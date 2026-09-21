const mockSend = jest.fn();
const mockFetchAllListings = jest.fn();
const mockFetch = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  GetCommand: jest.fn((input: unknown) => input),
  PutCommand: jest.fn((input: unknown) => input),
  UpdateCommand: jest.fn((input: unknown) => input),
  DeleteCommand: jest.fn((input: unknown) => input),
}));
jest.mock('../lambda/shared/kabuyutai-client', () => ({
  fetchAllListings: (...args: unknown[]) => mockFetchAllListings(...args),
}));

process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.YUTAI_TDNET_EVENT_TABLE_NAME = 'JQuantsYutaiTdnetEvent';
process.env.TDNET_LOOKBACK_DAYS = '1';
process.env.TDNET_REQUEST_INTERVAL_MS = '0';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/yutai-tdnet-watch-batch/index') as { handler: () => Promise<void> };

// totalCountを渡すと、rows.lengthとは独立に「全X件」バナーの件数だけを差し替えられる
// (ページネーションのテスト用。実際のrows配列は1ページ目に載せる行だけで足りる)。
function dayListHtml(rows: Array<{ code: string; name: string; title: string }>, totalCount?: number): string {
  const trs = rows
    .map(
      (r) => `<tr>
<td class="oddnew-L kjTime" noWrap>18:00</td>
<td class="oddnew-M kjCode" noWrap>${r.code}</td>
<td class="oddnew-M kjName" noWrap>${r.name}</td>
<td class="oddnew-M kjTitle" align="left"><a href="x.pdf" target="_blank">${r.title}</a></td>
</tr>`,
    )
    .join('\n');
  const total = totalCount ?? rows.length;
  return `<div class="kaijiSum">1～100件&nbsp;/&nbsp;全${total}件</div>${trs}`;
}

beforeEach(() => {
  mockSend.mockReset();
  mockFetchAllListings.mockReset();
  mockFetch.mockReset();
  (global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;
});

test('matches a yutai-related disclosure, looks it up via a single fetchAllListings scan, and upserts it', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    text: async () =>
      dayListHtml([{ code: '21570', name: 'コシダカホールディングス', title: '株主優待制度の一部変更に関するお知らせ' }]),
  });
  mockFetchAllListings.mockResolvedValueOnce([
    {
      ticker: '2157',
      companyName: 'コシダカホールディングス',
      content: '割引券（3,000円相当～）',
      rightsMonths: [2, 8],
      value: 3000,
      minInvestment: 150000,
    },
  ]);
  mockSend.mockResolvedValue({});

  await handler();

  expect(mockFetchAllListings).toHaveBeenCalledTimes(1);
  // Get(既存有無チェック) + Update(マスタupsert) + Put(イベント記録) = 3件。
  expect(mockSend).toHaveBeenCalledTimes(3);
  expect(mockSend.mock.calls[0][0]).toMatchObject({ TableName: 'JQuantsYutaiMaster', Key: { ticker: '2157' } });
  expect(mockSend.mock.calls[1][0]).toMatchObject({
    TableName: 'JQuantsYutaiMaster',
    Key: { ticker: '2157' },
    ExpressionAttributeValues: { ':value': 3000, ':unitShares': 100, ':minInvestment': 150000, ':rightsMonths': [2, 8] },
  });
  expect(mockSend.mock.calls[2][0]).toMatchObject({
    TableName: 'JQuantsYutaiTdnetEvent',
    Item: expect.objectContaining({
      pk: 'ALL',
      ticker: '2157',
      companyName: 'コシダカホールディングス',
      eventType: 'start',
      disclosureTitle: '株主優待制度の一部変更に関するお知らせ',
    }),
  });
});

test('upserts a matched ticker with value: null when kabuyutai.com has no extractable value, as long as rightsMonths is present', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    text: async () =>
      dayListHtml([{ code: '21570', name: 'コシダカホールディングス', title: '株主優待制度の一部変更に関するお知らせ' }]),
  });
  mockFetchAllListings.mockResolvedValueOnce([
    {
      ticker: '2157',
      companyName: 'コシダカホールディングス',
      content: '割引券（金額不明）',
      rightsMonths: [2, 8],
      value: undefined,
      minInvestment: 150000,
    },
  ]);
  mockSend.mockResolvedValue({});

  await handler();

  expect(mockFetchAllListings).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledTimes(3);
  expect(mockSend.mock.calls[1][0]).toMatchObject({
    TableName: 'JQuantsYutaiMaster',
    Key: { ticker: '2157' },
    ExpressionAttributeValues: { ':value': null, ':unitShares': 100, ':minInvestment': 150000, ':rightsMonths': [2, 8] },
  });
});

test('ignores disclosures whose title has no yutai-related keyword', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    text: async () => dayListHtml([{ code: '72030', name: 'トヨタ自動車', title: '自己株式取得に関するお知らせ' }]),
  });

  await handler();

  expect(mockFetchAllListings).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});

