import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable } from '@tanstack/react-table';
import type { ColumnDef } from '@tanstack/react-table';
import { fetchYutaiList } from '../api/client';
import type { YutaiListItem, YutaiRiskStatus } from '../api/types';
import { StatusNote } from '../components/StatusNote';
import { formatFinancialYen } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import {
  crossColumns,
  EMPTY_CROSS_FILTERS,
  toCrossParams,
  YutaiCrossFilters,
  type CrossFilterState,
} from '../lib/yutai-cross';

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
    sortDescFirst: false,
    sortingFn: (rowA, rowB) => {
      const a = rowA.original.value;
      const b = rowB.original.value;
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return a - b;
    },
    cell: ({ row }) => (row.original.value !== null ? formatFinancialYen(String(row.original.value)) : '—'),
  },
  {
    accessorKey: 'maxGyakuhibu',
    header: '最大逆日歩',
    sortDescFirst: false,
    sortingFn: (rowA, rowB) => {
      const a = rowA.original.maxGyakuhibu;
      const b = rowB.original.maxGyakuhibu;
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return a - b;
    },
    cell: ({ row }) => (row.original.maxGyakuhibu !== null ? formatFinancialYen(String(row.original.maxGyakuhibu)) : '—'),
  },
  {
    accessorKey: 'rightsDate',
    header: '権利日',
    sortDescFirst: false,
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
  // 必要株数・クロス・必要資金・前回逆日歩(逆日歩予測画面と共通の列)
  ...crossColumns<YutaiListItem>(),
];

// キーワード入力欄からのAPI呼び出し用デバウンス(ms)。無しだと1文字打つたびに
// GET /yutai が発火し、無駄なリクエストとバックエンドの再スキャンが増えてしまう。
const KEYWORD_DEBOUNCE_MS = 400;

// keywordのstateをこの専用の子コンポーネントに閉じ込める。親(YutaiListPage)にkeyword
// 自体を持たせると、1文字打つたびに親全体(テーブルを含む)が再レンダーされ、行モデルの
// 中身は変わらなくてもJSXツリーの再構築・差分比較コストが検索結果の多さに応じて
// 重くなる(逆日歩予測ページで実機のスマホで固まる不具合として顕在化した)。
// onDebouncedChangeはデバウンス後にしか呼ばれないため、親は実際に検索条件が変わった
// 時だけ再レンダーすればよい。
function KeywordFilterInput({ onDebouncedChange }: { onDebouncedChange: (value: string) => void }) {
  const [value, setValue] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => onDebouncedChange(value), KEYWORD_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, onDebouncedChange]);

  return (
    <input className="input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="会社名・優待内容" />
  );
}

export function YutaiListPage() {
  const defaultRange = monthRange();
  const [rightsDateFrom, setRightsDateFrom] = useState(defaultRange.from);
  const [rightsDateTo, setRightsDateTo] = useState(defaultRange.to);
  const [debouncedKeyword, setDebouncedKeyword] = useState('');
  const [riskStatus, setRiskStatus] = useState<'all' | YutaiRiskStatus>('all');

  const [crossFilters, setCrossFilters] = useState<CrossFilterState>(EMPTY_CROSS_FILTERS);

  // depsはオブジェクトを渡すと毎レンダーで参照が変わり無限ループになるため、
  // crossFiltersは個々の文字列に展開して並べる。
  // 数値欄(株価・必要資金)の値はYutaiCrossFilters側でデバウンスされてから届くので、
  // 1文字ごとに全表スキャンのリクエストが飛ぶことはない。クロス可否の<select>は即時。
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
          キーワード: <KeywordFilterInput onDebouncedChange={setDebouncedKeyword} />
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
        <YutaiCrossFilters state={crossFilters} onChange={setCrossFilters} />
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
                      className={
                        ['value', 'maxGyakuhibu', 'rightsDate', 'requiredShares', 'requiredInvestment', 'lastGyakuhibu'].includes(
                          cell.column.id,
                        )
                          ? 'num'
                          : cell.column.id === 'content'
                            ? 'cell-wrap'
                            : undefined
                      }
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
