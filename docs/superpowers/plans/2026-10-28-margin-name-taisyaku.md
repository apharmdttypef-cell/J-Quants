# 貸借区分のtaisyaku.jp移行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 貸借区分(`JQuantsYutaiMaster.marginName`)の取得元をJ-Quants `/equities/master`から、信用残バッチが取得済みのtaisyaku.jp一括CSVの`貸借区分`列に切り替える。

**Architecture:** 信用残バッチ(`lambda/margin-balance-batch`)が、その実行で取れた最新申込日のCSVから東証行の`貸借区分`を読み、マスタの`marginName`と異なる銘柄だけ`UpdateCommand`で書く。貸借判定バッチ(`yutai-risk-precompute-batch`)と検証用Lambda(`gyakuhibu-forecast-validation`)はJ-Quantsを呼ばず、マスタの`marginName`を読むだけにする。

**Tech Stack:** TypeScript, AWS CDK, Lambda (NodejsFunction, Node 22), DynamoDB DocumentClient, Jest (ts-jest)

**Spec:** `docs/superpowers/specs/2026-10-27-margin-name-taisyaku-design.md`

## Global Constraints

- git worktreeは使わない。現在のチェックアウト(ブランチ`feature/margin-name-taisyaku`)上で作業する
- `README.md`には他セッションの未コミット変更(Cognito「メールなしで発行」の1行)がある。Task 1〜4では`README.md`を`git add`しない。`git add -A`/`git add .`は禁止。変更したファイルを名指しで`git add`する
- `marginName`の値はtaisyaku.jpの表記をそのまま保存する: `'貸借' | '貸借融資' | '非貸借'`。東証行が無い銘柄は`null`
- 判定は`marginName === '貸借'`と`null`かどうかだけ。J-Quants表記(`信用`/`その他`)への変換はしない
- `marginName`を書くのは信用残バッチだけ
- コメントは日本語で、周囲のコードと同じ密度・語調にする
- Jestはメモリ不足で落ちるため、全体実行は `NODE_OPTIONS=--max-old-space-size=4096 npx jest -i`(約15分)。個別ファイルは `npx jest test/<file>.test.ts`。スタック合成テスト`test/j-quants.test.ts`は約10分かかるので、バックグラウンドに回さずフォアグラウンドで(timeout 600000ms)実行し、`-t`で対象テストに絞ってよい
- Git Bashでは`/`始まりの引数がパス変換されるため、必要なら`export MSYS_NO_PATHCONV=1`
- コミットメッセージは英語の1文(既存の履歴に合わせる)、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

---

### Task 1: `parseTaisyakuMarginNames`(CSV → 東証行の貸借区分マップ)

**Files:**
- Modify: `lambda/margin-balance-batch/data-source.ts`
- Test: `test/margin-balance-taisyaku-parse.test.ts`

**Interfaces:**
- Produces: `export function parseTaisyakuMarginNames(csvText: string): Map<string, string>` — キーは`銘柄コード`(4文字)、値は`貸借区分`。東証行のみ、`貸借区分`が空の行は含めない。ヘッダー不一致で`TaisyakuCsvFormatError`。空文字列なら空Map

- [ ] **Step 1: 失敗するテストを書く**

`test/margin-balance-taisyaku-parse.test.ts`のimportに`parseTaisyakuMarginNames`を足し、ファイル末尾に追加する:

```ts
describe('parseTaisyakuMarginNames', () => {
  it('実CSVから東証行の銘柄コード→貸借区分を返す(7203の名証行は見ない)', () => {
    expect(parseTaisyakuMarginNames(fixtureText)).toEqual(
      new Map([
        ['1301', '貸借'],
        ['3197', '貸借'],
        ['7203', '貸借'],
        ['9418', '貸借'],
      ]),
    );
  });

  it('東証以外の行は値が違っても無視し、貸借区分が空の行は含めない', () => {
    const csv = [
      HEADER_LINE,
      '"1111","A","東証","貸借融資","20270331","","100","100","0","1.00","0.00","-","-","-"',
      '"1111","A","名証","非貸借","20270331","","100","100","0","1.00","0.00","-","-","-"',
      '"2222","B","名証","貸借","20270331","","100","100","0","1.00","0.00","-","-","-"',
      '"3333","C","東証","","20270331","","100","100","0","1.00","0.00","-","-","-"',
      '"4444","D","東証","非貸借","20270331","","-","-","-","-","-","-","-","-"',
    ].join('\n');
    expect(parseTaisyakuMarginNames(csv)).toEqual(
      new Map([
        ['1111', '貸借融資'],
        ['4444', '非貸借'],
      ]),
    );
  });

  it('空のテキストは空のMapを返す', () => {
    expect(parseTaisyakuMarginNames('')).toEqual(new Map());
  });

  it('ヘッダーが想定と違えばTaisyakuCsvFormatErrorを投げる', () => {
    expect(() => parseTaisyakuMarginNames('"銘柄コード","銘柄名"\n"1301","極洋"')).toThrow(TaisyakuCsvFormatError);
  });
});
```

(4444は残高が`-`でも区分は採る — 区分のパースは残高を見ない)

- [ ] **Step 2: 失敗を確認**

Run: `npx jest test/margin-balance-taisyaku-parse.test.ts`
Expected: FAIL(`parseTaisyakuMarginNames is not a function` 等)

- [ ] **Step 3: 実装**

`data-source.ts`で、ヘッダー検証と行分割を非公開関数に切り出し、`parseTaisyakuBalanceCsv`(挙動は変えない)と新関数の両方から使う。`parseTaisyakuBalanceCsv`の`if (csvText.trim() === '') return [];`からループ内の列数チェックまでを次で置き換える:

