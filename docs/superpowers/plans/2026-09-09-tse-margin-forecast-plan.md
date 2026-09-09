# 東証信用残ベースの逆日歩予測(現在需給ベース予測) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 東証信用残(J-Quants `margin-interest`/`margin-alert`)を入力とする「現在需給ベース予測」を既存の過去実績ベース予測と並列に表示し、信用残バッチを日次化し、CDKコンテキスト値1つでスタンダードプラン依存の処理・API応答・画面をまとめてON/OFFできるようにする。

**Architecture:** 既存の統計モデル(`lambda/shared/gyakuhibu-forecast.ts`の`buildPool`/`forecast`)を流用し、超過率の入力元だけを東証信用残スナップショットに差し替えた別プール(`_POOL_TSE_`、権利日までの日数で3バケット)を`gyakuhibu-forecast-batch`内の新モジュールで計算する。過去実績ベース予測からは`current-tse`フォールバックを外し、スタンダードプラン非依存にする。フラグ`tseMarginFeatures`は、CDKでスケジュール生成と環境変数を切り替え、APIが`features.tseMargin`と`tseForecast: null`で応答し、フロントがそれを見て列・カードを非表示にする。

**Tech Stack:** TypeScript / AWS CDK / Lambda(Node.js 22) / DynamoDB / Jest / React + Vite / @tanstack/react-table / @radix-ui/react-hover-card

## Global Constraints

- 設計書: `docs/superpowers/specs/2026-09-09-tse-margin-forecast-design.md`。バックテスト根拠: `docs/superpowers/notes/2026-09-09-tse-margin-balance-backtest.md`
- フラグ名はCDKコンテキスト `tseMarginFeatures`(既定`true`)、Lambda環境変数 `TSE_MARGIN_FEATURES_ENABLED`(`'true'`/`'false'`の文字列)、APIレスポンスの `features.tseMargin`(boolean)。CLI `-c tseMarginFeatures=false` は文字列 `"false"` で渡るため、CDK側は `value !== false && value !== 'false'` で判定する
- ラグバケットは `'0-7'`(0〜7日) / `'8-21'`(8〜21日) / `'22+'`(22日以上)、スナップショットの鮮度上限は21日(`SNAPSHOT_MAX_AGE_DAYS = 21`)、4週前比の基準は28日前
- スケジュール: `MarginBalanceBatchSchedule` = `cron(30 8 ? * MON-FRI *)`(JST平日17:30、フラグ有効時のみ生成)、`GyakuhibuForecastBatchSchedule` = `cron(40 10 * * ? *)`(JST 19:40、`GyakuhibuHistoryBatchSchedule`の`cron(0 10 * * ? *)`の後)
- `margin-balance-batch`は毎回「直近14日」を両エンドポイントで取得し、2年分の金曜バックフィルは UTC月曜 または環境変数 `FORCE_FULL_BACKFILL=true` のときのみ
- 東証由来のスナップショットは `source: 'weekly'`(`margin-interest`)と `'daily-alert'`(`margin-alert`)を同じ系列として扱い、同一日付は `daily-alert` を優先する
- DynamoDBへ書く数値は既存の `finiteOrNull` を通す(`excessRatio`、`lendingGrowth4w`、`_POOL_TSE_`の`lo`/`hi`)
- 過去実績ベース予測(`forecast`フィールド・`forecastStatus`・判定列・デフォルトソート)は変更しない。`scenario` は `'last-rights'` か `'none'` のみになる
- テストのモック呼び出し順は各タスクの本文に明記した順序に揃える(`mockResolvedValueOnce`のチェーンで検証している既存方針)
- フロントのnullガード・ソートは既存パターン(`x !== null ? … : '—'`、`sortingFn`でnullを最後尾)を踏襲する

---

### Task 1: 共有純粋関数とTseForecast型を追加する

**Files:**
- Modify: `lambda/shared/gyakuhibu-forecast.ts`
- Test: `test/gyakuhibu-forecast.test.ts`

**Interfaces:**
- Produces(Task 5が使う): `LagBucket`、`LAG_BUCKETS`、`SNAPSHOT_MAX_AGE_DAYS`、`MarginSnapshot`、`lagBucketFor(lagDays)`、`snapshotAtOrBefore(points, targetDate)`、`lendingGrowth4w(points, snapshotDate)`、`shiftIsoDate(iso, days)`、`TseForecast`

- [ ] **Step 1: 失敗するテストを書く**

`test/gyakuhibu-forecast.test.ts`の先頭importに `lagBucketFor, snapshotAtOrBefore, lendingGrowth4w, shiftIsoDate` を追加し、ファイル末尾に以下を追加する:

```ts
test('lagBucketFor splits at 7/8 and 21/22 days', () => {
  expect(lagBucketFor(0)).toBe('0-7');
  expect(lagBucketFor(7)).toBe('0-7');
  expect(lagBucketFor(8)).toBe('8-21');
  expect(lagBucketFor(21)).toBe('8-21');
  expect(lagBucketFor(22)).toBe('22+');
  expect(lagBucketFor(60)).toBe('22+');
});

test('shiftIsoDate moves an ISO date by calendar days across month boundaries', () => {
  expect(shiftIsoDate('2026-08-28', -28)).toBe('2026-07-31');
  expect(shiftIsoDate('2026-08-28', 4)).toBe('2026-09-01');
});

test('snapshotAtOrBefore returns the latest point on/before the target, ignoring points older than 21 days', () => {
  const points = [
    { date: '2026-08-07', financingBalance: 100, lendingBalance: 10 },
    { date: '2026-08-14', financingBalance: 100, lendingBalance: 20 },
    { date: '2026-08-28', financingBalance: 100, lendingBalance: 30 },
  ];
  expect(snapshotAtOrBefore(points, '2026-08-28')?.lendingBalance).toBe(30);
  expect(snapshotAtOrBefore(points, '2026-08-20')?.lendingBalance).toBe(20);
  expect(snapshotAtOrBefore(points, '2026-08-06')).toBeNull(); // 以前の点が無い
  expect(snapshotAtOrBefore(points, '2026-09-18')?.lendingBalance).toBe(30); // ちょうど21日前は有効
  expect(snapshotAtOrBefore(points, '2026-09-19')).toBeNull(); // 最新点(08-28)が22日前で鮮度切れ
});

test('lendingGrowth4w divides the current lending balance by the one 4 weeks earlier, null when the base is missing or 0', () => {
  const points = [
    { date: '2026-07-31', financingBalance: 100, lendingBalance: 10 },
    { date: '2026-08-28', financingBalance: 100, lendingBalance: 25 },
  ];
  expect(lendingGrowth4w(points, '2026-08-28')).toBeCloseTo(2.5);
  expect(lendingGrowth4w(points, '2026-07-31')).toBeNull(); // 4週前の点が無い
  expect(
    lendingGrowth4w([{ date: '2026-07-31', financingBalance: 100, lendingBalance: 0 }, points[1]], '2026-08-28'),
  ).toBeNull(); // 分母0
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx jest test/gyakuhibu-forecast.test.ts`
Expected: FAIL(`lagBucketFor`等がexportされていないためコンパイルエラー)

- [ ] **Step 3: 実装する**

`lambda/shared/gyakuhibu-forecast.ts`の `export const SHRINKAGE_K = 4;` の直後に以下を追加する:

```ts
// --- 東証信用残(J-Quants margin-interest / margin-alert)ベースの「現在需給」予測用 ---
// 設計: docs/superpowers/specs/2026-09-09-tse-margin-forecast-design.md

// スナップショット日→権利日の暦日数でキャリブレーションを分ける3バケット。
// バックテスト(docs/superpowers/notes/2026-09-09-tse-margin-balance-backtest.md)で、
// 東証で「融資超過」でも発生率が権利日直前36%→4週前54%と大きく変わることが分かったため。
export type LagBucket = '0-7' | '8-21' | '22+';
export const LAG_BUCKETS: ReadonlyArray<{ key: LagBucket; minLagDays: number }> = [
  { key: '0-7', minLagDays: 0 },
  { key: '8-21', minLagDays: 8 },
  { key: '22+', minLagDays: 22 },
];
// 基準日からこれより古いスナップショットは「鮮度切れ」として使わない(週次データの
// 取得漏れ1〜2回分までは許容し、それ以上古い残高で判断しないための上限)。
export const SNAPSHOT_MAX_AGE_DAYS = 21;

export interface MarginSnapshot {
  date: string;
  financingBalance: number;
  lendingBalance: number;
}

export function lagBucketFor(lagDays: number): LagBucket {
  if (lagDays <= 7) return '0-7';
  if (lagDays <= 21) return '8-21';
  return '22+';
}

// "YYYY-MM-DD"をdays日ずらす(UTCのミリ秒演算なので月またぎでも正しい)。
export function shiftIsoDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 日付昇順のpointsから、targetDate以前で最新の点を返す。ただし
// targetDate - SNAPSHOT_MAX_AGE_DAYS より古い点しか無ければ鮮度切れとしてnull。
export function snapshotAtOrBefore(points: MarginSnapshot[], targetDate: string): MarginSnapshot | null {
  let found: MarginSnapshot | null = null;
  for (const p of points) {
    if (p.date <= targetDate) found = p;
    else break;
  }
  if (found === null) return null;
  if (found.date < shiftIsoDate(targetDate, -SNAPSHOT_MAX_AGE_DAYS)) return null;
  return found;
}

// 貸株残の4週前比 = 直近スナップショットの貸株残 ÷ 28日前以前で最新の点の貸株残。
// 基準点が無い(鮮度切れ含む)、または基準点の貸株残が0ならnull。
export function lendingGrowth4w(points: MarginSnapshot[], snapshotDate: string): number | null {
  const current = snapshotAtOrBefore(points, snapshotDate);
  const base = snapshotAtOrBefore(points, shiftIsoDate(snapshotDate, -28));
  if (current === null || base === null || base.lendingBalance === 0) return null;
  return current.lendingBalance / base.lendingBalance;
}
```

