# price-batch 一括日付取得への切り替え Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `lambda/price-batch/index.ts`を銘柄ごとの直列リクエスト(1233回、約64銘柄でタイムアウト打ち切り)から、日付ごとの一括取得(LOOKBACK_DAYS+1回、実測で東証全銘柄がpaginationなしで1レスポンスに収まる)に切り替え、全対象銘柄がカバーされるようにする。

**Architecture:** J-Quantsの`/equities/bars/daily`は`code`を省略し`date`のみ指定すると全上場銘柄のその日のデータを返す(実機検証済み)。この方式に切り替え、返ってきた5桁`Code`を4桁tickerに変換して対象銘柄集合と突き合わせ、一致したものだけDynamoDBにupsertする。

**Tech Stack:** TypeScript / Node.js Lambda / jest(ts-jest)。既存の`lambda/shared/jquants-batch-client.ts`(`getApiKey`/`getTargetTickers`/`fetchWithRetry`/`normalizeDate`/`formatDate`)はそのまま利用する。

## Global Constraints

- `DELIVERY_DELAY_DAYS`/`LOOKBACK_DAYS`のロジック(7日ローリングウィンドウという設計)は変更しない(spec: 2026-08-24-price-batch-bulk-fetch-design.md スコープ「含まない」)
- 新規銘柄への12週間分バックフィルは実装しない(スコープ外、日々の蓄積に任せる)
- `financial-summary-batch`など他バッチは変更しない
- `REQUEST_INTERVAL_MS`・`MAX_RETRIES`・`fetchWithRetry`のシグネチャは変更しない
- DynamoDBへの書き込み項目(`ticker`/`date`/`open`/`high`/`low`/`close`/`volume`/`updated_at`)は変更しない

---

### Task 1: price-batchを日付ごとの一括取得に書き換え

**Files:**
- Modify: `lambda/price-batch/index.ts`(全面書き換え)
- Modify: `test/price-batch.test.ts`(全面書き換え)

**Interfaces:**
- Consumes: `lambda/shared/jquants-batch-client.ts`の`getApiKey(secretArn)`・`getTargetTickers(watchlistTable, yutaiMasterTable)`・`fetchWithRetry(url, apiKey, intervalMs, maxRetries)`・`normalizeDate(raw)`・`formatDate(date)`。いずれも変更しない
- Produces: 他バッチはこのファイルに依存しない

- [ ] **Step 1: `test/price-batch.test.ts`を以下の内容に全面置き換える(RED)**

既存テストは「銘柄ごとにfetchWithRetryが呼ばれる」ことを検証しているが、新実装では「日付ごとに1回呼ばれ、`date=`のみでURLに`code=`は含まれない」ことと、対象銘柄以外は無視されること、普通株式・優先株式の優先順位、pagination_keyの追跡を検証する。`LOOKBACK_DAYS=2`(3日分のループ)に設定し、日付ごとのループを1つのテストの中で確認しやすくする。

