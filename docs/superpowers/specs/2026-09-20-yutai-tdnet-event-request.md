# 依頼書: 優待開始・廃止情報の一覧表示画面

> これはユーザーから提示された依頼書の原文です。ブレインストーミングを経た最終設計は
> 別ファイル(`docs/superpowers/specs/2026-09-20-yutai-tdnet-event-design.md`、未確定事項の
> 決定を反映)にまとめます。

## 背景・目的

`yutai-tdnet-watch-batch`（週次Lambda）は、TDnetの開示情報から株主優待関連（新設・一部変更・廃止）のキーワードを検知し、該当銘柄を`kabuyutai.com`で再取得して`JQuantsYutaiMaster`テーブルへupsert（廃止の場合はdelete）している。

しかし、**この「検知したイベント」自体は永続化されていない**。バッチはマスタテーブルを直接更新するだけで、処理後は`console.log`に出力されて消える。そのため、「最近どの銘柄で優待の開始・廃止があったか」を後から確認する手段が現状存在しない。

本依頼は、このイベントを永続化し、一覧表示する読み取り専用画面を追加すること。

## スコープ

- 対応する: TDnet監視で検知した優待関連イベント（開始・変更・廃止）の記録と一覧表示
- 対応しない: イベントの手動編集・削除機能、通知（メール等）、ページネーション（バッチは週次実行かつ検知件数が少数と想定されるため、初期実装では全件表示でよい。件数が増えてきたら別途対応）

## 対応方針

### 1. DynamoDBテーブル追加: `JQuantsYutaiTdnetEvent`

`yutai-tdnet-watch-batch`が検知したイベントを1件1レコードとして記録する新規テーブル。

**想定スキーマ**

| 属性 | 型 | 説明 |
|---|---|---|
| `eventId` (PK) | string | 一意なID。例: `{ticker}#{disclosureDate}#{title のハッシュ}` など、同一開示の再処理でも重複が増えない形にする |
| `ticker` | string | 4桁ティッカー |
| `companyName` | string | 会社名（TDnet開示時点の表記） |
| `eventType` | string | `start`(新規登録) / `update`(一部変更) / `abolition`(廃止) のいずれか。既存コードの`isAbolitionRelated`判定と、マスタへの新規登録/更新/削除の分岐ロジックに対応させる |
| `disclosureTitle` | string | TDnet開示タイトル原文（例:「株主優待制度の廃止に関するお知らせ」） |
| `disclosedAt` | string (ISO date) | 開示日（`YYYYMMDD` → ISO形式に変換） |
| `recordedAt` | string (ISO datetime) | バッチがこのレコードを書き込んだ日時 |

**GSI**: `disclosedAt`降順で一覧取得したいため、`disclosedAt`をソートキーにしたGSI、またはPKを固定値（例: `"ALL"`）にしたシンプルなテーブル構成のどちらかを検討。件数が少ない前提なら後者で十分。

**冪等性の考慮**: バッチは`LOOKBACK_DAYS`（9日）分を毎回再走査するため、同一開示を複数回処理する。`eventId`を開示内容から一意に導出することで、再実行時は同じレコードを上書きするだけにし、重複エントリを防ぐ。

### 2. `yutai-tdnet-watch-batch`の改修

既存の`matchedTickers`処理ループ内、マスタテーブルへのupdate/delete処理に加えて、`JQuantsYutaiTdnetEvent`への書き込みを追加する。

- 対象: `isYutaiRelated(title)`に一致した開示（現状の検知ロジックはそのまま流用）
- `eventType`の判定: 既存の`sawAbolitionAlready` / `isAbolitionRelated`判定結果と、マスタに既存エントリがあるかどうか（`listingsByTicker.get(ticker)`の有無）を組み合わせて決定
  - マスタ未登録 → `start`
  - マスタ既存 かつ 廃止キーワードなし → `update`
  - 廃止キーワードあり（マスタから削除した場合） → `abolition`
- 1つの開示につき1イベントとして記録する（同一tickerで複数開示がマッチした場合の重複排除は、既存の`matchedTickers`のMap構造を踏襲）
- 既存のテストスイート（`test/yutai-tdnet-watch-batch.test.ts`）に、イベントテーブルへの書き込みを検証するケースを追加

### 3. API追加: `GET /yutai/tdnet-events`

- `JQuantsYutaiTdnetEvent`を`disclosedAt`降順で返す読み取り専用エンドポイント
- 既存の認証（Lambdaオーソライザーによる`x-app-password`チェック）をそのまま適用
- レスポンス例:

```json
{
  "events": [
    {
      "ticker": "2157",
      "companyName": "コシダカホールディングス",
      "eventType": "update",
      "disclosureTitle": "株主優待制度の一部変更に関するお知らせ",
      "disclosedAt": "2026-09-08",
      "recordedAt": "2026-09-08T21:03:00Z"
    }
  ]
}
```

### 4. フロントエンド追加: `/yutai/tdnet-events`

- 一覧表示のみ（検索・フィルタ・詳細ページ遷移は今回スコープ外）
- 表形式で以下を表示: 開示日 / 銘柄コード / 会社名 / 種別（開始・変更・廃止のバッジ表示） / 開示タイトル
- `eventType`ごとに色分け（例: 開始=青、変更=グレー、廃止=赤）してひと目で分かるようにする
- 既存の`/yutai`画面からのリンクを追加（ナビゲーションに組み込む）
- 既存のデザイン規約（`JetBrains Mono`のtabular-nums、日本市場慣例の配色）に合わせる

## 未確定事項（実装時に判断・要相談）

- `eventId`の具体的な生成ルール（開示タイトル+日付+tickerのハッシュ化 or 他の方式）
- GSI構成 vs シンプルなPK固定構成のどちらを採るか（想定データ量次第）
- 一覧の表示件数上限（当面は全件表示でよいか、直近N件に絞るか）

## 参考（既存実装）

- `lambda/yutai-tdnet-watch-batch/index.ts` — 検知・判定ロジック本体
- `docs/superpowers/notes/2026-08-20-tdnet-list-page-format.md` — TDnetページ構造の調査メモ
- `docs/superpowers/specs/2026-08-20-yutai-master-automation-design.md` — 既存の優待マスタ自動化設計
- `frontend/` の `/yutai` 画面群 — デザイン・実装パターンの参考