```ts
// ヘッダーを完全一致で検証し、データ行を列に分けて返す。空行は飛ばし、列数の合わない行は警告して捨てる。
function readTaisyakuCsvRows(csvText: string): string[][] {
  if (csvText.trim() === '') return [];

  const lines = csvText.split(/\r?\n/);
  const header = splitCsvLine(lines[0]);
  if (
    header.length !== TAISYAKU_BALANCE_CSV_HEADER.length ||
    header.some((name, i) => name !== TAISYAKU_BALANCE_CSV_HEADER[i])
  ) {
    throw new TaisyakuCsvFormatError(
      `Unexpected taisyaku.jp CSV header: ${lines[0].slice(0, 200)}`,
    );
  }

  const rows: string[][] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === '') continue;
    const cols = splitCsvLine(line);
    if (cols.length !== TAISYAKU_BALANCE_CSV_HEADER.length) {
      console.warn(`Skipping taisyaku.jp CSV row with ${cols.length} columns: ${line.slice(0, 100)}`);
      continue;
    }
    rows.push(cols);
  }
  return rows;
}
```

`parseTaisyakuBalanceCsv`の本体:

```ts
export function parseTaisyakuBalanceCsv(csvText: string, date: string): MarginBalancePoint[] {
  const codeIdx = TAISYAKU_BALANCE_CSV_HEADER.indexOf('銘柄コード');
  const marketIdx = TAISYAKU_BALANCE_CSV_HEADER.indexOf('市場区分');
  const financingIdx = TAISYAKU_BALANCE_CSV_HEADER.indexOf('融資残高（株）');
  const lendingIdx = TAISYAKU_BALANCE_CSV_HEADER.indexOf('貸株残高（株）');

  const points: MarginBalancePoint[] = [];
  for (const cols of readTaisyakuCsvRows(csvText)) {
    if (cols[marketIdx] !== '東証') continue;

    const financingBalance = parseBalance(cols[financingIdx]);
    const lendingBalance = parseBalance(cols[lendingIdx]);
    if (financingBalance === null || lendingBalance === null) continue;

    points.push({ code: cols[codeIdx], date, financingBalance, lendingBalance, source: 'taisyaku' });
  }
  return points;
}
```

その直後に新関数を追加:

```ts
// 全銘柄一括CSVから、東証行の 銘柄コード → 貸借区分('貸借' | '貸借融資' | '非貸借') を作る。
// 制度信用で売れる(逆日歩が発生しうる)のは'貸借'だけ。信用残と同じく東証の行だけを見る。
// 区分は残高と無関係なので、残高が'-'の行でも採る。貸借区分が空の行は含めない。
export function parseTaisyakuMarginNames(csvText: string): Map<string, string> {
  const codeIdx = TAISYAKU_BALANCE_CSV_HEADER.indexOf('銘柄コード');
  const marketIdx = TAISYAKU_BALANCE_CSV_HEADER.indexOf('市場区分');
  const marginNameIdx = TAISYAKU_BALANCE_CSV_HEADER.indexOf('貸借区分');

  const names = new Map<string, string>();
  for (const cols of readTaisyakuCsvRows(csvText)) {
    if (cols[marketIdx] !== '東証' || cols[marginNameIdx] === '') continue;
    names.set(cols[codeIdx], cols[marginNameIdx]);
  }
  return names;
}
```

`parseTaisyakuBalanceCsv`の上の既存コメント(東証だけを使う等)はそのまま残す。

- [ ] **Step 4: 通過を確認**

Run: `npx jest test/margin-balance-taisyaku-parse.test.ts test/margin-balance-batch.test.ts`
Expected: PASS(既存の`parseTaisyakuBalanceCsv`のテストも全て通る)

- [ ] **Step 5: コミット**

```bash
git add lambda/margin-balance-batch/data-source.ts test/margin-balance-taisyaku-parse.test.ts
git commit -m "Parse the margin classification of TSE rows from the taisyaku.jp CSV"
```

---

### Task 2: 信用残バッチがマスタの`marginName`を更新する

**Files:**
- Modify: `lambda/margin-balance-batch/index.ts`
- Modify: `lib/j-quants-stack.ts`(`this.yutaiMasterTable.grantReadData(marginBalanceBatchFn);` 付近、約244行)
- Test: `test/margin-balance-batch.test.ts`
- Test: `test/j-quants.test.ts`(信用残バッチのテスト内「優待マスタは読み取りのみ」の箇所、約329〜334行)

**Interfaces:**
- Consumes: `parseTaisyakuMarginNames(csvText: string): Map<string, string>`(Task 1、`./data-source`)
- Produces: なし(マスタの`marginName`属性を書く。値は`'貸借' | '貸借融資' | '非貸借' | null`)

- [ ] **Step 1: テストのモックを拡張する**

`test/margin-balance-batch.test.ts`:

1. `jest.mock('@aws-sdk/lib-dynamodb', ...)`に追加:
```ts
  UpdateCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'Update' })),
```

2. `Row`と`csvFor`を、5番目の要素で貸借区分を指定できるようにする(省略時は`'貸借'`。既存テストはそのまま動く):
```ts
type Row = [code: string, market: string, financing: string, lending: string, marginName?: string];

function csvFor(rows: Row[]): string {
  const quote = (cols: string[]) => cols.map((c) => `"${c}"`).join(',');
  const lines = [quote([...TAISYAKU_BALANCE_CSV_HEADER])];
  for (const [code, market, financing, lending, marginName = '貸借'] of rows) {
    lines.push(
      quote([code, `銘柄${code}`, market, marginName, '20270331', '', financing, lending, '0', '1.00', '0.00', '-', '-', '-']),
    );
  }
  return lines.join('\r\n');
}
```

