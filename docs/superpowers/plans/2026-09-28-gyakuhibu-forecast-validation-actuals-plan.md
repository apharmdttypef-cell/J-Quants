# 逆日歩予測 精度検証 実装計画(Task 4-6: 実績取得・評価・合格基準凍結)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **日付固定の締切があります。** Task 1(実績取得Lambda)+ Task 2(スケジュール)は2026-09-29 20:00 JSTの1回目実績取得より前にデプロイ完了している必要があります。Task 5(合格基準凍結)は2026-09-28 09:00 JSTが本来の締切でしたが既に経過しており(ユーザー確認済み、実害なし — 実際の結果はtaisyaku.jpの確報サイクル上、2026-09-29以降にしか判明しないため)、それでも**評価スクリプト実行より前に**確定させる。

**Goal:** 2026-09-28権利付き最終日の実績逆日歩を取得し、既に凍結済みのスナップショットA・B(Task 1-3で本番稼働・実データで検証済み)の予測精度を、事前凍結した合格基準と突き合わせて評価する。

**Architecture:** 新規Lambda `ForecastActualsFunction` がtaisyaku.jpから9/28申込分の実績を取得し、Task 1で作成済みのObject Lock付きS3バケットに書き込む(スナップショットと同じ「最後にmanifest.json」パターン)。評価は独立したNode/TSスクリプト `scripts/evaluate-forecast.ts` として実装し、S3上のスナップショット・実績データを読み込んで指標を計算し、レポートを出力する。合格基準は評価スクリプトの実行前にJSONとして凍結する。

**Tech Stack:** AWS Lambda(Node.js 22)、EventBridge Scheduler、S3(Object Lock、Task 1で作成済みの`GyakuhibuValidationBucket`を再利用)、DynamoDB、Node.js CLIスクリプト(ts-node)。

## 前提(Task 1-3の実際の結果、この計画が依拠する事実)

- **スナップショットA(本命)**: 実際に2026-09-26 00:00 JSTに発火・完了。S3キー `forecast-snapshots/rightsDate=2026-09-28/asof=2026-09-26T0000JST/run=run=1/`。`variant: "final"`、`asofDate: "2026-09-24"`。307銘柄、全件`fetchStatus: "ok"`。
- **スナップショットB(参考)**: 実際に2026-09-28 15:00 JSTに発火・完了。S3キー `forecast-snapshots/rightsDate=2026-09-28/asof=2026-09-28T1500JST/run=run=1/`。`variant: "final"`(design doc記載の`prelim`ではなく、リハーサル結果に基づきユーザー判断で`final`に単純化済み)、`asofDate: "2026-09-25"`。同じく307銘柄全件成功。
- **設計書との差異**: design doc(`docs/superpowers/specs/2026-09-24-gyakuhibu-forecast-validation-design.md`)のTask 5は「A-final、A-prelim、Bの比較」を想定しているが、**A-prelim(スナップショットAの速報バリアント)は実装・実行されていない**(Task 3の計画時点で不要と判断済み)。この計画のTask 4(評価スクリプト)は実在する2本(AとB、どちらも`final`・別日付の確報)の比較として再設計する。
- **実際のforecast.jsonレコード形状**(design doc記載の例とは異なる、実装時に独自設計された実際の形状。以下がこの計画が前提とする「真実」):

```json
{
  "ticker": "9024",
  "companyName": "西武ホールディングス",
  "rightsDate": "2026-09-28",
  "value": 3000,
  "unitShares": 100,
  "requiredShares": 100,
  "closePrice": 1800,
  "pricedAt": "2026-09-25",
  "maxRatePerShare": 14.4,
  "days": 1,
  "asofDate": "2026-09-24",
  "variant": "final",
  "dataStatus": "final",
  "fetchStatus": "ok",
  "financingBalance": 8000,
  "lendingBalance": 500,
  "observedExcessRatio": 0.0625,
  "errorMessage": null,
  "forecast": {
    "scenario": "last-rights",
    "excessRatio": 0.0625,
    "maxGyakuhibu": 1440,
    "bin": "0〜0.5",
    "pOccur": 0.3,
    "fillP50": 0.1,
    "fillP90": 0.6,
    "fillMean": 0.25,
    "forecastP50": 144,
    "forecastP90": 864,
    "forecastMean": 360,
    "expectedNet": 2640,
    "forecastStatus": "safe",
    "tickerSamples": 3,
    "poolSamples": 42,
    "shrinkageWeight": 0.4285714285714286
  },
  "computedAt": "2026-09-26T00:03:12.000Z"
}
```

読み取る際は`lambda/gyakuhibu-forecast-validation/index.ts`のレコード生成部分(現時点のHEAD)を都度確認すること。この計画のどのタスクも`lambda/gyakuhibu-forecast-validation/`配下のファイルは変更しない(凍結済みの過去実行結果の解釈契約を壊さないため)。

## Global Constraints

- 評価母集団は**スナップショットAの銘柄リストに固定**する(実績取得時に銘柄を追加・削除しない)。
- 既存のtaisyaku.jpクライアント(`lambda/gyakuhibu-history-batch/taisyaku-client.ts`の`fetchTaisyakuCsv`・`parseTaisyakuCsv`・`splitCsvLine`)、既存の逆日歩予測純粋関数(`lambda/shared/gyakuhibu-forecast.ts`の`toSample`・`binFor`・`weightedQuantile`・`forecastStatus`)、既存の最高料率計算(`lambda/shared/gyakuhibu-calc.ts`の`calcMaxRate`・`RIGHTS_DAY_RATE_MULTIPLIER`)をそのまま再利用する。**これらのファイルは変更しない**(本番の日次バッチに影響するため)。`lambda/gyakuhibu-forecast-validation/`配下(Task 1-3の成果物)も変更しない。
- 取得に失敗した銘柄は`fetchStatus: "fetch_error"`として記録し、**古いデータへの暗黙のフォールバックをしない**。`no_row`と`fetch_error`は0円扱いにしない(0円扱いは品貸料率が「-」の場合のみ)。
- `manifest.json`が最後に書かれることを「run完了」の合図とする。
- 新規Lambda・スクリプトは既存の予測パイプライン(`gyakuhibu-forecast-batch`・`gyakuhibu-history-batch`等)に一切変更を加えない。
- S3バケットは既存の`this.gyakuhibuValidationBucket`(Task 1で作成済み)をそのまま使う。新規バケットは作らない。

---

### Task 1: 実績取得Lambda `ForecastActualsFunction`

**Files:**
- Create: `lambda/gyakuhibu-forecast-actuals/target-tickers.ts`
- Create: `lambda/gyakuhibu-forecast-actuals/actuals-input.ts`
- Create: `lambda/gyakuhibu-forecast-actuals/index.ts`
- Test: `test/gyakuhibu-forecast-actuals.test.ts`

**Interfaces:**
- Consumes: Task 1(旧)の`this.gyakuhibuValidationBucket`、既存の`fetchTaisyakuCsv`・`parseTaisyakuCsv`・`splitCsvLine`(`lambda/gyakuhibu-history-batch/taisyaku-client.ts`、変更しない)、既存の`calcMaxRate`(`lambda/shared/gyakuhibu-calc.ts`、変更しない)、既存の`forecastStatus`(`lambda/shared/gyakuhibu-forecast.ts`、変更しない)、S3上の凍結済みスナップショットA(`forecast-snapshots/rightsDate=2026-09-28/asof=2026-09-26T0000JST/run=run=1/forecast.json`)
- Produces(Task 2が呼ぶ): `handler(event: { rightsDate: string; fetchedLabel: string; prefix?: string }): Promise<void>`
- Produces(Task 3/4が読む): S3キー`{prefix ?? ''}actuals/rightsDate={rightsDate}/fetchedAt={fetchedLabel}/actuals.json`の1レコードの形状(下記Step 3参照)

- [ ] **Step 1: スナップショットAの凍結済み銘柄リストを読み込むロジックを実装する**

`lambda/gyakuhibu-forecast-actuals/target-tickers.ts`:

```ts
// 逆日歩予測 精度検証: 実績取得の対象銘柄を、既にObject Lockで凍結済みの
// スナップショットA(forecast-snapshots/rightsDate=2026-09-28/asof=2026-09-26T0000JST/run=run=1/)
// のforecast.jsonからそのまま読み込む。評価母集団を後から増減させないための唯一の正典。
// asofLabelが '2026-09-26T0000JST' 固定なのは、このLambdaが2026-09-28権利日専用の
// 検証実行が前提のため(実際にこの時刻でスナップショットAが発火・完了済み)。
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

export interface FrozenTarget {
  ticker: string;
  companyName: string;
  value: number | null;
  unitShares: number;
  requiredShares: number;
  closePrice: number | null;
  days: number;
}

interface FrozenForecastRecord {
  ticker: string;
  companyName: string;
  value: number | null;
  unitShares: number;
  requiredShares: number;
  closePrice: number | null;
  days: number;
}

interface FrozenForecastJson {
  records: FrozenForecastRecord[];
}

async function streamToString(stream: import('stream').Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function loadSnapshotATargets(
  s3Client: S3Client,
  bucket: string,
  snapshotAKey: string,
): Promise<FrozenTarget[]> {
  const result = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: snapshotAKey }));
  const body = await streamToString(result.Body as import('stream').Readable);
  const parsed = JSON.parse(body) as FrozenForecastJson;

  return parsed.records.map((r) => ({
    ticker: r.ticker,
    companyName: r.companyName,
    value: r.value,
    unitShares: r.unitShares,
    requiredShares: r.requiredShares,
    closePrice: r.closePrice,
    days: r.days,
  }));
}
```

- [ ] **Step 2: 実績1銘柄分の取得ロジックを実装する**

`lambda/gyakuhibu-forecast-actuals/actuals-input.ts`:

