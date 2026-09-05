# 逆日歩予測 実装計画

設計書: `docs/superpowers/specs/2026-09-05-gyakuhibu-forecast-design.md`

既存の流儀(TDD・銘柄ごとtry/catch・純粋関数の切り出し・CDK合成テスト・READMEへの実機メモ)に従う。タスクは依存順。各タスクは1コミット。

---

## Task 0: taisyaku.jp CSVの残高列を実機で確認する(手動、コード変更なし)

**Files:** `docs/superpowers/notes/2026-09-05-taisyaku-csv-balance-columns.md`(新規)

- [ ] 既存の`fetchTaisyakuCsv`を1銘柄(9418、2026-08-20〜08-28)でローカル実行し、生CSVをファイルに保存する
- [ ] ヘッダー行の**正確な列名**を書き写す。特に「融資」「貸株」それぞれの「新規/返済/残高」列の名前、「差引残高」「貸借値段」「最高料率(品貸日数分/円)」「応札ランク」「制限措置」「臨時措置」
- [ ] 桁区切りカンマの有無(`"1,234,567"`)とクォートの有無を確認する
- [ ] 「差引残高」の符号を確認する(8/27の行で `貸株残高 - 融資残高` と比較)
- [ ] 結果をnotesに残す。Task 1のマーカー文字列とテストのCSV例はこの実物に合わせる

---

## Task 1: `parseTaisyakuCsv`の拡張(残高列・クォート対応・occurredフラグ)

**Files:**
- Modify: `lambda/gyakuhibu-history-batch/taisyaku-client.ts`
- Modify: `test/taisyaku-client.test.ts`

**Interfaces:**
```typescript
export interface GyakuhibuActualPoint {
  rightsDate: string;
  occurred: boolean;          // 品貸料率が'-'以外
  totalAmount: number;        // occurred=false なら 0
  days: number;               // occurred=false なら 0
  avgRate: number;            // occurred=false なら 0
  financingBalance: number;
  lendingBalance: number;
  lendingPrice: number | null;
  maxRateActual: number | null;   // 最高料率(品貸日数分/円)、倍率適用済み
  bidRank: string | null;
  restriction: string | null;
  emergencyMeasure: string | null;
}
export function splitCsvLine(line: string): string[];   // クォート内カンマを区切りにしない簡易パーサ
export function parseTaisyakuCsv(csv: string, rightsDate: string, unitShares: number, ticker?: string): GyakuhibuActualPoint | undefined;
```

- [ ] **Step 1: 失敗するテストを書く**(Task 0の実列名で置き換えること)

```typescript
const HEADER = '"申込日","融資残高","貸株残高","差引残高","貸借値段(円)","品貸料率(品貸日数分/円)","品貸日数","最高料率(品貸日数分/円)","応札ランク","制限措置","臨時措置"';

test('splitCsvLine keeps thousands separators inside quoted fields', () => {
  expect(splitCsvLine('"2026-08-27","1,234,567","2,000,000"')).toEqual(['2026-08-27', '1,234,567', '2,000,000']);
});

test('parseTaisyakuCsv returns balances and the actual max rate alongside the fee', () => {
  const csv = [HEADER, '"2026-08-27","75,000","195,000","-120,000","1,752.00","14.40","1","14.40","A","",""'].join('\n');
  expect(parseTaisyakuCsv(csv, '2026-08-27', 100)).toEqual({
    rightsDate: '2026-08-27', occurred: true, totalAmount: 1440, days: 1, avgRate: 14.4,
    financingBalance: 75000, lendingBalance: 195000, lendingPrice: 1752, maxRateActual: 14.4,
    bidRank: 'A', restriction: null, emergencyMeasure: null,
  });
});

test('parseTaisyakuCsv returns occurred=false with balances when the fee is a dash', () => {
  const csv = [HEADER, '"2026-08-27","75,000","60,000","15,000","1,752.00","-","1","3.60","","",""'].join('\n');
  const point = parseTaisyakuCsv(csv, '2026-08-27', 100);
  expect(point?.occurred).toBe(false);
  expect(point?.totalAmount).toBe(0);
  expect(point?.lendingBalance).toBe(60000);
  expect(point?.maxRateActual).toBe(3.6);
});

test('parseTaisyakuCsv still returns undefined when the rights date row is absent', () => { /* 既存テストを流用 */ });
```

既存の「品貸料率が`-`なら`undefined`」を期待するテストは**`occurred: false`を期待する形に書き換える**。

