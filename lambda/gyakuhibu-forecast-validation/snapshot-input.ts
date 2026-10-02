// 逆日歩予測 精度検証: 銘柄1件分の「入力データ」(taisyaku.jpのCSVから見た基準日時点の
// 融資残高・貸株残高)を取得する。既存のfetchTaisyakuCsv/parseTaisyakuCsv(どちらも変更しない)
// をそのまま呼び出すだけで、本番のgyakuhibu-history-batchとは完全に独立している
// (取得結果をDynamoDBへ書き込むことはしない。S3スナップショットへ渡すためだけの値)。
// 設計: .superpowers/sdd/2026-09-24-gyakuhibu-forecast-validation-plan/task-2-brief.md Step 2
import { fetchTaisyakuCsv, parseTaisyakuCsv } from '../gyakuhibu-history-batch/taisyaku-client';
import { shiftIsoDate } from '../shared/gyakuhibu-forecast';

// taisyaku.jpの検索範囲。過去30日分を指定すれば対象日の行が含まれる想定
// (実際のCSVは銘柄の直近3ヶ月分程度が返る)。
const LOOKBACK_DAYS = 30;

export interface TickerSnapshotInput {
  ticker: string;
  variant: 'final' | 'prelim';
  dataStatus: 'final' | 'prelim' | 'no_row' | 'fetch_error';
  financingBalance: number | null;
  lendingBalance: number | null;
  fetchStatus: 'ok' | 'fetch_error';
  // brief記載のインターフェースには無いが、index.tsがinputs/{ticker}.csvへ生CSVを
  // そのまま保存する必要があるため追加した(判断の詳細はtask-2-report.md参照)。
  // fetchStatus: 'fetch_error'のときは常にnull(CSV自体を取得できていないため)。
  // dataStatus: 'no_row'のときも、CSV自体の取得には成功しているのでrawCsvは入る
  // (対象日の行が無かっただけで、他の日の行は載っている可能性がある生データとして保存する)。
  rawCsv: string | null;
  // fetch_error時の診断用(必須ではないため呼び出し側はオプショナル扱いでよい)。
  errorMessage?: string;
}

// brief記載のシグネチャは(ticker, asofDate)の2引数だが、parseTaisyakuCsvはunitSharesを
// 必須で要求し、dataStatusの'final'/'prelim'振り分けは呼び出し元のvariantをそのまま使う
// (task-2-brief.md Step 2.4)ため、この2つを追加引数として受け取る形に拡張した
// (task-2-report.mdに判断として明記)。
export async function fetchTickerSnapshotInput(
  ticker: string,
  asofDate: string, // "2026-09-24" 形式
  unitShares: number,
  variant: 'final' | 'prelim',
): Promise<TickerSnapshotInput> {
  const from = shiftIsoDate(asofDate, -LOOKBACK_DAYS);

  let csv: string;
  try {
    // fetchTaisyakuCsvのfrom/toはISO("YYYY-MM-DD")形式の文字列をそのまま受け取り、
    // 関数内部でtaisyaku.jpのフォーム形式("YYYY / MM / DD")へ変換する
    // (toSlashDateがハイフンをスペース区切りスラッシュへ置換する実装であることを
    // gyakuhibu-history-batch/taisyaku-client.tsの本体・呼び出し元index.tsの
    // fetchTaisyakuCsv(ticker, rightsDate, rightsDate)呼び出しの両方で確認済み。
    // rightsDateはISO形式の文字列)。そのため、ここでもISO形式のまま渡せばよく、
    // 別途"YYYY/MM/DD"への変換を自前実装する必要は無い。
    csv = await fetchTaisyakuCsv(ticker, from, asofDate);
  } catch (error) {
    // 古いデータへのフォールバックをしない: 例外時は無条件でfetch_errorとして返す。
    console.error(`${ticker}: failed to fetch taisyaku.jp CSV for asof ${asofDate}`, error);
    return {
      ticker,
      variant,
      dataStatus: 'fetch_error',
      financingBalance: null,
      lendingBalance: null,
      fetchStatus: 'fetch_error',
      rawCsv: null,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  const point = parseTaisyakuCsv(csv, asofDate, unitShares, ticker);
  if (!point) {
    return {
      ticker,
      variant,
      dataStatus: 'no_row',
      financingBalance: null,
      lendingBalance: null,
      fetchStatus: 'ok',
      rawCsv: csv,
    };
  }

  // 速報/確報の自動判定手段が無いため(Task 0で判明)、呼び出し元が渡したvariantを
  // そのままdataStatusとして採用する(task-2-brief.md Step 2.4)。
  return {
    ticker,
    variant,
    dataStatus: variant,
    financingBalance: point.financingBalance,
    lendingBalance: point.lendingBalance,
    fetchStatus: 'ok',
    rawCsv: csv,
  };
}
