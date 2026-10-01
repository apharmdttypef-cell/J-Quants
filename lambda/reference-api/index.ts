import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getLocalTradingCalendar, isTradingDay, nextRightsDate } from '../shared/trading-calendar';
import { excessRatio, fillRatio } from '../shared/gyakuhibu-forecast';
import type { GyakuhibuActualRef } from '../shared/gyakuhibu-actual-summary';

const TABLE_NAME = process.env.TABLE_NAME!;
const FINANCIAL_TABLE_NAME = process.env.FINANCIAL_TABLE_NAME!;
const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const MARGIN_BALANCE_TABLE_NAME = process.env.MARGIN_BALANCE_TABLE_NAME!;
const GYAKUHIBU_ACTUAL_TABLE_NAME = process.env.GYAKUHIBU_ACTUAL_TABLE_NAME!;
const GYAKUHIBU_FORECAST_TABLE_NAME = process.env.GYAKUHIBU_FORECAST_TABLE_NAME!;
const YUTAI_TDNET_EVENT_TABLE_NAME = process.env.YUTAI_TDNET_EVENT_TABLE_NAME!;
// 日付範囲(from/to)ではなく「保存済みの最新N件」で返す方式(12週間分の営業日 ≈ 60件)。
// 日付境界で絞るより単純で、取得が数営業日遅れても直近チャートの見た目は変わらない。
const PRICE_RANGE_TRADING_DAYS = 60;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function isKnownTicker(ticker: string): Promise<boolean> {
  const result = await ddbDocClient.send(
    new GetCommand({ TableName: YUTAI_MASTER_TABLE_NAME, Key: { ticker } }),
  );
  return result.Item !== undefined;
}

async function getPrices(ticker: string, range: string | undefined): Promise<APIGatewayProxyResultV2> {
  if (!(await isKnownTicker(ticker))) {
    return jsonResponse(404, { message: `Unknown ticker: ${ticker}` });
  }
  if (range !== undefined && range !== '12w') {
    return jsonResponse(400, { message: 'Only range=12w is supported' });
  }

  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: { ':ticker': ticker },
      ScanIndexForward: false,
      Limit: PRICE_RANGE_TRADING_DAYS,
    }),
  );

  const prices = (result.Items ?? [])
    .map((item) => ({
      date: item.date as string,
      open: item.open,
      high: item.high,
      low: item.low,
      close: item.close,
      volume: item.volume,
    }))
    .reverse();

  return jsonResponse(200, { ticker, range: '12w', prices });
}

async function getSummary(ticker: string): Promise<APIGatewayProxyResultV2> {
  if (!(await isKnownTicker(ticker))) {
    return jsonResponse(404, { message: `Unknown ticker: ${ticker}` });
  }

  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: FINANCIAL_TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: { ':ticker': ticker },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );

  const latest = result.Items?.[0];
  if (!latest) {
    return jsonResponse(404, { message: `No financial summary available yet for ${ticker}` });
  }

  return jsonResponse(200, {
    ticker,
    discDate: latest.discDate,
    docType: latest.docType,
    curPerType: latest.curPerType,
    sales: latest.sales,
    operatingProfit: latest.operatingProfit,
    ordinaryProfit: latest.ordinaryProfit,
    netProfit: latest.netProfit,
    eps: latest.eps,
  });
}

type RiskStatus = 'safe' | 'danger' | 'na';
type CrossEligible = 'ok' | 'ng' | 'unknown';
type HoldingKind = 'none' | 'bonus' | 'required' | 'unknown';

// yutai-detail-sync-batchが書く株数段階。詳細エンドポイントが素通しで返すだけなので
// ここで中身を検証しない(検証はパーサー側の責務)。
interface BenefitTier { shares: number; valueYen: number | null; rawText: string }
interface BenefitGroup { title: string | null; holdingMonths: number | null; holdingRaw: string | null; tiers: BenefitTier[] }

