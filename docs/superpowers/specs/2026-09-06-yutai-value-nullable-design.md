# 優待価値nullable化 設計書

## 背景・課題

`yutai-master-sync-batch`は、kabuyutai.comの優待内容テキストから「(◯◯円相当)」という金額表記を正規表現で抽出し、`JQuantsYutaiMaster`の`value`(優待価値)に書き込んでいる。抽出できない場合は「必要投資金額×優待利回り」で近似するフォールバックもあるが、それも失敗した場合、**該当銘柄はマスタへの書き込み自体がスキップされ、アプリ上に一切表示されない**。

実際に2026-09-06時点で503銘柄(全2210件中)がこの理由でスキップされている。代表例が東武鉄道(9001)・西武ホールディングス(9024)で、優待内容が「乗車証◯枚〜」のような枚数表記のみで金額換算されておらず、kabuyutai.com自体が優待利回りを公開していないためフォールバックも効かない。

このような「優待価値が不明なだけで、それ以外のデータ(権利月・信用残・株価)は揃っている」銘柄を、非表示にするのではなく「対象外」として一覧に表示できるようにする。

## ゴール

- 優待価値(`value`)が不明な銘柄も`JQuantsYutaiMaster`に書き込み、優待クロス一覧(`/yutai`)・逆日歩予測一覧(`/yutai/forecast`)の両方に表示する。
- 優待価値が絡む最終判定(リスクのsafe/danger、逆日歩予測のsafe/caution/danger)は、値が無ければ既存の`na`(対象外)にする。**新しいステータス値は追加しない**。
- 優待価値に依存しない計算(最大逆日歩・最高料率・品貸日数・逆日歩予測の統計分布P50/P90/発生確率など)は、優待価値の有無に関わらず今まで通り計算して表示する。ユーザーが自分で判断材料にできるようにするため。

## 非ゴール

- kabuyutai.comから金額を推定するロジック自体の改善(回数券の単価推定など)は別課題とする。今回は「金額が取れなかった銘柄を隠さない」ことが目的で、金額推定の精度向上は扱わない。
- `rightsMonths`(権利確定月)が解析できないケースへの対応。実データでは発生実績が無い(2026-09-06時点のログで0件)ため、現状のスキップ挙動を維持する。

## アーキテクチャ・データフロー

`value: number` を `value: number | null` として一貫して扱うよう、書き込み元から表示まで型を広げる。既存の`maxGyakuhibu: number | null`と同じ「無ければnull、呼び出し側でnullガード」というこのプロジェクトの既存パターンをそのまま踏襲する。

```
yutai-master-sync-batch (書き込み: value: null許容)
  → JQuantsYutaiMaster (value: number | null)
    → yutai-risk-precompute-batch (読み取り・riskStatus計算)
    → gyakuhibu-forecast-batch (読み取り・forecastStatus計算)
    → reference-api (読み取り・API応答)
      → フロントエンド (表示)
```

## コンポーネント別の変更

### 1. `lambda/yutai-master-sync-batch/index.ts`

現在:
```ts
if (entry.value === undefined) {
  console.warn(`${entry.ticker}: could not extract value from content "${entry.content}"; skipping`);
  skipped++;
  continue;
}
```

この`value === undefined`によるスキップを削除し、`rightsMonths`が空の場合のスキップのみ残す。`UpdateExpression`の`:value`には`entry.value ?? null`を渡す(DynamoDBは`undefined`を許容しないため明示的に`null`に変換する)。

### 2. `lambda/yutai-risk-precompute-batch/index.ts`

`scanYutaiMaster()`の行フィルタ条件から`typeof item.value === 'number'`を外し、`value: number | null`として読み込む(`typeof item.value === 'number' ? item.value : null`)。

`calcRisk()`内の最終行:
```ts
const riskStatus: RiskStatus = row.value > maxGyakuhibu ? 'safe' : 'danger';
```
を
```ts
const riskStatus: RiskStatus = row.value === null ? 'na' : row.value > maxGyakuhibu ? 'safe' : 'danger';
```
に変更する。`maxGyakuhibu`/`maxRate`/`days`の計算自体(`closePrice`・`unitShares`・`days`のみに依存)は変更しない。

### 3. `lambda/shared/gyakuhibu-forecast.ts`

