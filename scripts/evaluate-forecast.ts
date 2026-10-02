// 逆日歩予測 精度検証: S3上の凍結済みスナップショット(A・B)と実績を読み込み、
// 評価指標を計算してレポートを出力する。ローカル/CI実行用CLIスクリプト(Lambdaではない)。
// 実行例: npx ts-node scripts/evaluate-forecast.ts --actuals-label=2026-09-29T2000JST
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { binFor } from '../lambda/shared/gyakuhibu-forecast';
import {
  type JoinedSample,
  quantileCoverage,
  pinballLoss,
  occurrenceConfusionMatrix,
  occurrenceRateByBin,
  statusConfusionMatrix,
  safeMissList,
  binBreakdown,
  poolOnlyPinballLoss,
  tickerOnlyPinballLoss,
  fullFillPinballLoss,
  crossSnapshotComparison,
  populationBreakdown,
} from './lib/evaluation-metrics';
import { rebuildBaselineSamples } from './lib/rebuild-baseline-samples';

const BUCKET = process.env.VALIDATION_BUCKET_NAME ?? 'jquantsstack-gyakuhibuvalidationbucketad82b892-brbbrft4t0du';
const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME ?? 'JQuantsYutaiMaster';
const GYAKUHIBU_ACTUAL_TABLE_NAME = process.env.GYAKUHIBU_ACTUAL_TABLE_NAME ?? 'JQuantsGyakuhibuActual';
const RIGHTS_DATE = '2026-09-28';
const SNAPSHOT_A_KEY = 'forecast-snapshots/rightsDate=2026-09-28/asof=2026-09-26T0000JST/run=run=1/forecast.json';
const SNAPSHOT_B_KEY = 'forecast-snapshots/rightsDate=2026-09-28/asof=2026-09-28T1500JST/run=run=1/forecast.json';

const s3Client = new S3Client({});

interface FrozenForecastRecord {
  ticker: string;
  value: number | null;
  forecast: {
    bin: string | null;
    excessRatio: number | null;
    fillP50: number | null;
    fillP90: number | null;
    maxGyakuhibu: number | null;
    forecastStatus: 'safe' | 'caution' | 'danger' | 'na';
  };
}

interface ActualsRecord {
  ticker: string;
  fetchStatus: 'ok' | 'no_row' | 'fetch_error';
  fillRatioActual: number | null;
  costActual: number | null;
  statusActual: 'safe' | 'caution' | 'danger' | 'na';
  excessGroup: 'excess' | 'no_excess' | null;
  specialMultiplier: boolean;
}

// poolOnlyPinballLoss/tickerOnlyPinballLossはTask 3のレビュー修正で number | null を返すように
// なった(バッチ内に使えるベースラインデータを持つサンプルが1件も無いときnull、NaNは返さない、
// 例外も投げない)。ここでは number | null をそのままJSON metrics.jsonへ運ぶ(nullは「このバッチでは
// 算出不能」を意味する正当な自己記述的な値として扱う)。number側へ丸めたりnullを握りつぶしたり
// しないよう、以下の型は number/null をそのまま反映する。
interface BaselineMetrics {
  poolOnlyPinballLossP50: number | null;
  poolOnlyPinballLossP90: number | null;
  tickerOnlyPinballLossP50: number | null;
  tickerOnlyPinballLossP90: number | null;
  // fullFillPinballLossは(n=0以外は)常にnumberを返す関数のまま変わっていない
  // (baselineの中でも定数ベースラインなので、pool/ticker実績データの有無に依存しない)。
  fullFillPinballLossP50: number;
  fullFillPinballLossP90: number;
}

interface SafeMissRecord {
  ticker: string;
  value: number | null;
  costActual: number | null;
  fillP50: number | null;
  fillP90: number | null;
}

interface MetricsSection {
  label: string;
  n: number;
  populationBreakdown: ReturnType<typeof populationBreakdown>;
  note: string | null;
  quantileCoverage: ReturnType<typeof quantileCoverage> | null;
  pinballLossP50: number | null;
  pinballLossP90: number | null;
  occurrenceConfusionMatrix: ReturnType<typeof occurrenceConfusionMatrix> | null;
  occurrenceRateByBin: ReturnType<typeof occurrenceRateByBin> | null;
  statusConfusionMatrix: ReturnType<typeof statusConfusionMatrix> | null;
  safeMissList: SafeMissRecord[] | null;
  binBreakdown: ReturnType<typeof binBreakdown> | null;
  baselines: BaselineMetrics | null;
}

