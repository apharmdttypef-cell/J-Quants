import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { calcMaxGyakuhibu, calcMaxRate, RIGHTS_DAY_RATE_MULTIPLIER } from '../shared/gyakuhibu-calc';
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
  minInvestment: number | null;
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
          minInvestment: typeof item.minInvestment === 'number' ? item.minInvestment : null,
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
  unitShares: number;
}

const NA_RISK: Omit<RiskResult, 'unitShares'> = { riskStatus: 'na', maxGyakuhibu: null, maxRate: null, days: null };

// kabuyutai.comの「必要投資金額」は優待を受け取るための実際の最低投資額であり、必ずしも
// 単元株数(100株)と一致しない(例: 第一興商は単元100株だが優待の権利獲得には200株必要、
// 2026-09-04発見: docs/superpowers/notes/2026-09-04-kabuyutai-required-shares-mismatch.md参照)。
// minInvestment÷現在株価を100株単位に丸めて実際の必要株数を逆算する。逆算できない・
// 不自然な場合はDB上のunitShares(デフォルト100)にフォールバックする。
function estimateRequiredShares(minInvestment: number | null, closePrice: number, fallback: number): number {
  if (minInvestment === null || minInvestment <= 0 || closePrice <= 0) return fallback;
  const estimated = Math.round(minInvestment / closePrice / 100) * 100;
  return estimated > 0 ? estimated : fallback;
}

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
  row: { ticker: string; value: number; unitShares: number; minInvestment: number | null },
  rightsDate: string | undefined,
  calendarCache: Map<string, CalendarDay[]>,
): Promise<RiskResult> {
  if (!rightsDate) return { ...NA_RISK, unitShares: row.unitShares };
  if (!(await hasMarginBalance(row.ticker))) return { ...NA_RISK, unitShares: row.unitShares };

  const closePrice = await latestClose(row.ticker);
  if (closePrice === undefined) return { ...NA_RISK, unitShares: row.unitShares };

  const unitShares = estimateRequiredShares(row.minInvestment, closePrice, row.unitShares);

  const calendarTo = new Date(rightsDate);
  calendarTo.setDate(calendarTo.getDate() + 14);
  const calendar = fetchTradingCalendarCached(rightsDate, calendarTo.toISOString().slice(0, 10), calendarCache);
  // 品貸日数(days)は日証金の用語集の定義通り「受渡日(T+2)〜その翌営業日」の暦日数
  // (taisyaku.jpの実データで検証済み。docs/superpowers/specs/2026-08-13-yutai-cross-risk-design.md参照)。
  const settlement = settlementDate(calendar, rightsDate);
  const followingTradingDay = businessDaysAfter(calendar, settlement, 1);
  const days = calendarDaysBetween(settlement, followingTradingDay);

  // rightsDateは常に「権利落日の前営業日」(taisyaku.jpの倍率適用規定)に一致するため、
  // 最高料率は無条件に4倍で見積もる(docs/superpowers/notes/2026-09-03-taisyaku-rights-day-rate-multiplier.md参照)。
  const maxRate = calcMaxRate(closePrice, unitShares) * RIGHTS_DAY_RATE_MULTIPLIER;
  const maxGyakuhibu = calcMaxGyakuhibu(closePrice, unitShares, days) * RIGHTS_DAY_RATE_MULTIPLIER;
  const riskStatus: RiskStatus = row.value > maxGyakuhibu ? 'safe' : 'danger';
  return { riskStatus, maxGyakuhibu, maxRate, days, unitShares };
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
          UpdateExpression:
            'SET riskStatus = :riskStatus, maxGyakuhibu = :maxGyakuhibu, maxRate = :maxRate, #days = :days, unitShares = :unitShares',
          ExpressionAttributeNames: { '#days': 'days' },
          ExpressionAttributeValues: {
            ':riskStatus': risk.riskStatus,
            ':maxGyakuhibu': risk.maxGyakuhibu,
            ':maxRate': risk.maxRate,
            ':days': risk.days,
            ':unitShares': risk.unitShares,
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