- [ ] **Step 2:** `npx jest test/taisyaku-client.test.ts` → FAIL を確認
- [ ] **Step 3: 実装**
  - `splitCsvLine`: 1文字ずつ走査し、`"`でinQuoteをトグル、inQuote外の`,`で分割。各フィールドは`stripQuotes`
  - 数値変換ヘルパー `toNumber(field): number | null`(カンマ除去→`Number`、空/`-`/NaNは`null`)
  - ヘッダー探索: `融資`と`残高`を両方含む列 / `貸株`と`残高`を両方含む列 / `貸借値段` / `最高料率` / `応札` / `制限` / `臨時`。`融資`・`貸株`の残高列が見つからなければ例外(ヘッダー変化に気づくため)
  - 権利日行が見つかったら残高2列が数値であることを必須にし、どちらかが`null`なら`undefined`を返して警告ログ
- [ ] **Step 4:** テスト PASS
- [ ] **Step 5:** `git commit -m "Extract balances, actual max rate and measures from the taisyaku CSV rights-date row"`

---

## Task 2: `gyakuhibu-history-batch`のバックフィル対応(enriched判定・列保存)

**Files:**
- Modify: `lambda/gyakuhibu-history-batch/index.ts`
- Modify: `test/gyakuhibu-history-batch.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

```typescript
test('re-fetches a rights date whose row exists but is not yet enriched', async () => {
  // master scan → 1銘柄、GetCommand → { Item: { ticker, rightsDate, totalAmount: 600, enriched: undefined } }
  // parseTaisyakuCsv → 拡張後のpoint
  // expect: fetchTaisyakuCsv が呼ばれ、PutCommand の Item に enriched: true と financingBalance が含まれる
});

test('stores noGyakuhibu:true together with balances when occurred is false', async () => {
  // parseTaisyakuCsv → { occurred: false, financingBalance: 75000, lendingBalance: 60000, ... }
  // expect: Item.noGyakuhibu === true && Item.enriched === true && Item.lendingBalance === 60000
});

test('skips a rights date that is already enriched', async () => {
  // GetCommand → { Item: { enriched: true } } → fetchTaisyakuCsv 未呼び出し
});
```

- [ ] **Step 2:** FAIL 確認
- [ ] **Step 3: 実装**
  - `alreadyFetched` を `isEnriched` にリネームする。判定は `result.Item?.enriched === true || (result.Item?.checkedAt !== undefined && result.Item.checkedAt >= todayMinus30Days)` の**どちらか**を満たせばスキップ(前者は残高まで取得済み、後者は「行は無い/欠損のままだが30日以内に確認済みなので今日はスキップ」)
  - `point === undefined` の分岐(行が無い)は従来どおり `noGyakuhibu: true` を書くが、**`enriched: true`は付けない**(残高が無いので学習に使えない)。代わりに `checkedAt: today` を書き、上記`isEnriched`の後者の条件で毎日の再取得を防ぐ
  - `point.occurred === false` → `{ ...balances, totalAmount: 0, days: 0, avgRate: 0, noGyakuhibu: true, enriched: true }`
  - `point.occurred === true` → `{ ...balances, totalAmount, days, avgRate, enriched: true }`
- [ ] **Step 4:** PASS
- [ ] **Step 5:** `git commit -m "Backfill balance columns into JQuantsGyakuhibuActual and skip only enriched rows"`
- [ ] **Step 6(デプロイ後の運用):** CDKの`MAX_GYAKUHIBU_FETCHES_PER_RUN`を一時的に`800`にしてデプロイ。CloudWatchで`enriched`の埋まり具合を見て、完了後`200`に戻す

---

## Task 3: 予測ロジックの純粋関数

**Files:**
- Create: `lambda/shared/gyakuhibu-forecast.ts`
- Create: `test/gyakuhibu-forecast.test.ts`

**Interfaces:**
```typescript
// JQuantsGyakuhibuActualの1行(Task 2で拡張済みのDynamoDB Item形状)。
// GyakuhibuActualPoint(CSVパース直後の型、ticker/enriched/noGyakuhibuを持たない)とは別物。
export interface GyakuhibuActualRow {
  ticker: string;
  rightsDate: string;
  financingBalance: number;
  lendingBalance: number;
  avgRate: number;
  days: number;
  maxRateActual: number | null;
  restriction: string | null;
  emergencyMeasure: string | null;
  enriched: boolean;
  noGyakuhibu?: boolean;
}
export interface ForecastSample { ticker: string; rightsDate: string; month: number; excessRatio: number | null; fillRatio: number; regulated: boolean; }
export interface PoolBin { label: string; lo: number; hi: number; n: number; pOccur: number; fillP50: number; fillP90: number; fillMean: number; }
export type ForecastStatus = 'safe' | 'caution' | 'danger' | 'na';
export type Scenario = 'last-rights' | 'current-tse' | 'none';
export interface ForecastResult {
  scenario: Scenario; excessRatio: number | null; bin: string | null;
  pOccur: number | null; fillP50: number | null; fillP90: number | null; fillMean: number | null;
  forecastP50: number | null; forecastP90: number | null; forecastMean: number | null; expectedNet: number | null;
  forecastStatus: ForecastStatus; tickerSamples: number; poolSamples: number;
}

