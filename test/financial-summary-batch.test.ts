// このファイルをモジュールにする。トップレベルのimport/exportが無いとファイルの宣言が
// グローバルスコープに出てしまい、同名の宣言(mockSend・handlerなど)を持つ他のテスト
// ファイルとts-jestの型検査で衝突する(TS2451)。どのファイルが同じワーカーに割り当て
// られるかで発火するため非決定的に落ちていた。
export {};

const mockDdbSend = jest.fn();
const mockGetApiKey = jest.fn();
const mockScanTickerColumn = jest.fn();
const mockFetchWithRetry = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  QueryCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'Query' })),
  BatchWriteCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'BatchWrite' })),
}));

jest.mock('../lambda/shared/jquants-batch-client', () => ({
  getApiKey: (...args: unknown[]) => mockGetApiKey(...args),
  scanTickerColumn: (...args: unknown[]) => mockScanTickerColumn(...args),
  fetchWithRetry: (...args: unknown[]) => mockFetchWithRetry(...args),
  normalizeDate: (raw: string) => (raw.includes('-') ? raw : `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`),
}));

process.env.FINANCIAL_TABLE_NAME = 'JQuantsFinancialSummary';
process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:JQuantsApiKey';
process.env.LOOKBACK_DAYS = '3';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/financial-summary-batch/index') as { handler: () => Promise<void> };

function putItems(): Record<string, unknown>[] {
  return mockDdbSend.mock.calls
    .map(([cmd]) => cmd as Record<string, unknown>)
    .filter((cmd) => cmd.__type === 'BatchWrite')
    .flatMap((cmd) => {
      const requestItems = cmd.RequestItems as Record<string, { PutRequest: { Item: Record<string, unknown> } }[]>;
      return requestItems['JQuantsFinancialSummary'].map((r) => r.PutRequest.Item);
    });
}

beforeEach(() => {
  mockDdbSend.mockReset();
  mockGetApiKey.mockReset();
  mockScanTickerColumn.mockReset();
  mockFetchWithRetry.mockReset();

  mockDdbSend.mockResolvedValue({}); // default: Query -> no existing item, BatchWrite -> success
  mockGetApiKey.mockResolvedValue('test-api-key');
  mockFetchWithRetry.mockResolvedValue({ json: async () => ({ data: [] }) });
});

test('does nothing when there are no target tickers', async () => {
  mockScanTickerColumn.mockResolvedValueOnce([]);

  await handler();

  expect(mockGetApiKey).not.toHaveBeenCalled();
  expect(mockFetchWithRetry).not.toHaveBeenCalled();
});

test('backfills a new ticker (no existing summary) using a code-only full-history fetch', async () => {
  mockScanTickerColumn.mockResolvedValueOnce(['7203']);
  mockDdbSend.mockImplementation((cmd: Record<string, unknown>) => {
    if (cmd.__type === 'Query') return Promise.resolve({ Items: [] }); // no existing summary -> new ticker
    return Promise.resolve({});
  });
  mockFetchWithRetry.mockImplementation((url: string) => {
    if (url.includes('code=7203')) {
      return Promise.resolve({
        json: async () => ({
          data: [
            {
              Code: '72030',
              DiscDate: '2026-05-08',
              DocType: 'FYFinancialStatements_Consolidated_IFRS',
              CurPerType: 'FY',
              Sales: '45095325000000',
              OP: '4795586000000',
              OdP: '',
              NP: '4765002000000',
              EPS: '345.42',
            },
          ],
        }),
      });
    }
    return Promise.resolve({ json: async () => ({ data: [] }) });
  });

  await handler();

  const backfillCall = mockFetchWithRetry.mock.calls.find(([url]) => (url as string).includes('code=7203'));
  expect(backfillCall).toBeDefined();
  expect(putItems()).toContainEqual(
    expect.objectContaining({ ticker: '7203', discDate: '2026-05-08', sales: '45095325000000' }),
  );
});

