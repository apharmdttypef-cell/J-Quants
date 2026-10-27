// このファイルをモジュールにする。トップレベルのimport/exportが無いとファイルの宣言が
// グローバルスコープに出てしまい、同名の宣言(mockSend・handlerなど)を持つ他のテスト
// ファイルとts-jestの型検査で衝突する(TS2451)。どのファイルが同じワーカーに割り当て
// られるかで発火するため非決定的に落ちていた。
export {};

const mockSend = jest.fn();
const mockFetchCsv = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  ScanCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'Scan' })),
  GetCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'Get' })),
  PutCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'Put' })),
  UpdateCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'Update' })),
  BatchWriteCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'BatchWrite' })),
}));
// 取得(HTTP)だけ差し替え、パース(ヘッダー検証を含む)は本物を使う
jest.mock('../lambda/margin-balance-batch/data-source', () => ({
  ...jest.requireActual('../lambda/margin-balance-batch/data-source'),
  fetchTaisyakuBalanceCsv: (...args: unknown[]) => mockFetchCsv(...args),
}));

process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.MARGIN_BALANCE_TABLE_NAME = 'JQuantsMarginBalance';
process.env.REQUEST_INTERVAL_MS = '0';
process.env.MAX_DATES_PER_RUN = '3';

/* eslint-disable @typescript-eslint/no-var-requires */
const { handler } = require('../lambda/margin-balance-batch/index') as { handler: () => Promise<void> };
const { TAISYAKU_BALANCE_CSV_HEADER, TaisyakuCsvFormatError } = jest.requireActual(
  '../lambda/margin-balance-batch/data-source',
) as { TAISYAKU_BALANCE_CSV_HEADER: readonly string[]; TaisyakuCsvFormatError: new (message?: string) => Error };
const { CURSOR_KEY } = require('../lambda/margin-balance-batch/fetch-plan') as {
  CURSOR_KEY: { ticker: string; date: string };
};
/* eslint-enable @typescript-eslint/no-var-requires */

type Row = [code: string, market: string, financing: string, lending: string, marginName?: string];

function csvFor(rows: Row[]): string {
  const quote = (cols: string[]) => cols.map((c) => `"${c}"`).join(',');
  const lines = [quote([...TAISYAKU_BALANCE_CSV_HEADER])];
  for (const [code, market, financing, lending, marginName = '貸借'] of rows) {
    lines.push(
      quote([code, `銘柄${code}`, market, marginName, '20270331', '', financing, lending, '0', '1.00', '0.00', '-', '-', '-']),
    );
  }
  return lines.join('\r\n');
}

function mockTables({
  master,
  cursor,
  marginNames = {},
}: {
  master: string[];
  cursor?: string;
  marginNames?: Record<string, string>;
}): void {
  mockSend.mockImplementation(async (command: { __type: string }) => {
    switch (command.__type) {
      case 'Scan':
        return { Items: master.map((ticker) => ({ ticker, marginName: marginNames[ticker] })) };
      case 'Get':
        return cursor ? { Item: { ...CURSOR_KEY, lastFetchedDate: cursor } } : {};
      default:
        return {};
    }
  });
}

type SentCommand = { __type: string; [key: string]: unknown };

function sentCommands(type: string): SentCommand[] {
  return mockSend.mock.calls.map(([command]) => command as SentCommand).filter((c) => c.__type === type);
}

function cursorWrites(): string[] {
  return sentCommands('Put')
    .map((c) => c.Item as Record<string, unknown>)
    .filter((item) => item.ticker === '__cursor__')
    .map((item) => item.lastFetchedDate as string);
}

function putItems(): Record<string, unknown>[] {
  return sentCommands('BatchWrite').flatMap((c) =>
    ((c.RequestItems as Record<string, { PutRequest: { Item: Record<string, unknown> } }[]>).JQuantsMarginBalance ?? []).map(
      (r) => r.PutRequest.Item,
    ),
  );
}

// マスタへの貸借区分の書き込み(ticker → 書いた値)
function marginNameUpdates(): Record<string, unknown> {
  return Object.fromEntries(
    sentCommands('Update').map((c) => [
      (c.Key as { ticker: string }).ticker,
      (c.ExpressionAttributeValues as Record<string, unknown>)[':marginName'],
    ]),
  );
}

function fetchedDates(): string[] {
  return mockFetchCsv.mock.calls.map(([date]) => date as string);
}