さらに、`export interface ForecastResult { ... }` の直後に以下を追加する:

```ts
// 現在需給ベース予測の結果。ForecastResultのexcessRatio/binは東証スナップショット由来、
// scenarioは常に'current-tse'。
export interface TseForecast extends ForecastResult {
  snapshotDate: string;
  lagDays: number;
  lagBucket: LagBucket;
  financingBalance: number;
  lendingBalance: number;
  lendingGrowth4w: number | null;
}
```

`chooseScenario`の直上コメント(「3. 銘柄サンプルが1件も無ければ、東証信用残…」の行)の末尾に、次の1行を追加する:

```ts
// ※ 2026-09-09以降、過去実績ベース予測はtseLatestにnullを渡し('current-tse'を使わない)、
//    東証信用残は現在需給ベース予測(gyakuhibu-forecast-batch/tse-forecast.ts)側でのみ使う。
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx jest test/gyakuhibu-forecast.test.ts`
Expected: PASS(既存テスト含め全件)

- [ ] **Step 5: コミット**

```bash
git add lambda/shared/gyakuhibu-forecast.ts test/gyakuhibu-forecast.test.ts
git commit -m "Add lag-bucket, snapshot lookup, and growth helpers for TSE margin forecast"
```

---

### Task 2: CDKにtseMarginFeaturesフラグを追加し、スケジュールと環境変数を切り替える

**Files:**
- Modify: `lib/j-quants-stack.ts`
- Modify: `cdk.json`
- Test: `test/j-quants.test.ts`

**Interfaces:**
- Produces: Lambda環境変数 `TSE_MARGIN_FEATURES_ENABLED`(`gyakuhibu-forecast-batch`・`reference-api`。Task 5/6が読む)

- [ ] **Step 1: 既存テストの期待値を新スケジュールに更新し、フラグのテストを追加する**

`test/j-quants.test.ts`:

(a) 「creates the margin balance batch Lambda … on a weekly schedule」テストのタイトルを `on a weekday daily schedule` に変え、`ScheduleExpression: 'cron(30 9 ? * MON *)'` を `'cron(30 8 ? * MON-FRI *)'` に変更する。

(b) 「creates the gyakuhibu-forecast-batch Lambda …」テストの `Match.exact({...})` に `TSE_MARGIN_FEATURES_ENABLED: 'true',` を追加し、`ScheduleExpression: 'cron(40 9 * * ? *)'` を `'cron(40 10 * * ? *)'` に、直上コメントを `// GyakuhibuHistoryBatchSchedule(daily 10:00 UTC)の後、JST 19:40 = UTC 10:40。` に変更する。

(c) ファイル末尾に以下を追加する:

```ts
test('passes TSE_MARGIN_FEATURES_ENABLED=true to the reference API by default', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Environment: {
      Variables: Match.objectLike({
        GYAKUHIBU_FORECAST_TABLE_NAME: Match.anyValue(),
        WATCHLIST_TABLE_NAME: Match.anyValue(),
        TSE_MARGIN_FEATURES_ENABLED: 'true',
      }),
    },
  });
});

test('tseMarginFeatures=false drops the margin balance schedule and flips the env var to false', () => {
  const app = new cdk.App({ context: { tseMarginFeatures: false } });
  const template = Template.fromStack(new JQuantsStack(app, 'TestStack'));

  const rules = template.findResources('AWS::Events::Rule');
  const scheduleExpressions = Object.values(rules).map(
    (r) => (r as { Properties?: { ScheduleExpression?: string } }).Properties?.ScheduleExpression,
  );
  expect(scheduleExpressions).not.toContain('cron(30 8 ? * MON-FRI *)');
  expect(scheduleExpressions.filter(Boolean)).toHaveLength(6); // 既定の7つから信用残バッチ分が減る

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Environment: {
      Variables: Match.exact({
        YUTAI_MASTER_TABLE_NAME: Match.anyValue(),
        GYAKUHIBU_ACTUAL_TABLE_NAME: Match.anyValue(),
        MARGIN_BALANCE_TABLE_NAME: Match.anyValue(),
        GYAKUHIBU_FORECAST_TABLE_NAME: Match.anyValue(),
        TSE_MARGIN_FEATURES_ENABLED: 'false',
      }),
    },
  });
});

test('tseMarginFeatures passed as the string "false" (as the CLI -c flag does) is treated as disabled', () => {
  const app = new cdk.App({ context: { tseMarginFeatures: 'false' } });
  const template = Template.fromStack(new JQuantsStack(app, 'TestStack'));

  const rules = template.findResources('AWS::Events::Rule');
  const scheduleExpressions = Object.values(rules).map(
    (r) => (r as { Properties?: { ScheduleExpression?: string } }).Properties?.ScheduleExpression,
  );
  expect(scheduleExpressions.filter(Boolean)).toHaveLength(6);
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx jest test/j-quants.test.ts`
Expected: FAIL(スケジュール式・環境変数が未変更)

- [ ] **Step 3: 実装する**

`cdk.json` の `"context": {` の直後(最初のエントリとして)に以下を追加する:

```json
    "tseMarginFeatures": true,
```

`lib/j-quants-stack.ts`:

(a) `constructor` の `super(scope, id, props);` の直後に追加する:

```ts
    // スタンダードプラン依存機能(東証信用残の取得・現在需給ベース予測・信用残トレンド)の
    // 有効/無効。ライトプランへ落とす際は `cdk deploy -c tseMarginFeatures=false` の1回で、
    // 信用残バッチのスケジュール削除・APIのnull応答・画面非表示までまとめて切り替わる
    // (docs/superpowers/specs/2026-09-09-tse-margin-forecast-design.md)。CLIの-cは文字列で渡る。
    const tseMarginFeaturesContext = this.node.tryGetContext('tseMarginFeatures');
    const tseMarginFeatures = tseMarginFeaturesContext !== false && tseMarginFeaturesContext !== 'false';
```

(b) `MarginBalanceBatchSchedule` のブロック(コメント3行 + `new events.Rule(...)`)を以下に置き換える:

```ts
    // 信用残はJ-Quants側で毎営業日16:30頃に更新される(margin-alertは以前から日次、
    // margin-interestは2026-09-28から日次)。JST平日17:30 = UTC 08:30。
    // スタンダードプラン依存のため、tseMarginFeaturesが無効ならスケジュール自体を作らない
    // (Lambdaは残すので手動実行は可能)。
    if (tseMarginFeatures) {
      new events.Rule(this, 'MarginBalanceBatchSchedule', {
        schedule: events.Schedule.cron({ minute: '30', hour: '8', weekDay: 'MON-FRI' }),
        targets: [new targets.LambdaFunction(marginBalanceBatchFn)],
      });
    }
```

(c) `gyakuhibuForecastBatchFn` の `environment` に `TSE_MARGIN_FEATURES_ENABLED: String(tseMarginFeatures),` を追加し、そのスケジュールを以下に置き換える:

```ts
    // 逆日歩実績(GyakuhibuHistoryBatchSchedule: 毎日10:00 UTC)と信用残(MarginBalanceBatchSchedule:
    // 平日08:30 UTC)の後に実行する。JST 19:40 = UTC 10:40。
    new events.Rule(this, 'GyakuhibuForecastBatchSchedule', {
      schedule: events.Schedule.cron({ minute: '40', hour: '10' }),
      targets: [new targets.LambdaFunction(gyakuhibuForecastBatchFn)],
    });
```

