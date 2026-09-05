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
  occurred: boolean;          // 品貸料率が数値としてparseできる('-'・'*****'等の非数値マーカーはfalse)
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

- [ ] **Step 1: 失敗するテストを書く**

Task 0(`docs/superpowers/notes/2026-09-05-taisyaku-csv-balance-columns.md`)で実機確認した実物のヘッダー・行をそのまま使う(全角括弧・全27列)。

```typescript
const HEADER = '"銘柄コード","銘柄名","直後基準日","直近制限措置","直近臨時措置","直近特別措置","申込日","市場区分","貸借区分","融資新規（株）","融資返済（株）","融資残高（株）","貸株新規（株）","貸株返済（株）","貸株残高（株）","差引残高（株）","貸借値段（円）","品貸料率（品貸日数分/円）","品貸日数","品貸料率（年率換算/％）","最高料率（品貸日数分/円）","最低料率（品貸日数分/円）","応札ランク","制限措置","臨時措置","特別措置","新株引受・権利入札"';

// splitCsvLineのクォート考慮パーサ自体は、実機データ(3ヶ月・63行)ではカンマ区切りの
// 数値を一度も観測できなかったため防御的な実装(将来カンマ区切りの列が来ても壊れない)。
// このテストは実在パターンではなく、想定される入力形への耐性を確認するもの。
test('splitCsvLine keeps thousands separators inside quoted fields', () => {
  expect(splitCsvLine('"2026-08-27","1,234,567","2,000,000"')).toEqual(['2026-08-27', '1,234,567', '2,000,000']);
});

test('parseTaisyakuCsv returns balances and the actual max rate alongside the fee', () => {
  // 実物(9418、2026-08-27、権利付き最終日): 融資残高1,100/貸株残高2,039,300/差引残高-2,038,200
  // (=融資残高-貸株残高。excessRatioの符号とは逆なので自前計算に使わない)/
  // 貸借値段1,752円/品貸料率14.40円(=最高料率と一致、応札ランクA=最も逼迫)。
  const row = '"9418","","20270228","","","","20260827","東証","貸借","0","500","1100","1785200","1800","2039300","-2038200","1752.00","14.40","1","300.00","14.40","0.00","A","","","",""';
  const csv = [HEADER, row].join('\n');
  expect(parseTaisyakuCsv(csv, '2026-08-27', 100)).toEqual({
    rightsDate: '2026-08-27', occurred: true, totalAmount: 1440, days: 1, avgRate: 14.4,
    financingBalance: 1100, lendingBalance: 2039300, lendingPrice: 1752, maxRateActual: 14.4,
    bidRank: 'A', restriction: null, emergencyMeasure: null,
  });
});

test('parseTaisyakuCsv returns occurred=false with balances when the fee is a dash', () => {
  // 実物(9418、2026-08-20、通常日): 品貸料率"-"(品薄なし)。応札ランクも"-"(=null)。
  const row = '"9418","","20270228","","","","20260820","東証","貸借","0","5300","25800","0","2000","21900","3900","1775.00","-","1","-","7.20","0.00","-","","","",""';
  const csv = [HEADER, row].join('\n');
  const point = parseTaisyakuCsv(csv, '2026-08-20', 100);
  expect(point?.occurred).toBe(false);
  expect(point?.totalAmount).toBe(0);
  expect(point?.lendingBalance).toBe(21900);
  expect(point?.maxRateActual).toBe(7.2);
  expect(point?.bidRank).toBeNull();
});

test('parseTaisyakuCsv treats a non-numeric "*****" fee the same as a dash (occurred=false)', () => {
  // 実機で発見した想定外パターン(9418、2026-08-21): 融資残高=貸株残高=26,100で差引残高が
  // ちょうど0になる境界日にだけ、品貸料率・年率換算の両方が"-"ではなく"*****"になる
  // (Task 0のnotes参照、63行中1行のみ観測)。Number('*****')はNaNなので、
  // 「'-'と等しいか」ではなく「数値としてparseできるか」で判定しないとoccurred:trueに
  // 誤判定され、totalAmount等がNaNになる。最高料率自体は通常通りの数値のまま。
  const row = '"9418","","20270228","","","","20260821","東証","貸借","16800","16500","26100","10300","6100","26100","0","1755.00","*****","1","*****","7.20","0.00","-","","","",""';
  const csv = [HEADER, row].join('\n');
  const point = parseTaisyakuCsv(csv, '2026-08-21', 100);
  expect(point?.occurred).toBe(false);
  expect(point?.totalAmount).toBe(0);
  expect(point?.maxRateActual).toBe(7.2);
});

test('parseTaisyakuCsv still returns undefined when the rights date row is absent', () => { /* 既存テストを流用 */ });
```

- [ ] **Step 2:** `npx jest test/taisyaku-client.test.ts` → FAIL を確認
- [ ] **Step 3: 実装**
  - `splitCsvLine`: 1文字ずつ走査し、`"`でinQuoteをトグル、inQuote外の`,`で分割。各フィールドは`stripQuotes`
  - 数値変換ヘルパー `toNumber(field): number | null`(カンマ除去→trim後に空文字列なら`null`を即返す — `Number('')`は`NaN`ではなく`0`になるJSの罠があるため、空文字列は先に弾く。それ以外は`Number()`に通し、結果が`NaN`なら`null`。`-`・`*****`はいずれも`Number()`で`NaN`になるためこれで`null`になる)
  - 文字列フィールド用ヘルパー `blankToNull(field): string | null`(空文字列または`-`なら`null`、それ以外はそのまま。`応札ランク`・`制限措置`・`臨時措置`に使う — `応札ランク`の「未実施」は`-`、`制限措置`等の「無し」は空文字列と実機で表記が異なるため、両方を`null`に丸める共通ヘルパーにする)
  - **`occurred`判定**: `品貸料率(品貸日数分/円)`列の生文字列を`toNumber`に通した結果が`null`(`NaN`)なら`occurred: false`。文字列が`'-'`かどうかの直接比較はしない(実機で`'*****'`という別の非数値マーカーも観測されているため、NaN判定に一本化して未知のマーカーにも耐えるようにする)
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

- [ ] **Step 1: 失敗するテストを書く**

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

function sample(fillRatio: number, overrides: Partial<ForecastSample> = {}): ForecastSample {
  return { ticker: 'T', rightsDate: '2026-01-01', month: 1, excessRatio: 1.5, fillRatio, regulated: false, ...overrides };
}

