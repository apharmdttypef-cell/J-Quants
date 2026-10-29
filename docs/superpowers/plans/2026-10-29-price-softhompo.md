# 株価のSoftHompo移行・財務サマリー廃止 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 株価の取得元をJ-Quantsから SoftHompo の日次株価CSVに切り替え、財務サマリーを取得・API・表示ともに廃止して、J-Quantsを呼ぶ処理を無くす。

**Architecture:** `lambda/price-batch/softhompo.ts`(新規)がzipの取得・展開とCSVの解析を担い、`lambda/price-batch/index.ts`がそれを使って直近7日分を`JQuantsStockPrices`へ書く(テーブルの形と読む側は変えない)。財務バッチ・J-Quants共通クライアント・APIキーのシークレット・`/tickers/{ticker}/summary`・画面の財務表示を削除する。

**Tech Stack:** AWS CDK (TypeScript), Lambda NodejsFunction (Node 22), DynamoDB DocumentClient, EventBridge, CloudWatch Alarm, Jest + ts-jest, `fflate`(zip展開), Vite + React(frontend)

設計書: `docs/superpowers/specs/2026-10-29-price-softhompo-design.md`

## Global Constraints

- 書き先の`JQuantsStockPrices`の行の形は変えない: `ticker`, `date`(`YYYY-MM-DD`), `open`, `high`, `low`, `close`, `volume`, `updated_at`
- 読む側(`yutai-risk-precompute-batch`、`gyakuhibu-forecast-validation`、`reference-api`の株価部分)は変更しない
- 株価バッチの実行は平日 09:30 JST = `cron(30 0 ? * MON-FRI *)`。直近7日分の日付を毎回取り直す
- 対象は優待マスタ(`JQuantsYutaiMaster`)の銘柄だけ
- 値の変換: `open`=午前の始値(無ければ午後の始値)、`high`=午前・午後の高値の大きい方、`low`=午前・午後の安値の小さい方、`close`=午後の終値(無ければ午前の終値)、`volume`=売買高(千株)×1000を整数に丸めた値。終日取引なし(午前・午後とも終値なし)の行は書かない
- 取引の無かった場の値はCSV上`"－"`(全角ハイフン U+FF0D)
- 財務テーブル`JQuantsFinancialSummary`はスタックに残す(`RemovalPolicy.RETAIN`のまま)。削除しない
- J-QuantsのAPIキー(シークレット`JQuantsApiKey`)はスタックから削除する
- アラームは信用残バッチと同じ形: `Errors`、`period` 1日、`Sum`、閾値1以上、評価2期間・2回、欠測は正常、SNS `JQuantsBatchAlarmTopic`へ。説明「株価バッチ(SoftHompo)が2日連続で失敗」
- git worktreeは使わない。ブランチ`feature/price-softhompo`上で作業する
- コメントは既存コードと同じく日本語で、密度も周囲に合わせる
- コミットメッセージの末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける
- `README.md`には別作業の未コミット変更(Cognitoの「メールなしで発行」の行)がある。`git add README.md`で巻き込まないこと(README以外のタスクでは`README.md`をステージしない。Task 6では`git add -p`で自分の変更だけをステージする)

---

## File Structure

- Create: `lambda/price-batch/softhompo.ts` — SoftHompoのCSV解析(`parseSoftHompoCsv`)とzipの取得・展開(`fetchSoftHompoDay`)
- Create: `test/fixtures/softhompo/stq_20261028.csv` — 実ファイル(2026-10-28分)から切り出したフィクスチャ
- Create: `test/softhompo.test.ts` — 上の2関数のテスト
- Rewrite: `lambda/price-batch/index.ts` — SoftHompoから直近7日分を書く
- Rewrite: `test/price-batch.test.ts`
- Delete: `lambda/financial-summary-batch/index.ts`、`test/financial-summary-batch.test.ts`
- Delete: `lambda/shared/jquants-batch-client.ts`、`test/jquants-batch-client.test.ts`
- Modify: `lambda/reference-api/index.ts`、`test/reference-api.test.ts`
- Modify: `lib/j-quants-stack.ts`、`test/j-quants.test.ts`
- Modify: `frontend/src/pages/TickerDetailPage.tsx`、`frontend/src/pages/YutaiDetailPage.tsx`、`frontend/src/api/client.ts`、`frontend/src/api/types.ts`
- Modify: `README.md`
- Modify: `package.json` / `package-lock.json`(`fflate`を追加)

---

### Task 1: SoftHompo CSVの解析

**Files:**
- Create: `lambda/price-batch/softhompo.ts`
- Create: `test/fixtures/softhompo/stq_20261028.csv`
- Create: `test/softhompo.test.ts`

**Interfaces:**
- Produces:
  - `export interface SoftHompoBar { open: number; high: number; low: number; close: number; volume: number | null }`
  - `export const SOFTHOMPO_CSV_HEADER: readonly string[]`
  - `export class SoftHompoCsvFormatError extends Error {}`
  - `export function parseSoftHompoCsv(csvText: string): Map<string, SoftHompoBar>` — キーは銘柄コード(`'2301'`、`'256A'`のような英字入りもそのまま)

CSVの実際の形(2026-10-28分の実ファイルで確認済み):
- UTF-8、先頭にBOM(`﻿`)。改行はCRLF。
- `"!`で始まる行はコメント。1行目`"!株価データ",`、2行目は午前/午後の区切り、3行目が見出し(`"! コード"`で始まる)、以降に`"! 2026年10月28日(水曜日)","","","1-1",`のようなページ見出しが途中に何度も出る。
- データ行は17列+末尾のカンマ(split すると18要素で最後が空)。数値はクォート無し、取引の無い値は`"－"`。値の中にカンマは無い。
- 2列目のフラグは通常`""`だが、`"#"`の行もある(普通に読む)。

- [ ] **Step 1: フィクスチャを作る**

`test/fixtures/softhompo/stq_20261028.csv`を、以下の内容そのままで作る(BOMは付けない。BOMの扱いはテスト側で先頭に付けて確かめる)。行は実ファイルからの抜粋。

```
"!株価データ",
"!","","","","午前","","","","午後","","","","","","","","",
"! コード","フラグ","売買単位","銘柄名","始値(円)","高値(円)","安値(円)","終値(円)","始値(円)","高値(円)","安値(円)","終値(円)","最終気配(円)","前日比(円)","売買高加重平均価格(円)","売買高(千株)","売買代金(千円)",
"! 2026年10月28日(水曜日)","","","1-1",
"1301","",100,"極洋",4550,4560,4475,4475,4475,4485,4440,4440,"－",-115,4491.7799,73.6,330595,
"2301","",100,"学情",1694,1700,1688,1692,1691,1691,1672,1673,"－",-22,1686.2936,553.5,933363.5,
"1793","",100,"大本組",2043,2063,2022,2063,"－","－","－","－","－",31,2043.1429,0.7,1430.2,
"1787","",100,"ナカボーテック","－","－","－","－",5500,5500,5500,5500,"－","－",5500,0.1,550,
"1788","",100,"三東工業","－","－","－","－","－","－","－","－","－","－","－","－","－",
"! 2026年10月28日(水曜日)","","","1-2",
"256A","",100,"飛島ＨＤ",2228,2240,2215,2219,2220,2226,2211,2211,"－",-22,2221.2929,115.4,256337.2,
"3469","#",100,"デュアルタップ",844,855,844,855,844,845,844,845,"－","－",847.1538,1.3,1101.3,
```

