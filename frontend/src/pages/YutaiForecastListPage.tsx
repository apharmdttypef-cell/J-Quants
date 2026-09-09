import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable } from '@tanstack/react-table';
import type { ColumnDef } from '@tanstack/react-table';
import { fetchYutaiForecastList } from '../api/client';
import type { YutaiForecastListItem, YutaiForecastStatus } from '../api/types';
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

const FORECAST_STATUS_LABEL: Record<YutaiForecastStatus, string> = {
  danger: '危険',
  caution: '注意',
  safe: '安全',
  na: '対象外',
};
// 判定は危険→注意→安全→対象外の順に並ぶ方が意味があるため、文字列の並び順ではなく
// このランクでソートする(既存YutaiListPageのRISK_SORT_RANKと同じ考え方)。
const FORECAST_STATUS_SORT_RANK: Record<YutaiForecastStatus, number> = {
  danger: 0,
  caution: 1,
  safe: 2,
  na: 3,
};

// デフォルトソート: 判定ランク→expectedNet昇順(=優待価値と予測逆日歩の差が小さい=
// 危ないものが上に来る)。tanstack/react-tableの複数列初期ソートに頼らず、テーブルに
// 渡す前に配列を並べ替えておく(ヘッダークリックでの単一列ソートはこれとは独立に動く)。
function compareByDefaultOrder(a: YutaiForecastListItem, b: YutaiForecastListItem): number {
  const rankDiff = FORECAST_STATUS_SORT_RANK[a.forecast.forecastStatus] - FORECAST_STATUS_SORT_RANK[b.forecast.forecastStatus];
  if (rankDiff !== 0) return rankDiff;
  const netA = a.forecast.expectedNet ?? Infinity;
  const netB = b.forecast.expectedNet ?? Infinity;
  return netA - netB;
}

function formatPercent(value: number | null): string {
  return value !== null ? `${Math.round(value * 100)}%` : '—';
}