```tsx
const mockDdbSend = jest.fn();
const mockGetApiKey = jest.fn();
const mockGetTargetTickers = jest.fn();
const mockFetchWithRetry = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  PutCommand: jest.fn((input: unknown) => input),
}));

jest.mock('../lambda/shared/jquants-batch-client', () => ({
  getApiKey: (...args: unknown[]) => mockGetApiKey(...args),
  getTargetTickers: (...args: unknown[]) => mockGetTargetTickers(...args),
  fetchWithRetry: (...args: unknown[]) => mockFetchWithRetry(...args),
  normalizeDate: (raw: string) => (raw.includes('-') ? raw : `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`),
  formatDate: (date: Date) => date.toISOString().slice(0, 10).replace(/-/g, ''),
}));

process.env.TABLE_NAME = 'JQuantsStockPrices';
process.env.WATCHLIST_TABLE_NAME = 'JQuantsWatchlist';
process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:JQuantsApiKey';
// 3日分(offset+2〜offsetの3日)のループになるようにし、日付ごとに1回fetchWithRetryが
// 呼ばれることをテストで確認しやすくする。
process.env.LOOKBACK_DAYS = '2';
process.env.DELIVERY_DELAY_DAYS = '10';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/price-batch/index') as { handler: () => Promise<void> };

beforeEach(() => {
  mockDdbSend.mockReset();
  mockGetApiKey.mockReset();
  mockGetTargetTickers.mockReset();
  mockFetchWithRetry.mockReset();
});

test('does nothing when there are no target tickers', async () => {
  mockGetTargetTickers.mockResolvedValueOnce([]);

  await handler();

  expect(mockGetApiKey).not.toHaveBeenCalled();
  expect(mockFetchWithRetry).not.toHaveBeenCalled();
});

test('queries once per day in the lookback window, by date only (no code parameter)', async () => {
  mockGetTargetTickers.mockResolvedValueOnce(['7203']);
  mockGetApiKey.mockResolvedValueOnce('test-api-key');
  mockFetchWithRetry.mockResolvedValue({ json: async () => ({ data: [] }) });

  await handler();

  // LOOKBACK_DAYS=2 → 3日分(from〜to inclusive)
  expect(mockFetchWithRetry).toHaveBeenCalledTimes(3);
  for (const [url] of mockFetchWithRetry.mock.calls) {
    expect(url as string).toContain('/equities/bars/daily');
    expect(url as string).toMatch(/date=\d{8}/);
    expect(url as string).not.toContain('code=');
  }
});

test('upserts only bars for tickers in the target set, ignoring the rest of the market snapshot', async () => {
  mockGetTargetTickers.mockResolvedValueOnce(['7203']);
  mockGetApiKey.mockResolvedValueOnce('test-api-key');
  mockFetchWithRetry.mockResolvedValue({
    json: async () => ({
      data: [
        { Code: '72030', Date: '2026-08-01', O: 100, H: 110, L: 95, C: 105, Vo: 1000 },
        { Code: '99990', Date: '2026-08-01', O: 1, H: 2, L: 1, C: 2, Vo: 5 },
      ],
    }),
  });

  await handler();

  const putCalls = mockDdbSend.mock.calls.filter(([cmd]) => 'Item' in (cmd as Record<string, unknown>));
  // 3日分ループする環境設定のため、一致した1件が日ごとに書き込まれ3件になる
  expect(putCalls).toHaveLength(3);
  for (const [cmd] of putCalls) {
    expect(cmd).toMatchObject({ TableName: 'JQuantsStockPrices', Item: { ticker: '7203', date: '2026-08-01' } });
  }
});

test('prefers the common-stock record (5th digit 0) when a ticker has multiple share classes listed', async () => {
  mockGetTargetTickers.mockResolvedValueOnce(['1301']);
  mockGetApiKey.mockResolvedValueOnce('test-api-key');
  mockFetchWithRetry.mockResolvedValue({
    json: async () => ({
      data: [
        { Code: '13011', Date: '2026-08-01', O: 999, H: 999, L: 999, C: 999, Vo: 999 }, // 優先株式(先に出現)
        { Code: '13010', Date: '2026-08-01', O: 100, H: 110, L: 95, C: 105, Vo: 1000 }, // 普通株式
      ],
    }),
  });

  await handler();

  const putCalls = mockDdbSend.mock.calls.filter(([cmd]) => 'Item' in (cmd as Record<string, unknown>));
  expect(putCalls).toHaveLength(3);
  for (const [cmd] of putCalls) {
    expect(cmd).toMatchObject({ Item: { ticker: '1301', close: 105 } }); // 普通株式側の値
  }
});

test('follows pagination_key when a single date response is paginated', async () => {
  mockGetTargetTickers.mockResolvedValueOnce(['7203']);
  mockGetApiKey.mockResolvedValueOnce('test-api-key');
  mockFetchWithRetry
    .mockResolvedValueOnce({
      json: async () => ({
        data: [{ Code: '72030', Date: '2026-08-01', O: 100, H: 110, L: 95, C: 105, Vo: 1000 }],
        pagination_key: 'page2',
      }),
    })
    .mockResolvedValue({ json: async () => ({ data: [] }) });

  await handler();

  // 1日目が2ページ(pagination_key追跡)+残り2日分=合計4回
  expect(mockFetchWithRetry).toHaveBeenCalledTimes(4);
  expect(mockFetchWithRetry.mock.calls[1][0]).toContain('pagination_key=page2');
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
cd /c/workspaces/J-Quants
npx jest price-batch.test.ts
```

