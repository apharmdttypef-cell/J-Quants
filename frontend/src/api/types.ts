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
  value: number | null;
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
  value: number | null;
  unitShares: number;
  rightsDate: string | null;
  basicInfo: YutaiBasicInfo;
  risk: YutaiRiskInfo;
  rightsHistory: YutaiRightsHistoryPoint[];
  features: YutaiFeatures;
}

export interface MarginTrendPoint {
  date: string;
  // 全上場銘柄一括取得の対象に含まれる値欠損レコード(J-Quants側のデータ欠落)は
  // nullとして書き込まれる(margin-balance-batch参照)。Rechartsの<Line>はnullを
  // その点だけ欠けとして描画するため、フロント側の追加ハンドリングは不要。
  financingBalance: number | null;
  lendingBalance: number | null;
}

export interface MarginTrendResponse {
  ticker: string;
  range: '1y';
  points: MarginTrendPoint[];
}

export type YutaiForecastStatus = 'safe' | 'caution' | 'danger' | 'na';
export type YutaiForecastScenario = 'last-rights' | 'current-tse' | 'none';

export interface YutaiForecast {
  scenario: YutaiForecastScenario;
  excessRatio: number | null;
  bin: string | null;
  pOccur: number | null;
  fillP50: number | null;
  fillP90: number | null;
  fillMean: number | null;
  forecastP50: number | null;
  forecastP90: number | null;
  forecastMean: number | null;
  expectedNet: number | null;
  forecastStatus: YutaiForecastStatus;
  tickerSamples: number;
  poolSamples: number;
}

export type YutaiTseLagBucket = '0-7' | '8-21' | '22+';

// 東証信用残ベースの現在需給予測(スタンダードプラン依存)。APIはフラグ無効時にnullを返す。
export interface YutaiTseForecast extends YutaiForecast {
  snapshotDate: string;
  lagDays: number;
  lagBucket: YutaiTseLagBucket;
  financingBalance: number;
  lendingBalance: number;
  lendingGrowth4w: number | null;
}

export interface YutaiFeatures {
  tseMargin: boolean;
}

export interface YutaiForecastListItem {
  ticker: string;
  companyName?: string;
  content: string;
  value: number | null;
  rightsDate: string | null;
  riskStatus: YutaiRiskStatus;
  maxGyakuhibu: number | null;
  closePrice: number | null;
  forecast: YutaiForecast;
  tseForecast: YutaiTseForecast | null;
}

export interface YutaiForecastListResponse {
  tickers: YutaiForecastListItem[];
  currentMonthLastTradableDate: string;
  poolComputedAt: string | null;
  features: YutaiFeatures;
}

export interface YutaiForecastHistoryPoint {
  rightsDate: string;
  excessRatio: number | null;
  excessShares: number;
  financingBalance: number;
  lendingBalance: number;
  lendingPrice: number | null;
  fillRatio: number | null;
  totalAmount: number;
  maxRateActual: number | null;
  bidRank: string | null;
  restriction: string | null;
  emergencyMeasure: string | null;
  occurred: boolean;
}

export interface PoolBin {
  label: string;
  lo: number | null;
  hi: number | null;
  n: number;
  pOccur: number;
  fillP50: number;
  fillP90: number;
  fillMean: number;
}

export interface YutaiForecastMarginLatest {
  date: string;
  financingBalance: number;
  lendingBalance: number;
}

export interface YutaiForecastDetail {
  ticker: string;
  companyName: string | null;
  content: string;
  value: number | null;
  unitShares: number;
  rightsDate: string | null;
  maxGyakuhibu: number | null;
  closePrice: number | null;
  forecast: YutaiForecast;
  tseForecast: YutaiTseForecast | null;
  history: YutaiForecastHistoryPoint[];
  poolBins: PoolBin[];
  marginTrend: { latest: YutaiForecastMarginLatest | null };
  features: YutaiFeatures;
}

export type YutaiTdnetEventType = 'start' | 'update' | 'abolition';

export interface YutaiTdnetEvent {
  ticker: string;
  companyName: string;
  eventType: YutaiTdnetEventType;
  disclosureTitle: string;
  disclosedAt: string;
  recordedAt: string;
}

export interface YutaiTdnetEventsResponse {
  events: YutaiTdnetEvent[];
}
