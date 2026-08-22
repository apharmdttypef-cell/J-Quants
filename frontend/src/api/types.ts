export interface WatchlistTicker {
  ticker: string;
  companyName?: string;
  addedAt?: string;
}

export interface PricePoint {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

export interface PricesResponse {
  ticker: string;
  range: '12w';
  prices: PricePoint[];
}

export interface FinancialSummary {
  ticker: string;
  discDate: string;
  docType: string;
  curPerType: string;
  sales: string;
  operatingProfit: string;
  ordinaryProfit: string;
  netProfit: string;
  eps: string;
}

export type YutaiRiskStatus = 'safe' | 'danger' | 'na';

export interface YutaiListItem {
  ticker: string;
  companyName?: string;
  content: string;
  value: number;
  rightsDate: string | null;
  riskStatus: YutaiRiskStatus;
  maxGyakuhibu: number | null;
}

export interface YutaiListResponse {
  tickers: YutaiListItem[];
  currentMonthLastTradableDate: string;
}

export interface YutaiRiskInfo {
  maxGyakuhibu: number | null;
  maxRate: number | null;
  days: number | null;
  riskStatus: YutaiRiskStatus;
}

export interface YutaiRightsHistoryPoint {
  rightsDate: string;
  totalAmount: number;
  days: number;
  avgRate: number;
}

export interface YutaiBasicInfo {
  closePrice: number | null;
  volume: number | null;
  per: number | null;
  sales: string | null;
  operatingProfit: string | null;
  netProfit: string | null;
  eps: string | null;
}

export interface YutaiDetail {
  ticker: string;
  companyName: string | null;
  content: string;
  value: number;
  unitShares: number;
  rightsDate: string | null;
  basicInfo: YutaiBasicInfo;
  risk: YutaiRiskInfo;
  rightsHistory: YutaiRightsHistoryPoint[];
}

export interface MarginTrendPoint {
  date: string;
  financingBalance: number;
  lendingBalance: number;
}

export interface MarginTrendResponse {
  ticker: string;
  range: '1y';
  points: MarginTrendPoint[];
}
