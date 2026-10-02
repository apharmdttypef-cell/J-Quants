import { getLocalTradingCalendar, rightsDateForMonth } from '../lambda/shared/trading-calendar';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  GetCommand: jest.fn((input: unknown) => input),
  PutCommand: jest.fn((input: unknown) => input),
  QueryCommand: jest.fn((input: unknown) => input),
  ScanCommand: jest.fn((input: unknown) => input),
  UpdateCommand: jest.fn((input: unknown) => input),
}));
jest.mock('../lambda/gyakuhibu-history-batch/taisyaku-client', () => ({
  fetchTaisyakuCsv: jest.fn(),
  parseTaisyakuCsv: jest.fn(),
}));

process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.GYAKUHIBU_ACTUAL_TABLE_NAME = 'JQuantsGyakuhibuActual';
// taisyaku.jpへの1リクエスト/秒の待機を0にする(モジュール読み込み時に読まれるので
// requireより手前で設定する)。本物の1秒を待つと、取得を複数回試すテストが4秒前後
// 眠ったままjestの既定タイムアウト5秒に迫り、他のスイート(CDKのsynthなど)と並列に
// 走ったときだけ落ちる。待機そのものはこのスイートの検証対象ではない。
process.env.TAISYAKU_REQUEST_INTERVAL_MS = '0';

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
  mockSend.mockResolvedValue({ Item: undefined }); // isEnriched: 常に未取得として扱う(候補が複数年分生成されるため)
  taisyakuClient.fetchTaisyakuCsv.mockResolvedValue('csv-body');
  taisyakuClient.parseTaisyakuCsv.mockImplementation((_csv, targetRightsDate) =>
    targetRightsDate === rightsDate
      ? {
          rightsDate,
          occurred: true,
          totalAmount: 680,
          days: 2,
          avgRate: 0.4,
          financingBalance: 50000,
          lendingBalance: 40000,
          lendingPrice: 1200,
          maxRateActual: 0.5,
          bidRank: 'A',
          restriction: null,
          emergencyMeasure: null,
        }
      : undefined,
  );

  await handler();

  const putCalls = mockSend.mock.calls.filter(
    ([cmd]) => 'Item' in (cmd as Record<string, unknown>) && (cmd as { TableName?: string }).TableName === 'JQuantsGyakuhibuActual',
  );
  expect(putCalls.some((call) => (call[0] as { Item: { rightsDate: string } }).Item.rightsDate === rightsDate)).toBe(true);
  const matchingCall = putCalls.find((call) => (call[0] as { Item: { rightsDate: string } }).Item.rightsDate === rightsDate);
  expect(matchingCall![0]).toMatchObject({
    Item: {
      ticker: '7203',
      rightsDate,
      totalAmount: 680,
      days: 2,
      avgRate: 0.4,
      enriched: true,
      financingBalance: 50000,
      lendingBalance: 40000,
    },
  });
});

test('writes a noGyakuhibu marker row (instead of nothing) when parseTaisyakuCsv finds no lending fee, so the date is not re-scraped forever', async () => {
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203', unitShares: 100, rightsMonths: [3] }] }); // yutai master scan
  mockSend.mockResolvedValue({ Item: undefined }); // isEnriched: 常に未取得
  taisyakuClient.fetchTaisyakuCsv.mockResolvedValue('csv-body');
  taisyakuClient.parseTaisyakuCsv.mockReturnValue(undefined); // どの候補日もCSVに行自体が無い

  await handler();

  const putCalls = mockSend.mock.calls.filter(
    ([cmd]) => 'Item' in (cmd as Record<string, unknown>) && (cmd as { TableName?: string }).TableName === 'JQuantsGyakuhibuActual',
  );
  expect(putCalls.length).toBeGreaterThan(0);
  expect(putCalls.every((call) => (call[0] as { Item: { noGyakuhibu?: boolean } }).Item.noGyakuhibu === true)).toBe(true);
  // point === undefined(行自体が無い)場合はenriched: trueを付けない代わりにcheckedAtを書く
  // (30日以内の再スキップ用)。enrichedを付けてしまうと残高の無いこの行が永久に完了扱いになる。
  expect(putCalls.every((call) => (call[0] as { Item: { enriched?: boolean } }).Item.enriched === undefined)).toBe(true);
  expect(putCalls.every((call) => typeof (call[0] as { Item: { checkedAt?: string } }).Item.checkedAt === 'string')).toBe(true);
});

