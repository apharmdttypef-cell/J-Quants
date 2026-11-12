const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  GetCommand: jest.fn((input) => input),
  QueryCommand: jest.fn((input) => input),
  ScanCommand: jest.fn((input) => input),
}));

process.env.TABLE_NAME = 'prices';
process.env.YUTAI_MASTER_TABLE_NAME = 'yutai-master';
process.env.MARGIN_BALANCE_TABLE_NAME = 'margin';
process.env.GYAKUHIBU_ACTUAL_TABLE_NAME = 'actual';
process.env.GYAKUHIBU_FORECAST_TABLE_NAME = 'forecast';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { loadYutaiForecastDetail } = require('../lambda/shared/yutai-forecast-detail');

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
});

test('returns null when the ticker is not in the yutai master', async () => {
  mockSend.mockResolvedValueOnce({}); // master Get
  await expect(loadYutaiForecastDetail('0000')).resolves.toBeNull();
});

test('returns the API body and the abolition notice from the master row', async () => {
  mockSend
    .mockResolvedValueOnce({ Item: { ticker: '1234', companyName: 'テスト', content: 'QUO', value: 1000, unitShares: 100,
      requiredShares: 100, rightsMonths: [3], maxGyakuhibu: 500, closePrice: 1500,
      abolitionNotice: { disclosedAt: '2026-10-13', title: '株主優待制度の廃止に関するお知らせ' } } })
    .mockResolvedValueOnce({ Item: { ticker: '1234', forecastStatus: 'safe', tickerSamples: 3, poolSamples: 10 } }) // forecast
    .mockResolvedValueOnce({ Item: { ticker: '_POOL_', bins: [{ label: 'a' }] } }) // pool
    .mockResolvedValueOnce({ Items: [{ rightsDate: '2026-03-27', financingBalance: 100, lendingBalance: 200, avgRate: 1, days: 1 }] }) // actual
    .mockResolvedValueOnce({ Items: [] }); // margin
  const result = await loadYutaiForecastDetail('1234');
  expect(result?.abolitionNotice).toEqual({ disclosedAt: '2026-10-13', title: '株主優待制度の廃止に関するお知らせ' });
  expect(result?.detail.ticker).toBe('1234');
  expect(result?.detail.forecast.forecastStatus).toBe('safe');
  expect(result?.detail.poolBins).toEqual([{ label: 'a' }]);
  expect(result?.detail.history).toHaveLength(1);
  expect(result?.detail).not.toHaveProperty('abolitionNotice');
});

test('abolitionNotice is null when the master row has none', async () => {
  mockSend.mockResolvedValueOnce({ Item: { ticker: '1234', content: 'QUO', unitShares: 100, rightsMonths: [3] } });
  const result = await loadYutaiForecastDetail('1234');
  expect(result?.abolitionNotice).toBeNull();
});