export const BIN_EDGES: ReadonlyArray<{ label: string; lo: number; hi: number }>;   // 設計書の6ビン。hiはexclusive、最上位はInfinity
export const SHRINKAGE_K = 4;

export function excessRatio(financing: number, lending: number): number | null;
export function fillRatio(avgRate: number, days: number, maxRateActual: number | null): number | null;
export function toSample(row: GyakuhibuActualRow, unitShares: number): ForecastSample | null;  // enriched でない/maxRateActual 無しは null
export function binFor(ratio: number): { label: string; lo: number; hi: number };
export function buildPool(samples: ForecastSample[]): PoolBin[];
export function weightedQuantile(values: number[], weights: number[], q: number): number;
export function chooseScenario(tickerSamples: ForecastSample[], nextRightsMonth: number, tseLatest: { financingBalance: number; lendingBalance: number } | null): { scenario: Scenario; excessRatio: number | null };
export function forecast(args: { tickerSamples: ForecastSample[]; poolSamples: ForecastSample[]; scenario: Scenario; excessRatio: number | null; maxGyakuhibu: number | null; value: number; }): ForecastResult;
export function forecastStatus(value: number, p50: number, p90: number): ForecastStatus;
```

- [ ] **Step 1: 失敗するテストを書く**(要点のみ、境界値を必ず含める)

```typescript
test('excessRatio: positive when lending exceeds financing, Infinity when financing is 0 and lending > 0, null when both 0', () => {
  expect(excessRatio(100, 250)).toBeCloseTo(1.5);
  expect(excessRatio(100, 50)).toBeCloseTo(-0.5);
  expect(excessRatio(0, 10)).toBe(Infinity);
  expect(excessRatio(0, 0)).toBeNull();
});

test('fillRatio divides the total fee for the period by the actual max rate and clamps to [0,1]', () => {
  expect(fillRatio(14.4, 1, 14.4)).toBe(1);
  expect(fillRatio(0, 0, 3.6)).toBe(0);
  expect(fillRatio(2, 1, null)).toBeNull();
});

test('binFor uses exclusive upper edges', () => {
  expect(binFor(0.5).label).toBe('0.5〜1');
  expect(binFor(-0.01).label).toBe('融資超過');
  expect(binFor(Infinity).label).toBe('5以上');
});

test('buildPool counts zeros in the quantiles', () => {
  // 同一ビンに fill=[0,0,0,0.4,0.8] → pOccur 0.4, fillP50 0, fillP90 0.8(補間方式は実装に合わせて期待値を固定)
});

test('weightedQuantile reduces to the plain quantile with equal weights', () => { /* [1,2,3,4] q=0.5 → 2.5 等 */ });

test('forecast with no ticker samples equals the pool bin distribution', () => {
  // tickerSamples=[] → fillP50/fillP90 が buildPool の該当ビンと一致
});

test('forecast with 4 ticker samples weights ticker and pool equally (K=4)', () => {
  // tickerSamples全て fill=1、pool全て fill=0 → fillMean ≈ 0.5
});

test('forecast with an empty pool bin falls back to ticker samples only', () => { /* poolSamplesにそのビンが無い → 銘柄分布と一致 */ });

test('chooseScenario prefers the latest same-month rights date, then the latest rights date, then TSE, then none', () => { /* 4ケース */ });

test('forecastStatus boundaries: value == p90 is caution, value == p50 is danger', () => {
  expect(forecastStatus(5000, 1000, 4000)).toBe('safe');
  expect(forecastStatus(4000, 1000, 4000)).toBe('caution');
  expect(forecastStatus(1000, 1000, 4000)).toBe('danger');
});