beforeEach(() => {
  mockSend.mockReset();
  mockFetchCsv.mockReset();
  jest.useFakeTimers({
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick'],
  }).setSystemTime(new Date('2026-10-23T11:00:00Z')); // JST 2026-10-23(金) 20:00
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('初回(カーソル無し)は3年前から上限件数だけ取る', async () => {
  mockTables({ master: ['7203'] });
  mockFetchCsv.mockResolvedValue(csvFor([['7203', '東証', '100', '50']]));

  await handler();

  expect(fetchedDates()).toEqual(['2023-10-24', '2023-10-25', '2023-10-26']);
  expect(mockFetchCsv.mock.calls.every(([, intervalMs]) => intervalMs === 0)).toBe(true);
  expect(cursorWrites()).toEqual(['2023-10-24', '2023-10-25', '2023-10-26']);
});

test('通常はカーソル日から今日まで取り、優待マスタの東証行だけをsource: taisyakuで書く', async () => {
  mockTables({ master: ['7203', '3197'], cursor: '2026-10-21' });
  mockFetchCsv.mockResolvedValue(
    csvFor([
      ['7203', '東証', '639600', '800'],
      ['7203', '名証', '0', '0'],
      ['3197', '東証', '12900', '138400'],
      ['1301', '東証', '7200', '7200'],
    ]),
  );

  await handler();

  expect(fetchedDates()).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
  const items = putItems();
  expect(items).toContainEqual({
    ticker: '7203',
    date: '2026-10-22',
    financingBalance: 639600,
    lendingBalance: 800,
    source: 'taisyaku',
  });
  expect(items.some((item) => item.ticker === '1301')).toBe(false);
  expect(items.some((item) => item.financingBalance === 0)).toBe(false);
  expect(items).toHaveLength(6);
});

test('カーソル行は__cursor__/taisyakuのキーで読み書きする', async () => {
  mockTables({ master: ['7203'], cursor: '2026-10-21' });
  mockFetchCsv.mockResolvedValue(csvFor([['7203', '東証', '100', '50']]));

  await handler();

  expect(sentCommands('Get')[0]).toMatchObject({
    TableName: 'JQuantsMarginBalance',
    Key: { ticker: '__cursor__', date: 'taisyaku' },
  });
  const puts = sentCommands('Put');
  const last = puts[puts.length - 1];
  expect(last.TableName).toBe('JQuantsMarginBalance');
  expect(last.Item).toEqual({
    ticker: '__cursor__',
    date: 'taisyaku',
    lastFetchedDate: '2026-10-23',
    updatedAt: expect.any(String),
  });
});

test('今日が0件(未公表)ならカーソルを進めずに終える', async () => {
  mockTables({ master: ['7203'], cursor: '2026-10-21' });
  const csv = csvFor([['7203', '東証', '100', '50']]);
  mockFetchCsv.mockImplementation(async (date: string) => (date === '2026-10-23' ? null : csv));

  await expect(handler()).resolves.toBeUndefined();

  expect(cursorWrites()).toEqual(['2026-10-21', '2026-10-22']);
});

test('今日より前の0件は休場日とみなしてカーソルを進める', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  mockTables({ master: ['7203'], cursor: '2026-10-21' });
  const csv = csvFor([['7203', '東証', '100', '50']]);
  mockFetchCsv.mockImplementation(async (date: string) => (date === '2026-10-22' ? null : csv));

  await handler();

  expect(fetchedDates()).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
  expect(cursorWrites()).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
  expect(warn.mock.calls.some((args) => String(args[0]).includes('2026-10-22'))).toBe(true);
});

test('ヘッダーのみのCSV(パース結果0件)もnullと同じ扱いにする', async () => {
  mockTables({ master: ['7203'], cursor: '2026-10-21' });
  const csv = csvFor([['7203', '東証', '100', '50']]);
  mockFetchCsv.mockImplementation(async (date: string) => (date === '2026-10-23' ? csvFor([]) : csv));

  await expect(handler()).resolves.toBeUndefined();

  expect(cursorWrites()).toEqual(['2026-10-21', '2026-10-22']);
});

test('取得失敗はその回を打ち切り、カーソルが進んだ部分失敗なら例外にしない', async () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockTables({ master: ['7203'], cursor: '2026-10-21' });
  mockFetchCsv
    .mockResolvedValueOnce(csvFor([['7203', '東証', '100', '50']]))
    .mockResolvedValueOnce(csvFor([['7203', '東証', '100', '50']]))
    .mockRejectedValueOnce(new Error('taisyaku.jp error 503'));

  await expect(handler()).resolves.toBeUndefined();

  expect(fetchedDates()).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
  expect(cursorWrites()).toEqual(['2026-10-21', '2026-10-22']);
  expect(error).toHaveBeenCalled();
});

