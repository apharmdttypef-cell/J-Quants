# 優待変更情報の反映(条件の自動取り直し・廃止予告) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TDnetで検知した優待変更のうち、条件の取り直しを週次で自動実行し、廃止予告をマスタに記録して一覧・詳細・イベント一覧に表示する。

**Architecture:** 廃止予告の判定を`lambda/shared/yutai-abolition.ts`の純粋関数にまとめ、TDnetバッチとバックフィルスクリプトの両方から使う。マスタ行に`abolitionNotice`属性を足し、reference-apiが一覧・詳細でそのまま返す。detail-syncのステートマシンにEventBridgeの週次ルールを付ける。

**Tech Stack:** TypeScript, AWS CDK v2, Lambda(Node 22), DynamoDB(lib-dynamodb), Step Functions, Jest(ts-jest), React 19 + Vite(フロントにテストは無く、`npm run build`と`npm run lint`で検証)

**Spec:** `docs/superpowers/specs/2026-11-12-yutai-change-apply-design.md`

## Global Constraints

- git worktreeは使わない。ブランチ`feature/yutai-change-apply`上で直接作業する(既に作成・チェックアウト済み)。
- `README.md`にはユーザー自身の未コミット変更がある。**`git add README.md`や`git add -A`/`git add .`をしない**。Task 5でREADMEを編集するときも、既存の未コミット差分を消さないこと(コミットは`git add -p`ではなく、Task 5の手順に従う)。
- コミットは対象ファイルを明示して`git add <path>`する。コミットメッセージは英語1行+空行+`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- バックエンドのテスト: リポジトリ直下で`npx jest <file>`。全体は`npx jest`。
- フロントの検証: `cd frontend && npm run build && npm run lint`。
- コメントは既存コードに合わせて日本語で、「なぜ」を書く。
- 廃止予告の判定: タイトルに「株主優待」を含み、「廃止」または「終了」を含み、「一部」を含まない。
- `abolitionNotice`の形: `{ disclosedAt: 'YYYY-MM-DD', title: string }`。無い場合はAPIで`null`。
- 新しいイベント種別: `'abolition-notice'`(画面ラベル「廃止予告」)。
- detail-syncのスケジュール: `cron(0 12 ? * TUE *)`(JST 火曜21:00)。
- AWS CLIはこの環境(cp932)で日本語を出力できない。スクリプトはNode SDKで書く。
- 本番へのデプロイ・バックフィルの`--execute`・`main`へのマージ・pushは**このプランでは行わない**(ユーザー承認後に別途)。

---

### Task 1: 廃止予告の判定とTDnetバッチでの記録

**Files:**
- Create: `lambda/shared/yutai-abolition.ts`
- Create: `test/yutai-abolition.test.ts`
- Modify: `lambda/yutai-tdnet-watch-batch/index.ts`(キーワード定数・`isAbolitionRelated`・ハンドラのticker分岐・`recordEvents`)
- Test: `test/yutai-tdnet-watch-batch.test.ts`

**Interfaces:**
- Produces(`lambda/shared/yutai-abolition.ts`):
  ```ts
  export interface AbolitionNotice { disclosedAt: string; title: string }
  export type YutaiTdnetEventType = 'start' | 'update' | 'abolition' | 'abolition-notice';
  export function isAbolitionNotice(title: string): boolean;
  export function latestAbolitionNotice(disclosures: Array<{ disclosedAt: string; title: string }>): AbolitionNotice | null;
  ```

- [ ] **Step 1: 判定関数の失敗するテストを書く**

`test/yutai-abolition.test.ts`:

```ts
import { isAbolitionNotice, latestAbolitionNotice } from '../lambda/shared/yutai-abolition';

test('treats a whole-program abolition or termination as an abolition notice', () => {
  expect(isAbolitionNotice('株主優待制度の廃止に関するお知らせ')).toBe(true);
  expect(isAbolitionNotice('2027年３月期配当予想の修正（無配）及び株主優待制度の廃止に関するお知らせ')).toBe(true);
  expect(isAbolitionNotice('現行株主優待制度の終了および持株会社における新株主優待制度の導入方針について')).toBe(true);
});

test('does not treat a partial change that drops one item as an abolition notice', () => {
  // 6577: 制度自体は続く(デジタルギフトだけをやめる)
  expect(isAbolitionNotice('株主優待制度の一部変更（デジタルギフトの廃止）のお知らせ')).toBe(false);
});

test('requires the yutai keyword', () => {
  expect(isAbolitionNotice('定款の一部廃止に関するお知らせ')).toBe(false);
  expect(isAbolitionNotice('事業の終了に関するお知らせ')).toBe(false);
});

test('does not treat an ordinary change as an abolition notice', () => {
  expect(isAbolitionNotice('株主優待制度の変更（拡充）に関するお知らせ')).toBe(false);
});

test('latestAbolitionNotice picks the newest abolition disclosure and ignores others', () => {
  expect(
    latestAbolitionNotice([
      { disclosedAt: '2026-09-10', title: '株主優待制度の廃止に関するお知らせ' },
      { disclosedAt: '2026-10-13', title: '株主優待制度の廃止に関する補足説明' },
      { disclosedAt: '2026-10-20', title: '株主優待制度の変更に関するお知らせ' },
    ]),
  ).toEqual({ disclosedAt: '2026-10-13', title: '株主優待制度の廃止に関する補足説明' });
});