(d) `referenceApiFn` の `environment` に `TSE_MARGIN_FEATURES_ENABLED: String(tseMarginFeatures),` を追加する。

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx jest test/j-quants.test.ts`
Expected: PASS(全件)

- [ ] **Step 5: コミット**

```bash
git add cdk.json lib/j-quants-stack.ts test/j-quants.test.ts
git commit -m "Add tseMarginFeatures flag, daily margin schedule, and later forecast schedule"
```

---

### Task 3: margin-balance-batchを日次ウィンドウ取得に変更する

**Files:**
- Modify: `lambda/margin-balance-batch/index.ts`
- Test: `test/margin-balance-batch.test.ts`

**Interfaces:**
- 変更なし(exportは`handler`のみ)。環境変数 `FORCE_FULL_BACKFILL`(`'true'`で2年分バックフィルを強制)を新設

- [ ] **Step 1: テストを更新・追加する**

`test/margin-balance-batch.test.ts`:

(a) 「queries every Friday within LOOKBACK_DAYS and fetches today once for daily-alert」テストを以下に置き換える:

```ts
test('fetches the last 14 days (newest first) from both endpoints and skips the full Friday backfill on a non-Monday', async () => {
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203' }] }); // yutai master scan
  mockFetchAllWeekly.mockResolvedValueOnce([
    { code: '7203', date: '2026-08-28', financingBalance: 1, lendingBalance: 1, source: 'weekly' },
  ]);

  await handler();

  // today=2026-08-28(金) -> 08-28, 08-27, ..., 08-15 の14日分。金曜は週次バックフィルの対象外(UTC月曜ではない)。
  const expectedDates = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 7, 28 - i));
    return d.toISOString().slice(0, 10);
  });
  expect(mockFetchAllWeekly.mock.calls.map(([date]) => date)).toEqual(expectedDates);
  expect(mockFetchAllDailyAlert.mock.calls.map(([date]) => date)).toEqual(expectedDates);
  expect(mockFetchAllWeekly).toHaveBeenCalledWith('2026-08-28', 'test-api-key');
  expect(mockFetchAllDailyAlert).toHaveBeenCalledWith('2026-08-28', 'test-api-key');
});

test('runs the 2-year Friday backfill (LOOKBACK_DAYS) after the recent window on UTC Mondays', async () => {
  jest.setSystemTime(new Date('2026-08-31T00:00:00Z')); // a Monday
  mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203' }] });
  mockFetchAllWeekly.mockResolvedValue([
    { code: '7203', date: '2026-08-28', financingBalance: 1, lendingBalance: 1, source: 'weekly' },
  ]);

  await handler();

  // 直近14日(08-31..08-18) + LOOKBACK_DAYS=14以内の金曜(08-28, 08-21)。
  const dates = mockFetchAllWeekly.mock.calls.map(([date]) => date);
  expect(dates).toHaveLength(16);
  expect(dates.slice(14)).toEqual(['2026-08-28', '2026-08-21']);
  expect(mockFetchAllDailyAlert).toHaveBeenCalledTimes(14);
});

test('runs the full Friday backfill on any day when FORCE_FULL_BACKFILL=true', async () => {
  process.env.FORCE_FULL_BACKFILL = 'true';
  try {
    mockSend.mockResolvedValueOnce({ Items: [{ ticker: '7203' }] });
    mockFetchAllWeekly.mockResolvedValue([
      { code: '7203', date: '2026-08-28', financingBalance: 1, lendingBalance: 1, source: 'weekly' },
    ]);

    await handler();

    // 直近14日 + 金曜(08-28, 08-21, 08-14)。
    expect(mockFetchAllWeekly).toHaveBeenCalledTimes(17);
  } finally {
    delete process.env.FORCE_FULL_BACKFILL;
  }
});
```

(b) 「throws when every weekly date and the daily-alert fetch fail」の期待メッセージを `'all 28 fetch/upsert calls failed'` に変更する(14日×2エンドポイント、金曜なのでバックフィル無し)。

(c) 「throws when every call succeeds but 0 tickers match across all dates」はそのまま(`'0 points matched'` を含む)。

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx jest test/margin-balance-batch.test.ts`
Expected: FAIL(現状は金曜3回+当日1回の呼び出し)

- [ ] **Step 3: 実装する**

`lambda/margin-balance-batch/index.ts`:

(a) `LOOKBACK_DAYS` の定義ブロックの直後に追加する:

```ts
// 毎回の実行で取得する直近ウィンドウ(暦日)。margin-alertは以前から日次、margin-interestは
// 2026-09-28から日次配信のため、平日毎日この範囲を両エンドポイントで取り直す(冪等upsert)。
// 取りこぼした日はこのウィンドウで自動的に埋まる。2026-09-28前のmargin-interestは金曜以外
// 空配列が返るだけで無害。
const RECENT_WINDOW_DAYS = 14;
```

(b) `listFridays` の直後に追加する:

```ts
// 今日からwindowDays日分の日付(新しい順)。
function listRecentDates(windowDays: number, now: number): string[] {
  const dates: string[] = [];
  for (let offset = 0; offset < windowDays; offset++) {
    dates.push(formatIsoDate(new Date(now - offset * 24 * 60 * 60 * 1000)));
  }
  return dates;
}

// 2年分の金曜バックフィルはAPI呼び出し数を抑えるため週1回(UTC月曜=JST月曜夕方の定期実行)のみ。
// 有効化直後などに手動で一括取得したい場合はFORCE_FULL_BACKFILL=trueで強制できる。
function shouldRunFullBackfill(now: number): boolean {
  if (process.env.FORCE_FULL_BACKFILL === 'true') return true;
  return new Date(now).getUTCDay() === 1;
}
```

(c) `export const handler` を以下に置き換える:

```ts
export const handler = async (): Promise<void> => {
  const tickers = await getYutaiTickers();
  if (tickers.length === 0) {
    console.warn('Yutai master is empty; nothing to fetch');
    return;
  }
  const targetTickers = new Set(tickers);

  const apiKey = await getApiKey(SECRET_ARN);
  const now = Date.now();

  let attempted = 0;
  let failed = 0;
  let upserted = 0;

  async function fetchAndUpsert(
    label: 'daily-alert' | 'margin-interest',
    date: string,
    fetcher: (date: string, apiKey: string) => Promise<MarginBalancePoint[]>,
  ): Promise<void> {
    attempted += 1;
    try {
      const points = await fetcher(date, apiKey);
      const matched = resolveTargetPoints(points, targetTickers);
      await batchUpsert(ddbDocClient, MARGIN_BALANCE_TABLE_NAME, toItems(matched));
      upserted += matched.size;
      console.log(`${date}: matched ${matched.size} of ${targetTickers.size} target tickers (${label})`);
    } catch (error) {
      failed += 1;
      console.error(`${date}: failed to fetch/upsert ${label} margin balances`, error);
    }
  }

  // 直近ウィンドウ(新しい日付から)。実行が遅延・打ち切りになった場合でも鮮度の高い
  // データが先に確保されるよう、過去分のバックフィルより先に処理する。
  for (const date of listRecentDates(RECENT_WINDOW_DAYS, now)) {
    await fetchAndUpsert('daily-alert', date, fetchAllDailyAlertBalancesForDate);
    await fetchAndUpsert('margin-interest', date, fetchAllWeeklyBalancesForDate);
  }

  const fullBackfill = shouldRunFullBackfill(now);
  if (fullBackfill) {
    for (const date of listFridays(LOOKBACK_DAYS, now)) {
      await fetchAndUpsert('margin-interest', date, fetchAllWeeklyBalancesForDate);
    }
  }

  console.log(
    `margin-balance-batch: ${attempted} fetch/upsert calls (${failed} failed), ${upserted} points upserted, fullBackfill=${fullBackfill} (of ${targetTickers.size} target tickers)`,
  );

  // 全呼び出しが失敗、または失敗ゼロなのに1件もマッチしなかった場合は、日付パラメータの
  // 意味やAPIキーなど構造的な問題を疑い、例外を投げてCloudWatch/EventBridgeにエラーとして
  // 見えるようにする(handlerが常にresolveすると、全滅していても実行は"成功"に見えてしまう)。
  if (failed === attempted) {
    throw new Error(`margin-balance-batch: all ${attempted} fetch/upsert calls failed`);
  }
  if (upserted === 0 && failed === 0) {
    throw new Error(
      `margin-balance-batch: 0 points matched across ${attempted} fetch/upsert calls despite no fetch failures (of ${targetTickers.size} target tickers)`,
    );
  }
};
```

