import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { calcMaxGyakuhibu, calcMaxRate } from '../shared/gyakuhibu-calc';
import {
  getLocalTradingCalendar,
  settlementDate,
  businessDaysAfter,
  calendarDaysBetween,
  nextRightsDate,
  type CalendarDay,
} from '../shared/trading-calendar';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const MARGIN_BALANCE_TABLE_NAME = process.env.MARGIN_BALANCE_TABLE_NAME!;
const TABLE_NAME = process.env.TABLE_NAME!; // 株価(JQuantsStockPrices)

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface MasterRow {
  ticker: string;
  value: number;
  unitShares: number;
  rightsMonths: number[];
}

async function scanYutaiMaster(): Promise<MasterRow[]> {
  const rows: MasterRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({ TableName: YUTAI_MASTER_TABLE_NAME, ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of result.Items ?? []) {
      if (typeof item.ticker === 'string' && typeof item.value === 'number' && typeof item.unitShares === 'number') {
        rows.push({
          ticker: item.ticker,
          value: item.value,
          unitShares: item.unitShares,
          rightsMonths: item.rightsMonths ?? [],
        });
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return rows;
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

interface RiskResult {
  riskStatus: RiskStatus;
  maxGyakuhibu: number | null;
  maxRate: number | null;
  days: number | null;
}

const NA_RISK: RiskResult = { riskStatus: 'na', maxGyakuhibu: null, maxRate: null, days: null };

// 権利日が月末近くに集中するため、同じfrom/toのカレンダーはバッチ全体で使い回す
// (getLocalTradingCalendarはローカル計算なので実害は小さいが、無駄のないよう用意する)。
function fetchTradingCalendarCached(from: string, to: string, cache: Map<string, CalendarDay[]>): CalendarDay[] {
  const key = `${from}|${to}`;
  let cached = cache.get(key);
  if (!cached) {
    cached = getLocalTradingCalendar(from, to);
    cache.set(key, cached);
  }
  return cached;
}

async function calcRisk(
  row: { ticker: string; value: number; unitShares: number },
  rightsDate: string | undefined,
  calendarCache: Map<string, CalendarDay[]>,
): Promise<RiskResult> {
  if (!rightsDate) return NA_RISK;
  if (!(await hasMarginBalance(row.ticker))) return NA_RISK;

  const closePrice = await latestClose(row.ticker);
  if (closePrice === undefined) return NA_RISK;

  const calendarTo = new Date(rightsDate);
  calendarTo.setDate(calendarTo.getDate() + 14);
  const calendar = fetchTradingCalendarCached(rightsDate, calendarTo.toISOString().slice(0, 10), calendarCache);
  // 品貸日数(days)は日証金の用語集の定義通り「受渡日(T+2)〜その翌営業日」の暦日数
  // (taisyaku.jpの実データで検証済み。docs/superpowers/specs/2026-08-13-yutai-cross-risk-design.md参照)。
  const settlement = settlementDate(calendar, rightsDate);
  const followingTradingDay = businessDaysAfter(calendar, settlement, 1);
  const days = calendarDaysBetween(settlement, followingTradingDay);

  const maxRate = calcMaxRate(closePrice, row.unitShares);
  const maxGyakuhibu = calcMaxGyakuhibu(closePrice, row.unitShares, days);
  const riskStatus: RiskStatus = row.value > maxGyakuhibu ? 'safe' : 'danger';
  return { riskStatus, maxGyakuhibu, maxRate, days };
}

export const handler = async (): Promise<void> => {
  const rows = await scanYutaiMaster();
  const calendarCache = new Map<string, CalendarDay[]>();

  let updated = 0;
  for (const row of rows) {
    try {
      const rightsDate = nextRightsDate(row.rightsMonths);
      const risk = await calcRisk(row, rightsDate, calendarCache);

      await ddbDocClient.send(
        new UpdateCommand({
          TableName: YUTAI_MASTER_TABLE_NAME,
          Key: { ticker: row.ticker },
          UpdateExpression: 'SET riskStatus = :riskStatus, maxGyakuhibu = :maxGyakuhibu, maxRate = :maxRate, #days = :days',
          ExpressionAttributeNames: { '#days': 'days' },
          ExpressionAttributeValues: {
            ':riskStatus': risk.riskStatus,
            ':maxGyakuhibu': risk.maxGyakuhibu,
            ':maxRate': risk.maxRate,
            ':days': risk.days,
          },
        }),
      );
      updated++;
    } catch (error) {
      console.error(`${row.ticker}: failed to precompute/update risk`, error);
    }
  }

  console.log(`yutai-risk-precompute-batch: updated ${updated} of ${rows.length} rows`);
};
