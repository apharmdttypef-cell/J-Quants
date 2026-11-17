import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { excessRatio, fillRatio, shiftIsoDate } from './gyakuhibu-forecast';
import { nextRightsDate, toRightsDay } from './trading-calendar';
import type { AbolitionNotice } from './yutai-abolition';

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// 逆日歩予測(lambda/shared/gyakuhibu-forecast.tsのForecastResult)のAPIレスポンス形状。
// listYutaiForecast/getYutaiForecastの両方で共用する(予測行が未計算の銘柄は
// defaultForecast()と同じ形を返す。フィールドを省略したり例外を投げたりしない)。
export interface ForecastFields {
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

export function defaultForecast(): ForecastFields {
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
export function buildForecast(item: Record<string, unknown> | undefined): ForecastFields {
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

export interface TseForecastFields extends ForecastFields {
  snapshotDate: string;
  lagDays: number;
  lagBucket: string;
  financingBalance: number;
  lendingBalance: number;
  lendingGrowth4w: number | null;
}

// 予測行のtseForecast属性(gyakuhibu-forecast-batch/tse-forecast.tsが書く)をAPI表現にする。
// 属性無し・nullのいずれもnull。
export function buildTseForecast(item: Record<string, unknown> | undefined): TseForecastFields | null {
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

// margin-trendが遡る日付範囲(暦日)。件数ではなく日付で絞る(Limitはフィルタより先に効くため)。
export const MARGIN_TREND_RANGE_DAYS = 365;

// 日証金(taisyaku.jp)由来の行だけを日付範囲(直近MARGIN_TREND_RANGE_DAYS日)で取得する。
// 旧データ(source: 'weekly'/'daily-alert')はFilterExpressionで除き、すり抜けた行もJS側で捨てる。
export async function queryTaisyakuMarginRows(ticker: string, ascending: boolean): Promise<Record<string, unknown>[]> {
  const today = new Date().toISOString().slice(0, 10);
  const rows: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await ddbDocClient.send(
      new QueryCommand({
        TableName: process.env.MARGIN_BALANCE_TABLE_NAME!,
        KeyConditionExpression: 'ticker = :ticker AND #date >= :from',
        FilterExpression: '#source = :source',
        ExpressionAttributeNames: { '#date': 'date', '#source': 'source' },
        ExpressionAttributeValues: {
          ':ticker': ticker,
          ':from': shiftIsoDate(today, -MARGIN_TREND_RANGE_DAYS),
          ':source': 'taisyaku',
        },
        ScanIndexForward: ascending,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of result.Items ?? []) {
      if (item.source === 'taisyaku') rows.push(item);
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return rows;
}

// GET /yutai/{ticker}/forecastのレスポンスボディと同じ形。
export interface YutaiForecastDetail {
  ticker: string;
  companyName: string | null;
  content: string;
  value: number | null;
  unitShares: number;
  requiredShares: number | null;
  rightsDate: string | null;
  maxGyakuhibu: number | null;
  closePrice: number | null;
  forecast: ForecastFields;
  tseForecast: TseForecastFields | null;
  history: Record<string, unknown>[];
  poolBins: unknown[];
  marginTrend: {
    latest: { date: unknown; financingBalance: unknown; lendingBalance: unknown } | null;
  };
}

// abolitionNoticeはAPIのレスポンスに無い項目なのでdetailの外に置く(APIのレスポンスを変えないため)。
export interface YutaiForecastDetailResult {
  detail: YutaiForecastDetail;
  abolitionNotice: AbolitionNotice | null;
}

export async function loadYutaiForecastDetail(ticker: string): Promise<YutaiForecastDetailResult | null> {
  const masterResult = await ddbDocClient.send(
    new GetCommand({ TableName: process.env.YUTAI_MASTER_TABLE_NAME!, Key: { ticker } }),
  );
  const masterItem = masterResult.Item;
  if (!masterItem) return null;
  const master = {
    ticker: masterItem.ticker as string,
    companyName: (masterItem.companyName as string | undefined) ?? null,
    content: masterItem.content as string,
    value: (masterItem.value as number | null | undefined) ?? null,
    unitShares: masterItem.unitShares as number,
    requiredShares: (masterItem.requiredShares as number | null | undefined) ?? null,
    rightsMonths: (masterItem.rightsMonths as number[] | undefined) ?? [],
    rightsDay: toRightsDay(masterItem.rightsDay),
    maxGyakuhibu: (masterItem.maxGyakuhibu as number | null | undefined) ?? null,
    closePrice: (masterItem.closePrice as number | null | undefined) ?? null,
    abolitionNotice: (masterItem.abolitionNotice as AbolitionNotice | null | undefined) ?? null,
  };

  // 呼び出し順はテストのmockResolvedValueOnce順(forecast get → _POOL_ get → actual query →
  // margin query)と一致させるため、この順で逐次await(Promise.allは使わない)。
  const forecastTable = process.env.GYAKUHIBU_FORECAST_TABLE_NAME!;
  const forecastResult = await ddbDocClient.send(new GetCommand({ TableName: forecastTable, Key: { ticker } }));
  const poolResult = await ddbDocClient.send(new GetCommand({ TableName: forecastTable, Key: { ticker: '_POOL_' } }));
  const actualResult = await ddbDocClient.send(
    new QueryCommand({
      TableName: process.env.GYAKUHIBU_ACTUAL_TABLE_NAME!,
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: { ':ticker': ticker },
      ScanIndexForward: false,
    }),
  );
  const marginRows = await queryTaisyakuMarginRows(ticker, false);

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
      // totalAmountは記録当時のunitSharesを掛けた値なので、必要株数とは別の株数を
      // 指している可能性がある。画面はavgRate × days × 株数で組み直すため、
      // 株数に依存しないavgRateとdaysを渡す(totalAmountは既存の互換のために残す)。
      avgRate: item.avgRate ?? 0,
      days: item.days ?? 0,
      totalAmount: item.totalAmount ?? 0,
      maxRateActual: item.maxRateActual ?? null,
      bidRank: item.bidRank ?? null,
      restriction: item.restriction ?? null,
      emergencyMeasure: item.emergencyMeasure ?? null,
      occurred: item.noGyakuhibu !== true,
    };
  });

  const poolBins = poolResult.Item?.bins ?? [];

  const marginLatest = marginRows[0];
  const marginTrend = marginLatest
    ? {
        latest: {
          date: marginLatest.date,
          financingBalance: marginLatest.financingBalance,
          lendingBalance: marginLatest.lendingBalance,
        },
      }
    : { latest: null };

  const rightsDate = nextRightsDate(master.rightsMonths, master.rightsDay);

  return {
    detail: {
      ticker: master.ticker,
      companyName: master.companyName,
      content: master.content,
      value: master.value,
      unitShares: master.unitShares,
      // 過去権利日のコストは必要株数ベースで出す(単元株数ではない)。unitSharesは
      // 単元の表示に使うので消さずに両方返す。
      requiredShares: master.requiredShares,
      rightsDate: rightsDate ?? null,
      maxGyakuhibu: master.maxGyakuhibu,
      closePrice: master.closePrice,
      forecast,
      tseForecast: buildTseForecast(forecastResult.Item),
      history,
      poolBins,
      marginTrend,
    },
    abolitionNotice: master.abolitionNotice,
  };
}
