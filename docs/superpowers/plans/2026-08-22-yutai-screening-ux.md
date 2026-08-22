# 株主優待ページ UXリッチ化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `YutaiListPage`の一覧テーブルに列ソートを追加し、`YutaiDetailPage`の逆日歩実績プレビューを自前hover実装からRadix HoverCardに置き換える。

**Architecture:** 見た目を持たないヘッドレスライブラリ(`@tanstack/react-table`・`@radix-ui/react-hover-card`)を追加し、既存の`index.css`のデザイントークン・クラス(`.data-table`/`.risk-badge`/`.gyakuhibu-tooltip`等)はそのまま流用する。2つのページ変更は互いに独立しており、依存関係はない。

**Tech Stack:** React 19 / TypeScript(`verbatimModuleSyntax: true`) / Vite。`frontend/`にテストフレームワークは無く、検証は`tsc -b`(型チェック)・`oxlint`(lint)・`npm run dev`での目視確認で行う。

## Global Constraints

- Tailwind・shadcn等の見た目込みUIキットは導入しない(spec: 2026-08-22-yutai-screening-ux-design.md スコープ「含まない」)
- framer-motion等のアニメーションライブラリは導入しない。アニメーションはCSS `@keyframes`のみ
- `GET /yutai`のクエリパラメータ・レスポンス形状、フィルタ(日付範囲・キーワード・リスク)のサーバーサイド呼び出しロジックは変更しない
- 一覧のページネーション・仮想スクロール・列表示切替・行展開は実装しない(スコープ外)
- `frontend/tsconfig.app.json`は`verbatimModuleSyntax: true`のため、型のみのインポートは既存コードの流儀に合わせて`import type { ... } from '...'`を独立した行で書く(値インポートと混在させない)
- `noUnusedLocals`/`noUnusedParameters`が有効なため、使わなくなったインポート・変数は必ず削除する

---

### Task 1: YutaiListPageに列ソートを追加

**Files:**
- Modify: `frontend/package.json`(依存追加)
- Modify: `frontend/src/pages/YutaiListPage.tsx`(全体書き換え)

**Interfaces:**
- Consumes: 既存の`fetchYutaiList`(`frontend/src/api/client.ts`)・`YutaiListItem`/`YutaiRiskStatus`型(`frontend/src/api/types.ts`)・`formatFinancialYen`(`frontend/src/lib/format.ts`)・`useAsync`(`frontend/src/lib/useAsync.ts`)。いずれも変更しない
- Produces: 他タスクはこのファイルに依存しない(Task 2とは独立)

- [ ] **Step 1: `@tanstack/react-table`をインストール**

```bash
cd frontend
npm install @tanstack/react-table@^8.21.3
```

注: `@tanstack/react-table`のnpm `latest`タグは9.x系だが、v9は`useReactTable`/`getCoreRowModel`/`getSortedRowModel`を`useTable`+`features`オプションの新APIに置き換えるフルリライトで、旧APIは`useLegacyTable`という非推奨の互換レイヤーでしか使えない。本書のコード(Step 2)は安定版であるv8系のAPI(`useReactTable`/`getCoreRowModel`/`getSortedRowModel`)を前提にしているため、`^8.21.3`(2026-08-22時点のv8系最新)を明示的にインストールする。

- [ ] **Step 2: `frontend/src/pages/YutaiListPage.tsx`を以下の内容に全面置き換え**

現状はテーブル行を`listState.data.tickers.map(...)`で直接描画しておりソート不可。`useReactTable`でソート機能付きに置き換える。列は5つ(銘柄・優待内容・優待価値・権利日・リスク)。リスクは文字列の五十音順ではなく「危険→安全→対象外」の順に意味があるため、`RISK_SORT_RANK`によるカスタム`sortingFn`を使う。権利日は`null`を持ち得るため、昇順時に`null`を末尾に固定するカスタム`sortingFn`を使う(降順にトグルするとTanStack Tableの標準動作により比較結果が反転するため、`null`は先頭に来る。これは他のライブラリでも一般的な「nullを末尾固定する比較関数を反転した」ときの標準的な挙動であり、意図した仕様とする)。

