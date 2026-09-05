import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { fetchTaisyakuCsv, parseTaisyakuCsv, GyakuhibuActualPoint } from './taisyaku-client';
import { getLocalTradingCalendar, rightsDateForMonth } from '../shared/trading-calendar';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const GYAKUHIBU_ACTUAL_TABLE_NAME = process.env.GYAKUHIBU_ACTUAL_TABLE_NAME!;
// taisyaku.jpが公開しているのは直近3年分のみ(それより古いデータは非公開)。
const MAX_HISTORY_YEARS = 3;
// 1,000銘柄規模になると初回は候補件数が膨大になり、Lambdaの実行時間内に収まらない。
// 実際にtaisyaku.jpへ取得しに行く件数だけを上限で区切り、残りは翌日以降に自然と持ち越す
// (isEnrichedがfalseのままなので取りこぼしにはならない)。
const MAX_FETCHES_PER_RUN = Number(process.env.MAX_GYAKUHIBU_FETCHES_PER_RUN ?? '200');
// Task 1でparseTaisyakuCsvが残高/レート列を返すようになる前に書かれた既存行(約5,000件)には
// enrichedが無い。これらを毎日ハンマーせず、かつ確実に一度は再取得(バックフィル)するための
// クールダウン日数。「行自体が無い(=そもそもCSVにその権利日が載っていない)」ことを確認済みの
// 行にも同じ日数を使う(毎日の無駄な再スクレイピングを防ぐ)。
const ENRICHED_RECHECK_COOLDOWN_DAYS = 30;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface MasterRow {
  ticker: string;
  unitShares: number;
  rightsMonths: number[];
}

interface RightsDateCandidate {
  ticker: string;
  rightsDate: string;
  unitShares: number;
}

