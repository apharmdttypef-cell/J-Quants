const mockSecretsSend = jest.fn();
const mockDdbSend = jest.fn();
const mockFetch = jest.fn();

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => input),
}));

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  ScanCommand: jest.fn((input: unknown) => input),
}));

import { getApiKey, getTargetTickers, fetchWithRetry, formatDate, normalizeDate } from '../lambda/shared/jquants-batch-client';

beforeEach(() => {
  mockSecretsSend.mockReset();
  mockDdbSend.mockReset();
  mockFetch.mockReset();
  (global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;
});

// cachedApiKeyはモジュールスコープでテスト間を跨いで保持されるため、
// 「失敗」ケースを先に置く(成功キャッシュが一度できると以降secretsSendが呼ばれなくなるため)。
describe('getApiKey', () => {
  test('throws when the secret has no string value', async () => {
    mockSecretsSend.mockResolvedValueOnce({});
    await expect(getApiKey('arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:JQuantsApiKey')).rejects.toThrow(
      'no string value',
    );
  });

  test('fetches the API key from Secrets Manager and caches it for subsequent calls', async () => {
    mockSecretsSend.mockResolvedValueOnce({ SecretString: 'test-api-key' });
    const first = await getApiKey('arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:JQuantsApiKey');
    const second = await getApiKey('arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:JQuantsApiKey');
    expect(first).toBe('test-api-key');
    expect(second).toBe('test-api-key');
    expect(mockSecretsSend).toHaveBeenCalledTimes(1);
  });
});

describe('getTargetTickers', () => {
  test('returns the union of watchlist and yutai-master tickers, deduped', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Items: [{ ticker: '7203' }] })
      .mockResolvedValueOnce({ Items: [{ ticker: '7203' }, { ticker: '9999' }] });

    const tickers = await getTargetTickers('JQuantsWatchlist', 'JQuantsYutaiMaster');

    expect(tickers.sort()).toEqual(['7203', '9999']);
  });

  test('paginates through ScanCommand results using LastEvaluatedKey', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Items: [{ ticker: '1111' }], LastEvaluatedKey: { ticker: '1111' } })
      .mockResolvedValueOnce({ Items: [{ ticker: '2222' }] })
      .mockResolvedValueOnce({ Items: [] });

    const tickers = await getTargetTickers('JQuantsWatchlist', 'JQuantsYutaiMaster');

    expect(tickers.sort()).toEqual(['1111', '2222']);
  });
});

describe('fetchWithRetry', () => {
  test('returns the response when the request succeeds', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const response = await fetchWithRetry('https://api.example.com/x', 'key', 0, 5);

    expect(response.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith('https://api.example.com/x', { headers: { 'x-api-key': 'key' } });
  });

  test('retries with backoff on 429 and eventually succeeds', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429 }).mockResolvedValueOnce({ ok: true });

    const response = await fetchWithRetry('https://api.example.com/x', 'key', 0, 5);

    expect(response.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('throws when the response is not ok and not a 429', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'server error' });

    await expect(fetchWithRetry('https://api.example.com/x', 'key', 0, 5)).rejects.toThrow('J-Quants API error 500');
  });

  test('gives up after maxRetries and throws', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' });

    await expect(fetchWithRetry('https://api.example.com/x', 'key', 0, 1)).rejects.toThrow('J-Quants API error 429');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('formatDate', () => {
  test('formats a Date as YYYYMMDD', () => {
    expect(formatDate(new Date('2026-08-18T00:00:00Z'))).toBe('20260818');
  });
});

describe('normalizeDate', () => {
  test('leaves an already-hyphenated date unchanged', () => {
    expect(normalizeDate('2026-08-18')).toBe('2026-08-18');
  });

  test('converts YYYYMMDD to YYYY-MM-DD', () => {
    expect(normalizeDate('20260818')).toBe('2026-08-18');
  });
});
