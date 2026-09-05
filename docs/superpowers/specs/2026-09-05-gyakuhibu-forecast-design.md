# 逆日歩予測(貸株超過率 → 実績逆日歩)設計書

既存の優待クロス機能(`/yutai`, `/yutai/:ticker`)は「最高料率(=入札の上限)で決着した場合の**最大**逆日歩」を見積もる。本機能はその上に「過去の権利日で、貸株超過がどれだけあったときに上限の何割まで実際に付いたか」の実績曲線を重ね、**次回権利日に実際に付きそうな逆日歩の分布(発生確率・中央値・P90)**を予測して、優待価値との差し引きでリスクを可視化する。

## 背景・目的

- 最大逆日歩は上限であり、実際の品貸料率は毎日の入札で決まる変動相場。流動性の高い銘柄では権利日でも0円のことが多く、上限だけ見ると「危険」判定が過剰になる。逆に注意喚起・申込制限のかかった銘柄では上限(4倍〜10倍)まで張り付く。
- 予測に必要な「権利日時点の融資残高・貸株残高・差引残高・貸借値段・最高料率・応札ランク・制限措置」は、`gyakuhibu-history-batch`が**すでに毎日ダウンロードしているtaisyaku.jpのCSVに含まれている**が、現状の`parseTaisyakuCsv`は権利日1行の「品貸料率・品貸日数」しか取り出しておらず、残りの列を捨てている。
- 逆日歩を直接決めるのは**日本証券金融の貸借残高(証金残)**であり、J-Quantsの`mkt-margin-int`(東証全体の信用残・週次、2026-09-28から日次)は「権利日に向けて超過が膨らむか」の先行指標として位置づける。両者は水準が異なるため同じ曲線に混ぜない。

本アプリは個人用。YAGNIで進め、統計モデルは「ビン別の経験分布＋銘柄実績への縮小推定」に留める(回帰・機械学習は使わない)。

## ユーザー決定事項(2026-09-05)

| 論点 | 決定 |
|---|---|
| 画面の置き方 | 新規の**予測付き一覧画面**(`/yutai/forecast`)と、新規の**銘柄別予測画面**(`/yutai/:ticker/forecast`)を追加。既存`/yutai/:ticker`には予測画面へのリンクを1つ足すだけ |
| 実績曲線の学習データ | **権利日のみ**(権利付き最終日は4倍倍率・優待クロス需要で需給が特殊なため、通常日を混ぜない) |
| 進め方 | 設計書＋実装計画まで一気に作成し、順次実装 |

## スコープ

**含む**:
- `parseTaisyakuCsv`を拡張し、権利日行の残高・貸借値段・最高料率・応札ランク・制限措置列を取り出す
- `JQuantsGyakuhibuActual`にそれらの列を追加保存し、既存行(列が無い行)を日次バッチで順次再取得して埋める(バックフィル)
- 純粋関数の予測ロジック(`lambda/shared/gyakuhibu-forecast.ts`)
- 日次の予測事前計算バッチ(`gyakuhibu-forecast-batch`)と保存先テーブル(`JQuantsGyakuhibuForecast`)
- API `GET /yutai/forecast`, `GET /yutai/{ticker}/forecast`
- フロント `/yutai/forecast`(一覧), `/yutai/:ticker/forecast`(詳細)、ナビ追加、既存詳細画面へのリンク追加

**含まない(方針決定済み)**:
- 通常営業日(非権利日)の実績を使った曲線(ユーザー決定により権利日のみ)
- 日証金の**直近**スナップショット(権利日前の"今"の証金残)の取得。現在需給シナリオはJ-Quants信用残(東証ベース)で代替し「参考」扱いとする。必要になったら別スコープ(taisyaku.jp `POST /app/stock/search`が`mgrCd[]`で複数銘柄を1リクエストで返せるかの検証から)
- 注意喚起・申込制限などの**将来の**規制指定の予測(日証金が随時指定するもので事前予測不能)。過去権利日にそれが付いていたかは説明変数として保存・表示はする
- 回帰モデル・ML・信頼区間の厳密な推定。サンプル数(銘柄あたり直近3年で2〜9点)に対して過剰
- 既存の`riskStatus`(最大逆日歩ベース)の意味変更。既存判定はそのまま残し、新しい`forecastStatus`を別フィールドとして並べる

## アーキテクチャ

