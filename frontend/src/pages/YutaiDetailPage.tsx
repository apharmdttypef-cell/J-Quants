import { Link, useParams } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import * as HoverCard from '@radix-ui/react-hover-card';
import { fetchYutaiDetail, fetchYutaiMarginTrend } from '../api/client';
import type { BenefitGroup } from '../api/types';
import { StatusNote } from '../components/StatusNote';
import { formatFinancialYen, formatPrice, formatVolume } from '../lib/format';
import { useAsync } from '../lib/useAsync';

function holdingLabel(group: BenefitGroup): string {
  if (group.holdingMonths === null) return '継続保有条件なし';
  // 原文があればそのまま出す(「継続保有期間6か月以上」など表記が銘柄ごとに違う)。
  return group.holdingRaw ?? `継続保有${group.holdingMonths}ヶ月以上`;
}

function BenefitGroupsCard({ groups, warning }: { groups: BenefitGroup[]; warning: string | null }) {
  // 警告は段階表が空のときこそ重要なので、早期returnより手前で組み立てて
  // 両方の分岐で出す。空の分岐の中で出し忘れると、no-groups(取得したが読めなかった)
  // が画面から黙って落ちる。
  const warningNote =
    warning !== null ? (
      <p className="benefit-warning">
        ⚠ 解析が不完全な可能性があります({warning})。内容は取得元のページで確認してください。
      </p>
    ) : null;

  if (groups.length === 0) {
    return (
      <div className="card">
        {warningNote}
        <p style={{ color: 'var(--text-muted)', margin: 0 }}>
          {warning === null
            ? // 個別ページの取得がこの銘柄まで到達していない。次回のバッチで埋まる。
              '株数段階の情報はまだ取得していません。'
            : // 取得済みだが段階表を1つも読み取れなかった。運用者はパーサーを確認する必要がある。
              '個別ページは取得済みですが、株数段階を読み取れませんでした。'}
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      {warningNote}
      {groups.map((group, groupIndex) => (
        // 同じ種別・同じ保有条件のグループが重複して現れる銘柄があるため
        // (年2回の中間/期末の区別が解析で落ちる)、keyには添字を含める。
        <div key={`${group.title ?? ''}-${group.holdingMonths ?? 'none'}-${groupIndex}`} className="benefit-group">
          {group.title !== null && <div className="benefit-group__title">{group.title}</div>}
          <div className="summary-item__label">{holdingLabel(group)}</div>
          <table className="data-table">
            <thead>
              <tr>
                <th>株数</th>
                <th>優待内容</th>
              </tr>
            </thead>
            <tbody>
              {/* 1つの表に同じ株数が2回現れることがある(年2回の中間/期末が1グループに
                  潰れた場合)。グループのkeyと同じ理由で、tierのkeyにも添字を含める。 */}
              {group.tiers.map((tier, tierIndex) => (
                <tr key={`${tier.shares}-${tierIndex}`}>
                  <td className="num">{tier.shares.toLocaleString('ja-JP')}株</td>
                  {/* 金額が読めた段階は金額を、読めなかった段階(「ー」や個数表記)は
                      原文をそのまま出す。どちらの場合も原文は失われていない。 */}
                  <td className="cell-wrap" style={{ textAlign: 'left' }}>
                    {tier.valueYen !== null ? formatFinancialYen(String(tier.valueYen)) : tier.rawText}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

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
  // 過去の実績逆日歩を出す株数。必要株数が未取得なら単元株数で代用する
  // (lambda/shared/gyakuhibu-actual-summary.tsと同じ規則)。必要株数が200株・300株の
  // 銘柄で単元株数を使うと、一覧画面の「前回逆日歩」の半分・3分の1の金額が並んでしまう。
  const shares = data.requiredShares ?? data.unitShares;

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
            <div className="summary-item__value">{data.value !== null ? formatFinancialYen(String(data.value)) : '—'}</div>
          </div>
          <div className="summary-item">
            <div className="summary-item__label">権利日</div>
            <div className="summary-item__value">{data.rightsDate ?? '—'}</div>
          </div>
          <div className="summary-item">
            <div className="summary-item__label">必要株数</div>
            <div className="summary-item__value">
              {data.requiredShares !== null ? `${data.requiredShares.toLocaleString('ja-JP')}株` : '—'}
              {data.requiredShares !== null && data.requiredShares !== data.unitShares && (
                <span className="cross-months">単元{data.unitShares}株</span>
              )}
            </div>
          </div>
          <div className="summary-item">
            <div className="summary-item__label">1回のクロスで取得</div>
            <div className="summary-item__value">
              {data.crossEligible === 'ok' ? '可' : data.crossEligible === 'ng' ? '不可(長期保有者限定)' : '不明'}
              {data.holdingKind === 'required' && data.holdingMinMonths !== null && (
                <span className="cross-months">最低{data.holdingMinMonths}ヶ月</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="section-heading">株数段階別の優待条件</div>
      <BenefitGroupsCard groups={data.benefitGroups} warning={data.benefitParseWarning} />

      <div className="section-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span>逆日歩リスク計算</span>
        <Link to={`/yutai/${data.ticker}/forecast`} style={{ fontSize: '0.85rem', fontWeight: 400 }}>
          予測を見る →
        </Link>
      </div>
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
                        {/* 金額は必要株数ベース。未取得なら単元株数で概算していることを示す。 */}
                        <th>
                          実績逆日歩({shares.toLocaleString('ja-JP')}株{data.requiredShares === null ? '・概算' : ''})
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rightsHistory.map((h) => (
                        <tr key={h.rightsDate}>
                          <td>{h.rightsDate}</td>
                          {/* 保存済みのtotalAmountは読まない — 記録当時のunitShares(移行期には
                              200や300)を掛けた値で、必要株数とは別の株数を指している。
                              avgRate・daysは株数に依存しないのでここから組み直す。 */}
                          <td className="num">{formatFinancialYen(String(Math.round(h.avgRate * h.days * shares)))}</td>
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

      {data.features.tseMargin && (
        <>
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
      )}
    </>
  );
}