interface YutaiMasterRow {
  ticker: string;
  companyName?: string;
  content: string;
  value: number | null;
  unitShares: number;
  rightsMonths: number[];
  riskStatus: RiskStatus;
  maxGyakuhibu: number | null;
  maxRate: number | null;
  days: number | null;
  closePrice: number | null;
  requiredShares: number | null;
  crossEligible: CrossEligible;
  holdingKind: HoldingKind;
  holdingMinMonths: number | null;
  minTierValueYen: number | null;
  benefitParseWarning: string | null;
  requiredInvestment: number | null;
  lastGyakuhibu: GyakuhibuActualRef | null;
  sameMonthLastYearGyakuhibu: GyakuhibuActualRef | null;
  benefitGroups: BenefitGroup[];
}

// DynamoDBの行をYutaiMasterRowにする。個別ページ取得前の行は新項目を持たないため、
// 省略や例外ではなく既定値(null / 'unknown' / [])で埋める。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toYutaiMasterRow(item: Record<string, any>): YutaiMasterRow {
  return {
    ticker: item.ticker,
    companyName: item.companyName,
    content: item.content,
    value: item.value ?? null,
    unitShares: item.unitShares,
    rightsMonths: item.rightsMonths ?? [],
    riskStatus: item.riskStatus ?? 'na',
    maxGyakuhibu: item.maxGyakuhibu ?? null,
    maxRate: item.maxRate ?? null,
    days: item.days ?? null,
    closePrice: item.closePrice ?? null,
    requiredShares: item.requiredShares ?? null,
    crossEligible: item.crossEligible ?? 'unknown',
    holdingKind: item.holdingKind ?? 'unknown',
    holdingMinMonths: item.holdingMinMonths ?? null,
    minTierValueYen: item.minTierValueYen ?? null,
    benefitParseWarning: item.benefitParseWarning ?? null,
    requiredInvestment: item.requiredInvestment ?? null,
    lastGyakuhibu: item.lastGyakuhibu ?? null,
    sameMonthLastYearGyakuhibu: item.sameMonthLastYearGyakuhibu ?? null,
    benefitGroups: item.benefitGroups ?? [],
  };
}

