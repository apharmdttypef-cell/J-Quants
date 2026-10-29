import type {
  YutaiCrossEligible,
  MarginTrendResponse,
  PricesResponse,
  YutaiDetail,
  YutaiForecastStatus,
  YutaiForecastListResponse,
  YutaiForecastDetail,
  YutaiTdnetEventsResponse,
} from './types';
import { getAccessToken, signIn } from '../lib/auth';

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

  const accessToken = await getAccessToken();
  if (!accessToken) {
    // ログインが切れている(リフレッシュにも失敗した)。ログイン画面へ戻す。
    signIn();
    throw new ApiError(401, 'ログインの有効期限が切れました。ログイン画面へ移動します');
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...init?.headers,
    },
  });

  if (response.status === 401) {
    // トークンが無効になった(管理者による停止・失効など)。ログインし直してもらう。
    signIn();
    throw new ApiError(401, 'ログインの有効期限が切れました。ログイン画面へ移動します');
  }

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

export function fetchPrices(ticker: string): Promise<PricesResponse> {
  return request(`/tickers/${ticker}/prices?range=12w`);
}

export interface YutaiListParams {
  rightsDateFrom?: string;
  rightsDateTo?: string;
  keyword?: string;
  priceMin?: number;
  priceMax?: number;
  investmentMin?: number;
  investmentMax?: number;
  crossEligible?: YutaiCrossEligible | 'all';
}

// 数値の0は有効な下限なので、truthy判定ではなくundefined判定で書き出す。
function setNumberParam(query: URLSearchParams, key: string, value: number | undefined): void {
  if (value !== undefined) query.set(key, String(value));
}

function setCrossParams(query: URLSearchParams, params: YutaiListParams): void {
  setNumberParam(query, 'priceMin', params.priceMin);
  setNumberParam(query, 'priceMax', params.priceMax);
  setNumberParam(query, 'investmentMin', params.investmentMin);
  setNumberParam(query, 'investmentMax', params.investmentMax);
  if (params.crossEligible) query.set('crossEligible', params.crossEligible);
}

export function fetchYutaiDetail(ticker: string): Promise<YutaiDetail> {
  return request(`/yutai/${ticker}`);
}

export function fetchYutaiMarginTrend(ticker: string): Promise<MarginTrendResponse> {
  return request(`/yutai/${ticker}/margin-trend`);
}

export function fetchYutaiTdnetEvents(): Promise<YutaiTdnetEventsResponse> {
  return request('/yutai/tdnet-events');
}

export interface YutaiForecastListParams extends YutaiListParams {
  forecastStatus?: YutaiForecastStatus | 'all';
}

export function fetchYutaiForecastList(params: YutaiForecastListParams): Promise<YutaiForecastListResponse> {
  const query = new URLSearchParams();
  if (params.rightsDateFrom) query.set('rightsDateFrom', params.rightsDateFrom);
  if (params.rightsDateTo) query.set('rightsDateTo', params.rightsDateTo);
  if (params.keyword) query.set('keyword', params.keyword);
  if (params.forecastStatus) query.set('forecastStatus', params.forecastStatus);
  setCrossParams(query, params);
  return request(`/yutai/forecast?${query}`);
}

export function fetchYutaiForecastDetail(ticker: string): Promise<YutaiForecastDetail> {
  return request(`/yutai/${ticker}/forecast`);
}