test('warns without deleting or recording an event when a matched ticker is not found on kabuyutai.com but the disclosure has no abolition keyword', async () => {
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        dayListHtml([{ code: '99990', name: '謎企業', title: '株主優待制度の一部変更に関するお知らせ' }]),
    });
    mockFetchAllListings.mockResolvedValueOnce([]); // not found, but no abolition signal -> likely transient

    await handler();

    expect(mockSend).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('9999'));
  } finally {
    warnSpy.mockRestore();
  }
});

test('deletes the yutai master row and records an abolition event when a matched ticker is not found on kabuyutai.com AND the matching disclosure contains an abolition keyword', async () => {
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        dayListHtml([{ code: '99990', name: '廃止企業', title: '株主優待制度の廃止に関するお知らせ' }]),
    });
    mockFetchAllListings.mockResolvedValueOnce([]); // もうkabuyutai.comの一覧に存在しない
    mockSend.mockResolvedValue({});

    await handler();

    // Delete(マスタ削除) + Put(イベント記録) = 2件。廃止はGetCommand(既存有無チェック)不要
    // (eventTypeが'abolition'に確定しているため)。
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[0][0]).toMatchObject({ TableName: 'JQuantsYutaiMaster', Key: { ticker: '9999' } });
    expect(mockSend.mock.calls[1][0]).toMatchObject({
      TableName: 'JQuantsYutaiTdnetEvent',
      Item: expect.objectContaining({ ticker: '9999', eventType: 'abolition', companyName: '廃止企業' }),
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('9999'));
  } finally {
    logSpy.mockRestore();
  }
});

test('deduplicates multiple matching disclosures across tickers into a single fetchAllListings scan, and records one event per disclosure', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    text: async () =>
      dayListHtml([
        { code: '21570', name: 'コシダカホールディングス', title: '株主優待制度の一部変更に関するお知らせ' },
        { code: '21570', name: 'コシダカホールディングス', title: '株主優待制度の一部変更に関するお知らせ（訂正）' },
        { code: '30030', name: '別企業', title: '株主優待制度の新設に関するお知らせ' },
      ]),
  });
  mockFetchAllListings.mockResolvedValueOnce([
    {
      ticker: '2157',
      companyName: 'コシダカホールディングス',
      content: '割引券（3,000円相当～）',
      rightsMonths: [2, 8],
      value: 3000,
    },
    { ticker: '3003', companyName: '別企業', content: 'QUOカード（500円相当～）', rightsMonths: [3], value: 500 },
  ]);
  mockSend.mockResolvedValue({});

  await handler();

  // 銘柄数(2件)に関わらず、実行全体を通してサイト走査は1回だけ。
  expect(mockFetchAllListings).toHaveBeenCalledTimes(1);

  // 2157: Get+Update+Put×2件(開示ごと)、3003: Get+Update+Put×1件 = 7件。
  expect(mockSend).toHaveBeenCalledTimes(7);
  const eventPuts = mockSend.mock.calls
    .map((c) => c[0] as { TableName?: string; Item?: { ticker: string; disclosureTitle: string } })
    .filter((c) => c.TableName === 'JQuantsYutaiTdnetEvent');
  expect(eventPuts).toHaveLength(3);
  expect(eventPuts.filter((c) => c.Item!.ticker === '2157')).toHaveLength(2);
  expect(eventPuts.map((c) => c.Item!.disclosureTitle)).toEqual(
    expect.arrayContaining([
      '株主優待制度の一部変更に関するお知らせ',
      '株主優待制度の一部変更に関するお知らせ（訂正）',
      '株主優待制度の新設に関するお知らせ',
    ]),
  );
});

test('treats a 404 day page as "no disclosures that day" rather than failing the run', async () => {
  mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

  await expect(handler()).resolves.not.toThrow();
  expect(mockFetchAllListings).not.toHaveBeenCalled();
});

test('throws when every day in the lookback window fails to fetch from TDnet', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    mockFetch.mockResolvedValue({ ok: false, status: 500 }); // every day errors (not a 404 "no disclosures")

    await expect(handler()).rejects.toThrow(/All \d+ days failed to fetch from TDnet/);
    expect(mockFetchAllListings).not.toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
  }
});