```ts
// 逆日歩予測 精度検証: 銘柄1件分の実績(9/28申込分)を取得する。
// 既存のfetchTaisyakuCsv/parseTaisyakuCsv/splitCsvLine(いずれも変更しない)をそのまま使う。
// parseTaisyakuCsvにはunitShares=1を渡す(totalAmount = perShareRate × 1 = perShareRate、
// つまり「1株あたり・品貸日数分」の生の値がそのままlendingFeeTotalになる。呼び出し側
// (index.ts)が実際のrequiredSharesを掛けてcostActualを出すので、ここでは単元株数を
// 一切考慮しない)。
// parseTaisyakuCsvは「最低料率」列を返さない(GyakuhibuActualPointに無い)ため、
// このファイル内で splitCsvLine を使い同じ行検索ロジックを再実装する(重複コード、
// 意図的。taisyaku-client.tsは変更しない)。
import { fetchTaisyakuCsv, parseTaisyakuCsv, splitCsvLine } from '../gyakuhibu-history-batch/taisyaku-client';
import { shiftIsoDate } from '../shared/gyakuhibu-forecast';

const LOOKBACK_DAYS = 30;

export interface ActualsInput {
  ticker: string;
  fetchStatus: 'ok' | 'no_row' | 'fetch_error';
  lendingFeeTotal: number | null; // 1株あたり・品貸日数分(unitShares=1で取得した生の値)
  days: number | null;
  maxRateActual: number | null;
  minRateActual: number | null;
  financingBalance: number | null;
  lendingBalance: number | null;
  bidRank: string | null;
  measures: string[]; // [restriction, emergencyMeasure]のうちnullでないもの
  rawCsv: string | null;
  errorMessage?: string;
}

// CSVの「最低料率（品貸日数分/円）」列を、対象日の行から抽出する。
// parseTaisyakuCsvの行検索ロジック(日付正規化・列不一致行スキップ)と同じ方針を踏襲する。
function extractMinRateActual(csvText: string, rightsDate: string): number | null {
  const lines = csvText.trim().split('\n');
  const header = splitCsvLine(lines[0]);
  const minRateIdx = header.findIndex((h) => h.includes('最低料率'));
  const dateIdx = header.findIndex((h) => h.includes('申込日'));
  if (minRateIdx === -1 || dateIdx === -1) return null;

  const normalizedRightsDate = rightsDate.replace(/\D/g, '');
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = splitCsvLine(line);
    if (cols.length !== header.length) continue;
    if (cols[dateIdx].replace(/\D/g, '') !== normalizedRightsDate) continue;
    const raw = cols[minRateIdx].trim();
    if (raw === '') return null;
    const value = Number(raw.replace(/,/g, ''));
    return Number.isNaN(value) ? null : value;
  }
  return null;
}

export async function fetchTickerActualsInput(ticker: string, rightsDate: string): Promise<ActualsInput> {
  const from = shiftIsoDate(rightsDate, -LOOKBACK_DAYS);

  let csv: string;
  try {
    csv = await fetchTaisyakuCsv(ticker, from, rightsDate);
  } catch (error) {
    console.error(`${ticker}: failed to fetch taisyaku.jp CSV for rightsDate ${rightsDate}`, error);
    return {
      ticker,
      fetchStatus: 'fetch_error',
      lendingFeeTotal: null,
      days: null,
      maxRateActual: null,
      minRateActual: null,
      financingBalance: null,
      lendingBalance: null,
      bidRank: null,
      measures: [],
      rawCsv: null,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  const point = parseTaisyakuCsv(csv, rightsDate, 1, ticker);
  if (!point) {
    return {
      ticker,
      fetchStatus: 'no_row',
      lendingFeeTotal: null,
      days: null,
      maxRateActual: null,
      minRateActual: null,
      financingBalance: null,
      lendingBalance: null,
      bidRank: null,
      measures: [],
      rawCsv: csv,
    };
  }

  return {
    ticker,
    fetchStatus: 'ok',
    lendingFeeTotal: point.totalAmount,
    days: point.days,
    maxRateActual: point.maxRateActual,
    minRateActual: extractMinRateActual(csv, rightsDate),
    financingBalance: point.financingBalance,
    lendingBalance: point.lendingBalance,
    bidRank: point.bidRank,
    measures: [point.restriction, point.emergencyMeasure].filter((m): m is string => m !== null),
    rawCsv: csv,
  };
}
```

- [ ] **Step 3: ハンドラ本体を実装する**

`lambda/gyakuhibu-forecast-actuals/index.ts`:

```ts
// 逆日歩予測 精度検証(2026-09-28権利付き最終日)用実績取得Lambda。
// スナップショットLambda(lambda/gyakuhibu-forecast-validation/)とは完全に独立。
// 出力はTask 1(旧)で作成したObject Lock付きS3バケットへ、以下のキー配下に書く:
//   {prefix ?? ''}actuals/rightsDate={rightsDate}/fetchedAt={fetchedLabel}/
//     actuals.json        銘柄ごとの実績(全銘柄まとめて1ファイル)
//     inputs/{ticker}.csv taisyaku.jpから取得した生CSV(銘柄ごとに1ファイル)
//     manifest.json       run完了の合図として最後に書く
import { createHash } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { calcMaxRate, RIGHTS_DAY_RATE_MULTIPLIER } from '../shared/gyakuhibu-calc';
import { forecastStatus, type ForecastStatus } from '../shared/gyakuhibu-forecast';
import { loadSnapshotATargets, type FrozenTarget } from './target-tickers';
import { fetchTickerActualsInput, type ActualsInput } from './actuals-input';

const VALIDATION_BUCKET_NAME = process.env.VALIDATION_BUCKET_NAME!;
const GYAKUHIBU_ACTUAL_TABLE_NAME = process.env.GYAKUHIBU_ACTUAL_TABLE_NAME!;
// 実際に発火・完了済みのスナップショットAの固定キー(2026-09-28権利日専用の検証実行が
// 前提のため定数化する。Task 3(旧)完了時点でこの値は既に確定済みの過去の事実)。
const SNAPSHOT_A_KEY =
  process.env.SNAPSHOT_A_KEY ??
  'forecast-snapshots/rightsDate=2026-09-28/asof=2026-09-26T0000JST/run=run=1/forecast.json';
const BETWEEN_REQUESTS_DELAY_MS = Number(process.env.TAISYAKU_REQUEST_INTERVAL_MS ?? '1000');
// 実績照合時のavgRate許容誤差(浮動小数点の丸め対策)。
const AVG_RATE_TOLERANCE = 0.01;
const MULTIPLIER_TOLERANCE = 0.01;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3Client = new S3Client({});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function putObject(key: string, body: string, contentType: string): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({ Bucket: VALIDATION_BUCKET_NAME, Key: key, Body: body, ContentType: contentType }),
  );
}

// 既存JQuantsGyakuhibuActualの同一ticker・rightsDateの行を読み、avgRateを突き合わせる。
// 存在しない場合はundefinedを返す(まだ本番のgyakuhibu-history-batchが処理していない、
// または対象ticker自体が優待銘柄以外)。
async function crossCheckAgainstProductionTable(
  ticker: string,
  rightsDate: string,
  ourAvgRate: number | null,
): Promise<{ existingAvgRate: number; mismatch: boolean } | undefined> {
  const result = await ddbDocClient.send(
    new GetCommand({ TableName: GYAKUHIBU_ACTUAL_TABLE_NAME, Key: { ticker, rightsDate } }),
  );
  const item = result.Item as { avgRate?: number } | undefined;
  if (!item || typeof item.avgRate !== 'number') return undefined;
  const mismatch = ourAvgRate === null || Math.abs(item.avgRate - ourAvgRate) > AVG_RATE_TOLERANCE;
  return { existingAvgRate: item.avgRate, mismatch };
}

export const handler = async (event: {
  rightsDate: string;
  fetchedLabel: string;
  prefix?: string;
}): Promise<void> => {
  const startedAt = new Date().toISOString();
  const basePrefix = `${event.prefix ?? ''}actuals/rightsDate=${event.rightsDate}/fetchedAt=${event.fetchedLabel}/`;

  console.log(`gyakuhibu-forecast-actuals: starting fetchedLabel=${event.fetchedLabel} rightsDate=${event.rightsDate}`);

  const targets: FrozenTarget[] = await loadSnapshotATargets(s3Client, VALIDATION_BUCKET_NAME, SNAPSHOT_A_KEY);
  console.log(`gyakuhibu-forecast-actuals: loaded ${targets.length} frozen targets from Snapshot A`);

  const records: Record<string, unknown>[] = [];
  const csvByTicker = new Map<string, string>();
  const crossCheckMismatches: Array<{ ticker: string; ours: number | null; existing: number }> = [];
  let fetchOkCount = 0;
  let fetchErrorCount = 0;
  let noRowCount = 0;

  for (const target of targets) {
    let input: ActualsInput;
    try {
      input = await fetchTickerActualsInput(target.ticker, event.rightsDate);
    } catch (error) {
      console.error(`${target.ticker}: unexpected error from fetchTickerActualsInput`, error);
      input = {
        ticker: target.ticker,
        fetchStatus: 'fetch_error',
        lendingFeeTotal: null,
        days: null,
        maxRateActual: null,
        minRateActual: null,
        financingBalance: null,
        lendingBalance: null,
        bidRank: null,
        measures: [],
        rawCsv: null,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }

    if (input.fetchStatus === 'ok') fetchOkCount++;
    else if (input.fetchStatus === 'no_row') noRowCount++;
    else fetchErrorCount++;
    if (input.rawCsv !== null) csvByTicker.set(target.ticker, input.rawCsv);

    // fillRatioActual = lendingFeeTotal / maxRateActual(どちらも1株・品貸日数分なので約分される)。
    const fillRatioActual =
      input.maxRateActual === null || input.lendingFeeTotal === null
        ? null
        : input.maxRateActual === 0
          ? 0
          : input.lendingFeeTotal / input.maxRateActual;

    // multiplierActual = maxRateActual / (calcMaxRate(スナップショットAの終値, 単元株数) × days)。
    // Snapshot Aが凍結したclosePrice/unitShares/daysから、掛け算前の生の最高料率をここで
    // 再計算する(Snapshot A自身はmaxRatePerShare = 生の値×RIGHTS_DAY_RATE_MULTIPLIERを
    // 保存しているが、実績側は「実際に何倍だったか」を独立に検証する必要があるため、
    // 生の値を自前で再計算し直す)。
    const rawMaxRate =
      target.closePrice !== null ? calcMaxRate(target.closePrice, target.unitShares) : null;
    const expectedMaxRate = rawMaxRate !== null ? rawMaxRate * target.days : null;
    const multiplierActual =
      input.maxRateActual !== null && expectedMaxRate !== null && expectedMaxRate !== 0
        ? input.maxRateActual / expectedMaxRate
        : null;
    const specialMultiplier =
      multiplierActual !== null && Math.abs(multiplierActual - RIGHTS_DAY_RATE_MULTIPLIER) > MULTIPLIER_TOLERANCE;

    const costActual = input.lendingFeeTotal !== null ? input.lendingFeeTotal * target.requiredShares : null;
    const statusActual: ForecastStatus =
      target.value !== null && costActual !== null ? forecastStatus(target.value, costActual, costActual) : 'na';
    const excessGroup: 'excess' | 'no_excess' | null =
      input.financingBalance !== null && input.lendingBalance !== null
        ? input.lendingBalance > input.financingBalance
          ? 'excess'
          : 'no_excess'
        : null;

    const ourAvgRate =
      input.lendingFeeTotal !== null && input.days !== null && input.days > 0
        ? input.lendingFeeTotal / input.days
        : input.lendingFeeTotal === 0
          ? 0
          : null;
    const crossCheck = await crossCheckAgainstProductionTable(target.ticker, event.rightsDate, ourAvgRate);
    if (crossCheck?.mismatch) {
      crossCheckMismatches.push({ ticker: target.ticker, ours: ourAvgRate, existing: crossCheck.existingAvgRate });
    }

    records.push({
      ticker: target.ticker,
      fetchStatus: input.fetchStatus,
      lendingFeeTotal: finiteOrNull(input.lendingFeeTotal),
      days: input.days,
      maxRateActual: finiteOrNull(input.maxRateActual),
      minRateActual: finiteOrNull(input.minRateActual),
      financingBalance: input.financingBalance,
      lendingBalance: input.lendingBalance,
      bidRank: input.bidRank,
      measures: input.measures,
      fillRatioActual: finiteOrNull(fillRatioActual),
      multiplierActual: finiteOrNull(multiplierActual),
      specialMultiplier,
      costActual: finiteOrNull(costActual),
      statusActual,
      excessGroup,
      errorMessage: input.errorMessage ?? null,
      computedAt: new Date().toISOString(),
    });

    await sleep(BETWEEN_REQUESTS_DELAY_MS);
  }

  const actualsJson = JSON.stringify(
    { rightsDate: event.rightsDate, fetchedLabel: event.fetchedLabel, records },
    null,
    2,
  );
  await putObject(`${basePrefix}actuals.json`, actualsJson, 'application/json');

  const fileHashes: Record<string, string> = { 'actuals.json': sha256Hex(actualsJson) };
  for (const [ticker, csv] of csvByTicker) {
    const relativeKey = `inputs/${ticker}.csv`;
    try {
      await putObject(`${basePrefix}${relativeKey}`, csv, 'text/csv');
      fileHashes[relativeKey] = sha256Hex(csv);
    } catch (error) {
      console.error(`${ticker}: failed to write raw CSV to S3`, error);
    }
  }

  const completedAt = new Date().toISOString();
  const manifest = {
    startedAt,
    completedAt,
    gitCommit: process.env.GIT_COMMIT ?? 'unknown',
    rightsDate: event.rightsDate,
    fetchedLabel: event.fetchedLabel,
    snapshotAKey: SNAPSHOT_A_KEY,
    tickerCounts: {
      total: records.length,
      ok: fetchOkCount,
      noRow: noRowCount,
      fetchError: fetchErrorCount,
    },
    crossCheckMismatches,
    files: fileHashes,
  };
  await putObject(`${basePrefix}manifest.json`, JSON.stringify(manifest, null, 2), 'application/json');

  console.log(
    `gyakuhibu-forecast-actuals: completed fetchedLabel=${event.fetchedLabel} — ${records.length} tickers ` +
      `(${fetchOkCount} ok, ${noRowCount} no_row, ${fetchErrorCount} fetch_error, ${crossCheckMismatches.length} cross-check mismatches)`,
  );
};
```