test('latestAbolitionNotice returns null when none qualifies', () => {
  expect(latestAbolitionNotice([{ disclosedAt: '2026-10-20', title: '株主優待制度の変更に関するお知らせ' }])).toBeNull();
  expect(latestAbolitionNotice([])).toBeNull();
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx jest test/yutai-abolition.test.ts`
Expected: FAIL(`Cannot find module '../lambda/shared/yutai-abolition'`)

- [ ] **Step 3: 判定関数を実装**

`lambda/shared/yutai-abolition.ts`:

```ts
// TDnetの開示タイトルから「優待制度そのものの廃止予告」を判定する。
// yutai-tdnet-watch-batch(毎週の検知)とscripts/backfill-abolition-notice.ts(過去分の一括反映)で共有する。
// 設計: docs/superpowers/specs/2026-11-12-yutai-change-apply-design.md

const YUTAI_KEYWORD = '株主優待';
// 「終了」は9223「現行株主優待制度の終了および…」のような言い回しを拾うため。
const ABOLITION_KEYWORDS = ['廃止', '終了'];
// 「一部変更（デジタルギフトの廃止）」のように、制度は続き一部の品目だけをやめる開示を除く。
const PARTIAL_KEYWORD = '一部';

export interface AbolitionNotice {
  disclosedAt: string;
  title: string;
}

export type YutaiTdnetEventType = 'start' | 'update' | 'abolition' | 'abolition-notice';

export function isAbolitionNotice(title: string): boolean {
  return (
    title.includes(YUTAI_KEYWORD) &&
    ABOLITION_KEYWORDS.some((keyword) => title.includes(keyword)) &&
    !title.includes(PARTIAL_KEYWORD)
  );
}

// 同じ銘柄に廃止予告が複数あれば(本開示+補足など)、最も新しい開示を記録する。
export function latestAbolitionNotice(
  disclosures: Array<{ disclosedAt: string; title: string }>,
): AbolitionNotice | null {
  let latest: AbolitionNotice | null = null;
  for (const { disclosedAt, title } of disclosures) {
    if (!isAbolitionNotice(title)) continue;
    if (!latest || disclosedAt > latest.disclosedAt) latest = { disclosedAt, title };
  }
  return latest;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx jest test/yutai-abolition.test.ts`
Expected: PASS(6件)

- [ ] **Step 5: TDnetバッチの失敗するテストを足す**

`test/yutai-tdnet-watch-batch.test.ts`の末尾に追加する(既存のヘルパー`dayListHtml`・`mockFetch`・`mockFetchAllListings`・`mockSend`を使う)。

```ts
describe('abolition notices (abolition announced while kabuyutai.com still lists the program)', () => {
  const listing = {
    ticker: '3297',
    companyName: '東武住販',
    content: '下関市ゆかりの食品（1,000円相当～）',
    rightsMonths: [5],
    value: 1000,
    minInvestment: 100000,
  };

  test('upserts the master with abolitionNotice and records an abolition-notice event', async () => {
    const title = '2027年５月期配当予想の修正（無配）及び株主優待制度の廃止に関するお知らせ';
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => dayListHtml([{ code: '32970', name: '東武住販', title }]) });
    mockFetchAllListings.mockResolvedValueOnce([listing]);
    mockSend.mockResolvedValueOnce({ Item: { ticker: '3297' } }); // Get: already in master
    mockSend.mockResolvedValue({});

    await handler();

    const update = mockSend.mock.calls[1][0] as { UpdateExpression: string; ExpressionAttributeValues: Record<string, unknown> };
    expect(update.UpdateExpression).toContain('abolitionNotice = :abolitionNotice');
    expect(update.ExpressionAttributeValues[':abolitionNotice']).toEqual({
      disclosedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      title,
    });
    expect(mockSend.mock.calls[2][0]).toMatchObject({
      TableName: 'JQuantsYutaiTdnetEvent',
      Item: expect.objectContaining({ ticker: '3297', eventType: 'abolition-notice', disclosureTitle: title }),
    });
  });

  test('an ordinary update leaves an existing abolitionNotice alone', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => dayListHtml([{ code: '32970', name: '東武住販', title: '株主優待制度の変更に関するお知らせ' }]),
    });
    mockFetchAllListings.mockResolvedValueOnce([listing]);
    mockSend.mockResolvedValueOnce({ Item: { ticker: '3297' } });
    mockSend.mockResolvedValue({});

    await handler();

    const update = mockSend.mock.calls[1][0] as { UpdateExpression: string; ExpressionAttributeValues: Record<string, unknown> };
    expect(update.UpdateExpression).not.toContain('abolitionNotice');
    expect(update.ExpressionAttributeValues).not.toHaveProperty(':abolitionNotice');
    expect(mockSend.mock.calls[2][0]).toMatchObject({ Item: expect.objectContaining({ eventType: 'update' }) });
  });

  test('a partial change mentioning 廃止 is an ordinary update', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        dayListHtml([{ code: '32970', name: '東武住販', title: '株主優待制度の一部変更（デジタルギフトの廃止）のお知らせ' }]),
    });
    mockFetchAllListings.mockResolvedValueOnce([listing]);
    mockSend.mockResolvedValueOnce({ Item: { ticker: '3297' } });
    mockSend.mockResolvedValue({});

    await handler();

    const update = mockSend.mock.calls[1][0] as { UpdateExpression: string };
    expect(update.UpdateExpression).not.toContain('abolitionNotice');
    expect(mockSend.mock.calls[2][0]).toMatchObject({ Item: expect.objectContaining({ eventType: 'update' }) });
  });

  test('labels each disclosure separately when an abolition notice and an ordinary change arrive together', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        dayListHtml([
          { code: '32970', name: '東武住販', title: '株主優待制度の廃止に関するお知らせ' },
          { code: '32970', name: '東武住販', title: '株主優待発送日の決定に関するお知らせ' },
        ]),
    });
    mockFetchAllListings.mockResolvedValueOnce([listing]);
    mockSend.mockResolvedValueOnce({ Item: { ticker: '3297' } });
    mockSend.mockResolvedValue({});

    await handler();

    const puts = mockSend.mock.calls
      .map((call) => call[0] as { TableName: string; Item?: { eventType: string; disclosureTitle: string } })
      .filter((input) => input.TableName === 'JQuantsYutaiTdnetEvent');
    expect(puts.map((p) => [p.Item!.disclosureTitle, p.Item!.eventType])).toEqual(
      expect.arrayContaining([
        ['株主優待制度の廃止に関するお知らせ', 'abolition-notice'],
        ['株主優待発送日の決定に関するお知らせ', 'update'],
      ]),
    );
  });

  test('a termination disclosure for a program no longer on kabuyutai.com deletes the row', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => dayListHtml([{ code: '92230', name: '終了企業', title: '現行株主優待制度の終了に関するお知らせ' }]),
      });
      mockFetchAllListings.mockResolvedValueOnce([]);
      mockSend.mockResolvedValue({});

      await handler();

      expect(mockSend.mock.calls[0][0]).toMatchObject({ TableName: 'JQuantsYutaiMaster', Key: { ticker: '9223' } });
      expect(mockSend.mock.calls[1][0]).toMatchObject({ Item: expect.objectContaining({ eventType: 'abolition' }) });
    } finally {
      logSpy.mockRestore();
    }
  });
});
```

- [ ] **Step 6: 失敗を確認**

Run: `npx jest test/yutai-tdnet-watch-batch.test.ts`
Expected: 追加した5件のうち、少なくとも「abolitionNotice」「abolition-notice」「終了」のテストがFAIL。既存テストはPASSのまま。

- [ ] **Step 7: TDnetバッチを改修**

`lambda/yutai-tdnet-watch-batch/index.ts`:

1. importに追加:
   ```ts
   import { isAbolitionNotice, latestAbolitionNotice, type YutaiTdnetEventType } from '../shared/yutai-abolition';
   ```
2. `ABOLITION_KEYWORDS`定数とそのコメント、`isAbolitionRelated`関数を削除する。
3. ticker分岐の`sawAbolitionKeyword`を次に置き換える(削除のゲートとしての意味を残すコメントにする):
   ```ts
   // 優待制度そのものの廃止予告(lambda/shared/yutai-abolition.ts)。kabuyutai.comの最新一覧に
   // 見当たらない、という状態と組み合わさった時だけ本当の廃止として削除する
   // (トランジェントなスクレイピング失敗だけでは削除しない、というゲート)。
   const abolitionNotice = latestAbolitionNotice(disclosures);
   ```
   削除分岐の`if (sawAbolitionKeyword)`は`if (abolitionNotice)`にする。
4. `UpdateCommand`の組み立てを次の形にする(既存のSET句・値は変えず、廃止予告のときだけ足す):
   ```ts
   // 廃止予告があれば記録する。予告でない更新ではabolitionNoticeに触れない
   // (過去に付いた予告を、後続の発送日決定などの開示で消さないため)。
   const setAbolitionNotice = abolitionNotice ? ', abolitionNotice = :abolitionNotice' : '';
   ...
   UpdateExpression:
     'SET companyName = :companyName, #content = :content, #value = :value, unitShares = :unitShares, minInvestment = :minInvestment, rightsMonths = :rightsMonths, detailUrl = :detailUrl, listBadge = :listBadge' +
     setAbolitionNotice +
     ' REMOVE conditionCheckedAt',
   ExpressionAttributeValues: {
     ...(既存の値),
     ...(abolitionNotice ? { ':abolitionNotice': abolitionNotice } : {}),
   },
   ```
   ログ行も`abolitionNotice`があれば`(abolition notice: ${abolitionNotice.disclosedAt})`を付ける。
5. イベント記録を、廃止予告の開示とそれ以外に分ける:
   ```ts
   // 同じ週に廃止予告と発送日決定などが並ぶことがあるため、種別は開示ごとに決める。
   const noticeDisclosures = disclosures.filter((d) => isAbolitionNotice(d.title));
   const otherDisclosures = disclosures.filter((d) => !isAbolitionNotice(d.title));
   await recordEvents(ticker, noticeDisclosures, 'abolition-notice');
   await recordEvents(ticker, otherDisclosures, eventType);
   ```
   (削除分岐の`recordEvents(ticker, disclosures, 'abolition')`はそのまま。)
6. `recordEvents`の第3引数の型を`YutaiTdnetEventType`にする。空配列なら何もしない(既存のforループで自然にそうなる)。

- [ ] **Step 8: テストが通ることを確認**

Run: `npx jest test/yutai-tdnet-watch-batch.test.ts test/yutai-abolition.test.ts`
Expected: PASS(既存+追加すべて)

- [ ] **Step 9: コミット**

```bash
git add lambda/shared/yutai-abolition.ts test/yutai-abolition.test.ts lambda/yutai-tdnet-watch-batch/index.ts test/yutai-tdnet-watch-batch.test.ts
git commit -m "Record abolition notices on the yutai master from TDnet disclosures" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 過去分のバックフィルスクリプト