test('preserves existing totalAmount when a legacy (not-yet-enriched) row falls outside the CSV response, instead of overwriting it with zero', async () => {
  // 既存行(Task 1以前に書かれた、totalAmountはあるがenrichedが無いレガシー行)が、
  // taisyaku.jpの3年公開ウィンドウから外れて今日のCSVには含まれなくなったケースを模す。
  const rightsDate = knownPastRightsDate();
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203', unitShares: 100, rightsMonths: [3] }] }); // yutai master scan
  mockSend.mockResolvedValue({ Item: { ticker: '7203', rightsDate, totalAmount: 600, enriched: undefined } }); // 既存の未enriched行(実データ持ち)
  taisyakuClient.fetchTaisyakuCsv.mockResolvedValue('csv-body');
  taisyakuClient.parseTaisyakuCsv.mockReturnValue(undefined); // 3年公開ウィンドウから外れ、CSVにこの日の行が無い

  await handler();

  const putCalls = mockSend.mock.calls.filter(
    ([cmd]) => 'Item' in (cmd as Record<string, unknown>) && (cmd as { TableName?: string }).TableName === 'JQuantsGyakuhibuActual',
  );
  // totalAmountを消す(=0を書く)PutCommandが発行されていないことを確認する
  expect(putCalls.some((call) => (call[0] as { Item?: { totalAmount?: number } }).Item?.totalAmount === 0)).toBe(false);

  const updateCalls = mockSend.mock.calls.filter(
    ([cmd]) => 'UpdateExpression' in (cmd as Record<string, unknown>) && (cmd as { TableName?: string }).TableName === 'JQuantsGyakuhibuActual',
  );
  expect(updateCalls.length).toBeGreaterThan(0);
  // rightsMonths: [3]は複数年分の過去候補を生成し、そのすべてで既存行があるためUpdateCommandが
  // 複数回発行される。対象のrightsDateに対応する1件を見つけて検証する。
  const matchingUpdateCall = updateCalls.find(
    (call) => (call[0] as { Key?: { rightsDate?: string } }).Key?.rightsDate === rightsDate,
  );
  expect(matchingUpdateCall).toBeDefined();
  expect(matchingUpdateCall![0]).toMatchObject({
    Key: { ticker: '7203', rightsDate },
    ExpressionAttributeValues: { ':checkedAt': expect.any(String) },
  });
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

test('re-fetches a rights date whose row exists but is not yet enriched', async () => {
  // Task 1より前に書かれた既存行を模す: totalAmountはあるがenrichedが無い(undefined)。
  // 旧alreadyFetchedはItemが存在するだけでスキップしていたが、isEnrichedはenriched!==trueなので
  // スキップしない = 再取得してenriched: trueと残高列で上書きする。
  const rightsDate = knownPastRightsDate();
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203', unitShares: 100, rightsMonths: [3] }] }); // yutai master scan
  mockSend.mockResolvedValue({ Item: { ticker: '7203', rightsDate, totalAmount: 600, enriched: undefined } }); // isEnriched: 既存行はあるが未enriched
  taisyakuClient.fetchTaisyakuCsv.mockResolvedValue('csv-body');
  taisyakuClient.parseTaisyakuCsv.mockImplementation((_csv, targetRightsDate) =>
    targetRightsDate === rightsDate
      ? {
          rightsDate,
          occurred: true,
          totalAmount: 680,
          days: 2,
          avgRate: 0.4,
          financingBalance: 50000,
          lendingBalance: 40000,
          lendingPrice: 1200,
          maxRateActual: 0.5,
          bidRank: 'A',
          restriction: null,
          emergencyMeasure: null,
        }
      : undefined,
  );

  await handler();

  expect(taisyakuClient.fetchTaisyakuCsv).toHaveBeenCalled();
  const putCalls = mockSend.mock.calls.filter(
    ([cmd]) => 'Item' in (cmd as Record<string, unknown>) && (cmd as { TableName?: string }).TableName === 'JQuantsGyakuhibuActual',
  );
  const matchingCall = putCalls.find((call) => (call[0] as { Item: { rightsDate: string } }).Item.rightsDate === rightsDate);
  expect(matchingCall).toBeDefined();
  expect(matchingCall![0]).toMatchObject({
    Item: { ticker: '7203', rightsDate, enriched: true, financingBalance: 50000 },
  });
});

test('stores noGyakuhibu:true together with balances when occurred is false', async () => {
  // parseTaisyakuCsvが行を見つけたが、その日は品貸料が発生しなかった(occurred: false)ケース。
  // 残高は取得できているのでnoGyakuhibu: trueとenriched: trueが両立する。
  const rightsDate = knownPastRightsDate();
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203', unitShares: 100, rightsMonths: [3] }] }); // yutai master scan
  mockSend.mockResolvedValue({ Item: undefined }); // isEnriched: 未取得
  taisyakuClient.fetchTaisyakuCsv.mockResolvedValue('csv-body');
  taisyakuClient.parseTaisyakuCsv.mockImplementation((_csv, targetRightsDate) =>
    targetRightsDate === rightsDate
      ? {
          rightsDate,
          occurred: false,
          totalAmount: 0,
          days: 0,
          avgRate: 0,
          financingBalance: 75000,
          lendingBalance: 60000,
          lendingPrice: 900,
          maxRateActual: null,
          bidRank: null,
          restriction: null,
          emergencyMeasure: null,
        }
      : undefined,
  );

  await handler();

  const putCalls = mockSend.mock.calls.filter(
    ([cmd]) => 'Item' in (cmd as Record<string, unknown>) && (cmd as { TableName?: string }).TableName === 'JQuantsGyakuhibuActual',
  );
  const matchingCall = putCalls.find((call) => (call[0] as { Item: { rightsDate: string } }).Item.rightsDate === rightsDate);
  expect(matchingCall).toBeDefined();
  const item = matchingCall![0] as { Item: { noGyakuhibu?: boolean; enriched?: boolean; lendingBalance?: number } };
  expect(item.Item.noGyakuhibu).toBe(true);
  expect(item.Item.enriched).toBe(true);
  expect(item.Item.lendingBalance).toBe(60000);
});

test('skips a rights date that is already enriched', async () => {
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203', unitShares: 100, rightsMonths: [3] }] }); // yutai master scan
  mockSend.mockResolvedValue({ Item: { enriched: true } }); // isEnriched: 既にenriched済み

  await handler();

  expect(taisyakuClient.fetchTaisyakuCsv).not.toHaveBeenCalled();
});

test('skips a rights date whose checkedAt is within the last 30 days, even without enriched', async () => {
  // 行自体がCSVに無いことを直近に確認済み(checkedAt=今日)のケース。enrichedは付いていないが、
  // クールダウン期間内なので今日は再取得しない。
  const recentCheckedAt = new Date().toISOString().slice(0, 10);
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203', unitShares: 100, rightsMonths: [3] }] }); // yutai master scan
  mockSend.mockResolvedValue({ Item: { ticker: '7203', noGyakuhibu: true, checkedAt: recentCheckedAt } });

  await handler();

  expect(taisyakuClient.fetchTaisyakuCsv).not.toHaveBeenCalled();
});

test('re-fetches a rights date whose checkedAt is older than 30 days', async () => {
  // 30日クールダウンが切れていれば、enrichedが無い(かつcheckedAtが古い)行は再取得対象に戻る。
  const staleCheckedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203', unitShares: 100, rightsMonths: [3] }] }); // yutai master scan
  mockSend.mockResolvedValue({ Item: { ticker: '7203', noGyakuhibu: true, checkedAt: staleCheckedAt } });
  taisyakuClient.fetchTaisyakuCsv.mockResolvedValue('csv-body');
  taisyakuClient.parseTaisyakuCsv.mockReturnValue(undefined);

  await handler();

  expect(taisyakuClient.fetchTaisyakuCsv).toHaveBeenCalled();
});
