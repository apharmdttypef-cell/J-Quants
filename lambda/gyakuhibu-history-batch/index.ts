import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { fetchTaisyakuCsv, parseTaisyakuCsv } from './taisyaku-client';
import { getLocalTradingCalendar, rightsDateForMonth } from '../shared/trading-calendar';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const GYAKUHIBU_ACTUAL_TABLE_NAME = process.env.GYAKUHIBU_ACTUAL_TABLE_NAME!;
// taisyaku.jpが公開しているのは直近3年分のみ(それより古いデータは非公開)。
const MAX_HISTORY_YEARS = 3;
// 1,000銘柄規模になると初回は候補件数が膨大になり、Lambdaの実行時間内に収まらない。
// 実際にtaisyaku.jpへ取得しに行く件数だけを上限で区切り、残りは翌日以降に自然と持ち越す
// (alreadyFetchedが常にfalseのままなので取りこぼしにはならない)。
const MAX_FETCHES_PER_RUN = Number(process.env.MAX_GYAKUHIBU_FETCHES_PER_RUN ?? '200');

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

// 各銘柄のrightsMonthsについて、taisyaku.jpの公開範囲(直近MAX_HISTORY_YEARS年)分の
// 権利付き最終日を計算し、今日より過去の日付だけを候補として返す(旧JQuantsYutaiRightsDate
// テーブルスキャンの代替)。
function pastRightsDateCandidates(rows: MasterRow[]): RightsDateCandidate[] {
  const today = new Date().toISOString().slice(0, 10);
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

async function alreadyFetched(ticker: string, rightsDate: string): Promise<boolean> {
  const result = await ddbDocClient.send(
    new GetCommand({ TableName: GYAKUHIBU_ACTUAL_TABLE_NAME, Key: { ticker, rightsDate } }),
  );
  return result.Item !== undefined;
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
    // (alreadyFetchedでスキップした行まで待つのは無駄なため)。
    let attemptedFetch = false;
    try {
      if (await alreadyFetched(ticker, rightsDate)) continue;

      attemptedFetch = true;
      fetchCount++;
      const csv = await fetchTaisyakuCsv(ticker, rightsDate, rightsDate);
      const point = parseTaisyakuCsv(csv, rightsDate, unitShares, ticker);
      if (!point) {
        // 品貸料が発生しなかった(または対象日がCSVに含まれていなかった)場合でも、
        // 「確認済みで実績なし」の行を書いておかないとalreadyFetchedが常にfalseになり、
        // 毎日この権利日を再スクレイピングし続けてしまう(Fix 2)。
        console.log(`${ticker}: no lending fee on ${rightsDate} (not a margin-shortage event); recording as checked`);
        await ddbDocClient.send(
          new PutCommand({
            TableName: GYAKUHIBU_ACTUAL_TABLE_NAME,
            Item: { ticker, rightsDate, totalAmount: 0, days: 0, avgRate: 0, noGyakuhibu: true },
          }),
        );
        continue;
      }

      await ddbDocClient.send(
        new PutCommand({
          TableName: GYAKUHIBU_ACTUAL_TABLE_NAME,
          Item: { ticker, rightsDate: point.rightsDate, totalAmount: point.totalAmount, days: point.days, avgRate: point.avgRate },
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
