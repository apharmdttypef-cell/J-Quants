# 東証信用残ベースの逆日歩予測(現在需給ベース予測)設計書

## 背景

逆日歩予測(`docs/superpowers/specs/2026-09-05-gyakuhibu-forecast-design.md`)は、銘柄自身の**過去の権利日時点**の貸株超過率(taisyaku.jp)でビンを選ぶため、「今年は去年と違って空売りが急増している」という変化を検知できない。J-Quantsスタンダードプランで取得できる東証信用残(`/markets/margin-interest`、2026-09-28から日次配信)と日々公表信用取引残高(`/markets/margin-alert`)は、まさにこの「現在の需給」を表す。

2026-09-09に本番データで実施したバックテスト(`docs/superpowers/notes/2026-09-09-tse-margin-balance-backtest.md`)で以下が確認できた:

- 権利日直前の東証超過率は充足率と順位相関0.64(taisyaku.jp超過率は0.82)。単独でも予測力があるが、taisyaku.jpの代替ではなく補完
- 東証超過率でtaisyaku.jp基準のビン表を引くとリスクを過小評価する(東証で「融資超過」でも36%は逆日歩が発生、taisyaku.jpの同ビンは0%)。**現行の`current-tse`フォールバックはこの過小評価を抱えている**
- 予測力は権利日の1週間前を境に落ち、貸株超過への転換は最終週に集中する。週1回(月曜)取得の現行バッチでは駆け込みを取り逃す
- 4週前比の貸株残の増加率は、水準とは独立した追加シグナルになる(発生率: 減少34%→3倍以上78%)
- 日々公表銘柄(`margin-alert`)は現行バッチが月曜に当日分しか取っていないため蓄積が無く、現時点では評価不能

あわせて、J-Quantsをスタンダードプランからライトプラン(`margin-interest`/`margin-alert`とも利用不可)に変更する可能性があるため、**スタンダードプラン依存の処理・画面を明確に分離し、フラグ1つで停止・非表示にできる**ことを設計の前提条件とする。

## ゴール

1. 東証信用残を入力とする「現在需給ベース予測」を、既存の「過去実績ベース予測」と**並列**に一覧・詳細へ表示する(判定・デフォルトソートは従来どおり過去実績ベース)
2. 貸株残の4週前比(積み上がりペース)を指標として表示する
3. `margin-balance-batch`を日次化し、`margin-alert`も毎営業日取得して蓄積する(将来の日々公表銘柄バッジの土台)
4. 既存予測から`current-tse`フォールバックを外し、過去実績ベース予測をスタンダードプラン非依存にする
5. CDKコンテキスト値1つで、スタンダードプラン依存の処理停止・API応答のnull化・画面非表示をまとめて切り替えられるようにする

## 非ゴール

- 日々公表銘柄のバッジ表示・判定への反映(蓄積後に別途評価・設計する)
- 現在需給ベース予測の判定を既存の判定(過去実績ベース)に統合すること
- 東証信用残とtaisyaku.jp貸借残高を同じ分布に混ぜること(水準が異なるため、別々にキャリブレーションする)
- ビン境界(`BIN_EDGES`)の見直し

## 全体アーキテクチャ

```
margin-balance-batch (毎営業日17:30 JST、フラグ有効時のみスケジュール)
  → JQuantsMarginBalance (ticker/date、source: weekly|daily-alert)  ※構造変更なし

gyakuhibu-forecast-batch (毎日19:40 JST)
  ├─ 過去実績ベース予測(既存、current-tseフォールバック撤去)      → JQuantsGyakuhibuForecast (ticker行 / _POOL_ 行)
  └─ 現在需給ベース予測(新規モジュール、フラグ有効時のみ実行)      → 同テーブル ticker行の tseForecast 属性 / _POOL_TSE_ 行

reference-api
  └─ /yutai/forecast, /yutai/{ticker}/forecast に tseForecast と features.tseMargin を追加(無効時は null / false)

frontend
  └─ features.tseMargin を見て、現在需給の列・カード・信用残トレンドチャートを表示/非表示
```

## フラグと分離境界

### CDKコンテキスト値 `tseMarginFeatures`