test('カーソル日の取り直しだけ成功し次の日で失敗したら、進んでいないので例外', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockTables({ master: ['7203'], cursor: '2026-10-21' });
  mockFetchCsv
    .mockResolvedValueOnce(csvFor([['7203', '東証', '100', '50']]))
    .mockRejectedValueOnce(new Error('taisyaku.jp error 503'))
    .mockResolvedValue(csvFor([['7203', '東証', '100', '50']]));

  await expect(handler()).rejects.toThrow('no progress past cursor');

  expect(mockFetchCsv).toHaveBeenCalledTimes(2);
  expect(cursorWrites()).toEqual(['2026-10-21']);
});

test('カーソル日が成功し今日が未公表(0件)なら、進んでいなくても例外にしない', async () => {
  mockTables({ master: ['7203'], cursor: '2026-10-22' });
  const csv = csvFor([['7203', '東証', '100', '50']]);
  mockFetchCsv.mockImplementation(async (date: string) => (date === '2026-10-23' ? null : csv));

  await expect(handler()).resolves.toBeUndefined();

  expect(fetchedDates()).toEqual(['2026-10-22', '2026-10-23']);
  expect(cursorWrites()).toEqual(['2026-10-22']);
});

test('DynamoDB書き込み失敗も打ち切り、1日目で失敗したら例外', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockTables({ master: ['7203'], cursor: '2026-10-21' });
  const base = mockSend.getMockImplementation()!;
  let batchWrites = 0;
  mockSend.mockImplementation(async (command: { __type: string }) => {
    if (command.__type === 'BatchWrite' && batchWrites++ === 0) throw new Error('ddb down');
    return base(command);
  });
  mockFetchCsv.mockResolvedValue(csvFor([['7203', '東証', '100', '50']]));

  await expect(handler()).rejects.toThrow('margin-balance-batch: all fetches failed');

  expect(cursorWrites()).toEqual([]);
  expect(mockFetchCsv).toHaveBeenCalledTimes(1);
});

test('全件失敗なら例外', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockTables({ master: ['7203'], cursor: '2026-10-21' });
  mockFetchCsv.mockRejectedValue(new Error('boom'));

  await expect(handler()).rejects.toThrow('margin-balance-batch: all fetches failed');
});

test('ヘッダー不一致は即失敗し、後続の日も取らない', async () => {
  mockTables({ master: ['7203'], cursor: '2026-10-21' });
  mockFetchCsv.mockResolvedValue('"銘柄コード","銘柄名"');

  await expect(handler()).rejects.toThrow(TaisyakuCsvFormatError);

  expect(mockFetchCsv).toHaveBeenCalledTimes(1);
  expect(cursorWrites()).toEqual([]);
});

test('成功したのに1件もマッチしなければ例外', async () => {
  mockTables({ master: ['9999'], cursor: '2026-10-21' });
  mockFetchCsv.mockResolvedValue(csvFor([['7203', '東証', '100', '50']]));

  await expect(handler()).rejects.toThrow('0 points matched');
});

test('優待マスタが空なら何もしない', async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  mockTables({ master: [] });

  await handler();

  expect(mockFetchCsv).not.toHaveBeenCalled();
  expect(sentCommands('Get')).toHaveLength(0);
});

test('取得済みが最新ならカーソル日の取り直し1日だけ取る', async () => {
  mockTables({ master: ['7203'], cursor: '2026-10-23' });
  mockFetchCsv.mockResolvedValue(csvFor([['7203', '東証', '100', '50']]));

  await handler();

  expect(fetchedDates()).toEqual(['2026-10-23']);
});