async function scanYutaiMaster(): Promise<YutaiMasterRow[]> {
  const rows: YutaiMasterRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({ TableName: YUTAI_MASTER_TABLE_NAME, ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of result.Items ?? []) {
      rows.push(toYutaiMasterRow(item));
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return rows;
}

// JQuantsGyakuhibuForecastの全件スキャン(scanYutaiMasterと同じdo-whileページング)。
// `_POOL_`行(全銘柄横断のプール曲線)も含めてそのまま返す。呼び出し側で
// `ticker === '_POOL_'`により銘柄別の予測行と分離する。
async function scanForecastTable(): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({ TableName: GYAKUHIBU_FORECAST_TABLE_NAME, ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of result.Items ?? []) {
      rows.push(item);
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return rows;
}

// 逆日歩予測(lambda/shared/gyakuhibu-forecast.tsのForecastResult)のAPIレスポンス形状。
// listYutaiForecast/getYutaiForecastの両方で共用する(予測行が未計算の銘柄は
// defaultForecast()と同じ形を返す。フィールドを省略したり例外を投げたりしない)。
interface ForecastFields {
  scenario: string;
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
  forecastStatus: string;
  tickerSamples: number;
  poolSamples: number;
}

function defaultForecast(): ForecastFields {
  return {
    scenario: 'none',
    excessRatio: null,
    bin: null,
    pOccur: null,
    fillP50: null,
    fillP90: null,
    fillMean: null,
    forecastP50: null,
    forecastP90: null,
    forecastMean: null,
    expectedNet: null,
    forecastStatus: 'na',
    tickerSamples: 0,
    poolSamples: 0,
  };
}

// JQuantsGyakuhibuForecastの1行(GetCommand/ScanCommandの生Item)からForecastFieldsを
// 組み立てる。行が無ければdefaultForecast()を返す(呼び出し側はforecastフィールドを
// 省略したりクラッシュしたりしない)。
function buildForecast(item: Record<string, unknown> | undefined): ForecastFields {
  if (!item) return defaultForecast();
  const fallback = defaultForecast();
  return {
    scenario: (item.scenario as string | undefined) ?? fallback.scenario,
    excessRatio: (item.excessRatio as number | null | undefined) ?? fallback.excessRatio,
    bin: (item.bin as string | null | undefined) ?? fallback.bin,
    pOccur: (item.pOccur as number | null | undefined) ?? fallback.pOccur,
    fillP50: (item.fillP50 as number | null | undefined) ?? fallback.fillP50,
    fillP90: (item.fillP90 as number | null | undefined) ?? fallback.fillP90,
    fillMean: (item.fillMean as number | null | undefined) ?? fallback.fillMean,
    forecastP50: (item.forecastP50 as number | null | undefined) ?? fallback.forecastP50,
    forecastP90: (item.forecastP90 as number | null | undefined) ?? fallback.forecastP90,
    forecastMean: (item.forecastMean as number | null | undefined) ?? fallback.forecastMean,
    expectedNet: (item.expectedNet as number | null | undefined) ?? fallback.expectedNet,
    forecastStatus: (item.forecastStatus as string | undefined) ?? fallback.forecastStatus,
    tickerSamples: (item.tickerSamples as number | undefined) ?? fallback.tickerSamples,
    poolSamples: (item.poolSamples as number | undefined) ?? fallback.poolSamples,
  };
}

// スタンダードプラン依存機能(東証信用残ベースの現在需給予測)を応答に含めるか。ライトプラン
// へ落とす際はCDKのtseMarginFeatures=falseでこの環境変数が'false'になり、tseForecastは常に
// null、features.tseMarginはfalseになる(フロントはこれを見て列・カードを隠す)。
function tseMarginEnabled(): boolean {
  return process.env.TSE_MARGIN_FEATURES_ENABLED === 'true';
}

interface TseForecastFields extends ForecastFields {
  snapshotDate: string;
  lagDays: number;
  lagBucket: string;
  financingBalance: number;
  lendingBalance: number;
  lendingGrowth4w: number | null;
}

// 予測行のtseForecast属性(gyakuhibu-forecast-batch/tse-forecast.tsが書く)をAPI表現にする。
// フラグ無効・属性無し・nullのいずれもnull。
function buildTseForecast(item: Record<string, unknown> | undefined): TseForecastFields | null {
  if (!tseMarginEnabled()) return null;
  const raw = item?.tseForecast;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.snapshotDate !== 'string' || typeof r.lagDays !== 'number' || typeof r.lagBucket !== 'string') return null;
  return {
    ...buildForecast(r),
    snapshotDate: r.snapshotDate,
    lagDays: r.lagDays,
    lagBucket: r.lagBucket,
    financingBalance: (r.financingBalance as number | undefined) ?? 0,
    lendingBalance: (r.lendingBalance as number | undefined) ?? 0,
    lendingGrowth4w: (r.lendingGrowth4w as number | null | undefined) ?? null,
  };
}

// 当月末の最終営業日から2営業日前(受渡T+2)を「権利付き最終日」の目安として返す。
// 月末が権利確定日の銘柄が多いため、このバナー1つを一覧全体で使い回す(銘柄ごとには計算しない)。
function currentMonthLastTradableDate(calendar: { date: string; holDiv: string }[]): string {
  const businessDays = calendar.filter(isTradingDay).map((d) => d.date).sort();
  const cutoffIndex = Math.max(businessDays.length - 3, 0);
  return businessDays[cutoffIndex];
}

interface YutaiListFilters {
  keyword?: string;
  rightsDateFrom?: string;
  rightsDateTo?: string;
  priceMin?: number;
  priceMax?: number;
  investmentMin?: number;
  investmentMax?: number;
  crossEligible?: CrossEligible;
}

// 数値のクエリパラメータ。空文字や数値でない値は「指定なし」として扱う
// (指定ミスで全件が消えるより、絞り込みが効かない方が気付きやすい)。
function parseNumberParam(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function parseCrossEligibleParam(raw: string | undefined): CrossEligible | undefined {
  return raw === 'ok' || raw === 'ng' || raw === 'unknown' ? raw : undefined;
}

// 2つの一覧(GET /yutai と GET /yutai/forecast)が受けるクエリパラメータの解釈を
// ここ1箇所に集約する。ハンドラごとに組み立てると、片方だけ項目を足し忘れても
// 型エラーにならず「同じ判断が両方の画面でできる」という要件が静かに崩れる。
function parseYutaiListFilters(query: Record<string, string | undefined>): YutaiListFilters {
  return {
    keyword: query.keyword?.toLowerCase(),
    rightsDateFrom: query.rightsDateFrom,
    rightsDateTo: query.rightsDateTo,
    priceMin: parseNumberParam(query.priceMin),
    priceMax: parseNumberParam(query.priceMax),
    investmentMin: parseNumberParam(query.investmentMin),
    investmentMax: parseNumberParam(query.investmentMax),
    crossEligible: parseCrossEligibleParam(query.crossEligible),
  };
}

// 範囲指定があるのに値が不明な行は除外する(「株価100万円以下」の結果に株価不明の
// 銘柄を混ぜない)。範囲指定が無ければ値が不明でも通す。
function passesRange(value: number | null, min: number | undefined, max: number | undefined): boolean {
  if (min === undefined && max === undefined) return true;
  if (value === null) return false;
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;
  return true;
}

// 優待条件(個別ページ由来)。2つの一覧と詳細の3箇所で共通。
function buildBenefitFields(row: YutaiMasterRow) {
  return {
    unitShares: row.unitShares,
    requiredShares: row.requiredShares,
    crossEligible: row.crossEligible,
    holdingKind: row.holdingKind,
    holdingMinMonths: row.holdingMinMonths,
    minTierValueYen: row.minTierValueYen,
    benefitParseWarning: row.benefitParseWarning,
  };
}

// 条件 + 価格・コスト。2つの一覧(GET /yutai と GET /yutai/forecast)専用。
// 片方だけに足すと「同じ判断が両方の画面でできる」という要件が崩れるため、
// 必ずこの関数を経由する。
//
// closePriceはprecomputeが日次で書いたスナップショットで、requiredInvestmentを
// 算出した元の値。詳細エンドポイントには渡さない — あちらは既にリクエスト時点の
// ライブ値をbasicInfo.closePriceで返しており、同名で違う値が並ぶのを避ける。
function buildCrossFields(row: YutaiMasterRow) {
  return {
    ...buildBenefitFields(row),
    closePrice: row.closePrice,
    requiredInvestment: row.requiredInvestment,
    lastGyakuhibu: row.lastGyakuhibu,
    sameMonthLastYearGyakuhibu: row.sameMonthLastYearGyakuhibu,
  };
}

// keyword/rightsDateFrom/rightsDateToによる絞り込み。listYutaiとlistYutaiForecastの
// 両方から呼ばれる(riskStatus/forecastStatusによる絞り込みはハンドラごとに別条件のため含めない)。
function passesYutaiFilters(
  row: YutaiMasterRow,
  rightsDate: string | undefined,
  filters: YutaiListFilters,
): boolean {
  if (filters.keyword) {
    const haystack = `${row.companyName ?? ''} ${row.content}`.toLowerCase();
    if (!haystack.includes(filters.keyword)) return false;
  }
  if (filters.rightsDateFrom && (!rightsDate || rightsDate < filters.rightsDateFrom)) return false;
  if (filters.rightsDateTo && (!rightsDate || rightsDate > filters.rightsDateTo)) return false;
  if (!passesRange(row.closePrice, filters.priceMin, filters.priceMax)) return false;
  if (!passesRange(row.requiredInvestment, filters.investmentMin, filters.investmentMax)) return false;
  if (filters.crossEligible && row.crossEligible !== filters.crossEligible) return false;
  return true;
}

async function listYutai(query: Record<string, string | undefined>): Promise<APIGatewayProxyResultV2> {
  const filters = parseYutaiListFilters(query);
  const riskStatusFilter = query.riskStatus && query.riskStatus !== 'all' ? query.riskStatus : undefined;

  const rows = await scanYutaiMaster();

  const items = [];
  for (const row of rows) {
    const rightsDate = nextRightsDate(row.rightsMonths);
    if (!passesYutaiFilters(row, rightsDate, filters)) continue;

    if (riskStatusFilter && row.riskStatus !== riskStatusFilter) continue;

    items.push({
      ticker: row.ticker,
      companyName: row.companyName,
      content: row.content,
      value: row.value,
      rightsDate: rightsDate ?? null,
      riskStatus: row.riskStatus,
      maxGyakuhibu: row.maxGyakuhibu,
      ...buildCrossFields(row),
    });
  }

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const monthCalendar = getLocalTradingCalendar(monthStart, monthEnd);

  return jsonResponse(200, {
    tickers: items,
    currentMonthLastTradableDate: currentMonthLastTradableDate(monthCalendar),
  });
}

async function listYutaiForecast(query: Record<string, string | undefined>): Promise<APIGatewayProxyResultV2> {
  const filters = parseYutaiListFilters(query);
  const forecastStatusFilter = query.forecastStatus && query.forecastStatus !== 'all' ? query.forecastStatus : undefined;

  // 呼び出し順はテストのmockResolvedValueOnce順(master scan → forecast scan)と
  // 一致させるため、この順で逐次await(Promise.allは使わない)。
  const masterRows = await scanYutaiMaster();
  const forecastRows = await scanForecastTable();

  const forecastByTicker = new Map(
    forecastRows.filter((r) => r.ticker !== '_POOL_').map((r) => [r.ticker as string, r]),
  );
  const poolRow = forecastRows.find((r) => r.ticker === '_POOL_');

  const items = [];
  for (const row of masterRows) {
    const rightsDate = nextRightsDate(row.rightsMonths);
    if (!passesYutaiFilters(row, rightsDate, filters)) continue;

    const forecast = buildForecast(forecastByTicker.get(row.ticker));
    if (forecastStatusFilter && forecast.forecastStatus !== forecastStatusFilter) continue;

    items.push({
      ticker: row.ticker,
      companyName: row.companyName,
      content: row.content,
      value: row.value,
      rightsDate: rightsDate ?? null,
      riskStatus: row.riskStatus,
      maxGyakuhibu: row.maxGyakuhibu,
      forecast,
      tseForecast: buildTseForecast(forecastByTicker.get(row.ticker)),
      ...buildCrossFields(row),
    });
  }

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const monthCalendar = getLocalTradingCalendar(monthStart, monthEnd);

  return jsonResponse(200, {
    tickers: items,
    currentMonthLastTradableDate: currentMonthLastTradableDate(monthCalendar),
    poolComputedAt: (poolRow?.computedAt as string | undefined) ?? null,
    features: { tseMargin: tseMarginEnabled() },
  });
}

async function getYutaiMaster(ticker: string): Promise<YutaiMasterRow | undefined> {
  const result = await ddbDocClient.send(new GetCommand({ TableName: YUTAI_MASTER_TABLE_NAME, Key: { ticker } }));
  if (!result.Item) return undefined;
  return toYutaiMasterRow(result.Item);
}

async function latestPricePoint(ticker: string): Promise<{ close: number; volume: number | null } | undefined> {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: { ':ticker': ticker },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  const latest = result.Items?.[0];
  if (!latest || typeof latest.close !== 'number') return undefined;
  return { close: latest.close, volume: latest.volume ?? null };
}

async function latestFinancialSummary(ticker: string) {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: FINANCIAL_TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: { ':ticker': ticker },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  return result.Items?.[0];
}

async function gyakuhibuHistory(ticker: string) {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: GYAKUHIBU_ACTUAL_TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: { ':ticker': ticker },
      ScanIndexForward: false,
    }),
  );
  return (result.Items ?? [])
    // noGyakuhibu:trueは「その権利日は確認済みで実際には逆日歩が発生しなかった」マーカー行
    // (Fix 2: 再スクレイピング防止のために書き込む)。ツールチップは実際に逆日歩が
    // 発生した権利日のみを表示する仕様なので、ここで除外する。
    .filter((item) => item.noGyakuhibu !== true)
    .map((item) => ({
      rightsDate: item.rightsDate,
      totalAmount: item.totalAmount,
      days: item.days,
      avgRate: item.avgRate,
    }));
}