- `cdk.json`の`context`に`"tseMarginFeatures": true`を既定値として持つ。`cdk deploy -c tseMarginFeatures=false`で上書きできる(CLIからは文字列`"false"`で渡るため、`lib/j-quants-stack.ts`では`value !== false && value !== 'false'`で判定する)
- 有効/無効で変わるもの:

| 対象 | 有効時 | 無効時 |
|---|---|---|
| `MarginBalanceBatchSchedule`(EventBridgeルール) | 作成 | 作成しない(Lambda自体は残し手動実行は可能) |
| `gyakuhibu-forecast-batch`の環境変数`TSE_MARGIN_FEATURES_ENABLED` | `'true'` | `'false'` → 現在需給モジュールをスキップ、`tseForecast`は書かない |
| `reference-api`の環境変数`TSE_MARGIN_FEATURES_ENABLED` | `'true'` | `'false'` → `features.tseMargin: false`、`tseForecast: null`を返す |
| フロント | 現在需給の列・カード・信用残トレンドを表示 | 非表示 |

- `margin-balance-batch`自身はフラグを見ない(スケジュールの有無で制御する。手動実行はいつでも可能)
- `yutai-risk-precompute-batch`の`hasMarginBalance`(信用残の行が1件でもあれば最大逆日歩を計算する判定)は変更しない。無効化後もテーブルに過去の行が残るため、最大逆日歩の計算は従来どおり動く
- テーブル・データは無効化しても削除しない。再有効化は`-c tseMarginFeatures=true`(または指定なし)で再デプロイするだけ

### 既存予測からの`current-tse`撤去

`lambda/gyakuhibu-forecast-batch/index.ts`の過去実績ベース予測は、`chooseScenario(tickerSamples, nextRightsMonth, null)`のように東証の直近値を渡さず、`'last-rights'`か`'none'`のみになる。`latestMarginBalance()`は過去実績ベース予測から呼ばなくなる(現在需給モジュール側で信用残を一括スキャンするため、per-tickerのQueryも不要になる)。

`lambda/shared/gyakuhibu-forecast.ts`の`chooseScenario`の第3引数と`Scenario`型の`'current-tse'`は残す(現在需給モジュールが`scenario: 'current-tse'`を使う)。既存の`JQuantsGyakuhibuForecast`に残っている`scenario: 'current-tse'`の行は、次回バッチ実行で`'none'`(実績なし)に上書きされる。

## `margin-balance-batch`の日次化

### スケジュール

`lib/j-quants-stack.ts`: `events.Schedule.cron({ minute: '30', hour: '8', weekDay: 'MON-FRI' })`(UTC 08:30 = JST 17:30、JST平日)。J-Quants側の更新は16:30頃(`margin-interest`は週次時代は火曜、`margin-alert`は毎営業日。2026-09-28以降は`margin-interest`も毎営業日に前営業日分)。

### 取得範囲

毎回の実行で:

1. **直近14日ウィンドウ**: 今日から13日前までの各日付について、`fetchAllDailyAlertBalancesForDate(date)`(公表日ベース)と`fetchAllWeeklyBalancesForDate(date)`(データ日付ベース)を呼ぶ。2026-09-28前の`margin-interest`は金曜以外は空配列が返るだけ(無害)。取りこぼした日はこのウィンドウで自動的に埋まる(冪等upsert)
2. **2年分の金曜バックフィル**(既存の`listFridays`ロジック)は、実行日がUTC月曜のとき、または環境変数`FORCE_FULL_BACKFILL=true`のときのみ行う。API呼び出し数を平日1回あたり約28回に抑えるため

呼び出し順は「直近ウィンドウ(新しい日付から)→金曜バックフィル」とし、タイムアウト時にも鮮度の高いデータが先に確保されるようにする(既存の方針を踏襲)。

### 失敗時の扱い

既存の「全呼び出し失敗なら例外」「失敗ゼロなのに0件マッチなら例外」の判定は、直近ウィンドウとバックフィルの合計に対して同じ基準で適用する。

### `source`属性

`margin-interest`由来の点は引き続き`source: 'weekly'`で書く(2026-09-28以降は日次でも同じ値。既存データ・読み取り側との互換のため。意味は「`margin-interest`エンドポイント由来」であることをコードコメントで明記する)。`margin-alert`由来は`'daily-alert'`のまま。