```
EventBridge(毎日 JST19:00、既存)
  → GyakuhibuHistoryBatchFunction(既存、拡張)
      - taisyaku.jp CSVの権利日行から残高・貸借値段・最高料率・応札ランク・制限措置も取り出す
      - 未取得 or 未拡張(enriched≠true)の権利日を順次取得
      → JQuantsGyakuhibuActual に upsert(列追加)

EventBridge(毎日 JST18:40、新規。YutaiRiskPrecompute(18:20)の後)
  → GyakuhibuForecastBatchFunction(Lambda、新規)
      - JQuantsGyakuhibuActual を全件スキャン(enriched行のみ採用)
      - 全銘柄プールの「貸株超過率ビン → 充足率分布」を作る
      - 銘柄ごとに次回権利日の超過率シナリオを決め、銘柄実績とプールを縮小推定でブレンドして
        発生確率・充足率P50/P90 → 予測逆日歩P50/P90 → forecastStatus を算出
      → JQuantsGyakuhibuForecast に upsert(銘柄行 + プール曲線行 `_POOL_`)

ブラウザ
  → GET /yutai/forecast, GET /yutai/{ticker}/forecast(読み取り専用)
```

予測計算はリクエスト時ではなく事前計算(サブプロジェクトCで確立した方式)。`reference-api`は保存済みの値を読むだけ。

## データモデル

### `JQuantsGyakuhibuActual`(既存、列追加)

PK `ticker` / SK `rightsDate`。既存列`totalAmount`/`days`/`avgRate`/`noGyakuhibu`はそのまま。以下を追加:

| 列 | 型 | 内容(taisyaku.jp CSV列) |
|---|---|---|
| `financingBalance` | number | 融資残高(株) |
| `lendingBalance` | number | 貸株残高(株) |
| `lendingPrice` | number \| null | 貸借値段(円) |
| `maxRateActual` | number \| null | 最高料率(品貸日数分/円)。**倍率適用済みの実値**(9418の検証で4倍が入っていることを確認済み)なので、自前の`calcMaxRate×4`ではなくこちらを充足率の分母に使う |
| `bidRank` | string \| null | 応札ランク |
| `restriction` | string \| null | 制限措置(注/制/停 等) |
| `emergencyMeasure` | string \| null | 臨時措置(4/10 等) |
| `enriched` | boolean | 上記列を取得済みなら`true`。バックフィル対象判定に使う |

派生値(保存せず計算):
- `excessShares = lendingBalance - financingBalance`(貸株超過株数。正=貸株超過)
- `excessRatio = excessShares / financingBalance`(`financingBalance = 0`かつ`lendingBalance > 0`なら`+Infinity`扱い=最上位ビン、両方0なら`null`)
- `fillRatio = (avgRate × days) / maxRateActual`(0〜1。`noGyakuhibu`行は0。`maxRateActual`が無い行は学習から除外)

**差引残高列の符号**: CSVの「差引残高」は融資−貸株か貸株−融資かを実機で未確認のため、保存はするが計算には使わず、必ず`lendingBalance - financingBalance`で自前計算する(実装時に符号を確認し、notesに残す)。

### `JQuantsGyakuhibuForecast`(新規、PK `ticker`)

毎日全件再計算される派生データでRETAIN必須ではないが、`JQuantsWatchlistTable`と同じ理由(「消えても復旧できるが、他テーブルと運用を揃えるため同じ方針にする」)で`RemovalPolicy.RETAIN`+PITR有効・オンデマンド課金にする(既存6テーブルは例外なく全てこの方針)。

銘柄行:

| 列 | 内容 |
|---|---|
| `rightsDate` | 評価対象の次回権利付き最終日 |
| `scenario` | `last-rights`(前回権利日並み) \| `current-tse`(現在の東証信用残から、参考) \| `none` |
| `excessRatio` | シナリオで採用した貸株超過率 |
| `bin` | 採用ビンのラベル |
| `pOccur` | 逆日歩発生確率(充足率>0の割合) |
| `fillP50` / `fillP90` / `fillMean` | 充足率の分位・平均(0〜1) |
| `forecastP50` / `forecastP90` / `forecastMean` | 予測逆日歩(円) = 充足率 × `maxGyakuhibu`(既存マスタの最大逆日歩) |
| `forecastStatus` | `safe` \| `caution` \| `danger` \| `na` |
| `tickerSamples` / `poolSamples` | 根拠サンプル数 |
| `computedAt` | 計算日 |

プール行(`ticker = '_POOL_'`): `bins: [{ label, lo, hi, n, pOccur, fillP50, fillP90, fillMean }]` と `computedAt`。散布図・感度表に使う。

