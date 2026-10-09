import { useEffect, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import type { YutaiCrossEligible, YutaiCrossFields } from '../api/types';
import { formatFinancialYen } from './format';

// 長期保有の要否。保存値は2つあり、crossEligible(権利日だけの保有=1回のクロスで取れるか)と
// holdingKind(長期保有の条件が「必須」か「上乗せ」か)を組み合わせて表示する。
//   none     不要: 保有期間の条件が無い
//   bonus    優遇のみ: 無くても貰えるが、長期保有なら上乗せ(クロスでは上乗せ分は取れない)
//   required 必須: 長期保有者限定(クロスでは取れない)
//   unknown  不明
export type HoldingRequirement = 'none' | 'bonus' | 'required' | 'unknown';

const HOLDING_LABEL: Record<HoldingRequirement, string> = {
  none: '不要',
  bonus: '優遇のみ',
  required: '必須',
  unknown: '不明',
};
// 避けたい銘柄(必須)を先頭に出せる順。
const HOLDING_SORT_RANK: Record<HoldingRequirement, number> = { required: 0, bonus: 1, none: 2, unknown: 3 };
const HOLDING_BADGE_CLASS: Record<HoldingRequirement, string> = {
  none: 'risk-badge risk-badge--safe',
  bonus: 'risk-badge risk-badge--safe',
  required: 'risk-badge risk-badge--danger',
  unknown: 'risk-badge risk-badge--na',
};

type HoldingFields = Pick<YutaiCrossFields, 'crossEligible' | 'holdingKind' | 'holdingMinMonths' | 'benefitParseWarning'>;

// 一覧ページのバッジと個別ページの解析が食い違っている銘柄は、保存値の優先順位
// (個別ページ優先)は変えずに、表示だけ安全側に倒して「不明」にする。誤りの
// コストが非対称だから — 誤った「不要」はクロスして逆日歩を払った上で優待が
// 取れないが、誤った「必須」は機会損失で済む。
function isBadgeMismatch(fields: HoldingFields): boolean {
  return fields.benefitParseWarning !== null && fields.benefitParseWarning.includes('badge-mismatch');
}

export function holdingRequirement(fields: HoldingFields): HoldingRequirement {
  if (isBadgeMismatch(fields)) return 'unknown';
  if (fields.crossEligible === 'ng') return 'required';
  if (fields.crossEligible === 'unknown') return 'unknown';
  return fields.holdingKind === 'bonus' ? 'bonus' : 'none';
}

// 長期保有のバッジ(+必須なら最低保有月数)。一覧の列と詳細ページで共用する。
export function HoldingBadge({ fields }: { fields: HoldingFields }) {
  const requirement = holdingRequirement(fields);
  const months =
    requirement === 'required' && fields.holdingKind === 'required' && fields.holdingMinMonths !== null
      ? `${fields.holdingMinMonths}ヶ月`
      : null;
  // 食い違いによる「不明」は、データが無いだけの「不明」と区別して目立たせる。
  const className = isBadgeMismatch(fields) ? 'risk-badge risk-badge--caution' : HOLDING_BADGE_CLASS[requirement];
  return (
    <>
      <span className={className}>{HOLDING_LABEL[requirement]}</span>
      {months !== null && <span className="cross-months">{months}</span>}
    </>
  );
}

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
      header: '長期保有',
      accessorFn: (row) => holdingRequirement(row),
      sortingFn: (rowA, rowB) =>
        HOLDING_SORT_RANK[holdingRequirement(rowA.original)] - HOLDING_SORT_RANK[holdingRequirement(rowB.original)],
      cell: ({ row }) => (
        <>
          <HoldingBadge fields={row.original} />
          {/* 解析が不完全な銘柄は詳細ページで原文を確かめてほしい */}
          {row.original.benefitParseWarning !== null && (
            <span className="cross-warning" title={row.original.benefitParseWarning}>⚠</span>
          )}
        </>
      ),
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
              // 単元株数は銘柄ごとの値をそのまま出す。「100株」と決め打ちすると、
              // 移行期にunitSharesが200/300のまま残っている行で嘘の数字を出してしまう。
              <span
                className="gyakuhibu-note"
                title={`必要株数が未取得のため単元株数(${row.original.unitShares.toLocaleString('ja-JP')}株)で概算しています`}
              >
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

type CrossNumericFilters = Omit<CrossFilterState, 'crossEligible'>;

function pickNumeric(state: CrossFilterState): CrossNumericFilters {
  return {
    priceMin: state.priceMin,
    priceMax: state.priceMax,
    investmentMin: state.investmentMin,
    investmentMax: state.investmentMax,
  };
}

function sameNumeric(a: CrossNumericFilters, b: CrossNumericFilters): boolean {
  return (
    a.priceMin === b.priceMin &&
    a.priceMax === b.priceMax &&
    a.investmentMin === b.investmentMin &&
    a.investmentMax === b.investmentMax
  );
}

// 数値欄からのAPI呼び出し用デバウンス(ms)。同じ画面のキーワード欄と同じ理由で必要 —
// 無しだと必要資金に「400000」と打つ間に全表スキャンのリクエストが6回走る
// (逆日歩予測画面はmaster+forecastの2スキャンなので12回)。キーワード欄に合わせて400ms。
const NUMERIC_DEBOUNCE_MS = 400;

// 入力中の値はこのコンポーネントが持ち、デバウンス後に親へ渡す(キーワード欄の
// KeywordFilterInputと同じ仕組み)。親のstateが1文字ごとに変わると、親のuseAsyncの
// 依存配列が変わって打つたびにリクエストが飛ぶ。
//
// onChangeは更新関数を受ける形にしてある。親のsetStateをそのまま渡せる(=参照が安定する)
// ので、デバウンスのタイマーが親の再レンダーごとに張り替わらない。
export function YutaiCrossFilters({
  state,
  onChange,
}: {
  state: CrossFilterState;
  onChange: (update: (prev: CrossFilterState) => CrossFilterState) => void;
}) {
  const [numeric, setNumeric] = useState<CrossNumericFilters>(() => pickNumeric(state));

  useEffect(() => {
    const timer = setTimeout(() => {
      // 中身が同じなら同じオブジェクトを返してReactの再レンダーを省く(初回マウント時の
      // 空振り対策)。
      onChange((prev) => (sameNumeric(prev, numeric) ? prev : { ...prev, ...numeric }));
    }, NUMERIC_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [numeric, onChange]);

  const updateNumeric = (patch: Partial<CrossNumericFilters>) => setNumeric((prev) => ({ ...prev, ...patch }));

  return (
    <>
      <label>
        株価:{' '}
        <input
          type="number"
          className="input input--narrow"
          value={numeric.priceMin}
          onChange={(e) => updateNumeric({ priceMin: e.target.value })}
          placeholder="下限"
        />
        {' 〜 '}
        <input
          type="number"
          className="input input--narrow"
          value={numeric.priceMax}
          onChange={(e) => updateNumeric({ priceMax: e.target.value })}
          placeholder="上限"
        />
      </label>
      <label>
        必要資金:{' '}
        <input
          type="number"
          className="input input--narrow"
          value={numeric.investmentMin}
          onChange={(e) => updateNumeric({ investmentMin: e.target.value })}
          placeholder="下限"
        />
        {' 〜 '}
        <input
          type="number"
          className="input input--narrow"
          value={numeric.investmentMax}
          onChange={(e) => updateNumeric({ investmentMax: e.target.value })}
          placeholder="上限"
        />
      </label>
      <label>
        長期保有:{' '}
        {/* <select>は1操作で値が確定するのでデバウンスしない(待たせる意味がない)。 */}
        <select
          value={state.crossEligible}
          onChange={(e) => {
            const crossEligible = e.target.value as CrossFilterState['crossEligible'];
            onChange((prev) => ({ ...prev, crossEligible }));
          }}
        >
          <option value="all">すべて</option>
          {/* APIの絞り込みはcrossEligible単位なので、「不要」と「優遇のみ」はまとめて扱う */}
          <option value="ok">不要・優遇のみ(クロスで取得可)</option>
          <option value="ng">必須(クロス不可)</option>
          <option value="unknown">不明</option>
        </select>
      </label>
    </>
  );
}