- [ ] **Step 2: 失敗するテストを書く**

`test/softhompo.test.ts`:

```ts
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseSoftHompoCsv, SoftHompoCsvFormatError } from '../lambda/price-batch/softhompo';

const fixture = readFileSync(join(__dirname, 'fixtures', 'softhompo', 'stq_20261028.csv'), 'utf8');

describe('parseSoftHompoCsv', () => {
  test('reads a row traded in both sessions: open from the morning, close from the afternoon, high/low across both', () => {
    const bars = parseSoftHompoCsv(fixture);
    expect(bars.get('2301')).toEqual({ open: 1694, high: 1700, low: 1672, close: 1673, volume: 553500 });
  });

  test('uses the morning values when there was no afternoon trade', () => {
    const bars = parseSoftHompoCsv(fixture);
    expect(bars.get('1793')).toEqual({ open: 2043, high: 2063, low: 2022, close: 2063, volume: 700 });
  });

  test('uses the afternoon values when there was no morning trade', () => {
    const bars = parseSoftHompoCsv(fixture);
    expect(bars.get('1787')).toEqual({ open: 5500, high: 5500, low: 5500, close: 5500, volume: 100 });
  });

  test('leaves out a row with no trade all day', () => {
    const bars = parseSoftHompoCsv(fixture);
    expect(bars.has('1788')).toBe(false);
  });

  test('keeps alphanumeric codes, flagged rows, and rows after a repeated page heading', () => {
    const bars = parseSoftHompoCsv(fixture);
    expect(bars.get('256A')).toEqual({ open: 2228, high: 2240, low: 2211, close: 2211, volume: 115400 });
    expect(bars.get('3469')).toEqual({ open: 844, high: 855, low: 844, close: 845, volume: 1300 });
    expect([...bars.keys()].sort()).toEqual(['1301', '1787', '1793', '2301', '256A', '3469']);
  });

  test('handles a leading BOM and CRLF line endings', () => {
    const bars = parseSoftHompoCsv('﻿' + fixture.replace(/\r?\n/g, '\r\n'));
    expect(bars.get('2301')?.close).toBe(1673);
    expect(bars.size).toBe(6);
  });

  test('throws when the heading row is missing', () => {
    const withoutHeader = fixture
      .split('\n')
      .filter((line) => !line.startsWith('"! コード"'))
      .join('\n');
    expect(() => parseSoftHompoCsv(withoutHeader)).toThrow(SoftHompoCsvFormatError);
  });

  test('throws when a heading column changes', () => {
    expect(() => parseSoftHompoCsv(fixture.replace('"売買高(千株)"', '"出来高(千株)"'))).toThrow(SoftHompoCsvFormatError);
  });

  test('throws when a data row has an unexpected number of columns', () => {
    expect(() => parseSoftHompoCsv(fixture.replace('"2301","",100,', '"2301",100,'))).toThrow(SoftHompoCsvFormatError);
  });
});
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `npx jest test/softhompo.test.ts`
Expected: FAIL(`Cannot find module '../lambda/price-batch/softhompo'`)

- [ ] **Step 4: 実装する**

`lambda/price-batch/softhompo.ts`:

```ts
// SoftHompo(https://softhompo.a.la9.jp/Data/StockData.html)の日次株価データ。
// 東証「株式相場表」を加工したCSVで、1日1ファイルに東証の全銘柄が入っている。
// 前営業日分が翌営業日の朝に公表される。

export interface SoftHompoBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

// 見出し行(3行目)。午前・午後で「始値〜終値」の4列が2回並ぶ。
export const SOFTHOMPO_CSV_HEADER: readonly string[] = [
  '! コード',
  'フラグ',
  '売買単位',
  '銘柄名',
  '始値(円)',
  '高値(円)',
  '安値(円)',
  '終値(円)',
  '始値(円)',
  '高値(円)',
  '安値(円)',
  '終値(円)',
  '最終気配(円)',
  '前日比(円)',
  '売買高加重平均価格(円)',
  '売買高(千株)',
  '売買代金(千円)',
];

// 見出しや列数が想定と違う(仕様変更・エラーページなど)場合に投げる。バッチを失敗させて気づけるようにする。
export class SoftHompoCsvFormatError extends Error {}

// 値にカンマは含まれない(実ファイルで確認)。各行の末尾にカンマがあり、空の列が1つ付くので落とす。
function splitRow(line: string): string[] {
  const cols = line.split(',').map((col) => col.replace(/^"|"$/g, ''));
  if (cols[cols.length - 1] === '') cols.pop();
  return cols;
}

