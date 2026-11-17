# 月末以外の権利確定日(20日・15日)対応 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** kabuyutai.comで権利確定日が「（20日）」「（15日）」と書かれた銘柄を優待マスタに取り込み、権利付き最終日をその日付から計算する。

**Architecture:** 優待マスタに`rightsDay: number | null`(nullは月末)を保存し、`rightsDateForMonth`/`nextRightsDate`に必須引数として渡す。読み込み・保存(Task 1)と、計算・読み手への受け渡し(Task 2)に分ける。

**Tech Stack:** TypeScript, AWS Lambda (Node 22), DynamoDB DocumentClient, Jest + ts-jest

**Spec:** `docs/superpowers/specs/2026-11-17-yutai-rights-day-design.md`

## Global Constraints

- `rightsDay`の意味: 権利確定日の日付(1〜31の整数)。`null`は月末。DynamoDBの属性名は`rightsDay`。
- 権利確定日 = その月の`rightsDay`日以前の最後の営業日(`null`ならその月の最後の営業日)。権利付き最終日 = 権利確定日の2営業日前。
- 読む側は欠損・`null`・1〜31の整数以外をすべて`null`(月末)として扱う。データ移行はしない。
- コメント・ログ・テスト名の言語は周囲の既存コードに合わせる(コメントは日本語)。
- テストは`npx jest test/<file>.test.ts`で個別に流す。全体の`npm test`は16〜20分かかるので、タスク内では関係するテストファイルと`npx tsc --noEmit`だけを流す。
- git worktreeは使わない。現在のブランチ`feature/yutai-rights-day`にコミットする。
- コミットメッセージの末尾に`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`を付ける。

---

### Task 1: 権利確定日の読み込みと保存

**Files:**
- Modify: `lambda/shared/kabuyutai-client.ts`(`KabuyutaiEntry`, `parseListPage`)
- Modify: `lambda/yutai-master-sync-batch/index.ts`(UpdateCommand)
- Modify: `lambda/yutai-tdnet-watch-batch/index.ts:188-202`(UpdateCommand)
- Modify: `README.md`(`JQuantsYutaiMaster`の表の行、line 70付近)
- Test: `test/kabuyutai-client.test.ts`, `test/yutai-master-sync-batch.test.ts`, `test/yutai-tdnet-watch-batch.test.ts`

**Interfaces:**
- Produces: `KabuyutaiEntry.rightsDay: number | null`。DynamoDB `JQuantsYutaiMaster`の属性`rightsDay`(number または null)。

実際のHTML(kabuyutai.com、アスクル):

```html
<p>【権利確定月】<span class="tousi_price">5月・11月<span class="red-bold">（20日）</span></span></p>
```

括弧は全角`（` `）`。月末の銘柄は従来どおり`<span class="tousi_price">2月・8月</span>`。

- [ ] **Step 1: parseListPageの失敗するテストを書く**

`test/kabuyutai-client.test.ts`の`describe('parseListPage', ...)`に追加する。既存テストのブロック形式(`<!-- ▼ランキング_ブロック -->`〜`<!-- ▲ランキング_ブロック -->`、`<p><a href="..." class="kigyoumei">名前</a>（コード）</p>`、`<p>【優待内容】...</p>`)を流用する。

```ts
function block(ticker: string, name: string, monthsHtml: string): string {
  return (
    '<!-- ▼ランキング_ブロック --><div class="table_tr">' +
    `<p><a href="https://www.kabuyutai.com/kobetu/${ticker}.html" class="kigyoumei">${name}</a>（${ticker}）</p>` +
    '<p>【優待内容】QUOカード（500円相当～）</p>' +
    `<p>【権利確定月】<span class="tousi_price">${monthsHtml}</span></p>` +
    '</div><!-- ▲ランキング_ブロック -->'
  );
}

test('月末の銘柄はrightsDay: null', () => {
  const [entry] = parseListPage(block('1111', '月末企業', '2月・8月'));
  expect(entry.rightsMonths).toEqual([2, 8]);
  expect(entry.rightsDay).toBeNull();
});

test('（20日）が付いた銘柄はrightsDay: 20で、月も読める', () => {
  const [entry] = parseListPage(block('2678', 'アスクル', '5月・11月<span class="red-bold">（20日）</span>'));
  expect(entry.ticker).toBe('2678');
  expect(entry.rightsMonths).toEqual([5, 11]);
  expect(entry.rightsDay).toBe(20);
});

test('（15日）が付いた銘柄はrightsDay: 15', () => {
  const [entry] = parseListPage(block('2664', 'カワチ薬品', '3月・9月<span class="red-bold">（15日）</span>'));
  expect(entry.rightsMonths).toEqual([3, 9]);
  expect(entry.rightsDay).toBe(15);
});

test('内側のspanが（N日）の形でなければ飛ばして警告する', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const entries = parseListPage(block('3333', '想定外企業', '6月<span class="red-bold">（末日以外）</span>'));
  expect(entries).toEqual([]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('3333'));
  warn.mockRestore();
});

test('権利確定月が読めないブロックは飛ばして、銘柄コード付きで警告する', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const html =
    '<!-- ▼ランキング_ブロック --><div class="table_tr">' +
    '<p><a href="x" class="kigyoumei">壊れ企業</a>（4444）</p><p>【優待内容】QUOカード（500円相当～）</p>' +
    '</div><!-- ▲ランキング_ブロック -->';
  expect(parseListPage(html)).toEqual([]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('4444'));
  warn.mockRestore();
});
```