## 現在需給ベース予測(TSE予測)

### 位置づけ

既存の統計モデル(`lambda/shared/gyakuhibu-forecast.ts`の`buildPool`/`forecast`)をそのまま使い、**超過率の入力元だけをtaisyaku.jpの権利日時点残高から東証信用残スナップショットに差し替える**。充足率などの目的変数はtaisyaku.jp実績のまま。

### ラグバケット

権利日までの日数によって東証超過率の意味が変わる(バックテスト: 融資超過ビンの発生率が直前36%→4週前54%)ため、3段階でキャリブレーションする。

| バケット | 条件(スナップショット日→権利日の暦日数 `lagDays`) | サンプル側のスナップショット |
|---|---|---|
| `'0-7'` | 0〜7日 | 権利日以前で最新の点 |
| `'8-21'` | 8〜21日 | 権利日の8日以上前で最新の点 |
| `'22+'` | 22日以上 | 権利日の22日以上前で最新の点 |

スナップショットの探索は「基準日以前で最新、ただし基準日から21日より古い点は無効(欠損扱い)」。

### 新規モジュール `lambda/gyakuhibu-forecast-batch/tse-forecast.ts`

純粋関数は`lambda/shared/gyakuhibu-forecast.ts`に追加し(テスト容易性のため)、I/Oはモジュール側に置く。

**共有純粋関数(`lambda/shared/gyakuhibu-forecast.ts`に追加):**

```ts
export type LagBucket = '0-7' | '8-21' | '22+';
export const LAG_BUCKETS: ReadonlyArray<{ key: LagBucket; minLagDays: number }> = [
  { key: '0-7', minLagDays: 0 },
  { key: '8-21', minLagDays: 8 },
  { key: '22+', minLagDays: 22 },
];
export const SNAPSHOT_MAX_AGE_DAYS = 21;

export interface MarginSnapshot { date: string; financingBalance: number; lendingBalance: number }

// lagDays(スナップショット日→権利日の暦日数)からバケットを決める。
export function lagBucketFor(lagDays: number): LagBucket;

// 日付昇順のpointsから、targetDate以前で最新かつ (targetDate - SNAPSHOT_MAX_AGE_DAYS) 以降の点を返す。無ければnull。
export function snapshotAtOrBefore(points: MarginSnapshot[], targetDate: string): MarginSnapshot | null;

// 4週前比 = snapshot.lendingBalance / base.lendingBalance。
// base は snapshotAtOrBefore(points, snapshotDate - 28日)(同じ21日の鮮度ルールを適用)。
// base が無い、または base.lendingBalance が 0 ならnull。
export function lendingGrowth4w(points: MarginSnapshot[], snapshotDate: string): number | null;

export interface TseForecast extends ForecastResult {
  snapshotDate: string;
  lagDays: number;
  lagBucket: LagBucket;
  financingBalance: number;
  lendingBalance: number;
  lendingGrowth4w: number | null;
}
```

`ForecastResult`の`excessRatio`はスナップショットから`excessRatio(financing, lending)`で計算した値、`scenario`は常に`'current-tse'`。

**モジュール側(`tse-forecast.ts`)の処理:**

1. `JQuantsMarginBalance`を全件スキャンし、ticker→`MarginSnapshot[]`(日付昇順)に整理する。`weekly`と`daily-alert`は同じ系列として結合し、同じ日付が両方にある場合は`daily-alert`を優先する。`financingBalance`/`lendingBalance`が数値でない点は捨てる
2. 過去実績ベースと同じ`allSamples`(`toSample`の結果)を受け取り、各サンプルについて3バケットそれぞれの東証超過率を求める(`snapshotAtOrBefore(points, rightsDate - minLagDays)`)。スナップショットが無いバケットにはそのサンプルは含めない。結果はバケットごとの`ForecastSample[]`(`excessRatio`を東証値に差し替えたもの、`fillRatio`等はそのまま)
3. バケットごとに`buildPool()`で`_POOL_TSE_`行を作る: `{ ticker: '_POOL_TSE_', buckets: { '0-7': PoolBin[], '8-21': PoolBin[], '22+': PoolBin[] }, computedAt }`。`lo`/`hi`は既存の`finiteOrNull`を通す
4. 各銘柄について:
   - `snapshot = snapshotAtOrBefore(points, today)`。無ければ`tseForecast: null`(鮮度切れ・データ無し)
   - `nextRightsDate`が無ければ`null`
   - `lagDays = calendarDaysBetween(snapshot.date, nextRightsDate)`、`lagBucket = lagBucketFor(lagDays)`
   - `forecast({ tickerSamples: そのバケットでの自銘柄サンプル, poolSamples: そのバケットの全サンプル, scenario: 'current-tse', excessRatio: excessRatio(snapshot), maxGyakuhibu, value })`
   - `lendingGrowth4w(points, snapshot.date)`
   - 上記を`TseForecast`にまとめ、`excessRatio`・`lendingGrowth4w`は`finiteOrNull`を通して保存する

