import { Link, useParams } from 'react-router-dom';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fetchYutaiForecastDetail, fetchYutaiMarginTrend } from '../api/client';
import type { YutaiForecast, YutaiForecastHistoryPoint, PoolBin } from '../api/types';
import { StatusNote } from '../components/StatusNote';
import { formatFinancialYen } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { GENERAL_ONLY_NOTE, RISK_STATUS_LABEL } from '../lib/risk-status';

const FORECAST_STATUS_LABEL = RISK_STATUS_LABEL;

// lambda/shared/gyakuhibu-forecast.tsのBIN_EDGESと同じ6区分。フロントはバックエンドの
// 純粋関数を直接importできない(別npmパッケージ)ため、この境界値をこのファイル内に複製する
// (既存の各Lambdaファイルが銘柄マッチングロジックを複製しているのと同じ方針)。
const BIN_LABELS = ['融資超過', '0〜0.5', '0.5〜1', '1〜2', '2〜5', '5以上'] as const;

function binLabelFor(ratio: number): string {
  if (ratio < 0) return '融資超過';
  if (ratio < 0.5) return '0〜0.5';
  if (ratio < 1) return '0.5〜1';
  if (ratio < 2) return '1〜2';
  if (ratio < 5) return '2〜5';
  return '5以上';
}

function formatPercent(value: number | null): string {
  return value !== null ? `${Math.round(value * 100)}%` : '—';
}

// excessRatioはfinancing=0の行(真の無限大/融資残0の無データ行)がどちらもnullに潰れて
// 届く(JSON.stringifyがInfinityをnullにするため)。同じ行のfinancingBalance/lendingBalance
// (常に有限数)から本当に無限大なのか(貸株残>0)、単にデータが無いのか(両方0)を区別する。
function excessRatioLabel(h: YutaiForecastHistoryPoint): string {
  if (h.financingBalance === 0 && h.lendingBalance > 0) return '∞';
  return h.excessRatio !== null ? h.excessRatio.toFixed(2) : '—';
}

function formatSignedYen(value: number | null): string {
  if (value === null) return '—';
  return `${value < 0 ? '-' : ''}${formatFinancialYen(String(Math.abs(value)))}`;
}

// 過去権利日のコストを出す株数。優待の権利獲得に必要な実際の株数が分かっていればそれを、
// 未取得なら単元株数で代用する(lambda/shared/gyakuhibu-actual-summary.tsと同じ規則)。
function sharesBasis(requiredShares: number | null, unitShares: number): number {
  return requiredShares ?? unitShares;
}

// 1株あたりの料率 × 株数。保存済みのtotalAmountは読まない — あれは記録当時のunitShares
// (移行期には200や300が入っている)を掛けた値で、必要株数とは別の株数を指している。
// avgRateとdaysは株数に依存しないので、ここから組み直せば一覧画面の前回逆日歩と必ず一致する。
function sharesBasedYen(perShareRate: number | null, shares: number): string {
  if (perShareRate === null) return '—';
  return formatFinancialYen(String(Math.round(perShareRate * shares)));
}

function scenarioText(forecast: YutaiForecast): string {
  if (forecast.scenario === 'last-rights') {
    const ratio =
      forecast.excessRatio !== null && Number.isFinite(forecast.excessRatio) ? forecast.excessRatio.toFixed(1) : '—';
    return `過去の権利日実績の超過率 ${ratio} を採用`;
  }
  if (forecast.scenario === 'current-tse') return '東証信用残ベース(参考)';
  return '実績なし';
}

// 採用ビンの前後1つずつ(3ビン)。端なら片側2つを取る。
function sensitivityWindow(poolBins: PoolBin[], adoptedLabel: string | null): PoolBin[] {
  if (adoptedLabel === null) return [];
  const idx = poolBins.findIndex((b) => b.label === adoptedLabel);
  if (idx === -1) return [];
  let start = idx - 1;
  let end = idx + 1;
  if (start < 0) {
    end += -start;
    start = 0;
  }
  if (end > poolBins.length - 1) {
    start -= end - (poolBins.length - 1);
    end = poolBins.length - 1;
  }
  start = Math.max(0, start);
  return poolBins.slice(start, end + 1);
}