既存テストで`toEqual`によりentry全体を比較しているものがあれば、`rightsDay: null`を期待値に足す。既存の「企業名も権利確定月も無い壊れたブロック」のテストは、警告が出ても通るようにする(必要なら`console.warn`をspyで黙らせる)。

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `npx jest test/kabuyutai-client.test.ts`
Expected: 新しいテストがFAIL(`rightsDay`が無い・20日の銘柄が飛ばされる)

- [ ] **Step 3: parseListPageを実装する**

`lambda/shared/kabuyutai-client.ts`:

```ts
export interface KabuyutaiEntry {
  ticker: string;
  companyName: string;
  content: string;
  rightsMonths: number[];
  // 権利確定日の日付。一覧ページで「5月・11月（20日）」のように書かれた銘柄だけが持つ。
  // nullは月末(書かれていない銘柄)。
  rightsDay: number | null;
  // ...既存のvalue / minInvestment / detailUrl / listBadgeはそのまま
}
```

権利確定月の読み取りを関数に分ける:

```ts
// 【権利確定月】の中身を読む。月末以外の銘柄は
// `5月・11月<span class="red-bold">（20日）</span>`のように内側のspanで日付が付く。
// 内側のspanが（N日）の形でないときは、権利日が分からないまま月末扱いにしないよう
// 'unparsable'を返す。
type RightsSchedule = { rightsMonths: number[]; rightsDay: number | null };

function parseRightsSchedule(block: string): RightsSchedule | 'missing' | 'unparsable' {
  const match = block.match(
    /【権利確定月】<span class="tousi_price">([^<]+)(?:<span class="red-bold">([^<]*)<\/span>)?<\/span>/,
  );
  if (!match) return 'missing';
  const rightsMonths = parseRightsMonths(match[1]);
  if (match[2] === undefined) return { rightsMonths, rightsDay: null };
  const dayMatch = match[2].trim().match(/^（(\d{1,2})日）$/);
  const day = dayMatch ? Number(dayMatch[1]) : NaN;
  if (!Number.isInteger(day) || day < 1 || day > 31) return 'unparsable';
  return { rightsMonths, rightsDay: day };
}
```

`parseListPage`のループ:

```ts
for (const block of splitBlocks(html)) {
  const nameMatch = block.match(/<p><a href="([^"]+)" class="kigyoumei">([^<]+)<\/a>（(\d{4})）<\/p>/);
  const contentMatch = block.match(/【優待内容】([^<]+)/);
  const schedule = parseRightsSchedule(block);
  if (!nameMatch || !contentMatch || typeof schedule === 'string') {
    // 読めないブロックを黙って飛ばすと、今回の20日締めの銘柄のように気づかないまま
    // マスタから漏れるため、理由と(読めていれば)銘柄コードをログに残す。
    const ticker = block.match(/class="kigyoumei">[^<]*<\/a>（(\d{4})）/)?.[1] ?? 'unknown';
    const reason = !nameMatch
      ? 'company name'
      : !contentMatch
        ? 'yutai content'
        : schedule === 'unparsable'
          ? 'rights day'
          : 'rights months';
    console.warn(`parseListPage: could not parse ${reason} for ticker ${ticker}; skipping`);
    continue;
  }
  // ...entries.pushにrightsMonths: schedule.rightsMonths, rightsDay: schedule.rightsDayを渡す
}
```

