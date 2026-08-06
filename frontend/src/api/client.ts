import type { FinancialSummary, PricesResponse, WatchlistTicker } from './types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string | undefined;

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API_BASE_URL) {
    throw new Error('VITE_API_BASE_URL is not configured. See frontend/.env.example.');
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const body = await response.json().catch(() => undefined);

  if (!response.ok) {
    const message = (body as { message?: string } | undefined)?.message ?? response.statusText;
    throw new ApiError(response.status, message);
  }

  return body as T;
}

export function fetchTickers(): Promise<{ tickers: WatchlistTicker[] }> {
  return request('/tickers');
}

export function fetchPrices(ticker: string): Promise<PricesResponse> {
  return request(`/tickers/${ticker}/prices?range=12w`);
}

export function fetchSummary(ticker: string): Promise<FinancialSummary> {
  return request(`/tickers/${ticker}/summary`);
}

export function addTicker(ticker: string): Promise<WatchlistTicker> {
  return request('/tickers', { method: 'POST', body: JSON.stringify({ ticker }) });
}

export function removeTicker(ticker: string): Promise<void> {
  return request(`/tickers/${ticker}`, { method: 'DELETE' });
}
