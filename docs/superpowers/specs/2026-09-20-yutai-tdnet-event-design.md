# 優待開始・廃止イベント一覧 設計

> 元の依頼書: `docs/superpowers/specs/2026-09-20-yutai-tdnet-event-request.md`。
> 本ファイルはブレインストーミングで決定した最終設計(未確定事項への回答を含む)。

## 背景・目的

`yutai-tdnet-watch-batch`(週次Lambda)がTDnetの開示から検知した優待関連イベント(開始/変更/廃止)は、現状`console.log`に出るだけで永続化されない。これを`JQuantsYutaiTdnetEvent`テーブルに記録し、読み取り専用の一覧画面で確認できるようにする。

## スコープ

依頼書の通り。手動編集・削除、通知、ページネーションは対象外(初期実装は全件表示)。

## データモデル

**テーブル**: `JQuantsYutaiTdnetEvent`(GSIなし、既存テーブル群と同じ`dynamodb.Table`定義)

このスタックに既存のGSI使用テーブルは無く、`ticker`(+必要ならソートキー)という一貫したパターンを取っている。「全件を日付降順で一覧」というアクセスパターンには、パーティションキーを固定値にする方式がこの流儀に最も沿っており、GSIより単純なのでこちらを採用する。

| 属性 | 型 | 説明 |
|---|---|---|
| `pk` (PK) | string | 固定値`"ALL"`。全件を1パーティションにまとめ、`Query`+`ScanIndexForward: false`で日付降順取得する |
| `eventId` (SK) | string | `{disclosedAt}#{ticker}#{titleのsha256hexの先頭8文字}`。ソートキー自体に日付を先頭に埋め込むことで、ソートキー順=時系列順になる。同一開示の再処理は同じ`eventId`になり上書きのみ(冪等)。ハッシュはNode標準`crypto.createHash('sha256')`(新規依存なし) |
| `ticker` | string | 4桁ティッカー |
| `companyName` | string | **TDnet開示側`Disclosure.companyName`を保存**(kabuyutai.com側ではない)。理由: 廃止でマスタから削除される銘柄はkabuyutai.com側にもう存在せず、その時点で参照できる社名はTDnet開示のものだけ |
| `eventType` | `'start' \| 'update' \| 'abolition'` | 下記「eventTypeの判定」参照 |
| `disclosureTitle` | string | 開示タイトル原文 |
| `disclosedAt` | string (`YYYY-MM-DD`) | 開示日 |
| `recordedAt` | string (ISO datetime) | バッチ書き込み時刻 |

## イベント粒度

同一ticker・同一バッチ実行内に複数の優待関連開示がマッチした場合、**開示ごとに1件のイベント行を書く**(ticker×実行で1件に集約しない)。ただしイベント種別(`eventType`)はそのtickerのバッチ処理結果(マスタ更新/削除の分岐結果)を、そのtickerの全マッチ開示に共通して適用する。

## バッチ改修 (`lambda/yutai-tdnet-watch-batch/index.ts`)

`matchedTickers`を`Map<string, boolean>` → `Map<string, Disclosure[]>`に変更する。

```ts
const matchedTickers = new Map<string, Disclosure[]>();
...
if (isYutaiRelated(disclosure.title)) {
  const ticker = toTicker(disclosure.code);
  const existing = matchedTickers.get(ticker) ?? [];
  existing.push(disclosure);
  matchedTickers.set(ticker, existing);
}
```

ticker単位の処理ループでは`sawAbolitionKeyword = disclosures.some(d => isAbolitionRelated(d.title))`を都度算出。マスタ更新/削除の分岐ロジック自体は現状のまま変更しない。

**eventTypeの判定と書き込み**(分岐結果に応じて、そのtickerの`disclosures`全件に対して書く):
- マスタから削除(廃止: `!entry && sawAbolitionKeyword`) → 全件`eventType: 'abolition'`
- マスタ未登録から新規update(`entry`が見つかり、かつ元々`JQuantsYutaiMaster`に無かった) → 全件`eventType: 'start'`
- マスタ既存からupdate → 全件`eventType: 'update'`
- **警告のみでスキップするケース**(kabuyutai.comに見つからず廃止シグナルも無い、または見つかったが`rightsMonths`不完全) → マスタが実際には変わっていないため**イベントは記録しない**(現状通り`console.warn`のみ)

