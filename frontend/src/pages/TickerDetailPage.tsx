import { useParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ApiError, fetchPrices, fetchSummary, fetchTickers } from '../api/client';
import { StatusNote } from '../components/StatusNote';
import { formatFinancialYen, formatPrice, formatVolume } from '../lib/format';
import { useAsync } from '../lib/useAsync';

interface CandleShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: { open: number; close: number; high: number; low: number };
}

function Candle({ x = 0, y = 0, width = 0, height = 0, payload }: CandleShapeProps) {
  if (!payload) return null;
  const { open, close, high, low } = payload;
  const isUp = close >= open;
  const color = isUp ? 'var(--up)' : 'var(--down)';
  const span = high - low || 1;
  const priceToY = (price: number) => y + ((high - price) / span) * height;
  const bodyTop = priceToY(Math.max(open, close));
  const bodyBottom = priceToY(Math.min(open, close));
  const centerX = x + width / 2;

  return (
    <g>
      <line x1={centerX} x2={centerX} y1={y} y2={y + height} stroke={color} strokeWidth={1} />
      <rect x={x} y={bodyTop} width={width} height={Math.max(bodyBottom - bodyTop, 1)} fill={color} />
    </g>
  );
}

export function TickerDetailPage() {
  const { ticker } = useParams<{ ticker: string }>();

  const detailState = useAsync(async () => {
    if (!ticker) throw new Error('ticker is missing');
    const [{ tickers }, prices] = await Promise.all([fetchTickers(), fetchPrices(ticker)]);
    return { meta: tickers.find((t) => t.ticker === ticker), prices };
  }, [ticker]);

  const summaryState = useAsync(async () => {
    if (!ticker) return undefined;
    try {
      return await fetchSummary(ticker);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return undefined;
      throw error;
    }
  }, [ticker]);

  if (detailState.loading) return <StatusNote kind="loading" message="読み込み中…" />;
  if (detailState.error) return <StatusNote kind="error" message={`取得に失敗しました: ${detailState.error.message}`} />;
  if (!detailState.data) return null;

  const { meta, prices } = detailState.data;
  const chartData = prices.prices
    .filter((p) => p.open !== null && p.high !== null && p.low !== null && p.close !== null)
    .map((p) => ({ date: p.date.slice(5), open: p.open!, high: p.high!, low: p.low!, close: p.close!, volume: p.volume }));

  return (
    <>
      <h1 className="page-title">
        {meta?.companyName ?? ticker} <span className="ticker-card__code">{ticker}</span>
      </h1>
      <p className="page-subtitle">直近12週間の値動きと直近決算のサマリです。</p>
      <div className="disclaimer-banner">データはJ-Quants Freeプランの制約により12週間遅延しています</div>

      {chartData.length === 0 ? (
        <StatusNote kind="empty" message="まだ価格データがありません。次回バッチ取得をお待ちください。" />
      ) : (
        <>
          <div className="section-heading">値動き(ローソク足)</div>
          <div className="card" style={{ height: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                <YAxis
                  domain={[(dataMin: number) => dataMin * 0.98, (dataMax: number) => dataMax * 1.02]}
                  tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                  width={56}
                />
                <Tooltip
                  contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 12 }}
                  formatter={(value, name) => [formatPrice(Number(value)), String(name)]}
                />
                <Bar dataKey="high" shape={Candle} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="section-heading">出来高</div>
          <div className="card" style={{ height: 160 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} width={56} tickFormatter={(v) => formatVolume(v)} />
                <Tooltip
                  contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 12 }}
                  formatter={(value) => [formatVolume(Number(value)), '出来高']}
                />
                <Bar dataKey="volume" fill="var(--accent)" isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      <div className="section-heading">財務サマリ</div>
      {summaryState.loading && <StatusNote kind="loading" message="読み込み中…" />}
      {summaryState.error && (
        <StatusNote kind="error" message={`取得に失敗しました: ${summaryState.error.message}`} />
      )}
      {!summaryState.loading && !summaryState.error && !summaryState.data && (
        <StatusNote kind="empty" message="まだ決算データがありません(開示があるとバッチ取得で反映されます)。" />
      )}
      {summaryState.data && (
        <div className="card">
          <p className="page-subtitle" style={{ margin: '0 0 0.75rem' }}>
            {summaryState.data.discDate} 開示・{summaryState.data.curPerType}
          </p>
          <div className="summary-grid">
            <div className="summary-item">
              <div className="summary-item__label">売上高</div>
              <div className="summary-item__value">{formatFinancialYen(summaryState.data.sales)}</div>
            </div>
            <div className="summary-item">
              <div className="summary-item__label">営業利益</div>
              <div className="summary-item__value">{formatFinancialYen(summaryState.data.operatingProfit)}</div>
            </div>
            <div className="summary-item">
              <div className="summary-item__label">当期純利益</div>
              <div className="summary-item__value">{formatFinancialYen(summaryState.data.netProfit)}</div>
            </div>
            <div className="summary-item">
              <div className="summary-item__label">EPS</div>
              <div className="summary-item__value">{summaryState.data.eps || '—'}</div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