test('forecast returns na when maxGyakuhibu is null or there are no samples at all', () => { /* 2ケース */ });
```

- [ ] **Step 2:** FAIL 確認
- [ ] **Step 3: 実装**
  - `weightedQuantile`: 値でソートし累積重み(合計1に正規化)が`q`以上になる最初の値を返す(補間しない。テスト期待値もこの方式で固定)
  - `forecast`: `w = n_t / (n_t + K)`、片方が0なら`w`を0/1に倒す。`fillMean`は加重平均
  - `expectedNet = value - forecastMean`
- [ ] **Step 4:** PASS
- [ ] **Step 5:** `git commit -m "Add pure gyakuhibu forecast logic (pool bins, shrinkage blend, scenarios, status)"`

---

## Task 4: `gyakuhibu-forecast-batch` Lambda + CDK配線

**Files:**
- Create: `lambda/gyakuhibu-forecast-batch/index.ts`
- Create: `test/gyakuhibu-forecast-batch.test.ts`
- Modify: `lib/j-quants-stack.ts`
- Modify: `test/j-quants.test.ts`

**環境変数:** `YUTAI_MASTER_TABLE_NAME`, `GYAKUHIBU_ACTUAL_TABLE_NAME`, `MARGIN_BALANCE_TABLE_NAME`, `GYAKUHIBU_FORECAST_TABLE_NAME`

- [ ] **Step 1: 失敗するテストを書く**

```typescript
test('writes the _POOL_ row before any ticker row', async () => { /* PutCommand の呼び出し順を検証 */ });
test('computes a forecast per ticker using its own rights history and the pool', async () => { /* 1銘柄、Item に forecastStatus/forecastP90 が入る */ });
test('continues with the next ticker when one ticker throws', async () => { /* 既存バッチと同じパターン */ });
test('marks tickers without maxGyakuhibu as na', async () => {});
```

- [ ] **Step 2:** FAIL 確認
- [ ] **Step 3: 実装**

```
handler:
  master = scanYutaiMaster()                       // ticker, value, unitShares, rightsMonths, maxGyakuhibu
  actualRows = scanAll(GYAKUHIBU_ACTUAL)           // enriched のみ toSample
  samplesByTicker = groupBy(ticker)
  pool = buildPool(allSamples)
  put(_POOL_, { bins: pool, computedAt })
  for row of master (try/catch):
    nextDate = nextRightsDate(row.rightsMonths)      // lambda/shared/trading-calendar.tsの既存関数(引数はrightsMonthsのみ、内部でカレンダーをキャッシュ計算する)
    tseLatest = query MarginBalance (Limit 1, desc)   // scenario 'current-tse' 用
    { scenario, excessRatio } = chooseScenario(samplesByTicker[t] ?? [], month(nextDate), tseLatest)
    poolSamples = excessRatio == null ? [] : allSamples.filter(in binFor(excessRatio))
    result = forecast({ tickerSamples, poolSamples, scenario, excessRatio, maxGyakuhibu: row.maxGyakuhibu, value: row.value })
    put(ticker, { rightsDate: nextDate, ...result, computedAt })
