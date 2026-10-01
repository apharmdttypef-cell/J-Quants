# 優待条件マスタと一覧・検索の改善 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 優待の必要株数・継続保有条件・株数段階別の内容を kabuyutai.com の個別ページから取得してマスタに持たせ、一覧画面でクロス可否・必要資金・前回逆日歩のコストまで判断できるようにする。

**Architecture:** 一覧ページのスクレイピングで個別ページURLとバッジを拾い、新しい `yutai-detail-sync-batch` が個別ページを解析して `benefitGroups`(株数段階)と導出スカラーを `JQuantsYutaiMaster` に書く。15分のLambda制限を越えるため Step Functions の Map で銘柄コード先頭1桁の9バケットに分けて**直列**実行する。日次の `yutai-risk-precompute-batch` は必要株数ベースでリスクを再計算し、前回逆日歩の実績も行に集計する。`reference-api` は項目と絞り込みを追加し、フロントは2つの一覧画面と詳細画面に反映する。

**Tech Stack:** TypeScript / AWS CDK (aws-cdk-lib) / Lambda (NodejsFunction, Node 22) / DynamoDB (DocumentClient) / Step Functions / API Gateway HTTP API / React + TanStack Table + Vite / Jest + ts-jest

**設計書:** `docs/superpowers/specs/2026-10-01-yutai-condition-master-design.md`(コミット `33b1ff7`)

## Global Constraints

- kabuyutai.com へのリクエストは**1リクエスト/秒を超えてはならない**。既存の `KABUYUTAI_REQUEST_INTERVAL_MS`(既定 `1000`)を必ず経由する。
- Step Functions の Map は **`maxConcurrency: 1`**。並列化すると秒9リクエストになり各Lambda内の間隔ガードが無意味になる。Map は15分制限の回避のためだけに使う。
- 「計算できない」は `number | null` で表す。`NaN` を使ってはならない(コードベース全体の規約)。
- `unitShares` は**単元株数(100株固定)**の意味に戻す。優待に必要な株数は `requiredShares` が持つ。`yutai-risk-precompute-batch` は `unitShares` を書いてはならない。
- テストはネットワークに触れてはならない。実HTMLは**テストファイル内のインライン文字列**として持つ(既存 `test/kabuyutai-client.test.ts` の `SAMPLE_PAGE_HTML` と同じ流儀。`test/fixtures/` ディレクトリは作らない)。
- DynamoDB は既存テストと同じく `jest.mock('@aws-sdk/lib-dynamodb', ...)` でモックする。`mockResolvedValueOnce` の順番に依存するテストがあるため、ハンドラ内の `await` の順序を変えるときは既存テストを確認する。
- 新規 Lambda に EventBridge スケジュールを付けてはならない(`yutai-detail-sync-batch` は手動運用)。
- 既存の API レスポンス項目を削除・改名してはならない。追加のみ。
- 日本語のコメント・UIラベルで統一する(既存コードの流儀)。

## 作業ディレクトリとテストコマンド

- 作業ディレクトリ: `C:\workspaces\J-Quants`(ブランチ `main`)
- バックエンド/CDK のテスト: `npx jest <ファイル名>`(全体は `npm test`)
- バックエンド/CDK の型チェック: `npm run build`(`tsc`)
- フロントの検証: `cd frontend && npm run build`(`tsc -b && vite build`)と `npm run lint`
- フロントには単体テストが存在しない(jest の `roots` は `test/` のみ、`testMatch` は `*.test.ts`)。フロントのタスクは型チェックとビルドで検証する。

## File Structure

| ファイル | 責務 | 変更 |
|---|---|---|
| `lambda/shared/kabuyutai-client.ts` | kabuyutai.com の取得と一覧ページの解析 | 修正: `detailUrl`/`listBadge` を抽出、`fetchDetailPage` を追加 |
| `lambda/shared/kabuyutai-detail.ts` | **個別ページの解析と導出スカラー**(純関数・ネットワークなし) | 新規 |
| `lambda/shared/gyakuhibu-actual-summary.ts` | **逆日歩実績から前回/前年同月を選び必要株数ベースのコストを出す**(純関数) | 新規 |
| `lambda/yutai-master-sync-batch/index.ts` | 一覧ページ → マスタ upsert | 修正: 2項目を保存 |
| `lambda/yutai-tdnet-watch-batch/index.ts` | TDnet検知 → 再sync | 修正: 2項目を保存 + `conditionCheckedAt` を REMOVE |
| `lambda/yutai-detail-sync-batch/index.ts` | **個別ページを取得してマスタに書く**(上限+クールダウンで再開) | 新規 |
| `lambda/yutai-risk-precompute-batch/index.ts` | 日次のリスク事前計算 | 修正: `requiredShares` 使用、`unitShares` を書かない、前回逆日歩を集計 |
| `lambda/reference-api/index.ts` | 参照API | 修正: 項目と絞り込みを追加 |
| `lib/j-quants-stack.ts` | CDK スタック | 修正: 新Lambda + Step Functions、precompute への権限追加 |
| `frontend/src/api/types.ts` | APIの型 | 修正: 共通項目の型を追加 |
| `frontend/src/api/client.ts` | API呼び出し | 修正: 新しいクエリパラメータ |
| `frontend/src/lib/yutai-cross.tsx` | **2つの一覧で共用する4列と絞り込みUI** | 新規 |
| `frontend/src/pages/YutaiListPage.tsx` | 優待一覧 | 修正: 共通列と絞り込みを組み込む |
| `frontend/src/pages/YutaiForecastListPage.tsx` | 逆日歩予測一覧 | 修正: 同上 |
| `frontend/src/pages/YutaiDetailPage.tsx` | 優待詳細 | 修正: 株数段階表 |
| `docs/superpowers/notes/2026-10-01-yutai-detail-sync-runbook.md` | 移行手順の記録 | 新規 |

`lambda/shared/kabuyutai-detail.ts` を `kabuyutai-client.ts` に混ぜない理由: client は fetch を持ちテストで `global.fetch` をモックする。個別ページの解析は純関数で、実HTMLを食わせて結果を検証したい。混ぜると解析のテストが fetch のモックに引きずられる。

---

### Task 1: 一覧ページから個別ページURLとバッジを拾う

一覧ページの銘柄ブロックには個別ページの href とクロス可否のバッジが既に含まれている。URLを推測せずに済むので、まずこれをマスタに保存する。

**Files:**
- Modify: `lambda/shared/kabuyutai-client.ts`
- Modify: `lambda/yutai-master-sync-batch/index.ts`
- Modify: `lambda/yutai-tdnet-watch-batch/index.ts`
- Test: `test/kabuyutai-client.test.ts`, `test/yutai-master-sync-batch.test.ts`, `test/yutai-tdnet-watch-batch.test.ts`

**Interfaces:**
- Produces:
  - `export type ListBadge = 'chouki' | 'choukinomi' | null;`(`null` = バッジなし = 継続保有条件なし)
  - `KabuyutaiEntry` に `detailUrl: string | undefined` と `listBadge: ListBadge` を追加
  - マスタ行の新属性 `detailUrl`(`string | null`)、`listBadge`(`string | null`)

- [ ] **Step 1: `test/kabuyutai-client.test.ts` に失敗するテストを足す**

既存の `SAMPLE_PAGE_HTML`(コシダカ2157・地域新聞社2164)はバッジを持たない。ファイル末尾に、バッジ付きブロックのサンプルと3つのテストを追加する。

```ts
// 長期保有バッジ付きのブロック。「長期優遇あり」は長期保有で優待が上乗せされる
// (1回のクロスでも最低段階は取れる)、「長期優待のみ」は長期保有者限定で
// クロスでは取れない。クラス属性は choukinomi の方が "chouki choukinomi" と
// 2トークン持つため、トークン単位で判定する。
const BADGED_PAGE_HTML = `
<!-- ▼ランキング_ブロック -->
<div class="table_tr">
<div class="chouki tooltip">長期優遇あり<span class="tooltiptext">長期保有で優待が増えます</span></div>
<div class="table_tr_inner">
<div class="table_tr_info">
<p><a href="https://www.kabuyutai.com/kobetu/toba.html" class="kigyoumei">鳥羽洋行</a>（7472）</p>
<p>【優待内容】オリジナルQUOカード（1,000円相当～）</p>
<p>【権利確定月】<span class="tousi_price">5月</span></p>
<p>【必要投資金額】<span class="tousi_price">196,800円</span></p>
</div>
</div>
</div>
<!-- ▲ランキング_ブロック -->
<!-- ▼ランキング_ブロック -->
<div class="table_tr">
<div class="chouki choukinomi tooltip">長期優待のみ<span class="tooltiptext">優待がもらえるのは長期株式保有株主に限られます</span></div>
<div class="table_tr_inner">
<div class="table_tr_info">
<p><a href="https://www.kabuyutai.com/kobetu/maitake.html" class="kigyoumei">マイタケ</a>（1375）</p>
<p>【優待内容】自社製品セット（3,000円相当～）</p>
<p>【権利確定月】<span class="tousi_price">3月</span></p>
<p>【必要投資金額】<span class="tousi_price">120,000円</span></p>
</div>
</div>
</div>
<!-- ▲ランキング_ブロック -->
`;

test('parseListPage captures the detail page URL from the kigyoumei anchor', () => {
  const entries = parseListPage(SAMPLE_PAGE_HTML);
  expect(entries.map((e) => e.detailUrl)).toEqual([
    'https://www.kabuyutai.com/kobetu/koshidakaholdings.html',
    'https://www.kabuyutai.com/kobetu/chiikinews.html',
  ]);
  // 既存の抽出が壊れていないこと(href捕捉でキャプチャ番号がずれるため)
  expect(entries.map((e) => e.companyName)).toEqual(['コシダカホールディングス', '地域新聞社']);
  expect(entries.map((e) => e.ticker)).toEqual(['2157', '2164']);
});

test('parseListPage distinguishes the two long-holding badges and no badge at all', () => {
  expect(parseListPage(BADGED_PAGE_HTML).map((e) => e.listBadge)).toEqual(['chouki', 'choukinomi']);
  expect(parseListPage(SAMPLE_PAGE_HTML).map((e) => e.listBadge)).toEqual([null, null]);
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx jest kabuyutai-client`
Expected: FAIL — `detailUrl` と `listBadge` が `undefined`(`toEqual` が不一致)

- [ ] **Step 3: `lambda/shared/kabuyutai-client.ts` を修正する**

`KabuyutaiEntry` の定義直前に型を追加する。

```ts
// 一覧ページの長期保有バッジ。'chouki' = 「長期優遇あり」(長期保有で上乗せ。
// 1回のクロスでも最低段階は取れる)、'choukinomi' = 「長期優待のみ」
// (長期保有者限定でクロスでは取れない)、null = バッジなし(継続保有条件なし)。
// 個別ページの解析が失敗したときのクロス可否のフォールバックに使う。
export type ListBadge = 'chouki' | 'choukinomi' | null;
```

`KabuyutaiEntry` に2項目を足す。

```ts
export interface KabuyutaiEntry {
  ticker: string;
  companyName: string;
  content: string;
  rightsMonths: number[];
  value: number | undefined;
  minInvestment: number | undefined;
  // 個別ページのURL。一覧ページの企業名リンク(class="kigyoumei")のhrefそのもの。
  // yutai-detail-sync-batchが株数段階・継続保有条件を取りに行くのに使う
  // (URLの命名規則を推測する必要がない)。
  detailUrl: string | undefined;
  listBadge: ListBadge;
}
```

バッジ抽出関数を `extractMinInvestment` の近くに追加する。

```ts
// 長期保有バッジを抽出する。class属性は「長期優遇あり」が class="chouki tooltip"、
// 「長期優待のみ」が class="chouki choukinomi tooltip" で、後者も chouki を含む。
// クラスの並び順に依存しないようトークン単位で判定する。
function extractListBadge(block: string): ListBadge {
  const match = block.match(/<div class="([^"]*\bchouki\b[^"]*)"/);
  if (!match) return null;
  return /\bchoukinomi\b/.test(match[1]) ? 'choukinomi' : 'chouki';
}
```

`parseListPage` の `nameMatch` に href のキャプチャを足す。**キャプチャ番号が1つずれる**ので既存の参照も直す。

```ts
    const nameMatch = block.match(/<p><a href="([^"]+)" class="kigyoumei">([^<]+)<\/a>（(\d{4})）<\/p>/);
    const contentMatch = block.match(/【優待内容】([^<]+)/);
    const monthsMatch = block.match(/【権利確定月】<span class="tousi_price">([^<]+)<\/span>/);
    if (!nameMatch || !contentMatch || !monthsMatch) continue;

    const content = contentMatch[1].trim();
    const minInvestment = extractMinInvestment(block);
    entries.push({
      companyName: nameMatch[2],
      ticker: nameMatch[3],
      content,
      rightsMonths: parseRightsMonths(monthsMatch[1]),
      value: extractValue(content) ?? estimateValueFromYield(minInvestment, extractYieldPercent(block)),
      minInvestment,
      detailUrl: nameMatch[1],
      listBadge: extractListBadge(block),
    });
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx jest kabuyutai-client`
Expected: PASS(新規2件と既存の全件)

- [ ] **Step 5: `test/yutai-master-sync-batch.test.ts` に失敗するテストを足す**

ファイル末尾に追加する。既存テストの `mockFetchAllListings.mockResolvedValueOnce([...])` の形を真似て、2項目を含むエントリを渡す。

```ts
test('persists detailUrl and listBadge from the list page', async () => {
  mockFetchAllListings.mockResolvedValueOnce([
    {
      ticker: '7472',
      companyName: '鳥羽洋行',
      content: 'オリジナルQUOカード（1,000円相当～）',
      rightsMonths: [5],
      value: 1000,
      minInvestment: 196800,
      detailUrl: 'https://www.kabuyutai.com/kobetu/toba.html',
      listBadge: 'chouki',
    },
  ]);
  mockSend.mockResolvedValue({});

  await handler();

  expect(mockSend).toHaveBeenCalledTimes(1);
  const input = mockSend.mock.calls[0][0] as {
    UpdateExpression: string;
    ExpressionAttributeValues: Record<string, unknown>;
  };
  expect(input.UpdateExpression).toContain('detailUrl = :detailUrl');
  expect(input.UpdateExpression).toContain('listBadge = :listBadge');
  expect(input.ExpressionAttributeValues[':detailUrl']).toBe('https://www.kabuyutai.com/kobetu/toba.html');
  expect(input.ExpressionAttributeValues[':listBadge']).toBe('chouki');
});

test('writes null for a ticker with no badge and no detail URL', async () => {
  mockFetchAllListings.mockResolvedValueOnce([
    {
      ticker: '2157',
      companyName: 'コシダカホールディングス',
      content: '割引券（2,000円相当～）',
      rightsMonths: [2, 8],
      value: 2000,
      minInvestment: 102200,
      detailUrl: undefined,
      listBadge: null,
    },
  ]);
  mockSend.mockResolvedValue({});

  await handler();

  const input = mockSend.mock.calls[0][0] as { ExpressionAttributeValues: Record<string, unknown> };
  expect(input.ExpressionAttributeValues[':detailUrl']).toBeNull();
  expect(input.ExpressionAttributeValues[':listBadge']).toBeNull();
});
```

- [ ] **Step 6: テストが失敗することを確認する**

Run: `npx jest yutai-master-sync-batch`
Expected: FAIL — `UpdateExpression` に `detailUrl` が含まれない

- [ ] **Step 7: `lambda/yutai-master-sync-batch/index.ts` の UpdateExpression を拡張する**

```ts
          UpdateExpression:
            'SET companyName = :companyName, #content = :content, #value = :value, unitShares = :unitShares, minInvestment = :minInvestment, rightsMonths = :rightsMonths, detailUrl = :detailUrl, listBadge = :listBadge',
          ExpressionAttributeNames: { '#content': 'content', '#value': 'value' },
          ExpressionAttributeValues: {
            ':companyName': entry.companyName,
            ':content': entry.content,
            ':value': entry.value ?? null,
            ':unitShares': UNIT_SHARES,
            ':minInvestment': entry.minInvestment ?? null,
            ':rightsMonths': entry.rightsMonths,
            ':detailUrl': entry.detailUrl ?? null,
            ':listBadge': entry.listBadge ?? null,
          },
```

- [ ] **Step 8: テストが通ることを確認する**

Run: `npx jest yutai-master-sync-batch`
Expected: PASS

- [ ] **Step 9: `test/yutai-tdnet-watch-batch.test.ts` に失敗するテストを足す**

TDnet で変更を検知した銘柄は、個別ページも読み直す必要がある。`conditionCheckedAt` を消すことで次回の detail-sync が対象として拾う。既存テストの構造(TDnetのHTMLモックと `fetchAllListings` のモック)を確認してから、同じヘルパーを使って1件追加する。

```ts
test('removes conditionCheckedAt so the detail page is re-read after a TDnet change', async () => {
  // 既存テストと同じく、1日分の開示に優待関連のタイトルを1件だけ含めるHTMLを返す。
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => dayListHtml([{ code: '74720', name: '鳥羽洋行', title: '株主優待制度の一部変更に関するお知らせ' }]),
  });
  mockFetchAllListings.mockResolvedValueOnce([
    {
      ticker: '7472',
      companyName: '鳥羽洋行',
      content: 'オリジナルQUOカード（1,000円相当～）',
      rightsMonths: [5],
      value: 1000,
      minInvestment: 196800,
      detailUrl: 'https://www.kabuyutai.com/kobetu/toba.html',
      listBadge: 'chouki',
    },
  ]);
  mockSend.mockResolvedValue({ Item: { ticker: '7472' } });

  await handler();

  const update = mockSend.mock.calls
    .map((call) => call[0] as { UpdateExpression?: string; ExpressionAttributeValues?: Record<string, unknown> })
    .find((input) => typeof input.UpdateExpression === 'string');
  expect(update).toBeDefined();
  expect(update!.UpdateExpression).toContain('REMOVE conditionCheckedAt');
  expect(update!.ExpressionAttributeValues![':detailUrl']).toBe('https://www.kabuyutai.com/kobetu/toba.html');
  expect(update!.ExpressionAttributeValues![':listBadge']).toBe('chouki');
});
```

既存テストに `dayListHtml` 相当のヘルパーが別名で定義されている場合はその名前を使う。`mockFetch`/`mockSend`/`mockFetchAllListings` の変数名も既存ファイルのものに合わせる。

- [ ] **Step 10: テストが失敗することを確認する**

Run: `npx jest yutai-tdnet-watch-batch`
Expected: FAIL — `REMOVE conditionCheckedAt` が含まれない

- [ ] **Step 11: `lambda/yutai-tdnet-watch-batch/index.ts` の UpdateExpression を拡張する**

`recordEvents` の直前にある `UpdateCommand` を次のように変える。