`monthsMatch`の変数と旧正規表現は削除する。

- [ ] **Step 4: テストが通ることを確かめる**

Run: `npx jest test/kabuyutai-client.test.ts`
Expected: PASS

- [ ] **Step 5: 書き込み側の失敗するテストを書く**

`test/yutai-master-sync-batch.test.ts`: 既存の1件目のテストのentryに`rightsDay: null`を足し、`ExpressionAttributeValues`の期待値に`':rightsDay': null`を足す。新しいテストを追加:

```ts
test('writes rightsDay for an entry whose rights date is not month-end', async () => {
  mockFetchAllListings.mockResolvedValueOnce([
    { ticker: '2678', companyName: 'アスクル', content: 'カタログ（3,000円相当～）', rightsMonths: [5, 11], rightsDay: 20, value: 3000, minInvestment: 150000 },
  ]);
  mockSend.mockResolvedValue({});

  await handler();

  const command = mockSend.mock.calls[0][0];
  expect(command.input?.UpdateExpression ?? command.UpdateExpression).toContain('rightsDay = :rightsDay');
  expect(command).toMatchObject({ ExpressionAttributeValues: { ':rightsMonths': [5, 11], ':rightsDay': 20 } });
});
```

(既存テストが`mock.calls[0][0]`に対して`toMatchObject({ TableName, Key, ExpressionAttributeValues })`をかけている形に合わせる。モックの`UpdateCommand`がinputをそのまま返す作りなら`command.UpdateExpression`で読める。既存テストのモック方法を見て、どちらか一方に揃える。)

`test/yutai-tdnet-watch-batch.test.ts`: `findTicker`のモックが返すentryに`rightsDay: 20`を持たせたテストを1件足し、UpdateCommandの`ExpressionAttributeValues`に`':rightsDay': 20`、`UpdateExpression`に`rightsDay = :rightsDay`が入ることを確かめる。既存テストのentryには`rightsDay: null`を足し(型エラー防止)、`ExpressionAttributeValues`を完全一致で見ているテストがあれば`':rightsDay': null`を足す。

- [ ] **Step 6: テストが失敗することを確かめる**

Run: `npx jest test/yutai-master-sync-batch.test.ts test/yutai-tdnet-watch-batch.test.ts`
Expected: 新しいテストがFAIL

- [ ] **Step 7: 両バッチに書き込みを足す**

`lambda/yutai-master-sync-batch/index.ts`と`lambda/yutai-tdnet-watch-batch/index.ts`の`UpdateExpression`の`rightsMonths = :rightsMonths`の直後に`, rightsDay = :rightsDay`を足し、`ExpressionAttributeValues`に`':rightsDay': entry.rightsDay`を足す(月末はnullで上書きする。20日から月末に戻った銘柄の古い値を残さないため)。

- [ ] **Step 8: テストと型チェック**

Run: `npx jest test/kabuyutai-client.test.ts test/yutai-master-sync-batch.test.ts test/yutai-tdnet-watch-batch.test.ts && npx tsc --noEmit`
Expected: PASS、型エラーなし

- [ ] **Step 9: READMEを更新する**

`README.md`の`JQuantsYutaiMaster`の行(line 70付近)の`rightsMonths`〔…〕の直後に次を足す:

```
/ `rightsDay`〔権利確定日の日付。kabuyutai.comで「5月・11月（20日）」のように書かれた月末以外の銘柄だけが持ち、`null`・欠損は月末〕
```

- [ ] **Step 10: コミット**

