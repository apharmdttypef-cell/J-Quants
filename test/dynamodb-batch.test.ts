const mockSend = jest.fn();

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  BatchWriteCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'BatchWrite' })),
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { batchUpsert } = require('../lambda/shared/dynamodb-batch') as {
  batchUpsert: (ddbDocClient: unknown, tableName: string, items: Record<string, unknown>[]) => Promise<void>;
};

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

beforeEach(() => {
  mockSend.mockReset();
});

test('writes items in batches of 25', async () => {
  mockSend.mockResolvedValue({});
  const items = Array.from({ length: 30 }, (_, i) => ({ id: i }));

  await batchUpsert(ddbDocClient, 'MyTable', items);

  expect(mockSend).toHaveBeenCalledTimes(2);
  const firstBatch = mockSend.mock.calls[0][0] as { RequestItems: Record<string, unknown[]> };
  expect(firstBatch.RequestItems.MyTable).toHaveLength(25);
  const secondBatch = mockSend.mock.calls[1][0] as { RequestItems: Record<string, unknown[]> };
  expect(secondBatch.RequestItems.MyTable).toHaveLength(5);
});

test('does nothing (no send calls) when items is empty', async () => {
  await batchUpsert(ddbDocClient, 'MyTable', []);
  expect(mockSend).not.toHaveBeenCalled();
});

test('retries when UnprocessedItems is returned, until it succeeds', async () => {
  let callCount = 0;
  mockSend.mockImplementation((cmd: { RequestItems: Record<string, unknown[]> }) => {
    callCount++;
    if (callCount === 1) {
      const firstItem = cmd.RequestItems.MyTable[0];
      return Promise.resolve({ UnprocessedItems: { MyTable: [firstItem] } });
    }
    return Promise.resolve({});
  });

  await batchUpsert(ddbDocClient, 'MyTable', [{ id: 1 }]);

  expect(callCount).toBeGreaterThanOrEqual(2);
});

test('throws after more than 10 retries', async () => {
  jest.useFakeTimers();
  try {
    mockSend.mockImplementation((cmd: { RequestItems: Record<string, unknown[]> }) => {
      const item = cmd.RequestItems.MyTable[0];
      return Promise.resolve({ UnprocessedItems: { MyTable: [item] } });
    });

    const promise = batchUpsert(ddbDocClient, 'MyTable', [{ id: 1 }]);
    await jest.runAllTimersAsync();
    await expect(promise).rejects.toThrow('too many retries');
  } finally {
    jest.useRealTimers();
  }
});