(d) `lambda/margin-balance-batch/data-source.ts` の `fetchAllDailyAlertBalancesForDate` 直上コメントの「常にtodayの1日分のみ呼ばれる想定(履歴バックフィルはしない)。」を「直近14日の各日付で呼ばれる(index.tsのRECENT_WINDOW_DAYS)。」に修正する。同ファイルの`fetchAllWeeklyBalancesForDate`直上コメントの末尾に「保存時の`source: 'weekly'`は「margin-interest由来」の意味で、日次配信化後もこの値のまま。」を追加する。

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx jest test/margin-balance-batch.test.ts test/margin-balance-batch-data-source.test.ts`
Expected: PASS(全件)

- [ ] **Step 5: コミット**

```bash
git add lambda/margin-balance-batch/index.ts lambda/margin-balance-batch/data-source.ts test/margin-balance-batch.test.ts
git commit -m "Fetch a 14-day margin balance window daily; keep the 2-year Friday backfill weekly"
```

---

### Task 4: 過去実績ベース予測からcurrent-tseフォールバックを外す

**Files:**
- Modify: `lambda/gyakuhibu-forecast-batch/index.ts`
- Test: `test/gyakuhibu-forecast-batch.test.ts`

**Interfaces:**
- 変更なし(`handler`のみ)。`JQuantsGyakuhibuForecast`の銘柄行の`scenario`は`'last-rights'`|`'none'`のみになる

- [ ] **Step 1: テストのモック順を新しい呼び出し順に更新する**

`test/gyakuhibu-forecast-batch.test.ts`。呼び出し順は「master scan → actual scan → `_POOL_` put → 銘柄ごとのforecast put」になる(銘柄ごとのmargin balance queryが無くなる)。

(a) ファイル先頭の `process.env.GYAKUHIBU_FORECAST_TABLE_NAME = ...;` の直後に追加する(Task 5でTSEステップを個別テストごとに有効化するため、既定は無効):

```ts
process.env.TSE_MARGIN_FEATURES_ENABLED = 'false';
```

(b) 全テストから `// margin balance query` 系の `.mockResolvedValueOnce({ Items: [] })` 行を削除する(5箇所: 「writes the _POOL_ row…」「computes a forecast per ticker…」「writes a forecast row (with forecastStatus na)…」「marks tickers without maxGyakuhibu…」「every PutCommand Item survives…」)。

(c) 「continues with the next ticker when one ticker throws」を以下に置き換える(失敗の起点をmargin queryから1111のforecast putへ変更):

```ts
test('continues with the next ticker when one ticker throws', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await withFixedNow(async () => {
      mockSend
        .mockResolvedValueOnce({
          Items: [
            { ticker: '1111', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: 5000 },
            { ticker: '2222', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: 5000 },
          ],
        }) // yutai master scan
        .mockResolvedValueOnce({ Items: [] }) // gyakuhibu actual scan
        .mockResolvedValueOnce({}) // _POOL_ put
        .mockRejectedValueOnce(new Error('DynamoDB error')) // 1111のforecast putが失敗
        .mockResolvedValueOnce({}); // 2222のforecast put

      await handler();

      const tickerPuts = putCalls().filter((c) => (c[0] as { Item: { ticker: string } }).Item.ticker !== '_POOL_');
      expect(tickerPuts.map((c) => (c[0] as { Item: { ticker: string } }).Item.ticker)).toEqual(['1111', '2222']);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('1111'), expect.any(Error));
    });
  } finally {
    errorSpy.mockRestore();
  }
});
```

(d) 「writes the _POOL_ row before any ticker row」の直後に追加する:

```ts
test('does not fall back to current-tse: a ticker with no history gets scenario none and never queries the margin table', async () => {
  await withFixedNow(async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: 5000 }] }) // yutai master scan
      .mockResolvedValueOnce({ Items: [] }) // gyakuhibu actual scan (履歴なし)
      .mockResolvedValueOnce({}) // _POOL_ put
      .mockResolvedValueOnce({}); // 1234のforecast put

    await handler();

    const item = (putCalls()[1][0] as { Item: Record<string, unknown> }).Item;
    expect(item.scenario).toBe('none');
    expect(item.forecastStatus).toBe('na');
    // 銘柄ごとのQueryCommand(旧latestMarginBalance)は発行されない
    expect(mockSend.mock.calls.some(([cmd]) => 'KeyConditionExpression' in (cmd as Record<string, unknown>))).toBe(false);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx jest test/gyakuhibu-forecast-batch.test.ts`
Expected: FAIL(現状はmargin balance queryを発行するためモック順がずれる)

- [ ] **Step 3: 実装する**

`lambda/gyakuhibu-forecast-batch/index.ts`:

(a) import行 `import { DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';` から `QueryCommand` を外す。

(b) `const MARGIN_BALANCE_TABLE_NAME = ...;` の行と、`latestMarginBalance` 関数(コメント含む)を削除する。

(c) handler内の以下のブロック:

```ts
      const tickerSamples = samplesByTicker.get(row.ticker) ?? [];
      // scenario 'current-tse'用。呼び出し側で使うかどうかに関わらず毎回引く
      // (chooseScenarioが内部で要不要を判断する)。
      const tseLatest = await latestMarginBalance(row.ticker);
      const nextRightsMonth = Number(nextDate.slice(5, 7));
      const { scenario, excessRatio } = chooseScenario(tickerSamples, nextRightsMonth, tseLatest);
```

を以下に置き換える:

```ts
      const tickerSamples = samplesByTicker.get(row.ticker) ?? [];
      // 過去実績ベース予測は東証信用残(スタンダードプラン依存)を使わない。実績が無い銘柄は
      // 'none'(対象外)になり、現在需給ベース予測(tse-forecast.ts)側が補う。
      const nextRightsMonth = Number(nextDate.slice(5, 7));
      const { scenario, excessRatio } = chooseScenario(tickerSamples, nextRightsMonth, null);
```

(d) ファイル先頭コメントの「逆日歩実績履歴・信用残(直近値)を組み合わせ」を「逆日歩実績履歴を組み合わせ」に修正する。

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx jest test/gyakuhibu-forecast-batch.test.ts && npx tsc --noEmit`
Expected: PASS、型チェックも通る(未使用importが残っていないこと)

- [ ] **Step 5: コミット**

```bash
git add lambda/gyakuhibu-forecast-batch/index.ts test/gyakuhibu-forecast-batch.test.ts
git commit -m "Drop the miscalibrated current-tse fallback from the history-based forecast"
```

---

### Task 5: 現在需給ベース予測モジュールを追加し、フラグ有効時に_POOL_TSE_とtseForecastを書く

**Files:**
- Create: `lambda/gyakuhibu-forecast-batch/tse-forecast.ts`
- Modify: `lambda/gyakuhibu-forecast-batch/index.ts`
- Test: `test/gyakuhibu-forecast-batch.test.ts`

**Interfaces:**
- Consumes: Task 1の共有関数・型、Task 4後の`index.ts`
- Produces(Task 6が読む): `JQuantsGyakuhibuForecast`の `_POOL_TSE_` 行 `{ ticker: '_POOL_TSE_', buckets: { '0-7': PoolBin[], '8-21': PoolBin[], '22+': PoolBin[] }, computedAt }`、銘柄行の `tseForecast: TseForecast | null` 属性(フラグ無効時は属性自体を書かない)
- 呼び出し順(フラグ有効時): master scan → actual scan → **margin balance scan** → `_POOL_` put → **`_POOL_TSE_` put** → 銘柄ごとのforecast put

- [ ] **Step 1: 失敗するテストを書く**

`test/gyakuhibu-forecast-batch.test.ts` の末尾に追加する:

```ts
function withTseEnabled(fn: () => Promise<void>): Promise<void> {
  process.env.TSE_MARGIN_FEATURES_ENABLED = 'true';
  return fn().finally(() => {
    process.env.TSE_MARGIN_FEATURES_ENABLED = 'false';
  });
}