test('does not backfill an existing ticker (already has a summary)', async () => {
  mockScanTickerColumn.mockResolvedValueOnce(['7203']);
  mockDdbSend.mockImplementation((cmd: Record<string, unknown>) => {
    if (cmd.__type === 'Query') return Promise.resolve({ Items: [{ ticker: '7203', discDate: '2026-02-01' }] });
    return Promise.resolve({});
  });

  await handler();

  const backfillCall = mockFetchWithRetry.mock.calls.find(([url]) => (url as string).includes('code=7203'));
  expect(backfillCall).toBeUndefined();
});

test('checks LOOKBACK_DAYS+1 recent dates with date-only bulk fetch (no code param)', async () => {
  mockScanTickerColumn.mockResolvedValueOnce(['7203']);

  await handler();

  const dateCalls = mockFetchWithRetry.mock.calls.filter(([url]) => (url as string).includes('date='));
  expect(dateCalls).toHaveLength(4); // LOOKBACK_DAYS=3 -> offsets 0..3
  for (const [url] of dateCalls) {
    expect(url as string).not.toContain('code=');
  }
});

test('writes only target tickers from a date-bulk response, matching a 4-digit ticker to its 5-digit code', async () => {
  mockScanTickerColumn.mockResolvedValueOnce(['7203']);
  mockFetchWithRetry.mockImplementation((url: string) => {
    if (url.includes('date=')) {
      return Promise.resolve({
        json: async () => ({
          data: [
            {
              Code: '72030',
              DiscDate: '2026-08-01',
              DocType: 'FYFinancialStatements_Consolidated_IFRS',
              CurPerType: 'FY',
              Sales: '100',
              OP: '10',
              OdP: '9',
              NP: '8',
              EPS: '1.0',
            },
            {
              Code: '13010',
              DiscDate: '2026-08-01',
              DocType: 'FYFinancialStatements_Consolidated_IFRS',
              CurPerType: 'FY',
              Sales: '999',
              OP: '99',
              OdP: '98',
              NP: '97',
              EPS: '9.0',
            },
          ],
        }),
      });
    }
    return Promise.resolve({ json: async () => ({ data: [] }) });
  });

  await handler();

  const items = putItems();
  expect(items).toContainEqual(expect.objectContaining({ ticker: '7203', sales: '100' }));
  expect(items.some((item) => item.ticker === '13010')).toBe(false);
});

test('defers new-ticker backfills beyond the per-run cap, but still checks recent dates for everyone', async () => {
  const manyNewTickers = Array.from({ length: 151 }, (_, i) => `T${String(i).padStart(4, '0')}`);
  mockScanTickerColumn.mockResolvedValueOnce(manyNewTickers);
  mockDdbSend.mockImplementation((cmd: Record<string, unknown>) => {
    if (cmd.__type === 'Query') return Promise.resolve({ Items: [] }); // all are new
    return Promise.resolve({});
  });

  await handler();

  const backfillCalls = mockFetchWithRetry.mock.calls.filter(([url]) => (url as string).includes('code='));
  expect(backfillCalls).toHaveLength(150);
  const dateCalls = mockFetchWithRetry.mock.calls.filter(([url]) => (url as string).includes('date='));
  expect(dateCalls).toHaveLength(4);
});

test('continues past a single ticker backfill failure and a single date fetch failure', async () => {
  mockScanTickerColumn.mockResolvedValueOnce(['7203', '9999']);
  mockDdbSend.mockImplementation((cmd: Record<string, unknown>) => {
    if (cmd.__type === 'Query') return Promise.resolve({ Items: [] });
    return Promise.resolve({});
  });
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    let dateCallCount = 0;
    mockFetchWithRetry.mockImplementation((url: string) => {
      if (url.includes('code=7203')) return Promise.reject(new Error('boom'));
      if (url.includes('code=9999')) return Promise.resolve({ json: async () => ({ data: [] }) });
      if (url.includes('date=')) {
        dateCallCount++;
        if (dateCallCount === 1) return Promise.reject(new Error('date boom'));
        return Promise.resolve({ json: async () => ({ data: [] }) });
      }
      return Promise.resolve({ json: async () => ({ data: [] }) });
    });

    await handler();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('7203'), expect.any(Error));
  } finally {
    errorSpy.mockRestore();
  }
});