```ts
      await ddbDocClient.send(
        new UpdateCommand({
          TableName: YUTAI_MASTER_TABLE_NAME,
          Key: { ticker: entry.ticker },
          // conditionCheckedAtを消すことで、次のyutai-detail-sync-batchがこの銘柄を
          // 「未取得」として拾い直す。ここで個別ページを同期取得しないのは、優待関連の
          // 開示が多い週に該当銘柄が増えると14分のタイムアウトに近づくため。
          UpdateExpression:
            'SET companyName = :companyName, #content = :content, #value = :value, unitShares = :unitShares, minInvestment = :minInvestment, rightsMonths = :rightsMonths, detailUrl = :detailUrl, listBadge = :listBadge REMOVE conditionCheckedAt',
          ExpressionAttributeNames: { '#content': 'content', '#value': 'value' },
          ExpressionAttributeValues: {
            ':companyName': entry.companyName,
            ':content': entry.content,
            ':value': entry.value ?? null,
            ':unitShares': UNIT_SHARES,
            ':minInvestment': entry.minInvestment ?? null,
            ':rightsMonths': entry.rightsMonths,
            ':detailUrl': entry.detailUrl ?? null,
            ':listBadge': entry.listBadge ?? null,
          },
        }),
      );
```

- [ ] **Step 12: テスト全体と型チェックを通す**

Run: `npx jest kabuyutai-client yutai-master-sync-batch yutai-tdnet-watch-batch && npm run build`
Expected: 全てPASS、`tsc` エラーなし

`KabuyutaiEntry` に必須項目を2つ増やしたため、既存テストでエントリを組み立てている箇所が型エラーになる可能性がある。`npm run build` は `test/` を含まない設定の場合もあるので、`npx jest` の ts-jest 側のエラーも必ず確認する。エラーが出た既存テストのエントリには `detailUrl: undefined, listBadge: null` を足す。

- [ ] **Step 13: コミット**

```bash
git add lambda/shared/kabuyutai-client.ts lambda/yutai-master-sync-batch/index.ts lambda/yutai-tdnet-watch-batch/index.ts test/kabuyutai-client.test.ts test/yutai-master-sync-batch.test.ts test/yutai-tdnet-watch-batch.test.ts
git commit -m "Capture the kabuyutai detail-page URL and long-holding badge on the yutai master"
```

---

### Task 2: 個別ページの株数段階パーサー

個別ページの `<section id="yutai_detail">` から `<h3>`(優待種別)・`<div class="stit">`(継続保有条件)・`<table>`(株数段階)を出現順に解釈してグループ配列にする。純関数のみ。

**Files:**
- Create: `lambda/shared/kabuyutai-detail.ts`
- Test: `test/kabuyutai-detail.test.ts`

**Interfaces:**
- Produces:
```ts
export interface BenefitTier { shares: number; valueYen: number | null; rawText: string; }
export interface BenefitGroup {
  title: string | null;
  holdingMonths: number | null;
  holdingRaw: string | null;
  tiers: BenefitTier[];
}
export function parseBenefitDetail(html: string): BenefitGroup[];
```

- [ ] **Step 1: `test/kabuyutai-detail.test.ts` に失敗するテストを書く**

5銘柄の実データ断片をインラインで持つ。断片は `id="yutai_detail"` セクションから `<h3>`/`<div class="stit">`/`<table>` だけを抜いたもので、2026-10-01 に実ページから取得して検証済み。

```ts
import { parseBenefitDetail } from '../lambda/shared/kabuyutai-detail';

// 2026-10-01 に実ページから取得した断片。設計書
// docs/superpowers/specs/2026-10-01-yutai-condition-master-design.md の表の
// 期待値と対応する。末尾の「この企業の公式ホームページ」はセクションの終端
// アンカーで、ここより後ろ(サイドバーの他社情報)を拾わないための境界。

// 鳥羽洋行: 条件なしのグループと3年以上のグループ。素直なケース。
const TOBA_HTML = `
<section id="yutai_detail">
<h3>◎緑の募金への寄付金付きオリジナルQUOカード（クオカード）</h3>
<table class="yutai_table">
<tr><td>100株</td><td><b>1,000円</b>相当</td></tr>
<tr><td>500株</td><td><b>2,000円</b>相当</td></tr>
<tr><td>1,000株</td><td><b>3,000円</b>相当</td></tr>
</table>
<div class="stit">【株式継続保有期間3年以上】</div>
<table class="yutai_table">
<tr><td>100株</td><td><b>2,000円</b>相当</td></tr>
<tr><td>500株</td><td><b>4,000円</b>相当</td></tr>
<tr><td>1,000株</td><td><b>6,000円</b>相当</td></tr>
</table>
</section>
<p>この企業の公式ホームページ</p>
<table class="other"><tr><td>999株</td><td><b>99,999円</b>相当</td></tr></table>
`;

// ミライト: 両グループに継続保有条件。選択式で先頭の金額を採る。
const MIRAIT_HTML = `
<section id="yutai_detail">
<h3>◎QUOカードなど（選択式）</h3>
<div class="stit">【株式継続保有期間1年以上】</div>
<table class="yutai_table">
<tr><td>100株</td><td><span class="choice hosoku">【下記から1点を選択】</span><br> （1）<b>1,000円</b>相当<br> （2）<b>1,000円</b>相当<br> （3）<b>1kg</b>（抽選で600人）<br> （4）<b>1,000円</b>相当</td></tr>
<tr><td>1,000株</td><td><span class="choice hosoku">【下記から1点を選択】</span><br> （1）<b>3,000円</b>相当<br> （2）<b>3,000円</b>相当<br> （3）<b>1kg</b>（抽選で50人）<br> （4）<b>3,000円</b>相当</td></tr>
</table>
<div class="stit">【株式継続保有期間3年以上】</div>
<table class="yutai_table">
<tr><td>100株</td><td><span class="choice hosoku">【下記から1点を選択】</span><br> （1）<b>1,000円</b>相当<br> （2）<b>1,000円</b>相当<br> （3）<b>1kg</b>（抽選で600人）<br> （4）<b>1,000円</b>相当</td></tr>
<tr><td>1,000株</td><td><span class="choice hosoku">【下記から1点を選択】</span><br> （1）<b>4,000円</b>相当 <br> （2）<b>4,000円</b>相当<br> （3）<b>5kg</b>（抽選で210人）<br> （4）<b>4,000円</b>相当</td></tr>
</table>
</section>
<p>この企業の公式ホームページ</p>
`;

// マイタケ: 「か月」表記の継続保有条件が1グループだけ。
const MAITAKE_HTML = `
<section id="yutai_detail">
<h3>◎自社製品セット</h3>
<div class="stit">【株式継続保有期間6か月以上】</div>
<table class="yutai_table">
<tr><td>100株</td><td><b>3,000円</b>相当</td></tr>
<tr><td>300株</td><td><b>5,000円</b>相当</td></tr>
<tr><td>1,000株</td><td><b>7,000円</b>相当</td></tr>
</table>
</section>
<p>この企業の公式ホームページ</p>
`;

// 第一興商: 単元100株だが優待は200株から。必要株数が正確値で取れることの証拠。
const DKKARAOKE_HTML = `
<section id="yutai_detail">
<h3>◎「ビッグエコー」のほか、グループ店舗で使える優待利用割引カードなど（×年2回）</h3>
<table class="yutai_table">
<tr><td>200株</td><td><span class="choice hosoku">【下記から1点を選択】</span><br> （1）<b>5,000円</b>相当<br> （2）<b>1枚</b></td></tr>
<tr><td>2,000株</td><td><span class="choice hosoku">【下記から1点を選択】</span><br> （1）<b>12,500円</b>相当<br> （2）<b>2枚</b></td></tr>
</table>
</section>
<p>この企業の公式ホームページ</p>
`;

// ノジマ: 4種別・7グループ。「ー」(該当なし)が混在し、同じ(種別,保有条件)の
// グループが重複して現れる(年2回の中間/期末の区別がこのパーサーでは落ちる)。
const NOJIMA_HTML = `
<section id="yutai_detail">
<h3>◎「ノジマ」で使える優待買物割引券（×年2回）</h3>
<table class="yutai_table">
<tr><td>300株</td><td><b>15,000円</b>相当</td></tr>
<tr><td>1,000株</td><td><b>50,000円</b>相当</td></tr>
</table>
<h3>◎ノジマポイント（1ポイント1円相当）</h3>
<table class="yutai_table">
<tr><td>10,000株</td><td><b>30,000円</b>相当</td></tr>
</table>
<div class="stit">【株式継続保有期間2年以上】</div>
<table class="yutai_table">
<tr><td>300株</td><td>ー</td></tr>
<tr><td>1,000株</td><td><b>10,000円</b>相当</td></tr>
</table>
<table class="yutai_table">
<tr><td>300株</td><td><b>5,000円</b>相当</td></tr>
<tr><td>1,000株</td><td><b>10,000円</b>相当</td></tr>
</table>
<h3>◎オリジナル商品</h3>
<table class="yutai_table">
<tr><td>3,000株</td><td><b>5,000円</b>相当</td></tr>
</table>
</section>
<p>この企業の公式ホームページ</p>
`;

test('parses a benefit with one unconditional group and one long-holding group', () => {
  const groups = parseBenefitDetail(TOBA_HTML);
  expect(groups).toHaveLength(2);
  expect(groups[0].title).toBe('◎緑の募金への寄付金付きオリジナルQUOカード（クオカード）');
  expect(groups[0].holdingMonths).toBeNull();
  expect(groups[0].holdingRaw).toBeNull();
  expect(groups[0].tiers).toEqual([
    { shares: 100, valueYen: 1000, rawText: '1,000円 相当' },
    { shares: 500, valueYen: 2000, rawText: '2,000円 相当' },
    { shares: 1000, valueYen: 3000, rawText: '3,000円 相当' },
  ]);
  // h3は引き継がれ、stitは次の表にだけ効く
  expect(groups[1].title).toBe(groups[0].title);
  expect(groups[1].holdingMonths).toBe(36);
  expect(groups[1].holdingRaw).toBe('継続保有期間3年以上');
  expect(groups[1].tiers[0].valueYen).toBe(2000);
});

test('stops at the section end anchor and ignores tables that follow it', () => {
  // 終端アンカーより後ろの999株の表を拾っていないこと
  const allShares = parseBenefitDetail(TOBA_HTML).flatMap((g) => g.tiers.map((t) => t.shares));
  expect(allShares).not.toContain(999);
});

test('takes the first yen amount from a selection-style benefit', () => {
  const groups = parseBenefitDetail(MIRAIT_HTML);
  expect(groups).toHaveLength(2);
  expect(groups.map((g) => g.holdingMonths)).toEqual([12, 36]);
  expect(groups[0].tiers[0].valueYen).toBe(1000);
  expect(groups[1].tiers[1].valueYen).toBe(4000);
  // 原文は表示の忠実性のため保持する
  expect(groups[0].tiers[0].rawText).toContain('【下記から1点を選択】');
});

test('reads a holding period written in months', () => {
  const groups = parseBenefitDetail(MAITAKE_HTML);
  expect(groups).toHaveLength(1);
  expect(groups[0].holdingMonths).toBe(6);
  expect(groups[0].holdingRaw).toBe('継続保有期間6か月以上');
});

test('reads a minimum tier above one trading unit', () => {
  const groups = parseBenefitDetail(DKKARAOKE_HTML);
  expect(groups).toHaveLength(1);
  expect(groups[0].holdingMonths).toBeNull();
  expect(groups[0].tiers.map((t) => t.shares)).toEqual([200, 2000]);
  expect(groups[0].tiers[0].valueYen).toBe(5000);
});

test('parses multiple benefit types and resets the holding condition at each h3', () => {
  const groups = parseBenefitDetail(NOJIMA_HTML);
  expect(groups).toHaveLength(5);
  expect(groups.map((g) => g.holdingMonths)).toEqual([null, null, 24, 24, null]);
  expect(groups[1].title).toBe('◎ノジマポイント（1ポイント1円相当）');
  // h3の直後の表は、前のh3配下のstitを引き継がない
  expect(groups[1].holdingMonths).toBeNull();
  expect(groups[4].title).toBe('◎オリジナル商品');
});

test('records a dash value as null while keeping its raw text', () => {
  const groups = parseBenefitDetail(NOJIMA_HTML);
  const dashTier = groups[2].tiers[0];
  expect(dashTier.shares).toBe(300);
  expect(dashTier.valueYen).toBeNull();
  expect(dashTier.rawText).toBe('ー');
});

test('returns an empty array when the yutai_detail section is absent', () => {
  expect(parseBenefitDetail('<html><body><p>no detail here</p></body></html>')).toEqual([]);
});

test('skips tables that have no share rows', () => {
  const html = `
<section id="yutai_detail">
<h3>◎説明だけの表</h3>
<table><tr><td>権利確定月</td><td>3月</td></tr></table>
</section>
<p>この企業の公式ホームページ</p>
`;
  expect(parseBenefitDetail(html)).toEqual([]);
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx jest kabuyutai-detail`
Expected: FAIL — `Cannot find module '../lambda/shared/kabuyutai-detail'`

- [ ] **Step 3: `lambda/shared/kabuyutai-detail.ts` を作る**

```ts
// kabuyutai.comの個別ページから株数段階別の優待内容を取り出す。純関数のみで、
// ネットワークには触れない(取得はkabuyutai-client.fetchDetailPageの責務)。

export interface BenefitTier {
  shares: number;
  // 金額が読み取れない段階(「ー」= 該当なし、自社製品の個数表記など)はnull。
  // 表示にはrawTextを使うため、nullでも情報は失われない。
  valueYen: number | null;
  rawText: string;
}

export interface BenefitGroup {
  // <h3>の優待種別。セクション先頭にh3が無い場合はnull。
  title: string | null;
  // 継続保有条件の月数。条件なしはnull。
  holdingMonths: number | null;
  holdingRaw: string | null;
  tiers: BenefitTier[];
}

// セクションの終端候補。段階表は文書のかなり後方(実測で約74%の位置)にあるため、
// 終端候補は「必ず段階表より後ろに現れるもの」に限らなければならない。開発中に
// '<div class="comment' を候補に入れたところ段階表より手前でマッチし、全銘柄で
// パース結果が0件になった(2026-10-01)。
const SECTION_END_ANCHORS = ['この企業の公式ホームページ', 'の優待権利確定日情報', 'id="yutai_kijunbi"'];

function detailSection(html: string): string | null {
  const start = html.indexOf('id="yutai_detail"');
  if (start === -1) return null;

  let end = html.length;
  for (const anchor of SECTION_END_ANCHORS) {
    const position = html.indexOf(anchor, start);
    if (position !== -1 && position < end) end = position;
  }
  return html.slice(start, end);
}

// 「継続保有期間3年以上」「継続保有期間6か月以上」の両表記を月数に正規化する。
// 「ヶ月」「カ月」の表記ゆれも受ける。
function parseHolding(text: string): { months: number; raw: string } | null {
  // 末尾の「以上」まで含めて捕まえる。holdingRawは原文をそのまま画面に出すため、
  // 「継続保有期間3年」で切れていると「3年以上」なのか「3年のみ」なのか読めない。
  const match = text.match(/継続保有期間\s*(\d+)\s*(年|ヶ月|か月|カ月)(?:以上)?/);
  if (!match) return null;
  const amount = Number(match[1]);
  return { months: match[2] === '年' ? amount * 12 : amount, raw: match[0] };
}

function parseTiers(tableHtml: string): BenefitTier[] {
  const tiers: BenefitTier[] = [];

  for (const row of tableHtml.matchAll(/<tr>\s*<td>([^<]*)<\/td>\s*<td>([\s\S]*?)<\/td>/g)) {
    const sharesMatch = row[1].trim().match(/^([\d,]+)\s*株/);
    // 株数列でない行(「権利確定月」等の説明行)は段階ではない。
    if (!sharesMatch) continue;

    const rawText = row[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // 選択式(【下記から1点を選択】)は先頭の金額を採る。実データでは選択肢の金額が
    // 揃っているため先頭で足りる(揃っていない銘柄が出たら設計を見直す)。
    const valueMatch = rawText.match(/([\d,]+)\s*円/);

    tiers.push({
      shares: Number(sharesMatch[1].replace(/,/g, '')),
      valueYen: valueMatch ? Number(valueMatch[1].replace(/,/g, '')) : null,
      rawText,
    });
  }

  return tiers;
}

type Token =
  | { kind: 'title'; text: string }
  | { kind: 'holding'; text: string }
  | { kind: 'table'; html: string };

// h3 / stit / table を出現順に並べる。並び順そのものが意味を持つ(stitは直後の表に、
// h3はそれ以降の表に効く)ため、種類ごとに別々に集めてはならない。
function tokenize(section: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /<h3>([\s\S]*?)<\/h3>|<div class="stit">([^<]*)<\/div>|<table[^>]*>([\s\S]*?)<\/table>/g;

  for (let match = pattern.exec(section); match !== null; match = pattern.exec(section)) {
    if (match[1] !== undefined) {
      tokens.push({ kind: 'title', text: match[1].replace(/<[^>]+>/g, '').trim() });
    } else if (match[2] !== undefined) {
      tokens.push({ kind: 'holding', text: match[2].trim() });
    } else {
      tokens.push({ kind: 'table', html: match[3] });
    }
  }

  return tokens;
}

export function parseBenefitDetail(html: string): BenefitGroup[] {
  const section = detailSection(html);
  if (section === null) return [];

  const groups: BenefitGroup[] = [];
  let title: string | null = null;
  let holding: { months: number; raw: string } | null = null;

  for (const token of tokenize(section)) {
    if (token.kind === 'title') {
      // 新しい優待種別に入ったら継続保有条件はリセットする。ノジマのように
      // 「条件なしの表 → 2年以上の表 → 次の種別の条件なしの表」と並ぶため、
      // h3を越えてstitを引き継ぐと条件なしの表を誤って条件付きにしてしまう。
      title = token.text;
      holding = null;
      continue;
    }
    if (token.kind === 'holding') {
      holding = parseHolding(token.text);
      continue;
    }

    const tiers = parseTiers(token.html);
    // 株数段階を1つも含まない表は優待内容の表ではない。
    if (tiers.length === 0) continue;

    groups.push({
      title,
      holdingMonths: holding?.months ?? null,
      holdingRaw: holding?.raw ?? null,
      tiers,
    });
  }

  return groups;
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx jest kabuyutai-detail`
Expected: PASS(9件)

- [ ] **Step 5: コミット**

```bash
git add lambda/shared/kabuyutai-detail.ts test/kabuyutai-detail.test.ts
git commit -m "Add a parser for the kabuyutai detail-page benefit tier tables"
```

---

### Task 3: グループから導出スカラーと警告を出す

`benefitGroups` は必要株数・クロス可否・最低保有期間を**包含している**。APIが絞り込みとソートに使うため、スカラーとして取り出す。同じ株数の段階が複数グループに現れるので、どのグループを採るかを一意に決める規則が要る。

**Files:**
- Modify: `lambda/shared/kabuyutai-detail.ts`
- Test: `test/kabuyutai-detail.test.ts`

