import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getApiKey, scanTickerColumn, fetchWithRetry, normalizeDate } from '../shared/jquants-batch-client';
import { batchUpsert } from '../shared/dynamodb-batch';

const FINANCIAL_TABLE_NAME = process.env.FINANCIAL_TABLE_NAME!;
const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const SECRET_ARN = process.env.SECRET_ARN!;
const API_BASE_URL = process.env.API_BASE_URL ?? 'https://api.jquants.com/v2';
// Standardプランの決算系エンドポイント専用レート制限(60req/分)を想定した値
// (一般エンドポイントの120req/分とは別枠)。旧デフォルト13000msはFreeプラン5req/分の
// 想定のままだった。
const REQUEST_INTERVAL_MS = Number(process.env.REQUEST_INTERVAL_MS ?? '1000');
const MAX_RETRIES = 5;
// 新規銘柄1件の初回バックフィルは全期間分の逐次書き込みを伴うため、YutaiMasterへの
// 一括追加(kabuyutai優待抽出の改善による再取得等)直後は対象銘柄が一気に膨らみ、
// 14分のタイムアウト内に完走できなくなる。新規バックフィルの件数だけ実行あたりに
// 上限を設け、残りは次回実行に持ち越す(継続更新は一括取得で軽いので上限の対象外)。
const MAX_BACKFILL_TICKERS_PER_RUN = Number(process.env.MAX_BACKFILL_TICKERS_PER_RUN ?? '150');
if (!Number.isFinite(MAX_BACKFILL_TICKERS_PER_RUN) || MAX_BACKFILL_TICKERS_PER_RUN < 0) {
  throw new Error(`financial-summary-batch: invalid MAX_BACKFILL_TICKERS_PER_RUN env var: ${process.env.MAX_BACKFILL_TICKERS_PER_RUN}`);
}
// 決算発表は不定期に集中するため、週次実行(7日間隔)に対して2倍のバッファを持たせる。
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? '14');
if (!Number.isFinite(LOOKBACK_DAYS) || LOOKBACK_DAYS < 0) {
  throw new Error(`financial-summary-batch: invalid LOOKBACK_DAYS env var: ${process.env.LOOKBACK_DAYS}`);
}

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

interface FinancialSummary {
  Code: string;
  DiscDate: string;
  DocType: string;
  CurPerType: string;
  Sales: string;
  OP: string;
  OdP: string;
  NP: string;
  EPS: string;
}

interface FinancialSummaryResponse {
  data?: FinancialSummary[];
  pagination_key?: string;
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// LOOKBACK_DAYSの一括取得ループは新規(未バックフィル)銘柄も対象に含めるため、バックフィル
// 待ちの銘柄でも直近の開示が先に書き込まれることがある。単純な「1件でも存在するか」判定だと、
// このループ経由の書き込みだけで「既存」とみなされてしまい、そのtickerの全期間バックフィルが
// 二度と行われなくなる(このループ自体が原因でバックフィルを永久に取りこぼす)。そのため、
// lookbackウィンドウより古いdiscDateを持つ行があるかどうかで判定する(ウィンドウ内の行は
// 一括取得ループ由来の可能性があるため無視する)。
async function hasExistingSummary(ticker: string, cutoffDate: string): Promise<boolean> {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: FINANCIAL_TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker AND discDate < :cutoff',
      ExpressionAttributeValues: { ':ticker': ticker, ':cutoff': cutoffDate },
      Limit: 1,
    }),
  );
  return (result.Items ?? []).length > 0;
}

// 新規銘柄の初回バックフィル用。codeのみ指定(dateなし)で全期間分を取得する
// (/fins/summaryにfrom/toのような期間範囲パラメータは無いため、全期間分をこの形で
// 取得するのが唯一の方法)。
async function fetchAllSummariesForTicker(ticker: string, apiKey: string): Promise<FinancialSummary[]> {
  const summaries: FinancialSummary[] = [];
  let paginationKey: string | undefined;

  do {
    const params = new URLSearchParams({ code: ticker });
    if (paginationKey) params.set('pagination_key', paginationKey);

    const response = await fetchWithRetry(`${API_BASE_URL}/fins/summary?${params}`, apiKey, REQUEST_INTERVAL_MS, MAX_RETRIES);
    const body = (await response.json()) as FinancialSummaryResponse;
    summaries.push(...(body.data ?? []));
    paginationKey = body.pagination_key;
  } while (paginationKey);

  return summaries;
}

// 既存銘柄の継続更新用。codeを付けずdateのみ指定すると、その日に開示された全上場銘柄分の
// データが1回のリクエストで返る(price-batchのfetchAllBarsForDateと同じパターン)。
async function fetchAllSummariesForDate(date: string, apiKey: string): Promise<FinancialSummary[]> {
  const summaries: FinancialSummary[] = [];
  let paginationKey: string | undefined;

  do {
    const params = new URLSearchParams({ date });
    if (paginationKey) params.set('pagination_key', paginationKey);

    const response = await fetchWithRetry(`${API_BASE_URL}/fins/summary?${params}`, apiKey, REQUEST_INTERVAL_MS, MAX_RETRIES);
    const body = (await response.json()) as FinancialSummaryResponse;
    summaries.push(...(body.data ?? []));
    paginationKey = body.pagination_key;
  } while (paginationKey);

  return summaries;
}

