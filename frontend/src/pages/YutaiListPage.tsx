import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable } from '@tanstack/react-table';
import type { ColumnDef, VisibilityState } from '@tanstack/react-table';
import * as HoverCard from '@radix-ui/react-hover-card';
import { fetchYutaiForecastList } from '../api/client';
import type { YutaiForecastListItem, YutaiForecastStatus, YutaiTseForecast } from '../api/types';
import { StatusNote } from '../components/StatusNote';
import { formatFinancialYen } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { RISK_STATUS_LABEL, riskStatusTitle } from '../lib/risk-status';
import {
  crossColumns,
  EMPTY_CROSS_FILTERS,
  toCrossParams,
  YutaiCrossFilters,
  type CrossFilterState,
} from '../lib/yutai-cross';

// 優待クロス一覧。旧「優待クロス」(/yutai)と旧「逆日歩予測」(/yutai/forecast)を統合した画面。
// 判定の正本は逆日歩予測の判定(forecastStatus)で、APIもGET /yutai/forecastを使う。

// 列見出しの意味を説明する簡易ツールチップ。詳細ページのホバーカードと同じ
// gyakuhibu-hover/gyakuhibu-tooltipクラス(見た目・アニメーション)を再利用する。
function HeaderTooltip({ label, tooltip }: { label: string; tooltip: string }) {
  return (
    <HoverCard.Root openDelay={0}>
      <HoverCard.Trigger asChild>
        <span tabIndex={0} className="gyakuhibu-hover">
          {label}
        </span>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content className="gyakuhibu-tooltip" side="bottom" sideOffset={8}>
          {tooltip}
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

function monthRange(): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDay = new Date(y, m + 1, 0).getDate();
  return { from: `${y}-${pad(m + 1)}-01`, to: `${y}-${pad(m + 1)}-${pad(lastDay)}` };
}

// 判定は危険→注意→安全→制度信用不可→対象外の順に並ぶ方が意味があるため、
// 文字列の並び順ではなくこのランクでソートする。
const STATUS_SORT_RANK: Record<YutaiForecastStatus, number> = {
  danger: 0,
  caution: 1,
  safe: 2,
  'general-only': 3,
  na: 4,
};

// デフォルトソート: 判定ランク→expectedNet昇順(=優待価値と予測逆日歩の差が小さい=
// 危ないものが上に来る)。tanstack/react-tableの複数列初期ソートに頼らず、テーブルに
// 渡す前に配列を並べ替えておく(ヘッダークリックでの単一列ソートはこれとは独立に動く)。
function compareByDefaultOrder(a: YutaiForecastListItem, b: YutaiForecastListItem): number {
  const rankDiff = STATUS_SORT_RANK[a.forecast.forecastStatus] - STATUS_SORT_RANK[b.forecast.forecastStatus];
  if (rankDiff !== 0) return rankDiff;
  const netA = a.forecast.expectedNet ?? Infinity;
  const netB = b.forecast.expectedNet ?? Infinity;
  return netA - netB;
}

function formatPercent(value: number | null): string {
  return value !== null ? `${Math.round(value * 100)}%` : '—';
}

function formatYenOrDash(value: number | null): string {
  return value !== null ? formatFinancialYen(String(Math.round(value))) : '—';
}

// nullを末尾に固定する数値ソート(sortUndefined: 'last'と組み合わせてaccessorFnでundefinedを返す)。
function numberColumn(
  id: string,
  header: ColumnDef<YutaiForecastListItem>['header'],
  value: (row: YutaiForecastListItem) => number | null,
  sortDescFirst: boolean,
  format: (v: number | null) => string = formatYenOrDash,
): ColumnDef<YutaiForecastListItem> {
  return {
    id,
    header,
    accessorFn: (row) => value(row) ?? undefined,
    sortDescFirst,
    sortUndefined: 'last',
    cell: ({ row }) => format(value(row.original)),
  };
}

// lambda/shared/gyakuhibu-forecast.tsのBIN_EDGESと同じ6区分(順序=リスクの低い→高い)。
const BIN_LABELS = ['融資超過', '0〜0.5', '0.5〜1', '1〜2', '2〜5', '5以上'] as const;

function binIndex(label: string | null): number {
  return label === null ? -1 : BIN_LABELS.indexOf(label as (typeof BIN_LABELS)[number]);
}

// 現在需給のビンが過去実績のビンより悪い(順序で後ろ)か、過去実績が対象外で現在需給だけ
// 予測できている場合にtrue。一覧の「想定逆日歩(現在需給)」に↑を付ける判定。
function tseWorseThanHistory(item: YutaiForecastListItem): boolean {
  const tse = item.tseForecast;
  if (!tse || tse.bin === null) return false;
  if (item.forecast.forecastStatus === 'na' || item.forecast.bin === null) return true;
  return binIndex(tse.bin) > binIndex(item.forecast.bin);
}

function formatGrowth(value: number | null): string {
  return value !== null ? `${value.toFixed(1)}倍` : '—';
}

// 想定逆日歩(現在需給)セルのホバー内容。
function TseCellHover({ tse, children }: { tse: YutaiTseForecast; children: ReactNode }) {
  const ratio = tse.excessRatio !== null && Number.isFinite(tse.excessRatio) ? tse.excessRatio.toFixed(2) : '—';
  return (
    <HoverCard.Root openDelay={0}>
      <HoverCard.Trigger asChild>
        <span tabIndex={0} className="gyakuhibu-hover">
          {children}
        </span>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content className="gyakuhibu-tooltip" side="bottom" sideOffset={8}>
          <div>東証信用残 {tse.snapshotDate} 時点(権利日{tse.lagDays}日前)</div>
          <div>貸株超過率: {ratio}(ビン: {tse.bin ?? '—'})</div>
          <div>発生確率: {formatPercent(tse.pOccur)}</div>
          <div>想定逆日歩(最悪): {formatYenOrDash(tse.forecastP90)}</div>
          <div>現在需給の判定: {RISK_STATUS_LABEL[tse.forecastStatus]}</div>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

function buildColumns(tseEnabled: boolean): ColumnDef<YutaiForecastListItem>[] {
  const tseColumns: ColumnDef<YutaiForecastListItem>[] = tseEnabled
    ? [
        {
          id: 'tseForecastP50',
          header: () => (
            <HeaderTooltip
              label="想定逆日歩(現在需給)"
              tooltip="直近の東証信用残(融資残・貸株残)から求めた貸株超過率をもとに、過去の類似ケースの分布から算出した逆日歩の目安。過去実績ベースよりリスクが高い区分に入っていれば↑。スタンダードプラン限定の情報です。"
            />
          ),
          accessorFn: (row) => row.tseForecast?.forecastP50 ?? undefined,
          sortDescFirst: true,
          sortUndefined: 'last',
          cell: ({ row }) => {
            const tse = row.original.tseForecast;
            if (!tse || tse.forecastP50 === null) return '—';
            return (
              <TseCellHover tse={tse}>
                {formatYenOrDash(tse.forecastP50)}
                {tseWorseThanHistory(row.original) ? ' ↑' : ''}
              </TseCellHover>
            );
          },
        },
        numberColumn(
          'lendingGrowth4w',
          () => (
            <HeaderTooltip
              label="貸株残(4週前比)"
              tooltip="直近の東証貸株残が4週間前の何倍か。権利日に向けた空売りの積み上がりペースで、3倍以上の急増は逆日歩発生の先行シグナルです。スタンダードプラン限定の情報です。"
            />
          ),
          (row) => row.tseForecast?.lendingGrowth4w ?? null,
          true,
          formatGrowth,
        ),
      ]
    : [];

  return [
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
      id: 'rightsDate',
      header: '権利日',
      accessorFn: (row) => row.rightsDate ?? undefined,
      sortDescFirst: false,
      sortUndefined: 'last',
      cell: ({ row }) => row.original.rightsDate ?? '—',
    },
    {
      id: 'judgment',
      header: () => (
        <HeaderTooltip
          label="判定"
          tooltip="想定逆日歩(最悪)が最大逆日歩(入札上限)の何割か、で判定した目安。危険=50%以上、注意=20〜50%、安全=20%未満、制度信用不可=制度信用では売れない銘柄(逆日歩は付かない。一般信用の売り在庫は証券会社ごとに要確認)、対象外=過去実績が無く予測できない。優待価値は判定に使いません。"
        />
      ),
      accessorFn: (row) => row.forecast.forecastStatus,
      sortingFn: (rowA, rowB) =>
        STATUS_SORT_RANK[rowA.original.forecast.forecastStatus] - STATUS_SORT_RANK[rowB.original.forecast.forecastStatus],
      cell: ({ row }) => (
        <span
          className={`risk-badge risk-badge--${row.original.forecast.forecastStatus}`}
          title={riskStatusTitle(row.original.forecast.forecastStatus)}
        >
          {RISK_STATUS_LABEL[row.original.forecast.forecastStatus]}
        </span>
      ),
    },
    numberColumn(
      'forecastP90',
      () => (
        <HeaderTooltip
          label="想定逆日歩(最悪)"
          tooltip="過去の類似ケースの中でも悪い部類(上位1割)に入った場合を想定した逆日歩額。判定はこの金額が最大逆日歩の何割かで決まります。"
        />
      ),
      (row) => row.forecast.forecastP90,
      true,
    ),
    // ここから「詳細」表示でだけ出す列(DETAIL_ONLY_COLUMN_IDS)。
    numberColumn(
      'forecastP50',
      () => (
        <HeaderTooltip label="想定逆日歩" tooltip="過去の類似ケース(同程度の貸株超過率)の分布から算出した、実際に付きそうな逆日歩の目安(中央値)。" />
      ),
      (row) => row.forecast.forecastP50,
      true,
    ),
    ...tseColumns,
    numberColumn(
      'pOccur',
      () => (
        <HeaderTooltip label="発生確率" tooltip="貸株超過率が同程度だった過去のケースのうち、実際に逆日歩が発生した(0円ではなかった)割合。" />
      ),
      (row) => row.forecast.pOccur,
      true,
      formatPercent,
    ),
    numberColumn(
      'maxGyakuhibu',
      () => (
        <HeaderTooltip
          label="最大逆日歩"
          tooltip="理論上の上限額(入札で実際にここまで決着する確率はごく低い参考値)。株価・必要株数・品貸日数と、権利付き最終日の4倍ルールから算出しています。"
        />
      ),
      (row) => row.maxGyakuhibu,
      false,
    ),
    numberColumn(
      'closePrice',
      () => <HeaderTooltip label="前日株価" tooltip="直近の終値。最大逆日歩の計算に使っています。" />,
      (row) => row.closePrice,
      false,
    ),
    numberColumn(
      'value',
      () => <HeaderTooltip label="優待価値" tooltip="優待の金額換算(取得元の表記から抽出)。判定には使っていない参考値です。" />,
      (row) => row.value,
      true,
    ),
    // 必要株数・長期保有・必要資金・前回逆日歩
    ...crossColumns<YutaiForecastListItem>(),
  ];
}

// 「詳細」表示でだけ出す列。「基本」は判断に必要な8列(銘柄・優待内容・権利日・判定・
// 想定逆日歩(最悪)・長期保有・必要資金・前回逆日歩)に絞り、横幅が画面に収まるようにする。
const DETAIL_ONLY_COLUMN_IDS = [
  'forecastP50',
  'tseForecastP50',
  'lendingGrowth4w',
  'pOccur',
  'maxGyakuhibu',
  'closePrice',
  'value',
  'requiredShares',
] as const;

type ViewMode = 'basic' | 'detail';
const VIEW_MODE_STORAGE_KEY = 'yutai-list-view-mode';

// 表示モードはブラウザごとの好みなのでlocalStorageに覚える。プライベートウィンドウ等で
// 使えない場合は既定の「基本」で動く。
function loadViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_STORAGE_KEY) === 'detail' ? 'detail' : 'basic';
  } catch {
    return 'basic';
  }
}