**Files:**
- Create: `scripts/lib/abolition-notice-backfill.ts`
- Create: `scripts/backfill-abolition-notice.ts`
- Create: `test/abolition-notice-backfill.test.ts`

**Interfaces:**
- Consumes: `isAbolitionNotice`, `latestAbolitionNotice`, `AbolitionNotice`(Task 1, `lambda/shared/yutai-abolition.ts`)
- Produces(`scripts/lib/abolition-notice-backfill.ts`):
  ```ts
  export interface AbolitionNoticeTarget { ticker: string; notice: AbolitionNotice; eventIds: string[] }
  export async function findAbolitionNoticeTargets(
    client: { send: (command: unknown) => Promise<any> }, eventTableName: string, masterTableName: string,
  ): Promise<AbolitionNoticeTarget[]>;
  export async function applyAbolitionNoticeTargets(
    client: { send: (command: unknown) => Promise<any> }, eventTableName: string, masterTableName: string,
    targets: AbolitionNoticeTarget[],
  ): Promise<void>;
  ```

- [ ] **Step 1: 失敗するテストを書く**

`test/abolition-notice-backfill.test.ts`:

```ts
// モジュール化(TS2451回避)。
export {};

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  QueryCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'Query' })),
  GetCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'Get' })),
  UpdateCommand: jest.fn((input: unknown) => ({ ...(input as object), __type: 'Update' })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { findAbolitionNoticeTargets, applyAbolitionNoticeTargets } = require('../scripts/lib/abolition-notice-backfill');

const mockSend = jest.fn();
const client = { send: mockSend };

function event(ticker: string, disclosedAt: string, title: string, eventType = 'update') {
  return { pk: 'ALL', eventId: `${disclosedAt}#${ticker}#abcd1234`, ticker, disclosedAt, disclosureTitle: title, eventType };
}