test('writes _POOL_TSE_ after _POOL_ and a tseForecast per ticker when the flag is on', async () => {
  await withTseEnabled(() =>
    withFixedNow(async () => {
      mockSend
        .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: 5000 }] }) // yutai master scan
        .mockResolvedValueOnce({
          Items: [
            {
              ticker: '1234', rightsDate: '2025-08-27', financingBalance: 100, lendingBalance: 250,
              avgRate: 10, days: 1, maxRateActual: 10, restriction: null, emergencyMeasure: null, enriched: true,
            },
          ],
        }) // gyakuhibu actual scan
        .mockResolvedValueOnce({
          Items: [
            { ticker: '1234', date: '2025-08-01', financingBalance: 100, lendingBalance: 250, source: 'weekly' }, // 権利日2025-08-27の26日前(バケット'22+'のサンプル用、超過率1.5)
            { ticker: '1234', date: '2026-07-03', financingBalance: 100, lendingBalance: 25, source: 'weekly' }, // 4週前比の基準
            { ticker: '1234', date: '2026-07-31', financingBalance: 100, lendingBalance: 50, source: 'weekly' }, // 直近(today=2026-08-01)
          ],
        }) // margin balance scan
        .mockResolvedValueOnce({}) // _POOL_ put
        .mockResolvedValueOnce({}) // _POOL_TSE_ put
        .mockResolvedValueOnce({}); // 1234のforecast put

      await handler();

      const puts = putCalls();
      expect(puts.map((c) => (c[0] as { Item: { ticker: string } }).Item.ticker)).toEqual(['_POOL_', '_POOL_TSE_', '1234']);

      const pool = (puts[1][0] as { Item: { buckets: Record<string, unknown[]> } }).Item;
      expect(Object.keys(pool.buckets).sort()).toEqual(['0-7', '22+', '8-21']);
      expect(pool.buckets['22+']).toHaveLength(6);

      const tse = (puts[2][0] as { Item: { tseForecast: Record<string, unknown> } }).Item.tseForecast;
      // 直近スナップショット2026-07-31 → 次回権利日2026-08-27 まで27日 → バケット'22+'。
      expect(tse.snapshotDate).toBe('2026-07-31');
      expect(tse.lagDays).toBe(27);
      expect(tse.lagBucket).toBe('22+');
      expect(tse.scenario).toBe('current-tse');
      // 超過率 (50-100)/100 = -0.5 → 融資超過ビン。プールに同ビンのサンプルは無く、自銘柄の
      // '22+'サンプル(2025-08-01時点の超過率1.5、充足率1)だけで w=1 → forecastP50 = 1×5000。
      expect(tse.bin).toBe('融資超過');
      expect(tse.forecastP50).toBe(5000);
      expect(tse.forecastStatus).toBe('danger'); // value 1000 <= P50 5000
      expect(tse.lendingGrowth4w).toBeCloseTo(2); // 50 / 25
    }),
  );
});

test('skips the TSE step entirely when the flag is off (no margin scan, no _POOL_TSE_, no tseForecast attribute)', async () => {
  await withFixedNow(async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: 5000 }] }) // yutai master scan
      .mockResolvedValueOnce({ Items: [] }) // gyakuhibu actual scan
      .mockResolvedValueOnce({}) // _POOL_ put
      .mockResolvedValueOnce({}); // 1234のforecast put

    await handler();

    const puts = putCalls();
    expect(puts).toHaveLength(2);
    const item = (puts[1][0] as { Item: Record<string, unknown> }).Item;
    expect('tseForecast' in item).toBe(false);
    // ScanCommandはmaster/actualの2回のみ(margin balance scanは無い)
    const scans = mockSend.mock.calls.filter(([cmd]) => !('Item' in (cmd as Record<string, unknown>)));
    expect(scans).toHaveLength(2);
  });
});

test('writes tseForecast: null when the ticker has no fresh margin snapshot', async () => {
  await withTseEnabled(() =>
    withFixedNow(async () => {
      mockSend
        .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: 5000 }] }) // yutai master scan
        .mockResolvedValueOnce({ Items: [] }) // gyakuhibu actual scan
        .mockResolvedValueOnce({
          Items: [{ ticker: '1234', date: '2026-06-01', financingBalance: 100, lendingBalance: 50, source: 'weekly' }], // 61日前 → 鮮度切れ
        }) // margin balance scan
        .mockResolvedValueOnce({}) // _POOL_ put
        .mockResolvedValueOnce({}) // _POOL_TSE_ put
        .mockResolvedValueOnce({}); // 1234のforecast put

      await handler();

      const item = (putCalls()[2][0] as { Item: Record<string, unknown> }).Item;
      expect(item.tseForecast).toBeNull();
    }),
  );
});

test('TSE items survive real DynamoDB marshalling when the current snapshot has financingBalance 0 (excessRatio Infinity)', async () => {
  await withTseEnabled(() =>
    withFixedNow(async () => {
      mockSend
        .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: 5000 }] }) // yutai master scan
        .mockResolvedValueOnce({ Items: [] }) // gyakuhibu actual scan
        .mockResolvedValueOnce({
          Items: [
            { ticker: '1234', date: '2026-07-03', financingBalance: 0, lendingBalance: 0, source: 'weekly' }, // 4週前比の分母0 → null
            { ticker: '1234', date: '2026-07-31', financingBalance: 0, lendingBalance: 250, source: 'weekly' }, // excessRatio = Infinity
          ],
        }) // margin balance scan
        .mockResolvedValueOnce({}) // _POOL_ put
        .mockResolvedValueOnce({}) // _POOL_TSE_ put
        .mockResolvedValueOnce({}); // 1234のforecast put

      await handler();

      for (const [cmd] of putCalls()) {
        const { Item } = cmd as { Item: Record<string, unknown> };
        expect(() => marshall(Item)).not.toThrow();
      }
      const tse = (putCalls()[2][0] as { Item: { tseForecast: Record<string, unknown> } }).Item.tseForecast;
      expect(tse.excessRatio).toBeNull(); // Infinity → null
      expect(tse.bin).toBe('5以上');
      expect(tse.lendingGrowth4w).toBeNull();
    }),
  );
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx jest test/gyakuhibu-forecast-batch.test.ts -t "TSE|tseForecast|flag is off"`
Expected: FAIL(`_POOL_TSE_`もtseForecastも書かれない)

- [ ] **Step 3: 新モジュールを作成する**

`lambda/gyakuhibu-forecast-batch/tse-forecast.ts`:

```ts
// 現在需給ベース予測: 東証信用残(JQuantsMarginBalance)のスナップショットから貸株超過率を求め、
// 既存の統計モデル(lambda/shared/gyakuhibu-forecast.ts)を「東証超過率でキャリブレーションした
// 別プール」で走らせる。スタンダードプラン依存のため、index.tsはTSE_MARGIN_FEATURES_ENABLEDが
// 'true'のときだけこのモジュールを呼ぶ。
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

// JQuantsMarginBalanceを全件スキャンし、ticker→日付昇順のスナップショット列にする。
// weekly(margin-interest)とdaily-alert(margin-alert)は同じ東証信用残として1系列に結合し、
// 同じ日付に両方ある場合はdaily-alert(日々公表)を優先する。
export async function scanMarginSnapshots(
  ddbDocClient: DynamoDBDocumentClient,
  tableName: string,
): Promise<Map<string, MarginSnapshot[]>> {
  const byTicker = new Map<string, Map<string, { snapshot: MarginSnapshot; source: string }>>();
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey: exclusiveStartKey }));
    for (const item of result.Items ?? []) {
      if (typeof item.ticker !== 'string' || typeof item.date !== 'string') continue;
      if (typeof item.financingBalance !== 'number' || typeof item.lendingBalance !== 'number') continue;
      const perDate = byTicker.get(item.ticker) ?? new Map<string, { snapshot: MarginSnapshot; source: string }>();
      const existing = perDate.get(item.date);
      if (!existing || item.source === 'daily-alert') {
        perDate.set(item.date, {
          snapshot: { date: item.date, financingBalance: item.financingBalance, lendingBalance: item.lendingBalance },
          source: String(item.source),
        });
      }
      byTicker.set(item.ticker, perDate);
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  const snapshots = new Map<string, MarginSnapshot[]>();
  for (const [ticker, perDate] of byTicker) {
    snapshots.set(
      ticker,
      [...perDate.values()].map((v) => v.snapshot).sort((a, b) => a.date.localeCompare(b.date)),
    );
  }
  return snapshots;
}

// 各学習サンプル(taisyaku.jp実績)に、バケットごとの東証超過率を付与する。バケットのサンプル側
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
```

- [ ] **Step 4: index.tsに組み込む**

`lambda/gyakuhibu-forecast-batch/index.ts`:

(a) importに以下を追加し、`MARGIN_BALANCE_TABLE_NAME` 定数を復活させる(`GYAKUHIBU_FORECAST_TABLE_NAME` の直前):

```ts
import { buildTsePools, buildTseSamples, computeTseForecast, scanMarginSnapshots, type TsePools } from './tse-forecast';
```

```ts
const MARGIN_BALANCE_TABLE_NAME = process.env.MARGIN_BALANCE_TABLE_NAME!;
```

(b) `finiteOrNull` の直後に追加する:

```ts
// スタンダードプラン依存の現在需給ベース予測を実行するか。テストで切り替えられるよう
// 呼び出しごとに環境変数を読む。
function tseMarginFeaturesEnabled(): boolean {
  return process.env.TSE_MARGIN_FEATURES_ENABLED === 'true';
}

