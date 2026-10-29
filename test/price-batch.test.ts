// このファイルをモジュールにする。トップレベルのimport/exportが無いとファイルの宣言が
// グローバルスコープに出てしまい、同名の宣言(mockSend・handlerなど)を持つ他のテスト
// ファイルとts-jestの型検査で衝突する(TS2451)。
import { readFileSync } from 'fs';
import { join } from 'path';

const mockDdbSend = jest.fn();
const mockFetchSoftHompoDay = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  PutCommand: jest.fn((input: unknown) => ({ put: input })),
  ScanCommand: jest.fn((input: unknown) => ({ scan: input })),
}));

// 解析は本物を使い、取得だけを差し替える
jest.mock('../lambda/price-batch/softhompo', () => ({
  ...jest.requireActual('../lambda/price-batch/softhompo'),
  fetchSoftHompoDay: (...args: unknown[]) => mockFetchSoftHompoDay(...args),
}));

process.env.TABLE_NAME = 'JQuantsStockPrices';
process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.SOFTHOMPO_REQUEST_INTERVAL_MS = '0';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/price-batch/index') as { handler: () => Promise<void> };

const fixture = readFileSync(join(__dirname, 'fixtures', 'softhompo', 'stq_20261028.csv'), 'utf8');

type Sent = { scan?: Record<string, unknown>; put?: { TableName: string; Item: Record<string, unknown> } };

function mockMasterTickers(tickers: string[]) {
  mockDdbSend.mockImplementation(async (command: Sent) => {
    if (command.scan) return { Items: tickers.map((ticker) => ({ ticker })) };
    return {};
  });
}

function puts(): Array<{ TableName: string; Item: Record<string, unknown> }> {
  return mockDdbSend.mock.calls.map(([command]) => (command as Sent).put).filter((p): p is NonNullable<Sent['put']> => !!p);
}

beforeEach(() => {
  mockDdbSend.mockReset();
  mockFetchSoftHompoDay.mockReset();
  // JST 2026-10-29(木)09:30 の実行
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-29T00:30:00Z'));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('does nothing when there are no target tickers', async () => {
  mockMasterTickers([]);

  await handler();

  expect(mockFetchSoftHompoDay).not.toHaveBeenCalled();
});

test('fetches the seven JST days before today, oldest first, sharing one monthly cache', async () => {
  mockMasterTickers(['2301']);
  mockFetchSoftHompoDay.mockResolvedValue(null);

  await handler();

  expect(mockFetchSoftHompoDay.mock.calls.map(([date]) => date)).toEqual([
    '2026-10-22',
    '2026-10-23',
    '2026-10-24',
    '2026-10-25',
    '2026-10-26',
    '2026-10-27',
    '2026-10-28',
  ]);
  const caches = new Set(mockFetchSoftHompoDay.mock.calls.map(([, cache]) => cache));
  expect(caches.size).toBe(1);
  expect([...caches][0]).toBeInstanceOf(Map);
});

test('writes only the target tickers that traded, in the existing price row shape', async () => {
  // 1788は終日取引なし、1301は優待マスタに無い
  mockMasterTickers(['2301', '1793', '1788']);
  mockFetchSoftHompoDay.mockImplementation(async (date: string) => (date === '2026-10-28' ? fixture : null));

  await handler();

  const written = puts();
  expect(written.map((p) => p.Item.ticker).sort()).toEqual(['1793', '2301']);
  const row = written.find((p) => p.Item.ticker === '2301')!;
  expect(row.TableName).toBe('JQuantsStockPrices');
  expect(row.Item).toEqual({
    ticker: '2301',
    date: '2026-10-28',
    open: 1694,
    high: 1700,
    low: 1672,
    close: 1673,
    volume: 553500,
    updated_at: expect.any(String),
  });
});

test('reads only the ticker column of the yutai master', async () => {
  mockMasterTickers(['2301']);
  mockFetchSoftHompoDay.mockResolvedValue(null);

  await handler();

  const scan = mockDdbSend.mock.calls.map(([command]) => (command as Sent).scan).find(Boolean);
  expect(scan).toMatchObject({ TableName: 'JQuantsYutaiMaster', ProjectionExpression: 'ticker' });
});

test('skips days without a file and does not fail', async () => {
  mockMasterTickers(['2301']);
  mockFetchSoftHompoDay.mockResolvedValue(null);

  await expect(handler()).resolves.toBeUndefined();
  expect(puts()).toHaveLength(0);
});

test('keeps going after a failed day and throws at the end naming it', async () => {
  mockMasterTickers(['2301']);
  mockFetchSoftHompoDay.mockImplementation(async (date: string) => {
    if (date === '2026-10-27') throw new Error('softhompo: HTTP 503');
    if (date === '2026-10-28') return fixture;
    return null;
  });

  await expect(handler()).rejects.toThrow('2026-10-27');
  // 失敗した日の後の10/28も書いている
  expect(puts().map((p) => p.Item.date)).toEqual(['2026-10-28']);
});

test('treats a malformed file as a failed day', async () => {
  mockMasterTickers(['2301']);
  mockFetchSoftHompoDay.mockImplementation(async (date: string) =>
    date === '2026-10-28' ? fixture.replace('"売買高(千株)"', '"出来高(千株)"') : null,
  );

  await expect(handler()).rejects.toThrow('2026-10-28');
  expect(puts()).toHaveLength(0);
});