- [ ] **Step 4: テストを書く**

`test/gyakuhibu-forecast-actuals.test.ts`(taisyaku-client・DynamoDB・S3はモック):

```ts
import { createHash } from 'crypto';
import { Readable } from 'stream';

const mockDdbSend = jest.fn();
const mockS3Send = jest.fn();
const mockFetchTaisyakuCsv = jest.fn();
const mockParseTaisyakuCsv = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  GetCommand: jest.fn((input: unknown) => input),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn((input: unknown) => ({ __type: 'put', ...input })),
  GetObjectCommand: jest.fn((input: unknown) => ({ __type: 'get', ...input })),
}));
jest.mock('../lambda/gyakuhibu-history-batch/taisyaku-client', () => {
  const actual = jest.requireActual('../lambda/gyakuhibu-history-batch/taisyaku-client');
  return {
    ...actual,
    fetchTaisyakuCsv: (...args: unknown[]) => mockFetchTaisyakuCsv(...args),
    parseTaisyakuCsv: (...args: unknown[]) => mockParseTaisyakuCsv(...args),
  };
});

process.env.VALIDATION_BUCKET_NAME = 'test-validation-bucket';
process.env.GYAKUHIBU_ACTUAL_TABLE_NAME = 'JQuantsGyakuhibuActual';
process.env.TAISYAKU_REQUEST_INTERVAL_MS = '0';
process.env.SNAPSHOT_A_KEY = 'forecast-snapshots/rightsDate=2026-09-28/asof=2026-09-26T0000JST/run=run=1/forecast.json';

function frozenForecastJsonBody(records: unknown[]): string {
  return JSON.stringify({ records });
}

function s3GetObjectStub(body: string) {
  return { Body: Readable.from([Buffer.from(body, 'utf8')]) };
}

beforeEach(() => {
  mockDdbSend.mockReset();
  mockDdbSend.mockResolvedValue({}); // デフォルトはItem無し(クロスチェック対象無し)
  mockS3Send.mockReset();
  mockFetchTaisyakuCsv.mockReset();
  mockParseTaisyakuCsv.mockReset();
});

// -----------------------------------------------------------------------
// extractMinRateActual / fetchTickerActualsInput: '-' → 0円、行欠損 → no_row、
// クォート付きの値のパース、倍率の判定
// -----------------------------------------------------------------------
describe('fetchTickerActualsInput', () => {
  const { fetchTickerActualsInput: realFetch } = jest.requireActual(
    '../lambda/gyakuhibu-forecast-actuals/actuals-input',
  ) as typeof import('../lambda/gyakuhibu-forecast-actuals/actuals-input');
  const { parseTaisyakuCsv: realParse } = jest.requireActual(
    '../lambda/gyakuhibu-history-batch/taisyaku-client',
  ) as typeof import('../lambda/gyakuhibu-history-batch/taisyaku-client');

  const CSV_HEADER =
    '"銘柄コード","申込日","融資残高（株）","貸株残高（株）","貸借値段（円）","品貸料率（品貸日数分/円）","品貸日数","品貸料率（年率換算/％）","最高料率（品貸日数分/円）","最低料率（品貸日数分/円）","応札ランク","制限措置","臨時措置"';

  test('returns fetch_error (no fallback) when fetchTaisyakuCsv throws', async () => {
    mockFetchTaisyakuCsv.mockRejectedValueOnce(new Error('network error'));

    const result = await realFetch('1234', '2026-09-28');

    expect(result).toEqual({
      ticker: '1234',
      fetchStatus: 'fetch_error',
      lendingFeeTotal: null,
      days: null,
      maxRateActual: null,
      minRateActual: null,
      financingBalance: null,
      lendingBalance: null,
      bidRank: null,
      measures: [],
      rawCsv: null,
      errorMessage: 'network error',
    });
  });

  test('returns no_row when the target date is missing from the CSV (page fetched but no matching row)', async () => {
    const csv = `${CSV_HEADER}\n"1234","20260924","8000","500","3551.00","0.20","1","2.05","14.40","0.00","F","",""`;
    mockFetchTaisyakuCsv.mockResolvedValueOnce(csv);

    const result = await realFetch('1234', '2026-09-28');

    expect(result.fetchStatus).toBe('no_row');
    expect(result.rawCsv).toBe(csv); // ページ自体の取得には成功しているので生CSVは保持
  });

  test('parses a quoted "-" (no gyakuhibu) row as ok with lendingFeeTotal effectively 0, and extracts minRateActual', async () => {
    const csv = `${CSV_HEADER}\n"1234","20260928","8000","500","3551.00","-","1","-","14.40","0.00","-","",""`;
    mockFetchTaisyakuCsv.mockResolvedValueOnce(csv);

    const result = await realFetch('1234', '2026-09-28');

    expect(result.fetchStatus).toBe('ok');
    expect(result.lendingFeeTotal).toBe(0); // parseTaisyakuCsvの仕様: perShareRateがnullならtotalAmount=0
    expect(result.maxRateActual).toBe(14.4);
    expect(result.minRateActual).toBe(0);
    expect(result.bidRank).toBeNull(); // '-' はnullに丸められる(blankToNull)
  });

  test('parses a real occurrence row with quoted numeric values and populates measures from restriction/emergencyMeasure', async () => {
    const csv = `${CSV_HEADER}\n"1234","20260928","8000","500","3551.00","0.60","1","2.19","14.40","0.00","F","注意銘柄","臨時"`;
    mockFetchTaisyakuCsv.mockResolvedValueOnce(csv);

    const result = await realFetch('1234', '2026-09-28');

    expect(result.fetchStatus).toBe('ok');
    expect(result.lendingFeeTotal).toBe(0.6); // unitShares=1で呼ぶので1株あたりの生値そのまま
    expect(result.days).toBe(1);
    expect(result.measures).toEqual(['注意銘柄', '臨時']);
  });

  test('sanity-checks against the real parseTaisyakuCsv (not the mock) to confirm the unitShares=1 convention', () => {
    const csv = `${CSV_HEADER}\n"1234","20260928","8000","500","3551.00","0.60","1","2.19","14.40","0.00","F","",""`;
    const point = realParse(csv, '2026-09-28', 1, '1234');
    expect(point?.totalAmount).toBe(0.6); // unitShares=1のときtotalAmount=perShareRateそのもの
  });
});

// -----------------------------------------------------------------------
// handler: 銘柄母集団の固定、multiplierActual/specialMultiplier判定、
// manifest.jsonが最後に書かれること、クロスチェック
// -----------------------------------------------------------------------
describe('handler', () => {
  const { handler } = require('../lambda/gyakuhibu-forecast-actuals/index') as {
    handler: (event: { rightsDate: string; fetchedLabel: string; prefix?: string }) => Promise<void>;
  };

  function s3Calls() {
    return mockS3Send.mock.calls.map(([cmd]) => cmd as { __type: string; Key?: string; Body?: string });
  }

  test('loads the fixed target population from the frozen Snapshot A forecast.json, not a fresh scan', async () => {
    mockS3Send.mockImplementationOnce(async () =>
      s3GetObjectStub(
        frozenForecastJsonBody([
          { ticker: '1111', companyName: 'A社', value: 1000, unitShares: 100, requiredShares: 100, closePrice: 1800, days: 1 },
        ]),
      ),
    );
    mockFetchTaisyakuCsv.mockResolvedValueOnce(
      '"銘柄コード","申込日","融資残高（株）","貸株残高（株）","貸借値段（円）","品貸料率（品貸日数分/円）","品貸日数","品貸料率（年率換算/％）","最高料率（品貸日数分/円）","最低料率（品貸日数分/円）","応札ランク","制限措置","臨時措置"\n"1111","20260928","100","50","1800.00","-","1","-","3.60","0.00","-","",""',
    );
    mockS3Send.mockResolvedValue({}); // 以降のput-objectは成功扱い

    await handler({ rightsDate: '2026-09-28', fetchedLabel: '2026-09-29T2000JST' });

    const getCall = mockS3Send.mock.calls[0][0] as { __type: string; Key: string };
    expect(getCall.__type).toBe('get');
    expect(getCall.Key).toBe('forecast-snapshots/rightsDate=2026-09-28/asof=2026-09-26T0000JST/run=run=1/forecast.json');

    const puts = s3Calls().filter((c) => c.__type === 'put');
    expect(puts).toHaveLength(3); // actuals.json, inputs/1111.csv, manifest.json
    expect(puts[0].Key).toBe('actuals/rightsDate=2026-09-28/fetchedAt=2026-09-29T2000JST/actuals.json');
    expect(puts[puts.length - 1].Key).toBe('actuals/rightsDate=2026-09-28/fetchedAt=2026-09-29T2000JST/manifest.json');
  });

  test('computes multiplierActual against the frozen closePrice/unitShares/days and flags specialMultiplier when it deviates from 4x', async () => {
    mockS3Send.mockImplementationOnce(async () =>
      s3GetObjectStub(
        frozenForecastJsonBody([
          { ticker: '1111', companyName: 'A社', value: 1000, unitShares: 100, requiredShares: 100, closePrice: 1800, days: 1 },
        ]),
      ),
    );
    // calcMaxRate(1800, 100) = 3.6 (投資単位180,000円→上限360円÷単元100株)。
    // 期待される4倍の最高料率 = 3.6 × 4 × 1日 = 14.4。ここでは8倍相当の28.8を実績として与える。
    mockFetchTaisyakuCsv.mockResolvedValueOnce(
      '"銘柄コード","申込日","融資残高（株）","貸株残高（株）","貸借値段（円）","品貸料率（品貸日数分/円）","品貸日数","品貸料率（年率換算/％）","最高料率（品貸日数分/円）","最低料率（品貸日数分/円）","応札ランク","制限措置","臨時措置"\n"1111","20260928","100","500","1800.00","10.00","1","-","28.80","5.00","F","","臨時"',
    );
    mockS3Send.mockResolvedValue({});

    await handler({ rightsDate: '2026-09-28', fetchedLabel: '2026-09-29T2000JST' });

    const actualsJsonBody = s3Calls().filter((c) => c.__type === 'put')[0].Body!;
    const parsed = JSON.parse(actualsJsonBody) as { records: Array<{ multiplierActual: number; specialMultiplier: boolean }> };
    expect(parsed.records[0].multiplierActual).toBeCloseTo(8, 5);
    expect(parsed.records[0].specialMultiplier).toBe(true);
  });

  test('flags a cross-check mismatch against the existing JQuantsGyakuhibuActual row', async () => {
    mockS3Send.mockImplementationOnce(async () =>
      s3GetObjectStub(
        frozenForecastJsonBody([
          { ticker: '1111', companyName: 'A社', value: 1000, unitShares: 100, requiredShares: 100, closePrice: 1800, days: 1 },
        ]),
      ),
    );
    mockFetchTaisyakuCsv.mockResolvedValueOnce(
      '"銘柄コード","申込日","融資残高（株）","貸株残高（株）","貸借値段（円）","品貸料率（品貸日数分/円）","品貸日数","品貸料率（年率換算/％）","最高料率（品貸日数分/円）","最低料率（品貸日数分/円）","応札ランク","制限措置","臨時措置"\n"1111","20260928","100","500","1800.00","0.60","1","2.19","14.40","0.00","F","",""',
    );
    mockDdbSend.mockResolvedValueOnce({ Item: { avgRate: 999 } }); // 明らかに食い違う既存値
    mockS3Send.mockResolvedValue({});

    await handler({ rightsDate: '2026-09-28', fetchedLabel: '2026-09-29T2000JST' });

    const manifestBody = s3Calls().filter((c) => c.__type === 'put').slice(-1)[0].Body!;
    const manifest = JSON.parse(manifestBody) as { crossCheckMismatches: Array<{ ticker: string }> };
    expect(manifest.crossCheckMismatches).toEqual([{ ticker: '1111', ours: 0.6, existing: 999 }]);
  });

  test('an unexpected exception from fetchTickerActualsInput is caught and treated as fetch_error rather than aborting the run', async () => {
    mockS3Send.mockImplementationOnce(async () =>
      s3GetObjectStub(
        frozenForecastJsonBody([
          { ticker: '1111', companyName: 'A社', value: 1000, unitShares: 100, requiredShares: 100, closePrice: 1800, days: 1 },
        ]),
      ),
    );
    mockFetchTaisyakuCsv.mockRejectedValueOnce(new Error('boom'));
    mockS3Send.mockResolvedValue({});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await handler({ rightsDate: '2026-09-28', fetchedLabel: '2026-09-29T2000JST' });
    } finally {
      errorSpy.mockRestore();
    }

    const actualsJsonBody = s3Calls().filter((c) => c.__type === 'put')[0].Body!;
    const parsed = JSON.parse(actualsJsonBody) as { records: Array<{ fetchStatus: string }> };
    expect(parsed.records[0].fetchStatus).toBe('fetch_error');
  });
});
```

