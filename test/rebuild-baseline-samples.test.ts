const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  ScanCommand: jest.fn((input: unknown) => input),
}));

import { rebuildBaselineSamples } from '../scripts/lib/rebuild-baseline-samples';

beforeEach(() => {
  mockDdbSend.mockReset();
});

test('rebuilds per-ticker raw fillRatio arrays and per-bin pool fillRatio arrays from JQuantsGyakuhibuActual/JQuantsYutaiMaster', async () => {
  mockDdbSend
    .mockResolvedValueOnce({
      // JQuantsYutaiMaster scan (unitSharesByTicker用)
      Items: [{ ticker: '1111', unitShares: 100 }],
    })
    .mockResolvedValueOnce({
      // JQuantsGyakuhibuActual scan
      Items: [
        {
          ticker: '1111',
          rightsDate: '2025-09-26',
          financingBalance: 100,
          lendingBalance: 500,
          avgRate: 1,
          days: 1,
          maxRateActual: 2,
          enriched: true,
        },
        {
          ticker: '9999',
          rightsDate: '2025-03-27',
          financingBalance: 100,
          lendingBalance: 500,
          avgRate: 1,
          days: 1,
          maxRateActual: 2,
          enriched: true,
        },
      ],
    });

  const result = await rebuildBaselineSamples('JQuantsYutaiMaster', 'JQuantsGyakuhibuActual');

  expect(result.tickerSamplesByTicker.get('1111')).toBeDefined();
  expect(result.tickerSamplesByTicker.get('1111')!.length).toBe(1);
  expect(result.allSamples.length).toBe(2); // 1111と9999、両方ともプール全体には含まれる
});