function finitePools(pools: TsePools): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [bucket, bins] of Object.entries(pools)) {
    out[bucket] = bins.map((bin) => ({ ...bin, lo: finiteOrNull(bin.lo), hi: finiteOrNull(bin.hi) }));
  }
  return out;
}
```

(c) handler内、`const pool = buildPool(allSamples);` の直後(`computedAt`の前)に追加する:

```ts
  // 現在需給ベース予測(スタンダードプラン依存)。無効時は信用残テーブルに一切触れない。
  const tse = tseMarginFeaturesEnabled()
    ? await (async () => {
        const snapshots = await scanMarginSnapshots(ddbDocClient, MARGIN_BALANCE_TABLE_NAME);
        const bucketSamples = buildTseSamples(allSamples, snapshots);
        return { snapshots, bucketSamples, pools: buildTsePools(bucketSamples) };
      })()
    : null;
```

(d) `_POOL_` の `PutCommand` の直後に追加する:

```ts
  if (tse) {
    await ddbDocClient.send(
      new PutCommand({
        TableName: GYAKUHIBU_FORECAST_TABLE_NAME,
        Item: { ticker: '_POOL_TSE_', buckets: finitePools(tse.pools), computedAt },
      }),
    );
  }
```

(e) 銘柄ごとの `PutCommand` を以下に置き換える:

```ts
      const item: Record<string, unknown> = {
        ticker: row.ticker,
        rightsDate: nextDate,
        ...result,
        excessRatio: finiteOrNull(result.excessRatio),
        computedAt,
      };
      if (tse) {
        const tseForecast = computeTseForecast({
          ticker: row.ticker,
          today: computedAt,
          nextRightsDate: nextDate,
          snapshots: tse.snapshots,
          bucketSamples: tse.bucketSamples,
          maxGyakuhibu: row.maxGyakuhibu,
          value: row.value,
        });
        item.tseForecast = tseForecast
          ? {
              ...tseForecast,
              excessRatio: finiteOrNull(tseForecast.excessRatio),
              lendingGrowth4w: finiteOrNull(tseForecast.lendingGrowth4w),
            }
          : null;
      }

      await ddbDocClient.send(new PutCommand({ TableName: GYAKUHIBU_FORECAST_TABLE_NAME, Item: item }));
```

(f) ファイル先頭コメントに次の1行を追加する: `// フラグ(TSE_MARGIN_FEATURES_ENABLED)有効時は、東証信用残ベースの現在需給予測(tse-forecast.ts)も同じ行のtseForecast属性と_POOL_TSE_行へ書く。`

- [ ] **Step 5: テストを実行して成功を確認する**

Run: `npx jest test/gyakuhibu-forecast-batch.test.ts test/gyakuhibu-forecast.test.ts && npx tsc --noEmit`
Expected: PASS(全件)、型チェック通過

- [ ] **Step 6: コミット**

```bash
git add lambda/gyakuhibu-forecast-batch/tse-forecast.ts lambda/gyakuhibu-forecast-batch/index.ts test/gyakuhibu-forecast-batch.test.ts
git commit -m "Compute a TSE-calibrated current-supply forecast behind the tseMarginFeatures flag"
```

---

### Task 6: reference-apiにtseForecastとfeatures.tseMarginを追加する

**Files:**
- Modify: `lambda/reference-api/index.ts`
- Test: `test/reference-api.test.ts`

**Interfaces:**
- Consumes: Task 5のデータ形状、環境変数 `TSE_MARGIN_FEATURES_ENABLED`
- Produces(Task 7が使う): `/yutai/forecast` 一覧アイテムの `tseForecast`、レスポンス直下の `features: { tseMargin: boolean }`、`/yutai/{ticker}/forecast` の `tseForecast` と `features`

- [ ] **Step 1: 失敗するテストを書く**

`test/reference-api.test.ts`:

(a) `process.env.GYAKUHIBU_FORECAST_TABLE_NAME = ...;` の直後に追加する:

```ts
process.env.TSE_MARGIN_FEATURES_ENABLED = 'true';
```

(b) ファイル末尾に追加する:

```ts
const TSE_ROW = {
  ticker: '1234', rightsDate: '2026-08-27', scenario: 'last-rights', forecastStatus: 'safe', forecastP50: 100, forecastP90: 400,
  tickerSamples: 3, poolSamples: 400, computedAt: '2026-08-01',
  tseForecast: {
    scenario: 'current-tse', excessRatio: 1.5, bin: '1〜2', pOccur: 0.9, fillP50: 0.1, fillP90: 0.5, fillMean: 0.2,
    forecastP50: 500, forecastP90: 2500, forecastMean: 1000, expectedNet: 0, forecastStatus: 'caution',
    tickerSamples: 2, poolSamples: 150, snapshotDate: '2026-07-31', lagDays: 27, lagBucket: '22+',
    financingBalance: 100, lendingBalance: 250, lendingGrowth4w: 2,
  },
};

test('GET /yutai/forecast includes tseForecast and features.tseMargin=true when the flag is on', async () => {
  mockSend
    .mockResolvedValueOnce({
      Items: [{ ticker: '1234', companyName: 'A', content: 'A優待', value: 1000, unitShares: 100, rightsMonths: [8], riskStatus: 'safe', maxGyakuhibu: 5000 }],
    }) // yutai master scan
    .mockResolvedValueOnce({ Items: [{ ticker: '_POOL_', bins: [], computedAt: '2026-08-01' }, TSE_ROW] }); // forecast scan

  const result = await handler(makeEvent('GET /yutai/forecast', {}));

  const parsed = body(result) as { tickers: Array<{ tseForecast: Record<string, unknown> | null }>; features: { tseMargin: boolean } };
  expect(parsed.features).toEqual({ tseMargin: true });
  expect(parsed.tickers[0].tseForecast).toMatchObject({
    snapshotDate: '2026-07-31', lagDays: 27, lagBucket: '22+', bin: '1〜2', forecastP50: 500, forecastStatus: 'caution', lendingGrowth4w: 2,
  });
});

test('GET /yutai/forecast returns tseForecast: null for a ticker whose forecast row has no tseForecast', async () => {
  const { tseForecast: _omit, ...rowWithoutTse } = TSE_ROW;
  void _omit;
  mockSend
    .mockResolvedValueOnce({
      Items: [{ ticker: '1234', companyName: 'A', content: 'A優待', value: 1000, unitShares: 100, rightsMonths: [8], riskStatus: 'safe', maxGyakuhibu: 5000 }],
    })
    .mockResolvedValueOnce({ Items: [rowWithoutTse] });

  const result = await handler(makeEvent('GET /yutai/forecast', {}));

  const parsed = body(result) as { tickers: Array<Record<string, unknown>> };
  expect(parsed.tickers[0]).toHaveProperty('tseForecast', null);
});

test('GET /yutai/forecast nulls tseForecast and reports features.tseMargin=false when the flag is off', async () => {
  process.env.TSE_MARGIN_FEATURES_ENABLED = 'false';
  try {
    mockSend
      .mockResolvedValueOnce({
        Items: [{ ticker: '1234', companyName: 'A', content: 'A優待', value: 1000, unitShares: 100, rightsMonths: [8], riskStatus: 'safe', maxGyakuhibu: 5000 }],
      })
      .mockResolvedValueOnce({ Items: [TSE_ROW] });

    const result = await handler(makeEvent('GET /yutai/forecast', {}));

    const parsed = body(result) as { tickers: Array<Record<string, unknown>>; features: { tseMargin: boolean } };
    expect(parsed.features).toEqual({ tseMargin: false });
    expect(parsed.tickers[0]).toHaveProperty('tseForecast', null);
    expect(parsed.tickers[0]).toHaveProperty('forecast'); // 過去実績ベースは影響を受けない
  } finally {
    process.env.TSE_MARGIN_FEATURES_ENABLED = 'true';
  }
});

test('GET /yutai/{ticker}/forecast includes tseForecast and features', async () => {
  mockSend
    .mockResolvedValueOnce({
      Item: { ticker: '1234', companyName: 'A', content: 'A優待', value: 1000, unitShares: 100, rightsMonths: [8], riskStatus: 'safe', maxGyakuhibu: 5000 },
    }) // master get
    .mockResolvedValueOnce({ Item: TSE_ROW }) // forecast get
    .mockResolvedValueOnce({}) // _POOL_ get
    .mockResolvedValueOnce({ Items: [] }) // gyakuhibu actual query
    .mockResolvedValueOnce({ Items: [] }); // margin balance query

  const result = await handler(makeEvent('GET /yutai/{ticker}/forecast', { pathParameters: { ticker: '1234' } }));

  const parsed = body(result) as { tseForecast: Record<string, unknown> | null; features: { tseMargin: boolean } };
  expect(parsed.features).toEqual({ tseMargin: true });
  expect(parsed.tseForecast).toMatchObject({ snapshotDate: '2026-07-31', lagBucket: '22+', forecastP90: 2500 });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx jest test/reference-api.test.ts -t "tseForecast|features"`
Expected: FAIL(`features`・`tseForecast`が無い)

- [ ] **Step 3: 実装する**

`lambda/reference-api/index.ts`:

(a) `buildForecast` 関数の直後に追加する:

```ts
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
```

(b) `listYutaiForecast` の `items.push({...})` に `tseForecast: buildTseForecast(forecastByTicker.get(row.ticker)),` を `forecast,` の直後に追加し、最後の `jsonResponse(200, {...})` に `features: { tseMargin: tseMarginEnabled() },` を追加する。

(c) `getYutaiForecast` の `jsonResponse(200, {...})` に `tseForecast: buildTseForecast(forecastResult.Item),` を `forecast,` の直後に、`features: { tseMargin: tseMarginEnabled() },` を末尾に追加する。

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx jest test/reference-api.test.ts`
Expected: PASS(全件)

- [ ] **Step 5: コミット**

```bash
git add lambda/reference-api/index.ts test/reference-api.test.ts
git commit -m "Expose tseForecast and features.tseMargin on the forecast endpoints"
```

---

### Task 7: フロントエンドに現在需給の列・カードを追加し、フラグで表示を切り替える

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/pages/YutaiForecastListPage.tsx`
- Modify: `frontend/src/pages/YutaiForecastDetailPage.tsx`

**Interfaces:**
- Consumes: Task 6のレスポンス形状

- [ ] **Step 1: 型を追加する**

`frontend/src/api/types.ts` の `export interface YutaiForecast { ... }` の直後に追加する:

```ts
export type YutaiTseLagBucket = '0-7' | '8-21' | '22+';

// 東証信用残ベースの現在需給予測(スタンダードプラン依存)。APIはフラグ無効時にnullを返す。
export interface YutaiTseForecast extends YutaiForecast {
  snapshotDate: string;
  lagDays: number;
  lagBucket: YutaiTseLagBucket;
  financingBalance: number;
  lendingBalance: number;
  lendingGrowth4w: number | null;
}

export interface YutaiFeatures {
  tseMargin: boolean;
}
```

`YutaiForecastListItem` に `tseForecast: YutaiTseForecast | null;` を `forecast` の直後に、`YutaiForecastListResponse` に `features: YutaiFeatures;` を、`YutaiForecastDetail` に `tseForecast: YutaiTseForecast | null;`(`forecast`の直後)と `features: YutaiFeatures;`(末尾)を追加する。

- [ ] **Step 2: 一覧ページを変更する**

`frontend/src/pages/YutaiForecastListPage.tsx`:

(a) importの型を `import type { YutaiForecastListItem, YutaiForecastStatus, YutaiTseForecast } from '../api/types';` に変更する。

(b) `formatPercent` の直後に追加する:

```tsx
// lambda/shared/gyakuhibu-forecast.tsのBIN_EDGESと同じ6区分(順序=リスクの低い→高い)。
// 詳細ページと同じくファイル内複製。
const BIN_LABELS = ['融資超過', '0〜0.5', '0.5〜1', '1〜2', '2〜5', '5以上'] as const;

function binIndex(label: string | null): number {
  return label === null ? -1 : BIN_LABELS.indexOf(label as (typeof BIN_LABELS)[number]);
}

// 現在需給のビンが過去実績のビンより悪い(順序で後ろ)か、過去実績が対象外で現在需給だけ
// 予測できている場合にtrue。一覧の「想定逆日歩(現在需給)」に↑を付ける判定。
function tseWorseThanHistory(item: YutaiForecastListItem): boolean {
  const tse = item.tseForecast;
  if (!tse || tse.bin === null) return false;
  if (item.forecast.forecastStatus === 'na' || item.forecast.bin === null) return true;
  return binIndex(tse.bin) > binIndex(item.forecast.bin);
}

function formatGrowth(value: number | null): string {
  return value !== null ? `${value.toFixed(1)}倍` : '—';
}

// 想定逆日歩(現在需給)セルのホバー内容。
function TseCellHover({ tse, children }: { tse: YutaiTseForecast; children: React.ReactNode }) {
  const ratio = tse.excessRatio !== null && Number.isFinite(tse.excessRatio) ? tse.excessRatio.toFixed(2) : '—';
  return (
    <HoverCard.Root openDelay={0}>
      <HoverCard.Trigger asChild>
        <span tabIndex={0} className="gyakuhibu-hover">
          {children}
        </span>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content className="gyakuhibu-tooltip" side="bottom" sideOffset={8}>
          <div>東証信用残 {tse.snapshotDate} 時点(権利日{tse.lagDays}日前)</div>
          <div>貸株超過率: {ratio}(ビン: {tse.bin ?? '—'})</div>
          <div>発生確率: {formatPercent(tse.pOccur)}</div>
          <div>想定逆日歩(最悪): {tse.forecastP90 !== null ? formatFinancialYen(String(Math.round(tse.forecastP90))) : '—'}</div>
          <div>現在需給の判定: {FORECAST_STATUS_LABEL[tse.forecastStatus]}</div>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
```

`import { useEffect, useMemo, useState } from 'react';` を `import { useEffect, useMemo, useState, type ReactNode } from 'react';` に変え、上記の `React.ReactNode` は `ReactNode` にする。

(c) `const columns: ColumnDef<YutaiForecastListItem>[] = [ ... ];` を `function buildColumns(tseEnabled: boolean): ColumnDef<YutaiForecastListItem>[] { const columns: ColumnDef<YutaiForecastListItem>[] = [ ...既存の配列そのまま... ]; ... return columns; }` に変える。既存配列の直後(`return columns;`の前)に以下を入れる:

```tsx
  if (tseEnabled) {
    const insertAt = columns.findIndex((c) => c.id === 'pOccur');
    columns.splice(
      insertAt,
      0,
      {
        id: 'tseForecastP50',
        header: () => (
          <HeaderTooltip
            label="想定逆日歩(現在需給)"
            tooltip="直近の東証信用残(融資残・貸株残)から求めた貸株超過率をもとに、過去の類似ケースの分布から算出した逆日歩の目安。過去実績ベースよりリスクが高い区分に入っていれば↑。スタンダードプラン限定の情報です。"
          />
        ),
        accessorFn: (row) => row.tseForecast?.forecastP50 ?? null,
        sortDescFirst: true,
        sortingFn: (rowA, rowB) => {
          const a = rowA.original.tseForecast?.forecastP50 ?? null;
          const b = rowB.original.tseForecast?.forecastP50 ?? null;
          if (a === null && b === null) return 0;
          if (a === null) return 1;
          if (b === null) return -1;
          return a - b;
        },
        cell: ({ row }) => {
          const tse = row.original.tseForecast;
          if (!tse || tse.forecastP50 === null) return '—';
          return (
            <TseCellHover tse={tse}>
              {formatFinancialYen(String(Math.round(tse.forecastP50)))}
              {tseWorseThanHistory(row.original) ? ' ↑' : ''}
            </TseCellHover>
          );
        },
      },
      {
        id: 'lendingGrowth4w',
        header: () => (
          <HeaderTooltip
            label="貸株残(4週前比)"
            tooltip="直近の東証貸株残が4週間前の何倍か。権利日に向けた空売りの積み上がりペースで、3倍以上の急増は逆日歩発生の先行シグナルです。スタンダードプラン限定の情報です。"
          />
        ),
        accessorFn: (row) => row.tseForecast?.lendingGrowth4w ?? null,
        sortDescFirst: true,
        sortingFn: (rowA, rowB) => {
          const a = rowA.original.tseForecast?.lendingGrowth4w ?? null;
          const b = rowB.original.tseForecast?.lendingGrowth4w ?? null;
          if (a === null && b === null) return 0;
          if (a === null) return 1;
          if (b === null) return -1;
          return a - b;
        },
        cell: ({ row }) => formatGrowth(row.original.tseForecast?.lendingGrowth4w ?? null),
      },
    );
  }
```

(d) コンポーネント内の `useReactTable({ data: sortedTickers, columns, ... })` の直前に以下を追加し、`columns` はこの変数を渡す:

```tsx
  const tseEnabled = listState.data?.features.tseMargin ?? false;
  const columns = useMemo(() => buildColumns(tseEnabled), [tseEnabled]);
```

(e) セルのクラス判定(`cell.column.id === 'forecastP90'` の並び)に `cell.column.id === 'tseForecastP50' || cell.column.id === 'lendingGrowth4w' ||` を追加して右寄せ(`num`)にする。

- [ ] **Step 3: 詳細ページを変更する**

`frontend/src/pages/YutaiForecastDetailPage.tsx`:

(a) 「最大逆日歩(上限)」のカード(`<div className="card" style={{ marginTop: '0.75rem' }}> ... </div>`)の直後に追加する:

```tsx
      {data.features.tseMargin && data.tseForecast && (
        <>
          <div className="section-heading">
            現在需給ベース(東証信用残 {data.tseForecast.snapshotDate} 時点、権利日{data.tseForecast.lagDays}日前)
          </div>
          <div className="forecast-cards">
            <div className="card">
              <div className="summary-item__label">貸株超過率</div>
              <div className="summary-item__value">
                {data.tseForecast.excessRatio !== null && Number.isFinite(data.tseForecast.excessRatio)
                  ? data.tseForecast.excessRatio.toFixed(2)
                  : '∞'}
              </div>
            </div>
            <div className="card">
              <div className="summary-item__label">発生確率</div>
              <div className="summary-item__value">{formatPercent(data.tseForecast.pOccur)}</div>
            </div>
            <div className="card">
              <div className="summary-item__label">想定逆日歩</div>
              <div className="summary-item__value">
                {data.tseForecast.forecastP50 !== null ? formatFinancialYen(String(Math.round(data.tseForecast.forecastP50))) : '—'}
              </div>
            </div>
            <div className="card">
              <div className="summary-item__label">想定逆日歩(最悪)</div>
              <div className="summary-item__value">
                {data.tseForecast.forecastP90 !== null ? formatFinancialYen(String(Math.round(data.tseForecast.forecastP90))) : '—'}
              </div>
            </div>
            <div className="card">
              <div className="summary-item__label">貸株残(4週前比)</div>
              <div className="summary-item__value">
                {data.tseForecast.lendingGrowth4w !== null ? `${data.tseForecast.lendingGrowth4w.toFixed(1)}倍` : '—'}
              </div>
            </div>
            <div className="card">
              <div className="summary-item__label">現在需給の判定</div>
              <div className="summary-item__value">
                <span className={`risk-badge risk-badge--${data.tseForecast.forecastStatus}`}>
                  {FORECAST_STATUS_LABEL[data.tseForecast.forecastStatus]}
                </span>
              </div>
            </div>
          </div>
        </>
      )}
```

(b) `<div className="section-heading">信用残トレンド(過去1年)</div>` から、その直後のトレンド用 `{trendState.data && trendState.data.points.length > 0 && (...)}` ブロックの終わりまでを `{data.features.tseMargin && ( <> ... </> )}` で囲む(フラグ無効時はチャート自体を出さない)。

- [ ] **Step 4: 型チェックとビルド**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json && npm run build`
Expected: 両方エラー無し

- [ ] **Step 5: コミット**

```bash
git add frontend/src/api/types.ts frontend/src/pages/YutaiForecastListPage.tsx frontend/src/pages/YutaiForecastDetailPage.tsx
git commit -m "Show the TSE-based current-supply forecast and lending growth, gated by features.tseMargin"
```

---

### Task 8: READMEを更新する

**Files:**
- Modify: `README.md`

- [ ] **Step 1: バッチ一覧・スケジュール表を更新する**

(a) 冒頭のアーキテクチャ図で `MarginBalanceBatchFunction` の説明「信用残は本来週次更新のため週次で十分」を「毎営業日 JST17:30、直近14日分を取り直す(2026-09-28からmargin-interestも日次配信)。`tseMarginFeatures`無効時はスケジュール無し」に変更し、`GyakuhibuForecastBatchFunction` の「毎日 JST18:40」を「毎日 JST19:40」に変更する。

(b) スケジュール表の `MarginBalanceBatchFunction` 行を以下に置き換える:

```
| `MarginBalanceBatchFunction` | EventBridge(`cron(30 8 ? * MON-FRI *)` = JST平日 17:30、`tseMarginFeatures`有効時のみ) | `JQuantsYutaiMaster`の全銘柄の信用残(融資残・貸株残)を、直近14日分の各日付について`mkt-margin-int`/`mkt-margin-alert`両方から取得し`JQuantsMarginBalance`へupsert(冪等)。2年分の金曜バックフィルはUTC月曜、または環境変数`FORCE_FULL_BACKFILL=true`のときのみ。`source`は`weekly`(=margin-interest由来、日次配信化後も同じ値)と`daily-alert` |
```

(c) `GyakuhibuForecastBatchFunction` 行を以下に置き換える:

```
| `GyakuhibuForecastBatchFunction` | EventBridge(`cron(40 10 * * ? *)` = JST 19:40 毎日、逆日歩実績・信用残バッチの後) | `JQuantsYutaiMaster`・`JQuantsGyakuhibuActual`を読み、貸株超過率のビン別充足率分布から次回権利日の予測逆日歩(過去実績ベース)を算出し`JQuantsGyakuhibuForecast`へupsert。`TSE_MARGIN_FEATURES_ENABLED=true`のときは`JQuantsMarginBalance`も読み、東証信用残ベースの現在需給予測(`tseForecast`属性・`_POOL_TSE_`行)も併せて書く |
```

- [ ] **Step 2: 逆日歩予測の説明を更新する**

「逆日歩予測(貸株超過率→実績逆日歩、`/yutai/forecast`系)」段落の「次回権利日の超過率シナリオは「同銘柄・同月の直近実績」→「同銘柄の直近実績(月不問)」→「東証信用残(`JQuantsMarginBalance`)ベース、参考扱い」→「実績なし」の優先順で選ぶ。」を以下に置き換える:

```
次回権利日の超過率シナリオは「同銘柄・同月の直近実績」→「同銘柄の直近実績(月不問)」→「実績なし(対象外)」の優先順で選ぶ(2026-09-09に東証信用残フォールバックを撤去。東証超過率でtaisyaku.jp基準のビン表を引くとリスクを過小評価するため — `docs/superpowers/notes/2026-09-09-tse-margin-balance-backtest.md`)。
```

同段落の末尾に以下を追加する:

```
**現在需給ベース予測(東証信用残、スタンダードプラン依存)**: 上記とは別に、直近の東証信用残(`JQuantsMarginBalance`)から求めた貸株超過率で同じ統計モデルを走らせた予測を`tseForecast`として並列に持つ。プールは東証超過率で別途キャリブレーションし(`_POOL_TSE_`行)、スナップショット日→権利日の日数で`0-7`/`8-21`/`22+`日の3バケットに分ける(直前ほど予測力が高く、4週前では融資超過でも54%が発生するため)。貸株残の4週前比(`lendingGrowth4w`)も併せて保存する。一覧の「想定逆日歩(現在需給)」「貸株残(4週前比)」列と詳細の「現在需給ベース」カードに表示し、判定・デフォルトソートは過去実績ベースのまま。設計は`docs/superpowers/specs/2026-09-09-tse-margin-forecast-design.md`。
```

- [ ] **Step 3: フラグとダウングレード手順の節を追加する**

「デプロイ」の説明(`APP_PASSWORD=xxxxx npx cdk deploy` を含む節)の直後に以下を追加する:

```
### スタンダードプラン依存機能のON/OFF(`tseMarginFeatures`)

J-Quantsの`mkt-margin-int`/`mkt-margin-alert`はスタンダードプラン以上でしか使えない。これらに依存する機能(信用残バッチ・現在需給ベース予測・一覧の現在需給列・詳細の現在需給カードと信用残トレンド)はCDKコンテキスト値`tseMarginFeatures`(`cdk.json`で既定`true`)でまとめて切り替える。

ライトプラン等へ落とす場合:

```
APP_PASSWORD=xxxxx npx cdk deploy -c tseMarginFeatures=false
```

この1回で、`MarginBalanceBatchSchedule`が削除され(Lambdaは残る)、`GyakuhibuForecastBatchFunction`は現在需給予測をスキップし、`ReferenceApiFunction`は`features.tseMargin: false`と`tseForecast: null`を返し、フロントはそれを見て列・カード・信用残トレンドを非表示にする(フロントの再ビルドは不要)。テーブルとデータは残るので、`-c tseMarginFeatures=true`(または指定なし)で再デプロイすれば元に戻る。過去実績ベース予測(判定・想定逆日歩)はこのフラグの影響を受けない。
```

- [ ] **Step 4: 画面・API表を更新する**

(a) APIの `GET /yutai/forecast` 行の説明末尾に「各アイテムに`tseForecast`(現在需給ベース予測、フラグ無効時null)、レスポンスに`features.tseMargin`」を追加し、`GET /yutai/{ticker}/forecast` 行にも「`tseForecast`と`features`を含む」を追加する。

(b) 画面表の `/yutai/forecast` 行の説明末尾に「`features.tseMargin`が有効なら「想定逆日歩(現在需給)」(過去実績より悪化していれば↑)と「貸株残(4週前比)」の列を表示」を、`/yutai/:ticker/forecast` 行に「最大逆日歩カードの後に「現在需給ベース」カード群(フラグ有効かつ予測ありのとき)。信用残トレンドはフラグ有効時のみ」を追加する。

- [ ] **Step 5: コミット**

```bash
git add README.md
git commit -m "Document the daily margin batch, TSE-based forecast, and tseMarginFeatures flag"
```