export function YutaiForecastDetailPage() {
  const { ticker } = useParams<{ ticker: string }>();

  const detailState = useAsync(async () => {
    if (!ticker) throw new Error('ticker is missing');
    return fetchYutaiForecastDetail(ticker);
  }, [ticker]);

  const trendState = useAsync(async () => {
    if (!ticker) throw new Error('ticker is missing');
    return fetchYutaiMarginTrend(ticker);
  }, [ticker]);

  if (detailState.loading) return <StatusNote kind="loading" message="読み込み中…" />;
  if (detailState.error) return <StatusNote kind="error" message={`取得に失敗しました: ${detailState.error.message}`} />;
  if (!detailState.data) return null;

  const { data } = detailState;
  const { forecast } = data;
  const maxGyakuhibu = data.maxGyakuhibu;
  // 過去権利日の金額を出す株数。必要株数が200株・300株の銘柄で単元株数(100株)を使うと
  // 一覧画面の「前回逆日歩」の半分・3分の1の金額が並んでしまう。
  const shares = sharesBasis(data.requiredShares, data.unitShares);
  const netP90 = forecast.forecastP90 !== null && data.value !== null ? data.value - forecast.forecastP90 : null;

  const chartData = BIN_LABELS.map((label) => {
    const bin = data.poolBins.find((b) => b.label === label);
    return {
      label,
      pOccur: bin?.pOccur ?? 0,
      fillP50: bin?.fillP50 ?? 0,
      fillP90: bin?.fillP90 ?? 0,
    };
  });

  const scatterData = data.history
    .filter((h) => h.excessRatio !== null && Number.isFinite(h.excessRatio))
    .map((h) => ({ label: binLabelFor(h.excessRatio as number), fillRatio: h.fillRatio ?? 0 }));

  const sensitivityBins = forecast.forecastStatus !== 'na' ? sensitivityWindow(data.poolBins, forecast.bin) : [];

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 className="page-title">
          {data.companyName ?? data.ticker} <span className="ticker-card__code">{data.ticker}</span>
        </h1>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <Link to={`/yutai/${data.ticker}`} style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            逆日歩リスク計算を見る →
          </Link>
          <Link to={`/tickers/${data.ticker}`} style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            既存の個別銘柄画面を見る →
          </Link>
        </div>
      </div>

      {forecast.forecastStatus === 'general-only' ? (
        <StatusNote kind="empty" message={GENERAL_ONLY_NOTE} />
      ) : forecast.forecastStatus === 'na' ? (
        <StatusNote kind="empty" message="予測計算中です(まだ十分な実績データがありません)。" />
      ) : (
        <div className="forecast-cards">
          <div className="card">
            <div className="summary-item__label">発生確率</div>
            <div className="summary-item__value">{formatPercent(forecast.pOccur)}</div>
          </div>
          <div className="card">
            <div className="summary-item__label">想定逆日歩</div>
            <div className="summary-item__value">
              {forecast.forecastP50 !== null ? formatFinancialYen(String(Math.round(forecast.forecastP50))) : '—'}
            </div>
          </div>
          <div className="card">
            <div className="summary-item__label">想定逆日歩(最悪)</div>
            <div className="summary-item__value">
              {forecast.forecastP90 !== null ? formatFinancialYen(String(Math.round(forecast.forecastP90))) : '—'}
            </div>
          </div>
          <div className="card">
            <div className="summary-item__label">差額(最悪時)</div>
            <div className="summary-item__value">{formatSignedYen(netP90)}</div>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: '0.75rem' }}>
        <div className="summary-item__label">最大逆日歩(上限)</div>
        <div className="summary-item__value">{maxGyakuhibu !== null ? formatFinancialYen(String(maxGyakuhibu)) : '—'}</div>
        <p style={{ marginTop: '0.5rem' }}>
          <span className={`risk-badge risk-badge--${forecast.forecastStatus}`}>
            {FORECAST_STATUS_LABEL[forecast.forecastStatus]}
          </span>
        </p>
        <p style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--text-muted)' }}>{scenarioText(forecast)}</p>
      </div>

      {data.features.tseMargin && data.tseForecast && (
        <>
          <div className="section-heading">
            現在需給ベース(東証信用残 {data.tseForecast.snapshotDate} 時点、権利日{data.tseForecast.lagDays}日前)
          </div>
          <div className="forecast-cards">
            <div className="card">
              <div className="summary-item__label">貸株超過率</div>
              <div className="summary-item__value">
                {data.tseForecast.excessRatio !== null && Number.isFinite(data.tseForecast.excessRatio)
                  ? data.tseForecast.excessRatio.toFixed(2)
                  : '∞'}
              </div>
            </div>
            <div className="card">
              <div className="summary-item__label">発生確率</div>
              <div className="summary-item__value">{formatPercent(data.tseForecast.pOccur)}</div>
            </div>
            <div className="card">
              <div className="summary-item__label">想定逆日歩</div>
              <div className="summary-item__value">
                {data.tseForecast.forecastP50 !== null ? formatFinancialYen(String(Math.round(data.tseForecast.forecastP50))) : '—'}
              </div>
            </div>
            <div className="card">
              <div className="summary-item__label">想定逆日歩(最悪)</div>
              <div className="summary-item__value">
                {data.tseForecast.forecastP90 !== null ? formatFinancialYen(String(Math.round(data.tseForecast.forecastP90))) : '—'}
              </div>
            </div>
            <div className="card">
              <div className="summary-item__label">貸株残(4週前比)</div>
              <div className="summary-item__value">
                {data.tseForecast.lendingGrowth4w !== null ? `${data.tseForecast.lendingGrowth4w.toFixed(1)}倍` : '—'}
              </div>
            </div>
            <div className="card">
              <div className="summary-item__label">現在需給の判定</div>
              <div className="summary-item__value">
                <span className={`risk-badge risk-badge--${data.tseForecast.forecastStatus}`}>
                  {FORECAST_STATUS_LABEL[data.tseForecast.forecastStatus]}
                </span>
              </div>
            </div>
          </div>
        </>
      )}

      <div className="section-heading">貸株超過率と充足率(全銘柄プール)</div>
      <div className="card" style={{ height: 300 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="label" type="category" allowDuplicatedCategory={false} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
            <YAxis yAxisId="left" domain={[0, 1]} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} width={40} />
            <YAxis yAxisId="right" orientation="right" domain={[0, 1]} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} width={40} />
            <ChartTooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 12 }} />
            {forecast.bin !== null && (
              <ReferenceArea yAxisId="left" x1={forecast.bin} x2={forecast.bin} fill="var(--accent)" fillOpacity={0.12} ifOverflow="visible" />
            )}
            <Bar yAxisId="left" dataKey="pOccur" fill="var(--accent)" name="発生確率" barSize={28} />
            <Line yAxisId="right" type="monotone" dataKey="fillP50" stroke="var(--down)" dot={false} name="充足率P50" />
            <Line yAxisId="right" type="monotone" dataKey="fillP90" stroke="var(--up)" dot={false} name="充足率P90" />
            <Scatter yAxisId="right" data={scatterData} dataKey="fillRatio" fill="var(--up)" name="自銘柄の実績" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {sensitivityBins.length > 0 && maxGyakuhibu !== null && (
        <>
          <div className="section-heading">感度表(市場プールのみの値。銘柄実績とのブレンドは反映していません)</div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>超過率レンジ</th>
                  <th>発生確率</th>
                  <th>想定逆日歩</th>
                  <th>想定逆日歩(最悪)</th>
                  <th>優待価値との差</th>
                </tr>
              </thead>
              <tbody>
                {sensitivityBins.map((bin) => {
                  const p50 = bin.fillP50 * maxGyakuhibu;
                  const p90 = bin.fillP90 * maxGyakuhibu;
                  return (
                    <tr key={bin.label} style={bin.label === forecast.bin ? { fontWeight: 700 } : undefined}>
                      <td>{bin.label}</td>
                      <td className="num">{formatPercent(bin.pOccur)}</td>
                      <td className="num">{formatFinancialYen(String(Math.round(p50)))}</td>
                      <td className="num">{formatFinancialYen(String(Math.round(p90)))}</td>
                      <td className="num">{data.value !== null ? formatSignedYen(data.value - p90) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="section-heading">過去権利日</div>
      {data.history.length === 0 ? (
        <StatusNote kind="empty" message="過去の権利日実績がありません。" />
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>権利日</th>
                <th>融資残</th>
                <th>貸株残</th>
                <th>超過株数</th>
                <th>超過率</th>
                {/* 金額は必要株数ベース。株数が未取得なら単元株数で概算していることを
                    列見出しで示す(一覧画面の「※」と同じ扱い)。 */}
                <th>実績逆日歩({shares.toLocaleString('ja-JP')}株{data.requiredShares === null ? '・概算' : ''})</th>
                <th>上限</th>
                <th>充足率</th>
                <th>応札</th>
                <th>規制</th>
              </tr>
            </thead>
            <tbody>
              {data.history.map((h: YutaiForecastHistoryPoint) => (
                <tr key={h.rightsDate} style={!h.occurred ? { color: 'var(--text-muted)' } : undefined}>
                  <td>{h.rightsDate}</td>
                  <td className="num">{h.financingBalance.toLocaleString('ja-JP')}</td>
                  <td className="num">{h.lendingBalance.toLocaleString('ja-JP')}</td>
                  <td className="num">{h.excessShares.toLocaleString('ja-JP')}</td>
                  <td className="num">{excessRatioLabel(h)}</td>
                  <td className="num">{sharesBasedYen(h.avgRate * h.days, shares)}</td>
                  <td className="num">{sharesBasedYen(h.maxRateActual, shares)}</td>
                  <td className="num">{formatPercent(h.fillRatio)}</td>
                  <td>{h.bidRank ?? '—'}</td>
                  <td>{[h.restriction, h.emergencyMeasure].filter(Boolean).join('/') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.requiredShares === null && (
            <p style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              ※ 必要株数が未取得のため、実績逆日歩と上限は単元株数({data.unitShares.toLocaleString('ja-JP')}株)で概算しています。
            </p>
          )}
        </div>
      )}

      {data.features.tseMargin && (
        <>
          <div className="section-heading">信用残トレンド(過去1年)</div>
          {trendState.loading && <StatusNote kind="loading" message="読み込み中…" />}
          {trendState.error && <StatusNote kind="error" message={`取得に失敗しました: ${trendState.error.message}`} />}
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
                  {data.history.map((h) => (
                    <ReferenceLine key={h.rightsDate} x={h.rightsDate} stroke="var(--up)" strokeDasharray="3 3" />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}
    </>
  );
}