3. `mockTables`に、マスタの現在の区分を渡せるようにする:
```ts
function mockTables({
  master,
  cursor,
  marginNames = {},
}: {
  master: string[];
  cursor?: string;
  marginNames?: Record<string, string>;
}): void {
  mockSend.mockImplementation(async (command: { __type: string }) => {
    switch (command.__type) {
      case 'Scan':
        return { Items: master.map((ticker) => ({ ticker, marginName: marginNames[ticker] })) };
      case 'Get':
        return cursor ? { Item: { ...CURSOR_KEY, lastFetchedDate: cursor } } : {};
      default:
        return {};
    }
  });
}
```

4. ヘルパーを追加:
```ts
// マスタへの貸借区分の書き込み(ticker → 書いた値)
function marginNameUpdates(): Record<string, unknown> {
  return Object.fromEntries(
    sentCommands('Update').map((c) => [
      (c.Key as { ticker: string }).ticker,
      (c.ExpressionAttributeValues as Record<string, unknown>)[':marginName'],
    ]),
  );
}
```

- [ ] **Step 2: 失敗するテストを書く**

ファイル末尾(「J-Quantsに依存しない」テストの前)に追加:

```ts
test('最新の申込日のCSVの貸借区分で、値が変わった銘柄だけマスタを更新する', async () => {
  mockTables({
    master: ['7203', '3197', '1301', '9418'],
    cursor: '2026-10-21',
    marginNames: { '7203': '貸借', '3197': '信用', '1301': '貸借', '9418': '貸借' },
  });
  const older = csvFor([
    ['7203', '東証', '100', '50', '貸借'],
    ['3197', '東証', '100', '50', '貸借'],
    ['1301', '東証', '100', '50', '貸借'],
    ['9418', '東証', '100', '50', '貸借'],
  ]);
  const newest = csvFor([
    ['7203', '東証', '100', '50', '貸借'], // 変化なし → 書かない
    ['3197', '東証', '100', '50', '貸借融資'], // J-Quants表記(信用)から変わる
    ['1301', '東証', '100', '50', '非貸借'],
    ['9418', '名証', '100', '50', '貸借'], // 東証行が無い → null
  ]);
  mockFetchCsv.mockImplementation(async (date: string) => (date === '2026-10-23' ? newest : older));

  await handler();

  expect(marginNameUpdates()).toEqual({ '3197': '貸借融資', '1301': '非貸借', '9418': null });
  expect(sentCommands('Update')[0]).toMatchObject({
    TableName: 'JQuantsYutaiMaster',
    UpdateExpression: 'SET marginName = :marginName',
  });
});

test('今日が未公表なら、取れた日のうち最新(昨日)のCSVの区分を使う', async () => {
  mockTables({ master: ['7203'], cursor: '2026-10-21', marginNames: { '7203': '貸借' } });
  mockFetchCsv.mockImplementation(async (date: string) => {
    if (date === '2026-10-23') return null;
    return csvFor([['7203', '東証', '100', '50', date === '2026-10-22' ? '貸借融資' : '貸借']]);
  });

  await handler();

  expect(marginNameUpdates()).toEqual({ '7203': '貸借融資' });
});

test('東証行が無く、すでにnull(未設定)の銘柄は書かない', async () => {
  mockTables({ master: ['7203', '5555'], cursor: '2026-10-23', marginNames: { '7203': '貸借' } });
  mockFetchCsv.mockResolvedValue(csvFor([['7203', '東証', '100', '50']]));

  await handler();

  expect(sentCommands('Update')).toHaveLength(0);
});

test('CSVが1件も取れなかった実行では区分を更新しない', async () => {
  mockTables({ master: ['7203'], cursor: '2026-10-23', marginNames: { '7203': '貸借' } });
  mockFetchCsv.mockResolvedValue(null);

  await handler();

  expect(sentCommands('Update')).toHaveLength(0);
});

test('区分の更新に失敗しても信用残の処理を終えてから例外を投げる', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockTables({ master: ['7203', '3197'], cursor: '2026-10-21' });
  const base = mockSend.getMockImplementation()!;
  mockSend.mockImplementation(async (command: { __type: string; Key?: { ticker: string } }) => {
    if (command.__type === 'Update' && command.Key?.ticker === '7203') throw new Error('ddb down');
    return base(command);
  });
  mockFetchCsv.mockResolvedValue(
    csvFor([
      ['7203', '東証', '100', '50'],
      ['3197', '東証', '100', '50'],
    ]),
  );

  await expect(handler()).rejects.toThrow('failed to update the margin classification of 1 tickers');

  // 信用残は3日分とも書き終えている
  expect(cursorWrites()).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
  // 失敗した銘柄があっても残りの銘柄は更新する
  expect(sentCommands('Update').map((c) => (c.Key as { ticker: string }).ticker).sort()).toEqual(['3197', '7203']);
});

test('マスタのScanはtickerとmarginNameだけを読む', async () => {
  mockTables({ master: ['7203'], cursor: '2026-10-23' });
  mockFetchCsv.mockResolvedValue(csvFor([['7203', '東証', '100', '50']]));

  await handler();

  expect(sentCommands('Scan')[0]).toMatchObject({
    TableName: 'JQuantsYutaiMaster',
    ProjectionExpression: 'ticker, marginName',
  });
});
```

- [ ] **Step 3: 失敗を確認**

Run: `npx jest test/margin-balance-batch.test.ts`
Expected: 追加した6件がFAIL、既存テストはPASS

- [ ] **Step 4: 実装**

