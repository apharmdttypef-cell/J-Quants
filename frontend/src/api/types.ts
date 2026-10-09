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

// 逆日歩予測の判定(充足率P90)と同じ4段階。APIが予測テーブルの判定をそのまま返す。
export type YutaiRiskStatus = 'safe' | 'caution' | 'danger' | 'general-only' | 'na';

export type YutaiCrossEligible = 'ok' | 'ng' | 'unknown';
export type YutaiHoldingKind = 'none' | 'bonus' | 'required' | 'unknown';

export interface BenefitTier {
  shares: number;
  // 金額が読めない段階(「ー」= 該当なし、自社製品の個数表記など)はnull。
  // 表示にはrawTextを使う。
  valueYen: number | null;
  rawText: string;
}

export interface BenefitGroup {
  title: string | null;
  holdingMonths: number | null;
  holdingRaw: string | null;
  tiers: BenefitTier[];
}

export interface GyakuhibuActualRef {
  rightsDate: string;
  avgRate: number;
  days: number;
  perShareRate: number;
  cost: number;
  // 必要株数が未取得で単元株数で代用したコスト。画面で注記する。
  basedOnUnitShares: boolean;
}

// 優待条件(個別ページ由来)。2つの一覧と詳細の3箇所で共通。
export interface YutaiBenefitFields {
  unitShares: number;
  requiredShares: number | null;
  crossEligible: YutaiCrossEligible;
  holdingKind: YutaiHoldingKind;
  holdingMinMonths: number | null;
  minTierValueYen: number | null;
  benefitParseWarning: string | null;
}

// 条件 + 価格・コスト。2つの一覧専用。両方の一覧で同じ判断ができるよう、
// 列定義(lib/yutai-cross.tsx)はこの型だけに依存させる。
//
// 詳細(YutaiDetail)はこちらを継承しない。詳細は既にリクエスト時点のライブ値を
// basicInfo.closePriceで持っており、precomputeのスナップショットを同名で並べると
// 同じレスポンスに違う値が2つ入る。
export interface YutaiCrossFields extends YutaiBenefitFields {
  closePrice: number | null;
  requiredInvestment: number | null;
  lastGyakuhibu: GyakuhibuActualRef | null;
  sameMonthLastYearGyakuhibu: GyakuhibuActualRef | null;
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

export interface YutaiDetail extends YutaiBenefitFields {
  ticker: string;
  companyName: string | null;
  content: string;
  value: number | null;
  rightsDate: string | null;
  benefitGroups: BenefitGroup[];
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

// 'general-only'は制度信用で売れない銘柄(貸借区分が信用・その他)。一般信用でしかクロスできない。
export type YutaiForecastStatus = 'safe' | 'caution' | 'danger' | 'general-only' | 'na';
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

export interface YutaiForecastListItem extends YutaiCrossFields {
  ticker: string;
  companyName?: string;
  content: string;
  value: number | null;
  rightsDate: string | null;
  riskStatus: YutaiRiskStatus;
  maxGyakuhibu: number | null;
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
  // 1株1日あたりの料率と品貸日数。実績逆日歩は totalAmount ではなく
  // avgRate × days × 株数 で組み直す(totalAmountは記録当時のunitSharesを掛けた値で、
  // 必要株数とは別の株数を指しているため読まない)。
  avgRate: number;
  days: number;
  // 記録当時のunitShares基準の金額。互換のため残っているが表示には使わない。
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
  // 優待の権利獲得に必要な実際の株数。未取得はnullで、その場合は単元株数で代用する。
  requiredShares: number | null;
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