async function getYutaiDetail(ticker: string): Promise<APIGatewayProxyResultV2> {
  const master = await getYutaiMaster(ticker);
  if (!master) return jsonResponse(404, { message: `Unknown yutai ticker: ${ticker}` });

  const price = await latestPricePoint(ticker);
  const summary = await latestFinancialSummary(ticker);
  const eps = summary?.eps ? Number(summary.eps) : undefined;
  const per = price && eps && eps > 0 ? price.close / eps : null;

  const rightsDate = nextRightsDate(master.rightsMonths);
  const history = await gyakuhibuHistory(ticker);

  return jsonResponse(200, {
    ticker: master.ticker,
    companyName: master.companyName ?? null,
    content: master.content,
    value: master.value,
    rightsDate: rightsDate ?? null,
    basicInfo: {
      closePrice: price?.close ?? null,
      volume: price?.volume ?? null,
      per,
      sales: summary?.sales ?? null,
      operatingProfit: summary?.operatingProfit ?? null,
      netProfit: summary?.netProfit ?? null,
      eps: summary?.eps ?? null,
    },
    risk: {
      riskStatus: master.riskStatus,
      maxGyakuhibu: master.maxGyakuhibu,
      maxRate: master.maxRate,
      days: master.days,
    },
    rightsHistory: history,
    benefitGroups: master.benefitGroups,
    ...buildBenefitFields(master),
    features: { tseMargin: tseMarginEnabled() },
  });
}

