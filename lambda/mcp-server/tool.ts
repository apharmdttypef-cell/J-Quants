import { loadYutaiForecastDetail } from '../shared/yutai-forecast-detail';

export const GYAKUHIBU_TOOL = {
  name: 'get_gyakuhibu_forecast',
  title: '逆日歩予測(銘柄別)',
  description: [
    '優待クロス(制度信用の売り+現物買い)で、次の権利日にかかりそうな逆日歩を銘柄ごとに返す。',
    '金額はすべて「必要株数(requiredShares)あたりの円」。確率は0〜1。',
    'forecastStatus: safe=最悪ケース(P90)でも逆日歩は最大逆日歩の20%未満 / caution=20%以上50%未満 / danger=50%以上 /',
    'general-only=制度信用で売れない銘柄(逆日歩は発生しないが、クロスは一般信用でしか組めない) / na=実績が無く予測できない。',
    'forecast: 過去権利日の需給ベースの予測。pOccur=逆日歩の発生確率、forecastP50/P90/Mean=想定逆日歩(中央値/最悪/平均)、',
    'expectedNet=優待価値(value)-想定逆日歩の平均、tickerSamples/poolSamples=予測に使った銘柄自身/全銘柄のサンプル数。',
    'tseForecast: 現在の東証の信用残(snapshotDate時点)を使った予測。無ければnull。',
    'history: 過去の権利日の実績(新しい順、最大10件)。occurred=falseはその権利日に逆日歩が出なかったことを表す。',
    'abolitionNotice: 優待制度の廃止予告(開示日とタイトル)。nullでなければ、最後の権利日を開示で確認するよう利用者に伝えること。',
    'maxGyakuhibu: 最大逆日歩(必要株数あたりの円)。',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: { ticker: { type: 'string', description: '銘柄コード(4桁。例: 7203, 130A)' } },
    required: ['ticker'],
    additionalProperties: false,
  },
} as const;

export interface ToolResult { content: { type: 'text'; text: string }[]; isError?: true }

const errorResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

export async function callGyakuhibuForecast(args: unknown): Promise<ToolResult> {
  const raw = (args as { ticker?: unknown } | undefined)?.ticker;
  const ticker = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!/^[0-9][0-9A-Z]{3}$/.test(ticker)) return errorResult('銘柄コードは4桁で指定してください(例: 7203)。');
  const result = await loadYutaiForecastDetail(ticker);
  if (!result) return errorResult(`優待マスタに無い銘柄です: ${ticker}`);
  const { detail, abolitionNotice } = result;
  const output = {
    ticker: detail.ticker, companyName: detail.companyName, content: detail.content, value: detail.value,
    requiredShares: detail.requiredShares, unitShares: detail.unitShares, rightsDate: detail.rightsDate,
    closePrice: detail.closePrice, maxGyakuhibu: detail.maxGyakuhibu, abolitionNotice,
    forecast: detail.forecast, tseForecast: detail.tseForecast,
    history: detail.history.slice(0, 10), // 共有モジュールは新しい順で返す
    marginTrend: { latest: detail.marginTrend.latest },
    // poolBinsは画面のグラフ用で大きく、会話には要らないので返さない
  };
  return { content: [{ type: 'text', text: JSON.stringify(output) }] };
}