`lambda/margin-balance-batch/index.ts`:

1. import:
```ts
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { fetchTaisyakuBalanceCsv, parseTaisyakuBalanceCsv, parseTaisyakuMarginNames } from './data-source';
```

2. `getYutaiTickers`を置き換え:
```ts
// 優待マスタの ticker → 現在の貸借区分(未設定はnull)
async function getYutaiMarginNames(): Promise<Map<string, string | null>> {
  const marginNames = new Map<string, string | null>();
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({
        TableName: YUTAI_MASTER_TABLE_NAME,
        ProjectionExpression: 'ticker, marginName',
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of result.Items ?? []) {
      if (typeof item.ticker === 'string') {
        marginNames.set(item.ticker, typeof item.marginName === 'string' ? item.marginName : null);
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return marginNames;
}
```

3. `writeCursor`の後に追加:
```ts
// CSVの東証行の貸借区分('貸借' | '貸借融資' | '非貸借')を優待マスタのmarginNameに反映する。
// 東証行の無い銘柄(地方市場のみ上場など)はnull(区分不明)。値が変わった銘柄だけ書く。
// 1銘柄の失敗で他の銘柄を止めないよう、失敗件数を数えて返す。
async function updateMarginNames(csv: string, current: Map<string, string | null>): Promise<{ updated: number; failed: number }> {
  const names = parseTaisyakuMarginNames(csv);
  let updated = 0;
  let failed = 0;
  for (const [ticker, currentName] of current) {
    const marginName = names.get(ticker) ?? null;
    if (marginName === currentName) continue;
    try {
      await ddbDocClient.send(
        new UpdateCommand({
          TableName: YUTAI_MASTER_TABLE_NAME,
          Key: { ticker },
          UpdateExpression: 'SET marginName = :marginName',
          ExpressionAttributeValues: { ':marginName': marginName },
        }),
      );
      updated += 1;
    } catch (error) {
      failed += 1;
      console.error(`${ticker}: failed to update the margin classification to ${marginName}`, error);
    }
  }
  return { updated, failed };
}
```

4. `handler`:
   - 冒頭を次に変更:
```ts
  const currentMarginNames = await getYutaiMarginNames();
  if (currentMarginNames.size === 0) {
    console.warn('Yutai master is empty; nothing to fetch');
    return;
  }
  const targetTickers = new Set(currentMarginNames.keys());
```
   - `let cursor = lastFetchedDate;`の下に:
```ts
  // 貸借区分の取得元にする、この実行で取れた最新の申込日のCSV
  let latestCsv: string | null = null;
```
   - `const items = points` の直前(0件の分岐を抜けた所)に:
```ts
    latestCsv = csv;
```
     (`points.length > 0`なので`csv`は非null。型の都合で`csv!`が要るなら`latestCsv = csv as string;`ではなく、0件判定の後で`if (csv !== null) latestCsv = csv;`と書いてもよい)
   - ループ直後、既存の`console.log(\`margin-balance-batch: ...\`)`の前に:
```ts
  // 区分の変更は稀なので、取れた日のうち最新のCSVだけを見る。1件も取れなければ前回の値のまま
  const marginNameResult = latestCsv === null ? { updated: 0, failed: 0 } : await updateMarginNames(latestCsv, currentMarginNames);
```
   - サマリーログの末尾に区分の件数を足す:
```ts
  console.log(
    `margin-balance-batch: ${dates.length} dates planned, ${succeeded} succeeded, ${failed} failed, ${upserted} points upserted, cursor=${cursor}, ` +
      `${marginNameResult.updated} margin classifications updated (${marginNameResult.failed} failed)`,
  );
```
   - 既存の3つの例外チェックの後(関数の最後)に:
```ts
  if (marginNameResult.failed > 0) {
    throw new Error(
      `margin-balance-batch: failed to update the margin classification of ${marginNameResult.failed} tickers`,
    );
  }
```
   - `handler`上のコメントブロックに1行追加: `// 取れたCSVのうち最新の申込日のものから、優待マスタの貸借区分(marginName)も更新する。`

`lib/j-quants-stack.ts`:
```ts
    // 貸借区分(marginName)をtaisyaku.jpのCSVから更新するため、優待マスタは読み書き
    this.yutaiMasterTable.grantReadWriteData(marginBalanceBatchFn);
```
(`grantReadData(marginBalanceBatchFn)`の行を置き換える)

`test/j-quants.test.ts`の信用残バッチのテスト(約329〜334行)の「優待マスタは読み取りのみ」を置き換え:
```ts
  // 優待マスタは貸借区分(marginName)を更新するので読み書きできる
  const masterActions = statements.filter((s) => s.resourceStr.includes('YutaiMaster')).flatMap((s) => s.actions);
  expect(masterActions.some((a) => a.includes('Scan'))).toBe(true);
  expect(masterActions.some((a) => a.includes('UpdateItem'))).toBe(true);
```

- [ ] **Step 5: 通過を確認**

Run: `npx jest test/margin-balance-batch.test.ts test/margin-balance-taisyaku-parse.test.ts`
Expected: PASS

Run(約10分、フォアグラウンド): `npx jest test/j-quants.test.ts -t "margin balance batch Lambda"`
Expected: PASS

