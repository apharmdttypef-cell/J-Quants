import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getLocalTradingCalendar, isTradingDay, nextRightsDate } from '../shared/trading-calendar';
import { excessRatio, fillRatio } from '../shared/gyakuhibu-forecast';

const TABLE_NAME = process.env.TABLE_NAME!;
const FINANCIAL_TABLE_NAME = process.env.FINANCIAL_TABLE_NAME!;
const WATCHLIST_TABLE_NAME = process.env.WATCHLIST_TABLE_NAME!;
const SECRET_ARN = process.env.SECRET_ARN!;
const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const MARGIN_BALANCE_TABLE_NAME = process.env.MARGIN_BALANCE_TABLE_NAME!;
const GYAKUHIBU_ACTUAL_TABLE_NAME = process.env.GYAKUHIBU_ACTUAL_TABLE_NAME!;
const GYAKUHIBU_FORECAST_TABLE_NAME = process.env.GYAKUHIBU_FORECAST_TABLE_NAME!;
const YUTAI_TDNET_EVENT_TABLE_NAME = process.env.YUTAI_TDNET_EVENT_TABLE_NAME!;
const API_BASE_URL = process.env.API_BASE_URL ?? 'https://api.jquants.com/v2';
// 日付範囲(from/to)ではなく「保存済みの最新N件」で返す方式(12週間分の営業日 ≈ 60件)。
// 日付境界で絞るより単純で、取得が数営業日遅れても直近チャートの見た目は変わらない。
const PRICE_RANGE_TRADING_DAYS = 60;
// 4桁(普通株式)または5桁(末尾0付き)の銘柄コードのみ受け付ける。
const TICKER_CODE_PATTERN = /^\d{4,5}$/;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secretsClient = new SecretsManagerClient({});

let cachedApiKey: string | undefined;

async function getApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
  if (!result.SecretString) {
    throw new Error('J-Quants API key secret has no string value');
  }
  cachedApiKey = result.SecretString;
  return cachedApiKey;
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function emptyResponse(statusCode: number): APIGatewayProxyResultV2 {
  return { statusCode };
}

async function isWatchedTicker(ticker: string): Promise<boolean> {
  const result = await ddbDocClient.send(
    new GetCommand({ TableName: WATCHLIST_TABLE_NAME, Key: { ticker } }),
  );
  return result.Item !== undefined;
}

async function listTickers(): Promise<APIGatewayProxyResultV2> {
  const tickers: Array<{ ticker: string; companyName?: string; addedAt?: string }> = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({ TableName: WATCHLIST_TABLE_NAME, ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of result.Items ?? []) {
      tickers.push({ ticker: item.ticker, companyName: item.companyName, addedAt: item.addedAt });
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  tickers.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return jsonResponse(200, { tickers });
}

interface ListedInstrument {
  Code: string;
  CoName: string;
}

interface ListedInstrumentResponse {
  data: ListedInstrument[];
}

// 銘柄コードの実在確認と会社名表示のため、追加時に一度だけ問い合わせる
// (全銘柄一覧の常時同期はしない。詳細はADR/要件書6-4を参照)。
async function lookupCompanyName(ticker: string): Promise<string | undefined> {
  const apiKey = await getApiKey();
  const response = await fetch(`${API_BASE_URL}/equities/master?code=${ticker}`, {
    headers: { 'x-api-key': apiKey },
  });

  if (!response.ok) {
    throw new Error(`J-Quants API error ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as ListedInstrumentResponse;
  return body.data[0]?.CoName;
}

async function addTicker(rawBody: string | undefined): Promise<APIGatewayProxyResultV2> {
  let ticker: unknown;
  try {
    ticker = rawBody ? (JSON.parse(rawBody) as { ticker?: unknown }).ticker : undefined;
  } catch {
    return jsonResponse(400, { message: 'Invalid JSON body' });
  }

  if (typeof ticker !== 'string' || !TICKER_CODE_PATTERN.test(ticker)) {
    return jsonResponse(400, { message: 'ticker must be a 4 or 5 digit stock code' });
  }

  let companyName: string | undefined;
  try {
    companyName = await lookupCompanyName(ticker);
  } catch (error) {
    console.error(`Failed to look up company name for ${ticker}`, error);
    return jsonResponse(502, { message: 'Failed to verify ticker with J-Quants API' });
  }

  if (!companyName) {
    return jsonResponse(400, { message: `Unknown ticker code: ${ticker}` });
  }

  const addedAt = new Date().toISOString();
  await ddbDocClient.send(
    new PutCommand({
      TableName: WATCHLIST_TABLE_NAME,
      Item: { ticker, companyName, addedAt },
    }),
  );

  return jsonResponse(201, { ticker, companyName, addedAt });
}

async function removeTicker(ticker: string): Promise<APIGatewayProxyResultV2> {
  await ddbDocClient.send(new DeleteCommand({ TableName: WATCHLIST_TABLE_NAME, Key: { ticker } }));
  return emptyResponse(204);
}

async function getPrices(ticker: string, range: string | undefined): Promise<APIGatewayProxyResultV2> {
  if (!(await isWatchedTicker(ticker))) {
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
  if (!(await isWatchedTicker(ticker))) {
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
}

async function scanYutaiMaster(): Promise<YutaiMasterRow[]> {
  const rows: YutaiMasterRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({ TableName: YUTAI_MASTER_TABLE_NAME, ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of result.Items ?? []) {
      rows.push({
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
      });
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
  return true;
}

async function listYutai(query: Record<string, string | undefined>): Promise<APIGatewayProxyResultV2> {
  const filters: YutaiListFilters = {
    keyword: query.keyword?.toLowerCase(),
    rightsDateFrom: query.rightsDateFrom,
    rightsDateTo: query.rightsDateTo,
  };
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
  const filters: YutaiListFilters = {
    keyword: query.keyword?.toLowerCase(),
    rightsDateFrom: query.rightsDateFrom,
    rightsDateTo: query.rightsDateTo,
  };
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
      closePrice: row.closePrice,
      forecast,
      tseForecast: buildTseForecast(forecastByTicker.get(row.ticker)),
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
  return {
    ticker: result.Item.ticker,
    companyName: result.Item.companyName,
    content: result.Item.content,
    value: result.Item.value ?? null,
    unitShares: result.Item.unitShares,
    rightsMonths: result.Item.rightsMonths ?? [],
    riskStatus: result.Item.riskStatus ?? 'na',
    maxGyakuhibu: result.Item.maxGyakuhibu ?? null,
    maxRate: result.Item.maxRate ?? null,
    days: result.Item.days ?? null,
    closePrice: result.Item.closePrice ?? null,
  };
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
    unitShares: master.unitShares,
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
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: YUTAI_TDNET_EVENT_TABLE_NAME,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'ALL' },
      ScanIndexForward: false, // eventId(SK)の先頭がdisclosedAtなので、降順=新しい開示順になる
    }),
  );
  const events = (result.Items ?? []).map((item) => ({
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
    case 'GET /tickers':
      return listTickers();
    case 'POST /tickers':
      return addTicker(event.body);
    case 'DELETE /tickers/{ticker}':
      return ticker ? removeTicker(ticker) : jsonResponse(400, { message: 'Missing ticker' });
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
