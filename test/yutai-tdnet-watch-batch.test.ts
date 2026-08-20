const mockSend = jest.fn();
const mockFindTicker = jest.fn();
const mockFetch = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn((input: unknown) => input),
}));
jest.mock('../lambda/shared/kabuyutai-client', () => ({
  findTicker: (...args: unknown[]) => mockFindTicker(...args),
}));

process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.TDNET_LOOKBACK_DAYS = '1';
process.env.TDNET_REQUEST_INTERVAL_MS = '0';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/yutai-tdnet-watch-batch/index') as { handler: () => Promise<void> };

function dayListHtml(rows: Array<{ code: string; name: string; title: string }>): string {
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
  return `<div class="kaijiSum">1～100件&nbsp;/&nbsp;全${rows.length}件</div>${trs}`;
}

beforeEach(() => {
  mockSend.mockReset();
  mockFindTicker.mockReset();
  mockFetch.mockReset();
  (global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;
});

test('matches a yutai-related disclosure, looks it up on kabuyutai.com, and upserts it', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    text: async () =>
      dayListHtml([{ code: '21570', name: 'コシダカホールディングス', title: '株主優待制度の一部変更に関するお知らせ' }]),
  });
  mockFindTicker.mockResolvedValueOnce({
    ticker: '2157',
    companyName: 'コシダカホールディングス',
    content: '割引券（3,000円相当～）',
    rightsMonths: [2, 8],
    value: 3000,
  });
  mockSend.mockResolvedValue({});

  await handler();

  expect(mockFindTicker).toHaveBeenCalledWith('2157');
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend.mock.calls[0][0]).toMatchObject({
    TableName: 'JQuantsYutaiMaster',
    Item: { ticker: '2157', value: 3000, unitShares: 100, rightsMonths: [2, 8] },
  });
});

test('ignores disclosures whose title has no yutai-related keyword', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    text: async () => dayListHtml([{ code: '72030', name: 'トヨタ自動車', title: '自己株式取得に関するお知らせ' }]),
  });

  await handler();

  expect(mockFindTicker).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});

test('skips and logs a warning when a matched ticker is not found on kabuyutai.com', async () => {
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => dayListHtml([{ code: '99990', name: '廃止企業', title: '株主優待制度の廃止に関するお知らせ' }]),
    });
    mockFindTicker.mockResolvedValueOnce(undefined);

    await handler();

    expect(mockSend).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('9999'));
  } finally {
    warnSpy.mockRestore();
  }
});

test('deduplicates multiple matching disclosures for the same ticker into a single lookup', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    text: async () =>
      dayListHtml([
        { code: '21570', name: 'コシダカホールディングス', title: '株主優待制度の一部変更に関するお知らせ' },
        { code: '21570', name: 'コシダカホールディングス', title: '株主優待制度の一部変更に関するお知らせ（訂正）' },
      ]),
  });
  mockFindTicker.mockResolvedValueOnce({
    ticker: '2157',
    companyName: 'コシダカホールディングス',
    content: '割引券（3,000円相当～）',
    rightsMonths: [2, 8],
    value: 3000,
  });
  mockSend.mockResolvedValue({});

  await handler();

  expect(mockFindTicker).toHaveBeenCalledTimes(1);
});

test('treats a 404 day page as "no disclosures that day" rather than failing the run', async () => {
  mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

  await expect(handler()).resolves.not.toThrow();
  expect(mockFindTicker).not.toHaveBeenCalled();
});
