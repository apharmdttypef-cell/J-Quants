import { Link, useParams } from 'react-router-dom';
import { fetchYutaiDetail, fetchYutaiForecastDetail } from '../api/client';
import type { BenefitGroup } from '../api/types';
import { StatusNote } from '../components/StatusNote';
import {
  ForecastBasis,
  ForecastSummary,
  MarginTrendSection,
  TseForecastSection,
} from '../components/YutaiForecastSections';
import { formatFinancialYen, formatPrice, formatVolume } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { HoldingBadge, holdingRequirement, type HoldingRequirement } from '../lib/yutai-cross';

// 銘柄詳細。旧「優待クロス」の詳細(/yutai/:ticker)と旧「逆日歩予測」の詳細
// (/yutai/:ticker/forecast)を統合した画面。データは2つのAPIを並行して取る:
//   GET /yutai/{ticker}          銘柄基本情報・優待内容・株数段階・最高料率/品貸日数
//   GET /yutai/{ticker}/forecast 判定・予測分布・過去権利日・現在需給

const HOLDING_NOTE: Record<HoldingRequirement, string> = {
  none: '権利日だけ保有すれば取得できます(クロスで取得可)',
  bonus: '長期保有で上乗せがあります。基本の優待はクロスでも取得可',
  required: '長期保有者限定です(クロスでは取得不可)',
  unknown: '判定できません。下の優待条件の原文を確認してください',
};

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

  const forecastState = useAsync(async () => {
    if (!ticker) throw new Error('ticker is missing');
    return fetchYutaiForecastDetail(ticker);
  }, [ticker]);

  if (detailState.loading) return <StatusNote kind="loading" message="読み込み中…" />;
  if (detailState.error) return <StatusNote kind="error" message={`取得に失敗しました: ${detailState.error.message}`} />;
  if (!detailState.data) return null;

  const { data } = detailState;
  const forecast = forecastState.data;

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

      <div className="section-heading">逆日歩の判定</div>
      {forecastState.loading && <StatusNote kind="loading" message="予測を読み込み中…" />}
      {forecastState.error && (
        <StatusNote kind="error" message={`予測の取得に失敗しました: ${forecastState.error.message}`} />
      )}
      {forecast && <ForecastSummary data={forecast} maxRate={data.risk.maxRate} days={data.risk.days} />}

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
            <div className="summary-item__label">長期保有</div>
            <div className="summary-item__value">
              <HoldingBadge fields={data} />
              <div style={{ fontSize: '0.8rem', fontWeight: 400, color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                {HOLDING_NOTE[holdingRequirement(data)]}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="section-heading">株数段階別の優待条件</div>
      <BenefitGroupsCard groups={data.benefitGroups} warning={data.benefitParseWarning} />

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

      {forecast && (
        <>
          <ForecastBasis data={forecast} />
          <TseForecastSection data={forecast} />
          <MarginTrendSection data={forecast} />
        </>
      )}
    </>
  );
}