beforeEach(() => mockSend.mockReset());

test('finds abolition notices for tickers still in the master, paging through events', async () => {
  mockSend
    .mockResolvedValueOnce({
      Items: [
        event('3297', '2026-10-13', '無配及び株主優待制度の廃止に関するお知らせ'),
        event('6577', '2026-09-10', '株主優待制度の一部変更（デジタルギフトの廃止）のお知らせ'),
      ],
      LastEvaluatedKey: { pk: 'ALL', eventId: 'x' },
    })
    .mockResolvedValueOnce({
      Items: [
        event('2901', '2026-10-20', '株主優待制度廃止に関するお知らせ', 'abolition'),
        event('9223', '2026-09-14', '現行株主優待制度の終了および新制度の導入方針について'),
      ],
    })
    .mockResolvedValueOnce({ Item: { ticker: '3297' } }) // master get 3297
    .mockResolvedValueOnce({ Item: { ticker: '9223' } }); // master get 9223

  const targets = await findAbolitionNoticeTargets(client, 'Events', 'Master');

  expect(mockSend.mock.calls[1][0]).toMatchObject({ __type: 'Query', ExclusiveStartKey: { pk: 'ALL', eventId: 'x' } });
  expect(targets).toEqual([
    { ticker: '3297', notice: { disclosedAt: '2026-10-13', title: '無配及び株主優待制度の廃止に関するお知らせ' }, eventIds: ['2026-10-13#3297#abcd1234'] },
    { ticker: '9223', notice: { disclosedAt: '2026-09-14', title: '現行株主優待制度の終了および新制度の導入方針について' }, eventIds: ['2026-09-14#9223#abcd1234'] },
  ]);
});

test('skips tickers that are no longer in the master', async () => {
  mockSend
    .mockResolvedValueOnce({ Items: [event('3297', '2026-10-13', '株主優待制度の廃止に関するお知らせ')] })
    .mockResolvedValueOnce({}); // master get: no Item

  expect(await findAbolitionNoticeTargets(client, 'Events', 'Master')).toEqual([]);
});

