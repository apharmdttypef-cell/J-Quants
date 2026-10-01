const mockSend = jest.fn();
const mockFetchDetailPage = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  ScanCommand: jest.fn((input: Record<string, unknown>) => ({ ...input, __type: 'Scan' })),
  UpdateCommand: jest.fn((input: Record<string, unknown>) => ({ ...input, __type: 'Update' })),
}));
jest.mock('../lambda/shared/kabuyutai-client', () => ({
  fetchDetailPage: (...args: unknown[]) => mockFetchDetailPage(...args),
}));

process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.KABUYUTAI_REQUEST_INTERVAL_MS = '0';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/yutai-detail-sync-batch/index') as {
  handler: (event: { codePrefix?: string; tickers?: string[]; maxFetches?: number }) => Promise<void>;
};

// 個別ページ1枚ぶんの最小HTML。条件なしの100株→1,000円だけを持つ。
const SIMPLE_DETAIL_HTML = `
<section id="yutai_detail">
<h3>◎オリジナルQUOカード</h3>
<table><tr><td>100株</td><td><b>1,000円</b>相当</td></tr></table>
</section>
<p>この企業の公式ホームページ</p>
`;

function masterRow(ticker: string, overrides: Record<string, unknown> = {}) {
  return {
    ticker,
    detailUrl: `https://www.kabuyutai.com/kobetu/${ticker}.html`,
    listBadge: null,
    ...overrides,
  };
}

// Scan 1回ぶんの応答を返し、以降のUpdateには空応答を返す。
function mockScanThenUpdates(rows: Record<string, unknown>[]) {
  mockSend.mockImplementation((input: { __type: string }) => {
    if (input.__type === 'Scan') return Promise.resolve({ Items: rows });
    return Promise.resolve({});
  });
}

function updateCalls() {
  return mockSend.mock.calls
    .map((call) => call[0] as { __type: string; Key?: { ticker: string }; ExpressionAttributeValues?: Record<string, unknown> })
    .filter((input) => input.__type === 'Update');
}

beforeEach(() => {
  mockSend.mockReset();
  mockFetchDetailPage.mockReset();
  delete process.env.YUTAI_DETAIL_COOLDOWN_DAYS;
  delete process.env.MAX_DETAIL_FETCHES_PER_RUN;
});

test('writes the parsed groups and the derived scalars for a ticker', async () => {
  mockScanThenUpdates([masterRow('7472')]);
  mockFetchDetailPage.mockResolvedValue(SIMPLE_DETAIL_HTML);

  await handler({});

  expect(mockFetchDetailPage).toHaveBeenCalledWith('https://www.kabuyutai.com/kobetu/7472.html');
  const values = updateCalls()[0].ExpressionAttributeValues!;
  expect(values[':requiredShares']).toBe(100);
  expect(values[':holdingKind']).toBe('none');
  expect(values[':crossEligible']).toBe('ok');
  expect(values[':minTierValueYen']).toBe(1000);
  expect(values[':benefitParseWarning']).toBeNull();
  expect(values[':benefitGroups']).toEqual([
    {
      title: '◎オリジナルQUOカード',
      holdingMonths: null,
      holdingRaw: null,
      tiers: [{ shares: 100, valueYen: 1000, rawText: '1,000円 相当' }],
    },
  ]);
  // 次回のクールダウン判定に使う取得日
  expect(values[':conditionCheckedAt']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('only processes tickers whose code starts with codePrefix', async () => {
  mockScanThenUpdates([masterRow('1375'), masterRow('7472'), masterRow('7458')]);
  mockFetchDetailPage.mockResolvedValue(SIMPLE_DETAIL_HTML);

  await handler({ codePrefix: '7' });

  expect(updateCalls().map((call) => call.Key!.ticker)).toEqual(['7472', '7458']);
});

test('skips tickers checked within the cooldown window', async () => {
  const recent = new Date();
  recent.setDate(recent.getDate() - 10);
  const old = new Date();
  old.setDate(old.getDate() - 200);

  mockScanThenUpdates([
    masterRow('1111', { conditionCheckedAt: recent.toISOString().slice(0, 10) }),
    masterRow('2222', { conditionCheckedAt: old.toISOString().slice(0, 10) }),
    masterRow('3333'),
  ]);
  mockFetchDetailPage.mockResolvedValue(SIMPLE_DETAIL_HTML);

  await handler({});

  // 10日前は90日のクールダウン内なので対象外。200日前と未取得は対象。
  expect(updateCalls().map((call) => call.Key!.ticker)).toEqual(['2222', '3333']);
});

test('stops after maxFetches and leaves the rest for the next run', async () => {
  mockScanThenUpdates([masterRow('1111'), masterRow('2222'), masterRow('3333')]);
  mockFetchDetailPage.mockResolvedValue(SIMPLE_DETAIL_HTML);

  await handler({ maxFetches: 2 });

  expect(mockFetchDetailPage).toHaveBeenCalledTimes(2);
  expect(updateCalls().map((call) => call.Key!.ticker)).toEqual(['1111', '2222']);
});

test('the tickers mode ignores both the cooldown and codePrefix', async () => {
  const today = new Date().toISOString().slice(0, 10);
  mockScanThenUpdates([masterRow('7458', { conditionCheckedAt: today }), masterRow('1375')]);
  mockFetchDetailPage.mockResolvedValue(SIMPLE_DETAIL_HTML);

  // 今日取得済みでもコード先頭が違っても、名指しされた銘柄は必ず取り直す
  // (直したパーサーを1銘柄で即座に確かめるための口)。
  await handler({ tickers: ['7458'], codePrefix: '9' });

  expect(updateCalls().map((call) => call.Key!.ticker)).toEqual(['7458']);
});

test('skips a row with no detail URL without failing the run', async () => {
  mockScanThenUpdates([masterRow('1111', { detailUrl: undefined }), masterRow('2222')]);
  mockFetchDetailPage.mockResolvedValue(SIMPLE_DETAIL_HTML);

  await handler({});

  expect(mockFetchDetailPage).toHaveBeenCalledTimes(1);
  expect(updateCalls().map((call) => call.Key!.ticker)).toEqual(['2222']);
});

test('keeps going when one ticker fails to fetch', async () => {
  mockScanThenUpdates([masterRow('1111'), masterRow('2222')]);
  mockFetchDetailPage
    .mockRejectedValueOnce(new Error('kabuyutai.com error 503'))
    .mockResolvedValueOnce(SIMPLE_DETAIL_HTML);

  await expect(handler({})).resolves.toBeUndefined();

  // 失敗した銘柄はconditionCheckedAtを書かないので次回また対象になる
  expect(updateCalls().map((call) => call.Key!.ticker)).toEqual(['2222']);
});

test('records a warning and falls back to the badge when the page cannot be parsed', async () => {
  mockScanThenUpdates([masterRow('1111', { listBadge: 'choukinomi' })]);
  mockFetchDetailPage.mockResolvedValue('<html><body>構造が変わった</body></html>');

  await handler({});

  const values = updateCalls()[0].ExpressionAttributeValues!;
  expect(values[':benefitParseWarning']).toBe('no-groups');
  expect(values[':crossEligible']).toBe('ng');
  expect(values[':requiredShares']).toBeNull();
  expect(values[':benefitGroups']).toEqual([]);
  // 解析失敗でもconditionCheckedAtは書く。書かないと毎回同じ銘柄を取り直し、
  // 構造変化が直るまで他の銘柄が進まなくなる。
  expect(values[':conditionCheckedAt']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