**Interfaces:**
- Consumes: Task 2 の `BenefitGroup`、Task 1 の `ListBadge`
- Produces:
```ts
export type HoldingKind = 'none' | 'bonus' | 'required' | 'unknown';
export type CrossEligible = 'ok' | 'ng' | 'unknown';
export interface DerivedBenefitScalars {
  requiredShares: number | null;
  holdingKind: HoldingKind;
  holdingMinMonths: number | null;
  crossEligible: CrossEligible;
  minTierValueYen: number | null;
  benefitParseWarning: string | null;
}
export function deriveBenefitScalars(
  groups: BenefitGroup[],
  listBadge: ListBadge | undefined,
): DerivedBenefitScalars;
```

- [ ] **Step 1: 失敗するテストを `test/kabuyutai-detail.test.ts` に追記する**

import 行を差し替え、ファイル末尾にテストを足す。

```ts
import { parseBenefitDetail, deriveBenefitScalars } from '../lambda/shared/kabuyutai-detail';
```

```ts
test('derives bonus kind when an unconditional group sits alongside a long-holding one', () => {
  const derived = deriveBenefitScalars(parseBenefitDetail(TOBA_HTML), 'chouki');
  expect(derived).toEqual({
    requiredShares: 100,
    holdingKind: 'bonus',
    holdingMinMonths: null,
    crossEligible: 'ok',
    minTierValueYen: 1000,
    benefitParseWarning: null,
  });
});

test('picks the easiest holding group when several share the minimum tier', () => {
  // ミライトは1年以上と3年以上の両方に100株段階がある。クロス後に実際に
  // 到達しやすいのは1年以上の方なので、その価値(1,000円)を採る。
  const derived = deriveBenefitScalars(parseBenefitDetail(MIRAIT_HTML), 'choukinomi');
  expect(derived.requiredShares).toBe(100);
  expect(derived.holdingKind).toBe('required');
  expect(derived.holdingMinMonths).toBe(12);
  expect(derived.crossEligible).toBe('ng');
  expect(derived.minTierValueYen).toBe(1000);
  expect(derived.benefitParseWarning).toBeNull();
});

test('derives required kind from a single long-holding group', () => {
  const derived = deriveBenefitScalars(parseBenefitDetail(MAITAKE_HTML), 'choukinomi');
  expect(derived.holdingKind).toBe('required');
  expect(derived.holdingMinMonths).toBe(6);
  expect(derived.crossEligible).toBe('ng');
  expect(derived.requiredShares).toBe(100);
  expect(derived.minTierValueYen).toBe(3000);
});

test('derives none kind and an above-unit required share count', () => {
  const derived = deriveBenefitScalars(parseBenefitDetail(DKKARAOKE_HTML), null);
  expect(derived.holdingKind).toBe('none');
  expect(derived.holdingMinMonths).toBeNull();
  expect(derived.crossEligible).toBe('ok');
  expect(derived.requiredShares).toBe(200);
  expect(derived.minTierValueYen).toBe(5000);
  expect(derived.benefitParseWarning).toBeNull();
});

test('ignores long-holding groups when choosing the required share count', () => {
  // ノジマの条件なしグループは300株・10,000株・3,000株。2年以上グループの
  // 300株に引きずられず、条件なしの最小(300株=15,000円)を採る。
  const derived = deriveBenefitScalars(parseBenefitDetail(NOJIMA_HTML), 'chouki');
  expect(derived.requiredShares).toBe(300);
  expect(derived.holdingKind).toBe('bonus');
  expect(derived.crossEligible).toBe('ok');
  expect(derived.minTierValueYen).toBe(15000);
});

test('warns when the same benefit type and holding period appear twice', () => {
  // ノジマは「ポイント/2年以上」のグループが2つ現れる(年2回の中間/期末の
  // 区別がパーサーで落ちている)。表示用途では許容するが、黙って見過ごさない。
  const derived = deriveBenefitScalars(parseBenefitDetail(NOJIMA_HTML), 'chouki');
  expect(derived.benefitParseWarning).toBe('duplicate-groups');
});

test('warns and falls back to the badge when nothing could be parsed', () => {
  expect(deriveBenefitScalars([], 'choukinomi')).toEqual({
    requiredShares: null,
    holdingKind: 'unknown',
    holdingMinMonths: null,
    crossEligible: 'ng',
    minTierValueYen: null,
    benefitParseWarning: 'no-groups',
  });
  expect(deriveBenefitScalars([], 'chouki').crossEligible).toBe('ok');
  expect(deriveBenefitScalars([], null).crossEligible).toBe('ok');
  // バッジ自体が未取得(この変更より前に同期された行)なら判定できない
  expect(deriveBenefitScalars([], undefined).crossEligible).toBe('unknown');
});

test('warns when no tier anywhere has a readable yen amount', () => {
  const groups = [
    { title: '◎自社製品', holdingMonths: null, holdingRaw: null, tiers: [{ shares: 100, valueYen: null, rawText: '自社製品1点' }] },
  ];
  const derived = deriveBenefitScalars(groups, null);
  expect(derived.benefitParseWarning).toBe('no-values');
  expect(derived.minTierValueYen).toBeNull();
  // 金額が読めなくても必要株数は確定できる
  expect(derived.requiredShares).toBe(100);
});

test('warns when the badge disagrees with the parsed holding conditions', () => {
  // バッジは「長期優待のみ」(=クロス不可)だが、個別ページには条件なしの
  // グループがある。どちらかの解析が壊れているので可視化する。
  const derived = deriveBenefitScalars(parseBenefitDetail(DKKARAOKE_HTML), 'choukinomi');
  expect(derived.benefitParseWarning).toBe('badge-mismatch');
  // 食い違ったときは保有条件の原文を読んでいる個別ページ側を採る
  expect(derived.crossEligible).toBe('ok');
});

test('joins several warnings with a comma', () => {
  const groups = [
    { title: '◎A', holdingMonths: 24, holdingRaw: '継続保有期間2年以上', tiers: [{ shares: 100, valueYen: null, rawText: 'ー' }] },
    { title: '◎A', holdingMonths: 24, holdingRaw: '継続保有期間2年以上', tiers: [{ shares: 100, valueYen: null, rawText: 'ー' }] },
  ];
  expect(deriveBenefitScalars(groups, null).benefitParseWarning).toBe('duplicate-groups,no-values,badge-mismatch');
});
```

最後のテストの `badge-mismatch` は、バッジなし(`null` = 条件なし = `ok`)に対して解析結果が `required`(`ng`)なので正しく立つ。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx jest kabuyutai-detail`
Expected: FAIL — `deriveBenefitScalars` が存在しない(`TypeError: ... is not a function`)

- [ ] **Step 3: `lambda/shared/kabuyutai-detail.ts` に導出を追加する**

ファイル先頭の import と、末尾に以下を足す。

```ts
import type { ListBadge } from './kabuyutai-client';
```

```ts
export type HoldingKind = 'none' | 'bonus' | 'required' | 'unknown';
export type CrossEligible = 'ok' | 'ng' | 'unknown';

export interface DerivedBenefitScalars {
  requiredShares: number | null;
  holdingKind: HoldingKind;
  holdingMinMonths: number | null;
  crossEligible: CrossEligible;
  minTierValueYen: number | null;
  // 解析の不完全さの理由をカンマ区切りで連結する(例 'duplicate-groups,no-values')。
  // 該当なしはnull。画面で「この銘柄は要確認」と出すために使う。
  benefitParseWarning: string | null;
}

// 一覧ページのバッジだけから見たクロス可否。'chouki'(長期優遇あり)は長期保有で
// 上乗せされるだけなので最低段階はクロスで取れる。バッジなしも条件なしなので取れる。
function crossEligibleFromBadge(listBadge: ListBadge | undefined): CrossEligible {
  if (listBadge === undefined) return 'unknown';
  return listBadge === 'choukinomi' ? 'ng' : 'ok';
}

// requiredShares と minTierValueYen を一意に決める。実データでは同じ株数の段階が
// 複数グループに現れる(鳥羽洋行の100株は「条件なし=1,000円」と「3年以上=2,000円」の
// 両方にある)ため、株数だけで価値を決めてはならない。
function chooseGroup(groups: BenefitGroup[]): { group: BenefitGroup; shares: number } | null {
  // クロスで取れるグループを優先する。1つも無ければ(全グループが継続保有必須)
  // 全グループを候補にして「保有条件を満たせば何株必要か」を示す。
  const unconditional = groups.filter((group) => group.holdingMonths === null);
  const candidates = unconditional.length > 0 ? unconditional : groups;

  const allShares = candidates.flatMap((group) => group.tiers.map((tier) => tier.shares));
  if (allShares.length === 0) return null;
  const shares = Math.min(...allShares);

  // 同じ最小株数を持つグループが複数あれば、継続保有期間が短い方(= 到達しやすい方)を
  // 採り、それも同じなら文書順で先のものを採る。sortは安定なので文書順は保たれる。
  const holders = candidates
    .filter((group) => group.tiers.some((tier) => tier.shares === shares))
    .sort((a, b) => (a.holdingMonths ?? -1) - (b.holdingMonths ?? -1));

  return { group: holders[0], shares };
}

export function deriveBenefitScalars(
  groups: BenefitGroup[],
  listBadge: ListBadge | undefined,
): DerivedBenefitScalars {
  if (groups.length === 0) {
    // 解析できなかった場合だけ一覧ページのバッジに頼る。バッジは保有条件の有無しか
    // 分からないので、必要株数や段階の金額は埋められない。
    return {
      requiredShares: null,
      holdingKind: 'unknown',
      holdingMinMonths: null,
      crossEligible: crossEligibleFromBadge(listBadge),
      minTierValueYen: null,
      benefitParseWarning: 'no-groups',
    };
  }

  const conditional = groups.filter((group) => group.holdingMonths !== null);
  const holdingKind: HoldingKind =
    conditional.length === groups.length ? 'required' : conditional.length > 0 ? 'bonus' : 'none';
  const crossEligible: CrossEligible = holdingKind === 'required' ? 'ng' : 'ok';

  const chosen = chooseGroup(groups);
  const shares = chosen?.shares ?? null;
  const minTierValueYen =
    chosen === null
      ? null
      : (chosen.group.tiers.find((tier) => tier.shares === chosen.shares)?.valueYen ?? null);

  const warnings: string[] = [];

  const groupKeys = groups.map((group) => `${group.title ?? ''}|${group.holdingMonths ?? ''}`);
  if (new Set(groupKeys).size !== groupKeys.length) warnings.push('duplicate-groups');

  if (groups.every((group) => group.tiers.every((tier) => tier.valueYen === null))) {
    warnings.push('no-values');
  }

  const badgeView = crossEligibleFromBadge(listBadge);
  if (badgeView !== 'unknown' && badgeView !== crossEligible) warnings.push('badge-mismatch');

  return {
    requiredShares: shares,
    holdingKind,
    // 全グループが継続保有必須のときだけ「最低どれだけ持つ必要があるか」が意味を持つ。
    // bonusのときは条件なしで取れるので最低保有期間は無い。
    holdingMinMonths:
      holdingKind === 'required' ? Math.min(...conditional.map((group) => group.holdingMonths as number)) : null,
    crossEligible,
    minTierValueYen,
    benefitParseWarning: warnings.length > 0 ? warnings.join(',') : null,
  };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx jest kabuyutai-detail`
Expected: PASS(19件 — Task 2 の9件と本タスクの10件)

- [ ] **Step 5: 型チェックとコミット**

```bash
npm run build
git add lambda/shared/kabuyutai-detail.ts test/kabuyutai-detail.test.ts
git commit -m "Derive required shares, cross eligibility, and parse warnings from benefit groups"
```

---

### Task 4: yutai-detail-sync-batch

個別ページを取得してマスタに書くバッチ。15分制限に収めるため「1回あたり上限 + `conditionCheckedAt` クールダウンで再開」にする(既存 `gyakuhibu-history-batch` と同じパターン)。

**Files:**
- Modify: `lambda/shared/kabuyutai-client.ts`(`fetchDetailPage` を追加)
- Create: `lambda/yutai-detail-sync-batch/index.ts`
- Test: `test/yutai-detail-sync-batch.test.ts`

**Interfaces:**
- Consumes: Task 2 の `parseBenefitDetail`、Task 3 の `deriveBenefitScalars`
- Produces:
  - `export async function fetchDetailPage(url: string): Promise<string>`(kabuyutai-client)
  - ハンドラのイベント型 `{ codePrefix?: string; tickers?: string[]; maxFetches?: number }`
  - マスタ行の新属性: `benefitGroups`、`requiredShares`、`holdingKind`、`holdingMinMonths`、`crossEligible`、`minTierValueYen`、`benefitParseWarning`、`conditionCheckedAt`
  - 環境変数 `YUTAI_MASTER_TABLE_NAME`、`YUTAI_DETAIL_COOLDOWN_DAYS`(既定 `90`)、`MAX_DETAIL_FETCHES_PER_RUN`(既定 `300`)

- [ ] **Step 1: `fetchDetailPage` のテストを `test/kabuyutai-client.test.ts` に足す**

```ts
test('fetchDetailPage returns the body and sends the bot user agent', async () => {
  mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '<html>detail</html>' });

  await expect(fetchDetailPage('https://www.kabuyutai.com/kobetu/toba.html')).resolves.toBe('<html>detail</html>');
  expect(mockFetch).toHaveBeenCalledWith('https://www.kabuyutai.com/kobetu/toba.html', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JQuantsYutaiBot/1.0)' },
  });
});

test('fetchDetailPage throws on a non-OK response', async () => {
  mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => '' });

  await expect(fetchDetailPage('https://www.kabuyutai.com/kobetu/gone.html')).rejects.toThrow('404');
});
```

import 行に `fetchDetailPage` を足す。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx jest kabuyutai-client`
Expected: FAIL — `fetchDetailPage` is not a function

- [ ] **Step 3: `lambda/shared/kabuyutai-client.ts` に `fetchDetailPage` を足す**

既存の private な `fetchPage` を再利用するだけ。`findTicker` の直前に置く。

```ts
// 個別ページを1枚取得する。呼び出し元(yutai-detail-sync-batch)が銘柄ごとに
// REQUEST_INTERVAL_MSの間隔を空ける責務を持つ。ここで間隔を取らないのは、
// 単一ページの取得関数が自分で待つと呼び出し側の進捗管理と二重になるため。
export async function fetchDetailPage(url: string): Promise<string> {
  return fetchPage(url);
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx jest kabuyutai-client`
Expected: PASS

- [ ] **Step 5: `test/yutai-detail-sync-batch.test.ts` に失敗するテストを書く**

```ts
const mockSend = jest.fn();
const mockFetchDetailPage = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  ScanCommand: jest.fn((input: Record<string, unknown>) => ({ ...input, __type: 'Scan' })),
  UpdateCommand: jest.fn((input: Record<string, unknown>) => ({ ...input, __type: 'Update' })),
}));
jest.mock('../lambda/shared/kabuyutai-client', () => ({
  fetchDetailPage: (...args: unknown[]) => mockFetchDetailPage(...args),
}));

process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.KABUYUTAI_REQUEST_INTERVAL_MS = '0';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/yutai-detail-sync-batch/index') as {
  handler: (event: { codePrefix?: string; tickers?: string[]; maxFetches?: number }) => Promise<void>;
};

// 個別ページ1枚ぶんの最小HTML。条件なしの100株→1,000円だけを持つ。
const SIMPLE_DETAIL_HTML = `
<section id="yutai_detail">
<h3>◎オリジナルQUOカード</h3>
<table><tr><td>100株</td><td><b>1,000円</b>相当</td></tr></table>
</section>
<p>この企業の公式ホームページ</p>
`;

function masterRow(ticker: string, overrides: Record<string, unknown> = {}) {
  return {
    ticker,
    detailUrl: `https://www.kabuyutai.com/kobetu/${ticker}.html`,
    listBadge: null,
    ...overrides,
  };
}

// Scan 1回ぶんの応答を返し、以降のUpdateには空応答を返す。
function mockScanThenUpdates(rows: Record<string, unknown>[]) {
  mockSend.mockImplementation((input: { __type: string }) => {
    if (input.__type === 'Scan') return Promise.resolve({ Items: rows });
    return Promise.resolve({});
  });
}

function updateCalls() {
  return mockSend.mock.calls
    .map((call) => call[0] as { __type: string; Key?: { ticker: string }; ExpressionAttributeValues?: Record<string, unknown> })
    .filter((input) => input.__type === 'Update');
}

beforeEach(() => {
  mockSend.mockReset();
  mockFetchDetailPage.mockReset();
  delete process.env.YUTAI_DETAIL_COOLDOWN_DAYS;
  delete process.env.MAX_DETAIL_FETCHES_PER_RUN;
});