// 取引の無かった場の値は「－」(全角ハイフン)。
function toNumber(raw: string): number | null {
  if (raw === '' || raw === '－') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function maxOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function minOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

// 銘柄コード → 1日分の四本値と出来高。終日取引の無かった銘柄は含めない。
export function parseSoftHompoCsv(csvText: string): Map<string, SoftHompoBar> {
  const lines = csvText.replace(/^﻿/, '').split(/\r?\n/);

  const headerLine = lines.find((line) => line.startsWith('"! コード"'));
  if (headerLine === undefined) {
    throw new SoftHompoCsvFormatError('softhompo: heading row not found');
  }
  const header = splitRow(headerLine);
  if (
    header.length !== SOFTHOMPO_CSV_HEADER.length ||
    header.some((name, i) => name !== SOFTHOMPO_CSV_HEADER[i])
  ) {
    throw new SoftHompoCsvFormatError(`softhompo: unexpected heading row: ${headerLine}`);
  }

  const bars = new Map<string, SoftHompoBar>();
  for (const line of lines) {
    // 見出し・ページ見出しなどのコメント行は「"!」で始まる
    if (line === '' || line.startsWith('"!')) continue;

    const cols = splitRow(line);
    if (cols.length !== SOFTHOMPO_CSV_HEADER.length) {
      throw new SoftHompoCsvFormatError(`softhompo: expected ${SOFTHOMPO_CSV_HEADER.length} columns but got ${cols.length}: ${line}`);
    }

    const [amOpen, amHigh, amLow, amClose, pmOpen, pmHigh, pmLow, pmClose] = cols.slice(4, 12).map(toNumber);
    const close = pmClose ?? amClose;
    if (close === null) continue;

    const volumeThousands = toNumber(cols[15]);
    bars.set(cols[0], {
      open: (amOpen ?? pmOpen)!,
      high: maxOf(amHigh, pmHigh)!,
      low: minOf(amLow, pmLow)!,
      close,
      volume: volumeThousands === null ? null : Math.round(volumeThousands * 1000),
    });
  }
  return bars;
}
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `npx jest test/softhompo.test.ts`
Expected: PASS(9件)

- [ ] **Step 6: コミット**

```bash
git add lambda/price-batch/softhompo.ts test/softhompo.test.ts test/fixtures/softhompo/stq_20261028.csv
git commit -m "Parse the SoftHompo daily stock price CSV

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: SoftHompoのzipを取得・展開する

**Files:**
- Modify: `lambda/price-batch/softhompo.ts`
- Modify: `test/softhompo.test.ts`
- Modify: `package.json`、`package-lock.json`

**Interfaces:**
- Consumes: Task 1の`softhompo.ts`
- Produces:
  - `export type MonthlyArchiveCache = Map<string, Record<string, Uint8Array> | null>` — キーは`YYYYMM`。1回の実行で同じ月の月次ファイルを2回取らないためのキャッシュ(呼び出し側が実行ごとに`new Map()`を作って渡す)
  - `export async function fetchSoftHompoDay(date: string, monthlyCache: MonthlyArchiveCache): Promise<string | null>` — `date`は`YYYY-MM-DD`。CSVテキストを返す。ファイルが無ければ`null`

URLとファイルの事実(実機で確認済み):
- 日次: `https://softhompo.a.la9.jp/Data/stock/thisMonth/stq_YYYYMMDD.zip`(中身は`stq_YYYYMMDD.csv`の1件)。当月分のみ。休場日・未公表は404。
- 月次: `https://softhompo.a.la9.jp/Data/stock/pastMonth/YYYYMM.zip`(中身はその月の`stq_YYYYMMDD.csv`の集まり)。前月分は翌月第2営業日ごろに月次へ移り、同時に日次からは消える。当月分の月次ファイルは無い(404)。

- [ ] **Step 1: `fflate`を追加する**

Run: `npm install --save-dev fflate@0.8.2`
Expected: `package.json`の`devDependencies`に`"fflate": "^0.8.2"`が入る(他の依存と同じくdevDependenciesに置く。Lambdaはesbuildでバンドルされる)

- [ ] **Step 2: 失敗するテストを追加する**

`test/softhompo.test.ts`の先頭のimportを次に置き換え、ファイル末尾にテストを追加する。

```ts
import { readFileSync } from 'fs';
import { join } from 'path';
import { strToU8, zipSync } from 'fflate';
import {
  fetchSoftHompoDay,
  parseSoftHompoCsv,
  SoftHompoCsvFormatError,
  type MonthlyArchiveCache,
} from '../lambda/price-batch/softhompo';
```

```ts
describe('fetchSoftHompoDay', () => {
  const mockFetch = jest.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  function zipResponse(files: Record<string, string>) {
    const bytes = zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
    return {
      status: 200,
      ok: true,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }
  const notFound = { status: 404, ok: false, arrayBuffer: async () => new ArrayBuffer(0) };

  test('reads the daily zip first', async () => {
    mockFetch.mockResolvedValueOnce(zipResponse({ 'stq_20261028.csv': '﻿daily' }));

    const csv = await fetchSoftHompoDay('2026-10-28', new Map());

    expect(csv).toBe('daily');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://softhompo.a.la9.jp/Data/stock/thisMonth/stq_20261028.zip');
  });

  test('falls back to the monthly zip when the daily zip is gone', async () => {
    mockFetch
      .mockResolvedValueOnce(notFound)
      .mockResolvedValueOnce(zipResponse({ 'stq_20260930.csv': 'sep30', 'stq_20260929.csv': 'sep29' }));

    const csv = await fetchSoftHompoDay('2026-09-30', new Map());

    expect(csv).toBe('sep30');
    expect(mockFetch.mock.calls[1][0]).toBe('https://softhompo.a.la9.jp/Data/stock/pastMonth/202609.zip');
  });

  test('returns null when neither the daily nor the monthly zip has the day', async () => {
    mockFetch.mockResolvedValueOnce(notFound).mockResolvedValueOnce(notFound);

    expect(await fetchSoftHompoDay('2026-10-25', new Map())).toBeNull();
  });

  test('returns null when the monthly zip does not contain the day (a holiday)', async () => {
    mockFetch.mockResolvedValueOnce(notFound).mockResolvedValueOnce(zipResponse({ 'stq_20260930.csv': 'sep30' }));

    expect(await fetchSoftHompoDay('2026-09-27', new Map())).toBeNull();
  });

  test('fetches each monthly zip only once per run through the shared cache', async () => {
    const cache: MonthlyArchiveCache = new Map();
    mockFetch
      .mockResolvedValueOnce(notFound)
      .mockResolvedValueOnce(zipResponse({ 'stq_20260930.csv': 'sep30', 'stq_20260929.csv': 'sep29' }))
      .mockResolvedValueOnce(notFound);

    expect(await fetchSoftHompoDay('2026-09-30', cache)).toBe('sep30');
    expect(await fetchSoftHompoDay('2026-09-29', cache)).toBe('sep29');

    // 2日目は日次の404を確かめるだけで、月次ファイルは取り直さない
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[2][0]).toBe('https://softhompo.a.la9.jp/Data/stock/thisMonth/stq_20260929.zip');
  });

  test('throws on an HTTP error other than 404', async () => {
    mockFetch.mockResolvedValueOnce({ status: 503, ok: false, arrayBuffer: async () => new ArrayBuffer(0) });

    await expect(fetchSoftHompoDay('2026-10-28', new Map())).rejects.toThrow('503');
  });

  test('throws when the daily zip does not hold the expected file', async () => {
    mockFetch.mockResolvedValueOnce(zipResponse({ 'other.csv': 'x' }));

    await expect(fetchSoftHompoDay('2026-10-28', new Map())).rejects.toThrow('stq_20261028.csv');
  });
});
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `npx jest test/softhompo.test.ts`
Expected: FAIL(`fetchSoftHompoDay`が無い)

- [ ] **Step 4: 実装する**

`lambda/price-batch/softhompo.ts`の先頭(冒頭コメントの直後)にimportと定数を足し、ファイル末尾に関数を追加する。

```ts
import { unzipSync } from 'fflate';

const SOFTHOMPO_STOCK_BASE_URL = 'https://softhompo.a.la9.jp/Data/stock';
```

```ts
// キーはYYYYMM。値は月次ファイルの中身(ファイル名 → バイト列)、月次ファイルが無ければnull。
export type MonthlyArchiveCache = Map<string, Record<string, Uint8Array> | null>;

// zipを取って展開する。404はnull(休場日・未公表・月次へ移った後の日次など)。
async function fetchZip(url: string): Promise<Record<string, Uint8Array> | null> {
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`softhompo: HTTP ${response.status} fetching ${url}`);
  }
  return unzipSync(new Uint8Array(await response.arrayBuffer()));
}

// TextDecoderは先頭のBOMを取り除く。
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

// dateはYYYY-MM-DD。当月分は日次ファイル、前月以前は月次ファイルにある。前月分は翌月第2営業日ごろに
// 日次から月次へ移るので、日次が404なら月次を見る。どちらにも無ければnull(休場日・未公表)。
export async function fetchSoftHompoDay(date: string, monthlyCache: MonthlyArchiveCache): Promise<string | null> {
  const ymd = date.replace(/-/g, '');
  const fileName = `stq_${ymd}.csv`;

  const daily = await fetchZip(`${SOFTHOMPO_STOCK_BASE_URL}/thisMonth/stq_${ymd}.zip`);
  if (daily !== null) {
    const entry = daily[fileName];
    if (entry === undefined) {
      throw new Error(`softhompo: ${fileName} not found in the daily zip`);
    }
    return decodeUtf8(entry);
  }

  const yearMonth = ymd.slice(0, 6);
  if (!monthlyCache.has(yearMonth)) {
    monthlyCache.set(yearMonth, await fetchZip(`${SOFTHOMPO_STOCK_BASE_URL}/pastMonth/${yearMonth}.zip`));
  }
  const entry = monthlyCache.get(yearMonth)?.[fileName];
  return entry === undefined ? null : decodeUtf8(entry);
}
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `npx jest test/softhompo.test.ts`
Expected: PASS(16件)