Run: `npx jest test/gyakuhibu-forecast-actuals.test.ts`
Expected: PASS

- [ ] **Step 5: CDKに追加する**

`lib/j-quants-stack.ts`のTask 2(EventBridge Scheduler、旧計画)の定義の直後に追加する:

```ts
    const gyakuhibuForecastActualsFn = new nodejs.NodejsFunction(this, 'ForecastActualsFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'gyakuhibu-forecast-actuals', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(14),
      memorySize: 512,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        VALIDATION_BUCKET_NAME: this.gyakuhibuValidationBucket.bucketName,
        GYAKUHIBU_ACTUAL_TABLE_NAME: this.gyakuhibuActualTable.tableName,
      },
    });

    this.gyakuhibuActualTable.grantReadData(gyakuhibuForecastActualsFn);
    this.gyakuhibuValidationBucket.grantPut(gyakuhibuForecastActualsFn);
    this.gyakuhibuValidationBucket.grantRead(gyakuhibuForecastActualsFn);
```

CDKテスト(`test/j-quants.test.ts`)に、このLambdaが存在し上記のgrantを持つことを検証するテストを1つ追加する(既存の`gyakuhibu-forecast-validation`/`reference-api`のテストパターンに倣う)。

- [ ] **Step 6: テストを実行して確認、コミット**

Run: `npx jest test/gyakuhibu-forecast-actuals.test.ts test/j-quants.test.ts && npx tsc --noEmit`

```bash
git add lambda/gyakuhibu-forecast-actuals/ test/gyakuhibu-forecast-actuals.test.ts lib/j-quants-stack.ts test/j-quants.test.ts
git commit -m "Add the gyakuhibu forecast actuals-fetch Lambda"
```

- [ ] **Step 7(2026-10-02以降に実施): 再取得との差分確認**

design doc Task 4の照合要件「10/2の再取得との差分(ゼロであること)」を満たす。2回目(`fetchedLabel=2026-10-02T2000JST`)の実行後、2つの`actuals.json`をダウンロードして比較する:

```bash
BUCKET=jquantsstack-gyakuhibuvalidationbucketad82b892-brbbrft4t0du
aws s3api get-object --bucket "$BUCKET" --key "actuals/rightsDate=2026-09-28/fetchedAt=2026-09-29T2000JST/actuals.json" /tmp/actuals-first.json
aws s3api get-object --bucket "$BUCKET" --key "actuals/rightsDate=2026-09-28/fetchedAt=2026-10-02T2000JST/actuals.json" /tmp/actuals-second.json
diff <(node -e "console.log(JSON.stringify(require('/tmp/actuals-first.json').records, null, 2))") \
     <(node -e "console.log(JSON.stringify(require('/tmp/actuals-second.json').records, null, 2))")
```

差分が無いことを確認する。差分がある場合(確報の訂正等)、レポート(Task 4のevaluate-forecast.ts実行結果)にどちらのラベルを使ったかを明記し、2回目(より確定に近い)の値を優先する。

---

### Task 2: EventBridge Schedulerでの1回限りスケジュール(実績取得)

**Files:**
- Modify: `lib/j-quants-stack.ts`