const columns: ColumnDef<YutaiForecastListItem>[] = [
  {
    id: 'company',
    header: '銘柄',
    accessorFn: (row) => row.companyName ?? row.ticker,
    cell: ({ row }) => (
      <Link to={`/yutai/${row.original.ticker}/forecast`}>
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
    accessorKey: 'closePrice',
    header: '前日株価',
    sortDescFirst: false,
    sortingFn: (rowA, rowB) => {
      const a = rowA.original.closePrice;
      const b = rowB.original.closePrice;
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return a - b;
    },
    cell: ({ row }) => (row.original.closePrice !== null ? formatFinancialYen(String(row.original.closePrice)) : '—'),
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
    id: 'pOccur',
    header: '発生確率',
    accessorFn: (row) => row.forecast.pOccur,
    sortDescFirst: true,
    cell: ({ row }) => formatPercent(row.original.forecast.pOccur),
  },
  {
    id: 'forecastP50',
    header: '想定逆日歩',
    accessorFn: (row) => row.forecast.forecastP50,
    sortDescFirst: true,
    cell: ({ row }) =>
      row.original.forecast.forecastP50 !== null ? formatFinancialYen(String(row.original.forecast.forecastP50)) : '—',
  },
  {
    id: 'forecastP90',
    header: '最悪想定',
    accessorFn: (row) => row.forecast.forecastP90,
    sortDescFirst: true,
    cell: ({ row }) =>
      row.original.forecast.forecastP90 !== null ? formatFinancialYen(String(row.original.forecast.forecastP90)) : '—',
  },
  {
    id: 'judgment',
    header: '判定',
    accessorFn: (row) => row.forecast.forecastStatus,
    sortingFn: (rowA, rowB) =>
      FORECAST_STATUS_SORT_RANK[rowA.original.forecast.forecastStatus] - FORECAST_STATUS_SORT_RANK[rowB.original.forecast.forecastStatus],
    cell: ({ row }) => (
      <span className={`risk-badge risk-badge--${row.original.forecast.forecastStatus}`}>
        {FORECAST_STATUS_LABEL[row.original.forecast.forecastStatus]}
      </span>
    ),
  },
  {
    id: 'basis',
    header: '根拠',
    accessorFn: (row) => row.forecast.tickerSamples + row.forecast.poolSamples,
    cell: ({ row }) => (
      <>
        銘柄{row.original.forecast.tickerSamples}件＋市場{row.original.forecast.poolSamples}件
        {row.original.forecast.scenario === 'current-tse' && <span className="basis-badge">参考</span>}
      </>
    ),
  },
];

const KEYWORD_DEBOUNCE_MS = 400;

// keywordのstateをこの専用の子コンポーネントに閉じ込める。親(YutaiForecastListPage)に
// keyword自体を持たせると、1文字打つたびに親全体(数百行のテーブルを含む)が再レンダー
// され、行モデルの中身は変わらなくてもJSXツリーの再構築・差分比較コストがスマホで
// 無視できないほど重くなる。onChangeはデバウンス後にしか呼ばれないため、親は実際に
// 検索条件が変わった時だけ再レンダーすればよい。
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

// 実運用では「危険を除いたものを見て購入判断する」使い方になるため、危険だけ
// デフォルトで外し、注意・安全・対象外はデフォルトで選択しておく。
const DEFAULT_STATUSES: ReadonlySet<YutaiForecastStatus> = new Set(['caution', 'safe', 'na']);
const ALL_STATUSES: readonly YutaiForecastStatus[] = ['danger', 'caution', 'safe', 'na'];

export function YutaiForecastListPage() {
  const navigate = useNavigate();
  const defaultRange = monthRange();
  const [rightsDateFrom, setRightsDateFrom] = useState(defaultRange.from);
  const [rightsDateTo, setRightsDateTo] = useState(defaultRange.to);
  const [debouncedKeyword, setDebouncedKeyword] = useState('');
  const [selectedStatuses, setSelectedStatuses] = useState<ReadonlySet<YutaiForecastStatus>>(DEFAULT_STATUSES);

  // 判定はチェックボックスでの複数選択(クライアント側フィルタ)にしたため、APIには
  // forecastStatusを渡さず常に全件取得する。チェックボックスの切り替えはネットワーク
  // 往復無しで即座に反映される。
  const listState = useAsync(
    () => fetchYutaiForecastList({ rightsDateFrom, rightsDateTo, keyword: debouncedKeyword || undefined }),
    [rightsDateFrom, rightsDateTo, debouncedKeyword],
  );

  function toggleStatus(status: YutaiForecastStatus) {
    setSelectedStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  // listState.dataまたはselectedStatusesが変わった時だけ絞り込み・並べ替える。ここを
  // useMemoしないとkeyword入力のたびの再レンダーで毎回新しい配列を作ってしまい、
  // useReactTableが「新しいdata」と見なして内部の行モデルを毎回作り直す(検索結果が
  // 多いとスマホで固まって見えるほど重い)。既存のYutaiListPageはlistState.data?.tickers
  // をそのまま渡していて参照が安定しているため、この問題が起きない。
  const sortedTickers = useMemo(
    () =>
      (listState.data?.tickers ?? [])
        .filter((t) => selectedStatuses.has(t.forecast.forecastStatus))
        .sort(compareByDefaultOrder),
    [listState.data, selectedStatuses],
  );

  const table = useReactTable({
    data: sortedTickers,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <>
      <h1 className="page-title">逆日歩予測</h1>
      <p className="page-subtitle">過去の権利日実績から、次回権利日に実際に付きそうな逆日歩を予測します。</p>

      {listState.data && (
        <div className="cutoff-banner">
          <span>📅</span>
          <span>
            当月の権利付き最終日: <strong>{listState.data.currentMonthLastTradableDate}</strong>
          </span>
          {listState.data.poolComputedAt && (
            <span style={{ color: 'var(--text-muted)' }}>(プール統計の計算日: {listState.data.poolComputedAt})</span>
          )}
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
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.6rem' }}>
          判定:
          {ALL_STATUSES.map((status) => (
            <label key={status} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontWeight: 400 }}>
              <input type="checkbox" checked={selectedStatuses.has(status)} onChange={() => toggleStatus(status)} />
              {FORECAST_STATUS_LABEL[status]}
            </label>
          ))}
        </span>
      </div>

      {listState.loading && <StatusNote kind="loading" message="読み込み中…" />}
      {listState.error && <StatusNote kind="error" message={`取得に失敗しました: ${listState.error.message}`} />}
      {listState.data && sortedTickers.length === 0 && (
        <StatusNote kind="empty" message="条件に一致する優待銘柄がありません。" />
      )}

      {listState.data && sortedTickers.length > 0 && (
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
                <tr
                  key={row.id}
                  onClick={() => navigate(`/yutai/${row.original.ticker}/forecast`)}
                  style={{ cursor: 'pointer' }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className={
                        cell.column.id === 'value' ||
                        cell.column.id === 'maxGyakuhibu' ||
                        cell.column.id === 'rightsDate' ||
                        cell.column.id === 'pOccur' ||
                        cell.column.id === 'forecastP50' ||
                        cell.column.id === 'forecastP90'
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
