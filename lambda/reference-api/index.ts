import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { calcMaxGyakuhibu, calcMaxRate } from '../shared/gyakuhibu-calc';
import { fetchTradingCalendar, isTradingDay, settlementDate, calendarDaysBetween } from '../shared/trading-calendar';

const TABLE_NAME = process.env.TABLE_NAME!;
const FINANCIAL_TABLE_NAME = process.env.FINANCIAL_TABLE_NAME!;
const WATCHLIST_TABLE_NAME = process.env.WATCHLIST_TABLE_NAME!;
const SECRET_ARN = process.env.SECRET_ARN!;
const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const YUTAI_RIGHTS_DATE_TABLE_NAME = process.env.YUTAI_RIGHTS_DATE_TABLE_NAME!;
const MARGIN_BALANCE_TABLE_NAME = process.env.MARGIN_BALANCE_TABLE_NAME!;
const GYAKUHIBU_ACTUAL_TABLE_NAME = process.env.GYAKUHIBU_ACTUAL_TABLE_NAME!;
const API_BASE_URL = process.env.API_BASE_URL ?? 'https://api.jquants.com/v2';
// J-Quants Freeプランは配信12週間遅延のため、"今日からN日前" で絞ると実際に
// 保存されているデータ(遅延分だけ過去の日付)が範囲外になる。日付を基準にせず、
// 保存済みの最新N件(12週間分の営業日 ≈ 60件)をそのまま返す方式にする。
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
    return jsonResponse(400, { message: 'Only range=12w is supported (J-Quants Free plan constraint)' });
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

interface YutaiMasterRow {
  ticker: string;
  companyName?: string;
  content: string;
  value: number;
  unitShares: number;
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
        value: item.value,
        unitShares: item.unitShares,
      });
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return rows;
}

async function nextRightsDate(ticker: string): Promise<string | undefined> {
  const today = new Date().toISOString().slice(0, 10);
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: YUTAI_RIGHTS_DATE_TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker AND rightsDate >= :today',
      ExpressionAttributeValues: { ':ticker': ticker, ':today': today },
      ScanIndexForward: true,
      Limit: 1,
    }),
  );
  return result.Items?.[0]?.rightsDate;
}

async function hasMarginBalance(ticker: string): Promise<boolean> {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: MARGIN_BALANCE_TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: { ':ticker': ticker },
      Limit: 1,
    }),
  );
  return (result.Items ?? []).length > 0;
}

async function latestClose(ticker: string): Promise<number | undefined> {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: { ':ticker': ticker },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  const close = result.Items?.[0]?.close;
  return typeof close === 'number' ? close : undefined;
}

type RiskStatus = 'safe' | 'danger' | 'na';

async function calcRiskStatus(
  row: YutaiMasterRow,
  rightsDate: string | undefined,
  apiBaseUrl: string,
  apiKey: string,
): Promise<RiskStatus> {
  if (!rightsDate) return 'na';
  if (!(await hasMarginBalance(row.ticker))) return 'na';

  const closePrice = await latestClose(row.ticker);
  if (closePrice === undefined) return 'na';

  const calendarTo = new Date(rightsDate);
  calendarTo.setDate(calendarTo.getDate() + 14);
  const calendar = await fetchTradingCalendar(
    apiBaseUrl,
    apiKey,
    rightsDate,
    calendarTo.toISOString().slice(0, 10),
  );
  const settlement = settlementDate(calendar, rightsDate);
  const days = calendarDaysBetween(rightsDate, settlement);

  const maxGyakuhibu = calcMaxGyakuhibu(closePrice, row.unitShares, days);
  return row.value > maxGyakuhibu ? 'safe' : 'danger';
}

// 当月末の最終営業日から2営業日前(受渡T+2)を「権利付き最終日」の目安として返す。
// 月末が権利確定日の銘柄が多いため、このバナー1つを一覧全体で使い回す(銘柄ごとには計算しない)。
function currentMonthLastTradableDate(calendar: { date: string; holDiv: string }[]): string {
  const businessDays = calendar.filter(isTradingDay).map((d) => d.date).sort();
  const cutoffIndex = Math.max(businessDays.length - 3, 0);
  return businessDays[cutoffIndex];
}

async function listYutai(query: Record<string, string | undefined>): Promise<APIGatewayProxyResultV2> {
  const rightsDateFrom = query.rightsDateFrom;
  const rightsDateTo = query.rightsDateTo;
  const keyword = query.keyword?.toLowerCase();
  const riskStatusFilter = query.riskStatus && query.riskStatus !== 'all' ? query.riskStatus : undefined;

  const apiKey = await getApiKey();
  const rows = await scanYutaiMaster();

  const items = [];
  for (const row of rows) {
    if (keyword) {
      const haystack = `${row.companyName ?? ''} ${row.content}`.toLowerCase();
      if (!haystack.includes(keyword)) continue;
    }

    const rightsDate = await nextRightsDate(row.ticker);
    if (rightsDateFrom && (!rightsDate || rightsDate < rightsDateFrom)) continue;
    if (rightsDateTo && (!rightsDate || rightsDate > rightsDateTo)) continue;

    const riskStatus = await calcRiskStatus(row, rightsDate, API_BASE_URL, apiKey);
    if (riskStatusFilter && riskStatus !== riskStatusFilter) continue;

    items.push({
      ticker: row.ticker,
      companyName: row.companyName,
      content: row.content,
      value: row.value,
      rightsDate: rightsDate ?? null,
      riskStatus,
    });
  }

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const monthCalendar = await fetchTradingCalendar(API_BASE_URL, apiKey, monthStart, monthEnd);

  return jsonResponse(200, {
    tickers: items,
    currentMonthLastTradableDate: currentMonthLastTradableDate(monthCalendar),
  });
}

async function getYutaiMaster(ticker: string): Promise<YutaiMasterRow | undefined> {
  const result = await ddbDocClient.send(new GetCommand({ TableName: YUTAI_MASTER_TABLE_NAME, Key: { ticker } }));
  if (!result.Item) return undefined;
  return {
    ticker: result.Item.ticker,
    companyName: result.Item.companyName,
    content: result.Item.content,
    value: result.Item.value,
    unitShares: result.Item.unitShares,
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
  return (result.Items ?? []).map((item) => ({
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

  const rightsDate = await nextRightsDate(ticker);
  const apiKey = await getApiKey();

  let risk: { maxGyakuhibu: number | null; maxRate: number | null; days: number | null; riskStatus: RiskStatus } = {
    maxGyakuhibu: null,
    maxRate: null,
    days: null,
    riskStatus: 'na',
  };

  if (rightsDate && price && (await hasMarginBalance(ticker))) {
    const calendarTo = new Date(rightsDate);
    calendarTo.setDate(calendarTo.getDate() + 14);
    const calendar = await fetchTradingCalendar(API_BASE_URL, apiKey, rightsDate, calendarTo.toISOString().slice(0, 10));
    const settlement = settlementDate(calendar, rightsDate);
    const days = calendarDaysBetween(rightsDate, settlement);
    const maxRate = calcMaxRate(price.close, master.unitShares);
    const maxGyakuhibu = calcMaxGyakuhibu(price.close, master.unitShares, days);
    risk = { maxGyakuhibu, maxRate, days, riskStatus: master.value > maxGyakuhibu ? 'safe' : 'danger' };
  }

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
    risk,
    rightsHistory: history,
  });
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
    case 'GET /yutai/{ticker}':
      return ticker ? getYutaiDetail(ticker) : jsonResponse(400, { message: 'Missing ticker' });
    default:
      return jsonResponse(404, { message: 'Not found' });
  }
};