**Interfaces:**
- Consumes: Task 1の`gyakuhibuForecastActualsFn`

- [ ] **Step 1: 実装する**

Task 1で追加した`gyakuhibuForecastActualsFn`の定義の直後に追加する(`scheduler`/`scheduler_targets`は既にimport済み — Task 2(旧、EventBridge Scheduler)参照):

```ts
    // 実績取得(1回目、2026-09-29 20:00 JST)。1回限りの実行。
    // scheduler.ScheduleExpression.at(date, timeZone)はdate.toISOString()の数字を
    // そのままat(...)リテラルに埋め込み、timeZoneは「その数字をどのタイムゾーンの
    // 現地時刻として解釈するか」を別途指定する仕組み(Task 3(旧)で実装・検証済み)。
    // 望む現地時刻の数字をそのままUTCとして書く('Z'サフィックス、'+09:00'は使わない)。
    new scheduler.Schedule(this, 'ForecastActualsFirstScheduler', {
      schedule: scheduler.ScheduleExpression.at(new Date('2026-09-29T20:00:00Z'), cdk.TimeZone.ASIA_TOKYO),
      target: new scheduler_targets.LambdaInvoke(gyakuhibuForecastActualsFn, {
        input: scheduler.ScheduleTargetInput.fromObject({
          rightsDate: '2026-09-28',
          fetchedLabel: '2026-09-29T2000JST',
        }),
      }),
    });

    // 実績再取得(確報修正・再現性の確認、2026-10-02 20:00 JST)。1回限りの実行。
    new scheduler.Schedule(this, 'ForecastActualsRefetchScheduler', {
      schedule: scheduler.ScheduleExpression.at(new Date('2026-10-02T20:00:00Z'), cdk.TimeZone.ASIA_TOKYO),
      target: new scheduler_targets.LambdaInvoke(gyakuhibuForecastActualsFn, {
        input: scheduler.ScheduleTargetInput.fromObject({
          rightsDate: '2026-09-28',
          fetchedLabel: '2026-10-02T2000JST',
        }),
      }),
    });
```

`test/j-quants.test.ts`に、この2つの`AWS::Scheduler::Schedule`リソースが正しい`ScheduleExpression`(`at(2026-09-29T20:00:00)`/`at(2026-10-02T20:00:00)`)・`ScheduleExpressionTimezone`(`Asia/Tokyo`)・`Target.Input`(それぞれの`fetchedLabel`)で存在することを確認するテストを1つ追加する。既存のスナップショット用スケジュールのテスト(`test/j-quants.test.ts`内、"schedules the two one-time"というテスト名)と同じ検証パターンに倣う。合計の`AWS::Scheduler::Schedule`リソース数が2から4に増えたことも確認する。

Task 2にはこれ以外のユニットテストは書かない(1回限りのCDK構成であり、CDK synthテストで存在確認できれば十分)。

- [ ] **Step 2: テストを実行して確認、コミット**

Run: `npx jest test/j-quants.test.ts && npx tsc --noEmit`

```bash
git add lib/j-quants-stack.ts test/j-quants.test.ts
git commit -m "Schedule the two actuals-fetch runs via EventBridge Scheduler"
```

- [ ] **Step 3: デプロイ(締切: 2026-09-29 20:00 JSTより前)**

```bash
APP_PASSWORD=xxxxx npx cdk deploy JQuantsStack --require-approval broadening
```

デプロイ後、`aws scheduler get-schedule --name <ForecastActualsFirstSchedulerの実際の名前>`でスケジュール時刻が意図通り(JST 20:00に対応するUTC 11:00)になっていることを確認する。

---

### Task 3: 評価指標の純粋関数 `scripts/lib/evaluation-metrics.ts`

**Files:**
- Create: `scripts/lib/evaluation-metrics.ts`
- Test: `test/evaluation-metrics.test.ts`

**Interfaces:**
- Consumes: なし(このタスクは純粋関数のみ。入力データの組み立てはTask 4が行う)
- Produces(Task 4が呼ぶ): 下記の`JoinedSample`型と各関数

- [ ] **Step 1: 型定義と分位点カバレッジ・pinball lossの失敗するテストを書く**

`test/evaluation-metrics.test.ts`:

```ts
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
} from '../scripts/lib/evaluation-metrics';

function sample(overrides: Partial<JoinedSample> = {}): JoinedSample {
  return {
    ticker: '1111',
    bin: '0〜0.5',
    fillP50: 0.1,
    fillP90: 0.6,
    fillRatioActual: 0.2,
    forecastStatusValue: 'safe',
    statusActual: 'safe',
    value: 1000,
    costActual: 100,
    maxGyakuhibu: 1000,
    excessGroup: 'excess',
    specialMultiplier: false,
    fetchStatus: 'ok',
    tickerSamplesForBaseline: [0.1, 0.3],
    poolSamplesForBaseline: [0.05, 0.2, 0.4],
    ...overrides,
  };
}

describe('quantileCoverage', () => {
  test('counts the fraction of samples where actual fill ratio is <= predicted p50/p90', () => {
    const samples = [
      sample({ fillP50: 0.1, fillP90: 0.6, fillRatioActual: 0.05 }), // <=both
      sample({ fillP50: 0.1, fillP90: 0.6, fillRatioActual: 0.3 }), // <=p90 only
      sample({ fillP50: 0.1, fillP90: 0.6, fillRatioActual: 0.9 }), // <=neither
    ];

    const result = quantileCoverage(samples);

    expect(result.p50Coverage).toBeCloseTo(1 / 3, 10);
    expect(result.p90Coverage).toBeCloseTo(2 / 3, 10);
  });

  test('throws on an empty sample array (caller must check min sample size first)', () => {
    expect(() => quantileCoverage([])).toThrow();
  });
});

describe('pinballLoss', () => {
  test('computes the average pinball loss for tau=0.5 (equal penalty both directions)', () => {
    // predicted=0.1, actual=0.2 (under-predicted, actual>predicted): loss = tau*(actual-predicted) = 0.5*0.1 = 0.05
    // predicted=0.1, actual=0.05 (over-predicted, actual<predicted): loss = (1-tau)*(predicted-actual) = 0.5*0.05 = 0.025
    const samples = [
      sample({ fillP50: 0.1, fillRatioActual: 0.2 }),
      sample({ fillP50: 0.1, fillRatioActual: 0.05 }),
    ];

    const result = pinballLoss(samples, 0.5, 'fillP50');

    expect(result).toBeCloseTo((0.05 + 0.025) / 2, 10);
  });

  test('computes the average pinball loss for tau=0.9 (asymmetric penalty)', () => {
    // predicted=0.6, actual=0.8: under-predicted, loss = 0.9*(0.8-0.6) = 0.18
    const samples = [sample({ fillP90: 0.6, fillRatioActual: 0.8 })];

    const result = pinballLoss(samples, 0.9, 'fillP90');

    expect(result).toBeCloseTo(0.18, 10);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx jest test/evaluation-metrics.test.ts`
Expected: FAIL(`scripts/lib/evaluation-metrics`が存在しない)

- [ ] **Step 3: `JoinedSample`型と分位点カバレッジ・pinball lossを実装する**

`scripts/lib/evaluation-metrics.ts`(冒頭部分):

```ts
// 逆日歩予測 精度検証(2026-09-28権利付き最終日)の評価指標。純粋関数のみ、I/O無し。
// 設計: docs/superpowers/specs/2026-09-24-gyakuhibu-forecast-validation-design.md Task 5

export type ForecastStatusValue = 'safe' | 'caution' | 'danger' | 'na';

// スナップショット(予測)1レコードと実績1レコードをticker単位でjoinした評価用サンプル。
// このjoinはTask 4(evaluate-forecast.ts)が組み立てる。
export interface JoinedSample {
  ticker: string;
  bin: string | null;
  fillP50: number | null;
  fillP90: number | null;
  fillRatioActual: number | null;
  forecastStatusValue: ForecastStatusValue;
  statusActual: ForecastStatusValue;
  value: number | null;
  costActual: number | null;
  maxGyakuhibu: number | null;
  excessGroup: 'excess' | 'no_excess' | null;
  specialMultiplier: boolean;
  fetchStatus: 'ok' | 'no_row' | 'fetch_error';
  // ベースライン(b)(a)算出用。forecast()の入力に使われた生のfillRatio配列
  // (Task 4がJQuantsGyakuhibuActual/JQuantsYutaiMasterを再スキャンして復元する)。
  tickerSamplesForBaseline: number[];
  poolSamplesForBaseline: number[];
}

function assertNonEmpty(samples: JoinedSample[], fnName: string): void {
  if (samples.length === 0) {
    throw new Error(`${fnName}: samples array must not be empty (caller must check min sample size first)`);
  }
}

export function quantileCoverage(samples: JoinedSample[]): { p50Coverage: number; p90Coverage: number } {
  assertNonEmpty(samples, 'quantileCoverage');
  let p50Count = 0;
  let p90Count = 0;
  for (const s of samples) {
    if (s.fillRatioActual === null || s.fillP50 === null || s.fillP90 === null) continue;
    if (s.fillRatioActual <= s.fillP50) p50Count++;
    if (s.fillRatioActual <= s.fillP90) p90Count++;
  }
  return { p50Coverage: p50Count / samples.length, p90Coverage: p90Count / samples.length };
}

// pinball loss(分位点損失)。tau=0.5ならMAEの半分に相当する対称版、tau=0.9なら
// 過小予測(実績>予測)側をより強く罰する非対称版になる。
export function pinballLoss(
  samples: JoinedSample[],
  tau: number,
  predictedField: 'fillP50' | 'fillP90',
): number {
  assertNonEmpty(samples, 'pinballLoss');
  let total = 0;
  let n = 0;
  for (const s of samples) {
    const predicted = s[predictedField];
    if (predicted === null || s.fillRatioActual === null) continue;
    const diff = s.fillRatioActual - predicted;
    total += diff >= 0 ? tau * diff : (tau - 1) * diff;
    n++;
  }
  if (n === 0) throw new Error('pinballLoss: no samples had both predicted and actual values');
  return total / n;
}
```

