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