## 予測ロジック(`lambda/shared/gyakuhibu-forecast.ts`、純粋関数)

### 1. サンプル

`JQuantsGyakuhibuActual`の`enriched === true`かつ`maxRateActual > 0`の行を1サンプルとする。
`{ ticker, rightsDate, month, excessRatio, fillRatio, regulated: restriction/emergencyMeasureが空でない }`。

### 2. プール曲線(全銘柄)

貸株超過率のビン(固定):

| label | 範囲 |
|---|---|
| `融資超過` | `excessRatio < 0` |
| `0〜0.5` | 0 ≤ r < 0.5 |
| `0.5〜1` | 0.5 ≤ r < 1 |
| `1〜2` | 1 ≤ r < 2 |
| `2〜5` | 2 ≤ r < 5 |
| `5以上` | r ≥ 5(`+Infinity`含む) |

ビンごとに `n`, `pOccur = #(fill>0)/n`, `fillP50`, `fillP90`, `fillMean`(**ゼロを含む全サンプル**で計算。発生しなかった権利日を除くと過大評価になる)。

### 3. 銘柄別の予測分布(縮小推定)

同銘柄のサンプル `T`(件数 `n_t`)と、採用ビンのプールサンプル `P`(件数 `n_p`)を重み付きで混ぜ、加重分位点を取る:

```
w = n_t / (n_t + K)      K = 4(縮小の強さ。銘柄実績が4件あればプールと半々)
銘柄サンプル1件の重み = w / n_t
プールサンプル1件の重み = (1 - w) / n_p
```

- `n_t = 0` → プールのみ(`w = 0`)
- `n_p = 0`(ビンにサンプルが無い)→ 銘柄のみ。両方0なら`na`

同銘柄のサンプルは超過率で条件付けしない(件数が少なく、同銘柄・同月の季節性のほうが強いため)。

### 4. 超過率シナリオ

1. `last-rights`: 同銘柄の過去権利日サンプルのうち、**同じ月**があれば直近のものの`excessRatio`、無ければ直近の権利日の`excessRatio`
2. `current-tse`(1が無い場合のみ): `JQuantsMarginBalance`の直近行から `(lendingBalance - financingBalance) / financingBalance`。東証ベースで証金残とは水準が違うため、画面では「参考」バッジを付ける
3. どちらも無ければ`scenario = 'none'`、ビンなし(縮小推定は銘柄サンプルのみ、それも無ければ`na`)

### 5. 金額化と判定

```
forecastP50  = fillP50  × maxGyakuhibu   (maxGyakuhibuは既存マスタの値。倍率4・品貸日数込み)
forecastP90  = fillP90  × maxGyakuhibu
forecastMean = fillMean × maxGyakuhibu

forecastStatus =
  na       : maxGyakuhibu が無い、またはサンプルが無い
  safe     : value > forecastP90        (9割のケースで優待価値が逆日歩を上回る)
  caution  : forecastP50 < value ≤ forecastP90
  danger   : value ≤ forecastP50
```

`expectedNet = value - forecastMean` も返す(一覧のソートキー候補)。

### 6. 感度表

採用ビンとその上下のビンについて `pOccur / forecastP50 / forecastP90` を並べる(「超過が1段階膨らんだら」を見せる)。プール行の`bins`から画面側で計算できるためAPIには持たせない。

## 既存バッチの変更: `gyakuhibu-history-batch`

- `parseTaisyakuCsv(csv, rightsDate, unitShares, ticker)` の戻り値を拡張。権利日行が存在すれば**品貸料率が数値としてparseできなくても**(`'-'`・`'*****'`等。Task 0の実機確認で`'*****'`という想定外マーカーも見つかっている。差引残高がちょうど0になる境界日にだけ出現)`{ occurred: false, totalAmount: 0, days: 0, avgRate: 0, ...残高列 }`を返し、`undefined`は「対象日の行がCSVに無い」場合だけにする。呼び出し側は`occurred === false`のとき従来どおり`noGyakuhibu: true`を立てて保存する(既存API・ツールチップの挙動は不変)
- 全フィールドがダブルクォートで囲まれていることは実機で確認済み(`stripQuotes`は既存踏襲)。数値列の桁区切りカンマはTask 0で3ヶ月・63行(最大約200万)を確認した限り一度も観測されなかったため、実在は未確認。ただし`split(',')`を**クォートを考慮した簡易パーサ**(クォート内のカンマを区切りと見なさない)に置き換えること自体は無害な防御なので、実装は予定通り行う。既存の「列数不一致ならスキップ」ガードは残す
- `alreadyFetched` → `isEnriched`: `enriched === true`、または行が存在し`checkedAt`が30日以内なら(残高が取れなかった行を毎日再スクレイピングしないため)スキップ。既存行(列なし)は自然に再取得対象になる。既存行は約5,000件見込みで、`MAX_GYAKUHIBU_FETCHES_PER_RUN`=200のままだと約25日かかるため、バックフィル期間中だけCDKの環境変数を500〜1,000に上げ、完了後に戻す(コード変更不要)
- 列名は実CSVで確認して`findIndex`のマーカーを合わせる(`融資`/`貸株`は「新規/返済/残高」の3列があるため、ヘッダー内に`残高`を含む列を選ぶ)。ヘッダーが想定と違えば例外にして翌日以降に気づけるようにする(既存踏襲)