```

  `JQuantsGyakuhibuActual`の全件スキャンは数千行なので1回のScanでよい(ページングは既存`scanYutaiMaster`と同じdo-while)。

- [ ] **Step 4:** PASS
- [ ] **Step 5: CDK** — `JQuantsGyakuhibuForecast`テーブル(PK `ticker`、`RemovalPolicy.RETAIN`+PITR、オンデマンド。他の全テーブルと同じ方針。`JQuantsWatchlistTable`のコメント同様、毎日全件再計算される派生データでRETAIN必須ではないが運用を揃える)、Lambda、`events.Schedule.cron({ minute: '40', hour: '9' })`(JST 18:40。このファイルの他のスケジュールと同じオブジェクト形式)、権限(master read / actual read / margin read / forecast write)。`test/j-quants.test.ts`に合成テストを追加
- [ ] **Step 6:** `npx jest` 全体 PASS、`APP_PASSWORD=dummy-for-synth npx cdk synth JQuantsStack > /dev/null`
- [ ] **Step 7:** `git commit -m "Add gyakuhibu-forecast-batch and JQuantsGyakuhibuForecast table"`

---

## Task 5: API `GET /yutai/forecast`, `GET /yutai/{ticker}/forecast`

**Files:**
- Modify: `lambda/reference-api/index.ts`
- Modify: `lib/j-quants-stack.ts`
- Modify: `test/reference-api.test.ts`, `test/j-quants.test.ts`

- [ ] **Step 1: 失敗するテストを書く**
  - `GET /yutai/forecast` が master と forecast を ticker で結合し、`forecastStatus` フィルタが効く
  - `GET /yutai/{ticker}/forecast` が `history`(noGyakuhibu 行を含む、`excessRatio`/`fillRatio` 付き)と `poolBins` を返す
  - forecast 行が無い銘柄は `forecast.forecastStatus === 'na'`
- [ ] **Step 2:** FAIL 確認
- [ ] **Step 3: 実装**
  - `listYutai`のフィルタ部分(`rightsDateFrom/To`, `keyword`)を関数に切り出して共用する
  - `listYutaiForecast`: `scanYutaiMaster` + `scanForecastTable` → Mapで結合。`forecastStatus`フィルタ。`_POOL_`行の`computedAt`を`poolComputedAt`として返す
  - `getYutaiForecast`: master Get + forecast Get + `_POOL_` Get + actual Query(全期間) + margin Query(Limit 1)。`history`は`toSample`と同じ式で`excessRatio`/`fillRatio`を付け、`occurred = !noGyakuhibu`
  - switch文に2ルート追加。`GET /yutai/forecast`は`GET /yutai/{ticker}`より**前**に置く必要はない(routeKeyが違う)が、可読性のため隣接させる
- [ ] **Step 4:** PASS
- [ ] **Step 5: CDK** — `addRoutes` 2本、`routeKeys`配列に追加。forecast テーブルの read 権限を`referenceApiFn`に付与、環境変数追加
- [ ] **Step 6:** `git commit -m "Add GET /yutai/forecast and GET /yutai/{ticker}/forecast"`

---

## Task 6: フロントAPI型・クライアント

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/client.ts`

- [ ] `YutaiForecastStatus`, `YutaiForecast`, `YutaiForecastListItem`, `YutaiForecastListResponse`, `YutaiForecastHistoryPoint`, `PoolBin`, `YutaiForecastDetail` を追加(設計書のJSONそのまま)
- [ ] `fetchYutaiForecastList(params: YutaiListParams & { forecastStatus?: ... })`, `fetchYutaiForecastDetail(ticker)` を追加
- [ ] `git commit -m "Add forecast API types and client functions"`

---

## Task 7: `/yutai/forecast` 一覧画面

**Files:**
- Create: `frontend/src/pages/YutaiForecastListPage.tsx`
- Modify: `frontend/src/main.tsx`, `frontend/src/components/Layout.tsx`, `frontend/src/index.css`

- [ ] `YutaiListPage.tsx`の権利日範囲・キーワード・デバウンス・バナー部分を丸ごと流用(共通化は2画面目なので**まだしない**。3画面目が出たら切り出す)
- [ ] 列定義: 銘柄 / 優待内容 / 優待価値 / 権利日 / 最大逆日歩 / 発生確率(`%`) / 予測中央値 / 予測P90 / 判定 / 根拠(`銘柄n件＋市場m件`、`current-tse`なら`参考`バッジ)
- [ ] デフォルトソート: 判定ランク(danger 0, caution 1, safe 2, na 3)→ `expectedNet` 昇順
- [ ] CSS: `.risk-badge--caution`(黄系)、`.basis-badge`(小さな灰バッジ)
- [ ] ルート `yutai/forecast` を **`yutai/:ticker` より前**に登録(react-routerは静的セグメントを優先するが、順序を明示しておく)。ナビに `{ to: '/yutai/forecast', label: '逆日歩予測' }`
- [ ] 手動確認: 当月で絞られる、判定フィルタ、行クリックで`/yutai/:ticker/forecast`(Task 8まではNot Foundでよい)
- [ ] `git commit -m "Add /yutai/forecast list page with predicted gyakuhibu columns"`

---

## Task 8: `/yutai/:ticker/forecast` 詳細画面 + 既存詳細からのリンク

**Files:**
- Create: `frontend/src/pages/YutaiForecastDetailPage.tsx`
- Modify: `frontend/src/pages/YutaiDetailPage.tsx`(リンク1行)
- Modify: `frontend/src/main.tsx`, `frontend/src/index.css`