test('weightedQuantile picks the first value whose cumulative weight reaches q (no interpolation)', () => {
  // Step 3の方式(累積重みがq以上になる最初の値。補間しない)で手計算した値。
  // [1,2,3,4]を等重みで正規化すると各0.25、累積は0.25/0.5/0.75/1.0。
  // q=0.5は累積0.5(=2番目の値2)で条件を満たす -- 補間すれば2.5になるが、
  // この実装は補間しないので2が正しい。
  expect(weightedQuantile([1, 2, 3, 4], [1, 1, 1, 1], 0.5)).toBe(2);
  expect(weightedQuantile([1, 2, 3, 4], [1, 1, 1, 1], 0.9)).toBe(4);
});

test('buildPool counts zeros in the quantiles', () => {
  // 同一ビン(excessRatio=1.5 → '1〜2')にfill=[0,0,0,0.4,0.8]。等重みの累積は
  // 0.2/0.4/0.6/0.8/1.0。pOccur=2/5=0.4。P50(累積>=0.5の最初)=3番目の値0。
  // P90(累積>=0.9の最初)=5番目の値0.8。fillMean=(0+0+0+0.4+0.8)/5=0.24。
  const samples = [0, 0, 0, 0.4, 0.8].map((f) => sample(f));
  const pool = buildPool(samples);
  const bin = pool.find((b) => b.label === '1〜2')!;
  expect(bin.n).toBe(5);
  expect(bin.pOccur).toBeCloseTo(0.4);
  expect(bin.fillP50).toBe(0);
  expect(bin.fillP90).toBeCloseTo(0.8);
  expect(bin.fillMean).toBeCloseTo(0.24);
});

test('forecast with no ticker samples equals the pool bin distribution', () => {
  // poolSamplesのfill=[0, 0.5, 1.0]、等重み累積0.333/0.667/1.0。
  // P50(累積>=0.5の最初)=2番目の値0.5。P90(累積>=0.9の最初)=3番目の値1.0。
  const poolSamples = [0, 0.5, 1.0].map((f) => sample(f));
  const result = forecast({
    tickerSamples: [], poolSamples, scenario: 'last-rights', excessRatio: 1.5, maxGyakuhibu: 1000, value: 500,
  });
  expect(result.fillP50).toBeCloseTo(0.5);
  expect(result.fillP90).toBeCloseTo(1.0);
  expect(result.tickerSamples).toBe(0);
  expect(result.poolSamples).toBe(3);
});

test('forecast with 4 ticker samples weights ticker and pool equally (K=4)', () => {
  const tickerSamples = Array.from({ length: 4 }, () => sample(1));
  const poolSamples = Array.from({ length: 4 }, () => sample(0));
  const result = forecast({
    tickerSamples, poolSamples, scenario: 'last-rights', excessRatio: 1.5, maxGyakuhibu: 1000, value: 500,
  });
  // w = 4/(4+4) = 0.5 -> fillMean = 0.5*1 + 0.5*0 = 0.5
  expect(result.fillMean).toBeCloseTo(0.5);
});

test('forecast with an empty pool bin falls back to ticker samples only', () => {
  const tickerSamples = [0.2, 0.6, 1.0].map((f) => sample(f));
  const result = forecast({
    tickerSamples, poolSamples: [], scenario: 'last-rights', excessRatio: 1.5, maxGyakuhibu: 1000, value: 500,
  });
  // n_p=0 -> 重みは銘柄側1.0に倒れ、銘柄分布そのものと一致する
  expect(result.fillMean).toBeCloseTo((0.2 + 0.6 + 1.0) / 3);
  expect(result.poolSamples).toBe(0);
});

test('chooseScenario prefers the latest same-month rights date, then the latest rights date, then TSE, then none', () => {
  const tickerSamples = [
    sample(0.5, { rightsDate: '2024-09-26', month: 9, excessRatio: 1.0 }),
    sample(0.8, { rightsDate: '2025-09-26', month: 9, excessRatio: 2.0 }),
    sample(0.1, { rightsDate: '2025-03-27', month: 3, excessRatio: 0.3 }),
  ];

  // 対象月(9月)のサンプルが複数あれば、そのうち直近(rightsDateが新しい方)を採用
  expect(chooseScenario(tickerSamples, 9, null)).toEqual({ scenario: 'last-rights', excessRatio: 2.0 });

  // 対象月(6月)のサンプルが無ければ、全サンプル中で最も新しい権利日を採用
  expect(chooseScenario(tickerSamples, 6, null)).toEqual({ scenario: 'last-rights', excessRatio: 2.0 });

  // 銘柄サンプルが無ければ東証信用残ベース(excessRatio(100,250)=1.5)
  expect(chooseScenario([], 9, { financingBalance: 100, lendingBalance: 250 })).toEqual({
    scenario: 'current-tse', excessRatio: 1.5,
  });

  // どちらも無ければnone
  expect(chooseScenario([], 9, null)).toEqual({ scenario: 'none', excessRatio: null });
});

test('forecastStatus boundaries: value == p90 is caution, value == p50 is danger', () => {
  expect(forecastStatus(5000, 1000, 4000)).toBe('safe');
  expect(forecastStatus(4000, 1000, 4000)).toBe('caution');
  expect(forecastStatus(1000, 1000, 4000)).toBe('danger');
});

test('forecast returns na when maxGyakuhibu is null or there are no samples at all', () => {
  const result1 = forecast({
    tickerSamples: [sample(0.5)], poolSamples: [], scenario: 'last-rights', excessRatio: 1.5, maxGyakuhibu: null, value: 500,
  });
  expect(result1.forecastStatus).toBe('na');

  const result2 = forecast({
    tickerSamples: [], poolSamples: [], scenario: 'none', excessRatio: null, maxGyakuhibu: 1000, value: 500,
  });
  expect(result2.forecastStatus).toBe('na');
});
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

`test/yutai-risk-precompute-batch.test.ts`と同じモック方式・同じ日付固定方式(`jest.useFakeTimers().setSystemTime(...)`)を使う。`rightsMonths: [8]`・`now = 2026-08-01T00:00:00Z`のとき、次回権利付き最終日は`2026-08-27`になる(既存テストで検証済みの事実、再利用してよい)。