test('最新の申込日のCSVの貸借区分で、値が変わった銘柄だけマスタを更新する', async () => {
  mockTables({
    master: ['7203', '3197', '1301', '9418'],
    cursor: '2026-10-21',
    marginNames: { '7203': '貸借', '3197': '信用', '1301': '貸借', '9418': '貸借' },
  });
  const older = csvFor([
    ['7203', '東証', '100', '50', '貸借'],
    ['3197', '東証', '100', '50', '貸借'],
    ['1301', '東証', '100', '50', '貸借'],
    ['9418', '東証', '100', '50', '貸借'],
  ]);
  const newest = csvFor([
    ['7203', '東証', '100', '50', '貸借'], // 変化なし → 書かない
    ['3197', '東証', '100', '50', '貸借融資'], // J-Quants表記(信用)から変わる
    ['1301', '東証', '100', '50', '非貸借'],
    ['9418', '名証', '100', '50', '貸借'], // 東証行が無い → null
  ]);
  mockFetchCsv.mockImplementation(async (date: string) => (date === '2026-10-23' ? newest : older));

  await handler();

  expect(marginNameUpdates()).toEqual({ '3197': '貸借融資', '1301': '非貸借', '9418': null });
  expect(sentCommands('Update')[0]).toMatchObject({
    TableName: 'JQuantsYutaiMaster',
    UpdateExpression: 'SET marginName = :marginName',
  });
});

test('今日が未公表なら、取れた日のうち最新(昨日)のCSVの区分を使う', async () => {
  mockTables({ master: ['7203'], cursor: '2026-10-21', marginNames: { '7203': '貸借' } });
  mockFetchCsv.mockImplementation(async (date: string) => {
    if (date === '2026-10-23') return null;
    return csvFor([['7203', '東証', '100', '50', date === '2026-10-22' ? '貸借融資' : '貸借']]);
  });

  await handler();

  expect(marginNameUpdates()).toEqual({ '7203': '貸借融資' });
});

test('東証行が無く、すでにnull(未設定)の銘柄は書かない', async () => {
  mockTables({ master: ['7203', '5555'], cursor: '2026-10-23', marginNames: { '7203': '貸借' } });
  mockFetchCsv.mockResolvedValue(csvFor([['7203', '東証', '100', '50']]));

  await handler();

  expect(sentCommands('Update')).toHaveLength(0);
});

test('CSVが1件も取れなかった実行では区分を更新しない', async () => {
  mockTables({ master: ['7203'], cursor: '2026-10-23', marginNames: { '7203': '貸借' } });
  mockFetchCsv.mockResolvedValue(null);

  await handler();

  expect(sentCommands('Update')).toHaveLength(0);
});

test('区分の更新に失敗しても信用残の処理を終えてから例外を投げる', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockTables({ master: ['7203', '3197'], cursor: '2026-10-21' });
  const base = mockSend.getMockImplementation()!;
  mockSend.mockImplementation(async (command: { __type: string; Key?: { ticker: string } }) => {
    if (command.__type === 'Update' && command.Key?.ticker === '7203') throw new Error('ddb down');
    return base(command);
  });
  mockFetchCsv.mockResolvedValue(
    csvFor([
      ['7203', '東証', '100', '50'],
      ['3197', '東証', '100', '50'],
    ]),
  );

  await expect(handler()).rejects.toThrow('failed to update the margin classification of 1 tickers');

  // 信用残は3日分とも書き終えている
  expect(cursorWrites()).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
  // 失敗した銘柄があっても残りの銘柄は更新する
  expect(sentCommands('Update').map((c) => (c.Key as { ticker: string }).ticker).sort()).toEqual(['3197', '7203']);
});

test('マスタのScanはtickerとmarginNameだけを読む', async () => {
  mockTables({ master: ['7203'], cursor: '2026-10-23' });
  mockFetchCsv.mockResolvedValue(csvFor([['7203', '東証', '100', '50']]));

  await handler();

  expect(sentCommands('Scan')[0]).toMatchObject({
    TableName: 'JQuantsYutaiMaster',
    ProjectionExpression: 'ticker, marginName',
  });
});

test('J-Quants(APIキー・クライアント)に依存しない', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('path') as typeof import('path');
  for (const file of ['index.ts', 'data-source.ts']) {
    const source = readFileSync(join(__dirname, '..', 'lambda', 'margin-balance-batch', file), 'utf8');
    expect(source).not.toContain('jquants-batch-client');
    expect(source).not.toContain('SECRET_ARN');
    expect(source).not.toContain('getApiKey');
  }
});
