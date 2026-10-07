// 銘柄の貸借区分(J-Quants /equities/master の MrgnNm: '貸借' | '信用' | 'その他')。
// 制度信用で売れる(=逆日歩が発生しうる)のは'貸借'だけ。'信用'は買いのみ、'その他'は
// 制度信用の対象外で、どちらもクロスは一般信用(証券会社の在庫)でしか組めない。
import { fetchWithRetry } from './jquants-batch-client';

export interface EquityMasterRecord {
  Code?: string;
  MrgnNm?: string | null;
}

// 5桁コードを優待マスタと同じ先頭4文字に丸めて対応付ける。同じ4文字に普通株と優先株が
// 並ぶ銘柄があり(例: ソフトバンク 94340=貸借 / 94345=信用)、後勝ちにすると優先株の区分で
// 上書きされてしまうため、普通株(末尾0)を優先する。
export function pickMarginNames(records: EquityMasterRecord[]): Map<string, string> {
  const names = new Map<string, string>();
  const fromCommonShare = new Set<string>();
  for (const record of records) {
    if (typeof record.Code !== 'string' || record.Code.length < 5) continue;
    if (typeof record.MrgnNm !== 'string' || record.MrgnNm === '') continue;
    const ticker = record.Code.slice(0, 4);
    const isCommon = record.Code.endsWith('0');
    if (fromCommonShare.has(ticker)) continue;
    if (isCommon || !names.has(ticker)) names.set(ticker, record.MrgnNm);
    if (isCommon) fromCommonShare.add(ticker);
  }
  return names;
}

// 区分が分かっていて、かつ制度信用で売れない銘柄。区分が分からない銘柄(J-Quantsの
// 上場一覧に無い東証外上場の銘柄など)は決めつけずにfalseを返す。
export function isGeneralMarginOnly(marginName: string | null): boolean {
  return marginName !== null && marginName !== '貸借';
}

interface EquityMasterResponse {
  data?: EquityMasterRecord[];
  pagination_key?: string;
}

// 最新の上場銘柄一覧を取得して、ticker → 貸借区分 にする。
export async function fetchMarginNames(apiKey: string, apiBaseUrl: string): Promise<Map<string, string>> {
  const records: EquityMasterRecord[] = [];
  let paginationKey: string | undefined;
  do {
    const query = paginationKey ? `?pagination_key=${encodeURIComponent(paginationKey)}` : '';
    const response = await fetchWithRetry(`${apiBaseUrl}/equities/master${query}`, apiKey, 500, 5);
    const body = (await response.json()) as EquityMasterResponse;
    records.push(...(body.data ?? []));
    paginationKey = body.pagination_key;
  } while (paginationKey);
  return pickMarginNames(records);
}