```typescript
const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  QueryCommand: jest.fn((input: unknown) => input),
  ScanCommand: jest.fn((input: unknown) => input),
  PutCommand: jest.fn((input: unknown) => input),
}));

process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.GYAKUHIBU_ACTUAL_TABLE_NAME = 'JQuantsGyakuhibuActual';
process.env.MARGIN_BALANCE_TABLE_NAME = 'JQuantsMarginBalance';
process.env.GYAKUHIBU_FORECAST_TABLE_NAME = 'JQuantsGyakuhibuForecast';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/gyakuhibu-forecast-batch/index') as { handler: () => Promise<void> };

beforeEach(() => {
  mockSend.mockReset();
});

function putCalls() {
  return mockSend.mock.calls.filter(([cmd]) => 'Item' in (cmd as Record<string, unknown>));
}

function withFixedNow(fn: () => Promise<void>): Promise<void> {
  jest.useFakeTimers({
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick'],
  }).setSystemTime(new Date('2026-08-01T00:00:00Z'));
  return fn().finally(() => jest.useRealTimers());
}

test('writes the _POOL_ row before any ticker row', async () => {
  await withFixedNow(async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: 5000 }] }) // yutai master scan
      .mockResolvedValueOnce({ Items: [] }) // gyakuhibu actual scan (履歴なし)
      .mockResolvedValueOnce({}) // _POOL_ put
      .mockResolvedValueOnce({ Items: [] }) // 1234のmargin balance query
      .mockResolvedValueOnce({}); // 1234のforecast put

    await handler();

    const puts = putCalls();
    expect(puts).toHaveLength(2);
    expect((puts[0][0] as { Item: { ticker: string } }).Item.ticker).toBe('_POOL_');
    expect((puts[1][0] as { Item: { ticker: string } }).Item.ticker).toBe('1234');
  });
});

test('computes a forecast per ticker using its own rights history and the pool', async () => {
  await withFixedNow(async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: 5000 }] }) // yutai master scan
      .mockResolvedValueOnce({
        Items: [
          {
            ticker: '1234', rightsDate: '2025-08-27', financingBalance: 100, lendingBalance: 250,
            avgRate: 10, days: 1, maxRateActual: 10, restriction: null, emergencyMeasure: null, enriched: true,
          },
        ],
      }) // gyakuhibu actual scan(同銘柄・同月の権利日履歴が1件)
      .mockResolvedValueOnce({}) // _POOL_ put
      .mockResolvedValueOnce({ Items: [] }) // margin balance query(銘柄自身の履歴があるので使われないはず)
      .mockResolvedValueOnce({}); // 1234のforecast put

    await handler();

    const tickerPut = putCalls().find((c) => (c[0] as { Item: { ticker: string } }).Item.ticker === '1234')!;
    const item = (tickerPut[0] as { Item: Record<string, unknown> }).Item;
    expect(item.rightsDate).toBe('2026-08-27');
    expect(item.scenario).toBe('last-rights');
    expect(item.tickerSamples).toBe(1);
    // 手計算: 唯一の履歴行がticker自身の分・プール全体の分の両方を兼ねる(n_t=1, n_p=1)。
    // w=1/(1+4)=0.2、両方ともfillRatio=1なので、加重しても分位点・平均とも1のまま。
    // forecastP90 = 1 * maxGyakuhibu(5000) = 5000。value(1000) <= forecastP50(5000)なのでdanger。
    expect(item.forecastP90).toBe(5000);
    expect(item.forecastStatus).toBe('danger');
  });
});

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
        .mockRejectedValueOnce(new Error('DynamoDB error')) // 1111のmargin balance queryが失敗
        .mockResolvedValueOnce({ Items: [] }) // 2222のmargin balance query
        .mockResolvedValueOnce({}); // 2222のforecast put

      await handler();

      const tickerPuts = putCalls().filter((c) => (c[0] as { Item: { ticker: string } }).Item.ticker !== '_POOL_');
      expect(tickerPuts).toHaveLength(1);
      expect((tickerPuts[0][0] as { Item: { ticker: string } }).Item.ticker).toBe('2222');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('1111'), expect.any(Error));
    });
  } finally {
    errorSpy.mockRestore();
  }
});

test('marks tickers without maxGyakuhibu as na even when sample history exists', async () => {
  await withFixedNow(async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ ticker: '1234', value: 1000, unitShares: 100, rightsMonths: [8], maxGyakuhibu: null }] }) // risk-precompute未実行(maxGyakuhibuがまだ無い)
      .mockResolvedValueOnce({
        Items: [
          {
            ticker: '1234', rightsDate: '2025-08-27', financingBalance: 100, lendingBalance: 250,
            avgRate: 10, days: 1, maxRateActual: 10, restriction: null, emergencyMeasure: null, enriched: true,
          },
        ],
      }) // 履歴自体はある(n_t=1) -- naの原因がサンプル不足ではなくmaxGyakuhibu欠落そのものであることを分離するため
      .mockResolvedValueOnce({}) // _POOL_ put
      .mockResolvedValueOnce({ Items: [] }) // margin balance query
      .mockResolvedValueOnce({}); // 1234のforecast put

    await handler();

    const tickerPut = putCalls().find((c) => (c[0] as { Item: { ticker: string } }).Item.ticker === '1234')!;
    const item = (tickerPut[0] as { Item: Record<string, unknown> }).Item;
    expect(item.tickerSamples).toBe(1); // サンプルはある
    expect(item.forecastStatus).toBe('na'); // それでもmaxGyakuhibuが無いのでna
  });
});
```

- [ ] **Step 2:** FAIL 確認
- [ ] **Step 3: 実装**