- [ ] **Step 6: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 7: コミット**

```bash
git add lambda/price-batch/softhompo.ts test/softhompo.test.ts package.json package-lock.json
git commit -m "Fetch a day of SoftHompo prices from the daily zip, falling back to the monthly archive

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 株価バッチをSoftHompoに切り替える(Lambda・CDK)

**Files:**
- Rewrite: `lambda/price-batch/index.ts`
- Rewrite: `test/price-batch.test.ts`
- Modify: `lib/j-quants-stack.ts`(`PriceBatchFunction`まわり、166〜197行付近)
- Modify: `test/j-quants.test.ts`(株価バッチのテスト、176〜195行付近。アラームのテストを追加)

**Interfaces:**
- Consumes: `fetchSoftHompoDay(date: string, monthlyCache: MonthlyArchiveCache): Promise<string | null>`、`parseSoftHompoCsv(csvText: string): Map<string, SoftHompoBar>`、`type MonthlyArchiveCache`(Task 1・2)
- Produces: `handler(): Promise<void>`(環境変数`TABLE_NAME`・`YUTAI_MASTER_TABLE_NAME`。任意で`LOOKBACK_DAYS`(既定7)・`SOFTHOMPO_REQUEST_INTERVAL_MS`(既定1000))

- [ ] **Step 1: 失敗するテストを書く(ハンドラー)**

`test/price-batch.test.ts`を次の内容で置き換える。

```ts
// このファイルをモジュールにする。トップレベルのimport/exportが無いとファイルの宣言が
// グローバルスコープに出てしまい、同名の宣言(mockSend・handlerなど)を持つ他のテスト
// ファイルとts-jestの型検査で衝突する(TS2451)。
import { readFileSync } from 'fs';
import { join } from 'path';

const mockDdbSend = jest.fn();
const mockFetchSoftHompoDay = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  PutCommand: jest.fn((input: unknown) => ({ put: input })),
  ScanCommand: jest.fn((input: unknown) => ({ scan: input })),
}));

// 解析は本物を使い、取得だけを差し替える
jest.mock('../lambda/price-batch/softhompo', () => ({
  ...jest.requireActual('../lambda/price-batch/softhompo'),
  fetchSoftHompoDay: (...args: unknown[]) => mockFetchSoftHompoDay(...args),
}));

process.env.TABLE_NAME = 'JQuantsStockPrices';
process.env.YUTAI_MASTER_TABLE_NAME = 'JQuantsYutaiMaster';
process.env.SOFTHOMPO_REQUEST_INTERVAL_MS = '0';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/price-batch/index') as { handler: () => Promise<void> };

const fixture = readFileSync(join(__dirname, 'fixtures', 'softhompo', 'stq_20261028.csv'), 'utf8');

type Sent = { scan?: Record<string, unknown>; put?: { TableName: string; Item: Record<string, unknown> } };

function mockMasterTickers(tickers: string[]) {
  mockDdbSend.mockImplementation(async (command: Sent) => {
    if (command.scan) return { Items: tickers.map((ticker) => ({ ticker })) };
    return {};
  });
}

function puts(): Array<{ TableName: string; Item: Record<string, unknown> }> {
  return mockDdbSend.mock.calls.map(([command]) => (command as Sent).put).filter((p): p is NonNullable<Sent['put']> => !!p);
}

beforeEach(() => {
  mockDdbSend.mockReset();
  mockFetchSoftHompoDay.mockReset();
  // JST 2026-10-29(木)09:30 の実行
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-29T00:30:00Z'));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('does nothing when there are no target tickers', async () => {
  mockMasterTickers([]);

  await handler();

  expect(mockFetchSoftHompoDay).not.toHaveBeenCalled();
});

test('fetches the seven JST days before today, oldest first, sharing one monthly cache', async () => {
  mockMasterTickers(['2301']);
  mockFetchSoftHompoDay.mockResolvedValue(null);

  await handler();

  expect(mockFetchSoftHompoDay.mock.calls.map(([date]) => date)).toEqual([
    '2026-10-22',
    '2026-10-23',
    '2026-10-24',
    '2026-10-25',
    '2026-10-26',
    '2026-10-27',
    '2026-10-28',
  ]);
  const caches = new Set(mockFetchSoftHompoDay.mock.calls.map(([, cache]) => cache));
  expect(caches.size).toBe(1);
  expect([...caches][0]).toBeInstanceOf(Map);
});

test('writes only the target tickers that traded, in the existing price row shape', async () => {
  // 1788は終日取引なし、1301は優待マスタに無い
  mockMasterTickers(['2301', '1793', '1788']);
  mockFetchSoftHompoDay.mockImplementation(async (date: string) => (date === '2026-10-28' ? fixture : null));

  await handler();

  const written = puts();
  expect(written.map((p) => p.Item.ticker).sort()).toEqual(['1793', '2301']);
  const row = written.find((p) => p.Item.ticker === '2301')!;
  expect(row.TableName).toBe('JQuantsStockPrices');
  expect(row.Item).toEqual({
    ticker: '2301',
    date: '2026-10-28',
    open: 1694,
    high: 1700,
    low: 1672,
    close: 1673,
    volume: 553500,
    updated_at: expect.any(String),
  });
});

test('reads only the ticker column of the yutai master', async () => {
  mockMasterTickers(['2301']);
  mockFetchSoftHompoDay.mockResolvedValue(null);

  await handler();

  const scan = mockDdbSend.mock.calls.map(([command]) => (command as Sent).scan).find(Boolean);
  expect(scan).toMatchObject({ TableName: 'JQuantsYutaiMaster', ProjectionExpression: 'ticker' });
});

test('skips days without a file and does not fail', async () => {
  mockMasterTickers(['2301']);
  mockFetchSoftHompoDay.mockResolvedValue(null);

  await expect(handler()).resolves.toBeUndefined();
  expect(puts()).toHaveLength(0);
});

test('keeps going after a failed day and throws at the end naming it', async () => {
  mockMasterTickers(['2301']);
  mockFetchSoftHompoDay.mockImplementation(async (date: string) => {
    if (date === '2026-10-27') throw new Error('softhompo: HTTP 503');
    if (date === '2026-10-28') return fixture;
    return null;
  });

  await expect(handler()).rejects.toThrow('2026-10-27');
  // 失敗した日の後の10/28も書いている
  expect(puts().map((p) => p.Item.date)).toEqual(['2026-10-28']);
});