`gyakuhibu-forecast-batch/index.ts`は、フラグ有効時のみこのモジュールを呼び、`_POOL_TSE_`行を`_POOL_`行の直後に書き、各銘柄の`PutCommand`の`Item`に`tseForecast`(オブジェクトまたは`null`)を含める。無効時は`tseForecast`属性自体を書かない。

### 計算量

`JQuantsMarginBalance`は約16万行(2年分×約1,600銘柄)。Lambda(256MB)で全件スキャンしてもメモリ・時間とも問題ない想定だが、現行の予測バッチ(約40秒)に数十秒程度上乗せになる。タイムアウトは14分のまま。

## API(`lambda/reference-api/index.ts`)

- 環境変数`TSE_MARGIN_FEATURES_ENABLED`(`'true'`/`'false'`)を読む
- `/yutai/forecast`一覧: 各アイテムに`tseForecast`(下記)を追加。レスポンス直下に`features: { tseMargin: boolean }`を追加
- `/yutai/{ticker}/forecast`詳細: `tseForecast`と`features`を追加
- `tseForecast`の形(`TseForecast`のAPI表現。無効時、または該当行に`tseForecast`が無い/`null`のときは`null`):

```json
{
  "snapshotDate": "2026-09-05",
  "lagDays": 23,
  "lagBucket": "22+",
  "financingBalance": 446,
  "lendingBalance": 11,
  "excessRatio": -0.975,
  "bin": "融資超過",
  "pOccur": 0.54,
  "fillP50": 0.005,
  "fillP90": 0.375,
  "forecastP50": 769,
  "forecastP90": 57660,
  "forecastMean": 19681,
  "expectedNet": -18681,
  "forecastStatus": "caution",
  "tickerSamples": 0,
  "poolSamples": 2100,
  "lendingGrowth4w": 1.1
}
```

既存フィールド(`forecast`、`value`、`maxGyakuhibu`など)と既存の判定ロジックは変更しない。

## 画面

### 一覧(`YutaiForecastListPage.tsx`)

- 列を2つ追加(`features.tseMargin`が`true`のときのみ列定義に含める):
  - **想定逆日歩(現在需給)**: `tseForecast.forecastP50`を四捨五入して円表示。現在需給のビンが過去実績のビンより悪い(ビン順序で後ろ)か、過去実績が`na`で現在需給に値がある場合は末尾に`↑`を付ける。ヘッダーツールチップで意味を説明し、セルのホバーでスナップショット日・超過率・想定逆日歩(最悪)・発生確率・現在需給ベースの判定を表示
  - **貸株残(4週前比)**: `tseForecast.lendingGrowth4w`を`2.3倍`のように表示。`null`は`—`
- 両列とも既存パターン(`sortingFn`でnullを最後尾、`—`表示)に揃える
- 判定列・デフォルトソート(`compareByDefaultOrder`)は変更しない
- ビン順序の比較のため、`BIN_LABELS`(詳細ページに既にある6区分の複製)を一覧側にも持つ(既存方針どおりファイル内複製)

### 詳細(`YutaiForecastDetailPage.tsx`)