```
handler:
  master = scanYutaiMaster()                       // ticker, value, unitShares, rightsMonths, maxGyakuhibu(欠損はnullに正規化)
  unitSharesByTicker = Map(master.map(m => [m.ticker, m.unitShares]))
  actualRows = scanAll(GYAKUHIBU_ACTUAL)           // 全ticker横断、ページングはscanYutaiMasterと同じdo-while
  allSamples = actualRows
    .map(row => toSample(row, unitSharesByTicker.get(row.ticker) ?? 100))
    .filter(s => s !== null)                        // enrichedでない/maxRateActual無しの行はtoSampleがnullを返す
  samplesByTicker = groupBy(allSamples, s => s.ticker)
  pool = buildPool(allSamples)
  computedAt = today (YYYY-MM-DD)
  put(_POOL_, { bins: pool, computedAt })            // 銘柄ループより先に書く(プールが無いと全銘柄naになるため失敗が目立つように)

  for row of master (try/catch):
    nextDate = nextRightsDate(row.rightsMonths)      // lambda/shared/trading-calendar.tsの既存関数(引数はrightsMonthsのみ、内部でカレンダーをキャッシュ計算する)
    if (!nextDate) { console.warn(`${row.ticker}: no upcoming rights date, skipping`); continue }

    tickerSamples = samplesByTicker.get(row.ticker) ?? []
    tseLatest = query MarginBalance (Limit 1, desc)   // scenario 'current-tse' 用。呼び出し側で使うかどうかに関わらず毎回引く(chooseScenarioが内部で要不要を判断する)
    { scenario, excessRatio } = chooseScenario(tickerSamples, month(nextDate), tseLatest)

    // forecast()のpoolSamplesは「ビンで絞り込まない全件」を渡す契約(Task 3のgyakuhibu-forecast.ts参照)。
    // ここで先にbinFor等を使って絞り込んではいけない(forecast内部で絞り込むため、二重に絞ると
    // 契約違反にはならないが無駄で紛らわしい)。
    result = forecast({ tickerSamples, poolSamples: allSamples, scenario, excessRatio, maxGyakuhibu: row.maxGyakuhibu, value: row.value })
    put(row.ticker, { rightsDate: nextDate, ...result, computedAt })
```

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

**Interfaces(既存`lambda/reference-api/index.ts`への追加。Task 3の`excessRatio`/`fillRatio`をそのまま輸入する):**
```typescript
import { excessRatio, fillRatio } from '../shared/gyakuhibu-forecast';
```

- [ ] **Step 1: 失敗するテストを書く**

`test/reference-api.test.ts`は既存の`mockSend`/`makeEvent`/`body`ヘルパーをそのまま使う。呼び出し順は必ず`mockSend`が呼ばれる順(下記コメント参照)。`process.env.GYAKUHIBU_FORECAST_TABLE_NAME = 'JQuantsGyakuhibuForecast';`をファイル先頭のprocess.env設定群に追加すること。

```typescript
test('GET /yutai/forecast joins master and forecast tables by ticker and filters by forecastStatus', async () => {
  mockSend
    .mockResolvedValueOnce({
      Items: [
        { ticker: '1234', companyName: 'A', content: 'A優待', value: 1000, unitShares: 100, rightsMonths: [8], riskStatus: 'danger', maxGyakuhibu: 5000 },
        { ticker: '5678', companyName: 'B', content: 'B優待', value: 2000, unitShares: 100, rightsMonths: [8], riskStatus: 'safe', maxGyakuhibu: 100 },
      ],
    }) // yutai master scan
    .mockResolvedValueOnce({
      Items: [
        { ticker: '_POOL_', bins: [], computedAt: '2026-08-01' },
        { ticker: '1234', rightsDate: '2026-08-27', scenario: 'last-rights', forecastStatus: 'danger', forecastP50: 1000, forecastP90: 4000, tickerSamples: 3, poolSamples: 400, computedAt: '2026-08-01' },
        { ticker: '5678', rightsDate: '2026-08-27', scenario: 'none', forecastStatus: 'safe', forecastP50: 10, forecastP90: 50, tickerSamples: 0, poolSamples: 400, computedAt: '2026-08-01' },
      ],
    }); // gyakuhibu forecast scan

  const result = await handler(makeEvent('GET /yutai/forecast', { queryStringParameters: { forecastStatus: 'danger' } }));

  const parsed = body(result) as {
    tickers: Array<{ ticker: string; forecast: { forecastStatus: string; forecastP90: number } }>;
    poolComputedAt: string;
  };
  expect(parsed.tickers).toHaveLength(1);
  expect(parsed.tickers[0].ticker).toBe('1234');
  expect(parsed.tickers[0].forecast.forecastStatus).toBe('danger');
  expect(parsed.tickers[0].forecast.forecastP90).toBe(4000);
  expect(parsed.poolComputedAt).toBe('2026-08-01');
});

test('GET /yutai/forecast marks a ticker with no forecast row yet as forecastStatus na', async () => {
  mockSend
    .mockResolvedValueOnce({
      Items: [{ ticker: '9999', companyName: 'C', content: 'C優待', value: 500, unitShares: 100, rightsMonths: [8], riskStatus: 'na', maxGyakuhibu: null }],
    }) // yutai master scan
    .mockResolvedValueOnce({ Items: [] }); // gyakuhibu forecast scan(_POOL_行も無い)

  const result = await handler(makeEvent('GET /yutai/forecast', {}));

  const parsed = body(result) as { tickers: Array<{ forecast: { forecastStatus: string } }>; poolComputedAt: unknown };
  expect(parsed.tickers).toHaveLength(1);
  expect(parsed.tickers[0].forecast.forecastStatus).toBe('na');
  expect(parsed.poolComputedAt).toBeNull();
});

test('GET /yutai/{ticker}/forecast returns history including noGyakuhibu rows with excessRatio/fillRatio/occurred', async () => {
  mockSend
    .mockResolvedValueOnce({
      Item: { ticker: '1234', companyName: 'A', content: 'A優待', value: 1000, unitShares: 100, rightsMonths: [8], riskStatus: 'danger', maxGyakuhibu: 5000 },
    }) // master get
    .mockResolvedValueOnce({
      Item: { ticker: '1234', rightsDate: '2026-08-27', scenario: 'last-rights', forecastStatus: 'danger', forecastP50: 1000, forecastP90: 4000, tickerSamples: 1, poolSamples: 1 },
    }) // forecast get
    .mockResolvedValueOnce({
      Item: { ticker: '_POOL_', bins: [{ label: '1〜2', lo: 1, hi: 2, n: 400, pOccur: 0.5, fillP50: 0.2, fillP90: 0.8, fillMean: 0.3 }], computedAt: '2026-08-01' },
    }) // _POOL_ get
    .mockResolvedValueOnce({
      Items: [
        {
          ticker: '1234', rightsDate: '2025-08-27', financingBalance: 100, lendingBalance: 250, avgRate: 10, days: 1,
          maxRateActual: 10, lendingPrice: 1700, bidRank: 'A', restriction: null, emergencyMeasure: null, totalAmount: 1000, enriched: true,
        },
        {
          ticker: '1234', rightsDate: '2024-08-27', financingBalance: 200, lendingBalance: 150, avgRate: 0, days: 0,
          maxRateActual: 5, noGyakuhibu: true, totalAmount: 0, enriched: true,
        },
      ],
    }) // gyakuhibu actual query(権利日降順、noGyakuhibu行も含む)
    .mockResolvedValueOnce({ Items: [] }); // margin balance query

  const result = await handler(makeEvent('GET /yutai/{ticker}/forecast', { pathParameters: { ticker: '1234' } }));

  const parsed = body(result) as { history: Array<Record<string, unknown>>; poolBins: Array<Record<string, unknown>> };
  expect(parsed.history).toHaveLength(2); // noGyakuhibu行も含めて2件(既存/yutai/{ticker}のrightsHistoryとは違い除外しない)

  const occurredRow = parsed.history.find((h) => h.rightsDate === '2025-08-27')!;
  expect(occurredRow.excessRatio).toBeCloseTo(1.5); // (250-100)/100
  expect(occurredRow.excessShares).toBe(150); // 250-100
  expect(occurredRow.fillRatio).toBe(1); // (10*1)/10
  expect(occurredRow.occurred).toBe(true);

  const noFeeRow = parsed.history.find((h) => h.rightsDate === '2024-08-27')!;
  expect(noFeeRow.occurred).toBe(false);
  expect(noFeeRow.excessRatio).toBeCloseTo(-0.25); // (150-200)/200

  expect(parsed.poolBins).toHaveLength(1);
  expect(parsed.poolBins[0]).toMatchObject({ label: '1〜2', n: 400 });
});

test('GET /yutai/{ticker}/forecast returns forecastStatus na and empty history/poolBins when nothing is computed yet', async () => {
  mockSend
    .mockResolvedValueOnce({
      Item: { ticker: '9999', companyName: 'C', content: 'C優待', value: 500, unitShares: 100, rightsMonths: [8], riskStatus: 'na', maxGyakuhibu: null },
    }) // master get
    .mockResolvedValueOnce({}) // forecast get(Item無し)
    .mockResolvedValueOnce({}) // _POOL_ get(Item無し)
    .mockResolvedValueOnce({ Items: [] }) // gyakuhibu actual query
    .mockResolvedValueOnce({ Items: [] }); // margin balance query

  const result = await handler(makeEvent('GET /yutai/{ticker}/forecast', { pathParameters: { ticker: '9999' } }));

  const parsed = body(result) as { forecast: { forecastStatus: string }; poolBins: unknown[]; history: unknown[] };
  expect(parsed.forecast.forecastStatus).toBe('na');
  expect(parsed.poolBins).toEqual([]);
  expect(parsed.history).toEqual([]);
});

test('GET /yutai/{ticker}/forecast returns 404 for an unknown ticker', async () => {
  mockSend.mockResolvedValueOnce({}); // master get: Item無し

  const result = await handler(makeEvent('GET /yutai/{ticker}/forecast', { pathParameters: { ticker: '0000' } }));

  expect(result.statusCode).toBe(404);
});
```