`forecast()`の引数`value: number`を`value: number | null`に変更する。判定ブロック:
```ts
if (maxGyakuhibu !== null) {
  forecastP50 = fillP50 * maxGyakuhibu;
  forecastP90 = fillP90 * maxGyakuhibu;
  forecastMean = fillMean * maxGyakuhibu;
  expectedNet = value - forecastMean;
  status = forecastStatus(value, forecastP50, forecastP90);
}
```
を
```ts
if (maxGyakuhibu !== null) {
  forecastP50 = fillP50 * maxGyakuhibu;
  forecastP90 = fillP90 * maxGyakuhibu;
  forecastMean = fillMean * maxGyakuhibu;
  if (value !== null) {
    expectedNet = value - forecastMean;
    status = forecastStatus(value, forecastP50, forecastP90);
  }
}
```
に変更する。`forecastP50`/`forecastP90`/`forecastMean`(優待価値に依存しない、逆日歩の予測金額そのもの)は`maxGyakuhibu`さえあれば計算を継続し、`expectedNet`/`status`(優待価値との比較が必要な項目)だけ`value === null`なら`null`/`'na'`のままにする。

### 4. `lambda/gyakuhibu-forecast-batch/index.ts`

`scanYutaiMaster()`の行フィルタから`typeof item.value === 'number'`を外し、`MasterRow.value`を`number | null`にする(`typeof item.value === 'number' ? item.value : null`)。`forecast()`への`value`引数はそのまま渡す(既に`number | null`を受け付けるよう③で変更済み)。

### 5. `lambda/reference-api/index.ts`

以下の型宣言の`value: number`を`value: number | null`に変更する:
- `YutaiMasterRow`(`/yutai`系エンドポイントの内部表現)
- `/yutai/forecast`系のリストアイテム・詳細レスポンスの`value`フィールド

`scanYutaiMaster()`(API側)は元々`typeof`チェックをしていないため、書き込み側(①)が直ればそのまま`null`を含む行も素通りする。レスポンス組み立て箇所の`value: row.value` / `value: master.value`はそのまま(型が緩むだけで代入コード自体は変更不要)。

### 6. フロントエンド

以下の型定義の`value: number`を`value: number | null`に変更する(`frontend/src/api/types.ts`):
- `YutaiListItem`
- `YutaiForecastListItem`
- (`/yutai/:ticker`・`/yutai/:ticker/forecast`の詳細レスポンス型に`value`があれば同様に変更)

表示箇所(`YutaiListPage.tsx`・`YutaiForecastListPage.tsx`の「優待価値」列、および両詳細ページ)で、`formatFinancialYen(String(row.original.value))`のような直接呼び出しを、既存の`maxGyakuhibu`列と同じパターン(`row.original.value !== null ? formatFinancialYen(String(row.original.value)) : '—'`)でnullガードする。

判定バッジ(`risk-badge`/`FORECAST_STATUS_LABEL`)・ソート順(`RISK_SORT_RANK`/`FORECAST_STATUS_SORT_RANK`)は既に`na`を最後尾として扱っており、変更不要。

## エラーハンドリング

新規に例外が発生しうる箇所は無い(全てnull許容への型拡張と、既存パターンと同じnullガードの追加のみ)。DynamoDBへの書き込みは`undefined`ではなく明示的に`null`を渡すことで、`marshall`が拒否する対象(`undefined`はキー除外、`NaN`/`Infinity`はエラー)のいずれにも該当しない。

## テスト方針

- `yutai-master-sync-batch`: `value`が抽出できないentryでも(rightsMonthsが解析できれば)upsertされ、`value: null`が書き込まれることをテストする。
- `yutai-risk-precompute-batch`: `value: null`の行に対し、`maxGyakuhibu`等は計算されつつ`riskStatus: 'na'`になることをテストする。
- `lambda/shared/gyakuhibu-forecast.ts`の`forecast()`: `value: null`かつ`maxGyakuhibu`が有効な場合、`forecastP50`/`forecastP90`は非null、`expectedNet`は`null`、`forecastStatus`は`'na'`になることをテストする(既存のP50/P90ロジックへの回帰が無いことも合わせて確認)。
- `reference-api`: `value: null`の行が一覧・詳細の両方でエラー無く返り、`value: null`としてレスポンスに含まれることをテストする。
- フロントエンド: 型チェック(`tsc --noEmit`)通過に加え、`value === null`の行を含むデータでの一覧・詳細ページのレンダリングをテストする(「優待価値」列が「—」になること)。