- [ ] **Step 4: テストを実行して確認**

Run: `npx jest test/evaluation-metrics.test.ts`
Expected: PASS(この時点までの2つのdescribeブロック)

- [ ] **Step 5: 混同行列・bin別内訳の失敗するテストを追加する**

`test/evaluation-metrics.test.ts`に追加:

```ts
describe('occurrenceConfusionMatrix', () => {
  test('classifies predicted-occurred (pOccur-derived, here via fillP50>0 as the proxy) vs actual-occurred (fillRatioActual>0)', () => {
    const samples = [
      sample({ fillP50: 0.1, fillRatioActual: 0.2 }), // predicted yes, actual yes -> TP
      sample({ fillP50: 0.1, fillRatioActual: 0 }), // predicted yes, actual no -> FP
      sample({ fillP50: 0, fillRatioActual: 0.1 }), // predicted no, actual yes -> FN
      sample({ fillP50: 0, fillRatioActual: 0 }), // predicted no, actual no -> TN
    ];

    const result = occurrenceConfusionMatrix(samples);

    expect(result).toEqual({ truePositive: 1, falsePositive: 1, falseNegative: 1, trueNegative: 1 });
  });
});

describe('occurrenceRateByBin', () => {
  test('groups by bin and reports predicted vs actual occurrence rate plus sample count', () => {
    const samples = [
      sample({ bin: '0〜0.5', fillP50: 0.1, fillRatioActual: 0.2 }),
      sample({ bin: '0〜0.5', fillP50: 0, fillRatioActual: 0 }),
      sample({ bin: '1〜2', fillP50: 0.3, fillRatioActual: 0 }),
    ];

    const result = occurrenceRateByBin(samples);

    expect(result['0〜0.5']).toEqual({ n: 2, predictedRate: 0.5, actualRate: 0.5 });
    expect(result['1〜2']).toEqual({ n: 1, predictedRate: 1, actualRate: 0 });
  });
});

describe('statusConfusionMatrix / safeMissList', () => {
  test('cross-tabulates predicted status x actual status', () => {
    const samples = [
      sample({ forecastStatusValue: 'safe', statusActual: 'safe' }),
      sample({ forecastStatusValue: 'safe', statusActual: 'danger' }),
      sample({ forecastStatusValue: 'danger', statusActual: 'danger' }),
    ];

    const matrix = statusConfusionMatrix(samples);

    expect(matrix.safe.safe).toBe(1);
    expect(matrix.safe.danger).toBe(1);
    expect(matrix.danger.danger).toBe(1);
  });

  test('safeMissList returns every sample predicted safe but realized as a loss (actual danger), in full (not truncated)', () => {
    const samples = [
      sample({ ticker: '1111', forecastStatusValue: 'safe', statusActual: 'safe' }),
      sample({ ticker: '2222', forecastStatusValue: 'safe', statusActual: 'danger' }),
      sample({ ticker: '3333', forecastStatusValue: 'safe', statusActual: 'danger' }),
    ];

    const misses = safeMissList(samples);

    expect(misses.map((m) => m.ticker)).toEqual(['2222', '3333']);
  });
});

describe('binBreakdown', () => {
  test('reports n/coverage/pinball loss per bin, skipping bins with zero samples', () => {
    const samples = [
      sample({ bin: '0〜0.5', fillP50: 0.1, fillP90: 0.6, fillRatioActual: 0.2 }),
      sample({ bin: '1〜2', fillP50: 0.2, fillP90: 0.7, fillRatioActual: 0.1 }),
    ];

    const result = binBreakdown(samples);

    expect(Object.keys(result).sort()).toEqual(['0〜0.5', '1〜2']);
    expect(result['0〜0.5'].n).toBe(1);
    expect(result['0〜0.5'].p50Coverage).toBe(0); // 0.2 > 0.1なのでカバーされない
  });
});
```

- [ ] **Step 6: 混同行列・bin別内訳を実装する**

`scripts/lib/evaluation-metrics.ts`に追加:

```ts
export function occurrenceConfusionMatrix(samples: JoinedSample[]): {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
} {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  for (const s of samples) {
    if (s.fillP50 === null || s.fillRatioActual === null) continue;
    const predictedOccurred = s.fillP50 > 0;
    const actualOccurred = s.fillRatioActual > 0;
    if (predictedOccurred && actualOccurred) truePositive++;
    else if (predictedOccurred && !actualOccurred) falsePositive++;
    else if (!predictedOccurred && actualOccurred) falseNegative++;
    else trueNegative++;
  }
  return { truePositive, falsePositive, falseNegative, trueNegative };
}

export function occurrenceRateByBin(
  samples: JoinedSample[],
): Record<string, { n: number; predictedRate: number; actualRate: number }> {
  const groups = new Map<string, JoinedSample[]>();
  for (const s of samples) {
    if (s.bin === null) continue;
    const list = groups.get(s.bin) ?? [];
    list.push(s);
    groups.set(s.bin, list);
  }
  const result: Record<string, { n: number; predictedRate: number; actualRate: number }> = {};
  for (const [bin, list] of groups) {
    const valid = list.filter((s) => s.fillP50 !== null && s.fillRatioActual !== null);
    const predictedOccurredCount = valid.filter((s) => s.fillP50! > 0).length;
    const actualOccurredCount = valid.filter((s) => s.fillRatioActual! > 0).length;
    result[bin] = {
      n: valid.length,
      predictedRate: valid.length > 0 ? predictedOccurredCount / valid.length : 0,
      actualRate: valid.length > 0 ? actualOccurredCount / valid.length : 0,
    };
  }
  return result;
}

export function statusConfusionMatrix(
  samples: JoinedSample[],
): Record<ForecastStatusValue, Record<ForecastStatusValue, number>> {
  const statuses: ForecastStatusValue[] = ['safe', 'caution', 'danger', 'na'];
  const matrix = Object.fromEntries(
    statuses.map((predicted) => [predicted, Object.fromEntries(statuses.map((actual) => [actual, 0]))]),
  ) as Record<ForecastStatusValue, Record<ForecastStatusValue, number>>;

  for (const s of samples) {
    matrix[s.forecastStatusValue][s.statusActual]++;
  }
  return matrix;
}

export function safeMissList(samples: JoinedSample[]): JoinedSample[] {
  return samples.filter((s) => s.forecastStatusValue === 'safe' && s.statusActual === 'danger');
}

export function binBreakdown(
  samples: JoinedSample[],
): Record<string, { n: number; p50Coverage: number; p90Coverage: number; pinballP50: number; pinballP90: number }> {
  const groups = new Map<string, JoinedSample[]>();
  for (const s of samples) {
    if (s.bin === null) continue;
    const list = groups.get(s.bin) ?? [];
    list.push(s);
    groups.set(s.bin, list);
  }

  const result: ReturnType<typeof binBreakdown> = {};
  for (const [bin, list] of groups) {
    const coverage = quantileCoverage(list);
    result[bin] = {
      n: list.length,
      p50Coverage: coverage.p50Coverage,
      p90Coverage: coverage.p90Coverage,
      pinballP50: pinballLoss(list, 0.5, 'fillP50'),
      pinballP90: pinballLoss(list, 0.9, 'fillP90'),
    };
  }
  return result;
}
```

- [ ] **Step 7: テストを実行して確認**

Run: `npx jest test/evaluation-metrics.test.ts`
Expected: PASS(この時点までの全describeブロック)

- [ ] **Step 8: ベースライン比較の失敗するテストを追加する**

`test/evaluation-metrics.test.ts`に追加:

```ts
describe('crossSnapshotComparison', () => {
  test('lists only tickers whose predicted status differs between snapshot A and B, and says which one matched the actual', () => {
    const samplesA = [
      sample({ ticker: '1111', forecastStatusValue: 'safe', statusActual: 'safe' }), // 一致、対象外
      sample({ ticker: '2222', forecastStatusValue: 'safe', statusActual: 'danger' }), // A=safe, B=dangerで食い違う予定
      sample({ ticker: '3333', forecastStatusValue: 'caution', statusActual: 'na' }), // Bに無い(対象外)
    ];
    const samplesB = [
      sample({ ticker: '1111', forecastStatusValue: 'safe', statusActual: 'safe' }),
      sample({ ticker: '2222', forecastStatusValue: 'danger', statusActual: 'danger' }),
    ];

    const result = crossSnapshotComparison(samplesA, samplesB);

    expect(result).toEqual([
      { ticker: '2222', statusA: 'safe', statusB: 'danger', statusActual: 'danger', whichMatched: 'B' },
    ]);
  });

  test('reports whichMatched as "A" when only snapshot A agrees with the actual, and "neither" when both disagree', () => {
    const samplesA = [
      // A=caution matches actual(caution), B=safeは食い違う -> whichMatched='A'
      sample({ ticker: '4444', forecastStatusValue: 'caution', statusActual: 'caution' }),
      // A=safe, B=cautionどちらも実績(danger)と食い違う -> whichMatched='neither'
      sample({ ticker: '5555', forecastStatusValue: 'safe', statusActual: 'danger' }),
    ];
    const samplesB = [
      sample({ ticker: '4444', forecastStatusValue: 'safe', statusActual: 'caution' }),
      sample({ ticker: '5555', forecastStatusValue: 'caution', statusActual: 'danger' }),
    ];

    const result = crossSnapshotComparison(samplesA, samplesB);

    expect(result.find((r) => r.ticker === '4444')!.whichMatched).toBe('A');
    expect(result.find((r) => r.ticker === '5555')!.whichMatched).toBe('neither');
  });
});

describe('populationBreakdown', () => {
  test('counts samples by why they were excluded from the primary population (no_excess/specialMultiplier/fetch failure), not just the primary count', () => {
    const samples = [
      sample({ excessGroup: 'excess', specialMultiplier: false, fetchStatus: 'ok' }), // 本命
      sample({ excessGroup: 'no_excess', specialMultiplier: false, fetchStatus: 'ok' }),
      sample({ excessGroup: 'excess', specialMultiplier: true, fetchStatus: 'ok' }),
      sample({ excessGroup: 'excess', specialMultiplier: false, fetchStatus: 'fetch_error' }),
      sample({ excessGroup: 'excess', specialMultiplier: false, fetchStatus: 'no_row' }),
    ];

    const result = populationBreakdown(samples);

    expect(result).toEqual({ total: 5, primary: 1, noExcess: 1, specialMultiplier: 1, fetchFailed: 2 });
  });
});

describe('baseline pinball losses', () => {
  test('poolOnlyPinballLoss computes p50/p90 from equal-weighted pool samples only (ignoring ticker samples)', () => {
    const samples = [
      sample({
        fillRatioActual: 0.3,
        poolSamplesForBaseline: [0.1, 0.2, 0.3, 0.4], // p50=0.2(reuses weightedQuantile ranking), p90=0.4
      }),
    ];

    const result = poolOnlyPinballLoss(samples, 0.5);

    // weightedQuantile([0.1,0.2,0.3,0.4], equal weights, 0.5) は累積0.5に達する2番目の値=0.2
    // pinball(tau=0.5, predicted=0.2, actual=0.3) = 0.5*(0.3-0.2) = 0.05
    expect(result).toBeCloseTo(0.05, 10);
  });

  test('tickerOnlyPinballLoss computes p50/p90 from equal-weighted ticker samples only (ignoring pool)', () => {
    const samples = [
      sample({ fillRatioActual: 0.5, tickerSamplesForBaseline: [0.1, 0.9] }),
    ];

    const result = tickerOnlyPinballLoss(samples, 0.5);

    // weightedQuantile([0.1,0.9], equal weights, 0.5)は累積0.5に達する1番目=0.1
    expect(result).toBeCloseTo(0.5 * (0.5 - 0.1), 10);
  });

  test('fullFillPinballLoss uses fillRatio=1.0 (充足率100%、最大逆日歩) as the constant baseline prediction', () => {
    const samples = [sample({ fillRatioActual: 0.3 })];

    const result = fullFillPinballLoss(samples, 0.5);

    // predicted=1.0 (definitely over-predicted since fillRatioActual<=1 always): (tau-1)*(1-0.3) = -0.5*0.7
    expect(result).toBeCloseTo(0.5 * (1 - 0.3), 10); // pinball lossは非負なので絶対値側の式を使う
  });

  test('baseline functions skip samples with an empty baseline array rather than crashing', () => {
    const samples = [sample({ poolSamplesForBaseline: [] })];

    expect(() => poolOnlyPinballLoss(samples, 0.5)).not.toThrow();
  });
});
```