Run: `npx tsc --noEmit -p .`
Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add lambda/margin-balance-batch/index.ts lib/j-quants-stack.ts test/margin-balance-batch.test.ts test/j-quants.test.ts
git commit -m "Update the yutai master margin classification from the newest taisyaku.jp CSV in the margin balance batch"
```

---

### Task 3: 貸借判定バッチはJ-Quantsを呼ばず、マスタの`marginName`を読むだけにする

**Files:**
- Modify: `lambda/yutai-risk-precompute-batch/index.ts`
- Modify: `lambda/shared/margin-name.ts`
- Modify: `lib/j-quants-stack.ts`(`YutaiRiskPrecomputeBatchFunction`、約336〜355行)
- Test: `test/yutai-risk-precompute-batch.test.ts`
- Test: `test/margin-name.test.ts`
- Test: `test/j-quants.test.ts`(`YutaiRiskPrecompute`のテスト、約455〜540行)

**Interfaces:**
- Consumes: マスタの`marginName`(Task 2が書く。値は`'貸借' | '貸借融資' | '非貸借' | null`。移行直後はJ-Quants表記`'信用' | 'その他'`が残っていてもよい)
- Produces: `lambda/shared/margin-name.ts`は`export function isGeneralMarginOnly(marginName: string | null): boolean`だけになる(`fetchMarginNames`・`pickMarginNames`・`EquityMasterRecord`は削除)。`lambda/gyakuhibu-forecast-batch/index.ts`が`isGeneralMarginOnly`を使い続ける

- [ ] **Step 1: テストを書き換える(失敗させる)**

`test/yutai-risk-precompute-batch.test.ts`:

1. `margin-name`と`jquants-batch-client`の`jest.mock`2つ、`mockFetchMarginNames`、`process.env.SECRET_ARN`、`beforeEach`内の`mockFetchMarginNames`関連を削除する。代わりにJ-Quantsを呼ばないことを確かめるため、`jquants-batch-client`のモックを次に置き換える:
```ts
// 貸借区分は信用残バッチがtaisyaku.jpのCSVからマスタに書く。このバッチはJ-Quantsを呼ばない。
const mockGetApiKey = jest.fn();
jest.mock('../lambda/shared/jquants-batch-client', () => ({
  getApiKey: (...args: unknown[]) => mockGetApiKey(...args),
  fetchWithRetry: jest.fn(),
}));
```
   `beforeEach`は`mockSend.mockReset(); mockGetApiKey.mockReset();`にする。

2. これまで既定の`mockFetchMarginNames`(1234/9001/7458/1111/2222を貸借)に頼っていたテストは、マスタのScan結果の行に`marginName: '貸借'`を足して同じ経路を通す。ファイル内の全テストを見て、Scanの`Items`の行に`ticker`が`'1234' | '9001' | '7458' | '1111' | '2222'`のいずれかで`marginName`が無いものには`marginName: '貸借'`を足す(区分不明を確かめたい`9942`などには足さない)。

3. `:marginName`を検証している既存テストを書き換える:
   - `records the J-Quants margin classification and computes ...` → 名前を`computes the gyakuhibu amounts for a ticker whose stored classification is 貸借`にし、Scan行に`marginName: '貸借'`、`mockFetchMarginNames`の行と`expect(mockFetchMarginNames)...`・`expect(values[':marginName'])...`を削除、`maxGyakuhibu`が数値であることだけ残す
   - `for a 信用 ticker ...` → Scan行に`marginName: '貸借融資'`を足し、名前の`信用`を`貸借融資`に、`expect(values[':marginName']).toBe('信用')`を削除。残りの期待値(最大逆日歩null・必要資金あり・send 3回)はそのまま
   - `treats a ticker missing from the J-Quants listing ...` → 名前を`treats a ticker without a stored classification (no TSE row) as unknown, not as 一般信用のみ`にし、`mockFetchMarginNames`行を削除、期待値を`expect(updateValues()[':maxGyakuhibu']).toBeNull();`と`expect(updateValues()[':lastGyakuhibu']).toBeNull();`に変更(区分不明でも実績Queryは走る)
   - `keeps the stored margin classification when the J-Quants fetch fails`、`treats an empty J-Quants listing as a failed fetch ...`、`uses the stored 貸借 classification when the J-Quants fetch fails` の3件は削除
   - `writes null risk amounts when the margin classification is unknown (not in the J-Quants listing)` は名前の括弧内を`(no stored marginName)`に変える

4. 追加:
```ts
test('a stored J-Quants-era 信用 value is still treated as 一般信用のみ (until the margin balance batch rewrites it)', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '1380', unitShares: 100, rightsMonths: [8], marginName: '信用' }] })
    .mockResolvedValueOnce({ Items: [{ close: 800 }] })
    .mockResolvedValueOnce({});

  await handler();

  expect(updateValues()[':maxGyakuhibu']).toBeNull();
  expect(updateValues()[':requiredInvestment']).toBe(80000);
});

