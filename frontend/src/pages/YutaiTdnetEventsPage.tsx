import { Link } from 'react-router-dom';
import { fetchYutaiTdnetEvents } from '../api/client';
import type { YutaiTdnetEventType } from '../api/types';
import { StatusNote } from '../components/StatusNote';
import { useAsync } from '../lib/useAsync';

const EVENT_TYPE_LABEL: Record<YutaiTdnetEventType, string> = { start: '開始', update: '変更', abolition: '廃止' };
const EVENT_TYPE_CLASS: Record<YutaiTdnetEventType, string> = {
  start: 'event-badge--start',
  update: 'event-badge--update',
  abolition: 'event-badge--abolition',
};

export function YutaiTdnetEventsPage() {
  const eventsState = useAsync(() => fetchYutaiTdnetEvents(), []);

  return (
    <>
      <h1 className="page-title">優待変更履歴</h1>
      <p className="page-subtitle">TDnet開示から検知した株主優待の新設・変更・廃止(直近分)。</p>

      {eventsState.loading && <StatusNote kind="loading" message="読み込み中…" />}
      {eventsState.error && <StatusNote kind="error" message={`取得に失敗しました: ${eventsState.error.message}`} />}
      {eventsState.data && eventsState.data.events.length === 0 && (
        <StatusNote kind="empty" message="検知されたイベントはまだありません。" />
      )}

      {eventsState.data && eventsState.data.events.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>開示日</th>
                <th>銘柄コード</th>
                <th>会社名</th>
                <th>種別</th>
                <th>開示タイトル</th>
              </tr>
            </thead>
            <tbody>
              {eventsState.data.events.map((event) => (
                <tr key={`${event.disclosedAt}-${event.ticker}-${event.disclosureTitle}`}>
                  <td className="num">{event.disclosedAt}</td>
                  <td style={{ textAlign: 'left' }}>
                    <Link to={`/yutai/${event.ticker}`}>{event.ticker}</Link>
                  </td>
                  <td style={{ textAlign: 'left' }}>{event.companyName}</td>
                  <td>
                    <span className={`event-badge ${EVENT_TYPE_CLASS[event.eventType]}`}>
                      {EVENT_TYPE_LABEL[event.eventType]}
                    </span>
                  </td>
                  <td className="cell-wrap" style={{ textAlign: 'left' }}>
                    {event.disclosureTitle}
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
