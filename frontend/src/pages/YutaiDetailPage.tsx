import { Link, useParams } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import * as HoverCard from '@radix-ui/react-hover-card';
import { fetchYutaiDetail, fetchYutaiMarginTrend } from '../api/client';
import { StatusNote } from '../components/StatusNote';
import { formatFinancialYen, formatPrice, formatVolume } from '../lib/format';
import { useAsync } from '../lib/useAsync';

export function YutaiDetailPage() {
  const { ticker } = useParams<{ ticker: string }>();

  const detailState = useAsync(async () => {
    if (!ticker) throw new Error('ticker is missing');
    return fetchYutaiDetail(ticker);
  }, [ticker]);

  const trendState = useAsync(async () => {
    if (!ticker) throw new Error('ticker is missing');
    return fetchYutaiMarginTrend(ticker);
  }, [ticker]);

  if (detailState.loading) return <StatusNote kind="loading" message="読み込み中…" />;
  if (detailState.error) return <StatusNote kind="error" message={`取得に失敗しました: ${detailState.error.message}`} />;
  if (!detailState.data) return null;

  const { data } = detailState;
  const riskLabel = { safe: '安全', danger: '危険', na: '対象外' }[data.risk.riskStatus];

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 className="page-title">
          {data.companyName ?? data.ticker} <span className="ticker-card__code">{data.ticker}</span>
        </h1>
        <Link to={`/tickers/${data.ticker}`} style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
          既存の個別銘柄画面を見る →
        </Link>
      </div>

      <div className="section-heading">銘柄基本情報</div>
      <div className="card summary-grid">
        <div className="summary-item">
          <div className="summary-item__label">前日終値</div>
          <div className="summary-item__value">{formatPrice(data.basicInfo.closePrice)}</div>
        </div>
        <div className="summary-item">
          <div className="summary-item__label">出来高</div>
          <div className="summary-item__value">{formatVolume(data.basicInfo.volume)}</div>
        </div>
        <div className="summary-item">
          <div className="summary-item__label">PER</div>
          <div className="summary-item__value">{data.basicInfo.per !== null ? `${data.basicInfo.per.toFixed(1)}倍` : '—'}</div>
        </div>
        <div className="summary-item">
          <div className="summary-item__label">決算サマリ</div>
          <div className="summary-item__value" style={{ fontSize: '0.85rem', lineHeight: 1.6 }}>
            売上 {formatFinancialYen(data.basicInfo.sales ?? undefined)}
            <br />
            営業利益 {formatFinancialYen(data.basicInfo.operatingProfit ?? undefined)}
            <br />
            純利益 {formatFinancialYen(data.basicInfo.netProfit ?? undefined)}
            <br />
            EPS {data.basicInfo.eps ?? '—'}
          </div>
        </div>
      </div>

      <div className="section-heading">優待内容</div>
      <div className="card">
        <p style={{ margin: '0 0 0.75rem' }}>{data.content}</p>
        <div className="summary-grid">
          <div className="summary-item">
            <div className="summary-item__label">優待価値</div>
            <div className="summary-item__value">{formatFinancialYen(String(data.value))}</div>
          </div>
          <div className="summary-item">
            <div className="summary-item__label">権利日</div>
            <div className="summary-item__value">{data.rightsDate ?? '—'}</div>
          </div>
        </div>
      </div>

      <div className="section-heading">逆日歩リスク計算</div>
      <div className="card">
        <div className="summary-item__label">最大逆日歩(概算・次回権利日の予測)</div>
        {data.risk.maxGyakuhibu !== null ? (
          <HoverCard.Root openDelay={0}>
            <HoverCard.Trigger asChild>
              <div tabIndex={0} className="gyakuhibu-hover summary-item__value">
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

      <div className="section-heading">信用残トレンド(過去1年)</div>
      {trendState.loading && <StatusNote kind="loading" message="読み込み中…" />}
      {trendState.error && (
        <StatusNote kind="error" message={`取得に失敗しました: ${trendState.error.message}`} />
      )}
      {trendState.data && trendState.data.points.length === 0 && (
        <StatusNote kind="empty" message="まだ信用残データがありません(取得中です)。" />
      )}
      {trendState.data && trendState.data.points.length > 0 && (
        <div className="card" style={{ height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trendState.data.points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} width={64} />
              <ChartTooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 12 }} />
              <Line type="monotone" dataKey="lendingBalance" stroke="var(--accent)" dot={false} name="貸株残" />
              <Line type="monotone" dataKey="financingBalance" stroke="var(--text-muted)" dot={false} name="融資残" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </>
  );
}