test('never calls J-Quants and never writes marginName (the margin balance batch owns it)', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [{ ticker: '1234', unitShares: 100, rightsMonths: [8], marginName: '貸借' }] })
    .mockResolvedValueOnce({ Items: [{ close: 500 }] })
    .mockResolvedValueOnce({ Items: [] })
    .mockResolvedValueOnce({});

  await handler();

  expect(mockGetApiKey).not.toHaveBeenCalled();
  const update = updateCalls()[0][0] as { UpdateExpression: string; ExpressionAttributeValues: Record<string, unknown> };
  expect(update.UpdateExpression).not.toContain('marginName');
  expect(update.ExpressionAttributeValues).not.toHaveProperty(':marginName');
});
```

`test/margin-name.test.ts`:
- `pickMarginNames`の2テストを削除し、importを`isGeneralMarginOnly`だけにする
- `isGeneralMarginOnly`のテストをtaisyaku.jp表記に合わせる:
```ts
test('isGeneralMarginOnly: only 貸借 can be shorted under 制度信用; unknown stays unknown', () => {
  expect(isGeneralMarginOnly('貸借')).toBe(false);
  expect(isGeneralMarginOnly('貸借融資')).toBe(true);
  expect(isGeneralMarginOnly('非貸借')).toBe(true);
  // 移行前にJ-Quantsから取り込んだ表記も同じく扱う
  expect(isGeneralMarginOnly('信用')).toBe(true);
  expect(isGeneralMarginOnly('その他')).toBe(true);
  expect(isGeneralMarginOnly(null)).toBe(false); // 東証行が無いなど、区分が分からない銘柄は決めつけない
});
```

`test/j-quants.test.ts`の`YutaiRiskPrecompute`テスト:
- 環境変数の`Match.exact`から`SECRET_ARN`とそのコメント行を削除
- 末尾の「J-Quants APIキーのシークレットを読める」ブロックを次に置き換え:
```ts
  // 貸借区分はマスタから読むだけなので、J-Quants APIキーのシークレットは読まない
  const canReadApiKey = policyEntries
    .filter(([name]) => name.includes('YutaiRiskPrecompute'))
    .flatMap(([, p]) => (p as { Properties?: { PolicyDocument?: { Statement?: Array<{ Action?: string[] | string; Resource?: unknown }> } } }).Properties?.PolicyDocument?.Statement ?? [])
    .some((stmt) => {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : stmt.Action ? [stmt.Action] : [];
      return actions.includes('secretsmanager:GetSecretValue');
    });
  expect(canReadApiKey).toBe(false);
```

- [ ] **Step 2: 失敗を確認**

Run: `npx jest test/yutai-risk-precompute-batch.test.ts test/margin-name.test.ts`
Expected: `never calls J-Quants and never writes marginName` などがFAIL

- [ ] **Step 3: 実装**

`lambda/yutai-risk-precompute-batch/index.ts`:
- import `getApiKey`の行を削除、`import { isGeneralMarginOnly } from '../shared/margin-name';`にする
- `SECRET_ARN`・`API_BASE_URL`の定数を削除
- `MasterRow.marginName`のコメントを`// 貸借区分(taisyaku.jpの'貸借' | '貸借融資' | '非貸借')。信用残バッチが書く。東証行が無い銘柄はnull。`に変更
- `loadMarginNames`関数とその上のコメントを削除
- `handler`内: `const marginNames = await loadMarginNames();`を削除し、
```ts
      // 上場一覧に無い銘柄(東証外上場など)は区分不明としてnull。
      const marginName = marginNames ? (marginNames.get(row.ticker) ?? null) : row.marginName;
      const generalMarginOnly = isGeneralMarginOnly(marginName);
```
を
```ts
      const generalMarginOnly = isGeneralMarginOnly(row.marginName);
```
にし、`calcRisk(row.ticker, marginName, ...)`を`calcRisk(row.ticker, row.marginName, ...)`に
- `UpdateExpression`から`'marginName = :marginName ' +`を削除し、直前行末の`, `を調整する(`'lastGyakuhibu = :lastGyakuhibu, sameMonthLastYearGyakuhibu = :sameMonthLastYearGyakuhibu ' +`)。`ExpressionAttributeValues`から`':marginName': marginName,`を削除
- `calcGeneralMarginOnlyRisk`上のコメント`制度信用で売れない銘柄(信用・その他)`を`制度信用で売れない銘柄(貸借融資・非貸借)`に

`lambda/shared/margin-name.ts`を全体で次に置き換え:
```ts
// 銘柄の貸借区分(taisyaku.jp 全銘柄一括CSVの「貸借区分」: '貸借' | '貸借融資' | '非貸借')。
// 信用残バッチが東証行の値を優待マスタのmarginNameに書く。制度信用で売れる(=逆日歩が発生しうる)
// のは'貸借'だけ。'貸借融資'は買いのみ、'非貸借'は制度信用の対象外で、どちらもクロスは一般信用
// (証券会社の在庫)でしか組めない。移行前にJ-Quantsから取り込んだ'信用'・'その他'も同じ扱いになる。

// 区分が分かっていて、かつ制度信用で売れない銘柄。区分が分からない銘柄(東証行が無い地方市場
// 単独上場の銘柄など)は決めつけずにfalseを返す。
export function isGeneralMarginOnly(marginName: string | null): boolean {
  return marginName !== null && marginName !== '貸借';
}
```

`lib/j-quants-stack.ts`の`YutaiRiskPrecomputeBatchFunction`:
- `environment`から`// 貸借区分(J-Quants ...)...`のコメント行と`SECRET_ARN: this.apiKeySecret.secretArn,`を削除
- `this.apiKeySecret.grantRead(yutaiRiskPrecomputeBatchFn);`を削除

最後に、もう参照が無いことを確認:
Run: `grep -rn "fetchMarginNames\|pickMarginNames\|EquityMasterRecord" lambda test lib scripts`
Expected: `lambda/gyakuhibu-forecast-validation/target-tickers.ts`の`EquityMasterRecord`(Task 4で消す)以外にヒットなし

- [ ] **Step 4: 通過を確認**

Run: `npx jest test/yutai-risk-precompute-batch.test.ts test/margin-name.test.ts test/gyakuhibu-forecast-batch.test.ts`
Expected: PASS

Run(約10分、フォアグラウンド): `npx jest test/j-quants.test.ts -t "yutai-risk-precompute-batch Lambda"`
Expected: PASS(`YutaiRiskPrecompute`の検証はこの名前のテスト内にある)