## API

### `GET /yutai/forecast`

クエリ: `rightsDateFrom`, `rightsDateTo`(デフォルト当月)、`keyword`, `forecastStatus`(`safe|caution|danger|na|all`)。既存`GET /yutai`のフィルタ実装を共用する。

レスポンス:
```json
{
  "currentMonthLastTradableDate": "2026-09-28",
  "poolComputedAt": "2026-09-05",
  "tickers": [{
    "ticker": "9418", "companyName": "…", "content": "…", "value": 3000, "unitShares": 100,
    "rightsDate": "2026-09-28",
    "maxGyakuhibu": 5760, "riskStatus": "danger",
    "forecast": {
      "scenario": "last-rights", "excessRatio": 1.8, "bin": "1〜2",
      "pOccur": 0.67, "fillP50": 0.25, "fillP90": 0.9,
      "forecastP50": 1440, "forecastP90": 5184, "forecastMean": 2100, "expectedNet": 900,
      "forecastStatus": "caution", "tickerSamples": 3, "poolSamples": 412
    }
  }]
}
```

実装: `scanYutaiMaster`(既存)＋`JQuantsGyakuhibuForecast`の全件スキャン1回をメモリ上で結合(1,233件規模で2スキャン、10秒タイムアウトに収まる)。`/yutai/{ticker}`との経路衝突はHTTP APIが完全一致ルートを優先するため問題ないが、スタックテストでルートキーの存在を確認する。

### `GET /yutai/{ticker}/forecast`

```json
{
  "ticker": "9418", "companyName": "…", "value": 3000, "unitShares": 100, "rightsDate": "2026-09-28",
  "maxGyakuhibu": 5760,
  "forecast": { …上と同じ… },
  "history": [{
    "rightsDate": "2025-09-26", "excessRatio": 1.6, "excessShares": 120000,
    "financingBalance": 75000, "lendingBalance": 195000, "lendingPrice": 1700,
    "fillRatio": 0.5, "totalAmount": 2880, "maxRateActual": 57.6, "bidRank": "A",
    "restriction": null, "emergencyMeasure": null, "occurred": true
  }],
  "poolBins": [{ "label": "1〜2", "lo": 1, "hi": 2, "n": 412, "pOccur": 0.61, "fillP50": 0.2, "fillP90": 0.85, "fillMean": 0.31 }],
  "marginTrend": { "latest": { "date": "…", "financingBalance": 0, "lendingBalance": 0 } }
}
```

`history`は`noGyakuhibu`行も含めて返す(散布図に0点を打つため。既存`/yutai/{ticker}`の`rightsHistory`は従来どおり除外したまま)。

## 画面構成

### `/yutai/forecast`(一覧、新規)

既存`/yutai`と同じレイアウト(バナー・権利日範囲・キーワード・`@tanstack/react-table`)で、列を以下にする:

銘柄 / 優待内容 / 優待価値 / 権利日 / 最大逆日歩(既存) / **発生確率** / **予測(中央値)** / **予測(P90)** / **判定** / 根拠(`銘柄3件+市場412件`、`参考`バッジ)

- 判定バッジ: `safe`=安全(緑系)、`caution`=注意(黄)、`danger`=危険(赤)、`na`=対象外。既存`risk-badge`のクラスを流用し`caution`用のスタイルを1つ追加
- デフォルトソート: 判定(危険→注意→安全→対象外)→`expectedNet`昇順
- 行クリックで`/yutai/:ticker/forecast`へ
- グローバルナビに「逆日歩予測」を追加

### `/yutai/:ticker/forecast`(詳細、新規)

上から順に:

