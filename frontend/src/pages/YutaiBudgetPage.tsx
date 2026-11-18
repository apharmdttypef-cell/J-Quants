import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getLocalTradingCalendar, rightsDateForMonth, todayJst } from '../../../lambda/shared/trading-calendar';
import { fetchYutaiForecastList } from '../api/client';
import type { YutaiForecastListItem } from '../api/types';
import { StatusNote } from '../components/StatusNote';
import { RISK_STATUS_LABEL, riskStatusTitle } from '../lib/risk-status';
import { useAsync } from '../lib/useAsync';
import {
  addToCart,
  changeShares,
  defaultBudgetMonth,
  evaluateBudget,
  monthBounds,
  parseCash,
  removeFromCart,
  sortRows,
  visibleRows,
  type CartEntry,
  type ListRow,
  type SortDir,
  type SortKey,
} from '../lib/yutai-budget';

// 予算から探す。保有現金で買える優待銘柄を権利確定月ごとに一覧し、購入予定(カート)で株数を組み立てる。
// 保有現金と月はURLのクエリにだけ持ち、サーバーには保存しない。カートは画面内stateのみ。
// 設計: docs/superpowers/specs/2026-11-18-yutai-budget-design.md

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

function yen(value: number): string {
  return `${Math.round(value).toLocaleString('ja-JP')}円`;
}

function initialMonth(): number {
  const today = todayJst();
  const { from, to, year, month } = monthBounds(today);
  return defaultBudgetMonth(today, rightsDateForMonth(getLocalTradingCalendar(from, to), year, month, null));
}

function parseMonth(raw: string | null): number | null {
  const month = Number(raw);
  return Number.isInteger(month) && month >= 1 && month <= 12 ? month : null;
}

function StatusBadge({ item }: { item: YutaiForecastListItem }) {
  const status = item.forecast.forecastStatus;
  return (
    <span className={`risk-badge risk-badge--${status}`} title={riskStatusTitle(status)}>
      {RISK_STATUS_LABEL[status]}
    </span>
  );
}

const ROW_ACTION_LABEL: Record<ListRow<YutaiForecastListItem>['status'], string> = {
  affordable: '＋ 追加',
  inCart: '追加済み',
  unaffordable: '予算超過',
  unknown: '価格不明',
};