```bash
git add lambda/shared/kabuyutai-client.ts lambda/yutai-master-sync-batch/index.ts lambda/yutai-tdnet-watch-batch/index.ts README.md test/kabuyutai-client.test.ts test/yutai-master-sync-batch.test.ts test/yutai-tdnet-watch-batch.test.ts
git commit -m "Read and store the rights day for yutai listed with a non-month-end date

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: rightsDayを使った権利付き最終日の計算と読み手への受け渡し

**Files:**
- Modify: `lambda/shared/trading-calendar.ts:148-191`
- Modify: `lambda/reference-api/index.ts`(`YutaiMasterRow`, `toYutaiMasterRow`, `YUTAI_LIST_PROJECTION`, line 312と394の`nextRightsDate`)
- Modify: `lambda/shared/yutai-forecast-detail.ts:160-235`
- Modify: `lambda/gyakuhibu-forecast-batch/index.ts`(`MasterRow`, `scanYutaiMaster`, line 181)
- Modify: `lambda/yutai-risk-precompute-batch/index.ts`(`MasterRow`, ProjectionExpression line 43, line 183)
- Modify: `lambda/gyakuhibu-history-batch/index.ts`(`MasterRow`, `scanYutaiMaster`, `pastRightsDateCandidates`)
- Modify: `README.md`(line 25, 109, 152付近の`rightsDateForMonth`の説明)
- Test: `test/trading-calendar.test.ts`, `test/reference-api.test.ts`, `test/yutai-forecast-detail.test.ts`, `test/gyakuhibu-forecast-batch.test.ts`, `test/yutai-risk-precompute-batch.test.ts`, `test/gyakuhibu-history-batch.test.ts`

**Interfaces:**
- Consumes: DynamoDB `JQuantsYutaiMaster.rightsDay`(Task 1。number・null・欠損のいずれか)
- Produces:
  - `rightsDateForMonth(calendar: CalendarDay[], year: number, month: number, rightsDay: number | null): string | undefined`
  - `nextRightsDate(rightsMonths: number[], rightsDay: number | null, today?: string): string | undefined`
  - `toRightsDay(value: unknown): number | null`

`rightsDay`は**必須引数**にする(省略可能にすると、渡し忘れた呼び出し元が黙って月末で計算する)。`tsc`が呼び出し元の渡し忘れをすべて見つける。

- [ ] **Step 1: trading-calendarの失敗するテストを書く**

`test/trading-calendar.test.ts`の既存呼び出しを新しい引数順に直す: `rightsDateForMonth(calendar, 2026, 8)` → `rightsDateForMonth(calendar, 2026, 8, null)`、`nextRightsDate([])` → `nextRightsDate([], null)`、`nextRightsDate([10], '2026-10-28')` → `nextRightsDate([10], null, '2026-10-28')`など。importに`toRightsDay`を足す。次を追加:

```ts
describe('rightsDateForMonth with rightsDay', () => {
  test('20日が平日(2026-05-20水) -> 2026-05-18', () => {
    const calendar = getLocalTradingCalendar('2026-05-01', '2026-05-31');
    expect(rightsDateForMonth(calendar, 2026, 5, 20)).toBe('2026-05-18');
  });

  test('20日が日曜(2026-09-20)なら直前の営業日9/18が権利確定日 -> 2026-09-16', () => {
    const calendar = getLocalTradingCalendar('2026-09-01', '2026-09-30');
    expect(rightsDateForMonth(calendar, 2026, 9, 20)).toBe('2026-09-16');
  });

  test('20日が祝日(2026-03-20春分の日)なら3/19が権利確定日 -> 2026-03-17', () => {
    const calendar = getLocalTradingCalendar('2026-03-01', '2026-03-31');
    expect(rightsDateForMonth(calendar, 2026, 3, 20)).toBe('2026-03-17');
  });

  test('15日(2026-05-15金) -> 2026-05-13', () => {
    const calendar = getLocalTradingCalendar('2026-05-01', '2026-05-31');
    expect(rightsDateForMonth(calendar, 2026, 5, 15)).toBe('2026-05-13');
  });

  test('taisyaku.jpの実績がある日付と一致する(2678: 2025-11-18, 2025-05-16 / 8227: 2026-02-18)', () => {
    const calendar = getLocalTradingCalendar('2025-01-01', '2026-12-31');
    expect(rightsDateForMonth(calendar, 2025, 11, 20)).toBe('2025-11-18');
    expect(rightsDateForMonth(calendar, 2025, 5, 20)).toBe('2025-05-16');
    expect(rightsDateForMonth(calendar, 2026, 2, 20)).toBe('2026-02-18');
  });

  test('nullは月末(従来どおり)', () => {
    const calendar = getLocalTradingCalendar('2026-08-01', '2026-08-31');
    expect(rightsDateForMonth(calendar, 2026, 8, null)).toBe('2026-08-27');
  });
});

describe('nextRightsDate with rightsDay', () => {
  test('20日締めの5月・11月で、11/17時点の次の権利付き最終日は2026-11-18', () => {
    expect(nextRightsDate([5, 11], 20, '2026-11-17')).toBe('2026-11-18');
  });

  test('11/19時点では翌年5月の2027-05-18', () => {
    expect(nextRightsDate([5, 11], 20, '2026-11-19')).toBe('2027-05-18');
  });
});

