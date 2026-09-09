import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { getApiKey } from '../shared/jquants-batch-client';
import { batchUpsert } from '../shared/dynamodb-batch';
import { fetchAllWeeklyBalancesForDate, fetchAllDailyAlertBalancesForDate, type MarginBalancePoint } from './data-source';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const MARGIN_BALANCE_TABLE_NAME = process.env.MARGIN_BALANCE_TABLE_NAME!;
const SECRET_ARN = process.env.SECRET_ARN!;
// 週次データを何日分遡って取得するか。デフォルト2年分。price-batchのLOOKBACK_DAYSとは
// 無関係の別Lambda環境変数(このLambda専用)。
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? String(2 * 365));
if (!Number.isFinite(LOOKBACK_DAYS) || LOOKBACK_DAYS < 0) {
  throw new Error(`margin-balance-batch: invalid LOOKBACK_DAYS env var: ${process.env.LOOKBACK_DAYS}`);
}

// 毎回の実行で取得する直近ウィンドウ(暦日)。margin-alertは以前から日次、margin-interestは
// 2026-09-28から日次配信のため、平日毎日この範囲を両エンドポイントで取り直す(冪等upsert)。
// 取りこぼした日はこのウィンドウで自動的に埋まる。2026-09-28前のmargin-interestは金曜以外
// 空配列が返るだけで無害。
const RECENT_WINDOW_DAYS = 14;

// DynamoDBのデフォルト設定はundefinedなプロパティを持つアイテムの書き込みで例外を投げる。
// 全上場銘柄が対象の一括取得では値欠損レコードが混ざりうるため(data-source.tsでnullに
// 変換済みだが念のための防御)、undefinedのプロパティは書き込み時に自動的に取り除く。
const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
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

// 一括取得したレスポンスのcodeは5桁(例: '72030')。アプリ内のtickerは通常4桁(例: '7203')だが、
// 優先株式等を指定する5桁のticker(例: '72030')もありうる。そのため5桁の完全一致と4桁prefix
// の一致の両方をチェックする(price-batchのresolveTargetBarsと同じ変換)。同じ4桁prefixに
// 複数のcodeが存在する場合(普通株式・優先株式等)は5桁目が'0'(普通株式)のレコードを優先する。
function resolveTargetPoints(points: MarginBalancePoint[], targetTickers: Set<string>): Map<string, MarginBalancePoint> {
  const resolved = new Map<string, MarginBalancePoint>();

  for (const point of points) {
    const isCommonStock = point.code[4] === '0';

    if (targetTickers.has(point.code)) {
      resolved.set(point.code, point);
    }

    const prefix = point.code.slice(0, 4);
    if (targetTickers.has(prefix)) {
      const existing = resolved.get(prefix);
      if (!existing || isCommonStock) {
        resolved.set(prefix, point);
      }
    }
  }

  return resolved;
}

function toItems(matched: Map<string, MarginBalancePoint>): Record<string, unknown>[] {
  return [...matched.entries()].map(([ticker, point]) => ({
    ticker,
    date: point.date,
    financingBalance: point.financingBalance,
    lendingBalance: point.lendingBalance,
    source: point.source,
  }));
}

function listFridays(lookbackDays: number, now: number): string[] {
  const fridays: string[] = [];
  for (let offset = 0; offset <= lookbackDays; offset++) {
    const d = new Date(now - offset * 24 * 60 * 60 * 1000);
    if (d.getUTCDay() === 5) fridays.push(formatIsoDate(d));
  }
  return fridays;
}

// 今日からwindowDays日分の日付(新しい順)。
function listRecentDates(windowDays: number, now: number): string[] {
  const dates: string[] = [];
  for (let offset = 0; offset < windowDays; offset++) {
    dates.push(formatIsoDate(new Date(now - offset * 24 * 60 * 60 * 1000)));
  }
  return dates;
}

// 2年分の金曜バックフィルはAPI呼び出し数を抑えるため週1回(UTC月曜=JST月曜夕方の定期実行)のみ。
// 有効化直後などに手動で一括取得したい場合はFORCE_FULL_BACKFILL=trueで強制できる。
function shouldRunFullBackfill(now: number): boolean {
  if (process.env.FORCE_FULL_BACKFILL === 'true') return true;
  return new Date(now).getUTCDay() === 1;
}

export const handler = async (): Promise<void> => {
  const tickers = await getYutaiTickers();
  if (tickers.length === 0) {
    console.warn('Yutai master is empty; nothing to fetch');
    return;
  }
  const targetTickers = new Set(tickers);

  const apiKey = await getApiKey(SECRET_ARN);
  const now = Date.now();

  let attempted = 0;
  let failed = 0;
  let upserted = 0;

  async function fetchAndUpsert(
    label: 'daily-alert' | 'margin-interest',
    date: string,
    fetcher: (date: string, apiKey: string) => Promise<MarginBalancePoint[]>,
  ): Promise<void> {
    attempted += 1;
    try {
      const points = await fetcher(date, apiKey);
      const matched = resolveTargetPoints(points, targetTickers);
      await batchUpsert(ddbDocClient, MARGIN_BALANCE_TABLE_NAME, toItems(matched));
      upserted += matched.size;
      console.log(`${date}: matched ${matched.size} of ${targetTickers.size} target tickers (${label})`);
    } catch (error) {
      failed += 1;
      console.error(`${date}: failed to fetch/upsert ${label} margin balances`, error);
    }
  }

  // 直近ウィンドウ(新しい日付から)。実行が遅延・打ち切りになった場合でも鮮度の高い
  // データが先に確保されるよう、過去分のバックフィルより先に処理する。
  for (const date of listRecentDates(RECENT_WINDOW_DAYS, now)) {
    await fetchAndUpsert('daily-alert', date, fetchAllDailyAlertBalancesForDate);
    await fetchAndUpsert('margin-interest', date, fetchAllWeeklyBalancesForDate);
  }

  const fullBackfill = shouldRunFullBackfill(now);
  if (fullBackfill) {
    for (const date of listFridays(LOOKBACK_DAYS, now)) {
      await fetchAndUpsert('margin-interest', date, fetchAllWeeklyBalancesForDate);
    }
  }

  console.log(
    `margin-balance-batch: ${attempted} fetch/upsert calls (${failed} failed), ${upserted} points upserted, fullBackfill=${fullBackfill} (of ${targetTickers.size} target tickers)`,
  );

  // 全呼び出しが失敗、または失敗ゼロなのに1件もマッチしなかった場合は、日付パラメータの
  // 意味やAPIキーなど構造的な問題を疑い、例外を投げてCloudWatch/EventBridgeにエラーとして
  // 見えるようにする(handlerが常にresolveすると、全滅していても実行は"成功"に見えてしまう)。
  if (failed === attempted) {
    throw new Error(`margin-balance-batch: all ${attempted} fetch/upsert calls failed`);
  }
  if (upserted === 0 && failed === 0) {
    throw new Error(
      `margin-balance-batch: 0 points matched across ${attempted} fetch/upsert calls despite no fetch failures (of ${targetTickers.size} target tickers)`,
    );
  }
};
