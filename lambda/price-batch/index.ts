import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getApiKey, getTargetTickers, fetchWithRetry, normalizeDate, formatDate } from '../shared/jquants-batch-client';

const TABLE_NAME = process.env.TABLE_NAME!;
const WATCHLIST_TABLE_NAME = process.env.WATCHLIST_TABLE_NAME!;
const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const SECRET_ARN = process.env.SECRET_ARN!;
const API_BASE_URL = process.env.API_BASE_URL ?? 'https://api.jquants.com/v2';
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? '7');
// Freeプランは配信12週間遅延(=84日)。この境界を過ぎた日付を要求すると
// 「Your subscription covers the following dates: ...」400エラーになるため、
// "今日" を基準にせず配信済みの範囲まで遡る。日付境界のズレを避け+1日のバッファを持たせる。
const DELIVERY_DELAY_DAYS = Number(process.env.DELIVERY_DELAY_DAYS ?? String(12 * 7 + 1));
// Freeプランは5req/分。余裕を持たせて13秒間隔にする(60000ms / 5req = 12000ms が下限)。
// この値はprice-batchとfinancial-summary-batchで同じにしておくこと(1つのAPIキーのレート制限を両者で共有しているため)。
const REQUEST_INTERVAL_MS = Number(process.env.REQUEST_INTERVAL_MS ?? '13000');
const MAX_RETRIES = 5;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface DailyBar {
  Code: string;
  Date: string;
  O: number | null;
  H: number | null;
  L: number | null;
  C: number | null;
  Vo: number | null;
}

interface DailyBarsResponse {
  data: DailyBar[];
  pagination_key?: string;
}

// codeを付けずdateのみ指定すると、その日の全上場銘柄分のデータが1回のリクエストで返る
// (実機検証済み: 2026-05-26〜28で東証全銘柄4,446〜4,453件がpaginationなしで1レスポンスに
// 収まった)。pagination_keyのページング処理は取引日によって件数が変動する可能性に備えて残す。
async function fetchAllBarsForDate(date: string, apiKey: string): Promise<DailyBar[]> {
  const bars: DailyBar[] = [];
  let paginationKey: string | undefined;

  do {
    const params = new URLSearchParams({ date });
    if (paginationKey) params.set('pagination_key', paginationKey);

    const response = await fetchWithRetry(
      `${API_BASE_URL}/equities/bars/daily?${params}`,
      apiKey,
      REQUEST_INTERVAL_MS,
      MAX_RETRIES,
    );
    const body = (await response.json()) as DailyBarsResponse;
    bars.push(...body.data);
    paginationKey = body.pagination_key;
  } while (paginationKey);

  return bars;
}

// 一括取得したレスポンスのCodeは5桁(例: '13010')。アプリ内のtickerは通常4桁(例: '1301')だが、
// ウォッチリストでは優先株式等を指定するために5桁のticker(例: '72030')もありうる
// (reference-api/index.tsのTICKER_CODE_PATTERN=/^\d{4,5}$/参照)。そのため5桁の完全一致と
// 4桁prefixの一致の両方をチェックする(yutai-tdnet-watch-batchのtoTicker()と同じ変換)。
// 普通株式・優先株式等が両方上場している銘柄では同じ4桁prefixに複数のCodeが存在しうる。
// 従来はcodeに4桁を渡すとAPI側が自動的に普通株式のみ返していたが、一括取得ではこの自動選択が
// 効かないため、4桁prefixで突き合わせる場合は5桁目が'0'(普通株式)のレコードを優先することで
// 同じ結果になるようにする。
function resolveTargetBars(bars: DailyBar[], targetTickers: Set<string>): Map<string, DailyBar> {
  const resolved = new Map<string, DailyBar>();

  for (const bar of bars) {
    const isCommonStock = bar.Code[4] === '0';

    if (targetTickers.has(bar.Code)) {
      resolved.set(bar.Code, bar);
    }

    const prefix = bar.Code.slice(0, 4);
    if (targetTickers.has(prefix)) {
      const existing = resolved.get(prefix);
      if (!existing || isCommonStock) {
        resolved.set(prefix, bar);
      }
    }
  }

  return resolved;
}

async function upsertBar(ticker: string, bar: DailyBar): Promise<void> {
  await ddbDocClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        ticker,
        date: normalizeDate(bar.Date),
        open: bar.O,
        high: bar.H,
        low: bar.L,
        close: bar.C,
        volume: bar.Vo,
        updated_at: new Date().toISOString(),
      },
    }),
  );
}

export const handler = async (): Promise<void> => {
  const tickers = await getTargetTickers(WATCHLIST_TABLE_NAME, YUTAI_MASTER_TABLE_NAME);
  if (tickers.length === 0) {
    console.warn('No target tickers (watchlist and yutai master are both empty); nothing to fetch');
    return;
  }
  const targetTickers = new Set(tickers);

  const apiKey = await getApiKey(SECRET_ARN);

  const dates: string[] = [];
  for (let offset = DELIVERY_DELAY_DAYS + LOOKBACK_DAYS; offset >= DELIVERY_DELAY_DAYS; offset--) {
    dates.push(formatDate(new Date(Date.now() - offset * 24 * 60 * 60 * 1000)));
  }

  for (const date of dates) {
    try {
      const bars = await fetchAllBarsForDate(date, apiKey);
      const matched = resolveTargetBars(bars, targetTickers);
      for (const [ticker, bar] of matched) {
        await upsertBar(ticker, bar);
      }
      console.log(`${date}: matched ${matched.size} of ${targetTickers.size} target tickers (${bars.length} bars in market snapshot)`);
    } catch (error) {
      console.error(`${date}: failed to fetch/upsert daily bars`, error);
    }
  }
};