test('writes the parsed groups and the derived scalars for a ticker', async () => {
  mockScanThenUpdates([masterRow('7472')]);
  mockFetchDetailPage.mockResolvedValue(SIMPLE_DETAIL_HTML);

  await handler({});

  expect(mockFetchDetailPage).toHaveBeenCalledWith('https://www.kabuyutai.com/kobetu/7472.html');
  const values = updateCalls()[0].ExpressionAttributeValues!;
  expect(values[':requiredShares']).toBe(100);
  expect(values[':holdingKind']).toBe('none');
  expect(values[':crossEligible']).toBe('ok');
  expect(values[':minTierValueYen']).toBe(1000);
  expect(values[':benefitParseWarning']).toBeNull();
  expect(values[':benefitGroups']).toEqual([
    {
      title: '◎オリジナルQUOカード',
      holdingMonths: null,
      holdingRaw: null,
      tiers: [{ shares: 100, valueYen: 1000, rawText: '1,000円 相当' }],
    },
  ]);
  // 次回のクールダウン判定に使う取得日
  expect(values[':conditionCheckedAt']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('only processes tickers whose code starts with codePrefix', async () => {
  mockScanThenUpdates([masterRow('1375'), masterRow('7472'), masterRow('7458')]);
  mockFetchDetailPage.mockResolvedValue(SIMPLE_DETAIL_HTML);

  await handler({ codePrefix: '7' });

  expect(updateCalls().map((call) => call.Key!.ticker)).toEqual(['7472', '7458']);
});

test('skips tickers checked within the cooldown window', async () => {
  const recent = new Date();
  recent.setDate(recent.getDate() - 10);
  const old = new Date();
  old.setDate(old.getDate() - 200);

  mockScanThenUpdates([
    masterRow('1111', { conditionCheckedAt: recent.toISOString().slice(0, 10) }),
    masterRow('2222', { conditionCheckedAt: old.toISOString().slice(0, 10) }),
    masterRow('3333'),
  ]);
  mockFetchDetailPage.mockResolvedValue(SIMPLE_DETAIL_HTML);

  await handler({});

  // 10日前は90日のクールダウン内なので対象外。200日前と未取得は対象。
  expect(updateCalls().map((call) => call.Key!.ticker)).toEqual(['2222', '3333']);
});

test('stops after maxFetches and leaves the rest for the next run', async () => {
  mockScanThenUpdates([masterRow('1111'), masterRow('2222'), masterRow('3333')]);
  mockFetchDetailPage.mockResolvedValue(SIMPLE_DETAIL_HTML);

  await handler({ maxFetches: 2 });

  expect(mockFetchDetailPage).toHaveBeenCalledTimes(2);
  expect(updateCalls().map((call) => call.Key!.ticker)).toEqual(['1111', '2222']);
});

test('the tickers mode ignores both the cooldown and codePrefix', async () => {
  const today = new Date().toISOString().slice(0, 10);
  mockScanThenUpdates([masterRow('7458', { conditionCheckedAt: today }), masterRow('1375')]);
  mockFetchDetailPage.mockResolvedValue(SIMPLE_DETAIL_HTML);

  // 今日取得済みでもコード先頭が違っても、名指しされた銘柄は必ず取り直す
  // (直したパーサーを1銘柄で即座に確かめるための口)。
  await handler({ tickers: ['7458'], codePrefix: '9' });

  expect(updateCalls().map((call) => call.Key!.ticker)).toEqual(['7458']);
});

test('skips a row with no detail URL without failing the run', async () => {
  mockScanThenUpdates([masterRow('1111', { detailUrl: undefined }), masterRow('2222')]);
  mockFetchDetailPage.mockResolvedValue(SIMPLE_DETAIL_HTML);

  await handler({});

  expect(mockFetchDetailPage).toHaveBeenCalledTimes(1);
  expect(updateCalls().map((call) => call.Key!.ticker)).toEqual(['2222']);
});

test('keeps going when one ticker fails to fetch', async () => {
  mockScanThenUpdates([masterRow('1111'), masterRow('2222')]);
  mockFetchDetailPage
    .mockRejectedValueOnce(new Error('kabuyutai.com error 503'))
    .mockResolvedValueOnce(SIMPLE_DETAIL_HTML);

  await expect(handler({})).resolves.toBeUndefined();

  // 失敗した銘柄はconditionCheckedAtを書かないので次回また対象になる
  expect(updateCalls().map((call) => call.Key!.ticker)).toEqual(['2222']);
});

test('records a warning and falls back to the badge when the page cannot be parsed', async () => {
  mockScanThenUpdates([masterRow('1111', { listBadge: 'choukinomi' })]);
  mockFetchDetailPage.mockResolvedValue('<html><body>構造が変わった</body></html>');

  await handler({});

  const values = updateCalls()[0].ExpressionAttributeValues!;
  expect(values[':benefitParseWarning']).toBe('no-groups');
  expect(values[':crossEligible']).toBe('ng');
  expect(values[':requiredShares']).toBeNull();
  expect(values[':benefitGroups']).toEqual([]);
  // 解析失敗でもconditionCheckedAtは書く。書かないと毎回同じ銘柄を取り直し、
  // 構造変化が直るまで他の銘柄が進まなくなる。
  expect(values[':conditionCheckedAt']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
```

- [ ] **Step 6: テストが失敗することを確認する**

Run: `npx jest yutai-detail-sync-batch`
Expected: FAIL — `Cannot find module '../lambda/yutai-detail-sync-batch/index'`

- [ ] **Step 7: `lambda/yutai-detail-sync-batch/index.ts` を作る**

```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { fetchDetailPage, type ListBadge } from '../shared/kabuyutai-client';
import { deriveBenefitScalars, parseBenefitDetail } from '../shared/kabuyutai-detail';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const REQUEST_INTERVAL_MS = Number(process.env.KABUYUTAI_REQUEST_INTERVAL_MS ?? '1000');
// 優待条件は銘柄あたり年1回も変わらないことが多い。90日あれば、取りこぼしの
// 再取得には十分で、かつ全銘柄を取り直し続ける無駄も避けられる。
const COOLDOWN_DAYS = Number(process.env.YUTAI_DETAIL_COOLDOWN_DAYS ?? '90');
// 1リクエスト/秒なので300件で約5分。Step Functions経由では最大バケット(3000台・
// 274件)がこれを下回るため実際には発動しない。codePrefixを省いた全銘柄の手動実行と、
// 将来バケットが育ったときの安全弁として置く。超えた分は次回実行に持ち越される。
const MAX_DETAIL_FETCHES_PER_RUN = Number(process.env.MAX_DETAIL_FETCHES_PER_RUN ?? '300');

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export interface DetailSyncEvent {
  // '1'〜'9'。銘柄コードの先頭がこれで始まる銘柄だけを処理する(Step Functionsの
  // Mapが渡す)。省略時は全銘柄。
  codePrefix?: string;
  // 名指しした銘柄だけを、クールダウンとcodePrefixを無視して処理する。
  tickers?: string[];
  maxFetches?: number;
}

interface MasterRow {
  ticker: string;
  detailUrl: string | undefined;
  listBadge: ListBadge | undefined;
  conditionCheckedAt: string | undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function cooldownCutoff(): string {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - COOLDOWN_DAYS);
  return cutoff.toISOString().slice(0, 10);
}

function isListBadge(value: unknown): value is ListBadge {
  return value === 'chouki' || value === 'choukinomi' || value === null;
}

async function scanMaster(): Promise<MasterRow[]> {
  const rows: MasterRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({
        TableName: YUTAI_MASTER_TABLE_NAME,
        // 1,642銘柄の全属性を読むと無駄が大きい。判定に必要な4項目だけを取る。
        ProjectionExpression: 'ticker, detailUrl, listBadge, conditionCheckedAt',
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of result.Items ?? []) {
      if (typeof item.ticker !== 'string') continue;
      rows.push({
        ticker: item.ticker,
        detailUrl: typeof item.detailUrl === 'string' ? item.detailUrl : undefined,
        // 「バッジなし(null)」と「まだ一覧ページを取り直していない(undefined)」は
        // 別物。前者はクロス可の根拠になるが、後者は何の情報も無い。
        listBadge: isListBadge(item.listBadge) ? item.listBadge : undefined,
        conditionCheckedAt: typeof item.conditionCheckedAt === 'string' ? item.conditionCheckedAt : undefined,
      });
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return rows;
}

function selectTargets(rows: MasterRow[], event: DetailSyncEvent): MasterRow[] {
  if (event.tickers && event.tickers.length > 0) {
    const wanted = new Set(event.tickers);
    return rows.filter((row) => wanted.has(row.ticker));
  }

  const cutoff = cooldownCutoff();
  return rows.filter((row) => {
    if (event.codePrefix && !row.ticker.startsWith(event.codePrefix)) return false;
    return row.conditionCheckedAt === undefined || row.conditionCheckedAt < cutoff;
  });
}

export const handler = async (event: DetailSyncEvent = {}): Promise<void> => {
  const limit = event.maxFetches ?? MAX_DETAIL_FETCHES_PER_RUN;
  const targets = selectTargets(await scanMaster(), event).slice(0, limit);

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const warningCounts = new Map<string, number>();

  for (const [index, row] of targets.entries()) {
    if (row.detailUrl === undefined) {
      // 一覧ページの再同期(yutai-master-sync-batch)がまだ走っていない行。
      console.warn(`${row.ticker}: no detailUrl on the master row; run yutai-master-sync-batch first`);
      skipped++;
      continue;
    }

    // 2件目以降だけ待つ。先頭で待つと1件だけの単一銘柄モードが無駄に遅くなる。
    if (index > 0) await sleep(REQUEST_INTERVAL_MS);

    try {
      const groups = parseBenefitDetail(await fetchDetailPage(row.detailUrl));
      const derived = deriveBenefitScalars(groups, row.listBadge);

      await ddbDocClient.send(
        new UpdateCommand({
          TableName: YUTAI_MASTER_TABLE_NAME,
          Key: { ticker: row.ticker },
          UpdateExpression:
            'SET benefitGroups = :benefitGroups, requiredShares = :requiredShares, holdingKind = :holdingKind, ' +
            'holdingMinMonths = :holdingMinMonths, crossEligible = :crossEligible, minTierValueYen = :minTierValueYen, ' +
            'benefitParseWarning = :benefitParseWarning, conditionCheckedAt = :conditionCheckedAt',
          ExpressionAttributeValues: {
            ':benefitGroups': groups,
            ':requiredShares': derived.requiredShares,
            ':holdingKind': derived.holdingKind,
            ':holdingMinMonths': derived.holdingMinMonths,
            ':crossEligible': derived.crossEligible,
            ':minTierValueYen': derived.minTierValueYen,
            ':benefitParseWarning': derived.benefitParseWarning,
            // 解析できなかった行にもconditionCheckedAtを書く。書かないと毎回同じ
            // 銘柄を取り直し、サイト構造が直るまで他の銘柄が進まなくなる。
            ':conditionCheckedAt': todayIso(),
          },
        }),
      );

      if (derived.benefitParseWarning !== null) {
        for (const reason of derived.benefitParseWarning.split(',')) {
          warningCounts.set(reason, (warningCounts.get(reason) ?? 0) + 1);
        }
      }
      updated++;
    } catch (error) {
      // 1銘柄の失敗で残りを止めない(本プロジェクトの他バッチと同じ方針)。
      // conditionCheckedAtを書いていないので次回また対象になる。
      failed++;
      console.error(`${row.ticker}: failed to fetch/parse the detail page`, error);
    }
  }

  const warningSummary =
    warningCounts.size > 0
      ? [...warningCounts].map(([reason, count]) => `${reason}=${count}`).join(' ')
      : 'none';
  console.log(
    `yutai-detail-sync-batch: codePrefix=${event.codePrefix ?? 'all'} targets=${targets.length} ` +
      `updated=${updated} skipped=${skipped} failed=${failed} warnings: ${warningSummary}`,
  );
};
```

- [ ] **Step 8: テストが通ることを確認する**

Run: `npx jest yutai-detail-sync-batch`
Expected: PASS(8件)

- [ ] **Step 9: 型チェックとコミット**

```bash
npm run build
git add lambda/shared/kabuyutai-client.ts lambda/yutai-detail-sync-batch/index.ts test/kabuyutai-client.test.ts test/yutai-detail-sync-batch.test.ts
git commit -m "Add yutai-detail-sync-batch to fetch and store benefit tier conditions"
```

---

### Task 5: Step Functions で9バケット直列実行

1,642銘柄を1リクエスト/秒で直列処理すると約33分かかり、Lambdaの15分制限を超える。銘柄コード先頭1桁で9バケットに分け、Step Functions の Map で**1つずつ**回す。

**Files:**
- Modify: `lib/j-quants-stack.ts`
- Test: `test/j-quants.test.ts`

**Interfaces:**
- Consumes: Task 4 のハンドラとそのイベント型・環境変数
- Produces: CDK 論理ID `YutaiDetailSyncBatchFunction`、`YutaiDetailSyncStateMachine`

実測の銘柄コード分布(2026-10-01、1,642銘柄): 1000台=54、2000台=204、3000台=274、4000台=186、5000台=96、6000台=141、7000台=269、8000台=184、9000台=234。最大バケットは274件で1リクエスト/秒なら約5.5分、15分制限に対して余裕がある。

- [ ] **Step 1: `test/j-quants.test.ts` に失敗するテストを足す**

既存ファイルの先頭にある `Template.fromStack(stack)` を作るヘルパー(`templateFor()` 等)の名前を確認し、それを使う。

```ts
test('the yutai detail sync Lambda has the yutai master table and a long timeout', () => {
  const template = templateFor();

  template.hasResourceProperties('AWS::Lambda::Function', {
    Timeout: 840,
    MemorySize: 256,
    Environment: {
      Variables: Match.objectLike({
        YUTAI_MASTER_TABLE_NAME: { Ref: Match.anyValue() },
      }),
    },
    Handler: 'index.handler',
  });
});

test('the detail sync state machine fans out to nine code-prefix buckets one at a time', () => {
  const template = templateFor();

  // 並列にするとkabuyutai.comへ秒9リクエストを送ることになり、各Lambda内の
  // 1リクエスト/秒ガードが無意味になる。Mapは15分制限の回避だけが目的なので
  // MaxConcurrencyは必ず1でなければならない。
  template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
  const machines = template.findResources('AWS::StepFunctions::StateMachine');
  const definition = JSON.stringify(Object.values(machines)[0].Properties.DefinitionString);

  expect(definition).toContain('"MaxConcurrency":1');
  for (const prefix of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
    expect(definition).toContain(`{\\"codePrefix\\":\\"${prefix}\\"}`);
  }
});

test('the detail sync batch has no EventBridge schedule of its own', () => {
  // 優待条件は年1回も変わらないため手動運用。スケジュールを足すと
  // kabuyutai.comへ無意味な定期アクセスを続けることになる。
  const template = templateFor();
  const rules = template.findResources('AWS::Events::Rule');
  const targets = Object.values(rules).flatMap((rule) => rule.Properties.Targets ?? []);
  const targetArns = JSON.stringify(targets);
  expect(targetArns).not.toContain('YutaiDetailSyncBatchFunction');
});
```

`DefinitionString` の中身は `Fn::Join` になるため、`JSON.stringify` した文字列に対してエスケープ済みのJSON片(`{\"codePrefix\":\"1\"}` が `{\\"codePrefix\\":\\"1\\"}` になる)を探す。実際のエスケープの形は一度テストを走らせて失敗メッセージで確認し、合わせること。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx jest j-quants`
Expected: FAIL — `AWS::StepFunctions::StateMachine` が0個

- [ ] **Step 3: `lib/j-quants-stack.ts` に import を足す**

```ts
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as stepfunctions_tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
```

- [ ] **Step 4: Lambda とステートマシンを定義する**

`yutaiRiskPrecomputeBatchFn` のブロック(`YutaiRiskPrecomputeBatchSchedule` の直後)に続けて書く。

```ts
    const yutaiDetailSyncBatchFn = new nodejs.NodejsFunction(this, 'YutaiDetailSyncBatchFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'yutai-detail-sync-batch', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // 1銘柄1リクエスト/秒。最大バケット(3000台・274件)で約5.5分なので14分で足りる。
      timeout: cdk.Duration.minutes(14),
      memorySize: 256,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
      },
    });

    this.yutaiMasterTable.grantReadWriteData(yutaiDetailSyncBatchFn);

    // 1,642銘柄を1リクエスト/秒で直列処理すると約33分かかり、Lambdaの15分制限を
    // 超える。銘柄コード先頭1桁で9バケットに分けて1つずつ回す。
    //
    // maxConcurrencyは必ず1。並列にするとkabuyutai.comへ秒9リクエストを送ることに
    // なり、各Lambda内の1リクエスト/秒ガードが無意味になる。Mapは15分制限の回避の
    // ためだけに使っており、速くするためではない。
    const detailSyncBucket = new stepfunctions_tasks.LambdaInvoke(this, 'YutaiDetailSyncBucket', {
      lambdaFunction: yutaiDetailSyncBatchFn,
      payload: stepfunctions.TaskInput.fromJsonPathAt('$'),
      // バケットの戻り値を次の状態に渡さない(Step Functionsのペイロード上限に
      // 無駄にカウントされないようにする)。
      resultPath: stepfunctions.JsonPath.DISCARD,
    });

    detailSyncBucket.addRetry({
      errors: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'States.Timeout'],
      maxAttempts: 3,
      interval: cdk.Duration.seconds(30),
      backoffRate: 2,
    });

    const detailSyncMap = new stepfunctions.Map(this, 'YutaiDetailSyncBuckets', {
      // 1000台〜9000台。再実行はconditionCheckedAtにより冪等で、成功済みの銘柄は
      // 取り直されない。
      items: stepfunctions.ProvideItems.jsonArray(
        ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((codePrefix) => ({ codePrefix })),
      ),
      maxConcurrency: 1,
    });
    detailSyncMap.itemProcessor(detailSyncBucket);

    new stepfunctions.StateMachine(this, 'YutaiDetailSyncStateMachine', {
      stateMachineName: 'JQuantsYutaiDetailSync',
      definitionBody: stepfunctions.DefinitionBody.fromChainable(detailSyncMap),
      // 9バケット直列で約33分。リトライ込みでも余裕を持たせる。
      timeout: cdk.Duration.hours(2),
    });
```

- [ ] **Step 5: テストを走らせる**

Run: `npx jest j-quants`

使用する Step Functions の API は aws-cdk-lib 2.263.0 の実物で確認済み(2026-10-02)。
`ProvideItems.jsonArray` / `ProvideItems.jsonata` の2つだけが存在する(`fromJson` は無い)。
`Map.prototype.itemProcessor`・`DefinitionBody.fromChainable`・`JsonPath.DISCARD`・
`TaskInput.fromJsonPathAt`・`stepfunctions_tasks.LambdaInvoke` はいずれも存在する。
`Map.iterator` は deprecated なので使わない。

`DefinitionString` は `Fn::Join` に展開されるため、テストで中身を文字列として探す際の
エスケープの形は一度テストを走らせて失敗メッセージで確認し、実際の形に合わせること。
アサーションの意図(`MaxConcurrency` が 1、9バケット分の `codePrefix` が入っている)は
変えてはならない。

- [ ] **Step 6: テストが通ることを確認する**

Run: `npx jest j-quants && npm run build`
Expected: PASS

既存のCDKテストが `AWS::Lambda::Function` や `AWS::Events::Rule` の**件数**を固定で assert している場合、Lambdaを1つ足したことで壊れる。壊れた assert はその件数を新しい値に更新する(件数を assert している意図を消さない)。新しいリソースの存在は本タスクの新規テストが受け持つ。

- [ ] **Step 7: コミット**

```bash
git add lib/j-quants-stack.ts test/j-quants.test.ts
git commit -m "Run yutai-detail-sync-batch through a nine-bucket serial Step Functions map"
```

---

### Task 6: 逆日歩実績から前回・前年同月を選ぶ

`JQuantsGyakuhibuActual` の `totalAmount` は記録当時の `unitShares` を掛けた値なので、必要株数が変わると意味が合わなくなる。株数に依存しない `avgRate`(1株1日あたり料率)と `days` から必要株数ベースのコストを組み直す。

**Files:**
- Create: `lambda/shared/gyakuhibu-actual-summary.ts`
- Test: `test/gyakuhibu-actual-summary.test.ts`

**Interfaces:**
- Produces:
```ts
export interface GyakuhibuActualRef {
  rightsDate: string;
  avgRate: number;
  days: number;
  perShareRate: number;
  cost: number;
  basedOnUnitShares: boolean;
}
export interface ActualRowInput { rightsDate?: unknown; avgRate?: unknown; days?: unknown; }
export function summarizeActuals(
  rows: ActualRowInput[],
  nextRightsDate: string | undefined,
  requiredShares: number | null,
  unitShares: number,
): { last: GyakuhibuActualRef | null; sameMonthLastYear: GyakuhibuActualRef | null };
```

- [ ] **Step 1: `test/gyakuhibu-actual-summary.test.ts` に失敗するテストを書く**

```ts
import { summarizeActuals } from '../lambda/shared/gyakuhibu-actual-summary';

// JQuantsGyakuhibuActualの行の形(ticker/rightsDateがキー、avgRateは1株1日あたり料率、
// daysは品貸日数)。gyakuhibu-history-batchが書いている値をそのまま使う。
const ROWS = [
  { rightsDate: '2024-09-26', avgRate: 1.5, days: 3 },
  { rightsDate: '2025-03-27', avgRate: 0.5, days: 1 },
  { rightsDate: '2025-09-26', avgRate: 2.0, days: 3 },
];

test('takes the row with the latest rights date as the last result', () => {
  const { last } = summarizeActuals(ROWS, '2026-09-28', 300, 100);
  expect(last).toEqual({
    rightsDate: '2025-09-26',
    avgRate: 2.0,
    days: 3,
    // perShareRate = avgRate × days。taisyaku.jpの1株あたり品貸料そのもの。
    perShareRate: 6,
    // cost = perShareRate × 必要株数
    cost: 1800,
    basedOnUnitShares: false,
  });
});

test('takes the same calendar month of the previous year for the seasonal comparison', () => {
  const { sameMonthLastYear } = summarizeActuals(ROWS, '2026-09-28', 300, 100);
  // 次回権利日が2026-09なので、前年同月は2025-09(2024-09ではない)
  expect(sameMonthLastYear?.rightsDate).toBe('2025-09-26');
  expect(sameMonthLastYear?.cost).toBe(1800);
});

test('falls back to unitShares and flags it when the required share count is unknown', () => {
  const { last } = summarizeActuals(ROWS, '2026-09-28', null, 100);
  expect(last?.cost).toBe(600);
  expect(last?.basedOnUnitShares).toBe(true);
});

test('keeps a no-fee rights date as a zero cost rather than dropping it', () => {
  // 逆日歩が付かなかった権利日はavgRate=0・days=0で記録される
  // (gyakuhibu-history-batchのnoGyakuhibu行)。「前回は0円だった」は
  // 「前回のデータが無い」とは全く違う情報なので落としてはならない。
  const { last } = summarizeActuals([{ rightsDate: '2026-03-27', avgRate: 0, days: 0 }], '2026-09-28', 300, 100);
  expect(last).toEqual({
    rightsDate: '2026-03-27',
    avgRate: 0,
    days: 0,
    perShareRate: 0,
    cost: 0,
    basedOnUnitShares: false,
  });
});

test('ignores rows whose rate or day count is not a number', () => {
  const rows = [
    { rightsDate: '2025-09-26', avgRate: 2.0, days: 3 },
    { rightsDate: '2026-03-27', avgRate: null, days: 1 },
    { rightsDate: '2026-09-28' },
  ];
  // 壊れた行を落とした結果、最新は2025-09-26になる
  expect(summarizeActuals(rows, '2026-09-28', 100, 100).last?.rightsDate).toBe('2025-09-26');
});

test('returns nulls when there is no usable history', () => {
  expect(summarizeActuals([], '2026-09-28', 100, 100)).toEqual({ last: null, sameMonthLastYear: null });
});

test('returns a null seasonal comparison when the next rights date is unknown', () => {
  const { last, sameMonthLastYear } = summarizeActuals(ROWS, undefined, 100, 100);
  expect(last?.rightsDate).toBe('2025-09-26');
  expect(sameMonthLastYear).toBeNull();
});

test('returns a null seasonal comparison when the previous year has no row in that month', () => {
  const { sameMonthLastYear } = summarizeActuals(ROWS, '2026-06-26', 100, 100);
  expect(sameMonthLastYear).toBeNull();
});

test('does not treat the same row as both last and seasonal when the year differs', () => {
  const rows = [{ rightsDate: '2026-09-28', avgRate: 1.0, days: 2 }];
  const { last, sameMonthLastYear } = summarizeActuals(rows, '2026-09-28', 100, 100);
  // 今年の同じ権利日は「前年同月」ではない
  expect(last?.rightsDate).toBe('2026-09-28');
  expect(sameMonthLastYear).toBeNull();
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx jest gyakuhibu-actual-summary`
Expected: FAIL — `Cannot find module '../lambda/shared/gyakuhibu-actual-summary'`

- [ ] **Step 3: `lambda/shared/gyakuhibu-actual-summary.ts` を作る**

```ts
// JQuantsGyakuhibuActualの履歴から「前回」と「前年同月」を選び、必要株数ベースの
// 概算コストに組み直す。純関数のみ(DynamoDBには触れない)。

export interface GyakuhibuActualRef {
  rightsDate: string;
  // 1株1日あたりの品貸料率。株数にも日数にも依存しない。
  avgRate: number;
  days: number;
  // 1株あたりのその権利日の品貸料(= avgRate × days)。taisyaku.jpの生の値に相当する。
  perShareRate: number;
  // perShareRate × 株数。
  cost: number;
  // requiredSharesが未取得で、単元株数で代用したことを画面に示すためのフラグ。
  basedOnUnitShares: boolean;
}

export interface ActualRowInput {
  rightsDate?: unknown;
  avgRate?: unknown;
  days?: unknown;
}

interface UsableRow {
  rightsDate: string;
  avgRate: number;
  days: number;
}

// JQuantsGyakuhibuActual.totalAmountは記録当時のunitSharesを掛けた値なので、
// 必要株数が変わると意味が合わなくなる。avgRateとdaysは株数に依存しないため、
// ここから組み直す(設計書の「コストの再計算」参照)。
function toRef(row: UsableRow, shares: number, basedOnUnitShares: boolean): GyakuhibuActualRef {
  const perShareRate = row.avgRate * row.days;
  return {
    rightsDate: row.rightsDate,
    avgRate: row.avgRate,
    days: row.days,
    perShareRate,
    cost: perShareRate * shares,
    basedOnUnitShares,
  };
}

// 逆日歩が付かなかった権利日はavgRate=0・days=0で記録される。これは「コスト0円」
// という有用な情報なので、days===0で捨ててはならない。
function usableRows(rows: ActualRowInput[]): UsableRow[] {
  const usable: UsableRow[] = [];
  for (const row of rows) {
    if (typeof row.rightsDate !== 'string') continue;
    if (typeof row.avgRate !== 'number' || typeof row.days !== 'number') continue;
    usable.push({ rightsDate: row.rightsDate, avgRate: row.avgRate, days: row.days });
  }
  return usable.sort((a, b) => a.rightsDate.localeCompare(b.rightsDate));
}

export function summarizeActuals(
  rows: ActualRowInput[],
  nextRightsDate: string | undefined,
  requiredShares: number | null,
  unitShares: number,
): { last: GyakuhibuActualRef | null; sameMonthLastYear: GyakuhibuActualRef | null } {
  const basedOnUnitShares = requiredShares === null;
  const shares = requiredShares ?? unitShares;
  const sorted = usableRows(rows);
  if (sorted.length === 0) return { last: null, sameMonthLastYear: null };

  const last = toRef(sorted[sorted.length - 1], shares, basedOnUnitShares);

  // 権利月ごとに需給の季節性が出る(同じ銘柄でも3月と9月で逆日歩が大きく違う)ため、
  // 直近の権利日だけでなく「次回と同じ月の前年」も見せる。
  let sameMonthLastYear: GyakuhibuActualRef | null = null;
  if (nextRightsDate !== undefined) {
    const targetYear = Number(nextRightsDate.slice(0, 4)) - 1;
    const targetMonth = nextRightsDate.slice(5, 7);
    const prefix = `${targetYear}-${targetMonth}`;
    // 同月に複数行あることは通常ないが、あれば遅い方(sorted末尾側)を採る。
    const match = sorted.filter((row) => row.rightsDate.startsWith(prefix)).pop();
    if (match) sameMonthLastYear = toRef(match, shares, basedOnUnitShares);
  }

  return { last, sameMonthLastYear };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx jest gyakuhibu-actual-summary`
Expected: PASS(9件)

- [ ] **Step 5: コミット**

```bash
git add lambda/shared/gyakuhibu-actual-summary.ts test/gyakuhibu-actual-summary.test.ts
git commit -m "Summarize gyakuhibu actuals into last and prior-year-same-month costs"
```

---

### Task 7: 日次バッチを必要株数ベースに切り替える

`yutai-risk-precompute-batch` は今 `minInvestment ÷ 株価` で必要株数を推定し、その値で `unitShares` を**上書きしている**。株価が動くと結果が変わる不安定な推定なので、`requiredShares` に置き換えて推定を削除する。あわせて前回逆日歩を行に集計する。

**Files:**
- Modify: `lambda/yutai-risk-precompute-batch/index.ts`
- Modify: `lib/j-quants-stack.ts`(逆日歩実績テーブルへの読み取り権限と環境変数)
- Test: `test/yutai-risk-precompute-batch.test.ts`, `test/j-quants.test.ts`

**Interfaces:**
- Consumes: Task 3 の `requiredShares` 属性、Task 6 の `summarizeActuals`
- Produces: マスタ行の新属性 `requiredInvestment`(`number | null`)、`lastGyakuhibu`、`sameMonthLastYearGyakuhibu`。**`unitShares` を書かなくなる**

- [ ] **Step 1: `test/yutai-risk-precompute-batch.test.ts` に失敗するテストを足す**

既存ファイルのモック構造(`mockSend` の `mockResolvedValueOnce` の並び = master scan → margin query → price query …)を先に読み、同じ順序を守って書く。逆日歩実績の Query が1本増えるので、**既存テストの `mockResolvedValueOnce` の並びも1つずつずれる**。既存テストを壊さないため、ハンドラでは実績の Query を**価格取得の後**に置く。

```ts
test('uses requiredShares instead of estimating from minInvestment', async () => {
  // 第一興商: 単元100株だが優待は200株。推定ではなく個別ページ由来の正確値を使う。
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '7458', value: 5000, unitShares: 100, minInvestment: 400000, requiredShares: 200, rightsMonths: [3] }] })
    .mockResolvedValueOnce({ Items: [{ ticker: '7458' }] })       // margin balance あり
    .mockResolvedValueOnce({ Items: [{ close: 2000 }] })          // 直近終値
    .mockResolvedValueOnce({ Items: [] })                          // 逆日歩実績なし
    .mockResolvedValueOnce({});                                    // update

  await handler();

  const update = mockSend.mock.calls[4][0] as {
    UpdateExpression: string;
    ExpressionAttributeValues: Record<string, unknown>;
  };
  // unitSharesはもう書かない(単元株数の意味に戻した)
  expect(update.UpdateExpression).not.toContain('unitShares');
  // 必要資金 = 終値 × 必要株数
  expect(update.ExpressionAttributeValues[':requiredInvestment']).toBe(400000);
});

test('falls back to unitShares when requiredShares has not been fetched yet', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '1111', value: 3000, unitShares: 100, minInvestment: null, rightsMonths: [3] }] })
    .mockResolvedValueOnce({ Items: [{ ticker: '1111' }] })
    .mockResolvedValueOnce({ Items: [{ close: 1500 }] })
    .mockResolvedValueOnce({ Items: [] })
    .mockResolvedValueOnce({});

  await handler();

  const update = mockSend.mock.calls[4][0] as { ExpressionAttributeValues: Record<string, unknown> };
  expect(update.ExpressionAttributeValues[':requiredInvestment']).toBe(150000);
});

test('aggregates the last and prior-year-same-month gyakuhibu costs', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '7458', value: 5000, unitShares: 100, requiredShares: 200, rightsMonths: [3] }] })
    .mockResolvedValueOnce({ Items: [{ ticker: '7458' }] })
    .mockResolvedValueOnce({ Items: [{ close: 2000 }] })
    .mockResolvedValueOnce({
      Items: [
        { rightsDate: '2024-03-27', avgRate: 1.0, days: 3 },
        { rightsDate: '2025-03-27', avgRate: 2.0, days: 3 },
      ],
    })
    .mockResolvedValueOnce({});

  await handler();

  const values = (mockSend.mock.calls[4][0] as { ExpressionAttributeValues: Record<string, unknown> })
    .ExpressionAttributeValues;
  const last = values[':lastGyakuhibu'] as { rightsDate: string; cost: number; basedOnUnitShares: boolean };
  expect(last.rightsDate).toBe('2025-03-27');
  expect(last.cost).toBe(1200); // 2.0 × 3日 × 200株
  expect(last.basedOnUnitShares).toBe(false);
});

test('writes null summaries for a ticker with no actual history', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '1111', value: 3000, unitShares: 100, requiredShares: 100, rightsMonths: [3] }] })
    .mockResolvedValueOnce({ Items: [{ ticker: '1111' }] })
    .mockResolvedValueOnce({ Items: [{ close: 1500 }] })
    .mockResolvedValueOnce({ Items: [] })
    .mockResolvedValueOnce({});

  await handler();

  const values = (mockSend.mock.calls[4][0] as { ExpressionAttributeValues: Record<string, unknown> })
    .ExpressionAttributeValues;
  expect(values[':lastGyakuhibu']).toBeNull();
  expect(values[':sameMonthLastYearGyakuhibu']).toBeNull();
});

test('still aggregates the actual history when the risk verdict is na', async () => {
  // 信用残が無くリスク判定ができない銘柄でも、過去に実際に取られたコストは
  // 独立した事実なので一覧に出す価値がある。
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '1111', value: 3000, unitShares: 100, requiredShares: 100, rightsMonths: [3] }] })
    .mockResolvedValueOnce({ Items: [] })  // margin balance なし → riskStatus 'na'
    .mockResolvedValueOnce({ Items: [{ rightsDate: '2025-03-27', avgRate: 1.0, days: 2 }] })
    .mockResolvedValueOnce({});

  await handler();

  const values = (mockSend.mock.calls[3][0] as { ExpressionAttributeValues: Record<string, unknown> })
    .ExpressionAttributeValues;
  expect(values[':riskStatus']).toBe('na');
  expect((values[':lastGyakuhibu'] as { cost: number }).cost).toBe(200);
});
```

最後のテストが示す通り、信用残が無い場合は価格取得をスキップするため Query の本数が変わる。既存コードの早期 return の形を読んで、実績 Query が常に走る位置(`calcRisk` の外)に置くこと。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx jest yutai-risk-precompute-batch`
Expected: FAIL — `:requiredInvestment` が `undefined`

- [ ] **Step 3: `lambda/yutai-risk-precompute-batch/index.ts` を書き換える**

import と定数を足す。

```ts
import { summarizeActuals } from '../shared/gyakuhibu-actual-summary';
```

```ts
const GYAKUHIBU_ACTUAL_TABLE_NAME = process.env.GYAKUHIBU_ACTUAL_TABLE_NAME!;
```

`MasterRow` に `requiredShares` を足し、`scanYutaiMaster` でも読む。

```ts
interface MasterRow {
  ticker: string;
  value: number | null;
  unitShares: number;
  requiredShares: number | null;
  rightsMonths: number[];
}
```

```ts
        rows.push({
          ticker: item.ticker,
          value: typeof item.value === 'number' ? item.value : null,
          unitShares: item.unitShares,
          // yutai-detail-sync-batchが個別ページから取った正確な必要株数。
          // 未取得の銘柄ではnullになり、単元株数で代用する。
          requiredShares: typeof item.requiredShares === 'number' ? item.requiredShares : null,
          rightsMonths: item.rightsMonths ?? [],
        });
```

`minInvestment` は `MasterRow` から外す(もう使わない)。

`estimateRequiredShares` 関数と、その上の長いコメントを**削除**する。

実績取得を足す。`latestClose` の近くに置く。

```ts
// その銘柄の逆日歩実績を全件取る。権利日は年1〜2回なので、数年分でも数十行に収まる。
async function fetchActualRows(ticker: string): Promise<Array<Record<string, unknown>>> {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: GYAKUHIBU_ACTUAL_TABLE_NAME,
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: { ':ticker': ticker },
    }),
  );
  return result.Items ?? [];
}
```

`RiskResult` から `unitShares` を外し、`requiredInvestment` を足す。

```ts
interface RiskResult {
  riskStatus: RiskStatus;
  maxGyakuhibu: number | null;
  maxRate: number | null;
  days: number | null;
  closePrice: number | null;
  requiredInvestment: number | null;
}

const NA_RISK: RiskResult = {
  riskStatus: 'na',
  maxGyakuhibu: null,
  maxRate: null,
  days: null,
  closePrice: null,
  requiredInvestment: null,
};
```

`calcRisk` のシグネチャと中身を直す。`estimateRequiredShares` の呼び出しを消し、`shares` を引数で受ける。

```ts
async function calcRisk(
  row: { ticker: string; value: number | null },
  shares: number,
  rightsDate: string | undefined,
  calendarCache: Map<string, CalendarDay[]>,
): Promise<RiskResult> {
  if (!rightsDate) return NA_RISK;
  if (!(await hasMarginBalance(row.ticker))) return NA_RISK;

  const closePrice = await latestClose(row.ticker);
  if (closePrice === undefined) return NA_RISK;

  const calendarTo = new Date(rightsDate);
  calendarTo.setDate(calendarTo.getDate() + 14);
  const calendar = fetchTradingCalendarCached(rightsDate, calendarTo.toISOString().slice(0, 10), calendarCache);
  // 品貸日数(days)は日証金の用語集の定義通り「受渡日(T+2)〜その翌営業日」の暦日数
  // (taisyaku.jpの実データで検証済み。docs/superpowers/specs/2026-08-13-yutai-cross-risk-design.md参照)。
  const settlement = settlementDate(calendar, rightsDate);
  const followingTradingDay = businessDaysAfter(calendar, settlement, 1);
  const days = calendarDaysBetween(settlement, followingTradingDay);

  // rightsDateは常に「権利落日の前営業日」(taisyaku.jpの倍率適用規定)に一致するため、
  // 最高料率は無条件に4倍で見積もる(docs/superpowers/notes/2026-09-03-taisyaku-rights-day-rate-multiplier.md参照)。
  const maxRate = calcMaxRate(closePrice, shares) * RIGHTS_DAY_RATE_MULTIPLIER;
  const maxGyakuhibu = calcMaxGyakuhibu(closePrice, shares, days) * RIGHTS_DAY_RATE_MULTIPLIER;
  const riskStatus: RiskStatus = row.value === null ? 'na' : row.value > maxGyakuhibu ? 'safe' : 'danger';
  return { riskStatus, maxGyakuhibu, maxRate, days, closePrice, requiredInvestment: closePrice * shares };
}
```

ハンドラを直す。

```ts
export const handler = async (): Promise<void> => {
  const rows = await scanYutaiMaster();
  const calendarCache = new Map<string, CalendarDay[]>();

  let updated = 0;
  for (const row of rows) {
    try {
      const rightsDate = nextRightsDate(row.rightsMonths);
      // requiredSharesが未取得(yutai-detail-sync-batchがまだ回っていない)なら
      // 単元株数で代用する。代用したことはsummarizeActualsがbasedOnUnitSharesで
      // 画面に伝える。
      const shares = row.requiredShares ?? row.unitShares;
      const risk = await calcRisk(row, shares, rightsDate, calendarCache);
      // 実績の集計はリスク判定とは独立(信用残が無くriskStatusがnaの銘柄でも、
      // 過去に実際に取られたコストは出す価値がある)。
      const actuals = summarizeActuals(await fetchActualRows(row.ticker), rightsDate, row.requiredShares, row.unitShares);

      await ddbDocClient.send(
        new UpdateCommand({
          TableName: YUTAI_MASTER_TABLE_NAME,
          Key: { ticker: row.ticker },
          // unitSharesはもう書かない。単元株数(100株固定)はyutai-master-sync-batchが
          // 持ち、優待に必要な株数はyutai-detail-sync-batchのrequiredSharesが持つ。
          UpdateExpression:
            'SET riskStatus = :riskStatus, maxGyakuhibu = :maxGyakuhibu, maxRate = :maxRate, #days = :days, ' +
            'closePrice = :closePrice, requiredInvestment = :requiredInvestment, ' +
            'lastGyakuhibu = :lastGyakuhibu, sameMonthLastYearGyakuhibu = :sameMonthLastYearGyakuhibu',
          ExpressionAttributeNames: { '#days': 'days' },
          ExpressionAttributeValues: {
            ':riskStatus': risk.riskStatus,
            ':maxGyakuhibu': risk.maxGyakuhibu,
            ':maxRate': risk.maxRate,
            ':days': risk.days,
            ':closePrice': risk.closePrice,
            ':requiredInvestment': risk.requiredInvestment,
            ':lastGyakuhibu': actuals.last,
            ':sameMonthLastYearGyakuhibu': actuals.sameMonthLastYear,
          },
        }),
      );
      updated++;
    } catch (error) {
      console.error(`${row.ticker}: failed to precompute/update risk`, error);
    }
  }

  console.log(`yutai-risk-precompute-batch: updated ${updated} of ${rows.length} rows`);
};
```

- [ ] **Step 4: CDK に権限と環境変数を足す**

`lib/j-quants-stack.ts` の `yutaiRiskPrecomputeBatchFn` の `environment` に1行、その下に grant を1行足す。

```ts
      environment: {
        YUTAI_MASTER_TABLE_NAME: this.yutaiMasterTable.tableName,
        MARGIN_BALANCE_TABLE_NAME: this.marginBalanceTable.tableName,
        TABLE_NAME: this.stockPricesTable.tableName,
        GYAKUHIBU_ACTUAL_TABLE_NAME: this.gyakuhibuActualTable.tableName,
      },
```

```ts
    this.gyakuhibuActualTable.grantReadData(yutaiRiskPrecomputeBatchFn);
```

- [ ] **Step 5: CDK のテストを足す**

```ts
test('the yutai risk precompute Lambda can read the gyakuhibu actual table', () => {
  const template = templateFor();

  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: {
      Variables: Match.objectLike({
        GYAKUHIBU_ACTUAL_TABLE_NAME: { Ref: Match.anyValue() },
        MARGIN_BALANCE_TABLE_NAME: { Ref: Match.anyValue() },
      }),
    },
  });
});
```

- [ ] **Step 6: テストを通す**

Run: `npx jest yutai-risk-precompute-batch j-quants && npm run build`
Expected: PASS

既存テストが `unitShares` の書き込みや `minInvestment` からの推定を assert している場合、その assert は**仕様が変わったので書き換える**(削除ではなく、新しい仕様 — `unitShares` を書かないこと — を確かめる形に変える)。`estimateRequiredShares` を直接テストしている箇所があれば削除する。

- [ ] **Step 7: コミット**

```bash
git add lambda/yutai-risk-precompute-batch/index.ts lib/j-quants-stack.ts test/yutai-risk-precompute-batch.test.ts test/j-quants.test.ts
git commit -m "Use the exact required share count and aggregate past gyakuhibu costs in the daily batch"
```

---

### Task 8: API に項目と絞り込みを足す

`GET /yutai` と `GET /yutai/forecast` は同じ `scanYutaiMaster()` と `passesYutaiFilters()` を共有している。共有部分に足せば両方の一覧に同じ項目と絞り込みが入る。

**Files:**
- Modify: `lambda/reference-api/index.ts`
- Test: `test/reference-api.test.ts`

**Interfaces:**
- Consumes: Task 3/7 でマスタ行に入った属性
- Produces: 項目は2層に分ける。
```ts
// 優待条件(個別ページ由来)。一覧と詳細の両方に出す。
interface BenefitFields {
  unitShares: number;
  requiredShares: number | null;
  crossEligible: 'ok' | 'ng' | 'unknown';
  holdingKind: 'none' | 'bonus' | 'required' | 'unknown';
  holdingMinMonths: number | null;
  minTierValueYen: number | null;
  benefitParseWarning: string | null;
}
// 条件 + 価格・コスト。一覧だけに出す。
interface CrossFields extends BenefitFields {
  closePrice: number | null;
  requiredInvestment: number | null;
  lastGyakuhibu: GyakuhibuActualRef | null;
  sameMonthLastYearGyakuhibu: GyakuhibuActualRef | null;
}
```
  2層に分ける理由: `GET /yutai/:ticker` は既に `basicInfo.closePrice`(リクエスト時点のライブ値)を返している。そこに precompute のスナップショット値を `closePrice` として並べると、同じ名前で違う値が1つのレスポンスに2つ入る罠になる。詳細は `BenefitFields` だけを受け取り、価格は `basicInfo` 側に一本化する。

  2つの一覧(`GET /yutai`、`GET /yutai/forecast`)は `CrossFields`、`GET /yutai/:ticker` は `BenefitFields` + `benefitGroups`。
  クエリパラメータ `priceMin` / `priceMax` / `investmentMin` / `investmentMax` / `crossEligible` を両一覧で受ける。

- [ ] **Step 1: `test/reference-api.test.ts` に失敗するテストを足す**

既存ファイルのリクエスト組み立てヘルパー(`invoke({ rawPath, queryStringParameters })` 等)の名前を確認して合わせる。

```ts
// マスタ行1件ぶんの素材。個別ページ取得済み・実績ありの状態。
function crossMasterItem(overrides: Record<string, unknown> = {}) {
  return {
    ticker: '7458',
    companyName: '第一興商',
    content: '優待利用割引カード（5,000円相当～）',
    value: 5000,
    unitShares: 100,
    requiredShares: 200,
    crossEligible: 'ok',
    holdingKind: 'none',
    holdingMinMonths: null,
    minTierValueYen: 5000,
    benefitParseWarning: null,
    rightsMonths: [3],
    riskStatus: 'safe',
    maxGyakuhibu: 1200,
    maxRate: 400,
    days: 3,
    closePrice: 2000,
    requiredInvestment: 400000,
    lastGyakuhibu: { rightsDate: '2025-03-27', avgRate: 2, days: 3, perShareRate: 6, cost: 1200, basedOnUnitShares: false },
    sameMonthLastYearGyakuhibu: { rightsDate: '2025-03-27', avgRate: 2, days: 3, perShareRate: 6, cost: 1200, basedOnUnitShares: false },
    ...overrides,
  };
}

test('GET /yutai returns the cross-eligibility and cost fields', async () => {
  mockSend.mockResolvedValueOnce({ Items: [crossMasterItem()] });

  const response = await invoke({ rawPath: '/yutai', queryStringParameters: {} });
  const item = JSON.parse(response.body).tickers[0];

  expect(item.unitShares).toBe(100);
  expect(item.requiredShares).toBe(200);
  expect(item.crossEligible).toBe('ok');
  expect(item.holdingKind).toBe('none');
  expect(item.holdingMinMonths).toBeNull();
  expect(item.minTierValueYen).toBe(5000);
  expect(item.benefitParseWarning).toBeNull();
  expect(item.requiredInvestment).toBe(400000);
  expect(item.lastGyakuhibu.cost).toBe(1200);
  expect(item.sameMonthLastYearGyakuhibu.rightsDate).toBe('2025-03-27');
  // 既存項目が消えていないこと
  expect(item.maxGyakuhibu).toBe(1200);
  expect(item.rightsDate).toBeDefined();
});

test('GET /yutai defaults the cross fields for a row the detail sync has not reached', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [{ ticker: '1111', content: '割引券', value: 1000, unitShares: 100, rightsMonths: [3] }],
  });

  const item = JSON.parse((await invoke({ rawPath: '/yutai', queryStringParameters: {} })).body).tickers[0];

  // 項目を省略したり例外を投げたりせず、既定値で埋める
  expect(item.requiredShares).toBeNull();
  expect(item.crossEligible).toBe('unknown');
  expect(item.holdingKind).toBe('unknown');
  expect(item.lastGyakuhibu).toBeNull();
  expect(item.requiredInvestment).toBeNull();
});

test('GET /yutai filters by share price range', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [
      crossMasterItem({ ticker: '1111', closePrice: 500 }),
      crossMasterItem({ ticker: '2222', closePrice: 2000 }),
      crossMasterItem({ ticker: '3333', closePrice: 9000 }),
    ],
  });

  const response = await invoke({ rawPath: '/yutai', queryStringParameters: { priceMin: '1000', priceMax: '5000' } });
  expect(JSON.parse(response.body).tickers.map((t: { ticker: string }) => t.ticker)).toEqual(['2222']);
});