describe('toRightsDay', () => {
  test.each([
    [20, 20],
    [15, 15],
    [1, 1],
    [31, 31],
    [null, null],
    [undefined, null],
    [0, null],
    [32, null],
    [20.5, null],
    ['20', null],
  ])('toRightsDay(%p) -> %p', (input, expected) => {
    expect(toRightsDay(input)).toBe(expected);
  });
});
```

(2026-11-20は金曜なので権利確定日11/20、2営業日前は11/18水。2027-05-20は木曜なので2営業日前は5/18火。実装後にテストが通らなければ、カレンダーで曜日を確かめてから期待値を直すこと。期待値をむやみに実装に合わせない。)

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `npx jest test/trading-calendar.test.ts`
Expected: FAIL(`toRightsDay`が無い、20日の計算が月末になる)

- [ ] **Step 3: trading-calendarを実装する**

```ts
// year年month月の権利確定日から2営業日前(権利付き最終日T)を返す。権利確定日は、
// rightsDayがあればその日以前の最後の営業日(20日締めの銘柄で20日が土日祝なら前の営業日)、
// nullならその月の最後の営業日。calendarにその月の該当営業日が1件も含まれない場合はundefined。
// 優待マスタのrightsMonths(権利確定月)・rightsDay(権利確定日)から実際の権利付き最終日を
// 都度計算するために使う(JQuantsYutaiRightsDateテーブル廃止に伴う)。
export function rightsDateForMonth(
  calendar: CalendarDay[],
  year: number,
  month: number,
  rightsDay: number | null,
): string | undefined {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const tradingDays = calendar.filter(isTradingDay).map((d) => d.date).sort();
  const lastAllowed = rightsDay === null ? `${prefix}-31` : `${prefix}-${String(rightsDay).padStart(2, '0')}`;
  const monthTradingDays = tradingDays.filter((d) => d.startsWith(prefix) && d <= lastAllowed);
  const record = monthTradingDays[monthTradingDays.length - 1];
  if (!record) return undefined;
  const idx = tradingDays.indexOf(record);
  return idx >= 2 ? tradingDays[idx - 2] : undefined;
}