- [ ] **Step 2:** FAIL 確認
- [ ] **Step 3: 実装**
  - `lambda/reference-api/index.ts`の先頭に`import { excessRatio, fillRatio } from '../shared/gyakuhibu-forecast';`を追加
  - 環境変数`GYAKUHIBU_FORECAST_TABLE_NAME`を追加
  - `listYutai`のフィルタ部分(`keyword`・`rightsDateFrom`/`rightsDateTo`)を`passesYutaiFilters(row, rightsDate, filters)`のような関数に切り出し、`listYutai`と`listYutaiForecast`の両方から呼ぶ(`riskStatus`/`forecastStatus`フィルタはそれぞれ別条件なので切り出し関数には含めない)
  - `scanForecastTable()`: `GYAKUHIBU_FORECAST_TABLE_NAME`の全件スキャン(`scanYutaiMaster`と同じdo-whileページング)。`_POOL_`行も含めてそのまま返す(呼び出し側で`ticker === '_POOL_'`により分離する)
  - `listYutaiForecast(query)`:
    1. `masterRows = await scanYutaiMaster()`、`forecastRows = await scanForecastTable()`(この順で逐次await。呼び出し順がテストの`mockResolvedValueOnce`順と一致する)
    2. `forecastByTicker = new Map(forecastRows.filter(r => r.ticker !== '_POOL_').map(r => [r.ticker, r]))`、`poolRow = forecastRows.find(r => r.ticker === '_POOL_')`
    3. `masterRows`をループし、`passesYutaiFilters`と`keyword`/`rightsDateFrom`/`rightsDateTo`で絞り込み、`forecastByTicker.get(row.ticker)`が無ければ`{ scenario: 'none', excessRatio: null, bin: null, pOccur: null, fillP50: null, fillP90: null, forecastP50: null, forecastP90: null, forecastMean: null, expectedNet: null, forecastStatus: 'na', tickerSamples: 0, poolSamples: 0 }`をデフォルト値として使う。`query.forecastStatus`が`'all'`でなければ、確定した`forecast.forecastStatus`と一致しない行を除外する
    4. レスポンス: `{ currentMonthLastTradableDate, poolComputedAt: poolRow?.computedAt ?? null, tickers: items }`(`currentMonthLastTradableDate`は既存`listYutai`と同じ計算をそのまま再利用)
  - `getYutaiForecast(ticker)`:
    1. `master = await getYutaiMaster(ticker)`。無ければ404(既存`getYutaiDetail`と同じ)
    2. 以下を**この順で逐次await**する(テストの`mockResolvedValueOnce`順と一致させるため、`Promise.all`は使わない): `forecastResult = GetCommand({ TableName: GYAKUHIBU_FORECAST_TABLE_NAME, Key: { ticker } })`、`poolResult = GetCommand({ TableName: GYAKUHIBU_FORECAST_TABLE_NAME, Key: { ticker: '_POOL_' } })`、`actualResult = QueryCommand({ TableName: GYAKUHIBU_ACTUAL_TABLE_NAME, KeyConditionExpression: 'ticker = :ticker', ExpressionAttributeValues: { ':ticker': ticker }, ScanIndexForward: false })`(既存`gyakuhibuHistory`と違い`noGyakuhibu`行を除外しない)、`marginResult = QueryCommand({ TableName: MARGIN_BALANCE_TABLE_NAME, ..., ScanIndexForward: false, Limit: 1 })`
    3. `forecast`オブジェクトは`listYutaiForecast`と同じデフォルト値ロジックを共用する(`forecastResult.Item`が無ければ`na`/`none`のデフォルト)
    4. `history = (actualResult.Items ?? []).map(item => ({ rightsDate, excessRatio: excessRatio(financingBalance, lendingBalance), excessShares: lendingBalance - financingBalance, financingBalance, lendingBalance, lendingPrice: item.lendingPrice ?? null, fillRatio: fillRatio(item.avgRate ?? 0, item.days ?? 0, item.maxRateActual ?? null), totalAmount: item.totalAmount ?? 0, maxRateActual: item.maxRateActual ?? null, bidRank: item.bidRank ?? null, restriction: item.restriction ?? null, emergencyMeasure: item.emergencyMeasure ?? null, occurred: item.noGyakuhibu !== true }))`(`financingBalance`/`lendingBalance`は`typeof item.X === 'number' ? item.X : 0`で正規化してから計算に使う)
    5. `poolBins = poolResult.Item?.bins ?? []`
    6. `marginTrend = marginResult.Items?.[0] ? { latest: { date: ..., financingBalance: ..., lendingBalance: ... } } : { latest: null }`
    7. レスポンス: `{ ticker, companyName, content, value, unitShares, rightsDate, maxGyakuhibu: master.maxGyakuhibu, forecast, history, poolBins, marginTrend }`
  - switch文に2ルート追加。`GET /yutai/forecast`は`GET /yutai/{ticker}`より**前**に置く必要はない(routeKeyが違う)が、可読性のため隣接させる:
    ```typescript
    case 'GET /yutai/forecast':
      return listYutaiForecast(event.queryStringParameters ?? {});
    case 'GET /yutai/{ticker}/forecast':
      return ticker ? getYutaiForecast(ticker) : jsonResponse(400, { message: 'Missing ticker' });
    ```