test('GET /yutai filters by required investment range', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [
      crossMasterItem({ ticker: '1111', requiredInvestment: 50000 }),
      crossMasterItem({ ticker: '2222', requiredInvestment: 400000 }),
    ],
  });

  const response = await invoke({ rawPath: '/yutai', queryStringParameters: { investmentMax: '100000' } });
  expect(JSON.parse(response.body).tickers.map((t: { ticker: string }) => t.ticker)).toEqual(['1111']);
});

test('a range filter excludes rows whose value is unknown', async () => {
  // 「株価100万円以下」の検索結果に株価不明の銘柄を混ぜない。
  mockSend.mockResolvedValueOnce({
    Items: [crossMasterItem({ ticker: '1111', closePrice: null }), crossMasterItem({ ticker: '2222', closePrice: 2000 })],
  });

  const response = await invoke({ rawPath: '/yutai', queryStringParameters: { priceMax: '5000' } });
  expect(JSON.parse(response.body).tickers.map((t: { ticker: string }) => t.ticker)).toEqual(['2222']);
});

test('GET /yutai filters by cross eligibility', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [
      crossMasterItem({ ticker: '1111', crossEligible: 'ok' }),
      crossMasterItem({ ticker: '2222', crossEligible: 'ng' }),
      crossMasterItem({ ticker: '3333', crossEligible: 'unknown' }),
    ],
  });

  const response = await invoke({ rawPath: '/yutai', queryStringParameters: { crossEligible: 'ng' } });
  expect(JSON.parse(response.body).tickers.map((t: { ticker: string }) => t.ticker)).toEqual(['2222']);
});