Run: `npx tsc --noEmit -p .`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add lambda/yutai-risk-precompute-batch/index.ts lambda/shared/margin-name.ts lib/j-quants-stack.ts test/yutai-risk-precompute-batch.test.ts test/margin-name.test.ts test/j-quants.test.ts
git commit -m "Read the stored margin classification in the risk precompute batch instead of fetching it from J-Quants"
```

---

### Task 4: 検証用Lambdaの対象銘柄をマスタの`marginName`で絞る

**Files:**
- Modify: `lambda/gyakuhibu-forecast-validation/target-tickers.ts`
- Modify: `lib/j-quants-stack.ts`(`ForecastSnapshotFunction`、約500〜520行)
- Test: `test/gyakuhibu-forecast-validation.test.ts`(`describe('resolveTargetTickers')`と冒頭のモック・env)
- Test: `test/j-quants.test.ts`(`creates the ForecastSnapshotFunction ...`テスト)

**Interfaces:**
- Consumes: マスタの`marginName`
- Produces: `export async function resolveTargetTickers(rightsMonth: number): Promise<TargetTicker[]>`(シグネチャ・`TargetTicker`型は変えない)。`fetchMarginEligibleTickers`は削除

事前確認: `grep -rn "jquants\|SECRET_ARN\|API_BASE_URL\|getApiKey" lambda/gyakuhibu-forecast-validation` で、J-Quantsを使っているのが`target-tickers.ts`だけであることを確かめる(2026-10-28時点で確認済み: `index.ts`・`snapshot-input.ts`はtaisyaku.jpとDynamoDBのみ)。他に見つかった場合はSECRET_ARNとシークレット権限を残し、報告する。

- [ ] **Step 1: テストを書き換える(失敗させる)**

`test/gyakuhibu-forecast-validation.test.ts`:
- `mockGetApiKey`・`mockFetchWithRetry`は、J-Quantsを呼ばないことの確認に使うので残す
- `process.env.SECRET_ARN = ...`の行を削除
- `describe('resolveTargetTickers', ...)`内の3テストを次に置き換える(冒頭コメントの「equities/master」も「マスタのmarginName」に):

```ts
  test('keeps yutai-master rows whose rightsMonths include the target month and whose stored marginName is 貸借', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Items: [
        { ticker: '1111', companyName: 'A社', value: 1000, unitShares: 100, maxGyakuhibu: 5000, rightsMonths: [9], marginName: '貸借' },
        { ticker: '2222', companyName: 'B社', value: 2000, unitShares: 100, maxGyakuhibu: 3000, rightsMonths: [9], marginName: '貸借融資' }, // 貸借ではないので除外
        { ticker: '3333', companyName: 'C社', value: 500, unitShares: 100, maxGyakuhibu: 1000, rightsMonths: [3], marginName: '貸借' }, // 対象月(9)を含まない
        { ticker: '4444', companyName: 'D社', value: 500, unitShares: 100, maxGyakuhibu: 1000, rightsMonths: [9] }, // 区分不明(東証行なし)は除外
      ],
    });

    const result = await realResolveTargetTickers(9);

    expect(result).toEqual([
      { ticker: '1111', companyName: 'A社', value: 1000, unitShares: 100, maxGyakuhibu: 5000, rightsMonths: [9] },
    ]);
  });

  test('does not call J-Quants', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Items: [{ ticker: '1111', companyName: 'A社', value: 1000, unitShares: 100, maxGyakuhibu: 5000, rightsMonths: [9], marginName: '貸借' }],
    });

    await realResolveTargetTickers(9);

    expect(mockGetApiKey).not.toHaveBeenCalled();
    expect(mockFetchWithRetry).not.toHaveBeenCalled();
  });

  test('paginates the yutai master DynamoDB scan using LastEvaluatedKey', async () => {
    mockDdbSend
      .mockResolvedValueOnce({
        Items: [{ ticker: '5555', companyName: 'E社', value: 100, unitShares: 100, maxGyakuhibu: 200, rightsMonths: [9], marginName: '貸借' }],
        LastEvaluatedKey: { ticker: '5555' },
      })
      .mockResolvedValueOnce({
        Items: [{ ticker: '6666', companyName: 'F社', value: 100, unitShares: 100, maxGyakuhibu: 200, rightsMonths: [9], marginName: '貸借' }],
      });

    const result = await realResolveTargetTickers(9);

    expect(result.map((r) => r.ticker).sort()).toEqual(['5555', '6666']);
  });
```

`test/j-quants.test.ts`の`creates the ForecastSnapshotFunction ...`:
- テスト名の`the api secret, `を削除
- `Match.objectLike`の環境変数から`SECRET_ARN: Match.anyValue(),`を削除し、`hasResourceProperties`の後に次を追加:
```ts
  // 対象銘柄はマスタのmarginNameで絞るので、J-Quants APIキーは渡さない
  const snapshotFn = Object.entries(template.findResources('AWS::Lambda::Function')).find(([name]) =>
    name.includes('ForecastSnapshotFunction'),
  );
  expect(snapshotFn).toBeDefined();
  expect(
    (snapshotFn![1] as { Properties: { Environment: { Variables: Record<string, unknown> } } }).Properties.Environment.Variables,
  ).not.toHaveProperty('SECRET_ARN');
```
- `secretsmanager:GetSecretValue`の`expect(...).toBe(true)`を`.toBe(false)`にし、上に`// J-Quants APIキーのシークレットは読まない`

- [ ] **Step 2: 失敗を確認**

Run: `npx jest test/gyakuhibu-forecast-validation.test.ts`
Expected: `resolveTargetTickers`の3件がFAIL

- [ ] **Step 3: 実装**

