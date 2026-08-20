import { getLocalTradingCalendar, rightsDateForMonth } from '../lambda/shared/trading-calendar';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  GetCommand: jest.fn((input: unknown) => input),
  PutCommand: jest.fn((input: unknown) => input),
  QueryCommand: jest.fn((input: unknown) => input),
  ScanCommand: jest.fn((input: unknown) => input),
}));
jest.mock('../lambda/gyakuhibu-history-batch/taisyaku-client', () => ({
  fetchTaisyakuCsv: jest.fn(),
  parseTaisyakuCsv: jest.fn(),
}));

process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.GYAKUHIBU_ACTUAL_TABLE_NAME = 'JQuantsGyakuhibuActual';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/gyakuhibu-history-batch/index') as { handler: () => Promise<void> };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const taisyakuClient = require('../lambda/gyakuhibu-history-batch/taisyaku-client') as {
  fetchTaisyakuCsv: jest.Mock;
  parseTaisyakuCsv: jest.Mock;
};

beforeEach(() => {
  mockSend.mockReset();
  taisyakuClient.fetchTaisyakuCsv.mockReset();
  taisyakuClient.parseTaisyakuCsv.mockReset();
});

// テスト実行時点で確実に「過去」になる年月(去年の3月)から、実カレンダーで計算した
// 権利付き最終日を返す。ハードコードされた日付文字列に依存せず、実行時点によらず
// 安定して過去日になる。
function knownPastRightsDate(): string {
  const lastYear = new Date().getFullYear() - 1;
  const calendar = getLocalTradingCalendar(`${lastYear}-01-01`, `${lastYear}-12-31`);
  const date = rightsDateForMonth(calendar, lastYear, 3);
  if (!date) throw new Error('test setup: could not compute a known past rights date');
  return date;
}

test('fetches and upserts actual gyakuhibu only for past rights dates not yet in JQuantsGyakuhibuActual', async () => {
  const rightsDate = knownPastRightsDate();
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203', unitShares: 100, rightsMonths: [3] }] }); // yutai master scan
  mockSend.mockResolvedValue({ Item: undefined }); // alreadyFetched: 常に未取得として扱う(候補が複数年分生成されるため)
  taisyakuClient.fetchTaisyakuCsv.mockResolvedValue('csv-body');
  taisyakuClient.parseTaisyakuCsv.mockImplementation((_csv, targetRightsDate) =>
    targetRightsDate === rightsDate ? { rightsDate, totalAmount: 680, days: 2, avgRate: 0.4 } : undefined,
  );

  await handler();

  const putCalls = mockSend.mock.calls.filter(
    ([cmd]) => 'Item' in (cmd as Record<string, unknown>) && (cmd as { TableName?: string }).TableName === 'JQuantsGyakuhibuActual',
  );
  expect(putCalls.some((call) => (call[0] as { Item: { rightsDate: string } }).Item.rightsDate === rightsDate)).toBe(true);
  const matchingCall = putCalls.find((call) => (call[0] as { Item: { rightsDate: string } }).Item.rightsDate === rightsDate);
  expect(matchingCall![0]).toMatchObject({
    Item: { ticker: '7203', rightsDate, totalAmount: 680, days: 2, avgRate: 0.4 },
  });
});

test('writes a noGyakuhibu marker row (instead of nothing) when parseTaisyakuCsv finds no lending fee, so the date is not re-scraped forever', async () => {
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203', unitShares: 100, rightsMonths: [3] }] }); // yutai master scan
  mockSend.mockResolvedValue({ Item: undefined }); // alreadyFetched: 常に未取得
  taisyakuClient.fetchTaisyakuCsv.mockResolvedValue('csv-body');
  taisyakuClient.parseTaisyakuCsv.mockReturnValue(undefined); // どの候補日も品薄なし

  await handler();

  const putCalls = mockSend.mock.calls.filter(
    ([cmd]) => 'Item' in (cmd as Record<string, unknown>) && (cmd as { TableName?: string }).TableName === 'JQuantsGyakuhibuActual',
  );
  expect(putCalls.length).toBeGreaterThan(0);
  expect(putCalls.every((call) => (call[0] as { Item: { noGyakuhibu?: boolean } }).Item.noGyakuhibu === true)).toBe(true);
});

test('caps the number of real taisyaku.jp fetches per run at MAX_GYAKUHIBU_FETCHES_PER_RUN, leaving the rest for next time', async () => {
  const previousEnv = process.env.MAX_GYAKUHIBU_FETCHES_PER_RUN;
  process.env.MAX_GYAKUHIBU_FETCHES_PER_RUN = '1';
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { handler: cappedHandler } = require('../lambda/gyakuhibu-history-batch/index') as { handler: () => Promise<void> };
  // jest.resetModules()でモジュールレジストリがリセットされるため、上でrequireし直したindex.tsが
  // 内部でrequireする'./taisyaku-client'はファイル冒頭のtaisyakuClientとは別インスタンスになる
  // (モックファクトリが再実行され、新しいjest.fn()が作られる)。そのため、ここでも再requireして
  // 実際にcappedHandlerが使うのと同じインスタンスに対してモック設定・アサーションを行う。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const freshTaisyakuClient = require('../lambda/gyakuhibu-history-batch/taisyaku-client') as {
    fetchTaisyakuCsv: jest.Mock;
    parseTaisyakuCsv: jest.Mock;
  };

  try {
    // rightsMonths: [1, 2, 3]の3ヶ月分あれば、直近数年でほぼ確実に2件以上の過去候補が生じる。
    mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203', unitShares: 100, rightsMonths: [1, 2, 3] }] });
    mockSend.mockResolvedValue({ Item: undefined });
    freshTaisyakuClient.fetchTaisyakuCsv.mockResolvedValue('csv-body');
    freshTaisyakuClient.parseTaisyakuCsv.mockReturnValue(undefined);

    await cappedHandler();

    expect(freshTaisyakuClient.fetchTaisyakuCsv).toHaveBeenCalledTimes(1);
  } finally {
    if (previousEnv === undefined) delete process.env.MAX_GYAKUHIBU_FETCHES_PER_RUN;
    else process.env.MAX_GYAKUHIBU_FETCHES_PER_RUN = previousEnv;
  }
});
