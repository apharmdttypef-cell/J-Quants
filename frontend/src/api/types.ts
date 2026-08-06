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
