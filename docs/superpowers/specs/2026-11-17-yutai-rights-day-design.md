# 月末以外の権利確定日(20日・15日)対応 設計

## 背景

kabuyutai.comの一覧ページでは、権利確定日が月末でない銘柄の権利確定月が
`5月・11月<span class="red-bold">（20日）</span>`のように書かれている。
`parseListPage`の正規表現`【権利確定月】<span class="tousi_price">([^<]+)<\/span>`は
内側の`<span>`で一致しなくなり、該当ブロックを黙って飛ばしていた。
このため、アスクル(2678)・しまむら(8227)・象印(7965)など27銘柄が優待マスタに入っていない
(2026-11-17時点。2664のみ15日、ほかは20日)。

taisyaku.jpには20日締めの権利付き最終日の逆日歩実績がある(実データで確認):

| 銘柄 | 権利付き最終日 | 実績 |
|---|---|---|
| 2678 | 2026-05-18 / 2025-11-18 / 2025-05-16 | 逆日歩あり(1日分、1.5〜2.9円) |
| 8227 | 2026-02-18 | 4日分、平均1.55円 |
| 7965 | 2025-11-18 | 1日分、8円 |

## 方針

優待マスタに`rightsDay`(権利確定日の日付。`null`は月末)を持たせ、
権利付き最終日を計算する関数に渡す。権利月から権利日を計算する今の作りをそのまま広げる。

## 1. 読み込み(`lambda/shared/kabuyutai-client.ts`)

- `KabuyutaiEntry`に`rightsDay: number | null`を足す。
- 権利確定月の`<span class="tousi_price">`の中身を、月の文字列と、任意の`<span class="red-bold">…</span>`に分けて読む。
  - 内側のspanが`（N日）`(全角括弧、Nは1〜31)なら`rightsDay = N`。
  - 内側のspanが無ければ`rightsDay = null`(月末)。
  - 内側のspanがあっても`（N日）`の形でなければ、その銘柄を飛ばし、警告ログを出す(権利日が分からないまま月末扱いで登録しないため)。
- 企業名・優待内容・権利確定月が読めずに飛ばすブロックは、警告ログを出す(読めた範囲で銘柄コードを含める)。今回のような漏れを黙って起こさないため。

## 2. 保存

- `yutai-master-sync-batch`と`yutai-tdnet-watch-batch`の`UpdateCommand`で`rightsDay = :rightsDay`も書く(月末なら`null`)。
  月末に戻った銘柄も`null`で上書きされる。
- 既存行は`rightsDay`を持たない。読む側は欠損・`null`・1〜31の整数以外をすべて月末として扱う。データの移行はしない。

## 3. 権利付き最終日の計算(`lambda/shared/trading-calendar.ts`)

- `rightsDateForMonth(calendar, year, month, rightsDay: number | null)`:
  権利確定日 = その月の`rightsDay`日以前の最後の営業日(`null`ならその月の最後の営業日)。
  権利付き最終日 = 権利確定日の2営業日前。`rightsDay`は必須引数にして、渡し忘れを型エラーで見つける。
- `nextRightsDate(rightsMonths, rightsDay: number | null, today = todayJst())`も同様。
- DynamoDBの値を読む`toRightsDay(value: unknown): number | null`を同じファイルに置く。
- 呼び出し元すべてに`rightsDay`を渡す:
  - `reference-api`(一覧・詳細。一覧のScan射影に`rightsDay`を足す)
  - `lambda/shared/yutai-forecast-detail.ts`(予測詳細API・MCP)
  - `gyakuhibu-forecast-batch`
  - `yutai-risk-precompute-batch`(Scan射影に`rightsDay`を足す)
  - `gyakuhibu-history-batch`(過去の権利付き最終日の候補)

## 4. 画面

- 一覧・詳細に出る権利付き最終日は上の計算結果がそのまま出る。画面のコードは変えない。
- 一覧上部の「当月末の権利付き最終日」の案内は月末の銘柄向けなので変えない。

## 対象外

- `gyakuhibu-forecast-validation`(2026-09-28権利日専用の検証Lambda。月で対象を絞るだけで、権利日は外から受け取る)。
- 1銘柄で月ごとに権利確定日が違うケース(今回の27銘柄にはない)。

## 5. 反映

デプロイ後、master-syncを手動で1回実行して27銘柄をマスタに入れる。
続けて実績取得(`GyakuhibuHistoryBatchFunction`) → リスク計算 → 予測の順に手動で実行する。
条件(必要株数など)は毎週火曜の`yutai-detail-sync`で取り直される。

## テスト

- 読み込み: 日付なし・`（20日）`・`（15日）`・想定外の内側span(飛ばして警告)・読めないブロックの警告。
- 計算: 20日が平日(2026-05 → 2026-05-18)・日曜(2026-09 → 2026-09-16)・祝日(2026-03、3/20春分の日 → 2026-03-17)、15日(2026-05 → 2026-05-13)、`null`は従来どおり月末。
  `toRightsDay`の不正値。
- 書き込み: 両バッチが`:rightsDay`を書く(`null`含む)。
- 読み手: 各バッチ・APIが`rightsDay`付きの行で20日基準の権利付き最終日を使う。実績取得バッチが2025-11-18のような20日基準の過去日を候補に出す。
