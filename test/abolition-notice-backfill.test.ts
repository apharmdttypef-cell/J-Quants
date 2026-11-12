// モジュール化(TS2451回避)。
export {};

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  QueryCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'Query' })),
  GetCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'Get' })),
  UpdateCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'Update' })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { findAbolitionNoticeTargets, applyAbolitionNoticeTargets } = require('../scripts/lib/abolition-notice-backfill');

const mockSend = jest.fn();
const client = { send: mockSend };

function event(ticker: string, disclosedAt: string, title: string, eventType = 'update') {
  return { pk: 'ALL', eventId: `${disclosedAt}#${ticker}#abcd1234`, ticker, disclosedAt, disclosureTitle: title, eventType };
}

beforeEach(() => mockSend.mockReset());

test('finds abolition notices for tickers still in the master, paging through events', async () => {
  mockSend
    .mockResolvedValueOnce({
      Items: [
        event('3297', '2026-10-13', '無配及び株主優待制度の廃止に関するお知らせ'),
        event('6577', '2026-09-10', '株主優待制度の一部変更（デジタルギフトの廃止）のお知らせ'),
      ],
      LastEvaluatedKey: { pk: 'ALL', eventId: 'x' },
    })
    .mockResolvedValueOnce({
      Items: [
        event('2901', '2026-10-20', '株主優待制度廃止に関するお知らせ', 'abolition'),
        event('9223', '2026-09-14', '現行株主優待制度の終了および新制度の導入方針について'),
      ],
    })
    .mockResolvedValueOnce({ Item: { ticker: '3297' } }) // master get 3297
    .mockResolvedValueOnce({ Item: { ticker: '9223' } }); // master get 9223

  const targets = await findAbolitionNoticeTargets(client, 'Events', 'Master');

  expect(mockSend.mock.calls[1][0]).toMatchObject({ __type: 'Query', ExclusiveStartKey: { pk: 'ALL', eventId: 'x' } });
  expect(targets).toEqual([
    { ticker: '3297', notice: { disclosedAt: '2026-10-13', title: '無配及び株主優待制度の廃止に関するお知らせ' }, eventIds: ['2026-10-13#3297#abcd1234'] },
    { ticker: '9223', notice: { disclosedAt: '2026-09-14', title: '現行株主優待制度の終了および新制度の導入方針について' }, eventIds: ['2026-09-14#9223#abcd1234'] },
  ]);
});

test('skips tickers that are no longer in the master', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [event('3297', '2026-10-13', '株主優待制度の廃止に関するお知らせ')] })
    .mockResolvedValueOnce({}); // master get: no Item

  expect(await findAbolitionNoticeTargets(client, 'Events', 'Master')).toEqual([]);
});

test('apply sets abolitionNotice only on existing master rows and relabels the events', async () => {
  mockSend.mockResolvedValue({});

  await applyAbolitionNoticeTargets(client, 'Events', 'Master', [
    { ticker: '3297', notice: { disclosedAt: '2026-10-13', title: 't' }, eventIds: ['2026-10-13#3297#abcd1234'] },
  ]);

  expect(mockSend.mock.calls[0][0]).toMatchObject({
    __type: 'Update',
    TableName: 'Master',
    Key: { ticker: '3297' },
    UpdateExpression: 'SET abolitionNotice = :notice',
    ConditionExpression: 'attribute_exists(ticker)',
    ExpressionAttributeValues: { ':notice': { disclosedAt: '2026-10-13', title: 't' } },
  });
  expect(mockSend.mock.calls[1][0]).toMatchObject({
    __type: 'Update',
    TableName: 'Events',
    Key: { pk: 'ALL', eventId: '2026-10-13#3297#abcd1234' },
    UpdateExpression: 'SET eventType = :type',
    ExpressionAttributeValues: { ':type': 'abolition-notice' },
  });
});
