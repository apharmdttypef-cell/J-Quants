import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { fetchSoftHompoDay, parseSoftHompoCsv, type MonthlyArchiveCache, type SoftHompoBar } from './softhompo';

const TABLE_NAME = process.env.TABLE_NAME!;
const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
// SoftHompoは前営業日分を翌営業日の朝に公表する。直近7日分を毎回取り直し、遅れた公表や訂正を拾う。
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? '7');
// ファイル(日付)ごとに空ける間隔。個人のサイトなので間を空ける。
const REQUEST_INTERVAL_MS = Number(process.env.SOFTHOMPO_REQUEST_INTERVAL_MS ?? '1000');
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scanYutaiTickers(): Promise<Set<string>> {
  const tickers = new Set<string>();
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({
        TableName: YUTAI_MASTER_TABLE_NAME,
        ProjectionExpression: 'ticker',
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of result.Items ?? []) {
      if (typeof item.ticker === 'string') tickers.add(item.ticker);
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return tickers;
}

// JSTの日付で数える(手動実行がJST 0〜9時でもJSTの「今日」を基準にする)。今日の分は未公表なので含めない。
function lookbackDates(now: number): string[] {
  const dates: string[] = [];
  for (let offset = LOOKBACK_DAYS; offset >= 1; offset--) {
    dates.push(new Date(now + JST_OFFSET_MS - offset * DAY_MS).toISOString().slice(0, 10));
  }
  return dates;
}

async function upsertBar(ticker: string, date: string, bar: SoftHompoBar): Promise<void> {
  await ddbDocClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        ticker,
        date,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        updated_at: new Date().toISOString(),
      },
    }),
  );
}

export const handler = async (): Promise<void> => {
  const tickers = await scanYutaiTickers();
  if (tickers.size === 0) {
    console.warn('No target tickers (yutai master is empty); nothing to fetch');
    return;
  }

  const monthlyCache: MonthlyArchiveCache = new Map();
  const failedDates: string[] = [];

  for (const [index, date] of lookbackDates(Date.now()).entries()) {
    if (index > 0) await sleep(REQUEST_INTERVAL_MS);
    try {
      const csv = await fetchSoftHompoDay(date, monthlyCache);
      if (csv === null) {
        console.log(`${date}: no file (holiday or not yet published)`);
        continue;
      }
      const bars = parseSoftHompoCsv(csv);
      let written = 0;
      for (const [ticker, bar] of bars) {
        if (!tickers.has(ticker)) continue;
        await upsertBar(ticker, date, bar);
        written++;
      }
      console.log(`${date}: wrote ${written} of ${tickers.size} target tickers (${bars.size} rows in file)`);
    } catch (error) {
      console.error(`${date}: failed to fetch/parse/write SoftHompo prices`, error);
      failedDates.push(date);
    }
  }

  // 失敗した日があれば、他の日を処理し終えてから実行エラーにする(2日連続失敗のアラーム用)。
  if (failedDates.length > 0) {
    throw new Error(`price-batch: failed on ${failedDates.length} dates: ${failedDates.join(', ')}`);
  }
};