`lambda/gyakuhibu-forecast-validation/target-tickers.ts`:
- 冒頭コメントの「J-Quants /equities/masterで貸借銘柄(MrgnNm==='貸借')」を「JQuantsYutaiMasterのmarginName(信用残バッチがtaisyaku.jpの貸借区分から書く)が'貸借'」に改め、「303件」の記述の後に`(2026-10-28に貸借区分の取得元をJ-Quantsからtaisyaku.jpへ移した)`を足す
- `import { getApiKey, fetchWithRetry } ...`、`SECRET_ARN`・`API_BASE_URL`・`REQUEST_INTERVAL_MS`(とそのコメント)・`MAX_RETRIES`の定数、`EquityMasterRecord`・`EquityMasterResponse`・`fetchMarginEligibleTickers`を削除
- 関数名を`scanYutaiMasterForRightsMonth` → `scanMarginEligibleYutaiMaster`に変え、条件に`item.marginName === '貸借' &&`を足す。関数上のコメントを`// JQuantsYutaiMasterの中で、rightsMonthsに対象月を含み、貸借区分が'貸借'の行だけを集める。`に
- `resolveTargetTickers`:
```ts
// 対象銘柄 = JQuantsYutaiMasterでrightsMonthsに対象月を含み、marginNameが'貸借'の銘柄。
export async function resolveTargetTickers(rightsMonth: number): Promise<TargetTicker[]> {
  return scanMarginEligibleYutaiMaster(rightsMonth);
}
```

`lib/j-quants-stack.ts`の`ForecastSnapshotFunction`:
- `environment`から`SECRET_ARN: this.apiKeySecret.secretArn,`を削除
- `this.apiKeySecret.grantRead(gyakuhibuForecastSnapshotFn);`を削除

確認:
Run: `grep -rn "equities/master\|MrgnNm" lambda lib`
Expected: ヒットなし(`docs/`・`test/fixtures`以外)

- [ ] **Step 4: 通過を確認**

Run: `npx jest test/gyakuhibu-forecast-validation.test.ts`
Expected: PASS

Run(約10分、フォアグラウンド): `npx jest test/j-quants.test.ts -t "ForecastSnapshotFunction"`
Expected: PASS

Run: `npx tsc --noEmit -p .`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add lambda/gyakuhibu-forecast-validation/target-tickers.ts lib/j-quants-stack.ts test/gyakuhibu-forecast-validation.test.ts test/j-quants.test.ts
git commit -m "Pick the validation target tickers by the stored margin classification instead of J-Quants"
```

---

### Task 5: README更新と全体テスト(コントローラーが自分で行う)

`README.md`に他セッションの未コミット変更があるため、サブエージェントに任せずコントローラーが行う。

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 他セッションの変更を退避する**

```bash
git diff README.md > "$SCRATCHPAD/readme-other-session.patch"
git checkout -- README.md
```
(`$SCRATCHPAD`はセッションのスクラッチパッドの絶対パス)

- [ ] **Step 2: READMEを直す**

- 51行目付近のデータフロー: `J-Quants /equities/master の`MrgnNm`(...)を貸借区分`marginName`として取り込む(...)` を、信用残バッチの項に移し「taisyaku.jp CSVの東証行の`貸借区分`(`貸借`/`貸借融資`/`非貸借`)で`marginName`を更新する(値が変わった銘柄だけ。東証行が無ければnull、CSVが取れなかった実行では前回の値のまま)」と書く。貸借判定バッチの項からは削除
- 136行目付近の逆日歩予測の説明: `貸借以外(`信用`・`その他`)` → `貸借以外(`貸借融資`・`非貸借`)`、`J-Quantsの上場一覧に無い銘柄(名証・福証・札証の単独上場など)` → `taisyaku.jpのCSVに東証行が無い銘柄(名証・福証・札証の単独上場など)`
- 166行目付近のLambda表: `YutaiRiskPrecomputeBatchFunction`の説明から「貸借区分など」を外し「貸借判定はマスタの`marginName`(信用残バッチが書く)で行う」に。`MarginBalanceBatchFunction`の行に「優待マスタの`marginName`も更新」を足す
- 276〜290行目付近の移行メモの節に「貸借区分もtaisyaku.jpへ移した(`docs/superpowers/specs/2026-10-27-margin-name-taisyaku-design.md`)。J-Quantsに残る依存は株価(`PriceBatchFunction`)と財務(`FinancialSummaryBatchFunction`)だけ」を足す

- [ ] **Step 3: コミットして他セッションの変更を戻す**

```bash
git add README.md
git commit -m "Document that the margin classification now comes from the taisyaku.jp CSV"
git apply "$SCRATCHPAD/readme-other-session.patch"
git diff --stat README.md   # 他セッションの1行だけが未コミットで残っていること
```

- [ ] **Step 4: 全体テスト**

Run(約15分、フォアグラウンド timeout 600000ms で足りなければバックグラウンドで完了通知を待つ): `NODE_OPTIONS=--max-old-space-size=4096 npx jest -i`
Expected: 全件PASS

Run: `npx tsc --noEmit -p .`
Expected: エラーなし

Run: `npx cdk synth > /dev/null`
Expected: 成功

---

## デプロイ後の確認(ユーザー承認後、マージ・デプロイしてから)

1. 信用残バッチを手動invoke(`aws lambda invoke --function-name <MarginBalanceBatchFunction名> --invocation-type Event`)するか、平日19:15 JSTの定期実行を待つ
2. ログのサマリーに`N margin classifications updated (0 failed)`が出ること
3. マスタの`marginName`分布が `貸借`約1,044・`貸借融資`約552・`非貸借`約1・null約41 であること
4. 翌日の貸借判定バッチ・予測バッチがエラー無く終わり、`tseForecast`/`forecastStatus`の件数が移行前と大きく変わらないこと