function saveViewMode(mode: ViewMode): void {
  try {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // 保存できなくても表示は切り替わる
  }
}

const NUMERIC_COLUMN_IDS = new Set([
  'forecastP90',
  'forecastP50',
  'tseForecastP50',
  'lendingGrowth4w',
  'pOccur',
  'maxGyakuhibu',
  'closePrice',
  'value',
  'requiredShares',
  'requiredInvestment',
  'lastGyakuhibu',
]);

function cellClassName(columnId: string): string | undefined {
  if (NUMERIC_COLUMN_IDS.has(columnId)) return 'num';
  if (columnId === 'content') return 'cell-wrap';
  if (columnId === 'company') return 'company-cell';
  return undefined;
}

const KEYWORD_DEBOUNCE_MS = 400;

// keywordのstateをこの専用の子コンポーネントに閉じ込める。親にkeyword自体を持たせると、
// 1文字打つたびに親全体(数百行のテーブルを含む)が再レンダーされ、行モデルの中身は
// 変わらなくてもJSXツリーの再構築・差分比較コストがスマホで無視できないほど重くなる。
// onChangeはデバウンス後にしか呼ばれないため、親は実際に検索条件が変わった時だけ
// 再レンダーすればよい。
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
// デフォルトで外し、それ以外はデフォルトで選択しておく。
const DEFAULT_STATUSES: ReadonlySet<YutaiForecastStatus> = new Set(['caution', 'safe', 'general-only', 'na']);
const ALL_STATUSES: readonly YutaiForecastStatus[] = ['danger', 'caution', 'safe', 'general-only', 'na'];