async function getYutaiForecast(ticker: string): Promise<APIGatewayProxyResultV2> {
  const master = await getYutaiMaster(ticker);
  if (!master) return jsonResponse(404, { message: `Unknown yutai ticker: ${ticker}` });

  // 呼び出し順はテストのmockResolvedValueOnce順(forecast get → _POOL_ get → actual query →
  // margin query)と一致させるため、この順で逐次await(Promise.allは使わない)。
  const forecastResult = await ddbDocClient.send(
    new GetCommand({ TableName: GYAKUHIBU_FORECAST_TABLE_NAME, Key: { ticker } }),
  );
  const poolResult = await ddbDocClient.send(
    new GetCommand({ TableName: GYAKUHIBU_FORECAST_TABLE_NAME, Key: { ticker: '_POOL_' } }),
  );
  const actualResult = await ddbDocClient.send(
    new QueryCommand({
      TableName: GYAKUHIBU_ACTUAL_TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: { ':ticker': ticker },
      ScanIndexForward: false,
    }),
  );
  const marginResult = await ddbDocClient.send(
    new QueryCommand({
      TableName: MARGIN_BALANCE_TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: { ':ticker': ticker },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );

  const forecast = buildForecast(forecastResult.Item);

  // 既存gyakuhibuHistory(/yutai/{ticker}のrightsHistory)と違い、noGyakuhibu行も
  // 除外せず含める(occurred: falseとして「その権利日は確認済みで発生しなかった」ことを表す)。
  const history = (actualResult.Items ?? []).map((item) => {
    const financingBalance = typeof item.financingBalance === 'number' ? item.financingBalance : 0;
    const lendingBalance = typeof item.lendingBalance === 'number' ? item.lendingBalance : 0;
    return {
      rightsDate: item.rightsDate,
      excessRatio: excessRatio(financingBalance, lendingBalance),
      excessShares: lendingBalance - financingBalance,
      financingBalance,
      lendingBalance,
      lendingPrice: item.lendingPrice ?? null,
      fillRatio: fillRatio(item.avgRate ?? 0, item.days ?? 0, item.maxRateActual ?? null),
      totalAmount: item.totalAmount ?? 0,
      maxRateActual: item.maxRateActual ?? null,
      bidRank: item.bidRank ?? null,
      restriction: item.restriction ?? null,
      emergencyMeasure: item.emergencyMeasure ?? null,
      occurred: item.noGyakuhibu !== true,
    };
  });

  const poolBins = poolResult.Item?.bins ?? [];

  const marginLatest = marginResult.Items?.[0];
  const marginTrend = marginLatest
    ? {
        latest: {
          date: marginLatest.date,
          financingBalance: marginLatest.financingBalance,
          lendingBalance: marginLatest.lendingBalance,
        },
      }
    : { latest: null };

  const rightsDate = nextRightsDate(master.rightsMonths);

  return jsonResponse(200, {
    ticker: master.ticker,
    companyName: master.companyName ?? null,
    content: master.content,
    value: master.value,
    unitShares: master.unitShares,
    rightsDate: rightsDate ?? null,
    maxGyakuhibu: master.maxGyakuhibu,
    closePrice: master.closePrice,
    forecast,
    tseForecast: buildTseForecast(forecastResult.Item),
    history,
    poolBins,
    marginTrend,
    features: { tseMargin: tseMarginEnabled() },
  });
}

const MARGIN_TREND_RANGE_DAYS = 365;

async function getMarginTrend(ticker: string): Promise<APIGatewayProxyResultV2> {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: MARGIN_BALANCE_TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: { ':ticker': ticker },
      ScanIndexForward: false,
      Limit: MARGIN_TREND_RANGE_DAYS,
    }),
  );

  const points = (result.Items ?? [])
    .map((item) => ({
      date: item.date as string,
      financingBalance: item.financingBalance,
      lendingBalance: item.lendingBalance,
    }))
    .reverse();

  return jsonResponse(200, { ticker, range: '1y', points });
}