日付範囲・キーワード・リスクのフィルタ(`filter-bar`、`fetchYutaiList`呼び出し)は一切変更しない。

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable } from '@tanstack/react-table';
import type { ColumnDef } from '@tanstack/react-table';
import { fetchYutaiList } from '../api/client';
import type { YutaiListItem, YutaiRiskStatus } from '../api/types';
import { StatusNote } from '../components/StatusNote';
import { formatFinancialYen } from '../lib/format';
import { useAsync } from '../lib/useAsync';

function monthRange(): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDay = new Date(y, m + 1, 0).getDate();
  return { from: `${y}-${pad(m + 1)}-01`, to: `${y}-${pad(m + 1)}-${pad(lastDay)}` };
}

const RISK_LABEL: Record<YutaiRiskStatus, string> = { safe: '安全', danger: '危険', na: '対象外' };
// リスクは危険→安全→対象外の順に並ぶ方が意味があるため、文字列の並び順ではなく
// このランクでソートする。
const RISK_SORT_RANK: Record<YutaiRiskStatus, number> = { danger: 0, safe: 1, na: 2 };

const columns: ColumnDef<YutaiListItem>[] = [
  {
    id: 'company',
    header: '銘柄',
    accessorFn: (row) => row.companyName ?? row.ticker,
    cell: ({ row }) => (
      <Link to={`/yutai/${row.original.ticker}`}>
        {row.original.companyName ?? row.original.ticker}{' '}
        <span className="ticker-card__code">{row.original.ticker}</span>
      </Link>
    ),
  },
  {
    accessorKey: 'content',
    header: '優待内容',
  },
  {
    accessorKey: 'value',
    header: '優待価値',
    cell: ({ row }) => formatFinancialYen(String(row.original.value)),
  },
  {
    accessorKey: 'rightsDate',
    header: '権利日',
    sortingFn: (rowA, rowB) => {
      const a = rowA.original.rightsDate;
      const b = rowB.original.rightsDate;
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return a.localeCompare(b);
    },
    cell: ({ row }) => row.original.rightsDate ?? '—',
  },
  {
    accessorKey: 'riskStatus',
    header: 'リスク',
    sortingFn: (rowA, rowB) => RISK_SORT_RANK[rowA.original.riskStatus] - RISK_SORT_RANK[rowB.original.riskStatus],
    cell: ({ row }) => (
      <span className={`risk-badge risk-badge--${row.original.riskStatus}`}>{RISK_LABEL[row.original.riskStatus]}</span>
    ),
  },
];

// キーワード入力欄からのAPI呼び出し用デバウンス(ms)。無しだと1文字打つたびに
// GET /yutai が発火し、Freeプランのレート制限(5req/分)に簡単に触れてしまう
// (バックエンド側でカレンダー呼び出しをキャッシュしても、リクエスト数自体は減らない)。
const KEYWORD_DEBOUNCE_MS = 400;