export function YutaiListPage() {
  const navigate = useNavigate();
  const defaultRange = monthRange();
  const [rightsDateFrom, setRightsDateFrom] = useState(defaultRange.from);
  const [rightsDateTo, setRightsDateTo] = useState(defaultRange.to);
  const [debouncedKeyword, setDebouncedKeyword] = useState('');
  const [selectedStatuses, setSelectedStatuses] = useState<ReadonlySet<YutaiForecastStatus>>(DEFAULT_STATUSES);
  const [viewMode, setViewMode] = useState<ViewMode>(loadViewMode);

  const [crossFilters, setCrossFilters] = useState<CrossFilterState>(EMPTY_CROSS_FILTERS);

  // 判定はチェックボックスでの複数選択(クライアント側フィルタ)なので、APIには
  // forecastStatusを渡さず常に全件取得する。チェックボックスの切り替えはネットワーク
  // 往復無しで即座に反映される。
  // depsはオブジェクトを渡すと毎レンダーで参照が変わり無限ループになるため、
  // crossFiltersは個々の文字列に展開して並べる。
  // 数値欄(株価・必要資金)の値はYutaiCrossFilters側でデバウンスされてから届く。この画面は
  // 1リクエストでmaster+forecastの2スキャンを使うため、無しだと「400000」で12回スキャンが走る。
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

  function toggleStatus(status: YutaiForecastStatus) {
    setSelectedStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  function changeViewMode(mode: ViewMode) {
    setViewMode(mode);
    saveViewMode(mode);
  }

  // listState.dataまたはselectedStatusesが変わった時だけ絞り込み・並べ替える。ここを
  // useMemoしないとkeyword入力のたびの再レンダーで毎回新しい配列を作ってしまい、
  // useReactTableが「新しいdata」と見なして内部の行モデルを毎回作り直す(検索結果が
  // 多いとスマホで固まって見えるほど重い)。
  const sortedTickers = useMemo(
    () =>
      (listState.data?.tickers ?? [])
        .filter((t) => selectedStatuses.has(t.forecast.forecastStatus))
        .sort(compareByDefaultOrder),
    [listState.data, selectedStatuses],
  );

  const tseEnabled = listState.data?.features.tseMargin ?? false;
  const columns = useMemo(() => buildColumns(tseEnabled), [tseEnabled]);
  const columnVisibility = useMemo<VisibilityState>(
    () => Object.fromEntries(DETAIL_ONLY_COLUMN_IDS.map((id) => [id, viewMode === 'detail'])),
    [viewMode],
  );

  const table = useReactTable({
    data: sortedTickers,
    columns,
    state: { columnVisibility },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <>
      <h1 className="page-title">優待クロス</h1>
      <p className="page-subtitle">
        次回権利日に付きそうな逆日歩を過去の権利日実績から予測し、クロスの判断材料をまとめて表示します。
      </p>

      {listState.data && (
        <div className="cutoff-banner">
          <span>📅</span>
          <span>
            当月の権利付き最終日: <strong>{listState.data.currentMonthLastTradableDate}</strong>
          </span>
          <span style={{ color: 'var(--text-muted)' }}>(月末が権利確定日の銘柄はこの日までに買付が必要)</span>
          {listState.data.poolComputedAt && (
            <span style={{ color: 'var(--text-muted)' }}>(予測の計算日: {listState.data.poolComputedAt})</span>
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
              {RISK_STATUS_LABEL[status]}
            </label>
          ))}
        </span>
        <YutaiCrossFilters state={crossFilters} onChange={setCrossFilters} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.6rem' }}>
          表示:
          {(['basic', 'detail'] as const).map((mode) => (
            <label key={mode} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontWeight: 400 }}>
              <input type="radio" name="yutai-view-mode" checked={viewMode === mode} onChange={() => changeViewMode(mode)} />
              {mode === 'basic' ? '基本' : '詳細'}
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
                <tr key={row.id} onClick={() => navigate(`/yutai/${row.original.ticker}`)} style={{ cursor: 'pointer' }}>
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className={cellClassName(cell.column.id)}
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
