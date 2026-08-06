import { useState, type FormEvent } from 'react';
import { addTicker, removeTicker, fetchTickers } from '../api/client';
import { StatusNote } from '../components/StatusNote';
import { useAsync } from '../lib/useAsync';

const TICKER_CODE_PATTERN = /^\d{4,5}$/;

export function WatchlistPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [input, setInput] = useState('');
  const [formError, setFormError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [removingTicker, setRemovingTicker] = useState<string | undefined>();

  const tickersState = useAsync(async () => (await fetchTickers()).tickers, [refreshKey]);

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    setFormError(undefined);

    if (!TICKER_CODE_PATTERN.test(input)) {
      setFormError('4桁または5桁の銘柄コードを入力してください(例: 7203)');
      return;
    }

    setSubmitting(true);
    try {
      await addTicker(input);
      setInput('');
      setRefreshKey((k) => k + 1);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '追加に失敗しました');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRemove(ticker: string) {
    if (!window.confirm(`${ticker} をウォッチリストから削除しますか?(過去の価格・決算データは残ります)`)) return;

    setRemovingTicker(ticker);
    try {
      await removeTicker(ticker);
      setRefreshKey((k) => k + 1);
    } finally {
      setRemovingTicker(undefined);
    }
  }

  return (
    <>
      <h1 className="page-title">ウォッチリスト管理</h1>
      <p className="page-subtitle">
        追加した銘柄は次回のバッチ取得(毎日実行)から株価・財務データの収集対象になります。
      </p>

      <form className="form-row" onSubmit={handleAdd}>
        <div>
          <input
            className="input"
            value={input}
            onChange={(e) => setInput(e.target.value.trim())}
            placeholder="銘柄コード (例: 7203)"
            aria-label="銘柄コード"
            disabled={submitting}
          />
          {formError && <p className="form-error">{formError}</p>}
        </div>
        <button type="submit" className="btn btn--primary" disabled={submitting || input.length === 0}>
          {submitting ? '追加中…' : '追加'}
        </button>
      </form>

      {tickersState.loading && <StatusNote kind="loading" message="読み込み中…" />}
      {tickersState.error && <StatusNote kind="error" message={`取得に失敗しました: ${tickersState.error.message}`} />}
      {tickersState.data && tickersState.data.length === 0 && (
        <StatusNote kind="empty" message="ウォッチリストが空です。上のフォームから銘柄コードを追加してください。" />
      )}

      {tickersState.data && tickersState.data.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>銘柄コード</th>
                <th>会社名</th>
                <th>追加日</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tickersState.data.map((ticker) => (
                <tr key={ticker.ticker}>
                  <td className="num">{ticker.ticker}</td>
                  <td style={{ textAlign: 'left' }}>{ticker.companyName ?? '—'}</td>
                  <td className="num">{ticker.addedAt ? ticker.addedAt.slice(0, 10) : '—'}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn--danger"
                      onClick={() => handleRemove(ticker.ticker)}
                      disabled={removingTicker === ticker.ticker}
                    >
                      {removingTicker === ticker.ticker ? '削除中…' : '削除'}
                    </button>
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