// DynamoDBの優待マスタ行のrightsDayを読む。1〜31の整数以外(欠損・null・不正値)は
// すべてnull(月末)として扱う(rightsDayを持たない既存行は月末の銘柄)。
export function toRightsDay(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 31 ? value : null;
}
```

`nextRightsDate`は`(rightsMonths: number[], rightsDay: number | null, today: string = todayJst())`にし、ループ内を`rightsDateForMonth(calendar, y, month, rightsDay)`にする。上のコメントも「rightsMonthsの各月について、今年・来年の権利確定日(rightsDay、nullなら月末)から2営業日前…」に直す。

- [ ] **Step 4: テストが通ることを確かめる**

Run: `npx jest test/trading-calendar.test.ts`
Expected: PASS

- [ ] **Step 5: 呼び出し元を直す(型チェックで漏れを見つける)**

Run: `npx tsc --noEmit` — 呼び出し元すべてが引数不足でエラーになる。それぞれ次のように直す:

- `lambda/reference-api/index.ts`:
  - `YutaiMasterRow`の`rightsMonths`の下に`rightsDay: number | null;`。
  - `toYutaiMasterRow`に`rightsDay: toRightsDay(item.rightsDay),`。
  - `YUTAI_LIST_PROJECTION`の`rightsMonths, `の後に`rightsDay, `を足す(足し忘れると一覧では黙って月末になる)。
  - `nextRightsDate(row.rightsMonths)` → `nextRightsDate(row.rightsMonths, row.rightsDay)`、`nextRightsDate(master.rightsMonths)` → `nextRightsDate(master.rightsMonths, master.rightsDay)`。
- `lambda/shared/yutai-forecast-detail.ts`: `master`に`rightsDay: toRightsDay(masterItem.rightsDay),`を足し、`nextRightsDate(master.rightsMonths, master.rightsDay)`。
- `lambda/gyakuhibu-forecast-batch/index.ts`: `MasterRow`に`rightsDay: number | null;`、`scanYutaiMaster`で`rightsDay: toRightsDay(item.rightsDay),`、`nextRightsDate(row.rightsMonths, row.rightsDay)`。
- `lambda/yutai-risk-precompute-batch/index.ts`: `MasterRow`に`rightsDay: number | null;`、ProjectionExpressionを`'ticker, unitShares, requiredShares, rightsMonths, rightsDay, marginName'`に(コメントの「5項目」を「6項目」に)、`rightsDay: toRightsDay(item.rightsDay),`、`nextRightsDate(row.rightsMonths, row.rightsDay)`。
- `lambda/gyakuhibu-history-batch/index.ts`: `MasterRow`に`rightsDay: number | null;`、`scanYutaiMaster`の`rows.push`に`rightsDay: toRightsDay(item.rightsDay)`、`pastRightsDateCandidates`で`rightsDateForMonth(calendar, year, month, row.rightsDay)`。

`toRightsDay`はそれぞれ`../shared/trading-calendar`(共有モジュールからは`./trading-calendar`)からimportする。

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 6: 読み手のテストを書く**

それぞれ既存テストのモックの流儀(`mockSend.mockResolvedValueOnce`の順番)に合わせて1件ずつ追加する。今日の日付に依存しないよう、期待値はテスト内で`nextRightsDate`/`rightsDateForMonth`を呼んで作り、月末の値と違うことも確かめる:

```ts
const expected = nextRightsDate([5, 11], 20);
expect(expected).not.toBe(nextRightsDate([5, 11], null));
// ...ハンドラ/関数の結果のrightsDate(またはnextRightsDate引数として使われた値)がexpectedと一致すること
```

- `test/reference-api.test.ts`: 一覧(`GET /yutai/forecast`)で、master行`{ ..., rightsMonths: [5, 11], rightsDay: 20 }`の`rightsDate`が`expected`になること。Scanの`ProjectionExpression`に`rightsDay`が含まれること。詳細(`GET /yutai/{ticker}`)でも`rightsDate`が`expected`になること。
- `test/yutai-forecast-detail.test.ts`: master行に`rightsDay: 20`を持たせ、`detail.rightsDate`が`expected`になること。
- `test/gyakuhibu-forecast-batch.test.ts`: master行に`rightsDay: 20`を持たせ、予測テーブルに書く行の`nextRightsDate`(または既存テストが見ている権利日の項目)が`expected`になること。
- `test/yutai-risk-precompute-batch.test.ts`: Scanの`ProjectionExpression`に`rightsDay`が含まれること。master行に`rightsDay: 20`を持たせ、権利日を使って書く値(既存テストが見ている項目。例えば`sameMonthLastYearGyakuhibu`の対象月の決定や`rightsDate`)が20日基準になることを、既存テストの見方に合わせて確かめる。直接確かめられる項目が無ければProjectionの確認だけでよい。
- `test/gyakuhibu-history-batch.test.ts`: master行`{ ticker: '2678', unitShares: 100, rightsMonths: [5, 11], rightsDay: 20 }`で、`JQuantsGyakuhibuActual`への`GetCommand`のKeyに`rightsDate: '2025-11-18'`が含まれ、月末基準の`'2025-11-26'`が含まれないこと(2025-11の最終営業日は11/28金、その2営業日前が11/26)。`MAX_FETCHES_PER_RUN`などの上限で候補が切られないよう、既存テストのモック設定に合わせる。

- [ ] **Step 7: テストを流す**

Run: `npx jest test/trading-calendar.test.ts test/reference-api.test.ts test/yutai-forecast-detail.test.ts test/gyakuhibu-forecast-batch.test.ts test/yutai-risk-precompute-batch.test.ts test/gyakuhibu-history-batch.test.ts test/mcp-server.test.ts && npx tsc --noEmit`
Expected: PASS、型エラーなし

- [ ] **Step 8: READMEを更新する**

`README.md`のline 25・109・152付近で`rightsMonths`から権利日を計算すると書いている箇所を、「`rightsMonths`(権利確定月)と`rightsDay`(権利確定日、`null`は月末)から」に直す。

- [ ] **Step 9: コミット**

```bash
git add lambda/shared/trading-calendar.ts lambda/reference-api/index.ts lambda/shared/yutai-forecast-detail.ts lambda/gyakuhibu-forecast-batch/index.ts lambda/yutai-risk-precompute-batch/index.ts lambda/gyakuhibu-history-batch/index.ts README.md test/
git commit -m "Compute rights dates from the stored rights day instead of assuming month-end

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
