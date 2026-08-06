import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchPrices, fetchTickers } from '../api/client';
import type { PricesResponse, WatchlistTicker } from '../api/types';
import { StatusNote } from '../components/StatusNote';
import { formatPercent, formatPrice, formatVolume, trendClass } from '../lib/format';
import { useAsync } from '../lib/useAsync';

interface ScreeningRow {
  ticker: WatchlistTicker;
  latestClose: number | null;
  changePercent: number | null;
  latestVolume: number | null;
  volumeSpikeRatio: number | null;
}

function toRow(ticker: WatchlistTicker, prices: PricesResponse | undefined): ScreeningRow {
  const points = prices?.prices ?? [];
  const closes = points.map((p) => p.close).filter((c): c is number => c !== null);
  const volumes = points.map((p) => p.volume).filter((v): v is number => v !== null);

  const changePercent =
    closes.length >= 2 && closes[0] !== 0 ? ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100 : null;

  const latestVolume = volumes.length > 0 ? volumes[volumes.length - 1] : null;
  const priorFive = volumes.slice(-6, -1);
  const priorAvg = priorFive.length > 0 ? priorFive.reduce((sum, v) => sum + v, 0) / priorFive.length : null;
  const volumeSpikeRatio = latestVolume !== null && priorAvg ? latestVolume / priorAvg : null;

  return { ticker, latestClose: closes[closes.length - 1] ?? null, changePercent, latestVolume, volumeSpikeRatio };
}

async function loadRows(tickers: WatchlistTicker[]): Promise<ScreeningRow[]> {
  return Promise.all(
    tickers.map(async (ticker) => {
      try {
        return toRow(ticker, await fetchPrices(ticker.ticker));
      } catch {
        return toRow(ticker, undefined);
      }
    }),
  );
}

const SPIKE_THRESHOLDS = [1.5, 2, 3];

export function ScreeningPage() {
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [spikeOnly, setSpikeOnly] = useState(false);
  const [spikeThreshold, setSpikeThreshold] = useState(1.5);

  const tickersState = useAsync(async () => (await fetchTickers()).tickers, []);
  const rowsState = useAsync(
    () => (tickersState.data ? loadRows(tickersState.data) : Promise.resolve([])),
    [tickersState.data],
  );

  const rows = useMemo(() => {
    const base = rowsState.data ?? [];
    const filtered = spikeOnly ? base.filter((r) => (r.volumeSpikeRatio ?? 0) >= spikeThreshold) : base;
    return [...filtered].sort((a, b) => {
      const av = a.changePercent ?? -Infinity;
      const bv = b.changePercent ?? -Infinity;
      return sortOrder === 'desc' ? bv - av : av - bv;
    });
  }, [rowsState.data, spikeOnly, spikeThreshold, sortOrder]);

  return (
    <>
      <h1 className="page-title">簡易スクリーニング</h1>
      <p className="page-subtitle">直近12週間の騰落率と出来高の変化でウォッチリストを絞り込みます。</p>
      <div className="disclaimer-banner">
        データはJ-Quants Freeプランの制約により12週間遅延・長期トレンドやバリュエーション系の指標は対象外です
      </div>

      <div className="filter-bar">
        <label>
          並び順:{' '}
          <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value as 'desc' | 'asc')}>
            <option value="desc">騰落率 高い順</option>
            <option value="asc">騰落率 低い順</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={spikeOnly} onChange={(e) => setSpikeOnly(e.target.checked)} /> 出来高急増銘柄のみ
        </label>
        <label>
          直近5日平均比:{' '}
          <select
            value={spikeThreshold}
            onChange={(e) => setSpikeThreshold(Number(e.target.value))}
            disabled={!spikeOnly}
          >
            {SPIKE_THRESHOLDS.map((t) => (
              <option key={t} value={t}>
                {t}倍以上
              </option>
            ))}
          </select>
        </label>
      </div>

      {tickersState.loading && <StatusNote kind="loading" message="読み込み中…" />}
      {tickersState.error && <StatusNote kind="error" message={`取得に失敗しました: ${tickersState.error.message}`} />}
      {tickersState.data && tickersState.data.length === 0 && (
        <StatusNote kind="empty" message="ウォッチリストが空です。「ウォッチリスト管理」から銘柄を追加してください。" />
      )}
      {tickersState.data && tickersState.data.length > 0 && rows.length === 0 && !rowsState.loading && (
        <StatusNote kind="empty" message="条件に一致する銘柄がありません。" />
      )}

      {rows.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>銘柄</th>
                <th>直近終値</th>
                <th>12週騰落率</th>
                <th>直近出来高</th>
                <th>5日平均比</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.ticker.ticker}>
                  <td>
                    <Link to={`/tickers/${row.ticker.ticker}`}>
                      {row.ticker.companyName ?? row.ticker.ticker}{' '}
                      <span className="ticker-card__code">{row.ticker.ticker}</span>
                    </Link>
                  </td>
                  <td className="num">{formatPrice(row.latestClose)}</td>
                  <td>
                    <span className={`pct ${trendClass(row.changePercent)}`}>{formatPercent(row.changePercent)}</span>
                  </td>
                  <td className="num">{formatVolume(row.latestVolume)}</td>
                  <td className="num">{row.volumeSpikeRatio !== null ? `${row.volumeSpikeRatio.toFixed(2)}x` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