test('checks discDate against a lookback cutoff, not just row existence, when classifying a ticker as new-vs-existing', async () => {
  mockScanTickerColumn.mockResolvedValueOnce(['7203']);
  mockDdbSend.mockImplementation((cmd: Record<string, unknown>) => {
    if (cmd.__type === 'Query') return Promise.resolve({ Items: [] });
    return Promise.resolve({});
  });

  await handler();

  const queryCall = mockDdbSend.mock.calls.find(([cmd]) => (cmd as Record<string, unknown>).__type === 'Query');
  expect(queryCall).toBeDefined();
  const queryCmd = queryCall![0] as { KeyConditionExpression: string; ExpressionAttributeValues: Record<string, unknown> };
  expect(queryCmd.KeyConditionExpression).toBe('ticker = :ticker AND discDate < :cutoff');
  expect(queryCmd.ExpressionAttributeValues[':cutoff']).toEqual(expect.any(String));
});

test('dedupes same-ticker same-discDate backfill items before writing (keeps the last one)', async () => {
  mockScanTickerColumn.mockResolvedValueOnce(['7203']);
  mockDdbSend.mockImplementation((cmd: Record<string, unknown>) => {
    if (cmd.__type === 'Query') return Promise.resolve({ Items: [] });
    return Promise.resolve({});
  });
  mockFetchWithRetry.mockImplementation((url: string) => {
    if (url.includes('code=7203')) {
      return Promise.resolve({
        json: async () => ({
          data: [
            {
              Code: '72030',
              DiscDate: '2026-05-08',
              DocType: 'ForecastRevision_Consolidated_IFRS',
              CurPerType: 'FY',
              Sales: '1',
              OP: '1',
              OdP: '1',
              NP: '1',
              EPS: '0.1',
            },
            {
              Code: '72030',
              DiscDate: '2026-05-08',
              DocType: 'FYFinancialStatements_Consolidated_IFRS',
              CurPerType: 'FY',
              Sales: '999',
              OP: '99',
              OdP: '98',
              NP: '97',
              EPS: '9.0',
            },
          ],
        }),
      });
    }
    return Promise.resolve({ json: async () => ({ data: [] }) });
  });

  await handler();

  const items = putItems().filter((item) => item.ticker === '7203' && item.discDate === '2026-05-08');
  expect(items).toHaveLength(1);
  expect(items[0].sales).toBe('999');
});

test('counts failed backfill attempts against the cap, not just successes', async () => {
  const manyNewTickers = Array.from({ length: 151 }, (_, i) => `T${String(i).padStart(4, '0')}`);
  mockScanTickerColumn.mockResolvedValueOnce(manyNewTickers);
  mockDdbSend.mockImplementation((cmd: Record<string, unknown>) => {
    if (cmd.__type === 'Query') return Promise.resolve({ Items: [] });
    return Promise.resolve({});
  });
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    mockFetchWithRetry.mockImplementation((url: string) => {
      if (url.includes('code=')) return Promise.reject(new Error('boom'));
      return Promise.resolve({ json: async () => ({ data: [] }) });
    });

    await handler();

    const backfillCalls = mockFetchWithRetry.mock.calls.filter(([url]) => (url as string).includes('code='));
    expect(backfillCalls).toHaveLength(150);
  } finally {
    errorSpy.mockRestore();
  }
});

test('throws when every date fetch/upsert fails (so a broken run alarms instead of reporting success)', async () => {
  mockScanTickerColumn.mockResolvedValueOnce(['7203']);
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    mockFetchWithRetry.mockImplementation((url: string) => {
      if (url.includes('date=')) return Promise.reject(new Error('boom'));
      return Promise.resolve({ json: async () => ({ data: [] }) });
    });

    await expect(handler()).rejects.toThrow('all 4 date fetch/upsert calls failed');
  } finally {
    errorSpy.mockRestore();
  }
});
