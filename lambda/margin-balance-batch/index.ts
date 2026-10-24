import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { batchUpsert } from '../shared/dynamodb-batch';
import { fetchTaisyakuBalanceCsv, parseTaisyakuBalanceCsv } from './data-source';
import { CURSOR_KEY, planFetchDates, todayJst } from './fetch-plan';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const MARGIN_BALANCE_TABLE_NAME = process.env.MARGIN_BALANCE_TABLE_NAME!;

// 有限の非負整数(minimum以上)でなければ、誤設定のまま走らせずモジュール読み込み時に落とす
function readIntEnv(name: string, defaultValue: string, minimum: number): number {
  const raw = process.env[name] ?? defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`margin-balance-batch: invalid ${name} env var: ${raw}`);
  }
  return value;
}

// taisyaku.jpへの3リクエストの各間と、日付と日付の間に空ける待ち時間
const REQUEST_INTERVAL_MS = readIntEnv('REQUEST_INTERVAL_MS', '1000', 0);
// 1回の実行で取得する申込日の上限。1日 約8〜12秒 × 40日でタイムアウト(14分)に余裕を残す
const MAX_DATES_PER_RUN = readIntEnv('MAX_DATES_PER_RUN', '40', 1);

// DynamoDBのデフォルト設定はundefinedなプロパティを持つアイテムの書き込みで例外を投げる。
// 念のための防御として、undefinedのプロパティは書き込み時に自動的に取り除く。
const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

async function getYutaiTickers(): Promise<string[]> {
  const tickers: string[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({ TableName: YUTAI_MASTER_TABLE_NAME, ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of result.Items ?? []) {
      if (typeof item.ticker === 'string') tickers.push(item.ticker);
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return tickers;
}

// 取得済みの最終申込日(カーソル行)。無ければ初回としてnull
async function readCursor(): Promise<string | null> {
  const result = await ddbDocClient.send(new GetCommand({ TableName: MARGIN_BALANCE_TABLE_NAME, Key: CURSOR_KEY }));
  const lastFetchedDate = result.Item?.lastFetchedDate;
  return typeof lastFetchedDate === 'string' ? lastFetchedDate : null;
}

async function writeCursor(date: string): Promise<void> {
  await ddbDocClient.send(
    new PutCommand({
      TableName: MARGIN_BALANCE_TABLE_NAME,
      Item: { ...CURSOR_KEY, lastFetchedDate: date, updatedAt: new Date().toISOString() },
    }),
  );
}

// taisyaku.jp(日証金)の全銘柄一括CSVを申込日ごとに1回取得し、優待マスタの銘柄だけを保存する。
// 進捗はカーソル行(lastFetchedDate)で持ち、カーソル日自体も毎回取り直す。
// 失敗した日はその回の取得を打ち切り、カーソルを連続した最後の成功日のままにする(次回そこから取り直す)。
export const handler = async (): Promise<void> => {
  const tickers = await getYutaiTickers();
  if (tickers.length === 0) {
    console.warn('Yutai master is empty; nothing to fetch');
    return;
  }
  const targetTickers = new Set(tickers);

  const lastFetchedDate = await readCursor();
  const today = todayJst(Date.now());
  const dates = planFetchDates({ today, lastFetchedDate, maxDates: MAX_DATES_PER_RUN });

  let succeeded = 0;
  let failed = 0;
  let upserted = 0;
  let cursor = lastFetchedDate;

  for (const [i, date] of dates.entries()) {
    if (i > 0) await sleep(REQUEST_INTERVAL_MS);

    let csv: string | null;
    try {
      csv = await fetchTaisyakuBalanceCsv(date, REQUEST_INTERVAL_MS);
    } catch (error) {
      failed += 1;
      console.error(`${date}: failed to fetch taisyaku.jp balance CSV; stopping this run`, error);
      break;
    }

    // ヘッダー不一致(TaisyakuCsvFormatError)は仕様変更を疑い、そのまま投げてバッチを失敗させる
    const points = csv === null ? [] : parseTaisyakuBalanceCsv(csv, date);
    if (points.length === 0) {
      if (date === today) {
        console.log(`${date}: 0 rows (未公表); keeping the cursor at ${cursor}`);
        break;
      }
      // ローカル祝日計算に無い休場日(12/31等)や公開範囲外の日。止まり続けないよう進める
      console.warn(`${date}: 0 rows before today; treating as a market holiday and advancing the cursor`);
      try {
        await writeCursor(date);
      } catch (error) {
        failed += 1;
        console.error(`${date}: failed to write the cursor; stopping this run`, error);
        break;
      }
      cursor = date;
      continue;
    }

    const items = points
      .filter((p) => targetTickers.has(p.code))
      .map((p) => ({
        ticker: p.code,
        date: p.date,
        financingBalance: p.financingBalance,
        lendingBalance: p.lendingBalance,
        source: p.source,
      }));
    try {
      await batchUpsert(ddbDocClient, MARGIN_BALANCE_TABLE_NAME, items);
      await writeCursor(date);
    } catch (error) {
      failed += 1;
      console.error(`${date}: failed to upsert margin balances; stopping this run`, error);
      break;
    }
    succeeded += 1;
    upserted += items.length;
    cursor = date;
    console.log(`${date}: matched ${items.length} of ${targetTickers.size} target tickers`);
  }

  console.log(
    `margin-balance-batch: ${dates.length} dates planned, ${succeeded} succeeded, ${failed} failed, ${upserted} points upserted, cursor=${cursor}`,
  );

  // handlerが常にresolveすると全滅していても実行は"成功"に見えるため、例外にしてアラームに乗せる
  if (succeeded === 0 && failed > 0) {
    throw new Error(`margin-balance-batch: all fetches failed (${failed} failed of ${dates.length} planned)`);
  }
  if (succeeded > 0 && upserted === 0) {
    throw new Error(
      `margin-balance-batch: 0 points matched across ${succeeded} fetched dates (of ${targetTickers.size} target tickers)`,
    );
  }
};
