import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { calcMaxGyakuhibu, calcMaxRate, RIGHTS_DAY_RATE_MULTIPLIER } from '../shared/gyakuhibu-calc';
import { summarizeActuals } from '../shared/gyakuhibu-actual-summary';
import { getApiKey } from '../shared/jquants-batch-client';
import { fetchMarginNames, isGeneralMarginOnly } from '../shared/margin-name';
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
const GYAKUHIBU_ACTUAL_TABLE_NAME = process.env.GYAKUHIBU_ACTUAL_TABLE_NAME!;
const SECRET_ARN = process.env.SECRET_ARN!;
const API_BASE_URL = process.env.API_BASE_URL ?? 'https://api.jquants.com/v2';

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface MasterRow {
  ticker: string;
  unitShares: number;
  requiredShares: number | null;
  rightsMonths: number[];
  // 前回の実行で記録した貸借区分。J-Quantsからの取得に失敗した日はこれを使い続ける。
  marginName: string | null;
}

async function scanYutaiMaster(): Promise<MasterRow[]> {
  const rows: MasterRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({
        TableName: YUTAI_MASTER_TABLE_NAME,
        // MasterRowが読む5項目だけを取る。特にbenefitGroups(1銘柄0.7〜2KB × 1,642銘柄)は
        // ここでは使わないのに、Scanの1MBページングの往復回数を押し上げる。
        // MasterRowに項目を足すときはこの射影にも足すこと(足し忘れると黙ってundefinedに
        // なる)。
        ProjectionExpression: 'ticker, unitShares, requiredShares, rightsMonths, marginName',
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of result.Items ?? []) {
      if (typeof item.ticker === 'string' && typeof item.unitShares === 'number') {
        rows.push({
          ticker: item.ticker,
          unitShares: item.unitShares,
          // yutai-detail-sync-batchが個別ページから取った正確な必要株数。
          // 未取得の銘柄ではnullになり、単元株数で代用する。
          requiredShares: typeof item.requiredShares === 'number' ? item.requiredShares : null,
          rightsMonths: item.rightsMonths ?? [],
          marginName: typeof item.marginName === 'string' ? item.marginName : null,
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

// その銘柄の逆日歩実績を全件取る。権利日は年1〜2回なので、数年分でも数十行に収まる。
async function fetchActualRows(ticker: string): Promise<Array<Record<string, unknown>>> {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: GYAKUHIBU_ACTUAL_TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: { ':ticker': ticker },
    }),
  );
  return result.Items ?? [];
}

// リスクの判定(安全/注意/危険)はここでは出さない。逆日歩予測バッチが充足率P90で判定し、
// reference-apiがそれを優待一覧・詳細のriskStatusとして返す。このバッチはその土台となる
// 最大逆日歩(入札上限で決着した場合の上限額)などの金額を事前計算する。
interface RiskResult {
  maxGyakuhibu: number | null;
  maxRate: number | null;
  days: number | null;
  closePrice: number | null;
  requiredInvestment: number | null;
}

const NA_RISK: RiskResult = {
  maxGyakuhibu: null,
  maxRate: null,
  days: null,
  closePrice: null,
  requiredInvestment: null,
};

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
  row: { ticker: string },
  shares: number,
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

  // rightsDateは常に「権利落日の前営業日」(taisyaku.jpの倍率適用規定)に一致するため、
  // 最高料率は無条件に4倍で見積もる(docs/superpowers/notes/2026-09-03-taisyaku-rights-day-rate-multiplier.md参照)。
  const maxRate = calcMaxRate(closePrice, shares) * RIGHTS_DAY_RATE_MULTIPLIER;
  const maxGyakuhibu = calcMaxGyakuhibu(closePrice, shares, days) * RIGHTS_DAY_RATE_MULTIPLIER;
  return { maxGyakuhibu, maxRate, days, closePrice, requiredInvestment: closePrice * shares };
}

// 制度信用で売れない銘柄(信用・その他)には逆日歩が発生しえないので、最大逆日歩は出さない。
// クロスは一般信用で組むことになり、その場合も必要資金は要るので終値と必要資金だけ出す。
async function calcGeneralMarginOnlyRisk(ticker: string, shares: number): Promise<RiskResult> {
  const closePrice = await latestClose(ticker);
  return {
    ...NA_RISK,
    closePrice: closePrice ?? null,
    requiredInvestment: closePrice !== undefined ? closePrice * shares : null,
  };
}

// J-Quantsの上場一覧から最新の貸借区分を取る。失敗した場合や、空の一覧が返った場合は
// nullを返し、呼び出し側は前回までに記録した区分を使い続ける(全銘柄の区分を消さない)。
async function loadMarginNames(): Promise<Map<string, string> | null> {
  try {
    const names = await fetchMarginNames(await getApiKey(SECRET_ARN), API_BASE_URL);
    if (names.size === 0) {
      console.error('yutai-risk-precompute-batch: J-Quants returned an empty listing; keeping the stored margin names');
      return null;
    }
    return names;
  } catch (error) {
    console.error('yutai-risk-precompute-batch: failed to fetch margin names; keeping the stored values', error);
    return null;
  }
}

export const handler = async (): Promise<void> => {
  const rows = await scanYutaiMaster();
  const marginNames = await loadMarginNames();
  const calendarCache = new Map<string, CalendarDay[]>();

  let updated = 0;
  for (const row of rows) {
    try {
      const rightsDate = nextRightsDate(row.rightsMonths);
      // requiredSharesが未取得(yutai-detail-sync-batchがまだ回っていない)なら
      // 単元株数で代用する。代用したことはsummarizeActualsがbasedOnUnitSharesで
      // 画面に伝える。
      const shares = row.requiredShares ?? row.unitShares;
      // 上場一覧に無い銘柄(東証外上場など)は区分不明としてnull。
      const marginName = marginNames ? (marginNames.get(row.ticker) ?? null) : row.marginName;
      const generalMarginOnly = isGeneralMarginOnly(marginName);
      const risk = generalMarginOnly
        ? await calcGeneralMarginOnlyRisk(row.ticker, shares)
        : await calcRisk(row, shares, rightsDate, calendarCache);
      // 実績の集計は最大逆日歩の計算とは独立(信用残が無く最大逆日歩が出せない銘柄でも、
      // 過去に実際に取られたコストは出す価値がある)。ただし制度信用で売れない銘柄の実績は
      // 全て「発生しなかった」記録なので、「前回0円」と見せると誤解を招くため出さない。
      const actuals = generalMarginOnly
        ? { last: null, sameMonthLastYear: null }
        : summarizeActuals(await fetchActualRows(row.ticker), rightsDate, row.requiredShares, row.unitShares);

      await ddbDocClient.send(
        new UpdateCommand({
          TableName: YUTAI_MASTER_TABLE_NAME,
          Key: { ticker: row.ticker },
          // unitSharesはもう書かない。単元株数(100株固定)はyutai-master-sync-batchが持ち、
          // 優待に必要な株数はyutai-detail-sync-batchのrequiredSharesが持つ。
          // riskStatusは旧方式(優待価値 vs 最大逆日歩)の判定が残っていると紛らわしいので消す。
          UpdateExpression:
            'SET maxGyakuhibu = :maxGyakuhibu, maxRate = :maxRate, #days = :days, ' +
            'closePrice = :closePrice, requiredInvestment = :requiredInvestment, ' +
            'lastGyakuhibu = :lastGyakuhibu, sameMonthLastYearGyakuhibu = :sameMonthLastYearGyakuhibu, ' +
            'marginName = :marginName ' +
            'REMOVE riskStatus',
          ExpressionAttributeNames: { '#days': 'days' },
          ExpressionAttributeValues: {
            ':marginName': marginName,
            ':maxGyakuhibu': risk.maxGyakuhibu,
            ':maxRate': risk.maxRate,
            ':days': risk.days,
            ':closePrice': risk.closePrice,
            ':requiredInvestment': risk.requiredInvestment,
            ':lastGyakuhibu': actuals.last,
            ':sameMonthLastYearGyakuhibu': actuals.sameMonthLastYear,
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