- [ ] **Step 4:** PASS
- [ ] **Step 5: CDK** — `lib/j-quants-stack.ts`の`referenceApiFn`定義に`GYAKUHIBU_FORECAST_TABLE_NAME: this.gyakuhibuForecastTable.tableName`を環境変数追加し、`this.gyakuhibuForecastTable.grantReadData(referenceApiFn);`を追加。`this.api.addRoutes({ path: '/yutai/forecast', methods: [apigwv2.HttpMethod.GET], integration: referenceApiIntegration })`と`path: '/yutai/{ticker}/forecast'`の2つを、既存の`/yutai/{ticker}/margin-trend`ルート追加の直後に追加する。`test/j-quants.test.ts`の`'creates the HTTP API with tickers CRUD and the price/summary routes'`テスト内の既存`routeKeys`配列に`'GET /yutai/forecast'`と`'GET /yutai/{ticker}/forecast'`を追加する(新規テストではなく既存配列への追記でよい)
- [ ] **Step 6:** `npx jest` 全体PASS
- [ ] **Step 7:** `git commit -m "Add GET /yutai/forecast and GET /yutai/{ticker}/forecast"`

---

## Task 6: フロントAPI型・クライアント

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/client.ts`

Task 5で実際に実装された`GET /yutai/forecast`・`GET /yutai/{ticker}/forecast`のレスポンス形状に**そのまま**合わせる(設計書のJSON例は`unitShares`が一覧レスポンスにも書かれているが、実装は既存`YutaiListItem`/`listYutai`と同じく一覧では`unitShares`を返さない。詳細レスポンスにはある。以下はTask 5の実コードから起こした正確な形)。

- [ ] `frontend/src/api/types.ts`の末尾(既存`MarginTrendResponse`の後)に追加:

```typescript
export type YutaiForecastStatus = 'safe' | 'caution' | 'danger' | 'na';
export type YutaiForecastScenario = 'last-rights' | 'current-tse' | 'none';

export interface YutaiForecast {
  scenario: YutaiForecastScenario;
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
  forecastStatus: YutaiForecastStatus;
  tickerSamples: number;
  poolSamples: number;
}

export interface YutaiForecastListItem {
  ticker: string;
  companyName?: string;
  content: string;
  value: number;
  rightsDate: string | null;
  riskStatus: YutaiRiskStatus;
  maxGyakuhibu: number | null;
  forecast: YutaiForecast;
}

export interface YutaiForecastListResponse {
  tickers: YutaiForecastListItem[];
  currentMonthLastTradableDate: string;
  poolComputedAt: string | null;
}

export interface YutaiForecastHistoryPoint {
  rightsDate: string;
  excessRatio: number | null;
  excessShares: number;
  financingBalance: number;
  lendingBalance: number;
  lendingPrice: number | null;
  fillRatio: number | null;
  totalAmount: number;
  maxRateActual: number | null;
  bidRank: string | null;
  restriction: string | null;
  emergencyMeasure: string | null;
  occurred: boolean;
}

export interface PoolBin {
  label: string;
  lo: number;
  hi: number;
  n: number;
  pOccur: number;
  fillP50: number;
  fillP90: number;
  fillMean: number;
}

export interface YutaiForecastMarginLatest {
  date: string;
  financingBalance: number;
  lendingBalance: number;
}

export interface YutaiForecastDetail {
  ticker: string;
  companyName: string | null;
  content: string;
  value: number;
  unitShares: number;
  rightsDate: string | null;
  maxGyakuhibu: number | null;
  forecast: YutaiForecast;
  history: YutaiForecastHistoryPoint[];
  poolBins: PoolBin[];
  marginTrend: { latest: YutaiForecastMarginLatest | null };
}
```

- [ ] `frontend/src/api/client.ts`の末尾(既存`fetchYutaiMarginTrend`の後)に追加。既存`fetchYutaiList`と同じ`URLSearchParams`の組み立て方に揃える:

```typescript
export interface YutaiForecastListParams extends YutaiListParams {
  forecastStatus?: YutaiForecastStatus | 'all';
}

export function fetchYutaiForecastList(params: YutaiForecastListParams): Promise<YutaiForecastListResponse> {
  const query = new URLSearchParams();
  if (params.rightsDateFrom) query.set('rightsDateFrom', params.rightsDateFrom);
  if (params.rightsDateTo) query.set('rightsDateTo', params.rightsDateTo);
  if (params.keyword) query.set('keyword', params.keyword);
  if (params.forecastStatus) query.set('forecastStatus', params.forecastStatus);
  return request(`/yutai/forecast?${query}`);
}