- [ ] **サマリカード4枚**(`.forecast-cards` grid、モバイル2列): 発生確率 / 予測中央値 / 予測P90 / 優待価値−P90。下段に最大逆日歩・判定バッジ・シナリオ文言(`前回同月(2025-09-26)の超過率 1.6 を採用` / `東証信用残ベース(参考)` / `実績なし`)
- [ ] **曲線グラフ**(recharts `ComposedChart`): x=ビン(カテゴリ軸、6ビン)、`Bar`=発生確率(左軸)、`Line`=fillP50・fillP90(右軸、0〜1)。同銘柄の`history`を`Scatter`で重ねる(x=その権利日のビン、y=fillRatio、赤)。採用ビンに`ReferenceArea`で薄い背景
- [ ] **過去権利日テーブル**: 権利日 / 融資残 / 貸株残 / 超過株数 / 超過率 / 実績逆日歩 / 上限(`maxRateActual×unitShares`) / 充足率 / 応札 / 規制。`occurred=false`の行は灰色文字
- [ ] **感度表**: `poolBins`から採用ビンの前後1つずつ(端なら片側2つ)を取り、各ビンで`forecastP50 = fillP50×maxGyakuhibu`等を画面側で計算して表示。ただし銘柄実績のブレンドは画面では再現しないので「市場プールのみの値」と注記
- [ ] **信用残トレンド**: `fetchYutaiMarginTrend`を再利用し、`history`の各`rightsDate`に`ReferenceLine`
- [ ] `YutaiDetailPage.tsx`の「逆日歩リスク計算」カード見出し右に `<Link to={`/yutai/${ticker}/forecast`}>予測を見る →</Link>`
- [ ] 手動確認: 予測未計算銘柄で「予測計算中」、実績0件銘柄で曲線がプールのみ、9418で過去8/27の行が充足率1.0
- [ ] `git commit -m "Add /yutai/:ticker/forecast detail page and link it from the yutai detail page"`

---

## Task 9: README・notes更新

**Files:** `README.md`, `docs/superpowers/notes/2026-09-05-taisyaku-csv-balance-columns.md`(Task 0で作成済み、実装後の追記)

- [ ] アーキテクチャ図に`GyakuhibuForecastBatchFunction`を追加(JST 18:40)
- [ ] テーブル一覧に`JQuantsGyakuhibuForecast`、`JQuantsGyakuhibuActual`の追加列を記載
- [ ] Lambda一覧・API一覧・フロント画面一覧に追加
- [ ] 「予測ロジック」節: ビン定義・縮小推定(K=4)・シナリオ・判定式を設計書から要約。「最高料率は自前計算ではなくCSVの実値(倍率適用済み)を分母にする」ことを明記
- [ ] 実機メモ: バックフィルに要した日数、ビン別サンプル数の実測、`MAX_GYAKUHIBU_FETCHES_PER_RUN`を戻したこと
- [ ] `git commit -m "Document the gyakuhibu forecast feature"`

---

## デプロイ順序と確認

1. Task 1〜2 をデプロイ(`MAX_GYAKUHIBU_FETCHES_PER_RUN=800`)。数日待ち、`JQuantsGyakuhibuActual`の`enriched`行が増えるのを確認
2. Task 3〜5 をデプロイ。`GyakuhibuForecastBatchFunction`を手動invokeし、`_POOL_`行の`bins[].n`を確認(極端に偏るビンがあれば`BIN_EDGES`を調整してTask 3のテストも更新)
3. Task 6〜8 をデプロイ。9418・トヨタ(7203、常に0円)・直近の高逆日歩銘柄で画面を目視
4. バックフィル完了後、`MAX_GYAKUHIBU_FETCHES_PER_RUN`を200に戻す

## Self-Review Notes

- 設計書の全セクション(データ列追加・バックフィル・純粋関数・バッチ・API・2画面・既存画面へのリンク・README)に対応するタスクがある
- Task 1のテストCSV例は**Task 0で確認した実列名に置き換える前提**。列名が違えばマーカー文字列(`融資`+`残高`等)だけでなくテストも直す
- 既存`GET /yutai/{ticker}`の`rightsHistory`(noGyakuhibu除外)と新`history`(含む)の違いは意図的。既存ツールチップの挙動を変えないため
- `_POOL_`という特殊キーは`scanForecastTable`で除外し、一覧に紛れ込まないようにする(Task 5のテストに1ケース入れる)