test('treats a malformed file as a failed day', async () => {
  mockMasterTickers(['2301']);
  mockFetchSoftHompoDay.mockImplementation(async (date: string) =>
    date === '2026-10-28' ? fixture.replace('"売買高(千株)"', '"出来高(千株)"') : null,
  );

  await expect(handler()).rejects.toThrow('2026-10-28');
  expect(puts()).toHaveLength(0);
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx jest test/price-batch.test.ts`
Expected: FAIL(旧実装はJ-Quantsのクライアントを呼ぶため、`fetchSoftHompoDay`が呼ばれない等)

- [ ] **Step 3: ハンドラーを書き換える**

`lambda/price-batch/index.ts`を次の内容で置き換える。

```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { fetchSoftHompoDay, parseSoftHompoCsv, type MonthlyArchiveCache, type SoftHompoBar } from './softhompo';

const TABLE_NAME = process.env.TABLE_NAME!;
const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
// SoftHompoは前営業日分を翌営業日の朝に公表する。直近7日分を毎回取り直し、遅れた公表や訂正を拾う。
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? '7');
// ファイル(日付)ごとに空ける間隔。個人のサイトなので間を空ける。
const REQUEST_INTERVAL_MS = Number(process.env.SOFTHOMPO_REQUEST_INTERVAL_MS ?? '1000');
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scanYutaiTickers(): Promise<Set<string>> {
  const tickers = new Set<string>();
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({
        TableName: YUTAI_MASTER_TABLE_NAME,
        ProjectionExpression: 'ticker',
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of result.Items ?? []) {
      if (typeof item.ticker === 'string') tickers.add(item.ticker);
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return tickers;
}

// JSTの日付で数える(実行はJST 09:30で、UTCではまだ前日の00:30)。今日の分は未公表なので含めない。
function lookbackDates(now: number): string[] {
  const dates: string[] = [];
  for (let offset = LOOKBACK_DAYS; offset >= 1; offset--) {
    dates.push(new Date(now + JST_OFFSET_MS - offset * DAY_MS).toISOString().slice(0, 10));
  }
  return dates;
}

async function upsertBar(ticker: string, date: string, bar: SoftHompoBar): Promise<void> {
  await ddbDocClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        ticker,
        date,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        updated_at: new Date().toISOString(),
      },
    }),
  );
}

export const handler = async (): Promise<void> => {
  const tickers = await scanYutaiTickers();
  if (tickers.size === 0) {
    console.warn('No target tickers (yutai master is empty); nothing to fetch');
    return;
  }

  const monthlyCache: MonthlyArchiveCache = new Map();
  const failedDates: string[] = [];

  for (const [index, date] of lookbackDates(Date.now()).entries()) {
    if (index > 0) await sleep(REQUEST_INTERVAL_MS);
    try {
      const csv = await fetchSoftHompoDay(date, monthlyCache);
      if (csv === null) {
        console.log(`${date}: no file (holiday or not yet published)`);
        continue;
      }
      const bars = parseSoftHompoCsv(csv);
      let written = 0;
      for (const [ticker, bar] of bars) {
        if (!tickers.has(ticker)) continue;
        await upsertBar(ticker, date, bar);
        written++;
      }
      console.log(`${date}: wrote ${written} of ${tickers.size} target tickers (${bars.size} rows in file)`);
    } catch (error) {
      console.error(`${date}: failed to fetch/parse/write SoftHompo prices`, error);
      failedDates.push(date);
    }
  }

  // 失敗した日があれば、他の日を処理し終えてから実行エラーにする(2日連続失敗のアラーム用)。
  if (failedDates.length > 0) {
    throw new Error(`price-batch: failed on ${failedDates.length} dates: ${failedDates.join(', ')}`);
  }
};
```

- [ ] **Step 4: ハンドラーのテストが通ることを確認する**

Run: `npx jest test/price-batch.test.ts test/softhompo.test.ts`
Expected: PASS

- [ ] **Step 5: 失敗するテストを書く(スタック)**

`test/j-quants.test.ts`の`creates the price batch Lambda wired to the price/yutai tables (not financial) and a daily schedule`テストを次で置き換え、その直後にアラームのテストを追加する。

```ts
test('creates the price batch Lambda wired to the price/yutai tables (not financial, no J-Quants key) and a weekday morning schedule', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
    Environment: {
      Variables: Match.exact({
        TABLE_NAME: Match.anyValue(),
        YUTAI_MASTER_TABLE_NAME: Match.anyValue(),
      }),
    },
  });
  // SoftHompoは前営業日分を翌朝に公表する。平日JST 09:30 = UTC 00:30
  template.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'cron(30 0 ? * MON-FRI *)',
    State: 'ENABLED',
  });

  const rules = template.findResources('AWS::Events::Rule');
  const scheduleExpressions = Object.values(rules).map(
    (r) => (r as { Properties?: { ScheduleExpression?: string } }).Properties?.ScheduleExpression,
  );
  expect(scheduleExpressions).not.toContain('cron(0 9 * * ? *)');

  const policies = template.findResources('AWS::IAM::Policy');
  const priceBatchCanReadSecret = Object.entries(policies)
    .filter(([name]) => name.startsWith('PriceBatchFunction'))
    .flatMap(([, p]) => (p as { Properties: { PolicyDocument: { Statement: Array<{ Action: string | string[] }> } } }).Properties.PolicyDocument.Statement)
    .some((stmt) => (Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action]).includes('secretsmanager:GetSecretValue'));
  expect(priceBatchCanReadSecret).toBe(false);
});

test('notifies by email when the price batch fails two days in a row', () => {
  const template = synth();

  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    Namespace: 'AWS/Lambda',
    MetricName: 'Errors',
    Statistic: 'Sum',
    Period: 86400,
    EvaluationPeriods: 2,
    DatapointsToAlarm: 2,
    Threshold: 1,
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    TreatMissingData: 'notBreaching',
    AlarmDescription: '株価バッチ(SoftHompo)が2日連続で失敗',
    AlarmActions: [{ Ref: Match.stringLikeRegexp('JQuantsBatchAlarmTopic') }],
    Dimensions: [{ Name: 'FunctionName', Value: { Ref: Match.stringLikeRegexp('PriceBatchFunction') } }],
  });
});
```

- [ ] **Step 6: テストが失敗することを確認する**

Run: `npx jest test/j-quants.test.ts -t "price batch"`
Expected: FAIL(`SECRET_ARN`がある、スケジュールが`cron(0 9 * * ? *)`、アラームが無い)

- [ ] **Step 7: CDKを直す**

`lib/j-quants-stack.ts`の`PriceBatchFunction`の定義から、`SECRET_ARN: this.apiKeySecret.secretArn,`の行と`this.apiKeySecret.grantRead(priceBatchFn);`の行を削除する。関数定義の上のコメント(「日付ごとに東証全銘柄分を1リクエストで取得する方式…」の4行)を次に置き換える。

```ts
      // SoftHompoの日次ファイル(東証全銘柄分)を直近7日分取り、優待銘柄の行だけ書く。
