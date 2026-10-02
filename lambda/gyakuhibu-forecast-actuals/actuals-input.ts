// 逆日歩予測 精度検証: 銘柄1件分の実績(9/28申込分)を取得する。
// 既存のfetchTaisyakuCsv/parseTaisyakuCsv/splitCsvLine(いずれも変更しない)をそのまま使う。
// parseTaisyakuCsvにはunitShares=1を渡す(totalAmount = perShareRate × 1 = perShareRate、
// つまり「1株あたり・品貸日数分」の生の値がそのままlendingFeeTotalになる。呼び出し側
// (index.ts)が実際のrequiredSharesを掛けてcostActualを出すので、ここでは単元株数を
// 一切考慮しない)。
// parseTaisyakuCsvは「最低料率」列を返さない(GyakuhibuActualPointに無い)ため、
// このファイル内で splitCsvLine を使い同じ行検索ロジックを再実装する(重複コード、
// 意図的。taisyaku-client.tsは変更しない)。
import { fetchTaisyakuCsv, parseTaisyakuCsv, splitCsvLine } from '../gyakuhibu-history-batch/taisyaku-client';
import { shiftIsoDate } from '../shared/gyakuhibu-forecast';

const LOOKBACK_DAYS = 30;

export interface ActualsInput {
  ticker: string;
  fetchStatus: 'ok' | 'no_row' | 'fetch_error';
  lendingFeeTotal: number | null; // 1株あたり・品貸日数分(unitShares=1で取得した生の値)
  days: number | null;
  maxRateActual: number | null;
  minRateActual: number | null;
  financingBalance: number | null;
  lendingBalance: number | null;
  bidRank: string | null;
  measures: string[]; // [restriction, emergencyMeasure]のうちnullでないもの
  rawCsv: string | null;
  errorMessage?: string;
}

// CSVの「最低料率（品貸日数分/円）」列を、対象日の行から抽出する。
// parseTaisyakuCsvの行検索ロジック(日付正規化・列不一致行スキップ)と同じ方針を踏襲する。
function extractMinRateActual(csvText: string, rightsDate: string): number | null {
  const lines = csvText.trim().split('\n');
  const header = splitCsvLine(lines[0]);
  const minRateIdx = header.findIndex((h) => h.includes('最低料率'));
  const dateIdx = header.findIndex((h) => h.includes('申込日'));
  if (minRateIdx === -1 || dateIdx === -1) return null;

  const normalizedRightsDate = rightsDate.replace(/\D/g, '');
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = splitCsvLine(line);
    if (cols.length !== header.length) continue;
    if (cols[dateIdx].replace(/\D/g, '') !== normalizedRightsDate) continue;
    const raw = cols[minRateIdx].trim();
    if (raw === '') return null;
    const value = Number(raw.replace(/,/g, ''));
    return Number.isNaN(value) ? null : value;
  }
  return null;
}

export async function fetchTickerActualsInput(ticker: string, rightsDate: string): Promise<ActualsInput> {
  const from = shiftIsoDate(rightsDate, -LOOKBACK_DAYS);

  let csv: string;
  try {
    csv = await fetchTaisyakuCsv(ticker, from, rightsDate);
  } catch (error) {
    console.error(`${ticker}: failed to fetch taisyaku.jp CSV for rightsDate ${rightsDate}`, error);
    return {
      ticker,
      fetchStatus: 'fetch_error',
      lendingFeeTotal: null,
      days: null,
      maxRateActual: null,
      minRateActual: null,
      financingBalance: null,
      lendingBalance: null,
      bidRank: null,
      measures: [],
      rawCsv: null,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  const point = parseTaisyakuCsv(csv, rightsDate, 1, ticker);
  if (!point) {
    return {
      ticker,
      fetchStatus: 'no_row',
      lendingFeeTotal: null,
      days: null,
      maxRateActual: null,
      minRateActual: null,
      financingBalance: null,
      lendingBalance: null,
      bidRank: null,
      measures: [],
      rawCsv: csv,
    };
  }

  return {
    ticker,
    fetchStatus: 'ok',
    lendingFeeTotal: point.totalAmount,
    days: point.days,
    maxRateActual: point.maxRateActual,
    minRateActual: extractMinRateActual(csv, rightsDate),
    financingBalance: point.financingBalance,
    lendingBalance: point.lendingBalance,
    bidRank: point.bidRank,
    measures: [point.restriction, point.emergencyMeasure].filter((m): m is string => m !== null),
    rawCsv: csv,
  };
}