- [ ] **Step 9: ベースライン比較を実装する**

`scripts/lib/evaluation-metrics.ts`の先頭に`weightedQuantile`のimportを追加し、末尾に実装を追加する:

```ts
import { weightedQuantile } from '../../lambda/shared/gyakuhibu-forecast';

function baselinePinballLoss(
  samples: JoinedSample[],
  tau: number,
  baselineField: 'tickerSamplesForBaseline' | 'poolSamplesForBaseline',
): number {
  let total = 0;
  let n = 0;
  for (const s of samples) {
    const values = s[baselineField];
    if (values.length === 0 || s.fillRatioActual === null) continue;
    const equalWeights = values.map(() => 1);
    const predicted = weightedQuantile(values, equalWeights, tau === 0.9 ? 0.9 : 0.5);
    const diff = s.fillRatioActual - predicted;
    total += diff >= 0 ? tau * diff : (tau - 1) * diff;
    n++;
  }
  if (n === 0) throw new Error('baselinePinballLoss: no samples had a non-empty baseline array');
  return total / n;
}

// ベースライン(a): プールのみ(縮小推定の銘柄側重みを常に0にした場合)。
export function poolOnlyPinballLoss(samples: JoinedSample[], tau: number): number {
  return baselinePinballLoss(samples, tau, 'poolSamplesForBaseline');
}

// ベースライン(b): 銘柄自身のみ(縮小推定のプール側重みを常に0にした場合)。
export function tickerOnlyPinballLoss(samples: JoinedSample[], tau: number): number {
  return baselinePinballLoss(samples, tau, 'tickerSamplesForBaseline');
}

// ベースライン(c): 充足率100%(最大逆日歩)を常に予測したとみなす定数ベースライン。
export function fullFillPinballLoss(samples: JoinedSample[], tau: number): number {
  assertNonEmpty(samples, 'fullFillPinballLoss');
  let total = 0;
  let n = 0;
  for (const s of samples) {
    if (s.fillRatioActual === null) continue;
    const diff = s.fillRatioActual - 1;
    total += diff >= 0 ? tau * diff : (tau - 1) * diff;
    n++;
  }
  if (n === 0) throw new Error('fullFillPinballLoss: no samples had an actual value');
  return total / n;
}
```

- [ ] **Step 10: スナップショット間比較・母集団内訳を実装する**

design doc Task 5の指標7(「スナップショット間の比較: 各指標の差分。statusが入れ替わった
銘柄の一覧と、どちらが正しかったか」)と、「`no_excess`群、特殊倍率群、取得失敗は件数だけ
別記する」を満たす。`scripts/lib/evaluation-metrics.ts`に追加:

```ts
export interface StatusFlip {
  ticker: string;
  statusA: ForecastStatusValue;
  statusB: ForecastStatusValue;
  statusActual: ForecastStatusValue;
  whichMatched: 'A' | 'B' | 'both' | 'neither';
}

// 2つのスナップショット(通常はA・B)で予測statusが食い違った銘柄だけを一覧化し、
// どちらが実績に近かったかを付記する。両スナップショットに存在する銘柄のみが対象
// (どちらか片方にしか無い銘柄は比較不能なので除外する)。
export function crossSnapshotComparison(samplesA: JoinedSample[], samplesB: JoinedSample[]): StatusFlip[] {
  const bByTicker = new Map(samplesB.map((s) => [s.ticker, s]));
  const flips: StatusFlip[] = [];

  for (const a of samplesA) {
    const b = bByTicker.get(a.ticker);
    if (!b) continue;
    if (a.forecastStatusValue === b.forecastStatusValue) continue;

    const aMatches = a.forecastStatusValue === a.statusActual;
    const bMatches = b.forecastStatusValue === b.statusActual;
    const whichMatched: StatusFlip['whichMatched'] =
      aMatches && bMatches ? 'both' : aMatches ? 'A' : bMatches ? 'B' : 'neither';

    flips.push({
      ticker: a.ticker,
      statusA: a.forecastStatusValue,
      statusB: b.forecastStatusValue,
      statusActual: a.statusActual,
      whichMatched,
    });
  }

  return flips;
}

// 本命集計から除外された理由別の件数。本命集計自体の件数(primary)も含めて返す。
export function populationBreakdown(samples: JoinedSample[]): {
  total: number;
  primary: number;
  noExcess: number;
  specialMultiplier: number;
  fetchFailed: number;
} {
  let primary = 0;
  let noExcess = 0;
  let specialMultiplier = 0;
  let fetchFailed = 0;

  for (const s of samples) {
    if (s.fetchStatus !== 'ok') {
      fetchFailed++;
    } else if (s.specialMultiplier) {
      specialMultiplier++;
    } else if (s.excessGroup === 'no_excess') {
      noExcess++;
    } else {
      primary++;
    }
  }

  return { total: samples.length, primary, noExcess, specialMultiplier, fetchFailed };
}
```

- [ ] **Step 11: テストを実行して確認、コミット**

Run: `npx jest test/evaluation-metrics.test.ts && npx tsc --noEmit`
Expected: 全テストPASS

```bash
git add scripts/lib/evaluation-metrics.ts test/evaluation-metrics.test.ts
git commit -m "Add pure evaluation-metric functions for the gyakuhibu forecast validation"
```

---

### Task 4: 評価スクリプト `scripts/evaluate-forecast.ts`

**Files:**
- Create: `scripts/lib/rebuild-baseline-samples.ts`
- Create: `scripts/evaluate-forecast.ts`
- Test: `test/rebuild-baseline-samples.test.ts`

**Interfaces:**
- Consumes: Task 3の`JoinedSample`型と全評価関数(`scripts/lib/evaluation-metrics.ts`)、既存の`toSample`・`binFor`(`lambda/shared/gyakuhibu-forecast.ts`、変更しない)、S3上のスナップショットA・B(`forecast-snapshots/...`)と実績(`actuals/...`、Task 1の成果物)
- Produces: `evaluations/rightsDate=2026-09-28/report.md`・`metrics.json`(S3の`GyakuhibuValidationBucket`と、リポジトリの`docs/superpowers/notes/`の両方に書く)

このスクリプトは**Lambdaではなく、ローカル/CI実行用のNode CLIスクリプト**(`npx ts-node scripts/evaluate-forecast.ts`)。Task 1の実績取得(2026-09-29 20:00 JST、または10/2の再取得)が完了した後に手動で実行する。認証はAWS CLIのデフォルト認証情報チェーン(`aws configure`済みの資格情報)を使う。

- [ ] **Step 1: ベースライン用の生サンプル復元ロジックの失敗するテストを書く**

`forecast()`(`lambda/shared/gyakuhibu-forecast.ts`)は縮小推定の重み付き結果しか返さず、ベースライン(a)(b)の計算に必要な「銘柄自身の生のfillRatio配列」「同じビンのプール全体の生のfillRatio配列」は凍結されたforecast.jsonに含まれない。そのため、Snapshot Aが実行された時点と同じロジック(`toSample`・`binFor`)でJQuantsGyakuhibuActual/JQuantsYutaiMasterを再スキャンし、ticker×binごとの生配列を復元する。

`test/rebuild-baseline-samples.test.ts`:

```ts
const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  ScanCommand: jest.fn((input: unknown) => input),
}));

import { rebuildBaselineSamples } from '../scripts/lib/rebuild-baseline-samples';

beforeEach(() => {
  mockDdbSend.mockReset();
});

test('rebuilds per-ticker raw fillRatio arrays and per-bin pool fillRatio arrays from JQuantsGyakuhibuActual/JQuantsYutaiMaster', async () => {
  mockDdbSend
    .mockResolvedValueOnce({
      // JQuantsYutaiMaster scan (unitSharesByTicker用)
      Items: [{ ticker: '1111', unitShares: 100 }],
    })
    .mockResolvedValueOnce({
      // JQuantsGyakuhibuActual scan
      Items: [
        {
          ticker: '1111',
          rightsDate: '2025-09-26',
          financingBalance: 100,
          lendingBalance: 500,
          avgRate: 1,
          days: 1,
          maxRateActual: 2,
          enriched: true,
        },
        {
          ticker: '9999',
          rightsDate: '2025-03-27',
          financingBalance: 100,
          lendingBalance: 500,
          avgRate: 1,
          days: 1,
          maxRateActual: 2,
          enriched: true,
        },
      ],
    });

  const result = await rebuildBaselineSamples('JQuantsYutaiMaster', 'JQuantsGyakuhibuActual');

  expect(result.tickerSamplesByTicker.get('1111')).toBeDefined();
  expect(result.tickerSamplesByTicker.get('1111')!.length).toBe(1);
  expect(result.allSamples.length).toBe(2); // 1111と9999、両方ともプール全体には含まれる
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx jest test/rebuild-baseline-samples.test.ts`
Expected: FAIL(`scripts/lib/rebuild-baseline-samples`が存在しない)

- [ ] **Step 3: 実装する**

`scripts/lib/rebuild-baseline-samples.ts`:

```ts
// 評価スクリプト用: forecast()が内部で使った生のfillRatioサンプル配列を、
// スナップショット実行時と同じスキャン+変換ロジック(toSample)で復元する。
// lambda/gyakuhibu-forecast-validation/index.tsのscanUnitSharesByTicker/
// scanAllGyakuhibuActualと同等の処理(重複コード、意図的。Task 2(旧)のindex.tsと
// 同じ判断)。lambda/shared/gyakuhibu-forecast.tsは変更しない。
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { toSample, type ForecastSample, type GyakuhibuActualRow } from '../../lambda/shared/gyakuhibu-forecast';

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

async function scanUnitSharesByTicker(tableName: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await ddbDocClient.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey: exclusiveStartKey }));
    for (const item of result.Items ?? []) {
      if (typeof item.ticker === 'string' && typeof item.unitShares === 'number') {
        map.set(item.ticker, item.unitShares);
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return map;
}

async function scanAllGyakuhibuActual(tableName: string): Promise<GyakuhibuActualRow[]> {
  const rows: GyakuhibuActualRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await ddbDocClient.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey: exclusiveStartKey }));
    for (const item of result.Items ?? []) {
      if (typeof item.ticker === 'string' && typeof item.rightsDate === 'string') {
        rows.push({
          ticker: item.ticker,
          rightsDate: item.rightsDate,
          financingBalance: typeof item.financingBalance === 'number' ? item.financingBalance : 0,
          lendingBalance: typeof item.lendingBalance === 'number' ? item.lendingBalance : 0,
          avgRate: typeof item.avgRate === 'number' ? item.avgRate : 0,
          days: typeof item.days === 'number' ? item.days : 0,
          maxRateActual: typeof item.maxRateActual === 'number' ? item.maxRateActual : null,
          restriction: typeof item.restriction === 'string' ? item.restriction : null,
          emergencyMeasure: typeof item.emergencyMeasure === 'string' ? item.emergencyMeasure : null,
          enriched: item.enriched === true,
          noGyakuhibu: item.noGyakuhibu === true ? true : undefined,
        });
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return rows;
}

export interface BaselineSamples {
  allSamples: ForecastSample[];
  tickerSamplesByTicker: Map<string, ForecastSample[]>;
}

export async function rebuildBaselineSamples(
  yutaiMasterTableName: string,
  gyakuhibuActualTableName: string,
): Promise<BaselineSamples> {
  const [unitSharesByTicker, actualRows] = await Promise.all([
    scanUnitSharesByTicker(yutaiMasterTableName),
    scanAllGyakuhibuActual(gyakuhibuActualTableName),
  ]);

  const allSamples = actualRows
    .map((row) => toSample(row, unitSharesByTicker.get(row.ticker) ?? 100))
    .filter((s): s is ForecastSample => s !== null);

  const tickerSamplesByTicker = new Map<string, ForecastSample[]>();
  for (const s of allSamples) {
    const list = tickerSamplesByTicker.get(s.ticker) ?? [];
    list.push(s);
    tickerSamplesByTicker.set(s.ticker, list);
  }

  return { allSamples, tickerSamplesByTicker };
}
```

- [ ] **Step 4: テストを実行して確認**

Run: `npx jest test/rebuild-baseline-samples.test.ts`
Expected: PASS

- [ ] **Step 5: 評価スクリプト本体を実装する**

`scripts/evaluate-forecast.ts`:

```ts
// 逆日歩予測 精度検証: S3上の凍結済みスナップショット(A・B)と実績を読み込み、
// 評価指標を計算してレポートを出力する。ローカル/CI実行用CLIスクリプト(Lambdaではない)。
// 実行例: npx ts-node scripts/evaluate-forecast.ts --actuals-label=2026-09-29T2000JST
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
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

function formatMetricsSection(label: string, allJoined: JoinedSample[], primary: JoinedSample[]): Record<string, unknown> {
  const breakdown = populationBreakdown(allJoined);
  if (primary.length === 0) {
    return { label, n: 0, populationBreakdown: breakdown, note: '本命集計が0件のため指標を計算できません' };
  }
  const samples = primary;
  return {
    label,
    n: samples.length,
    populationBreakdown: breakdown,
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
  metricsA: Record<string, unknown>,
  metricsB: Record<string, unknown>,
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
    new (await import('@aws-sdk/client-s3')).PutObjectCommand({
      Bucket: BUCKET,
      Key: `evaluations/rightsDate=${RIGHTS_DATE}/report.md`,
      Body: reportMarkdown,
      ContentType: 'text/markdown',
    }),
  );
  await s3Client.send(
    new (await import('@aws-sdk/client-s3')).PutObjectCommand({
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
```

- [ ] **Step 6: 型チェックを実行して確認、コミット**

Run: `npx tsc --noEmit`
Expected: クリーン

`scripts/evaluate-forecast.ts`自体はユニットテストを書かない(S3・DynamoDBへの実アクセスを組み合わせる統合的なCLIスクリプトのため、Task 3の純粋関数群とTask 4の`rebuild-baseline-samples.ts`が既にユニットテストされている)。9/29 20:00の実績取得後に実際に実行して動作確認する。

```bash
git add scripts/evaluate-forecast.ts scripts/lib/rebuild-baseline-samples.ts test/rebuild-baseline-samples.test.ts
git commit -m "Add the gyakuhibu forecast evaluation script"
```

---

### Task 5: 合格基準の凍結

**Files:**
- Create(ローカル一時ファイル、コミットしない): 合格基準JSON本体はS3にのみ保存する

**Interfaces:**
- Consumes: なし
- Produces: S3の`criteria/rightsDate=2026-09-28/validation-criteria.json`(Object Lockで保持)

- [ ] **Step 1: 合格基準の数値をユーザーに提示し、明示的な確認を得る**

design doc(`docs/superpowers/specs/2026-09-24-gyakuhibu-forecast-validation-design.md`)のTask 6は以下を「初期値」として提示している。**この値をそのまま凍結してよいか、ユーザーに必ず確認すること(過去の設計レビューで既に一度フラグ済みの要確認事項)。無断でこの値を最終としない。**

| 基準 | 初期値(本命集計) |
|---|---|
| P90カバレッジ | 80%以上、97%以下 |
| P50カバレッジ | 35%以上、65%以下 |
| safeの見逃し | safe予測のうち実績損失の割合が5%以下 |
| ベースライン優位 | P50・P90のpinball lossが、ベースライン(a)(b)の両方以下 |
| 最低サンプル数 | 本命集計が30銘柄未満なら「判定保留」 |

ユーザーが数値の変更を希望した場合は、その値に差し替える。確認が取れるまで次のStepに進まない。

- [ ] **Step 2: 確認が取れた数値で`validation-criteria.json`を作成し、S3にObject Lockで書き込む**

ユーザー確認後、以下の形式でファイルを作成する(数値はStep 1で確認した値に置き換える):

```json
{
  "rightsDate": "2026-09-28",
  "frozenAt": "<この時点のISO時刻>",
  "criteria": {
    "p90CoverageMin": 0.80,
    "p90CoverageMax": 0.97,
    "p50CoverageMin": 0.35,
    "p50CoverageMax": 0.65,
    "safeMissRateMax": 0.05,
    "mustBeatBaselines": ["poolOnly", "tickerOnly"],
    "minSampleSize": 30
  },
  "verdicts": ["pass", "fail", "inconclusive"]
}
```

書き込みコマンド(Task 1のバケット名・Task 1のIAM権限を使う。`GyakuhibuValidationBucket`は既にObject Lockのデフォルト保持が設定済みなので、通常の`put-object`だけで自動的にGovernanceモードの保持が付与される):

```bash
aws s3api put-object \
  --bucket jquantsstack-gyakuhibuvalidationbucketad82b892-brbbrft4t0du \
  --key "criteria/rightsDate=2026-09-28/validation-criteria.json" \
  --body <上記JSONを保存したローカルファイルパス> \
  --content-type application/json
```

- [ ] **Step 3: 書き込みを確認する**

```bash
aws s3api get-object --bucket jquantsstack-gyakuhibuvalidationbucketad82b892-brbbrft4t0du --key "criteria/rightsDate=2026-09-28/validation-criteria.json" /dev/stdout
aws s3api get-object-retention --bucket jquantsstack-gyakuhibuvalidationbucketad82b892-brbbrft4t0du --key "criteria/rightsDate=2026-09-28/validation-criteria.json"
```

`Mode: GOVERNANCE`の保持が付いていることを確認する。このタスクはコード変更を伴わないため、gitコミットは無い(SDDレジャーに完了を記録するのみ)。

---

## スコープ外(この計画では扱わない)

- design doc Task 7(walk-forwardバックテスト、10/2以降) — 別途、必要になった時点で計画する。
- 予測モデル自体の改善。
- 画面への検証結果の表示。