export function fetchYutaiForecastDetail(ticker: string): Promise<YutaiForecastDetail> {
  return request(`/yutai/${ticker}/forecast`);
}
```

  `YutaiForecastListParams`は`riskStatus`(既存`YutaiListParams`由来、`/yutai/forecast`では未使用)を含んだままでよい(使わなければ単に送信されないだけで害はない)。`YutaiForecastStatus`は`frontend/src/api/types.ts`からimportする。

- [ ] `frontend`ディレクトリで`npm run build`(`tsc -b && vite build`)を実行し、型エラーなくビルドが通ることを確認する(フロントにjestテストは無い。既存の型・ビルドチェックのみが検証手段)
- [ ] `git commit -m "Add forecast API types and client functions"`

---

## Task 7: `/yutai/forecast` 一覧画面

**Files:**
- Create: `frontend/src/pages/YutaiForecastListPage.tsx`
- Modify: `frontend/src/main.tsx`, `frontend/src/components/Layout.tsx`, `frontend/src/index.css`

既存`frontend/src/pages/YutaiListPage.tsx`の権利日範囲・キーワード・デバウンス・バナー・テーブル描画の構造をそのまま複製し、列定義とソート・フィルタ対象だけを予測用に差し替える(共通化は2画面目なのでまだしない、既存コメントの方針どおり)。以下は複製元の実物と1対1で対応させた完全なコード。

- [ ] `frontend/src/index.css`の`.risk-badge--na`ブロックの直後に追加:

```css
.risk-badge--caution {
  color: var(--caution);
  background: color-mix(in srgb, var(--caution) 14%, transparent);
}

.basis-badge {
  font-size: 0.72rem;
  padding: 0.1rem 0.4rem;
  border-radius: 6px;
  color: var(--text-muted);
  background: var(--surface-alt);
  margin-left: 0.4rem;
}
```

  `:root`ブロック(`--down: #1e8449;`の直後)に`--caution: #b8860b;`を追加。`@media (prefers-color-scheme: dark)`内の`:root`ブロック(`--down: #34c77b;`の直後)に`--caution: #e0b64c;`を追加(`--up`/`--down`と同じ書き方に揃える)。

- [ ] `frontend/src/pages/YutaiForecastListPage.tsx`(新規、`YutaiListPage.tsx`の複製+差し替え):

