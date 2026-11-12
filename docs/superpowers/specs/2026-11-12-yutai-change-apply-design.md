# 優待変更情報の反映(条件の自動取り直し・廃止予告) 設計

## 背景・目的

`yutai-tdnet-watch-batch`(毎週月曜 JST 21:00)は、TDnetの優待関連開示を検知すると
kabuyutai.comの一覧から取り直して`JQuantsYutaiMaster`を上書きし、廃止(廃止キーワード+
kabuyutai.comから消えた)なら行を削除している。本番データ(2026-11-04時点、イベント137件・126銘柄)
で確認したところ、マスタ本体への反映はできていたが、次の2点が漏れていた。

1. **優待条件の取り直しが止まっている。** TDnetバッチは`conditionCheckedAt`を消して
   `yutai-detail-sync-batch`に取り直しを任せるが、detail-syncのステートマシンにはスケジュールが無く
   手動運用のまま(`2026-10-02-yutai-detail-sync-runbook.md`で保留)。マスタ1,639件のうち48件が
   取り直し待ちで、10/5以降に検知した銘柄はすべて条件(株数別の内容)が変更前のまま。
2. **予告された廃止が通常の変更扱いになっている。** 廃止を開示しても、最後の権利日までは
   kabuyutai.comに載り続けるため、`update`イベントとして記録され、マスタにも普通の優待銘柄として残る。
   次の権利日に優待が出ない銘柄を一覧から選んでクロスしてしまう恐れがある。

## スコープ

- detail-syncステートマシンの週次スケジュール化
- 廃止予告の判定・マスタへの記録・イベント種別の追加・過去分のバックフィル
- API(一覧・詳細)と画面(一覧バッジ・詳細の警告・イベント一覧のラベル)への表示

対象外: 廃止予告銘柄の一覧からの自動除外(最後の権利日まで優待が出る場合があるため、判断は開示を見て行う)、
通知、廃止予告の自動解除。

## 1. 条件取り直しの自動化

- `JQuantsYutaiDetailSync`ステートマシンに`events.Rule`を付け、**毎週火曜 JST 21:00(UTC 12:00 TUE)**に起動する。
  TDnetバッチ(月曜 UTC 12:00)の翌日で、kabuyutai.comを叩く他の処理と重ならない。
  入力は手動実行時と同じ(Passステートがバケット一覧を注入するので空入力でよい)。
- 対象選定はハンドラの現仕様のまま(`conditionCheckedAt`が無い、または90日より古い)。
  通常週は数十件で1分程度。90日のクールダウンが一斉に切れる2027-01-01前後は全件(約33分)になるが、
  既存の9バケット直列+タイムアウト2時間で収まる。
- runbookと`2026-10-02-yutai-condition-master-operational-decisions.md`の「手動運用」「キューを誰も消費しない」の
  記述を、スケジュール化した旨に更新する。

## 2. 廃止予告

### 判定

開示タイトルが次をすべて満たすとき廃止予告とみなす(`isAbolitionRelated`を置き換える)。

- 優待関連(既存の`YUTAI_KEYWORDS`=「株主優待」を含む)
- `ABOLITION_KEYWORDS = ['廃止', '終了']`のいずれかを含む
- 「一部」を含まない(例: 6577「株主優待制度の一部変更(デジタルギフトの廃止)」は制度自体が続くので除外)

「終了」の追加は既存の削除判定(廃止キーワード+kabuyutai.comに無い)にも効く。kabuyutai.comからも
消えていることが削除の条件なので、誤って削除する方向には広がらない。

2026-11-04時点で、この判定によりマスタに残っている廃止予告銘柄は7件:
6574, 7743, 7475, 2612, 9223(「終了」), 9246, 3297。

### 記録(`lambda/yutai-tdnet-watch-batch/index.ts`)

tickerごとの分岐を次のようにする(`sawAbolitionKeyword`は上の判定で算出)。

| kabuyutai.com | 廃止予告 | マスタ | イベント |
|---|---|---|---|
| 無い | あり | 削除(現状どおり) | `abolition` |
| 無い | なし | 変更なし・警告(現状どおり) | 記録しない |
| ある | あり | 上書き+`abolitionNotice`をSET | `abolition-notice` |
| ある | なし | 上書き(現状どおり) | `start` / `update` |

- `abolitionNotice`は`{ disclosedAt: 'YYYY-MM-DD', title: string }`。同じ銘柄に廃止予告が複数あれば、
  開示日が最も新しいものを書く。
- 既存の上書き用`UpdateCommand`の`SET`に足す(別コマンドにしない)。廃止予告でない更新では
  `abolitionNotice`に触れない(過去に付いたフラグを消さない)。
- 他のバッチ(master-sync / detail-sync / risk-precompute)はいずれも`UpdateCommand`で特定の項目だけを
  SETしているため、`abolitionNotice`は消えない。消えるのは、kabuyutai.comからも消えて行ごと削除されたとき。
- 誤検知だった場合に手で消すCLI手順(`aws dynamodb update-item ... REMOVE abolitionNotice`)をREADMEに書く。
- `eventType`の型に`'abolition-notice'`を追加する。

### 過去分のバックフィル(`scripts/backfill-abolition-notice.ts`)

一回限りのスクリプト。`JQuantsYutaiTdnetEvent`を全件読み、上の判定に当たる開示のうち、
tickerが`JQuantsYutaiMaster`に残っているものについて`abolitionNotice`をSETし、
該当イベント行の`eventType`を`abolition-notice`に書き換える。

- 既定はdry-run(対象の銘柄・開示日・タイトルを表示するだけ)。`--execute`で書き込む。
- 既存の`scripts/`のスクリプトと同じく、Node SDKから直接読む(AWS CLIはcp932で日本語を出力できないため)。

## 3. API・画面

- **API**(`lambda/reference-api/index.ts`): `GET /yutai/forecast`(一覧)の各行と`GET /yutai/{ticker}`(詳細)に
  `abolitionNotice: { disclosedAt, title } | null`を追加する。
- **一覧**: 「廃止予告」バッジを出す(既存のRSIバッジ等と同じ並び)。絞り込みからは外さない。
- **詳細**: 開示日・タイトル付きの警告を出す。文言例:
  「2026-10-13に優待制度の廃止が開示されています(『…』)。最後の権利日を開示で確認してください。」
- **イベント一覧**(`YutaiTdnetEventsPage.tsx`): `abolition-notice`のラベル「廃止予告」を追加する。
- **MCP**: 逆日歩予測MCPの戻り値にも`abolitionNotice`を含める(`2026-11-12-gyakuhibu-mcp-design.md`)。

## テスト

- TDnetバッチ: 廃止予告(kabuyutai.comにある)/「一部」を含む誤検知/「終了」/削除(kabuyutai.comに無い)/
  廃止予告でない更新で既存の`abolitionNotice`を消さないこと。
- バックフィル: dry-runで書き込まないこと、`--execute`で対象行だけ更新すること。
- API: 一覧・詳細で`abolitionNotice`が返ること(無い行は`null`)。
- フロント: バッジ・警告・ラベルの表示。
- CDK: detail-syncのスケジュールがステートマシンを対象にし、`cron(0 12 ? * TUE *)`であること。

## リリース手順

1. デプロイ(スケジュール・TDnetバッチ・API・フロント)
2. バックフィルをdry-run → 対象を確認 → `--execute`
3. 取り直し待ちの48件は、最初の火曜の自動実行で処理される(待たずに手動実行してもよい)