1. **見出し**: 銘柄名・コード、`/yutai/:ticker`と`/tickers/:ticker`への相互リンク
2. **予測サマリカード**(4枚横並び、モバイルは2×2): 発生確率 / 予測逆日歩(中央値) / 予測逆日歩(P90) / 優待価値との差(P90ベース)。下段に「最大逆日歩(上限)」と判定バッジ、シナリオ表示(`前回同月の超過率 1.8 を採用` or `東証信用残ベース(参考)`)
3. **散布図**(recharts `ScatterChart`): x=貸株超過率(対数っぽく見せるため`5以上`は5.5にクリップ、`融資超過`は−0.5にクリップ)、y=充足率。プール全サンプルを薄い灰の小点、同銘柄のサンプルを赤の大点(ホバーで権利日・実績額)、採用超過率に`ReferenceLine`(縦)。プール点は`_POOL_`行には無いため、詳細APIの`poolBins`だけで描く場合は「ビン中央×P50/P90の折れ線」で代替する(**初期実装はこの折れ線**。個票の散布はサンプル数が数千件でレスポンスが重くなるため、必要なら別途)
4. **過去権利日テーブル**: 権利日 / 融資残 / 貸株残 / 超過株数 / 超過率 / 実績逆日歩 / 上限 / 充足率 / 応札 / 規制。0円の権利日も行として出す(灰色)
5. **感度表**: 採用ビンの前後を含む3〜6行、`超過率レンジ / 発生確率 / 予測P50 / 予測P90 / 優待価値との差`
6. **信用残トレンド**(既存`/yutai/{ticker}/margin-trend`をそのまま呼び、既存グラフを再利用。過去権利日に`ReferenceLine`を縦に引く)

### 既存`/yutai/:ticker`への変更

「逆日歩リスク計算」カードの見出し右に「予測を見る →」リンクを1つ追加するのみ。

## エラーハンドリング方針

- CSVの権利日行に残高列が空・非数値: その行は`enriched: false`のまま保存せず、ログのみ(翌日再試行。既存踏襲)
- `maxRateActual`が0または欠損: 充足率が定義できないため学習サンプルから除外(表示の`history`には出す)
- 予測バッチは銘柄ごとにtry/catchして継続。`_POOL_`行の書き込みは銘柄ループの前に行う(プールが無いと全銘柄`na`になるため、失敗時はログで目立たせる)
- 予測未計算(初回バッチ前)の銘柄は一覧・詳細とも`forecastStatus: 'na'`・「予測計算中」の表示

## テスト方針

- `parseTaisyakuCsv`: 既存テストに加え、(a)残高列がクォート付き桁区切りで入っている行を正しく読む、(b)品貸料率`-`の行で`occurred: false`と残高が返る、(c)行自体が無いと`undefined`
- `gyakuhibu-forecast.ts`: 純粋関数のユニットテストを重点的に。`excessRatio`の境界(融資残0)、ビン境界(0.5ちょうど等)、加重分位点(`n_t=0`→プールと一致、`n_p=0`→銘柄と一致、`n_t=4`で重み0.5)、`forecastStatus`の境界(`value == forecastP90`は`caution`)、シナリオ選択(同月優先→直近→東証→none)
- `gyakuhibu-history-batch`: `isEnriched`分岐(既存行だが`enriched`無し→再取得する)
- `gyakuhibu-forecast-batch`: DynamoDBモックで「プール行→銘柄行の順に書く」「1銘柄失敗しても継続」
- `reference-api`: 2ルートのレスポンス形とフィルタ
- CDKスタック合成テスト: 新テーブル・Lambda・スケジュール・2ルート
- フロントは既存同様手動確認

## 実装後に確認・記録すること(notes)

- taisyaku.jp CSVの実際の列名(融資/貸株の「残高」列の見分け方)と「差引残高」の符号
- バックフィル完了までの日数と、完了後の`MAX_GYAKUHIBU_FETCHES_PER_RUN`の戻し
- プールのビン別サンプル数の実測。`5以上`や`融資超過`が極端に少なければビン境界を見直す(境界は定数化しておく)
- 9418(2026-08)・既知の高逆日歩銘柄で、予測P90が実績を包含していたかの事後検証

## スコープ外(保留事項)

- 日証金の直近スナップショット取得(現在需給シナリオの精度向上)
- 通常営業日サンプルの併用
- 通知(予測が`danger`に変わったら知らせる等)
- 権利日の2倍期間(権利落6〜2営業日前)を跨ぐ保有への対応(現状は権利付き最終日の1日分のみ評価。既存設計踏襲)