「マスタ未登録 vs 既存」の判定は、`listingsByTicker`(kabuyutai.com側)とは別物で、更新前の`JQuantsYutaiMaster`(自テーブル)に該当tickerが既にあったかどうかで判定する。既存の`UpdateCommand`はこれを区別しないため、`UpdateCommand`の直前に`GetCommand`で該当tickerの既存有無を1回確認してから`start`/`update`を決める(マッチ件数は週次かつ少数想定のため、ticker毎に1回の追加読み取りで十分。バッチ先頭での全件scanは不要)。

## API (`lambda/reference-api/index.ts`)

`GET /yutai/tdnet-events` を追加。

```ts
async function listTdnetEvents(): Promise<APIGatewayProxyResultV2> {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: YUTAI_TDNET_EVENT_TABLE_NAME,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'ALL' },
      ScanIndexForward: false,
    }),
  );
  const events = (result.Items ?? []).map((item) => ({
    ticker: item.ticker,
    companyName: item.companyName,
    eventType: item.eventType,
    disclosureTitle: item.disclosureTitle,
    disclosedAt: item.disclosedAt,
    recordedAt: item.recordedAt,
  }));
  return jsonResponse(200, { events });
}
```

`event.routeKey`のswitchに`'GET /yutai/tdnet-events'`を追加。既存のLambdaオーソライザーがAPI全体にかかっているので認証は自動的に適用される。

## CDK (`lib/j-quants-stack.ts`)

- 新規`dynamodb.Table`(`JQuantsYutaiTdnetEventTable`、PK: `pk` string, SK: `eventId` string)
- `yutaiTdnetWatchBatchFn`に新テーブルの`grantWriteData`、環境変数`YUTAI_TDNET_EVENT_TABLE_NAME`を追加
- `referenceApiFn`に新テーブルの`grantReadData`、環境変数`YUTAI_TDNET_EVENT_TABLE_NAME`を追加

## フロントエンド

- 新規ページ`frontend/src/pages/YutaiTdnetEventsPage.tsx`。`useReactTable`は使わず、`useAsync`で`fetchYutaiTdnetEvents()`を呼び、配列を`.map`して`<table className="data-table">`に流す(ソート・フィルタ無しなのでシンプルな構造で十分)
- 列: 開示日 / 銘柄(`/yutai/:ticker`へのリンク) / 会社名 / 種別バッジ / 開示タイトル(`cell-wrap`)
- 種別バッジは`.risk-badge`と同じ構造で`.event-badge`を追加。色は新規CSS変数を増やさず既存トークンを再利用: `start`→`--accent`、`update`→`--text-muted`、`abolition`→`--up`(既存のdanger相当と同じ「悪い知らせは赤」という一貫性)
- ルーティング: `frontend/src/main.tsx`に`<Route path="yutai/tdnet-events" element={<YutaiTdnetEventsPage />} />`を追加
- ナビゲーション: `frontend/src/components/Layout.tsx`の`NAV_ITEMS`に、「逆日歩予測」の直後として`{ to: '/yutai/tdnet-events', label: '優待変更履歴' }`を追加(全ページ共通ナビに出るため`/yutai`からもここ経由でアクセスできる)
- `frontend/src/api/types.ts`に`YutaiTdnetEventType`/`YutaiTdnetEvent`/`YutaiTdnetEventsResponse`型を追加
- `frontend/src/api/client.ts`に`fetchYutaiTdnetEvents(): Promise<YutaiTdnetEventsResponse>`を追加

## テスト

- `test/yutai-tdnet-watch-batch.test.ts`: 新規イベント書き込みを検証するケースを追加(start/update/abolitionそれぞれ、同一tickerに複数開示がマッチした場合に複数イベント行が書かれるケース、警告スキップケースでイベントが書かれないことを検証するケース)
- `test/reference-api.test.ts`: `GET /yutai/tdnet-events`の新規テスト
- `test/j-quants.test.ts`: 新テーブル・IAM grant・環境変数のCDKアサーション追加
- フロントエンドは既存の他ページ同様ユニットテスト無し、`tsc --noEmit` + `vite build`で検証