```

`PriceBatchSchedule`とその上のコメント(「株価四本値は当日16:30頃に配信される…」の3行)を次に置き換える。

```ts
    // SoftHompoは前営業日分を翌営業日の朝(8:30ごろ)に公表する。平日JST 09:30 = UTC 00:30。
    new events.Rule(this, 'PriceBatchSchedule', {
      schedule: events.Schedule.cron({ minute: '30', hour: '0', weekDay: 'MON-FRI' }),
      targets: [new targets.LambdaFunction(priceBatchFn)],
    });

    // 2日連続で失敗(エラーが出た日が2日続く)したらメールで知らせる。実行が無い日は欠測扱いで正常。
    new cloudwatch.Alarm(this, 'PriceBatchErrorsAlarm', {
      metric: priceBatchFn.metricErrors({ period: cdk.Duration.days(1), statistic: 'Sum' }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: '株価バッチ(SoftHompo)が2日連続で失敗',
    }).addAlarmAction(new cloudwatch_actions.SnsAction(this.batchAlarmTopic));
```

`this.batchAlarmTopic`は`PriceBatchFunction`より前(64行付近)で作られているので、そのまま参照できる。

- [ ] **Step 8: テストが通ることを確認する**

Run: `npx jest test/j-quants.test.ts test/price-batch.test.ts test/softhompo.test.ts`
Expected: PASS(既存の「margin balance batch」のアラームテストは`hasResourceProperties`なので、アラームが2つになっても通る)

- [ ] **Step 9: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 10: コミット**

```bash
git add lambda/price-batch/index.ts test/price-batch.test.ts lib/j-quants-stack.ts test/j-quants.test.ts
git commit -m "Read stock prices from SoftHompo on weekday mornings instead of J-Quants

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 財務サマリーとJ-Quantsのキーを削除する(バックエンド)

**Files:**
- Delete: `lambda/financial-summary-batch/index.ts`、`test/financial-summary-batch.test.ts`
- Delete: `lambda/shared/jquants-batch-client.ts`、`test/jquants-batch-client.test.ts`
- Modify: `lambda/reference-api/index.ts`
- Modify: `test/reference-api.test.ts`
- Modify: `lib/j-quants-stack.ts`
- Modify: `test/j-quants.test.ts`

**Interfaces:**
- Consumes: Task 3の後、`jquants-batch-client`を使うのは`financial-summary-batch`だけになっている
- Produces: `GET /yutai/{ticker}`の`basicInfo`は`{ closePrice: number | null; volume: number | null }`だけになる。`GET /tickers/{ticker}/summary`は無くなる(Task 5のフロントがこれに合わせる)

- [ ] **Step 1: APIのテストを先に直す(失敗させる)**

`test/reference-api.test.ts`で:

1. `process.env.FINANCIAL_TABLE_NAME = 'JQuantsFinancialSummary';`の行を削除する。
2. `GET /tickers/{ticker}/summary`で始まる3つのテスト(`returns 404 for a ticker not in JQuantsYutaiMaster`、`returns 404 when no disclosure has been collected yet`、`returns the latest disclosure`)を削除し、代わりに次の1件を置く。

```ts
test('the financial summary route GET /tickers/{ticker}/summary is gone', async () => {
  const result = await handler(makeEvent('GET /tickers/{ticker}/summary', { pathParameters: { ticker: '7203' } }));

  expect((result as { statusCode: number }).statusCode).toBe(404);
  expect(mockSend).not.toHaveBeenCalled();
});
```

3. `GET /yutai/{ticker}`系のテストで、`// financial summary`(`// financial summary: none yet`を含む)とコメントされた`.mockResolvedValueOnce(...)`の行をすべて削除する(5か所)。`GET /yutai/:ticker returns the benefit tier groups verbatim`テストでは、3番目の`.mockResolvedValueOnce({ Items: [] })`(summaryの分)を削除し、その上のコメントを`// 既存テストと同じ順序でモックする(master get → price → actual query)`にする。
4. `GET /yutai/{ticker} returns basic info, the gyakuhibu amounts, and rights history`テストを次のように直す:
   - `parsed`の型の`basicInfo: { closePrice: number; per: number | null };`を`basicInfo: Record<string, unknown>;`にする。
   - `expect(parsed.basicInfo.closePrice).toBe(500);`を`expect(parsed.basicInfo).toEqual({ closePrice: 500, volume: 10000 });`にする。
   - 呼び出し回数のコメントと期待値を次にする。

```ts
  // リクエストあたりのDynamoDBアクセスは3回(yutai master get・latest price・
  // gyakuhibu history)。判定はGET /yutai/{ticker}/forecastが返すので、
  // ここでは予測テーブルを読まない。財務サマリーは廃止したので読まない。
  expect(mockSend).toHaveBeenCalledTimes(3);
  expect(mockSend.mock.calls.some(([cmd]) => (cmd as { TableName?: string }).TableName === 'JQuantsGyakuhibuForecast')).toBe(false);
  expect(mockSend.mock.calls.some(([cmd]) => (cmd as { TableName?: string }).TableName === 'JQuantsFinancialSummary')).toBe(false);
```

Run: `npx jest test/reference-api.test.ts`
Expected: FAIL(summaryルートが200/404でDynamoDBを呼ぶ、`basicInfo`に財務項目がある、呼び出し回数が4)

- [ ] **Step 2: APIを直す**

`lambda/reference-api/index.ts`で:

1. `const FINANCIAL_TABLE_NAME = process.env.FINANCIAL_TABLE_NAME!;`を削除する。
2. `getSummary`関数(`async function getSummary(ticker: string)`から閉じ括弧まで)を削除する。
3. `latestFinancialSummary`関数を削除する。
4. `getYutaiDetail`の中の次の3行を削除する。

```ts
  const summary = await latestFinancialSummary(ticker);
  const eps = summary?.eps ? Number(summary.eps) : undefined;
  const per = price && eps && eps > 0 ? price.close / eps : null;
```

5. `basicInfo`を次にする。

```ts
    basicInfo: {
      closePrice: price?.close ?? null,
      volume: price?.volume ?? null,
    },
```

6. ルーターの`switch`から次の2行を削除する。

```ts
    case 'GET /tickers/{ticker}/summary':
      return ticker ? await getSummary(ticker) : jsonResponse(400, { message: 'Missing ticker' });
```

7. `isKnownTicker`が`getPrices`だけから使われるようになるが、関数はそのまま残す。

Run: `npx jest test/reference-api.test.ts`
Expected: PASS

- [ ] **Step 3: スタックのテストを先に直す(失敗させる)**

`test/j-quants.test.ts`で:

1. `creates the J-Quants API key secret without an inline value`テストを次で置き換える。

```ts
test('no longer keeps a J-Quants API key secret (nothing calls J-Quants)', () => {
  const template = synth();

  const secrets = template.findResources('AWS::SecretsManager::Secret');
  const names = Object.values(secrets).map((s) => (s as { Properties: { Name?: string } }).Properties.Name);
  expect(names).not.toContain('JQuantsApiKey');

  const functions = template.findResources('AWS::Lambda::Function');
  const envVars = Object.values(functions).flatMap((f) =>
    Object.keys((f as { Properties: { Environment?: { Variables?: Record<string, unknown> } } }).Properties.Environment?.Variables ?? {}),
  );
  expect(envVars).not.toContain('SECRET_ARN');
});
```

2. `creates the financial summary batch Lambda wired to the financial/yutai tables (not price) and a weekly schedule`テストを次で置き換える。

```ts
test('no longer runs a financial summary batch, but keeps the table', () => {
  const template = synth();

  const functions = template.findResources('AWS::Lambda::Function');
  expect(Object.keys(functions).some((id) => id.startsWith('FinancialSummaryBatchFunction'))).toBe(false);
  const envVars = Object.values(functions).flatMap((f) =>
    Object.keys((f as { Properties: { Environment?: { Variables?: Record<string, unknown> } } }).Properties.Environment?.Variables ?? {}),
  );
  expect(envVars).not.toContain('FINANCIAL_TABLE_NAME');

  const rules = template.findResources('AWS::Events::Rule');
  const scheduleExpressions = Object.values(rules).map(
    (r) => (r as { Properties?: { ScheduleExpression?: string } }).Properties?.ScheduleExpression,
  );
  expect(scheduleExpressions).not.toContain('cron(0 11 ? * MON *)');

  template.hasResourceProperties('AWS::DynamoDB::Table', { TableName: 'JQuantsFinancialSummary' });
});
```

3. `creates the HTTP API with the price/summary and yutai routes`テストの名前を`creates the HTTP API with the price and yutai routes`にし、`routeKeys`の配列から`'GET /tickers/{ticker}/summary',`を削除し、末尾の`expect(actualRouteKeys).not.toContain('GET /yutai');`の後に次を足す。

```ts
  // 財務サマリーは廃止した
  expect(actualRouteKeys).not.toContain('GET /tickers/{ticker}/summary');
```

4. スケジュールの数を数えている2か所(`toHaveLength(7)`)を`toHaveLength(6)`にし、その上のコメントを直す:
   - 1か所目(yutai-master-sync-batchのテスト): 「他バッチの4つのスケジュール(price/financial-summary/margin-balance/gyakuhibu-history)+tdnet-watch+yutai-risk-precompute+gyakuhibu-forecastの7つのみ。」→「他バッチの3つのスケジュール(price/margin-balance/gyakuhibu-history)+tdnet-watch+yutai-risk-precompute+gyakuhibu-forecastの6つのみ。」
   - 2か所目(forecast validationのテスト): 「既存7スケジュール(price/financial-summary/margin-balance/gyakuhibu-history/tdnet-watch/yutai-risk-precompute/gyakuhibu-forecast)から増えていないことを確認する。」→「既存6スケジュール(price/margin-balance/gyakuhibu-history/tdnet-watch/yutai-risk-precompute/gyakuhibu-forecast)から増えていないことを確認する。」
5. yutai-risk-precompute-batchのテストのコメント(「which has many more env vars (FINANCIAL_TABLE_NAME, GYAKUHIBU_ACTUAL_TABLE_NAME, …」)から`FINANCIAL_TABLE_NAME, `を削除する。

Run: `npx jest test/j-quants.test.ts`
Expected: FAIL(シークレット・財務バッチ・summaryルートがある、スケジュールが7つ)

- [ ] **Step 4: スタックを直す**

`lib/j-quants-stack.ts`で:

1. `FinancialSummaryBatchFunction`の定義、その4行の`grant…`(`financialSummaryTable.grantWriteData`/`grantReadData`、`yutaiMasterTable.grantReadData`、`apiKeySecret.grantRead`)、コメント2行と`FinancialSummaryBatchSchedule`を削除する(197〜225行付近の、`const financialSummaryBatchFn = …`から`FinancialSummaryBatchSchedule`の`});`まで)。
2. `JQuantsApiKeySecret`の定義と、その上のコメント2行(「APIキーの値自体はCDKに含めず…」)を削除する。`public readonly apiKeySecret: secretsmanager.Secret;`も削除する。`secretsmanager`のimportが他で使われていなければimportも削除する(`grep -n secretsmanager lib/j-quants-stack.ts`で確認)。
3. `ReferenceApiFunction`の`environment`から`FINANCIAL_TABLE_NAME: this.financialSummaryTable.tableName,`を、その下の`this.financialSummaryTable.grantReadData(referenceApiFn);`を削除する。
4. `/tickers/{ticker}/summary`の`this.api.addRoutes({ … });`を削除する。
5. `this.financialSummaryTable`(テーブル定義)とその`public readonly`宣言は残す。テーブル定義の上に次のコメントを足す。

```ts
    // 財務サマリーは2026-10に廃止した(取得・API・表示とも)。データは消さずに残している。
```

6. コメントの中で`FinancialSummaryBatchSchedule`に触れている箇所(`grep -n "FinancialSummary" lib/j-quants-stack.ts`で確認。YutaiTdnetWatchBatchScheduleの上のコメントなど)から、財務バッチの記述を削除する。

- [ ] **Step 5: 財務バッチとJ-Quants共通クライアントを削除する**

```bash
git rm -r lambda/financial-summary-batch test/financial-summary-batch.test.ts lambda/shared/jquants-batch-client.ts test/jquants-batch-client.test.ts
```

削除後、他から参照されていないことを確認する。

Run: `grep -rn "jquants-batch-client\|financial-summary-batch\|FINANCIAL_TABLE_NAME\|apiKeySecret\|SECRET_ARN" lambda lib bin test --include=*.ts`
Expected: 出力なし

- [ ] **Step 6: 全テストと型チェック**

Run: `npx tsc --noEmit`
Expected: エラーなし

Run: `npx jest`
Expected: 全スイートPASS

- [ ] **Step 7: コミット**

```bash
git add lambda/reference-api/index.ts test/reference-api.test.ts lib/j-quants-stack.ts test/j-quants.test.ts
git commit -m "Drop the financial summary batch, its API route, and the J-Quants API key

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(`git rm`した削除はStep 5の時点でステージ済み。同じコミットに入る)

---

### Task 5: 画面から財務サマリーとPERを外す(フロントエンド)

**Files:**
- Modify: `frontend/src/pages/TickerDetailPage.tsx`
- Modify: `frontend/src/pages/YutaiDetailPage.tsx`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/api/types.ts`

**Interfaces:**
- Consumes: Task 4のAPI(`basicInfo`は`closePrice`と`volume`だけ。`/tickers/{ticker}/summary`は無い)

フロントにはテストが無い。型チェック付きのビルドとlintで確かめる。

- [ ] **Step 1: 型を直す**

`frontend/src/api/types.ts`で:
- `export interface FinancialSummary { … }`(9項目)を削除する。
- `YutaiBasicInfo`を次にする。

```ts
export interface YutaiBasicInfo {
  closePrice: number | null;
  volume: number | null;
}
```

- [ ] **Step 2: APIクライアントを直す**

`frontend/src/api/client.ts`で:
- `import type { … } from './types';`から`FinancialSummary,`を削除する。
- `fetchSummary`関数(3行)を削除する。

- [ ] **Step 3: 銘柄詳細ページから財務サマリーを外す**

`frontend/src/pages/TickerDetailPage.tsx`で:
- importを次にする(`ApiError`・`fetchSummary`・`formatFinancialYen`は使わなくなる)。

```ts
import { fetchPrices } from '../api/client';
import { StatusNote } from '../components/StatusNote';
import { formatPrice, formatVolume } from '../lib/format';
```

- `const summaryState = useAsync(…);`のブロック(9行)を削除する。
- サブタイトルを`<p className="page-subtitle">直近12週間の値動きです。</p>`にする。
- `<div className="section-heading">財務サマリ</div>`から、最後の`{summaryState.data && ( … )}`の閉じ括弧までを削除する(`</>`の直前まで)。チャートの部分は変えない。

- [ ] **Step 4: 優待詳細ページからPERと決算サマリを外す**

`frontend/src/pages/YutaiDetailPage.tsx`の「銘柄基本情報」カードから、`PER`の`summary-item`(4行)と`決算サマリ`の`summary-item`(`<div className="summary-item">`から対応する`</div>`まで、12行)を削除する。「前日終値」「出来高」は残す。

`formatFinancialYen`は優待価値の表示などでまだ使っているので、importは残す(lintで未使用と言われたら削除する)。

- [ ] **Step 5: ビルドとlint**

Run: `cd frontend && npm run build`
Expected: 成功(型エラーなし)

Run: `cd frontend && npm run lint`
Expected: 新しい警告・エラーなし

Run: `grep -rn "fetchSummary\|FinancialSummary\|basicInfo\.\(per\|sales\|eps\|operatingProfit\|netProfit\)" frontend/src`
Expected: 出力なし

- [ ] **Step 6: コミット**

```bash
git add frontend/src/pages/TickerDetailPage.tsx frontend/src/pages/YutaiDetailPage.tsx frontend/src/api/client.ts frontend/src/api/types.ts
git commit -m "Remove the financial summary and PER from the ticker and yutai detail pages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: README

**Files:**
- Modify: `README.md`

`README.md`には別作業の未コミットの1行(Cognitoの「メールなしで発行」の行)がある。その行には触れず、コミットにも入れない。

- [ ] **Step 1: 書き換える**

1. 3行目の説明を「株価をSoftHompo、信用残・逆日歩・貸借区分をtaisyaku.jpから取得して蓄積し、Webで閲覧するための個人用アプリ。」にする。
2. アーキテクチャ図の`PriceBatchFunction`のブロックを次にする。

```
EventBridge(平日 JST09:30)
  → PriceBatchFunction(Lambda)
      - JQuantsYutaiMasterテーブルを読んで対象銘柄を取得
      - SoftHompoの日次株価ファイル(東証全銘柄、前営業日分が翌朝公表)を直近7日分取得
        (当月分は日次zip、前月以前は月次zip)し、対象銘柄の四本値・出来高をupsert
      → JQuantsStockPrices に upsert
```

3. アーキテクチャ図の`FinancialSummaryBatchFunction`のブロック(「EventBridge(毎週月曜 JST20:00)」から`→ JQuantsFinancialSummary に upsert`まで、空行1つを含む)を削除する。
4. 「シークレット」の節(見出し・表)を削除する。
5. Lambda表の`PriceBatchFunction`の行を次にする。

```
| `PriceBatchFunction` | EventBridge(`cron(30 0 ? * MON-FRI *)` = JST平日 09:30) | SoftHompo(`https://softhompo.a.la9.jp/Data/StockData.html`)の日次株価ファイルを直近7日分取得し、対象銘柄(`JQuantsYutaiMaster`)の四本値・出来高を`JQuantsStockPrices`へupsert。午後に取引の無い銘柄は午前の値、終日取引の無い銘柄は書かない。取得・解析に失敗した日があれば最後に実行エラーにし、2日連続で失敗するとSNS経由でメール通知 |
```

6. Lambda表の`FinancialSummaryBatchFunction`の行を削除する。
7. Lambda表の`YutaiTdnetWatchBatchFunction`の行の「`PriceBatchFunction`/`FinancialSummaryBatchFunction`の対象銘柄取得も…その銘柄の株価・決算サマリ収集を止め、`GET /tickers/{ticker}/prices`・`summary`も404にする」を「`PriceBatchFunction`の対象銘柄取得も…その銘柄の株価収集を止め、`GET /tickers/{ticker}/prices`も404にする」にする。
8. 「主要コマンド」の節の「deploy後に`JQuantsApiKey`へ投入するJ-Quants APIキーが必要。」と、コードブロック内の「# デプロイ後、J-Quants APIキーを投入(初回のみ)」から`--secret-id JQuantsApiKey --secret-string <APIキー>`までの3行を削除する。
9. テーブルの説明などで`JQuantsFinancialSummary`を挙げている箇所(`grep -n "FinancialSummary\|財務\|決算サマリ" README.md`で確認)に、「2026-10に財務サマリーは廃止。テーブルはデータを残したまま使っていない」旨を添える(テーブル一覧からは消さない)。
10. 移行の節の末尾(「これでJ-Quantsに残る依存は株価(`PriceBatchFunction`)と財務(`FinancialSummaryBatchFunction`)だけになった。」の段落)の後に、次の段落を足す。

```
株価もJ-Quants `/equities/bars/daily`からSoftHompoの日次株価ファイルへ移し、財務サマリー(取得・API・画面表示)とPERの表示は廃止した(`docs/superpowers/specs/2026-10-29-price-softhompo-design.md`)。これでJ-Quantsを呼ぶ処理は無くなり、APIキーのシークレット`JQuantsApiKey`もスタックから削除した。J-QuantsはFreeプランへの変更・解約ができる。SoftHompoは前営業日分を翌営業日の朝に公表するため、夜の貸借判定バッチ(JST 18:20)が使う終値は前営業日のものになる。SoftHompoは個人のサイトで利用規約の記載が無い(本アプリは個人利用に限る)。デプロイはフロント(`aws s3 sync` + CloudFront invalidation)が先、`cdk deploy`が後(旧フロントは`/tickers/{ticker}/summary`が無いとエラー表示になるため)。
```

11. 「J-Quants Freeプランの実際の挙動(実機で判明)」「J-Quants Standardプランへの移行に向けた準備メモ」の節は経緯の記録として残し、それぞれ見出しの直後に「(2026-10の移行でJ-Quantsは使わなくなった。以下は経緯の記録)」の1行を足す。

- [ ] **Step 2: 自分の変更だけをステージしてコミットする**

Run: `git add -p README.md`
Cognitoの「メールなしで発行」の行を含むhunkは`n`で飛ばし、それ以外を`y`でステージする(1つのhunkに混ざっていたら`s`で分割する)。

Run: `git diff --cached README.md | grep -n "メールなし"`
Expected: 出力なし

```bash
git commit -m "Document that stock prices come from SoftHompo and the financial summary is gone

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Run: `git diff README.md`
Expected: 別作業のCognitoの行だけが未コミットで残っている

---

## デプロイ(実装・レビュー完了後、ユーザーの承認を得てから)

1. mainへマージしてpush
2. フロント: `cd frontend && npm run build && aws s3 sync dist/ s3://<FrontendBucketName> --delete` → CloudFront invalidation
3. `npx cdk diff`で、財務バッチ・シークレット・summaryルートの削除、株価バッチの環境変数・スケジュール・アラームの変更だけであることを確認してから`npx cdk deploy`
4. 翌平日のJST 09:30以降、株価バッチのログ(`{date}: wrote N of M target tickers`)と、数銘柄の終値がJ-Quantsで取っていた値(10/29分まで)と一致することを確認する