export function YutaiBudgetPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const cashText = searchParams.get('cash') ?? '';
  const month = parseMonth(searchParams.get('month')) ?? initialMonth();
  const cash = parseCash(cashText);

  const [cart, setCart] = useState<CartEntry[]>([]);
  const [showOver, setShowOver] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'cost', dir: 1 });

  // 判定は全銘柄をクライアント側で行う(月・現金を変えるたびにAPIを叩かない)。
  const listState = useAsync(() => fetchYutaiForecastList({}), []);

  const result = useMemo(
    () => evaluateBudget({ items: listState.data?.tickers ?? [], cart, cash, month }),
    [listState.data, cart, cash, month],
  );
  const rows = useMemo(
    () => sortRows(visibleRows(result.rows, showOver), sort.key, sort.dir),
    [result.rows, showOver, sort],
  );
  const affordableCount = result.rows.filter((r) => r.status === 'affordable').length;

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value === '') next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  }

  function changeMonth(value: string) {
    setParam('month', value);
    // 権利月が違う銘柄は同時に買う対象ではないので、月を切り替えたらカートを空にする
    setCart([]);
  }

  function toggleSort(key: SortKey) {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: key === 'cost' ? 1 : -1 }));
  }

  function sortArrow(key: SortKey): string {
    if (sort.key !== key) return '';
    return sort.dir === 1 ? ' ▲' : ' ▼';
  }

  function ariaSort(key: SortKey): 'ascending' | 'descending' | undefined {
    if (sort.key !== key) return undefined;
    return sort.dir === 1 ? 'ascending' : 'descending';
  }

  function add(item: YutaiForecastListItem) {
    setCart((prev) => addToCart(prev, item));
  }

  return (
    <>
      <p className="budget-back">
        <Link to="/yutai">← 優待クロス一覧</Link>
      </p>
      <h1 className="page-title">予算から探す</h1>
      <p className="page-subtitle">
        保有現金で買える優待銘柄を、権利確定月ごとに一覧します。必要資金 = 前日終値 × 株数(現物買い分のみ。信用売りの保証金・手数料・逆日歩は含みません)。
      </p>

      <section className="budget-inputs card">
        <label className="budget-field">
          <span>保有現金(円)</span>
          <input
            className="input budget-cash"
            type="text"
            inputMode="numeric"
            placeholder="1,000,000"
            value={cashText}
            onChange={(e) => setParam('cash', e.target.value)}
          />
        </label>
        <label className="budget-field">
          <span>権利確定月</span>
          <select className="input budget-month" value={month} onChange={(e) => changeMonth(e.target.value)}>
            {MONTHS.map((m) => (
              <option key={m} value={m}>
                {m}月
              </option>
            ))}
          </select>
        </label>
        <p className="budget-note">入力値はURLにだけ残り、サーバーには保存しません。</p>
      </section>

      <section className={`budget-cart${result.shortage ? ' budget-cart--over' : ''}`} aria-labelledby="budget-cart-title">
        <div className="budget-cart__bar">
          <h2 id="budget-cart-title" className="budget-cart__title">
            購入予定 <span className="budget-cart__count">{result.cartLines.length}銘柄</span>
          </h2>
          <dl className="budget-cart__totals">
            <div>
              <dt>保有現金</dt>
              <dd className="num">{cash === null ? '未入力' : yen(cash)}</dd>
            </div>
            <div>
              <dt>合計必要資金</dt>
              <dd className="num">{yen(result.cartTotal)}</dd>
            </div>
            <div className="budget-cart__remaining">
              <dt>残り予算</dt>
              <dd className="num">
                {result.remaining === null ? '—' : result.remaining < 0 ? `−${yen(-result.remaining)}` : yen(result.remaining)}
              </dd>
            </div>
          </dl>
        </div>
        {result.shortage && result.remaining !== null && (
          <p className="budget-cart__alert" role="alert">
            資金が{yen(-result.remaining)}不足しています。株数を減らすか、銘柄を外してください。
          </p>
        )}
        {result.cartLines.length === 0 ? (
          <p className="budget-cart__empty">下の銘柄一覧で銘柄をクリックすると、ここに追加されます。株数はここで変えられます。</p>
        ) : (
          <div className="budget-scroll">
            <table className="data-table budget-table">
              <thead>
                <tr>
                  <th>銘柄</th>
                  <th className="budget-left">優待内容</th>
                  <th>優待価値</th>
                  <th className="budget-center">株数</th>
                  <th>必要資金</th>
                  <th className="budget-left">判定</th>
                  <th>
                    <span className="visually-hidden">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.cartLines.map((line) => {
                  const name = line.item.companyName ?? line.item.ticker;
                  const unit = line.item.unitShares;
                  return (
                    <tr key={line.item.ticker}>
                      <td className="company-cell">
                        <Link to={`/yutai/${line.item.ticker}`} className="ticker-card__code">
                          {line.item.ticker}
                        </Link>
                        <div>{name}</div>
                      </td>
                      <td className="cell-wrap budget-left">{line.item.content}</td>
                      <td className="num">{line.item.value !== null ? yen(line.item.value) : '—'}</td>
                      <td className="budget-center">
                        <div className="budget-stepper">
                          <button
                            type="button"
                            className="btn budget-stepper__btn"
                            disabled={!line.canDecrease}
                            onClick={() => setCart((prev) => changeShares(prev, line.item, -1))}
                            aria-label={`${name}を${unit}株減らす`}
                          >
                            −
                          </button>
                          <span className="num budget-stepper__value">{line.shares.toLocaleString('ja-JP')}株</span>
                          <button
                            type="button"
                            className="btn budget-stepper__btn"
                            disabled={!line.canIncrease}
                            onClick={() => setCart((prev) => changeShares(prev, line.item, 1))}
                            aria-label={`${name}を${unit}株増やす`}
                          >
                            ＋
                          </button>
                        </div>
                        {line.shares > line.minShares && line.item.requiredShares !== null && (
                          <div className="budget-sub">優待は{line.item.requiredShares.toLocaleString('ja-JP')}株以上</div>
                        )}
                      </td>
                      <td className="num">
                        <strong>{yen(line.cost)}</strong>
                        <div className="budget-sub">@{yen(line.price.price)}/株</div>
                        {line.price.source === 'minInvestment' && <div className="budget-fallback">※終値なし・推定</div>}
                      </td>
                      <td className="budget-left">
                        <StatusBadge item={line.item} />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn budget-remove"
                          onClick={() => setCart((prev) => removeFromCart(prev, line.item.ticker))}
                          aria-label={`${name}を購入予定から外す`}
                        >
                          外す
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="budget-list-title">
        <div className="budget-list-head">
          <h2 id="budget-list-title" className="budget-list-title">
            {month}月の優待銘柄{' '}
            {listState.data && (
              <span className="budget-list-count">
                {cash === null ? `${result.rows.length}件` : `残り予算で買える ${affordableCount}件 / ${result.rows.length}件`}
              </span>
            )}
          </h2>
          <label className="budget-toggle">
            <input type="checkbox" checked={showOver} onChange={(e) => setShowOver(e.target.checked)} />
            予算超過の銘柄も表示(あと◯円)
          </label>
        </div>

        {listState.loading && <StatusNote kind="loading" message="読み込み中…" />}
        {listState.error && <StatusNote kind="error" message={`取得に失敗しました: ${listState.error.message}`} />}
        {listState.data && rows.length === 0 && (
          <StatusNote
            kind="empty"
            message={
              result.rows.length === 0
                ? `${month}月が権利確定月の優待銘柄はありません。`
                : 'この月に残り予算で買える銘柄はありません。「予算超過の銘柄も表示」で不足額を確認できます。'
            }
          />
        )}
        {listState.data && rows.length > 0 && (
          <div className="table-scroll">
            <table className="data-table budget-table">
              <thead>
                <tr>
                  <th>
                    <span className="visually-hidden">追加</span>
                  </th>
                  <th className="budget-left">銘柄</th>
                  <th className="budget-left">優待内容</th>
                  <th aria-sort={ariaSort('value')}>
                    <button type="button" className="budget-sort" onClick={() => toggleSort('value')}>
                      優待価値{sortArrow('value')}
                    </button>
                  </th>
                  <th>必要株数</th>
                  <th aria-sort={ariaSort('cost')}>
                    <button type="button" className="budget-sort" onClick={() => toggleSort('cost')}>
                      必要資金{sortArrow('cost')}
                    </button>
                  </th>
                  <th aria-sort={ariaSort('yield')}>
                    <button type="button" className="budget-sort" onClick={() => toggleSort('yield')}>
                      利回り{sortArrow('yield')}
                    </button>
                  </th>
                  <th className="budget-left">判定</th>
                  <th>最大逆日歩</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const name = row.item.companyName ?? row.item.ticker;
                  const addable = row.status === 'affordable';
                  return (
                    <tr
                      key={row.item.ticker}
                      className={`budget-row budget-row--${row.status}`}
                      // 行のどこをクリックしても追加できるようにする。キーボードでは先頭のボタンで追加する
                      onClick={addable ? () => add(row.item) : undefined}
                    >
                      <td>
                        <button
                          type="button"
                          className={`budget-add budget-add--${row.status}`}
                          disabled={!addable}
                          onClick={(e) => {
                            e.stopPropagation();
                            add(row.item);
                          }}
                          aria-label={addable ? `${name}を購入予定に追加` : `${name}(${ROW_ACTION_LABEL[row.status]})`}
                        >
                          {ROW_ACTION_LABEL[row.status]}
                        </button>
                      </td>
                      <td className="company-cell budget-left">
                        <span className="ticker-card__code">{row.item.ticker}</span>
                        <div>{name}</div>
                      </td>
                      <td className="cell-wrap budget-left">{row.item.content}</td>
                      <td className="num">{row.item.value !== null ? yen(row.item.value) : '—'}</td>
                      <td className="num">{row.minShares.toLocaleString('ja-JP')}株</td>
                      <td className="num">
                        {row.cost !== null ? yen(row.cost) : '—'}
                        {row.price?.source === 'minInvestment' && (
                          <div className="budget-fallback">※終値なし・kabuyutaiの必要投資金額</div>
                        )}
                        {row.shortfall !== null && <div className="budget-short">あと{yen(row.shortfall)}</div>}
                      </td>
                      <td className="num">{row.yieldPct !== null ? `${row.yieldPct.toFixed(2)}%` : '—'}</td>
                      <td className="budget-left">
                        <StatusBadge item={row.item} />
                      </td>
                      <td className="num">{row.item.maxGyakuhibu !== null ? yen(row.item.maxGyakuhibu) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="budget-note budget-footnote">
          一覧の必要資金・利回りは必要株数(単元に切り上げ)で計算した値で、購入予定で株数を変えても並び順は変わりません。株数を増やしても優待価値は必要株数の段階のままです。最大逆日歩は参考表示で、必要資金には含めません。
        </p>
      </section>
    </>
  );
}
