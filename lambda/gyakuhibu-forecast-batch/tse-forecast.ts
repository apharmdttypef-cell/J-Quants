// 現在需給ベース予測: 日証金の貸借取引残高(JQuantsMarginBalanceのsource=taisyaku、旧J-Quants行は混ぜない)の
// スナップショットから貸株超過率を求め、既存の統計モデル(lambda/shared/gyakuhibu-forecast.ts)を
// 「この超過率でキャリブレーションした別プール」で走らせる。
// 設計: docs/superpowers/specs/2026-09-09-tse-margin-forecast-design.md
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  buildPool,
  excessRatio,
  forecast,
  lagBucketFor,
  lendingGrowth4w,
  shiftIsoDate,
  snapshotAtOrBefore,
  LAG_BUCKETS,
  type ForecastSample,
  type LagBucket,
  type MarginSnapshot,
  type PoolBin,
  type TseForecast,
} from '../shared/gyakuhibu-forecast';
import { calendarDaysBetween } from '../shared/trading-calendar';

export type TseBucketSamples = Record<LagBucket, ForecastSample[]>;
export type TsePools = Record<LagBucket, PoolBin[]>;

// JQuantsMarginBalanceのsource=taisyaku行だけをスキャンし、ticker→日付昇順のスナップショット列にする。
// 旧J-Quants行(weekly/daily-alert)とカーソル行は、FilterExpressionとJS側の両方で除外する。
export async function scanMarginSnapshots(
  ddbDocClient: DynamoDBDocumentClient,
  tableName: string,
): Promise<Map<string, MarginSnapshot[]>> {
  const byTicker = new Map<string, Map<string, MarginSnapshot>>();
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: '#source = :source',
        ExpressionAttributeNames: { '#source': 'source' },
        ExpressionAttributeValues: { ':source': 'taisyaku' },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of result.Items ?? []) {
      if (item.source !== 'taisyaku') continue;
      if (typeof item.ticker !== 'string' || typeof item.date !== 'string') continue;
      if (typeof item.financingBalance !== 'number' || typeof item.lendingBalance !== 'number') continue;
      const perDate = byTicker.get(item.ticker) ?? new Map<string, MarginSnapshot>();
      perDate.set(item.date, { date: item.date, financingBalance: item.financingBalance, lendingBalance: item.lendingBalance });
      byTicker.set(item.ticker, perDate);
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  const snapshots = new Map<string, MarginSnapshot[]>();
  for (const [ticker, perDate] of byTicker) {
    snapshots.set(
      ticker,
      [...perDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    );
  }
  return snapshots;
}

// 各学習サンプル(taisyaku.jp実績)に、バケットごとの超過率(日証金の貸借取引残高ベース)を付与する。バケットのサンプル側
// スナップショットは「権利日のminLagDays日以上前で最新の点」。スナップショットが無い(鮮度切れ
// 含む)バケットにはそのサンプルを含めない。fillRatio等の目的変数はそのまま。
export function buildTseSamples(samples: ForecastSample[], snapshots: Map<string, MarginSnapshot[]>): TseBucketSamples {
  const out: TseBucketSamples = { '0-7': [], '8-21': [], '22+': [] };
  for (const sample of samples) {
    const points = snapshots.get(sample.ticker);
    if (!points) continue;
    for (const { key, minLagDays } of LAG_BUCKETS) {
      const snapshot = snapshotAtOrBefore(points, shiftIsoDate(sample.rightsDate, -minLagDays));
      if (!snapshot) continue;
      const ratio = excessRatio(snapshot.financingBalance, snapshot.lendingBalance);
      if (ratio === null) continue;
      out[key].push({ ...sample, excessRatio: ratio });
    }
  }
  return out;
}

export function buildTsePools(bucketSamples: TseBucketSamples): TsePools {
  return {
    '0-7': buildPool(bucketSamples['0-7']),
    '8-21': buildPool(bucketSamples['8-21']),
    '22+': buildPool(bucketSamples['22+']),
  };
}

// 銘柄1件の現在需給ベース予測。直近スナップショットが無い(鮮度切れ含む)・超過率が定義できない
// (融資残・貸株残とも0)場合はnull。
export function computeTseForecast(args: {
  ticker: string;
  today: string;
  nextRightsDate: string;
  snapshots: Map<string, MarginSnapshot[]>;
  bucketSamples: TseBucketSamples;
  maxGyakuhibu: number | null;
  value: number | null;
}): TseForecast | null {
  const points = args.snapshots.get(args.ticker);
  if (!points) return null;
  const snapshot = snapshotAtOrBefore(points, args.today);
  if (!snapshot) return null;
  const ratio = excessRatio(snapshot.financingBalance, snapshot.lendingBalance);
  if (ratio === null) return null;

  const lagDays = calendarDaysBetween(snapshot.date, args.nextRightsDate);
  const lagBucket = lagBucketFor(lagDays);
  const poolSamples = args.bucketSamples[lagBucket];
  const tickerSamples = poolSamples.filter((s) => s.ticker === args.ticker);

  const result = forecast({
    tickerSamples,
    poolSamples,
    scenario: 'current-tse',
    excessRatio: ratio,
    maxGyakuhibu: args.maxGyakuhibu,
    value: args.value,
  });

  return {
    ...result,
    snapshotDate: snapshot.date,
    lagDays,
    lagBucket,
    financingBalance: snapshot.financingBalance,
    lendingBalance: snapshot.lendingBalance,
    lendingGrowth4w: lendingGrowth4w(points, snapshot.date),
  };
}