```typescript
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable } from '@tanstack/react-table';
import type { ColumnDef } from '@tanstack/react-table';
import { fetchYutaiForecastList } from '../api/client';
import type { YutaiForecastListItem, YutaiForecastStatus } from '../api/types';
import { StatusNote } from '../components/StatusNote';
import { formatFinancialYen } from '../lib/format';
import { useAsync } from '../lib/useAsync';

function monthRange(): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDay = new Date(y, m + 1, 0).getDate();
  return { from: `${y}-${pad(m + 1)}-01`, to: `${y}-${pad(m + 1)}-${pad(lastDay)}` };
}

const FORECAST_STATUS_LABEL: Record<YutaiForecastStatus, string> = {
  danger: '危険',
  caution: '注意',
  safe: '安全',
  na: '対象外',
};
// 判定は危険→注意→安全→対象外の順に並ぶ方が意味があるため、文字列の並び順ではなく
// このランクでソートする(既存YutaiListPageのRISK_SORT_RANKと同じ考え方)。
const FORECAST_STATUS_SORT_RANK: Record<YutaiForecastStatus, number> = {
  danger: 0,
  caution: 1,
  safe: 2,
  na: 3,
};

// デフォルトソート: 判定ランク→expectedNet昇順(=優待価値と予測逆日歩の差が小さい=
// 危ないものが上に来る)。tanstack/react-tableの複数列初期ソートに頼らず、テーブルに
// 渡す前に配列を並べ替えておく(ヘッダークリックでの単一列ソートはこれとは独立に動く)。
function compareByDefaultOrder(a: YutaiForecastListItem, b: YutaiForecastListItem): number {
  const rankDiff = FORECAST_STATUS_SORT_RANK[a.forecast.forecastStatus] - FORECAST_STATUS_SORT_RANK[b.forecast.forecastStatus];
  if (rankDiff !== 0) return rankDiff;
  const netA = a.forecast.expectedNet ?? Infinity;
  const netB = b.forecast.expectedNet ?? Infinity;
  return netA - netB;
}

function formatPercent(value: number | null): string {
  return value !== null ? `${Math.round(value * 100)}%` : '—';
}

const columns: ColumnDef<YutaiForecastListItem>[] = [
  {
    id: 'company',
    header: '銘柄',
    accessorFn: (row) => row.companyName ?? row.ticker,
    cell: ({ row }) => (
      <Link to={`/yutai/${row.original.ticker}/forecast`}>
        {row.original.companyName ?? row.original.ticker}{' '}
        <span className="ticker-card__code">{row.original.ticker}</span>
      </Link>
    ),
  },
  {
    accessorKey: 'content',
    header: '優待内容',
  },
  {
    accessorKey: 'value',
    header: '優待価値',
    sortDescFirst: false,
    cell: ({ row }) => formatFinancialYen(String(row.original.value)),
  },
  {
    accessorKey: 'rightsDate',
    header: '権利日',
    sortDescFirst: false,
    sortingFn: (rowA, rowB) => {
      const a = rowA.original.rightsDate;
      const b = rowB.original.rightsDate;
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return a.localeCompare(b);
    },
    cell: ({ row }) => row.original.rightsDate ?? '—',
  },
  {
    accessorKey: 'maxGyakuhibu',
    header: '最大逆日歩',
    sortDescFirst: false,
    sortingFn: (rowA, rowB) => {
      const a = rowA.original.maxGyakuhibu;
      const b = rowB.original.maxGyakuhibu;
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return a - b;
    },
    cell: ({ row }) => (row.original.maxGyakuhibu !== null ? formatFinancialYen(String(row.original.maxGyakuhibu)) : '—'),
  },
  {
    id: 'pOccur',
    header: '発生確率',
    accessorFn: (row) => row.forecast.pOccur,
    sortDescFirst: true,
    cell: ({ row }) => formatPercent(row.original.forecast.pOccur),
  },
  {
    id: 'forecastP50',
    header: '予測(中央値)',
    accessorFn: (row) => row.forecast.forecastP50,
    sortDescFirst: true,
    cell: ({ row }) =>
      row.original.forecast.forecastP50 !== null ? formatFinancialYen(String(row.original.forecast.forecastP50)) : '—',
  },
  {
    id: 'forecastP90',
    header: '予測(P90)',
    accessorFn: (row) => row.forecast.forecastP90,
    sortDescFirst: true,
    cell: ({ row }) =>
      row.original.forecast.forecastP90 !== null ? formatFinancialYen(String(row.original.forecast.forecastP90)) : '—',
  },
  {
    id: 'judgment',
    header: '判定',
    accessorFn: (row) => row.forecast.forecastStatus,
    sortingFn: (rowA, rowB) =>
      FORECAST_STATUS_SORT_RANK[rowA.original.forecast.forecastStatus] - FORECAST_STATUS_SORT_RANK[rowB.original.forecast.forecastStatus],
    cell: ({ row }) => (
      <span className={`risk-badge risk-badge--${row.original.forecast.forecastStatus}`}>
        {FORECAST_STATUS_LABEL[row.original.forecast.forecastStatus]}
      </span>
    ),
  },
  {
    id: 'basis',
    header: '根拠',
    accessorFn: (row) => row.forecast.tickerSamples + row.forecast.poolSamples,
    cell: ({ row }) => (
      <>
        銘柄{row.original.forecast.tickerSamples}件＋市場{row.original.forecast.poolSamples}件
        {row.original.forecast.scenario === 'current-tse' && <span className="basis-badge">参考</span>}
      </>
    ),
  },
];

const KEYWORD_DEBOUNCE_MS = 400;

export function YutaiForecastListPage() {
  const navigate = useNavigate();
  const defaultRange = monthRange();
  const [rightsDateFrom, setRightsDateFrom] = useState(defaultRange.from);
  const [rightsDateTo, setRightsDateTo] = useState(defaultRange.to);
  const [keyword, setKeyword] = useState('');
  const [debouncedKeyword, setDebouncedKeyword] = useState('');
  const [forecastStatus, setForecastStatus] = useState<'all' | YutaiForecastStatus>('all');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword), KEYWORD_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [keyword]);

  const listState = useAsync(
    () => fetchYutaiForecastList({ rightsDateFrom, rightsDateTo, keyword: debouncedKeyword || undefined, forecastStatus }),
    [rightsDateFrom, rightsDateTo, debouncedKeyword, forecastStatus],
  );

  const sortedTickers = [...(listState.data?.tickers ?? [])].sort(compareByDefaultOrder);

  const table = useReactTable({
    data: sortedTickers,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <>
      <h1 className="page-title">逆日歩予測</h1>
      <p className="page-subtitle">過去の権利日実績から、次回権利日に実際に付きそうな逆日歩を予測します。</p>

      {listState.data && (
        <div className="cutoff-banner">
          <span>📅</span>
          <span>
            当月の権利付き最終日: <strong>{listState.data.currentMonthLastTradableDate}</strong>
          </span>
          {listState.data.poolComputedAt && (
            <span style={{ color: 'var(--text-muted)' }}>(プール統計の計算日: {listState.data.poolComputedAt})</span>
          )}
        </div>
      )}

      <div className="filter-bar">
        <label>
          権利日(開始):{' '}
          <input type="date" className="input" value={rightsDateFrom} onChange={(e) => setRightsDateFrom(e.target.value)} />
        </label>
        <label>
          権利日(終了):{' '}
          <input type="date" className="input" value={rightsDateTo} onChange={(e) => setRightsDateTo(e.target.value)} />
        </label>
        <label>
          キーワード:{' '}
          <input
            className="input"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="会社名・優待内容"
          />
        </label>
        <label>
          判定:{' '}
          <select value={forecastStatus} onChange={(e) => setForecastStatus(e.target.value as typeof forecastStatus)}>
            <option value="all">すべて</option>
            <option value="danger">危険</option>
            <option value="caution">注意</option>
            <option value="safe">安全</option>
            <option value="na">対象外</option>
          </select>
        </label>
      </div>

      {listState.loading && <StatusNote kind="loading" message="読み込み中…" />}
      {listState.error && <StatusNote kind="error" message={`取得に失敗しました: ${listState.error.message}`} />}
      {listState.data && listState.data.tickers.length === 0 && (
        <StatusNote kind="empty" message="条件に一致する優待銘柄がありません。" />
      )}

      {listState.data && listState.data.tickers.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      onClick={header.column.getToggleSortingHandler()}
                      style={{ cursor: header.column.getCanSort() ? 'pointer' : undefined }}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {{ asc: ' 🔼', desc: ' 🔽' }[header.column.getIsSorted() as string] ?? ''}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => navigate(`/yutai/${row.original.ticker}/forecast`)}
                  style={{ cursor: 'pointer' }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className={
                        cell.column.id === 'value' ||
                        cell.column.id === 'maxGyakuhibu' ||
                        cell.column.id === 'rightsDate' ||
                        cell.column.id === 'pOccur' ||
                        cell.column.id === 'forecastP50' ||
                        cell.column.id === 'forecastP90'
                          ? 'num'
                          : cell.column.id === 'content'
                            ? 'cell-wrap'
                            : undefined
                      }
                      style={cell.column.id === 'company' || cell.column.id === 'content' ? { textAlign: 'left' } : undefined}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
```

  行に`onClick`+`cursor: pointer`を付けて行クリックでも遷移できるようにしつつ、銘柄セルは既存パターンどおり`<Link>`のままにする(キーボード操作・右クリックで新規タブが開けるように)。`<Link>`セルの`onClick`は行の`onClick`とバブリングで両方発火するが、`navigate`で同じ遷移先に移動するだけなので実害はない。

- [ ] `frontend/src/main.tsx`: `import { YutaiForecastListPage } from './pages/YutaiForecastListPage';`を追加し、`<Route path="yutai" element={<YutaiListPage />} />`の直後・`<Route path="yutai/:ticker" ...>`の**直前**に`<Route path="yutai/forecast" element={<YutaiForecastListPage />} />`を追加する(react-router-dom v7は静的セグメントを優先するため動作上は順序不問だが、意図を明示するため)
- [ ] `frontend/src/components/Layout.tsx`: `NAV_ITEMS`配列の`{ to: '/yutai', label: '優待クロス' }`の直後に`{ to: '/yutai/forecast', label: '逆日歩予測' }`を追加
- [ ] 手動確認: `npm run dev`(`frontend/`)で起動し、`/yutai/forecast`で当月の権利日範囲に絞られること、判定フィルタが効くこと、行クリック(またはヘッダーソート)が動くこと、行クリックで`/yutai/:ticker/forecast`に遷移すること(Task 8実装前は404/Not Foundでよい、ルーティング自体が正しく発火することだけ確認する)
- [ ] `frontend`ディレクトリで`npm run build`が型エラーなく通ることを確認
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