Expected: FAIL(既存実装は`code=`パラメータでリクエストしており、`date=`のみのURLや上記の新しい呼び出し回数・フィルタ・優先順位の期待に一致しないため)

- [ ] **Step 3: `lambda/price-batch/index.ts`を以下の内容に全面置き換える**

```tsx
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

// 一括取得したレスポンスのCodeは5桁(例: '13010')。アプリ内のtickerは4桁(例: '1301')なので
// 先頭4桁を取って突き合わせる(yutai-tdnet-watch-batchのtoTicker()と同じ変換)。
// 普通株式・優先株式等が両方上場している銘柄では同じ4桁prefixに複数のCodeが存在しうる。
// 従来はcodeに4桁を渡すとAPI側が自動的に普通株式のみ返していたが、一括取得ではこの自動選択が
// 効かないため、5桁目が'0'(普通株式)のレコードを優先することで同じ結果になるようにする。
function resolveTargetBars(bars: DailyBar[], targetTickers: Set<string>): Map<string, DailyBar> {
  const resolved = new Map<string, DailyBar>();

  for (const bar of bars) {
    const ticker = bar.Code.slice(0, 4);
    if (!targetTickers.has(ticker)) continue;

    const isCommonStock = bar.Code[4] === '0';
    const existing = resolved.get(ticker);
    if (!existing || isCommonStock) {
      resolved.set(ticker, bar);
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
```

- [ ] **Step 4: テストを実行して成功を確認する(GREEN)**

```bash
cd /c/workspaces/J-Quants
npx jest price-batch.test.ts
```

Expected: 全テストPASS

- [ ] **Step 5: バックエンド全体のテストスイートを実行し、他への影響が無いことを確認する**

```bash
cd /c/workspaces/J-Quants
npx jest
```

Expected: 全テストPASS(price-batch/index.tsを直接importしている他ファイルは無いはずだが、念のため全体を確認する)。

注: このリポジトリのフルスイートはCDKスタックのesbuildバンドルを含むため、Windows環境ではまれに「N failed / M passed」とテストスイートだけ失敗表示になりつつ、個々のテスト(`Tests:`行)は0 failedというesbuildワーカー終了処理の既知のflakeが起きることがある(本タスクの変更とは無関係)。その形("Tests: 0 failed"だがsuiteだけ失敗)に一致する場合は、`npx jest`をもう一度実行してから本当に問題があるか判断する。

- [ ] **Step 6: 型チェックを実行する**

```bash
cd /c/workspaces/J-Quants
npm run build
```

Expected: エラーなしで終了

- [ ] **Step 7: コミット**

```bash
git add lambda/price-batch/index.ts test/price-batch.test.ts
git commit -m "$(cat <<'EOF'
Switch price-batch to per-date bulk fetch instead of per-ticker

The per-ticker loop (1233 tickers x 13s rate-limit interval) could
only cover ~64 tickers before the 14-minute Lambda timeout, with no
rotation so the remaining ~1170 yutai tickers never got reached.

/equities/bars/daily accepts date alone (no code) and returns the
whole TSE market in one response - verified live against the real
API (4,446-4,453 records, no pagination, works on the Free plan).
Switches the loop from per-ticker to per-date (LOOKBACK_DAYS+1 calls
instead of 1233) and filters the market snapshot down to the target
ticker set, preferring the common-stock record when a ticker has
multiple listed share classes.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