async function readJsonFromS3<T>(key: string): Promise<T> {
  const result = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks: Buffer[] = [];
  for await (const chunk of result.Body as AsyncIterable<Buffer>) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

// スナップショット1件分のforecast.jsonと実績1件分のactuals.jsonをticker単位でjoinする。
// 母集団はスナップショット側の全銘柄(実績が無い/取得失敗の銘柄もfetchStatusを引き継いで残す)。
function joinSnapshotWithActuals(
  forecastRecords: FrozenForecastRecord[],
  actualsByTicker: Map<string, ActualsRecord>,
  baseline: Awaited<ReturnType<typeof rebuildBaselineSamples>>,
): JoinedSample[] {
  return forecastRecords.map((f) => {
    const actual = actualsByTicker.get(f.ticker);
    const bin = f.forecast.excessRatio !== null ? binFor(f.forecast.excessRatio).label : f.forecast.bin;
    const poolBinSamples =
      bin !== null ? baseline.allSamples.filter((s) => s.excessRatio !== null && binFor(s.excessRatio).label === bin) : [];

    return {
      ticker: f.ticker,
      bin: f.forecast.bin,
      fillP50: f.forecast.fillP50,
      fillP90: f.forecast.fillP90,
      fillRatioActual: actual?.fillRatioActual ?? null,
      forecastStatusValue: f.forecast.forecastStatus,
      statusActual: actual?.statusActual ?? 'na',
      value: f.value,
      costActual: actual?.costActual ?? null,
      maxGyakuhibu: f.forecast.maxGyakuhibu,
      excessGroup: actual?.excessGroup ?? null,
      specialMultiplier: actual?.specialMultiplier ?? false,
      fetchStatus: actual?.fetchStatus ?? 'fetch_error',
      tickerSamplesForBaseline: (baseline.tickerSamplesByTicker.get(f.ticker) ?? []).map((s) => s.fillRatio),
      poolSamplesForBaseline: poolBinSamples.map((s) => s.fillRatio),
    };
  });
}

// 本命集計: final(スナップショット自体が常にfinalなので暗黙)× excessGroup=excess
// × specialMultiplier=false × fetchStatus=ok。
function primaryPopulation(samples: JoinedSample[]): JoinedSample[] {
  return samples.filter((s) => s.excessGroup === 'excess' && !s.specialMultiplier && s.fetchStatus === 'ok');
}

function formatMetricsSection(label: string, allJoined: JoinedSample[], primary: JoinedSample[]): MetricsSection {
  const breakdown = populationBreakdown(allJoined);
  if (primary.length === 0) {
    return {
      label,
      n: 0,
      populationBreakdown: breakdown,
      note: '本命集計が0件のため指標を計算できません',
      quantileCoverage: null,
      pinballLossP50: null,
      pinballLossP90: null,
      occurrenceConfusionMatrix: null,
      occurrenceRateByBin: null,
      statusConfusionMatrix: null,
      safeMissList: null,
      binBreakdown: null,
      baselines: null,
    };
  }
  const samples = primary;
  return {
    label,
    n: samples.length,
    populationBreakdown: breakdown,
    note: null,
    quantileCoverage: quantileCoverage(samples),
    pinballLossP50: pinballLoss(samples, 0.5, 'fillP50'),
    pinballLossP90: pinballLoss(samples, 0.9, 'fillP90'),
    occurrenceConfusionMatrix: occurrenceConfusionMatrix(samples),
    occurrenceRateByBin: occurrenceRateByBin(samples),
    statusConfusionMatrix: statusConfusionMatrix(samples),
    safeMissList: safeMissList(samples).map((s) => ({
      ticker: s.ticker,
      value: s.value,
      costActual: s.costActual,
      fillP50: s.fillP50,
      fillP90: s.fillP90,
    })),
    binBreakdown: binBreakdown(samples),
    baselines: {
      // poolOnlyPinballLoss/tickerOnlyPinballLossはバッチ内の全サンプルがベースライン配列を
      // 欠く場合にnullを返す(上のBaselineMetrics定義のコメント参照)。ここでキャストせず、
      // number | null のままmetrics.json/report.mdへ運ぶ。
      poolOnlyPinballLossP50: poolOnlyPinballLoss(samples, 0.5),
      poolOnlyPinballLossP90: poolOnlyPinballLoss(samples, 0.9),
      tickerOnlyPinballLossP50: tickerOnlyPinballLoss(samples, 0.5),
      tickerOnlyPinballLossP90: tickerOnlyPinballLoss(samples, 0.9),
      fullFillPinballLossP50: fullFillPinballLoss(samples, 0.5),
      fullFillPinballLossP90: fullFillPinballLoss(samples, 0.9),
    },
  };
}

function renderReportMarkdown(
  metricsA: MetricsSection,
  metricsB: MetricsSection,
  statusFlips: ReturnType<typeof crossSnapshotComparison>,
): string {
  return [
    `# 逆日歩予測 精度検証レポート(権利日: ${RIGHTS_DATE})`,
    '',
    `生成日時: ${new Date().toISOString()}`,
    '',
    '## スナップショットA(本命、asof=2026-09-26T0000JST、確報9/24分)',
    '',
    '```json',
    JSON.stringify(metricsA, null, 2),
    '```',
    '',
    '## スナップショットB(参考、asof=2026-09-28T1500JST、確報9/25分)',
    '',
    '```json',
    JSON.stringify(metricsB, null, 2),
    '```',
    '',
    '## スナップショット間で予測statusが入れ替わった銘柄',
    '',
    statusFlips.length === 0
      ? '(該当銘柄なし)'
      : ['| ticker | A | B | 実績 | どちらが正しかったか |', '|---|---|---|---|---|'].concat(
          statusFlips.map((f) => `| ${f.ticker} | ${f.statusA} | ${f.statusB} | ${f.statusActual} | ${f.whichMatched} |`),
        ).join('\n'),
    '',
    '## 注記',
    '',
    '- design doc(2026-09-24)はA-final/A-prelim/Bの3本比較を想定していたが、A-prelimは' +
      'Task 3(旧計画)完了時点で不要と判断され実装されていない。本レポートはA・B(いずれも' +
      'final、別日付の確報)の2本比較として扱う。',
    '- baselines.poolOnlyPinballLoss(P50/P90)・tickerOnlyPinballLoss(P50/P90)は、本命集計内の' +
      '全サンプルが対応するベースライン配列(プール側/銘柄側)を欠く場合にnullになる' +
      '(データ不足を意味する正当な値。エラーではない)。',
  ].join('\n');
}

async function main(): Promise<void> {
  const actualsLabelArg = process.argv.find((a) => a.startsWith('--actuals-label='));
  if (!actualsLabelArg) {
    throw new Error('Usage: npx ts-node scripts/evaluate-forecast.ts --actuals-label=<fetchedLabel>');
  }
  const actualsLabel = actualsLabelArg.split('=')[1];
  const actualsKey = `actuals/rightsDate=${RIGHTS_DATE}/fetchedAt=${actualsLabel}/actuals.json`;

  const [snapshotA, snapshotB, actualsData, baseline] = await Promise.all([
    readJsonFromS3<{ records: FrozenForecastRecord[] }>(SNAPSHOT_A_KEY),
    readJsonFromS3<{ records: FrozenForecastRecord[] }>(SNAPSHOT_B_KEY),
    readJsonFromS3<{ records: ActualsRecord[] }>(actualsKey),
    rebuildBaselineSamples(YUTAI_MASTER_TABLE_NAME, GYAKUHIBU_ACTUAL_TABLE_NAME),
  ]);

  const actualsByTicker = new Map(actualsData.records.map((r) => [r.ticker, r]));

  const joinedA = joinSnapshotWithActuals(snapshotA.records, actualsByTicker, baseline);
  const joinedB = joinSnapshotWithActuals(snapshotB.records, actualsByTicker, baseline);

  const metricsA = formatMetricsSection('Snapshot A (final, asof=2026-09-26T0000JST)', joinedA, primaryPopulation(joinedA));
  const metricsB = formatMetricsSection('Snapshot B (final, asof=2026-09-28T1500JST)', joinedB, primaryPopulation(joinedB));
  const statusFlips = crossSnapshotComparison(primaryPopulation(joinedA), primaryPopulation(joinedB));

  const reportMarkdown = renderReportMarkdown(metricsA, metricsB, statusFlips);
  const metricsJson = JSON.stringify(
    { rightsDate: RIGHTS_DATE, actualsLabel, snapshotA: metricsA, snapshotB: metricsB, statusFlips },
    null,
    2,
  );

  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: `evaluations/rightsDate=${RIGHTS_DATE}/report.md`,
      Body: reportMarkdown,
      ContentType: 'text/markdown',
    }),
  );
  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: `evaluations/rightsDate=${RIGHTS_DATE}/metrics.json`,
      Body: metricsJson,
      ContentType: 'application/json',
    }),
  );

  const notesDir = join(__dirname, '..', 'docs', 'superpowers', 'notes');
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(join(notesDir, `2026-09-28-gyakuhibu-forecast-validation-report.md`), reportMarkdown, 'utf8');
  writeFileSync(join(notesDir, `2026-09-28-gyakuhibu-forecast-validation-metrics.json`), metricsJson, 'utf8');

  console.log('Evaluation complete. Report written to S3 and docs/superpowers/notes/.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
