// 逆日歩予測 精度検証(2026-09-28権利付き最終日)の対象銘柄303件を決定する。
// 「JQuantsYutaiMasterのrightsMonthsに対象月を含む」かつ「J-Quants /equities/masterで
// 貸借銘柄(MrgnNm==='貸借')」の積集合。docs/superpowers/notes/2026-09-25-validation-preflight.md
// で9月分467件→貸借絞り込み後303件になることを実地確認済み(このファイル自体は実数値に
// 依存しないロジックのみを持つ)。
// 設計: .superpowers/sdd/2026-09-24-gyakuhibu-forecast-validation-plan/task-2-brief.md
//
// 本番のgyakuhibu-forecast-batch/index.tsのscanYutaiMasterと処理内容は重複するが、
// 本番パイプラインへの影響を避けるためあえて共有せずこのファイル専用に実装する
// (task-2-brief.md Step 3の方針に同じ)。
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { getApiKey, fetchWithRetry } from '../shared/jquants-batch-client';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const SECRET_ARN = process.env.SECRET_ARN!;
const API_BASE_URL = process.env.API_BASE_URL ?? 'https://api.jquants.com/v2';
// equities/masterは全銘柄一覧を返す一般エンドポイント(価格系と同枠、120req/分)と想定し、
// price-batch/margin-balance-batchと同様の間隔を踏襲する。呼び出しはこのLambda全体で
// 高々数回(ページングがあっても)なので、この値自体が実行時間に与える影響は小さい。
const REQUEST_INTERVAL_MS = Number(process.env.EQUITIES_MASTER_REQUEST_INTERVAL_MS ?? '500');
const MAX_RETRIES = 5;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export interface TargetTicker {
  ticker: string;
  companyName: string;
  value: number | null;
  unitShares: number;
  maxGyakuhibu: number | null;
  rightsMonths: number[];
}

// JQuantsYutaiMasterの中で、rightsMonthsに対象月を含む行だけをスキャンして集める。
// 全件スキャンして呼び出し側でフィルタする(ScanCommandにFilterExpressionを付けても
// 読み込みRCU自体は変わらないため、フィルタはアプリ側で行う方がシンプル)。
async function scanYutaiMasterForRightsMonth(rightsMonth: number): Promise<TargetTicker[]> {
  const rows: TargetTicker[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({ TableName: YUTAI_MASTER_TABLE_NAME, ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of result.Items ?? []) {
      if (
        typeof item.ticker === 'string' &&
        typeof item.unitShares === 'number' &&
        Array.isArray(item.rightsMonths) &&
        item.rightsMonths.includes(rightsMonth)
      ) {
        rows.push({
          ticker: item.ticker,
          companyName: typeof item.companyName === 'string' ? item.companyName : '',
          value: typeof item.value === 'number' ? item.value : null,
          unitShares: item.unitShares,
          maxGyakuhibu: typeof item.maxGyakuhibu === 'number' ? item.maxGyakuhibu : null,
          rightsMonths: item.rightsMonths,
        });
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return rows;
}

interface EquityMasterRecord {
  Code?: string;
  MrgnNm?: string | null;
}

interface EquityMasterResponse {
  data?: EquityMasterRecord[];
  pagination_key?: string;
}

// J-Quants /equities/masterを1回(応答が分割される場合はpagination_keyで追加分)呼び出し、
// 貸借区分(MrgnNm)が'貸借'の銘柄コードを4桁(先頭4桁、price-batchのresolveTargetBarsと
// 同じ変換)の集合にして返す。日付指定は行わない(=最新の一覧を取得する、task-2-brief.md
// Step 1の方針通り)。
export async function fetchMarginEligibleTickers(): Promise<Set<string>> {
  const apiKey = await getApiKey(SECRET_ARN);
  const tickers = new Set<string>();
  let paginationKey: string | undefined;

  do {
    const params = new URLSearchParams();
    if (paginationKey) params.set('pagination_key', paginationKey);
    const query = params.toString();
    const url = query ? `${API_BASE_URL}/equities/master?${query}` : `${API_BASE_URL}/equities/master`;

    const response = await fetchWithRetry(url, apiKey, REQUEST_INTERVAL_MS, MAX_RETRIES);
    const body = (await response.json()) as EquityMasterResponse;
    for (const record of body.data ?? []) {
      if (record.MrgnNm === '貸借' && typeof record.Code === 'string' && record.Code.length >= 4) {
        tickers.add(record.Code.slice(0, 4));
      }
    }
    paginationKey = body.pagination_key;
  } while (paginationKey);

  return tickers;
}

// 対象銘柄 = (JQuantsYutaiMasterでrightsMonthsに対象月を含む銘柄) ∩ (equities/masterで貸借の銘柄)。
export async function resolveTargetTickers(rightsMonth: number): Promise<TargetTicker[]> {
  const [candidates, marginEligible] = await Promise.all([
    scanYutaiMasterForRightsMonth(rightsMonth),
    fetchMarginEligibleTickers(),
  ]);

  return candidates.filter((row) => marginEligible.has(row.ticker));
}