// 一括取得したレスポンスのCodeは5桁(例: '72030')。アプリ内のtickerは通常4桁(例: '7203')だが、
// 優先株式等を指定する5桁のticker(例: '72030')もありうる。そのため5桁の完全一致と4桁prefix
// の一致の両方をチェックする(price-batchのresolveTargetBarsと同じ変換)。同じ4桁prefixに
// 複数のcodeが存在する場合(普通株式・優先株式等)は5桁目が'0'(普通株式)のレコードを優先する。
function resolveTargetSummaries(summaries: FinancialSummary[], targetTickers: Set<string>): Map<string, FinancialSummary> {
  const resolved = new Map<string, FinancialSummary>();

  for (const summary of summaries) {
    const isCommonStock = summary.Code[4] === '0';

    if (targetTickers.has(summary.Code)) {
      resolved.set(summary.Code, summary);
    }

    const prefix = summary.Code.slice(0, 4);
    if (targetTickers.has(prefix)) {
      const existing = resolved.get(prefix);
      if (!existing || isCommonStock) {
        resolved.set(prefix, summary);
      }
    }
  }

  return resolved;
}

// 桁数が大きく精度が必要なためAPIが返す文字列のまま保持する。
function toItem(ticker: string, summary: FinancialSummary, updatedAt: string): Record<string, unknown> {
  return {
    ticker,
    discDate: normalizeDate(summary.DiscDate),
    docType: summary.DocType,
    curPerType: summary.CurPerType,
    sales: summary.Sales,
    operatingProfit: summary.OP,
    ordinaryProfit: summary.OdP,
    netProfit: summary.NP,
    eps: summary.EPS,
    updated_at: updatedAt,
  };
}

function listRecentDates(lookbackDays: number, now: number): string[] {
  const dates: string[] = [];
  for (let offset = 0; offset <= lookbackDays; offset++) {
    dates.push(formatIsoDate(new Date(now - offset * 24 * 60 * 60 * 1000)));
  }
  return dates;
}

export const handler = async (): Promise<void> => {
  const tickers = await scanTickerColumn(YUTAI_MASTER_TABLE_NAME);
  if (tickers.length === 0) {
    console.warn('No target tickers (yutai master is empty); nothing to fetch');
    return;
  }
  const targetTickers = new Set(tickers);

  const apiKey = await getApiKey(SECRET_ARN);

  const cutoffDate = formatIsoDate(new Date(Date.now() - (LOOKBACK_DAYS + 1) * 24 * 60 * 60 * 1000));
  const newTickers: string[] = [];
  for (const ticker of tickers) {
    if (!(await hasExistingSummary(ticker, cutoffDate))) newTickers.push(ticker);
  }

  let attempted = 0;
  let backfilled = 0;
  let deferred = 0;
  let backfillFailed = 0;
  for (const ticker of newTickers) {
    if (attempted >= MAX_BACKFILL_TICKERS_PER_RUN) {
      deferred++;
      continue;
    }
    attempted++;
    try {
      const summaries = await fetchAllSummariesForTicker(ticker, apiKey);
      const updatedAt = new Date().toISOString();
      // 同一ticker・同一discDateの重複行(APIが同日に複数DocType/CurPerTypeを返す場合)は
      // BatchWriteItemが「同一キーを含むバッチ全体」を丸ごと拒否するため、書き込み前に
      // discDateでdedupeする(後勝ち。1件ずつPutしていた旧実装と同じ挙動を維持)。
      const items = [...new Map(summaries.map((s) => [normalizeDate(s.DiscDate), toItem(ticker, s, updatedAt)])).values()];
      await batchUpsert(ddbDocClient, FINANCIAL_TABLE_NAME, items);
      backfilled++;
      console.log(`${ticker}: backfilled ${items.length} financial summaries`);
    } catch (error) {
      backfillFailed++;
      console.error(`${ticker}: failed to backfill financial summaries`, error);
    }
  }

  const dates = listRecentDates(LOOKBACK_DAYS, Date.now());
  let dateUpdated = 0;
  let dateFailed = 0;
  for (const date of dates) {
    try {
      const summaries = await fetchAllSummariesForDate(date, apiKey);
      const matched = resolveTargetSummaries(summaries, targetTickers);
      const updatedAt = new Date().toISOString();
      const items = [...matched.entries()].map(([ticker, summary]) => toItem(ticker, summary, updatedAt));
      await batchUpsert(ddbDocClient, FINANCIAL_TABLE_NAME, items);
      dateUpdated += matched.size;
      console.log(`${date}: matched ${matched.size} of ${targetTickers.size} target tickers (disclosed that day)`);
    } catch (error) {
      dateFailed++;
      console.error(`${date}: failed to fetch/upsert financial summaries`, error);
    }
  }

  console.log(
    `financial-summary-batch: ${attempted} new tickers attempted (${backfilled} backfilled, ${backfillFailed} failed), ${deferred} deferred (backfill cap reached), of ${newTickers.length} new; ${dates.length} recent dates checked, ${dateUpdated} points updated, ${dateFailed} date fetch failures (of ${targetTickers.size} target tickers)`,
  );

  // 日付一括取得が全滅した場合、handlerが常にresolveすると実行は"成功"に見えてしまう
  // (margin-balance-batchで同じ理由から導入した安全策と同じ)。dateパラメータの形式や
  // APIキーなど構造的な問題を疑い、CloudWatch/EventBridgeにエラーとして見えるようにする。
  if (dateFailed === dates.length) {
    throw new Error(`financial-summary-batch: all ${dates.length} date fetch/upsert calls failed`);
  }
};