async function listTdnetEvents(): Promise<APIGatewayProxyResultV2> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await ddbDocClient.send(
      new QueryCommand({
        TableName: YUTAI_TDNET_EVENT_TABLE_NAME,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': 'ALL' },
        ScanIndexForward: false, // eventId(SK)の先頭がdisclosedAtなので、降順=新しい開示順になる
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...(result.Items ?? []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  const events = items.map((item) => ({
    ticker: item.ticker,
    companyName: item.companyName,
    eventType: item.eventType,
    disclosureTitle: item.disclosureTitle,
    disclosedAt: item.disclosedAt,
    recordedAt: item.recordedAt,
  }));
  return jsonResponse(200, { events });
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const ticker = event.pathParameters?.ticker;

  switch (event.routeKey) {
    case 'GET /tickers/{ticker}/prices':
      return ticker
        ? getPrices(ticker, event.queryStringParameters?.range)
        : jsonResponse(400, { message: 'Missing ticker' });
    case 'GET /tickers/{ticker}/summary':
      return ticker ? await getSummary(ticker) : jsonResponse(400, { message: 'Missing ticker' });
    case 'GET /yutai':
      return listYutai(event.queryStringParameters ?? {});
    case 'GET /yutai/tdnet-events':
      return listTdnetEvents();
    case 'GET /yutai/{ticker}':
      return ticker ? getYutaiDetail(ticker) : jsonResponse(400, { message: 'Missing ticker' });
    case 'GET /yutai/{ticker}/margin-trend':
      return ticker ? getMarginTrend(ticker) : jsonResponse(400, { message: 'Missing ticker' });
    case 'GET /yutai/forecast':
      return listYutaiForecast(event.queryStringParameters ?? {});
    case 'GET /yutai/{ticker}/forecast':
      return ticker ? getYutaiForecast(ticker) : jsonResponse(400, { message: 'Missing ticker' });
    default:
      return jsonResponse(404, { message: 'Not found' });
  }
};