test('an all or absent cross eligibility filter keeps every row', async () => {
  mockSend.mockResolvedValueOnce({
    Items: [crossMasterItem({ ticker: '1111', crossEligible: 'ok' }), crossMasterItem({ ticker: '2222', crossEligible: 'ng' })],
  });

  const response = await invoke({ rawPath: '/yutai', queryStringParameters: { crossEligible: 'all' } });
  expect(JSON.parse(response.body).tickers).toHaveLength(2);
});

test('a non-numeric range filter is ignored rather than dropping every row', async () => {
  mockSend.mockResolvedValueOnce({ Items: [crossMasterItem()] });

  const response = await invoke({ rawPath: '/yutai', queryStringParameters: { priceMin: 'abc' } });
  expect(JSON.parse(response.body).tickers).toHaveLength(1);
});
```

`GET /yutai/forecast` と `GET /yutai/:ticker` のテストは既存のものに assert を足す形で書く。既存テストのモック順序(`master scan → forecast scan` / `master get → price → summary → actual query`)を必ず守る。

```ts
test('GET /yutai/forecast carries the same cross fields', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [crossMasterItem()] })
    .mockResolvedValueOnce({ Items: [] });

  const item = JSON.parse((await invoke({ rawPath: '/yutai/forecast', queryStringParameters: {} })).body).tickers[0];
  expect(item.requiredShares).toBe(200);
  expect(item.crossEligible).toBe('ok');
  expect(item.lastGyakuhibu.cost).toBe(1200);
  // 予測一覧固有の項目も残っていること
  expect(item.forecast).toBeDefined();
});
```

`GET /yutai/:ticker` のテストでは `benefitGroups` が素通しで返ることを確かめる。

```ts
test('GET /yutai/:ticker returns the benefit tier groups verbatim', async () => {
  const groups = [
    {
      title: '◎優待利用割引カード',
      holdingMonths: null,
      holdingRaw: null,
      tiers: [{ shares: 200, valueYen: 5000, rawText: '5,000円 相当' }],
    },
  ];
  // 既存テストと同じ順序でモックする(master get → price → summary → actual query)
  mockSend
    .mockResolvedValueOnce({ Item: crossMasterItem({ benefitGroups: groups }) })
    .mockResolvedValueOnce({ Items: [{ close: 2000, volume: 1000 }] })
    .mockResolvedValueOnce({ Items: [] })
    .mockResolvedValueOnce({ Items: [] });

  const body = JSON.parse((await invoke({ rawPath: '/yutai/7458' })).body);
  expect(body.benefitGroups).toEqual(groups);
  expect(body.requiredShares).toBe(200);
  expect(body.crossEligible).toBe('ok');
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx jest reference-api`
Expected: FAIL — `item.requiredShares` が `undefined`

- [ ] **Step 3: `YutaiMasterRow` と `scanYutaiMaster` / `getYutaiMaster` を拡張する**

`GyakuhibuActualRef` は Task 6 の共有モジュールの型をそのまま使う(APIで再定義すると、コストの計算方法が変わったときに片方だけ直して食い違う)。既存の `import { getLocalTradingCalendar, nextRightsDate } from '../shared/trading-calendar';` の近くに足す。

```ts
import type { GyakuhibuActualRef } from '../shared/gyakuhibu-actual-summary';
```

```ts
type RiskStatus = 'safe' | 'danger' | 'na';
type CrossEligible = 'ok' | 'ng' | 'unknown';
type HoldingKind = 'none' | 'bonus' | 'required' | 'unknown';

// yutai-detail-sync-batchが書く株数段階。詳細エンドポイントが素通しで返すだけなので
// ここで中身を検証しない(検証はパーサー側の責務)。
interface BenefitTier { shares: number; valueYen: number | null; rawText: string }
interface BenefitGroup { title: string | null; holdingMonths: number | null; holdingRaw: string | null; tiers: BenefitTier[] }

interface YutaiMasterRow {
  ticker: string;
  companyName?: string;
  content: string;
  value: number | null;
  unitShares: number;
  rightsMonths: number[];
  riskStatus: RiskStatus;
  maxGyakuhibu: number | null;
  maxRate: number | null;
  days: number | null;
  closePrice: number | null;
  requiredShares: number | null;
  crossEligible: CrossEligible;
  holdingKind: HoldingKind;
  holdingMinMonths: number | null;
  minTierValueYen: number | null;
  benefitParseWarning: string | null;
  requiredInvestment: number | null;
  lastGyakuhibu: GyakuhibuActualRef | null;
  sameMonthLastYearGyakuhibu: GyakuhibuActualRef | null;
  benefitGroups: BenefitGroup[];
}

// DynamoDBの行をYutaiMasterRowにする。個別ページ取得前の行は新項目を持たないため、
// 省略や例外ではなく既定値(null / 'unknown' / [])で埋める。
function toYutaiMasterRow(item: Record<string, any>): YutaiMasterRow {
  return {
    ticker: item.ticker,
    companyName: item.companyName,
    content: item.content,
    value: item.value ?? null,
    unitShares: item.unitShares,
    rightsMonths: item.rightsMonths ?? [],
    riskStatus: item.riskStatus ?? 'na',
    maxGyakuhibu: item.maxGyakuhibu ?? null,
    maxRate: item.maxRate ?? null,
    days: item.days ?? null,
    closePrice: item.closePrice ?? null,
    requiredShares: item.requiredShares ?? null,
    crossEligible: item.crossEligible ?? 'unknown',
    holdingKind: item.holdingKind ?? 'unknown',
    holdingMinMonths: item.holdingMinMonths ?? null,
    minTierValueYen: item.minTierValueYen ?? null,
    benefitParseWarning: item.benefitParseWarning ?? null,
    requiredInvestment: item.requiredInvestment ?? null,
    lastGyakuhibu: item.lastGyakuhibu ?? null,
    sameMonthLastYearGyakuhibu: item.sameMonthLastYearGyakuhibu ?? null,
    benefitGroups: item.benefitGroups ?? [],
  };
}
```

`scanYutaiMaster` のループ本体を `rows.push(toYutaiMasterRow(item));` に、`getYutaiMaster` の `return {...}` を `return toYutaiMasterRow(result.Item);` に置き換える。

- [ ] **Step 4: 共通のレスポンス項目ビルダーを足す**

`passesYutaiFilters` の近くに置く。

```ts
// 優待条件(個別ページ由来)。2つの一覧と詳細の3箇所で共通。
function buildBenefitFields(row: YutaiMasterRow) {
  return {
    unitShares: row.unitShares,
    requiredShares: row.requiredShares,
    crossEligible: row.crossEligible,
    holdingKind: row.holdingKind,
    holdingMinMonths: row.holdingMinMonths,
    minTierValueYen: row.minTierValueYen,
    benefitParseWarning: row.benefitParseWarning,
  };
}

// 条件 + 価格・コスト。2つの一覧(GET /yutai と GET /yutai/forecast)専用。
// 片方だけに足すと「同じ判断が両方の画面でできる」という要件が崩れるため、
// 必ずこの関数を経由する。
//
// closePriceはprecomputeが日次で書いたスナップショットで、requiredInvestmentを
// 算出した元の値。詳細エンドポイントには渡さない — あちらは既にリクエスト時点の
// ライブ値をbasicInfo.closePriceで返しており、同名で違う値が並ぶのを避ける。
function buildCrossFields(row: YutaiMasterRow) {
  return {
    ...buildBenefitFields(row),
    closePrice: row.closePrice,
    requiredInvestment: row.requiredInvestment,
    lastGyakuhibu: row.lastGyakuhibu,
    sameMonthLastYearGyakuhibu: row.sameMonthLastYearGyakuhibu,
  };
}
```

- [ ] **Step 5: 絞り込みを拡張する**

```ts
interface YutaiListFilters {
  keyword?: string;
  rightsDateFrom?: string;
  rightsDateTo?: string;
  priceMin?: number;
  priceMax?: number;
  investmentMin?: number;
  investmentMax?: number;
  crossEligible?: CrossEligible;
}

// 数値のクエリパラメータ。空文字や数値でない値は「指定なし」として扱う
// (指定ミスで全件が消えるより、絞り込みが効かない方が気付きやすい)。
function parseNumberParam(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function parseCrossEligibleParam(raw: string | undefined): CrossEligible | undefined {
  return raw === 'ok' || raw === 'ng' || raw === 'unknown' ? raw : undefined;
}

// 範囲指定があるのに値が不明な行は除外する(「株価100万円以下」の結果に株価不明の
// 銘柄を混ぜない)。範囲指定が無ければ値が不明でも通す。
function passesRange(value: number | null, min: number | undefined, max: number | undefined): boolean {
  if (min === undefined && max === undefined) return true;
  if (value === null) return false;
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;
  return true;
}
```

`passesYutaiFilters` の末尾の `return true;` の前に3つの条件を足す。

```ts
  if (!passesRange(row.closePrice, filters.priceMin, filters.priceMax)) return false;
  if (!passesRange(row.requiredInvestment, filters.investmentMin, filters.investmentMax)) return false;
  if (filters.crossEligible && row.crossEligible !== filters.crossEligible) return false;
  return true;
```

両ハンドラの `filters` の組み立てに5項目を足す。`listYutai` と `listYutaiForecast` の**両方**に同じものを書く。

```ts
  const filters: YutaiListFilters = {
    keyword: query.keyword?.toLowerCase(),
    rightsDateFrom: query.rightsDateFrom,
    rightsDateTo: query.rightsDateTo,
    priceMin: parseNumberParam(query.priceMin),
    priceMax: parseNumberParam(query.priceMax),
    investmentMin: parseNumberParam(query.investmentMin),
    investmentMax: parseNumberParam(query.investmentMax),
    crossEligible: parseCrossEligibleParam(query.crossEligible),
  };
```

- [ ] **Step 6: 3つのレスポンスに項目を足す**

`listYutai` の `items.push({...})` に展開を足す。

```ts
    items.push({
      ticker: row.ticker,
      companyName: row.companyName,
      content: row.content,
      value: row.value,
      rightsDate: rightsDate ?? null,
      riskStatus: row.riskStatus,
      maxGyakuhibu: row.maxGyakuhibu,
      ...buildCrossFields(row),
    });
```

`listYutaiForecast` の `items.push({...})` も同様に。既存の `closePrice: row.closePrice,` は `buildCrossFields` が同じ値を返すので**重複行を削除**する。

```ts
    items.push({
      ticker: row.ticker,
      companyName: row.companyName,
      content: row.content,
      value: row.value,
      rightsDate: rightsDate ?? null,
      riskStatus: row.riskStatus,
      maxGyakuhibu: row.maxGyakuhibu,
      forecast,
      tseForecast: buildTseForecast(forecastByTicker.get(row.ticker)),
      ...buildCrossFields(row),
    });
```

`getYutai` の `jsonResponse(200, {...})` に2つ足す。ここは `buildCrossFields` ではなく `buildBenefitFields` を使う(価格・コストは渡さない)。

```ts
    rightsHistory: history,
    benefitGroups: master.benefitGroups,
    ...buildBenefitFields(master),
    features: { tseMargin: tseMarginEnabled() },
```

`getYutai` は既に `unitShares: master.unitShares` を返しているので、`buildBenefitFields` の展開と重複する。同じ値なので動作は変わらないが、既存の行を削除して `buildBenefitFields` 側に寄せる。`basicInfo.closePrice` は**そのまま残す**(リクエスト時点のライブ値)。

- [ ] **Step 7: テストを通す**

Run: `npx jest reference-api && npm run build`
Expected: PASS

- [ ] **Step 8: コミット**

```bash
git add lambda/reference-api/index.ts test/reference-api.test.ts
git commit -m "Expose required shares, cross eligibility, and past gyakuhibu costs on the yutai endpoints"
```

---

### Task 9: フロントの型・APIクライアント・共通モジュール

2つの一覧画面に同じ4列と3つの絞り込みを入れる。片方にしか入れないと「同じ判断が両方でできる」という要件が崩れるので、列定義と絞り込みUIを1つのモジュールに出す。

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/index.css`
- Create: `frontend/src/lib/yutai-cross.tsx`

**Interfaces:**
- Consumes: Task 8 のレスポンス項目とクエリパラメータ
- Produces:
```ts
// types.ts
export type YutaiCrossEligible = 'ok' | 'ng' | 'unknown';
export type YutaiHoldingKind = 'none' | 'bonus' | 'required' | 'unknown';
export interface BenefitTier { shares: number; valueYen: number | null; rawText: string }
export interface BenefitGroup { title: string | null; holdingMonths: number | null; holdingRaw: string | null; tiers: BenefitTier[] }
export interface GyakuhibuActualRef { rightsDate: string; avgRate: number; days: number; perShareRate: number; cost: number; basedOnUnitShares: boolean }
export interface YutaiBenefitFields { /* Task 8 の BenefitFields と同じ7項目 */ }
export interface YutaiCrossFields extends YutaiBenefitFields { /* + 価格・コストの4項目 */ }

// lib/yutai-cross.tsx
export function crossColumns<T extends YutaiCrossFields>(): ColumnDef<T>[];
export interface CrossFilterState { priceMin: string; priceMax: string; investmentMin: string; investmentMax: string; crossEligible: 'all' | YutaiCrossEligible }
export const EMPTY_CROSS_FILTERS: CrossFilterState;
export function toCrossParams(state: CrossFilterState): CrossQueryParams;
export function YutaiCrossFilters(props: { state: CrossFilterState; onChange: (next: CrossFilterState) => void }): JSX.Element;
```

- [ ] **Step 1: `frontend/src/api/types.ts` に型を足す**

`YutaiListItem` の定義の**直前**に置く。

```ts
export type YutaiCrossEligible = 'ok' | 'ng' | 'unknown';
export type YutaiHoldingKind = 'none' | 'bonus' | 'required' | 'unknown';

export interface BenefitTier {
  shares: number;
  // 金額が読めない段階(「ー」= 該当なし、自社製品の個数表記など)はnull。
  // 表示にはrawTextを使う。
  valueYen: number | null;
  rawText: string;
}

export interface BenefitGroup {
  title: string | null;
  holdingMonths: number | null;
  holdingRaw: string | null;
  tiers: BenefitTier[];
}

export interface GyakuhibuActualRef {
  rightsDate: string;
  avgRate: number;
  days: number;
  perShareRate: number;
  cost: number;
  // 必要株数が未取得で単元株数で代用したコスト。画面で注記する。
  basedOnUnitShares: boolean;
}

// 優待条件(個別ページ由来)。2つの一覧と詳細の3箇所で共通。
export interface YutaiBenefitFields {
  unitShares: number;
  requiredShares: number | null;
  crossEligible: YutaiCrossEligible;
  holdingKind: YutaiHoldingKind;
  holdingMinMonths: number | null;
  minTierValueYen: number | null;
  benefitParseWarning: string | null;
}

// 条件 + 価格・コスト。2つの一覧専用。両方の一覧で同じ判断ができるよう、
// 列定義(lib/yutai-cross.tsx)はこの型だけに依存させる。
//
// 詳細(YutaiDetail)はこちらを継承しない。詳細は既にリクエスト時点のライブ値を
// basicInfo.closePriceで持っており、precomputeのスナップショットを同名で並べると
// 同じレスポンスに違う値が2つ入る。
export interface YutaiCrossFields extends YutaiBenefitFields {
  closePrice: number | null;
  requiredInvestment: number | null;
  lastGyakuhibu: GyakuhibuActualRef | null;
  sameMonthLastYearGyakuhibu: GyakuhibuActualRef | null;
}
```

3つのインターフェースを `extends` に変える。**重複するプロパティは削除する**(`YutaiForecastListItem` の `closePrice`、`YutaiDetail` の `unitShares`)。

```ts
export interface YutaiListItem extends YutaiCrossFields {
  ticker: string;
  companyName?: string;
  content: string;
  value: number | null;
  rightsDate: string | null;
  riskStatus: YutaiRiskStatus;
  maxGyakuhibu: number | null;
}
```

```ts
export interface YutaiForecastListItem extends YutaiCrossFields {
  ticker: string;
  companyName?: string;
  content: string;
  value: number | null;
  rightsDate: string | null;
  riskStatus: YutaiRiskStatus;
  maxGyakuhibu: number | null;
  forecast: YutaiForecast;
  tseForecast: YutaiTseForecast | null;
}
```

`YutaiDetail` が継承するのは `YutaiBenefitFields` の方(価格・コストは `basicInfo` と `rightsHistory` が持つ)。

```ts
export interface YutaiDetail extends YutaiBenefitFields {
  ticker: string;
  companyName: string | null;
  content: string;
  value: number | null;
  rightsDate: string | null;
  benefitGroups: BenefitGroup[];
  basicInfo: YutaiBasicInfo;
  risk: YutaiRiskInfo;
  rightsHistory: YutaiRightsHistoryPoint[];
  features: YutaiFeatures;
}
```

- [ ] **Step 2: `frontend/src/api/client.ts` にクエリパラメータを足す**

`YutaiListParams` を拡張し、**両方**の fetcher に同じ5行を足す。`YutaiForecastListParams` は `YutaiListParams` を extends しているので型は自動で付くが、クエリへの書き出しは別々に書かれているため片方だけだと効かない。

```ts
export interface YutaiListParams {
  rightsDateFrom?: string;
  rightsDateTo?: string;
  keyword?: string;
  riskStatus?: 'safe' | 'danger' | 'na' | 'all';
  priceMin?: number;
  priceMax?: number;
  investmentMin?: number;
  investmentMax?: number;
  crossEligible?: YutaiCrossEligible | 'all';
}

// 数値の0は有効な下限なので、truthy判定ではなくundefined判定で書き出す。
function setNumberParam(query: URLSearchParams, key: string, value: number | undefined): void {
  if (value !== undefined) query.set(key, String(value));
}

export function fetchYutaiList(params: YutaiListParams): Promise<YutaiListResponse> {
  const query = new URLSearchParams();
  if (params.rightsDateFrom) query.set('rightsDateFrom', params.rightsDateFrom);
  if (params.rightsDateTo) query.set('rightsDateTo', params.rightsDateTo);
  if (params.keyword) query.set('keyword', params.keyword);
  if (params.riskStatus) query.set('riskStatus', params.riskStatus);
  setNumberParam(query, 'priceMin', params.priceMin);
  setNumberParam(query, 'priceMax', params.priceMax);
  setNumberParam(query, 'investmentMin', params.investmentMin);
  setNumberParam(query, 'investmentMax', params.investmentMax);
  if (params.crossEligible) query.set('crossEligible', params.crossEligible);
  return request(`/yutai?${query}`);
}
```

`fetchYutaiForecastList` にも同じ5行(`setNumberParam` 4つ + `crossEligible`)を足す。import に `YutaiCrossEligible` を足す。

- [ ] **Step 3: `frontend/src/lib/yutai-cross.tsx` を作る**

```tsx
import type { ColumnDef } from '@tanstack/react-table';
import type { YutaiCrossEligible, YutaiCrossFields } from '../api/types';
import { formatFinancialYen } from './format';

const CROSS_LABEL: Record<YutaiCrossEligible, string> = { ok: '可', ng: '長期のみ', unknown: '—' };
// クロス可否は「不可→可→不明」の順に並ぶ方が意味がある(避けたい銘柄を先頭に出せる)。
const CROSS_SORT_RANK: Record<YutaiCrossEligible, number> = { ng: 0, ok: 1, unknown: 2 };
const CROSS_BADGE_CLASS: Record<YutaiCrossEligible, string> = {
  ok: 'risk-badge risk-badge--safe',
  ng: 'risk-badge risk-badge--danger',
  unknown: 'risk-badge risk-badge--na',
};

function formatShares(shares: number, unitShares: number): string {
  const units = unitShares > 0 ? shares / unitShares : null;
  // 単元の整数倍でない場合(データの異常)は株数だけを出す。
  const unitLabel = units !== null && Number.isInteger(units) ? `(${units}単元)` : '';
  return `${shares.toLocaleString('ja-JP')}株${unitLabel}`;
}

// 2つの一覧画面(YutaiListPage / YutaiForecastListPage)で共用する列。片方だけに
// 足すと「同じ判断が両方の画面でできる」という要件が崩れるため、必ずここに置く。
export function crossColumns<T extends YutaiCrossFields>(): ColumnDef<T>[] {
  return [
    {
      id: 'requiredShares',
      header: '必要株数',
      // accessorFnはundefinedを返す(nullではなく) — sortUndefined: 'last'が昇順・
      // 降順どちらでも欠損値を末尾に固定してくれる。
      accessorFn: (row) => row.requiredShares ?? undefined,
      sortDescFirst: false,
      sortUndefined: 'last',
      cell: ({ row }) => {
        const { requiredShares, unitShares } = row.original;
        if (requiredShares === null) return '—';
        // 単元株数と違う銘柄(第一興商の200株、ノジマの300株など)は見落とすと
        // 優待が取れないので強調する。
        const className = requiredShares !== unitShares ? 'shares-above-unit' : undefined;
        return <span className={className}>{formatShares(requiredShares, unitShares)}</span>;
      },
    },
    {
      id: 'crossEligible',
      header: 'クロス',
      accessorFn: (row) => row.crossEligible,
      sortingFn: (rowA, rowB) =>
        CROSS_SORT_RANK[rowA.original.crossEligible] - CROSS_SORT_RANK[rowB.original.crossEligible],
      cell: ({ row }) => {
        const { crossEligible, holdingKind, holdingMinMonths, benefitParseWarning } = row.original;
        const months = holdingKind === 'required' && holdingMinMonths !== null ? `${holdingMinMonths}ヶ月` : null;
        return (
          <>
            <span className={CROSS_BADGE_CLASS[crossEligible]}>{CROSS_LABEL[crossEligible]}</span>
            {months !== null && <span className="cross-months">{months}</span>}
            {/* 解析が不完全な銘柄は詳細ページで原文を確かめてほしい */}
            {benefitParseWarning !== null && <span className="cross-warning" title={benefitParseWarning}>⚠</span>}
          </>
        );
      },
    },
    {
      id: 'requiredInvestment',
      header: '必要資金',
      accessorFn: (row) => row.requiredInvestment ?? undefined,
      sortDescFirst: false,
      sortUndefined: 'last',
      cell: ({ row }) =>
        row.original.requiredInvestment !== null
          ? formatFinancialYen(String(Math.round(row.original.requiredInvestment)))
          : '—',
    },
    {
      id: 'lastGyakuhibu',
      header: '前回逆日歩',
      accessorFn: (row) => row.lastGyakuhibu?.cost ?? undefined,
      sortDescFirst: true,
      sortUndefined: 'last',
      cell: ({ row }) => {
        const { lastGyakuhibu, sameMonthLastYearGyakuhibu } = row.original;
        if (lastGyakuhibu === null) return '—';
        // 権利月ごとに需給の季節性が出るため、直近だけでなく前年同月も併記する。
        // 同じ権利日なら重複表示しない。
        const seasonal =
          sameMonthLastYearGyakuhibu !== null && sameMonthLastYearGyakuhibu.rightsDate !== lastGyakuhibu.rightsDate
            ? sameMonthLastYearGyakuhibu
            : null;
        return (
          <>
            {formatFinancialYen(String(Math.round(lastGyakuhibu.cost)))}
            <span className="gyakuhibu-date">{lastGyakuhibu.rightsDate}</span>
            {seasonal !== null && (
              <span className="gyakuhibu-seasonal">
                (前年同月 {formatFinancialYen(String(Math.round(seasonal.cost)))})
              </span>
            )}
            {lastGyakuhibu.basedOnUnitShares && (
              <span className="gyakuhibu-note" title="必要株数が未取得のため単元株数(100株)で概算しています">
                ※
              </span>
            )}
          </>
        );
      },
    },
  ];
}

export interface CrossFilterState {
  // 入力中の中間状態(空文字、「-」など)を保持するため文字列で持つ。
  // 数値への変換はtoCrossParamsが行う。
  priceMin: string;
  priceMax: string;
  investmentMin: string;
  investmentMax: string;
  crossEligible: 'all' | YutaiCrossEligible;
}

export const EMPTY_CROSS_FILTERS: CrossFilterState = {
  priceMin: '',
  priceMax: '',
  investmentMin: '',
  investmentMax: '',
  crossEligible: 'all',
};

function toNumber(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export interface CrossQueryParams {
  priceMin?: number;
  priceMax?: number;
  investmentMin?: number;
  investmentMax?: number;
  crossEligible?: 'all' | YutaiCrossEligible;
}

export function toCrossParams(state: CrossFilterState): CrossQueryParams {
  return {
    priceMin: toNumber(state.priceMin),
    priceMax: toNumber(state.priceMax),
    investmentMin: toNumber(state.investmentMin),
    investmentMax: toNumber(state.investmentMax),
    crossEligible: state.crossEligible,
  };
}

export function YutaiCrossFilters({
  state,
  onChange,
}: {
  state: CrossFilterState;
  onChange: (next: CrossFilterState) => void;
}) {
  const update = (patch: Partial<CrossFilterState>) => onChange({ ...state, ...patch });

  return (
    <>
      <label>
        株価:{' '}
        <input
          type="number"
          className="input input--narrow"
          value={state.priceMin}
          onChange={(e) => update({ priceMin: e.target.value })}
          placeholder="下限"
        />
        {' 〜 '}
        <input
          type="number"
          className="input input--narrow"
          value={state.priceMax}
          onChange={(e) => update({ priceMax: e.target.value })}
          placeholder="上限"
        />
      </label>
      <label>
        必要資金:{' '}
        <input
          type="number"
          className="input input--narrow"
          value={state.investmentMin}
          onChange={(e) => update({ investmentMin: e.target.value })}
          placeholder="下限"
        />
        {' 〜 '}
        <input
          type="number"
          className="input input--narrow"
          value={state.investmentMax}
          onChange={(e) => update({ investmentMax: e.target.value })}
          placeholder="上限"
        />
      </label>
      <label>
        クロス可否:{' '}
        <select
          value={state.crossEligible}
          onChange={(e) => update({ crossEligible: e.target.value as CrossFilterState['crossEligible'] })}
        >
          <option value="all">すべて</option>
          <option value="ok">可</option>
          <option value="ng">長期のみ</option>
          <option value="unknown">不明</option>
        </select>
      </label>
    </>
  );
}
```

- [ ] **Step 4: `frontend/src/index.css` にクラスを足す**

既存の `.risk-badge--caution`(367行目付近)の直後に足す。

```css
/* 単元株数と必要株数が違う銘柄(第一興商の200株など)は見落とすと優待が取れない */
.shares-above-unit {
  font-weight: 700;
  color: var(--caution);
}

.cross-months,
.gyakuhibu-date,
.gyakuhibu-seasonal,
.gyakuhibu-note {
  margin-left: 0.35rem;
  font-size: 0.75rem;
  color: var(--text-muted);
}

.cross-warning {
  margin-left: 0.35rem;
  font-size: 0.75rem;
  color: var(--caution);
  cursor: help;
}

.input--narrow {
  width: 6rem;
}
```

- [ ] **Step 5: 型チェックとビルド**

Run: `cd frontend && npm run build && npm run lint`
Expected: 成功。この時点では新しい列も絞り込みもまだ画面に組み込まれていないため、`yutai-cross.tsx` が未使用であることによる lint の警告が出る可能性がある。出た場合は Task 10 で解消されるので、ここでは `npm run build`(型エラーなし)を通過条件にする。

- [ ] **Step 6: コミット**

```bash
git add frontend/src/api/types.ts frontend/src/api/client.ts frontend/src/lib/yutai-cross.tsx frontend/src/index.css
git commit -m "Add shared yutai cross columns, filters, and the types they need"
```

---

### Task 10: 2つの一覧画面に組み込む

**Files:**
- Modify: `frontend/src/pages/YutaiListPage.tsx`
- Modify: `frontend/src/pages/YutaiForecastListPage.tsx`

**Interfaces:**
- Consumes: Task 9 の `crossColumns`、`CrossFilterState`、`EMPTY_CROSS_FILTERS`、`toCrossParams`、`YutaiCrossFilters`

- [ ] **Step 1: `YutaiListPage.tsx` に列を足す**

import を足す。

```tsx
import {
  crossColumns,
  EMPTY_CROSS_FILTERS,
  toCrossParams,
  YutaiCrossFilters,
  type CrossFilterState,
} from '../lib/yutai-cross';
```

モジュールスコープの `const columns: ColumnDef<YutaiListItem>[] = [...]` の**末尾**(`riskStatus` 列の後ろ)に展開する。配列リテラルの閉じ括弧の直前に1行足すだけ。

```tsx
  ...crossColumns<YutaiListItem>(),
];
```

- [ ] **Step 2: 絞り込みの state と API 呼び出しを繋ぐ**

`YutaiListPage` の state 宣言に1行足す。

```tsx
  const [crossFilters, setCrossFilters] = useState<CrossFilterState>(EMPTY_CROSS_FILTERS);
```

`useAsync` の呼び出しを差し替える。`useAsync` の deps は配列なので、オブジェクトをそのまま渡すと毎レンダーで参照が変わり無限ループになる。**個々の文字列を deps に並べる**。

```tsx
  const listState = useAsync(
    () =>
      fetchYutaiList({
        rightsDateFrom,
        rightsDateTo,
        keyword: debouncedKeyword || undefined,
        riskStatus,
        ...toCrossParams(crossFilters),
      }),
    [
      rightsDateFrom,
      rightsDateTo,
      debouncedKeyword,
      riskStatus,
      crossFilters.priceMin,
      crossFilters.priceMax,
      crossFilters.investmentMin,
      crossFilters.investmentMax,
      crossFilters.crossEligible,
    ],
  );
```

- [ ] **Step 3: 絞り込みUIを置く**

`<div className="filter-bar">` の中、「リスク判定」の `</label>` の直後に足す。

```tsx
        <YutaiCrossFilters state={crossFilters} onChange={setCrossFilters} />
```

- [ ] **Step 4: 新しい列のセルを右寄せにする**

`<td>` の `className` を決めている三項演算子に新しい列IDを足す。現在は `'value' | 'maxGyakuhibu' | 'rightsDate'` を `num` にしている。

```tsx
                      className={
                        ['value', 'maxGyakuhibu', 'rightsDate', 'requiredShares', 'requiredInvestment', 'lastGyakuhibu'].includes(
                          cell.column.id,
                        )
                          ? 'num'
                          : cell.column.id === 'content'
                            ? 'cell-wrap'
                            : undefined
                      }
```

- [ ] **Step 5: ビルドして確認**

Run: `cd frontend && npm run build`
Expected: 成功

- [ ] **Step 6: `YutaiForecastListPage.tsx` に同じものを足す**

このページの列は `buildColumns(tseEnabled)` 関数が返す配列なので、`return columns;` の直前に足す。

```tsx
  columns.push(...crossColumns<YutaiForecastListItem>());

  return columns;
```

import、`crossFilters` の state、`useAsync` の deps、`YutaiCrossFilters` の配置はStep 1〜3と同じ要領で行う。このページの `useAsync` は `fetchYutaiForecastList` を呼ぶので、そちらに `...toCrossParams(crossFilters)` を足す。

```tsx
  const listState = useAsync(
    () =>
      fetchYutaiForecastList({
        rightsDateFrom,
        rightsDateTo,
        keyword: debouncedKeyword || undefined,
        ...toCrossParams(crossFilters),
      }),
    [
      rightsDateFrom,
      rightsDateTo,
      debouncedKeyword,
      crossFilters.priceMin,
      crossFilters.priceMax,
      crossFilters.investmentMin,
      crossFilters.investmentMax,
      crossFilters.crossEligible,
    ],
  );
```

このページの `forecastStatus` 絞り込みは `selectedStatuses`(クライアント側のSet)で行われており、API のクエリには乗っていない。そこは**変えない**。

セルの右寄せも同様に、このページの `<td>` の className ロジックに3つの列IDを足す。既存のロジックの形はファイルを読んで合わせる。

- [ ] **Step 7: ビルドと lint**

Run: `cd frontend && npm run build && npm run lint`
Expected: 成功

- [ ] **Step 8: 手元で両画面を目視確認する**

```bash
cd frontend && npm run dev
```

`/yutai` と `/yutai/forecast` を開き、次を確かめる。

- 必要株数・クロス・必要資金・前回逆日歩の4列が両方の画面に出る
- 各列のヘッダをクリックしてソートでき、「—」の行が昇順・降順どちらでも末尾に来る
- 株価・必要資金の上下限を入れると件数が減り、空にすると戻る
- クロス可否を「長期のみ」にすると該当銘柄だけが残る

この時点では個別ページの取得がまだ走っていないため、必要株数とクロスは全銘柄「—」「不明」になる。それが正しい状態(Task 12 の移行手順で埋まる)。

- [ ] **Step 9: コミット**

```bash
git add frontend/src/pages/YutaiListPage.tsx frontend/src/pages/YutaiForecastListPage.tsx
git commit -m "Show required shares, cross eligibility, funding, and past gyakuhibu on both yutai lists"
```

---

### Task 11: 詳細画面に株数段階表を出す

一覧には最小段階しか出せないので、段階表の全体は詳細画面に置く。ノジマのように4種別・7グループある銘柄もあるため、種別と保有条件ごとに区切って出す。

**Files:**
- Modify: `frontend/src/pages/YutaiDetailPage.tsx`

**Interfaces:**
- Consumes: Task 8 の `GET /yutai/:ticker` の `benefitGroups`、Task 9 の `BenefitGroup` 型

- [ ] **Step 1: 段階表のコンポーネントを足す**

`YutaiDetailPage` 関数の**手前**(モジュールスコープ)に置く。

```tsx
function holdingLabel(group: BenefitGroup): string {
  if (group.holdingMonths === null) return '継続保有条件なし';
  // 原文があればそのまま出す(「継続保有期間6か月以上」など表記が銘柄ごとに違う)。
  return group.holdingRaw ?? `継続保有${group.holdingMonths}ヶ月以上`;
}

function BenefitGroupsCard({ groups, warning }: { groups: BenefitGroup[]; warning: string | null }) {
  if (groups.length === 0) {
    return (
      <div className="card">
        <p style={{ color: 'var(--text-muted)', margin: 0 }}>
          株数段階の情報がまだ取得できていません。
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      {warning !== null && (
        <p className="benefit-warning">
          ⚠ 解析が不完全な可能性があります({warning})。内容は取得元のページで確認してください。
        </p>
      )}
      {groups.map((group, groupIndex) => (
        // 同じ種別・同じ保有条件のグループが重複して現れる銘柄があるため
        // (年2回の中間/期末の区別が解析で落ちる)、keyには添字を含める。
        <div key={`${group.title ?? ''}-${group.holdingMonths ?? 'none'}-${groupIndex}`} className="benefit-group">
          {group.title !== null && <div className="benefit-group__title">{group.title}</div>}
          <div className="summary-item__label">{holdingLabel(group)}</div>
          <table className="data-table">
            <thead>
              <tr>
                <th>株数</th>
                <th>優待内容</th>
              </tr>
            </thead>
            <tbody>
              {group.tiers.map((tier) => (
                <tr key={tier.shares}>
                  <td className="num">{tier.shares.toLocaleString('ja-JP')}株</td>
                  {/* 金額が読めた段階は金額を、読めなかった段階(「ー」や個数表記)は
                      原文をそのまま出す。どちらの場合も原文は失われていない。 */}
                  <td className="cell-wrap" style={{ textAlign: 'left' }}>
                    {tier.valueYen !== null ? formatFinancialYen(String(tier.valueYen)) : tier.rawText}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
```

import に型を足す。

```tsx
import type { BenefitGroup } from '../api/types';
```

既存の import 行の形(`import type { YutaiDetail } from '../api/types';` など)に合わせて1つにまとめてよい。

- [ ] **Step 2: 「優待内容」カードの後ろに差し込む**

`<div className="section-heading">優待内容</div>` のカードが閉じた直後、`逆日歩リスク計算` の見出しの**手前**に置く。

```tsx
      <div className="section-heading">株数段階別の優待条件</div>
      <BenefitGroupsCard groups={data.benefitGroups} warning={data.benefitParseWarning} />
```

- [ ] **Step 3: 「優待内容」カードに必要株数とクロス可否を足す**

既存の `summary-grid` の中(「権利日」の後ろ)に2つ足す。一覧から詳細に来たときに同じ判断材料が見えるようにする。

```tsx
          <div className="summary-item">
            <div className="summary-item__label">必要株数</div>
            <div className="summary-item__value">
              {data.requiredShares !== null ? `${data.requiredShares.toLocaleString('ja-JP')}株` : '—'}
              {data.requiredShares !== null && data.requiredShares !== data.unitShares && (
                <span className="cross-months">単元{data.unitShares}株</span>
              )}
            </div>
          </div>
          <div className="summary-item">
            <div className="summary-item__label">1回のクロスで取得</div>
            <div className="summary-item__value">
              {data.crossEligible === 'ok' ? '可' : data.crossEligible === 'ng' ? '不可(長期保有者限定)' : '不明'}
              {data.holdingKind === 'required' && data.holdingMinMonths !== null && (
                <span className="cross-months">最低{data.holdingMinMonths}ヶ月</span>
              )}
            </div>
          </div>
```

- [ ] **Step 4: CSS を足す**

`frontend/src/index.css` の Task 9 で足したブロックの後ろに続ける。

```css
.benefit-group + .benefit-group {
  margin-top: 1.25rem;
  padding-top: 1.25rem;
  border-top: 1px solid var(--border);
}

.benefit-group__title {
  font-weight: 600;
  margin-bottom: 0.35rem;
}

.benefit-warning {
  margin: 0 0 1rem;
  font-size: 0.85rem;
  color: var(--caution);
}
```

`--border` 変数が存在しない場合は、`index.css` の `:root` を読んで実際にある境界線用の変数名に合わせる。

- [ ] **Step 5: ビルドして目視確認**

```bash
cd frontend && npm run build && npm run lint && npm run dev
```

`/yutai/7458` を開き、段階表のカードが出ること(この時点ではデータが無いので「まだ取得できていません」の表示になるのが正しい)を確かめる。

- [ ] **Step 6: コミット**

```bash
git add frontend/src/pages/YutaiDetailPage.tsx frontend/src/index.css
git commit -m "Show the full benefit tier tables on the yutai detail page"
```

---

### Task 12: 移行手順の実行と記録

コードは揃ったが、データはまだ埋まっていない。順序を間違えると不正確な値が画面に出るので、手順を固定して記録に残す。

**重要な順序の制約**: 現在 DB 上の `unitShares` は `estimateRequiredShares` に上書きされた**推定値**(第一興商は 200、ノジマは 300 になっている)。Task 7 で上書きをやめたため、`yutai-master-sync-batch` を走らせて `unitShares` を 100 に戻すまで、`requiredShares` 未取得の銘柄のフォールバックが汚れたままになる。したがって **master-sync(手順2)を detail-sync(手順3)より先に、新しい precompute(手順5)より必ず先に**走らせる。

**Files:**
- Create: `docs/superpowers/notes/2026-10-01-yutai-detail-sync-runbook.md`

- [ ] **Step 1: デプロイする**

```bash
npx cdk diff
```

差分を読み、以下が含まれることを確認する。新しい Lambda 1つ、Step Functions ステートマシン1つとその IAM ロール、`YutaiRiskPrecomputeBatchFunction` の環境変数と IAM ポリシーの変更。**EventBridge ルールが増えていないこと**も確認する(増えていたら detail-sync にスケジュールを付けてしまっている)。

```bash
npx cdk deploy
```

`APP_PASSWORD` は不要(`bin/j-quants.ts` が Secrets Manager の `JQuantsAppPassword` から読む)。

- [ ] **Step 2: 一覧ページを再同期して detailUrl と listBadge を入れる**

```bash
aws lambda invoke --function-name "$(aws cloudformation describe-stack-resource --stack-name JQuantsStack --logical-resource-id YutaiMasterSyncBatchFunction --query 'StackResourceDetail.PhysicalResourceId' --output text)" --invocation-type Event /dev/null
```

12ヶ月分の走査で約10分かかる。完了後、`detailUrl` が入った件数と `unitShares` が 100 に戻ったことを確認する。

```bash
aws dynamodb scan --table-name JQuantsYutaiMaster --projection-expression "ticker,detailUrl,listBadge,unitShares" --output json > /tmp/master.json
node -e "const r=require('/tmp/master.json').Items; console.log('total', r.length, 'withUrl', r.filter(x=>x.detailUrl&&x.detailUrl.S).length, 'badged', r.filter(x=>x.listBadge&&x.listBadge.S).length, 'unit!=100', r.filter(x=>x.unitShares&&x.unitShares.N!=='100').length)"
```

Windows の Git-Bash では `/tmp/...` がネイティブの `node.exe` から見えない(`C:\tmp\...` になる)。スクラッチパッドの Windows 絶対パスを使うこと。

期待値: `total` 約1,642、`withUrl` が `total` と同数、`badged` が約821、`unit!=100` が 0。

- [ ] **Step 3: 個別ページを取得する(9バケット直列、約33分)**

まず1銘柄で動作を確かめる。第一興商は必要株数が 200 になるはずの銘柄。

```bash
FN=$(aws cloudformation describe-stack-resource --stack-name JQuantsStack --logical-resource-id YutaiDetailSyncBatchFunction --query 'StackResourceDetail.PhysicalResourceId' --output text)
aws lambda invoke --function-name "$FN" --payload '{"tickers":["7458"]}' --cli-binary-format raw-in-base64-out /dev/null
aws dynamodb get-item --table-name JQuantsYutaiMaster --key '{"ticker":{"S":"7458"}}' --projection-expression "requiredShares,crossEligible,holdingKind,minTierValueYen,benefitParseWarning"
```

`requiredShares` が 200、`crossEligible` が `ok`、`holdingKind` が `none` になっていることを確認する。ここが違えばパーサーに問題があるので、全件を回す前に止めて直す。

確認できたらステートマシンを起動する。

```bash
SM=$(aws stepfunctions list-state-machines --query "stateMachines[?name=='JQuantsYutaiDetailSync'].stateMachineArn" --output text)
aws stepfunctions start-execution --state-machine-arn "$SM"
```

- [ ] **Step 4: 取りこぼしを評価する**

完了後、各バケットのログの最終行(`yutai-detail-sync-batch: codePrefix=... warnings: ...`)を集める。

```bash
MSYS_NO_PATHCONV=1 aws logs filter-log-events --log-group-name "/aws/lambda/$FN" --filter-pattern "yutai-detail-sync-batch:" --query 'events[].message' --output text
```

`requiredShares` が入らなかった銘柄数と、警告の理由別件数を記録する。

```bash
aws dynamodb scan --table-name JQuantsYutaiMaster --projection-expression "ticker,requiredShares,crossEligible,benefitParseWarning" --output json > <scratchpad>/derived.json
```

`requiredShares` が null の件数が全体の数%を大きく超える、または `no-groups` が多数ある場合は、サイト構造の想定と合っていない。その場合は手順5に進まず、該当銘柄の `detailUrl` を1つ開いて構造を確認し、パーサーを直してから `tickers` 指定で再取得する。

- [ ] **Step 5: 日次バッチを1回手動で回して集計を入れる**

スケジュール(JST 18:20)を待たずに動かす。

```bash
aws lambda invoke --function-name "$(aws cloudformation describe-stack-resource --stack-name JQuantsStack --logical-resource-id YutaiRiskPrecomputeBatchFunction --query 'StackResourceDetail.PhysicalResourceId' --output text)" --invocation-type Event /dev/null
```

完了後、第一興商の行で必要資金と前回逆日歩が入ったことを確認する。

```bash
aws dynamodb get-item --table-name JQuantsYutaiMaster --key '{"ticker":{"S":"7458"}}' --projection-expression "requiredShares,requiredInvestment,lastGyakuhibu,sameMonthLastYearGyakuhibu,unitShares"
```

`requiredInvestment` が `closePrice × 200` になっていること、`lastGyakuhibu.basedOnUnitShares` が `false` であること、`unitShares` が 100 のままであることを確認する。

- [ ] **Step 6: 画面を確認する**

本番の `/yutai` と `/yutai/forecast` を開き、4列に値が入っていること、絞り込みが効くことを確認する。`/yutai/7458` で段階表(200株→5,000円、2,000株→12,500円)が出ることを確認する。

- [ ] **Step 7: 結果を記録する**

`docs/superpowers/notes/2026-10-01-yutai-detail-sync-runbook.md` に以下を書く。測定した実数を入れること(「おおむね成功」のような曖昧な記述は役に立たない)。

- 実行日時と各手順の所要時間
- `detailUrl` が入った件数 / バッジ付きの件数
- `requiredShares` が取れた件数と取れなかった件数
- `benefitParseWarning` の理由別件数
- `requiredShares !== unitShares` だった銘柄の一覧(第一興商・ノジマ以外に何があったか。これは「単元100株だと思って買うと優待が取れない」銘柄のリストなので、それ自体が価値のある成果物)
- ステートマシンの実行ARNと、失敗したバケットがあればその理由
- 次に `yutai-master-sync-batch` と detail-sync を手動で回すべき目安(クールダウンは90日)

- [ ] **Step 8: コミット**

```bash
git add docs/superpowers/notes/2026-10-01-yutai-detail-sync-runbook.md
git commit -m "Record the yutai detail sync migration results"
```

---

## 完了条件

- `npm test` が全件通る
- `npm run build` と `cd frontend && npm run build` が通る
- `estimateRequiredShares` がコードベースに存在しない(`grep -rn estimateRequiredShares lambda/ test/` が空)
- `yutai-risk-precompute-batch` が `unitShares` を書かない
- Step Functions の Map が `maxConcurrency: 1` である
- `detailUrl` が全銘柄に入り、`requiredShares` が取れた銘柄数が runbook に記録されている
- 両方の一覧画面に4列と3つの絞り込みが出て、詳細画面に段階表が出る