async function scanYutaiMaster(): Promise<MasterRow[]> {
  const rows: MasterRow[] = [];
  let skippedCount = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({ TableName: YUTAI_MASTER_TABLE_NAME, ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of result.Items ?? []) {
      if (typeof item.ticker === 'string' && typeof item.unitShares === 'number' && Array.isArray(item.rightsMonths)) {
        rows.push({ ticker: item.ticker, unitShares: item.unitShares, rightsMonths: item.rightsMonths });
      } else {
        skippedCount++;
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  if (skippedCount > 0) {
    console.warn(`scanYutaiMaster: skipped ${skippedCount} rows with missing/malformed unitShares or rightsMonths`);
  }

  return rows;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// 各銘柄のrightsMonthsについて、taisyaku.jpの公開範囲(直近MAX_HISTORY_YEARS年)分の
// 権利付き最終日を計算し、今日より過去の日付だけを候補として返す(旧JQuantsYutaiRightsDate
// テーブルスキャンの代替)。
function pastRightsDateCandidates(rows: MasterRow[]): RightsDateCandidate[] {
  const today = todayIso();
  const thisYear = Number(today.slice(0, 4));
  const fromYear = thisYear - MAX_HISTORY_YEARS;
  const calendar = getLocalTradingCalendar(`${fromYear}-01-01`, `${thisYear}-12-31`);

  const candidates: RightsDateCandidate[] = [];
  for (const row of rows) {
    for (let year = fromYear; year <= thisYear; year++) {
      for (const month of row.rightsMonths) {
        const rightsDate = rightsDateForMonth(calendar, year, month);
        if (rightsDate && rightsDate < today) {
          candidates.push({ ticker: row.ticker, rightsDate, unitShares: row.unitShares });
        }
      }
    }
  }
  return candidates;
}

// "YYYY-MM-DD"のn日前を同フォーマットで返す(ミリ秒演算なので月/年またぎでも正しい)。
function isoDateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// 旧alreadyFetchedは「行が存在するかどうか」だけを見ていたため、Task 1で
// parseTaisyakuCsvが残高/レート列を返すようになる前に書かれた既存行(約5,000件、
// enrichedフィールドが無い)が永久にスキップされてしまっていた。isEnrichedは
// 次のいずれかを満たす場合だけスキップする(OR条件、両方満たす必要はない):
//   - enriched === true: 既に残高/レート列まで取得済み
//   - checkedAt が直近ENRICHED_RECHECK_COOLDOWN_DAYS日以内: 行そのものがCSVに
//     無いことを確認済み(=noGyakuhibuのみでenrichedは付いていない)で、かつ
//     確認してからまだ日が浅い。毎日ハンマーしないためのクールダウン。
async function isEnriched(ticker: string, rightsDate: string): Promise<boolean> {
  const result = await ddbDocClient.send(
    new GetCommand({ TableName: GYAKUHIBU_ACTUAL_TABLE_NAME, Key: { ticker, rightsDate } }),
  );
  if (result.Item?.enriched === true) return true;

  const checkedAt = result.Item?.checkedAt;
  if (typeof checkedAt === 'string' && checkedAt >= isoDateDaysAgo(ENRICHED_RECHECK_COOLDOWN_DAYS)) return true;

  return false;
}

// GyakuhibuActualPointの残高/レート列部分だけを取り出すヘルパー。noGyakuhibu行・実績行
// どちらのPutCommand Itemにも同じ形で埋め込む(点として重複させないため一箇所にまとめる)。
function balanceFieldsOf(point: GyakuhibuActualPoint) {
  return {
    financingBalance: point.financingBalance,
    lendingBalance: point.lendingBalance,
    lendingPrice: point.lendingPrice,
    maxRateActual: point.maxRateActual,
    bidRank: point.bidRank,
    restriction: point.restriction,
    emergencyMeasure: point.emergencyMeasure,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// taisyaku.jpへの連続リクエストの間隔。公開されたレート制限は無いが、個人利用の
// バッチとして無配慮に連打しないための最低限の間隔(数百ms〜数秒程度あれば十分)。
const BETWEEN_REQUESTS_DELAY_MS = Number(process.env.TAISYAKU_REQUEST_INTERVAL_MS ?? '1000');

export const handler = async (): Promise<void> => {
  const rows = await scanYutaiMaster();
  const candidates = pastRightsDateCandidates(rows);

  let fetchCount = 0;
  for (const { ticker, rightsDate, unitShares } of candidates) {
    if (fetchCount >= MAX_FETCHES_PER_RUN) break;

    // taisyaku.jpへの実リクエストを行った場合だけループ末尾で待機する
    // (isEnrichedでスキップした行まで待つのは無駄なため)。
    let attemptedFetch = false;
    try {
      if (await isEnriched(ticker, rightsDate)) continue;

      attemptedFetch = true;
      fetchCount++;
      const csv = await fetchTaisyakuCsv(ticker, rightsDate, rightsDate);
      const point = parseTaisyakuCsv(csv, rightsDate, unitShares, ticker);
      if (!point) {
        // 対象の申込日がCSVに全く含まれていない(行自体が無い)場合。残高も無いため
        // enriched: trueは付けない代わりにcheckedAt: todayを書き、isEnrichedの
        // クールダウン判定で当面(ENRICHED_RECHECK_COOLDOWN_DAYS日)の毎日再取得を防ぐ。
        console.log(`${ticker}: no row for ${rightsDate} in taisyaku.jp CSV; recording checkedAt`);
        await ddbDocClient.send(
          new PutCommand({
            TableName: GYAKUHIBU_ACTUAL_TABLE_NAME,
            Item: { ticker, rightsDate, totalAmount: 0, days: 0, avgRate: 0, noGyakuhibu: true, checkedAt: todayIso() },
          }),
        );
        continue;
      }

      if (!point.occurred) {
        // 行は見つかったが、その日は品貸料が発生しなかった(品貸料率が'-'等の非数値)。
        // 残高/レート列は取得できているのでenriched: trueにして完了扱いにする。
        console.log(`${ticker}: no lending fee on ${rightsDate} (not a margin-shortage event); recording balances`);
        await ddbDocClient.send(
          new PutCommand({
            TableName: GYAKUHIBU_ACTUAL_TABLE_NAME,
            Item: {
              ticker,
              rightsDate: point.rightsDate,
              ...balanceFieldsOf(point),
              totalAmount: 0,
              days: 0,
              avgRate: 0,
              noGyakuhibu: true,
              enriched: true,
            },
          }),
        );
        continue;
      }

      await ddbDocClient.send(
        new PutCommand({
          TableName: GYAKUHIBU_ACTUAL_TABLE_NAME,
          Item: {
            ticker,
            rightsDate: point.rightsDate,
            ...balanceFieldsOf(point),
            totalAmount: point.totalAmount,
            days: point.days,
            avgRate: point.avgRate,
            enriched: true,
          },
        }),
      );
      console.log(`${ticker}: upserted actual gyakuhibu for ${rightsDate}`);
    } catch (error) {
      console.error(`${ticker}: failed to fetch/upsert actual gyakuhibu for ${rightsDate}`, error);
    } finally {
      if (attemptedFetch) await sleep(BETWEEN_REQUESTS_DELAY_MS);
    }
  }
};
