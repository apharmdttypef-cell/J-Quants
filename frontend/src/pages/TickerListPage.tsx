import { Link } from 'react-router-dom';
import { fetchPrices, fetchTickers } from '../api/client';
import type { PricesResponse, WatchlistTicker } from '../api/types';
import { Sparkline } from '../components/Sparkline';
import { StatusNote } from '../components/StatusNote';
import { formatPercent, formatPrice, trendClass } from '../lib/format';
import { useAsync } from '../lib/useAsync';

interface TickerRow {
  ticker: WatchlistTicker;
  prices: PricesResponse | undefined;
}

function changePercent(prices: PricesResponse | undefined): number | null {
  const closes = (prices?.prices ?? []).map((p) => p.close).filter((c): c is number => c !== null);
  if (closes.length < 2) return null;
  const [first] = closes;
  const last = closes[closes.length - 1];
  if (first === 0) return null;
  return ((last - first) / first) * 100;
}

async function loadRows(tickers: WatchlistTicker[]): Promise<TickerRow[]> {
  const results = await Promise.all(
    tickers.map(async (ticker) => {
      try {
        const prices = await fetchPrices(ticker.ticker);
        return { ticker, prices };
      } catch {
        return { ticker, prices: undefined };
      }
    }),
  );
  return results;
}

export function TickerListPage() {
  const tickersState = useAsync(async () => (await fetchTickers()).tickers, []);
  const rowsState = useAsync(
    () => (tickersState.data ? loadRows(tickersState.data) : Promise.resolve([])),
    [tickersState.data],
  );

  return (
    <>
      <h1 className="page-title">銘柄一覧</h1>
      <p className="page-subtitle">ウォッチリストに登録した銘柄の直近の値動きです。</p>
      <div className="disclaimer-banner">データはJ-Quants Freeプランの制約により12週間遅延しています</div>

      {tickersState.loading && <StatusNote kind="loading" message="読み込み中…" />}
      {tickersState.error && <StatusNote kind="error" message={`取得に失敗しました: ${tickersState.error.message}`} />}
      {tickersState.data && tickersState.data.length === 0 && (
        <StatusNote kind="empty" message="ウォッチリストが空です。「ウォッチリスト管理」から銘柄を追加してください。" />
      )}

      {tickersState.data && tickersState.data.length > 0 && (
        <div className="card-grid">
          {(rowsState.data ?? tickersState.data.map((ticker) => ({ ticker, prices: undefined }))).map(({ ticker, prices }) => {
            const latest = prices?.prices[prices.prices.length - 1];
            const change = changePercent(prices);
            const volumes = (prices?.prices ?? []).map((p) => p.volume).filter((v): v is number => v !== null);

            return (
              <Link key={ticker.ticker} to={`/tickers/${ticker.ticker}`} className="card ticker-card">
                <div className="ticker-card__head">
                  <span className="ticker-card__code">{ticker.ticker}</span>
                  {change !== null && <span className={`pct ${trendClass(change)}`}>{formatPercent(change)}</span>}
                </div>
                <p className="ticker-card__name">{ticker.companyName ?? '(会社名未取得)'}</p>
                <div className="ticker-card__price">{latest ? formatPrice(latest.close) : '—'}</div>
                {volumes.length >= 2 && (
                  <div style={{ marginTop: '0.5rem' }}>
                    <Sparkline values={volumes} />
                  </div>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