test('apply sets abolitionNotice only on existing master rows and relabels the events', async () => {
  mockSend.mockResolvedValue({});

  await applyAbolitionNoticeTargets(client, 'Events', 'Master', [
    { ticker: '3297', notice: { disclosedAt: '2026-10-13', title: 't' }, eventIds: ['2026-10-13#3297#abcd1234'] },
  ]);

  expect(mockSend.mock.calls[0][0]).toMatchObject({
    __type: 'Update',
    TableName: 'Master',
    Key: { ticker: '3297' },
    UpdateExpression: 'SET abolitionNotice = :notice',
    ConditionExpression: 'attribute_exists(ticker)',
    ExpressionAttributeValues: { ':notice': { disclosedAt: '2026-10-13', title: 't' } },
  });
  expect(mockSend.mock.calls[1][0]).toMatchObject({
    __type: 'Update',
    TableName: 'Events',
    Key: { pk: 'ALL', eventId: '2026-10-13#3297#abcd1234' },
    UpdateExpression: 'SET eventType = :type',
    ExpressionAttributeValues: { ':type': 'abolition-notice' },
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx jest test/abolition-notice-backfill.test.ts`
Expected: FAIL(`Cannot find module '../scripts/lib/abolition-notice-backfill'`)

- [ ] **Step 3: ライブラリを実装**

`scripts/lib/abolition-notice-backfill.ts`:

```ts
// 廃止予告(lambda/shared/yutai-abolition.ts)の判定を導入する前に'update'/'start'として
// 記録された開示から、まだマスタに残っている銘柄へabolitionNoticeを付け直す。
// 設計: docs/superpowers/specs/2026-11-12-yutai-change-apply-design.md
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { isAbolitionNotice, latestAbolitionNotice, type AbolitionNotice } from '../../lambda/shared/yutai-abolition';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = { send: (command: any) => Promise<any> };

export interface AbolitionNoticeTarget {
  ticker: string;
  notice: AbolitionNotice;
  eventIds: string[];
}

interface EventRow {
  eventId: string;
  ticker: string;
  disclosedAt: string;
  title: string;
}

async function scanCandidateEvents(client: Client, eventTableName: string): Promise<EventRow[]> {
  const rows: EventRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: eventTableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': 'ALL' },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of result.Items ?? []) {
      // 'abolition'は既に削除済みの銘柄なので対象外。
      if (item.eventType !== 'update' && item.eventType !== 'start') continue;
      if (typeof item.disclosureTitle !== 'string' || !isAbolitionNotice(item.disclosureTitle)) continue;
      rows.push({ eventId: item.eventId, ticker: item.ticker, disclosedAt: item.disclosedAt, title: item.disclosureTitle });
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return rows;
}

export async function findAbolitionNoticeTargets(
  client: Client,
  eventTableName: string,
  masterTableName: string,
): Promise<AbolitionNoticeTarget[]> {
  const byTicker = new Map<string, EventRow[]>();
  for (const row of await scanCandidateEvents(client, eventTableName)) {
    byTicker.set(row.ticker, [...(byTicker.get(row.ticker) ?? []), row]);
  }

  const targets: AbolitionNoticeTarget[] = [];
  for (const [ticker, rows] of byTicker) {
    const master = await client.send(new GetCommand({ TableName: masterTableName, Key: { ticker } }));
    if (!master.Item) continue;
    const notice = latestAbolitionNotice(rows);
    if (!notice) continue;
    targets.push({ ticker, notice, eventIds: rows.map((r) => r.eventId) });
  }
  return targets;
}

export async function applyAbolitionNoticeTargets(
  client: Client,
  eventTableName: string,
  masterTableName: string,
  targets: AbolitionNoticeTarget[],
): Promise<void> {
  for (const target of targets) {
    // 確認から実行までの間に行が消えていたら作り直さない(UpdateCommandは行が無いと新規作成する)。
    await client.send(
      new UpdateCommand({
        TableName: masterTableName,
        Key: { ticker: target.ticker },
        UpdateExpression: 'SET abolitionNotice = :notice',
        ConditionExpression: 'attribute_exists(ticker)',
        ExpressionAttributeValues: { ':notice': target.notice },
      }),
    );
    for (const eventId of target.eventIds) {
      await client.send(
        new UpdateCommand({
          TableName: eventTableName,
          Key: { pk: 'ALL', eventId },
          UpdateExpression: 'SET eventType = :type',
          ExpressionAttributeValues: { ':type': 'abolition-notice' },
        }),
      );
    }
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx jest test/abolition-notice-backfill.test.ts`
Expected: PASS(3件)

- [ ] **Step 5: CLIラッパーを書く**

`scripts/backfill-abolition-notice.ts`(既存の`scripts/cleanup-legacy-margin-balance.ts`と同じ形):

```ts
// 廃止予告の判定を入れる前に記録されたTDnetイベントから、マスタにabolitionNoticeを付け直す一回限りのスクリプト。
// 実行例: npx ts-node scripts/backfill-abolition-notice.ts            (対象の表示だけ)
//         npx ts-node scripts/backfill-abolition-notice.ts --execute  (書き込み)
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { applyAbolitionNoticeTargets, findAbolitionNoticeTargets } from './lib/abolition-notice-backfill';

const YUTAI_TDNET_EVENT_TABLE_NAME = process.env.YUTAI_TDNET_EVENT_TABLE_NAME ?? 'JQuantsYutaiTdnetEvent';
const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME ?? 'JQuantsYutaiMaster';

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

async function main() {
  const execute = process.argv.includes('--execute');

  const targets = await findAbolitionNoticeTargets(ddbDocClient, YUTAI_TDNET_EVENT_TABLE_NAME, YUTAI_MASTER_TABLE_NAME);
  console.log(`対象: ${targets.length}銘柄`);
  for (const target of targets) {
    console.log(`${target.ticker} ${target.notice.disclosedAt} ${target.notice.title} (イベント${target.eventIds.length}件)`);
  }

  if (!execute) {
    console.log('ドライランです。書き込むには --execute を付けて再実行してください。');
    return;
  }

  await applyAbolitionNoticeTargets(ddbDocClient, YUTAI_TDNET_EVENT_TABLE_NAME, YUTAI_MASTER_TABLE_NAME, targets);
  console.log(`書き込みました: ${targets.length}銘柄`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

- [ ] **Step 6: 型検査**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: エラーなし(既存でエラーがあれば、今回触ったファイルに関するものが無いことを確認する)

- [ ] **Step 7: コミット**

```bash
git add scripts/lib/abolition-notice-backfill.ts scripts/backfill-abolition-notice.ts test/abolition-notice-backfill.test.ts
git commit -m "Add a one-off script to backfill abolition notices from recorded TDnet events" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: detail-syncの週次スケジュール

**Files:**
- Modify: `lib/j-quants-stack.ts`(`new stepfunctions.StateMachine(this, 'YutaiDetailSyncStateMachine', ...)`付近、401行目前後)
- Test: `test/j-quants.test.ts`
- Modify: `docs/superpowers/notes/2026-10-02-yutai-detail-sync-runbook.md`(「次に手動実行すべき目安」)
- Modify: `docs/superpowers/notes/2026-10-02-yutai-condition-master-operational-decisions.md`(「1. 再取得キューを誰も消費しない(保留)」)

**Interfaces:**
- Consumes: なし
- Produces: EventBridgeルール`YutaiDetailSyncSchedule`(ターゲットは`JQuantsYutaiDetailSync`ステートマシン)

- [ ] **Step 1: 失敗するテストを書く**

`test/j-quants.test.ts`の、detail-syncステートマシンのテスト群の後ろに追加する(ファイル内の既存ヘルパー`synth()`を使う):

```ts
test('runs the detail sync state machine every Tuesday at JST 21:00, the day after the TDnet watch', () => {
  // TDnetバッチ(月曜 UTC 12:00)がconditionCheckedAtを消した銘柄を翌日に取り直す。
  // 対象選定(未取得 or 90日超)はハンドラ側なので、入力は空でよい。
  const template = synth();
  const machines = template.findResources('AWS::StepFunctions::StateMachine');
  const machineId = Object.keys(machines)[0];

  const rules = Object.values(template.findResources('AWS::Events::Rule')) as Array<{
    Properties: { ScheduleExpression?: string; State?: string; Targets?: Array<{ Arn?: unknown }> };
  }>;
  const rule = rules.find((r) => r.Properties.ScheduleExpression === 'cron(0 12 ? * TUE *)');
  expect(rule).toBeDefined();
  expect(rule!.Properties.State).toBe('ENABLED');
  expect(rule!.Properties.Targets).toHaveLength(1);
  expect(rule!.Properties.Targets![0].Arn).toEqual({ Ref: machineId });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx jest test/j-quants.test.ts -t "every Tuesday"`
Expected: FAIL(`expect(rule).toBeDefined()`)

- [ ] **Step 3: スケジュールを足す**

`lib/j-quants-stack.ts`で、ステートマシンを変数に受け、ルールを足す:

```ts
    const detailSyncStateMachine = new stepfunctions.StateMachine(this, 'YutaiDetailSyncStateMachine', {
      // (既存の設定はそのまま)
    });

    // TDnetバッチ(YutaiTdnetWatchBatchSchedule: 月曜 UTC 12:00)がconditionCheckedAtを消した銘柄を、
    // 翌日に取り直す。JST 火曜21:00 = UTC 火曜12:00で、kabuyutai.comを叩く他の処理と重ならない。
    // 対象選定(未取得 or 90日超)はハンドラ側なので入力は空でよい。通常週は数十件で1分程度、
    // 90日のクールダウンが一斉に切れる週は全件(約33分)になるが、ステートマシンのタイムアウト(2時間)に収まる。
    new events.Rule(this, 'YutaiDetailSyncSchedule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '12', weekDay: 'TUE' }),
      targets: [new targets.SfnStateMachine(detailSyncStateMachine)],
    });
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx jest test/j-quants.test.ts`
Expected: PASS(既存の`resourceCountIs('AWS::StepFunctions::StateMachine', 1)`等も含めて全件)

- [ ] **Step 5: 運用ドキュメントを更新**

`docs/superpowers/notes/2026-10-02-yutai-detail-sync-runbook.md`の「次に手動実行すべき目安」の2つ目の箇条書き(「ただし detail-sync は EventBridge スケジュールを持たない(手動運用)…」の3行)を次に置き換える:

```markdown
- 2026-11-12 から detail-sync は **毎週火曜 JST 21:00 に自動実行** する(`YutaiDetailSyncSchedule`)。
  TDnet 検知で `conditionCheckedAt` が消された銘柄は翌日に取り直される。手動実行は急ぐときだけでよい。
  設計: `docs/superpowers/specs/2026-11-12-yutai-change-apply-design.md`
```

`docs/superpowers/notes/2026-10-02-yutai-condition-master-operational-decisions.md`の見出し「## 1. 再取得キューを誰も消費しない(保留)」を「## 1. 再取得キューを誰も消費しない(2026-11-12 解決)」にし、その見出しの直下に次の段落を足す(既存の本文は経緯として残す):

```markdown
**2026-11-12 追記:** 本番で48件が1か月以上取り直し待ちのまま止まっていたため、detail-sync のステートマシンに
毎週火曜 JST 21:00 のスケジュールを付けた(TDnet バッチの翌日)。対象選定はハンドラの既存仕様
(未取得 or 90日超)のまま。設計: `docs/superpowers/specs/2026-11-12-yutai-change-apply-design.md`
```

- [ ] **Step 6: コミット**

```bash
git add lib/j-quants-stack.ts test/j-quants.test.ts docs/superpowers/notes/2026-10-02-yutai-detail-sync-runbook.md docs/superpowers/notes/2026-10-02-yutai-condition-master-operational-decisions.md
git commit -m "Run the yutai detail sync weekly so TDnet-flagged tickers get their conditions re-fetched" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: APIで`abolitionNotice`を返す

**Files:**
- Modify: `lambda/reference-api/index.ts`(`YutaiMasterRow`型、`toYutaiMasterRow`、`YUTAI_LIST_PROJECTION`、`listYutaiForecast`の`items.push`、`getYutaiDetail`のレスポンス)
- Test: `test/reference-api.test.ts`

**Interfaces:**
- Consumes: `AbolitionNotice`(Task 1, `lambda/shared/yutai-abolition.ts`)
- Produces: `GET /yutai/forecast`の各`tickers[]`と`GET /yutai/{ticker}`に`abolitionNotice: { disclosedAt: string; title: string } | null`

- [ ] **Step 1: 失敗するテストを書く**

`test/reference-api.test.ts`:

1. 既存テスト`'the yutai list scan projects only the attributes the list returns'`の期待配列の末尾(`'rsiLabel'`の後)に`'abolitionNotice'`を足す。
2. RSIのテスト群の後ろに追加:

```ts
test('GET /yutai/forecast returns the abolition notice, and null for rows without one', async () => {
  const notice = { disclosedAt: '2026-10-13', title: '株主優待制度の廃止に関するお知らせ' };
  mockSend
    .mockResolvedValueOnce({
      Items: [
        { ticker: '3297', content: '食品', value: 1000, unitShares: 100, rightsMonths: [5], abolitionNotice: notice },
        { ticker: '5678', content: '自社製品', value: 3000, unitShares: 100, rightsMonths: [8] },
      ],
    }) // yutai master scan
    .mockResolvedValueOnce({ Items: [] }); // forecast scan

  const result = await handler(makeEvent('GET /yutai/forecast', { queryStringParameters: {} }));

  const parsed = body(result) as { tickers: Array<Record<string, unknown>> };
  expect(parsed.tickers.find((t) => t.ticker === '3297')).toHaveProperty('abolitionNotice', notice);
  expect(parsed.tickers.find((t) => t.ticker === '5678')).toHaveProperty('abolitionNotice', null);
});

test('GET /yutai/{ticker} returns the abolition notice, and null when there is none', async () => {
  const notice = { disclosedAt: '2026-10-13', title: '株主優待制度の廃止に関するお知らせ' };
  mockSend
    .mockResolvedValueOnce({ Item: { ticker: '3297', content: '食品', value: 1000, unitShares: 100, rightsMonths: [5], abolitionNotice: notice } })
    .mockResolvedValueOnce({ Items: [] }) // latest price
    .mockResolvedValueOnce({ Items: [] }); // gyakuhibu actual history
  expect(body(await handler(makeEvent('GET /yutai/{ticker}', { pathParameters: { ticker: '3297' } })))).toMatchObject({
    abolitionNotice: notice,
  });

  mockSend
    .mockResolvedValueOnce({ Item: { ticker: '1234', content: 'QUOカード', value: 1000, unitShares: 100, rightsMonths: [8] } })
    .mockResolvedValueOnce({ Items: [] })
    .mockResolvedValueOnce({ Items: [] });
  expect(body(await handler(makeEvent('GET /yutai/{ticker}', { pathParameters: { ticker: '1234' } })))).toMatchObject({
    abolitionNotice: null,
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx jest test/reference-api.test.ts`
Expected: 射影のテストと追加2件がFAIL

- [ ] **Step 3: 実装**

`lambda/reference-api/index.ts`:

1. importに`import type { AbolitionNotice } from '../shared/yutai-abolition';`を足す。
2. `YutaiMasterRow`の`rsiAsOf`の後ろに:
   ```ts
   // yutai-tdnet-watch-batchが書く、優待制度そのものの廃止予告。無ければnull。
   abolitionNotice: AbolitionNotice | null;
   ```
3. `toYutaiMasterRow`の`rsiAsOf`の後ろに`abolitionNotice: item.abolitionNotice ?? null,`。
4. `YUTAI_LIST_PROJECTION`の末尾を`'requiredInvestment, lastGyakuhibu, sameMonthLastYearGyakuhibu, rsiLabel, abolitionNotice'`にする。
5. `listYutaiForecast`の`items.push({...})`で`rsiLabel: row.rsiLabel,`の後ろに`abolitionNotice: row.abolitionNotice,`。
6. `getYutaiDetail`のレスポンスで`rsiAsOf: master.rsiAsOf,`の後ろに`abolitionNotice: master.abolitionNotice,`。

- [ ] **Step 4: テストが通ることを確認**

Run: `npx jest test/reference-api.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add lambda/reference-api/index.ts test/reference-api.test.ts
git commit -m "Return the yutai abolition notice from the list and detail endpoints" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 画面表示とREADME

**Files:**
- Modify: `frontend/src/api/types.ts`(`YutaiDetail`・`YutaiForecastListItem`・`YutaiTdnetEventType`)
- Modify: `frontend/src/pages/YutaiListPage.tsx`(`RsiBadge`の隣にバッジ)
- Modify: `frontend/src/pages/YutaiDetailPage.tsx`(タイトル直下に警告)
- Modify: `frontend/src/pages/YutaiTdnetEventsPage.tsx`(ラベルとクラス)
- Modify: `frontend/src/index.css`
- Modify: `README.md`(ユーザーの未コミット変更あり。注意点はGlobal Constraints)

**Interfaces:**
- Consumes: APIの`abolitionNotice: { disclosedAt: string; title: string } | null`(Task 4)、イベント種別`'abolition-notice'`(Task 1)

- [ ] **Step 1: 型を足す**

`frontend/src/api/types.ts`:

```ts
// 優待制度そのものの廃止予告(TDnetの開示)。最後の権利日までは優待が出ることもあるので、一覧からは外さない。
export interface AbolitionNotice {
  disclosedAt: string;
  title: string;
}
```

`YutaiDetail`の`rsiAsOf: string | null;`の後ろと、`YutaiForecastListItem`の`rsiLabel: RsiLabel;`の後ろに、それぞれ`abolitionNotice: AbolitionNotice | null;`を足す。
`YutaiTdnetEventType`を`'start' | 'update' | 'abolition' | 'abolition-notice'`にする。

- [ ] **Step 2: 一覧のバッジ**

`frontend/src/pages/YutaiListPage.tsx`の`RsiBadge`関数の後ろに:

```tsx
function AbolitionBadge({ notice }: { notice: AbolitionNotice | null }) {
  if (!notice) return null;
  return (
    <span className="abolition-badge" title={`${notice.disclosedAt} ${notice.title}`}>
      廃止予告
    </span>
  );
}
```

判定列の`cell`で`<RsiBadge label={row.original.rsiLabel} />`の後ろに`<AbolitionBadge notice={row.original.abolitionNotice} />`を足す。`AbolitionNotice`を`../api/types`からtype importする。

- [ ] **Step 3: 詳細の警告**

`frontend/src/pages/YutaiDetailPage.tsx`で、タイトル行の`</div>`の直後(「逆日歩の判定」見出しの前)に:

```tsx
      {data.abolitionNotice && (
        <p className="abolition-notice" role="alert">
          {data.abolitionNotice.disclosedAt}に優待制度の廃止が開示されています(「{data.abolitionNotice.title}」)。
          最後の権利日を開示で確認してください。
        </p>
      )}
```

- [ ] **Step 4: イベント一覧のラベル**

`frontend/src/pages/YutaiTdnetEventsPage.tsx`:

```ts
const EVENT_TYPE_LABEL: Record<YutaiTdnetEventType, string> = {
  start: '開始',
  update: '変更',
  abolition: '廃止',
  'abolition-notice': '廃止予告',
};
```

`EVENT_TYPE_CLASS`に`'abolition-notice': 'event-badge--abolition-notice',`を足す。

- [ ] **Step 5: スタイル**

`frontend/src/index.css`の`.rsi-badge--low { … }`の後ろに:

```css
/* 廃止予告。次の権利日に優待が出ないかもしれないので、判定バッジと並べて目立たせる */
.abolition-badge {
  font-size: 0.72rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  margin-left: 0.35rem;
  display: inline-block;
  color: var(--caution);
  border: 1px solid currentColor;
  font-weight: 600;
}

.abolition-notice {
  margin: 0.5rem 0 1rem;
  padding: 0.6rem 0.9rem;
  border-radius: 8px;
  color: var(--caution);
  background: color-mix(in srgb, var(--caution) 12%, transparent);
  font-size: 0.9rem;
}
```

`.event-badge--abolition { … }`の後ろに:

```css
.event-badge--abolition-notice {
  color: var(--caution);
  background: color-mix(in srgb, var(--caution) 14%, transparent);
}
```

- [ ] **Step 6: フロントの検証**

Run: `cd frontend && npm run build && npm run lint`
Expected: ビルド成功、lintエラーなし

- [ ] **Step 7: README**

`README.md`で、優待マスタ/TDnetバッチの運用を説明している節(`grep -n "TDnet\|tdnet" README.md`で探す)に次を追記する。適切な節が無ければ、Cognitoユーザー操作の表の後ろに「### 優待の廃止予告」節を作る。

```markdown
### 優待の廃止予告

TDnetバッチは、優待制度そのものの廃止・終了の開示(タイトルに「株主優待」と「廃止」または「終了」を含み、
「一部」を含まないもの)を検知すると、kabuyutai.comにまだ載っている銘柄のマスタ行に`abolitionNotice`を記録する。
一覧に「廃止予告」バッジ、詳細に警告が出る。行がkabuyutai.comから消えて削除されるまで残る。

| 操作 | コマンド |
|---|---|
| 過去分の反映(確認) | `npx ts-node scripts/backfill-abolition-notice.ts` |
| 過去分の反映(書き込み) | `npx ts-node scripts/backfill-abolition-notice.ts --execute` |
| 誤検知を消す | `aws dynamodb update-item --table-name JQuantsYutaiMaster --key '{"ticker":{"S":"<コード>"}}' --update-expression "REMOVE abolitionNotice"` |
```

READMEにはユーザーの未コミット変更(Cognitoの「メールなしで発行」行)がある。**READMEはこのタスクのコミットに含めない**。フロントの変更だけをコミットし、README の追記は作業ツリーに残したまま、完了報告で「README に追記した(ユーザーの変更と合わせて未コミット)」と伝える。

- [ ] **Step 8: コミット**

```bash
git add frontend/src/api/types.ts frontend/src/pages/YutaiListPage.tsx frontend/src/pages/YutaiDetailPage.tsx frontend/src/pages/YutaiTdnetEventsPage.tsx frontend/src/index.css
git commit -m "Show abolition notices on the yutai list, detail and TDnet events pages" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 全体確認と設計書の整合

**Files:**
- Modify: `docs/superpowers/specs/2026-11-12-yutai-change-apply-design.md`(バックフィルのフラグ名)

- [ ] **Step 1: 設計書のフラグ名を実装に合わせる**

設計書の「過去分のバックフィル」節とリリース手順で`--apply`となっている箇所を、既存スクリプトの慣例に合わせた`--execute`に直す。

- [ ] **Step 2: 全テスト**

Run: `npx jest`
Expected: 全件PASS

- [ ] **Step 3: CDK synth**

Run: `npx cdk synth --quiet`
Expected: エラーなし

- [ ] **Step 4: 本番データでdry-run(読み取りのみ)**

Run: `npx ts-node scripts/backfill-abolition-notice.ts`
Expected: 対象7銘柄前後(6574, 7743, 7475, 2612, 9223, 9246, 3297)が表示され、「ドライランです」で終わる。6577が含まれないこと。
(`--execute`は付けない。認証情報が無くて失敗した場合は、その旨を報告する。)

- [ ] **Step 5: コミット**

```bash
git add docs/superpowers/specs/2026-11-12-yutai-change-apply-design.md
git commit -m "Align the yutai change apply spec with the backfill script flag" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