export function YutaiListPage() {
  const defaultRange = monthRange();
  const [rightsDateFrom, setRightsDateFrom] = useState(defaultRange.from);
  const [rightsDateTo, setRightsDateTo] = useState(defaultRange.to);
  const [keyword, setKeyword] = useState('');
  const [debouncedKeyword, setDebouncedKeyword] = useState('');
  const [riskStatus, setRiskStatus] = useState<'all' | YutaiRiskStatus>('all');

  // このアプリの規模でuseDebounceのような専用ライブラリはOverkillなので、
  // useAsync同様に小さな手作りのuseEffectで済ませる。
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword), KEYWORD_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [keyword]);

  const listState = useAsync(
    () => fetchYutaiList({ rightsDateFrom, rightsDateTo, keyword: debouncedKeyword || undefined, riskStatus }),
    [rightsDateFrom, rightsDateTo, debouncedKeyword, riskStatus],
  );

  const table = useReactTable({
    data: listState.data?.tickers ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <>
      <h1 className="page-title">優待クロス スクリーニング</h1>
      <p className="page-subtitle">権利日・優待価値と最大逆日歩の見積りを比較して絞り込みます。</p>

      <div className="disclaimer-banner">
        ⚠️ 現在、信用残・貸借判定はダミーデータです(J-Quants Standardプラン移行後に実データに切り替わります)
      </div>

      {listState.data && (
        <div className="cutoff-banner">
          <span>📅</span>
          <span>
            当月の権利付き最終日: <strong>{listState.data.currentMonthLastTradableDate}</strong>
          </span>
          <span style={{ color: 'var(--text-muted)' }}>(月末が権利確定日の銘柄はこの日までに買付が必要)</span>
        </div>
      )}

      <div className="filter-bar">
        <label>
          権利日(開始):{' '}
          <input type="date" className="input" value={rightsDateFrom} onChange={(e) => setRightsDateFrom(e.target.value)} />
        </label>
        <label>
          権利日(終了):{' '}
          <input type="date" className="input" value={rightsDateTo} onChange={(e) => setRightsDateTo(e.target.value)} />
        </label>
        <label>
          キーワード:{' '}
          <input
            className="input"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="会社名・優待内容"
          />
        </label>
        <label>
          リスク判定:{' '}
          <select value={riskStatus} onChange={(e) => setRiskStatus(e.target.value as typeof riskStatus)}>
            <option value="all">すべて</option>
            <option value="safe">安全</option>
            <option value="danger">危険</option>
            <option value="na">対象外</option>
          </select>
        </label>
      </div>

      {listState.loading && <StatusNote kind="loading" message="読み込み中…" />}
      {listState.error && <StatusNote kind="error" message={`取得に失敗しました: ${listState.error.message}`} />}
      {listState.data && listState.data.tickers.length === 0 && (
        <StatusNote kind="empty" message="条件に一致する優待銘柄がありません。" />
      )}

      {listState.data && listState.data.tickers.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      onClick={header.column.getToggleSortingHandler()}
                      style={{ cursor: header.column.getCanSort() ? 'pointer' : undefined }}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {{ asc: ' 🔼', desc: ' 🔽' }[header.column.getIsSorted() as string] ?? ''}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className={cell.column.id === 'value' || cell.column.id === 'rightsDate' ? 'num' : undefined}
                      style={cell.column.id === 'company' || cell.column.id === 'content' ? { textAlign: 'left' } : undefined}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 3: 型チェックを実行**

```bash
cd frontend
npx tsc -b
```

Expected: エラーなしで終了(出力なし)

- [ ] **Step 4: lintを実行**

```bash
cd frontend
npm run lint
```

Expected: エラーなしで終了

- [ ] **Step 5: ブラウザで目視確認**

```bash
cd frontend
npm run dev
```

`/yutai`を開き、以下を確認する:
1. デフォルト(当月)のフィルタでテーブルが従来通り表示される(列構成・値の見た目に変化がないこと)
2. 「優待価値」ヘッダーをクリック → 数値の昇順に並び替わり、ヘッダー末尾に🔼が付く
3. もう一度クリック → 降順になり🔽が付く
4. さらにクリック → ソート解除前の順序に戻り、矢印が消える
5. 「権利日」ヘッダーをクリック → 日付の昇順に並び、`—`(未定)の行は末尾に来る
6. 「リスク」ヘッダーをクリック → 危険→安全→対象外の順に並ぶ
7. 日付範囲・キーワード・リスクのフィルタを変更 → 従来通りAPIが再呼び出され、テーブル内容が更新される
8. ダークモード(OS設定切り替え、または開発者ツールでprefers-color-schemeをエミュレート)でも配色が崩れない

- [ ] **Step 6: コミット**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/pages/YutaiListPage.tsx
git commit -m "$(cat <<'EOF'
Add column sorting to the yutai screening table

Replaces the plain <table> render in YutaiListPage with TanStack
Table so each column header can sort the already-fetched rows
client-side. Server-side filtering (date range/keyword/risk) is
unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: YutaiDetailPageの逆日歩プレビューをRadix HoverCardに置き換え

**Files:**
- Modify: `frontend/package.json`(依存追加)
- Modify: `frontend/src/pages/YutaiDetailPage.tsx`
- Modify: `frontend/src/index.css:443-459`

**Interfaces:**
- Consumes: 既存の`fetchYutaiDetail`/`fetchYutaiMarginTrend`(`frontend/src/api/client.ts`)・`YutaiDetail`型(`frontend/src/api/types.ts`)。いずれも変更しない
- Produces: 他タスクはこのファイルに依存しない(Task 1とは独立)

- [ ] **Step 1: `@radix-ui/react-hover-card`をインストール**

```bash
cd frontend
npm install @radix-ui/react-hover-card@^1.1.23
```

- [ ] **Step 2: `frontend/src/pages/YutaiDetailPage.tsx`の先頭importを変更**

現状の1行目:

```tsx
import { useRef, useState } from 'react';
```

を削除し(このファイルではこの後`useRef`/`useState`を使わなくなるため。`noUnusedLocals`が有効なので残すとビルドエラーになる)、`@radix-ui/react-hover-card`のimportを追加する。変更後のimportブロック全体は以下の通り(先頭行が丸ごと無くなり、`recharts`の次に`HoverCard`が入る):

```tsx
import { Link, useParams } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import * as HoverCard from '@radix-ui/react-hover-card';
import { fetchYutaiDetail, fetchYutaiMarginTrend } from '../api/client';
import { StatusNote } from '../components/StatusNote';
import { formatFinancialYen, formatPrice, formatVolume } from '../lib/format';
import { useAsync } from '../lib/useAsync';
```

- [ ] **Step 3: `triggerRef`・`tooltipStyle`・`showTooltip`を削除**

以下のブロック(コンポーネント冒頭付近)を削除する:

```tsx
  const [tooltipStyle, setTooltipStyle] = useState<{ top: number; left: number } | undefined>();
```

および:

```tsx
  const triggerRef = useRef<HTMLDivElement>(null);

  function showTooltip() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltipStyle({ top: rect.bottom + 8, left: Math.min(rect.left, window.innerWidth - 340) });
  }
```

- [ ] **Step 4: 逆日歩リスク計算カードのJSXをHoverCardベースに置き換え**

以下のブロック(`<div className="section-heading">逆日歩リスク計算</div>`の次の`<div className="card">`全体):

```tsx
      <div className="card">
        <div className="summary-item__label">最大逆日歩(概算・次回権利日の予測)</div>
        {data.risk.maxGyakuhibu !== null ? (
          <div
            ref={triggerRef}
            className="gyakuhibu-hover summary-item__value"
            onMouseEnter={showTooltip}
            onMouseLeave={() => setTooltipStyle(undefined)}
          >
            {formatFinancialYen(String(data.risk.maxGyakuhibu))}
          </div>
        ) : (
          <div className="summary-item__value">—</div>
        )}
        <p style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
          {data.risk.maxRate !== null ? `最高料率 ${data.risk.maxRate}円 ・ ` : ''}
          {data.risk.days !== null ? `${data.risk.days}日分` : ''}
        </p>
        <span className={`risk-badge risk-badge--${data.risk.riskStatus}`}>{riskLabel}</span>

        {tooltipStyle && (
          <div className="gyakuhibu-tooltip" style={{ top: tooltipStyle.top, left: tooltipStyle.left }}>
            <div className="summary-item__label" style={{ marginBottom: '0.5rem' }}>
              過去の権利日の実績逆日歩(taisyaku.jp確報ベース、直近3年分)
            </div>
            {data.rightsHistory.length === 0 ? (
              <p style={{ color: 'var(--text-muted)' }}>データがありません</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>権利日</th>
                    <th>実績逆日歩</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rightsHistory.map((h) => (
                    <tr key={h.rightsDate}>
                      <td>{h.rightsDate}</td>
                      <td className="num">{formatFinancialYen(String(h.totalAmount))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
```

を、以下に置き換える:

```tsx
      <div className="card">
        <div className="summary-item__label">最大逆日歩(概算・次回権利日の予測)</div>
        {data.risk.maxGyakuhibu !== null ? (
          <HoverCard.Root openDelay={0}>
            <HoverCard.Trigger asChild>
              <div className="gyakuhibu-hover summary-item__value">
                {formatFinancialYen(String(data.risk.maxGyakuhibu))}
              </div>
            </HoverCard.Trigger>
            <HoverCard.Portal>
              <HoverCard.Content className="gyakuhibu-tooltip" side="bottom" sideOffset={8}>
                <div className="summary-item__label" style={{ marginBottom: '0.5rem' }}>
                  過去の権利日の実績逆日歩(taisyaku.jp確報ベース、直近3年分)
                </div>
                {data.rightsHistory.length === 0 ? (
                  <p style={{ color: 'var(--text-muted)' }}>データがありません</p>
                ) : (
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>権利日</th>
                        <th>実績逆日歩</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rightsHistory.map((h) => (
                        <tr key={h.rightsDate}>
                          <td>{h.rightsDate}</td>
                          <td className="num">{formatFinancialYen(String(h.totalAmount))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </HoverCard.Content>
            </HoverCard.Portal>
          </HoverCard.Root>
        ) : (
          <div className="summary-item__value">—</div>
        )}
        <p style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
          {data.risk.maxRate !== null ? `最高料率 ${data.risk.maxRate}円 ・ ` : ''}
          {data.risk.days !== null ? `${data.risk.days}日分` : ''}
        </p>
        <span className={`risk-badge risk-badge--${data.risk.riskStatus}`}>{riskLabel}</span>
      </div>
```

`openDelay={0}`は、既存実装が`onMouseEnter`で即座に表示していた挙動に合わせるため(Radixのデフォルトは700ms遅延)。`closeDelay`はRadixのデフォルト(300ms)のままとする。

- [ ] **Step 5: `frontend/src/index.css`の`.gyakuhibu-tooltip`を変更**

現状(ファイル末尾、443-459行目):

```css
.gyakuhibu-hover {
  display: inline-block;
  border-bottom: 1px dotted var(--text-muted);
  cursor: help;
}

.gyakuhibu-tooltip {
  position: fixed;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  padding: 1rem;
  width: 320px;
  z-index: 1000;
  font-size: 0.85rem;
}
```

を以下に置き換える(`position: fixed`を削除してRadixの内部配置に任せ、`data-state`に応じたアニメーションを追加):

```css
.gyakuhibu-hover {
  display: inline-block;
  border-bottom: 1px dotted var(--text-muted);
  cursor: help;
}

.gyakuhibu-tooltip {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  padding: 1rem;
  width: 320px;
  z-index: 1000;
  font-size: 0.85rem;
}

.gyakuhibu-tooltip[data-state='open'] {
  animation: gyakuhibuTooltipShow 150ms ease-out;
}

.gyakuhibu-tooltip[data-state='closed'] {
  animation: gyakuhibuTooltipHide 100ms ease-in;
}

@keyframes gyakuhibuTooltipShow {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes gyakuhibuTooltipHide {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}
```

- [ ] **Step 6: 型チェックを実行**

```bash
cd frontend
npx tsc -b
```

Expected: エラーなしで終了(出力なし)。特に`useRef`/`useState`の未使用インポートが残っていないことを確認する(`noUnusedLocals`でエラーになる)。

- [ ] **Step 7: lintを実行**

```bash
cd frontend
npm run lint
```

Expected: エラーなしで終了

- [ ] **Step 8: ブラウザで目視確認**

```bash
cd frontend
npm run dev
```

`最大逆日歩`が`—`ではない銘柄の詳細ページ(`/yutai/{ticker}`)を開き、以下を確認する:
1. 「最大逆日歩」の数値にマウスを乗せる → 直下にフェード+わずかな下方向スライドのアニメーションでカードが表示され、過去の実績逆日歩テーブルが見える
2. マウスを離す → フェードアウトして消える
3. Tabキーでその値にフォーカスを当てる → 同様にカードが開く(キーボード操作対応の確認。マウスでのhoverでしか開かなかった旧実装からの改善点)
4. ウィンドウ幅を狭める、または画面右端に近いテスト銘柄で確認 → カードが画面外にはみ出さず自動で位置調整される
5. ダークモードでも配色が崩れない
6. `rightsHistory`が空の銘柄(存在すれば)で「データがありません」の表示になることを確認

- [ ] **Step 9: コミット**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/pages/YutaiDetailPage.tsx frontend/src/index.css
git commit -m "$(cat <<'EOF'
Replace the gyakuhibu history hover popup with Radix HoverCard

Swaps the hand-rolled getBoundingClientRect-based positioning and
mouseenter/mouseleave state for @radix-ui/react-hover-card, which
handles viewport collision avoidance and adds keyboard-focus support
for free. Animation is CSS keyframes keyed off Radix's data-state
attribute, no new animation library.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
