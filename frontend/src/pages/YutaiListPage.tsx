import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchYutaiList } from '../api/client';
import type { YutaiRiskStatus } from '../api/types';
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

const RISK_LABEL: Record<YutaiRiskStatus, string> = { safe: '安全', danger: '危険', na: '対象外' };

export function YutaiListPage() {
  const defaultRange = monthRange();
  const [rightsDateFrom, setRightsDateFrom] = useState(defaultRange.from);
  const [rightsDateTo, setRightsDateTo] = useState(defaultRange.to);
  const [keyword, setKeyword] = useState('');
  const [riskStatus, setRiskStatus] = useState<'all' | YutaiRiskStatus>('all');

  const listState = useAsync(
    () => fetchYutaiList({ rightsDateFrom, rightsDateTo, keyword: keyword || undefined, riskStatus }),
    [rightsDateFrom, rightsDateTo, keyword, riskStatus],
  );

  return (
    <>
      <h1 className="page-title">優待クロス スクリーニング</h1>
      <p className="page-subtitle">権利日・優待価値と最大逆日歩の見積りを比較して絞り込みます。</p>

      {listState.data && (
        <div className="cutoff-banner">
          <span>📅</span>
          <span>
            当月の権利付き最終日: <strong>{listState.data.currentMonthLastTradableDate}</strong>
          </span>
          <span style={{ color: 'var(--text-muted)' }}>(月末が権利確定日の銘柄はこの日までに買付が必要)</span>
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
          キーワード:{' '}
          <input
            className="input"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="会社名・優待内容"
          />
        </label>
        <label>
          リスク判定:{' '}
          <select value={riskStatus} onChange={(e) => setRiskStatus(e.target.value as typeof riskStatus)}>
            <option value="all">すべて</option>
            <option value="safe">安全</option>
            <option value="danger">危険</option>
            <option value="na">対象外</option>
          </select>
        </label>
      </div>

      {listState.loading && <StatusNote kind="loading" message="読み込み中…" />}
      {listState.error && <StatusNote kind="error" message={`取得に失敗しました: ${listState.error.message}`} />}
      {listState.data && listState.data.tickers.length === 0 && (
        <StatusNote kind="empty" message="条件に一致する優待銘柄がありません。" />
      )}

      {listState.data && listState.data.tickers.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>銘柄</th>
                <th>優待内容</th>
                <th>優待価値</th>
                <th>権利日</th>
                <th>リスク</th>
              </tr>
            </thead>
            <tbody>
              {listState.data.tickers.map((item) => (
                <tr key={item.ticker}>
                  <td style={{ textAlign: 'left' }}>
                    <Link to={`/yutai/${item.ticker}`}>
                      {item.companyName ?? item.ticker} <span className="ticker-card__code">{item.ticker}</span>
                    </Link>
                  </td>
                  <td style={{ textAlign: 'left' }}>{item.content}</td>
                  <td className="num">{formatFinancialYen(String(item.value))}</td>
                  <td className="num">{item.rightsDate ?? '—'}</td>
                  <td>
                    <span className={`risk-badge risk-badge--${item.riskStatus}`}>{RISK_LABEL[item.riskStatus]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