- 「現在需給ベース(東証信用残)」のカード群を追加: スナップショット日、超過率、発生確率、想定逆日歩、想定逆日歩(最悪)、判定バッジ、貸株残(4週前比)。`features.tseMargin`が`false`または`tseForecast`が`null`なら表示しない
- 既存の「信用残トレンド(過去1年)」チャートは`features.tseMargin`が`false`のとき非表示にする

### 型(`frontend/src/api/types.ts`)

`TseForecast`型と、`YutaiForecastListItem.tseForecast: TseForecast | null`、`YutaiForecastDetail.tseForecast: TseForecast | null`、`YutaiForecastListResponse.features: { tseMargin: boolean }`、詳細レスポンスの`features`を追加する。

## エラーハンドリング

- 東証スナップショットが無い/古い銘柄は`tseForecast: null`にし、バッチは継続する(既存の銘柄単位try/catchの中で計算する)
- `_POOL_TSE_`の書き込み失敗は既存の`_POOL_`と同じくログに出して例外を投げる(プールが無いと全銘柄の現在需給予測が`na`になるため目立たせる)
- DynamoDBへ書く数値は全て`finiteOrNull`を通す(`excessRatio`の`Infinity`、`lendingGrowth4w`の`Infinity`)
- `margin-balance-batch`の日次ウィンドウで空配列が返る日付(9/28前の非金曜など)は正常扱い

## テスト方針

- `lambda/shared/gyakuhibu-forecast.ts`: `lagBucketFor`の境界(7/8、21/22)、`snapshotAtOrBefore`の「以前で最新」「21日より古い点は無効」、`lendingGrowth4w`の分母0→null、を純粋関数として検証
- `gyakuhibu-forecast-batch`: (a) 過去実績ベースが`current-tse`を返さなくなること、(b) フラグ有効時に`_POOL_TSE_`行が書かれ各銘柄行に`tseForecast`が入ること、(c) フラグ無効時は`_POOL_TSE_`も`tseForecast`も書かれないこと、(d) スナップショット欠損銘柄は`tseForecast: null`、(e) `marshall()`が例外を投げないこと(既存の`Infinity`回帰テストと同様)
- `margin-balance-batch`: 直近14日ウィンドウで両エンドポイントが日付ごとに呼ばれること、UTC月曜/`FORCE_FULL_BACKFILL`のときだけ金曜バックフィルが走ること
- `reference-api`: フラグ有効時に`tseForecast`と`features.tseMargin: true`、無効時に`tseForecast: null`と`features.tseMargin: false`が返ること(一覧・詳細)
- CDK: `tseMarginFeatures=false`で`MarginBalanceBatchSchedule`が生成されないこと(`cdk synth`のテンプレートアサーション)
- フロント: `tsc --noEmit`と`vite build`。実画面は本番デプロイ後に確認

## ロールアウト手順

1. `cdk deploy`(フラグ既定`true`)
2. `margin-balance-batch`を`FORCE_FULL_BACKFILL=true`相当で1回手動実行し、直近14日分の`margin-alert`を埋める(週次2年分は既に蓄積済み)
3. `gyakuhibu-forecast-batch`を手動実行し、`_POOL_TSE_`行と数銘柄の`tseForecast`をDynamoDBで確認
4. フロントをビルド・S3同期・CloudFront無効化
5. 2026-09-28以降、`margin-interest`が日次で入り始めることをCloudWatchログ(`matched N of M`)で確認

## ダウングレード手順(ライトプランへ変更する場合)

```
npx cdk deploy -c tseMarginFeatures=false
```

これだけで、`margin-balance-batch`のスケジュールが削除され、予測バッチは現在需給モジュールをスキップし、APIは`features.tseMargin: false`/`tseForecast: null`を返し、フロントは現在需給の列・カード・信用残トレンドを非表示にする。フロントの再ビルドは不要。テーブルとデータは残る。戻す場合は`-c tseMarginFeatures=true`(または指定なし)で再デプロイする。

## 将来の拡張(このスコープ外)

- 日々公表銘柄バッジ: `margin-alert`が数ヶ月蓄積された後、「権利日前N日以内に日々公表指定あり」の実績を評価してから設計する
- モデルの2軸化(水準×積み上がりペース)
- 東証スナップショットの日次化後、`'0-7'`バケットをさらに細分化(直前1〜2営業日)