describe('pagination within a single day', () => {
  test('follows pagination when the count banner reports more than 100 disclosures, and picks up a ticker that only appears on page 2', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          dayListHtml(
            [{ code: '10010', name: 'ページ1企業', title: '株主優待制度の新設に関するお知らせ' }],
            149, // 「1～100件/全149件」 -> 100件/ページなので2ページ目が存在する
          ),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          dayListHtml([{ code: '20020', name: 'ページ2企業', title: '株主優待制度の新設に関するお知らせ' }], 149),
      });
    mockFetchAllListings.mockResolvedValueOnce([
      { ticker: '1001', companyName: 'ページ1企業', content: 'QUOカード（500円相当～）', rightsMonths: [3], value: 500 },
      { ticker: '2002', companyName: 'ページ2企業', content: '商品券（1,000円相当～）', rightsMonths: [9], value: 1000 },
    ]);
    mockSend.mockResolvedValue({});

    await handler();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(String(mockFetch.mock.calls[0][0])).toContain('I_list_001_');
    expect(String(mockFetch.mock.calls[1][0])).toContain('I_list_002_');

    const upsertedTickers = mockSend.mock.calls.map((call) => (call[0] as { Key?: { ticker?: string } }).Key?.ticker);
    expect(upsertedTickers).toContain('2002');
  });
});

test('records eventType "update" (not "start") when the ticker already exists in JQuantsYutaiMaster', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    text: async () =>
      dayListHtml([{ code: '21570', name: 'コシダカホールディングス', title: '株主優待制度の一部変更に関するお知らせ' }]),
  });
  mockFetchAllListings.mockResolvedValueOnce([
    { ticker: '2157', companyName: 'コシダカホールディングス', content: '割引券（3,000円相当～）', rightsMonths: [2, 8], value: 3000 },
  ]);
  mockSend.mockImplementation((command: unknown) => {
    const c = command as { TableName?: string; UpdateExpression?: string };
    if (c.TableName === 'JQuantsYutaiMaster' && !c.UpdateExpression) {
      // GetCommand(既存有無チェック)。UpdateCommandは同じTableNameだがUpdateExpressionを持つので区別できる。
      return Promise.resolve({ Item: { ticker: '2157' } });
    }
    return Promise.resolve({});
  });

  await handler();

  const eventPut = mockSend.mock.calls
    .map((c) => c[0] as { TableName?: string; Item?: Record<string, unknown> })
    .find((c) => c.TableName === 'JQuantsYutaiTdnetEvent');
  expect(eventPut?.Item).toMatchObject({ ticker: '2157', eventType: 'update' });
});

test('computes a deterministic eventId so re-processing the same disclosure overwrites rather than duplicates', async () => {
  const runOnce = async (): Promise<string> => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        dayListHtml([{ code: '21570', name: 'コシダカホールディングス', title: '株主優待制度の一部変更に関するお知らせ' }]),
    });
    mockFetchAllListings.mockResolvedValueOnce([
      { ticker: '2157', companyName: 'コシダカホールディングス', content: '割引券（3,000円相当～）', rightsMonths: [2, 8], value: 3000 },
    ]);
    mockSend.mockReset();
    mockSend.mockResolvedValue({});

    await handler();

    const eventPut = mockSend.mock.calls
      .map((c) => c[0] as { TableName?: string; Item?: { eventId: string } })
      .find((c) => c.TableName === 'JQuantsYutaiTdnetEvent');
    return eventPut!.Item!.eventId;
  };

  const firstEventId = await runOnce();
  const secondEventId = await runOnce();
  expect(firstEventId).toBe(secondEventId);
});

test('guards the event PutCommand with a ConditionExpression so re-processing cannot downgrade an already-recorded start event', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    text: async () =>
      dayListHtml([{ code: '21570', name: 'コシダカホールディングス', title: '株主優待制度の新設に関するお知らせ' }]),
  });
  mockFetchAllListings.mockResolvedValueOnce([
    { ticker: '2157', companyName: 'コシダカホールディングス', content: '割引券（3,000円相当～）', rightsMonths: [2, 8], value: 3000 },
  ]);
  mockSend.mockResolvedValue({});

  await handler();

  const eventPut = mockSend.mock.calls
    .map((c) => c[0] as { TableName?: string; ConditionExpression?: string; ExpressionAttributeValues?: Record<string, unknown> })
    .find((c) => c.TableName === 'JQuantsYutaiTdnetEvent');
  expect(eventPut?.ConditionExpression).toBe('attribute_not_exists(eventId) OR eventType <> :start');
  expect(eventPut?.ExpressionAttributeValues).toMatchObject({ ':start': 'start' });
});

test('swallows a ConditionalCheckFailedException on the event PutCommand without throwing or logging it as an error', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        dayListHtml([{ code: '21570', name: 'コシダカホールディングス', title: '株主優待制度の一部変更に関するお知らせ' }]),
    });
    mockFetchAllListings.mockResolvedValueOnce([
      { ticker: '2157', companyName: 'コシダカホールディングス', content: '割引券（3,000円相当～）', rightsMonths: [2, 8], value: 3000 },
    ]);
    mockSend.mockImplementation((command: unknown) => {
      const c = command as { TableName?: string };
      if (c.TableName === 'JQuantsYutaiTdnetEvent') {
        const error = new Error('The conditional request failed');
        error.name = 'ConditionalCheckFailedException';
        return Promise.reject(error);
      }
      return Promise.resolve({});
    });

    await expect(handler()).resolves.not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
  }
});
