// 逆日歩予測 精度検証(2026-09-28権利付き最終日)の対象銘柄303件を決定する。
// 「JQuantsYutaiMasterのrightsMonthsに対象月を含む」かつ「JQuantsYutaiMasterのmarginName
// (信用残バッチがtaisyaku.jpの貸借区分から書く)が'貸借'」の銘柄。docs/superpowers/notes/
// 2026-09-25-validation-preflight.mdで9月分467件→貸借絞り込み後303件になることを実地確認済み
// (2026-10-28に貸借区分の取得元をJ-Quantsからtaisyaku.jpへ移した。このファイル自体は
// 実数値に依存しないロジックのみを持つ)。
// 設計: .superpowers/sdd/2026-09-24-gyakuhibu-forecast-validation-plan/task-2-brief.md
//
// 本番のgyakuhibu-forecast-batch/index.tsのscanYutaiMasterと処理内容は重複するが、
// 本番パイプラインへの影響を避けるためあえて共有せずこのファイル専用に実装する
// (task-2-brief.md Step 3の方針に同じ)。
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export interface TargetTicker {
  ticker: string;
  companyName: string;
  value: number | null;
  unitShares: number;
  maxGyakuhibu: number | null;
  rightsMonths: number[];
}

// JQuantsYutaiMasterの中で、rightsMonthsに対象月を含み、貸借区分が'貸借'の行だけを集める。
// 全件スキャンして呼び出し側でフィルタする(ScanCommandにFilterExpressionを付けても
// 読み込みRCU自体は変わらないため、フィルタはアプリ側で行う方がシンプル)。
async function scanMarginEligibleYutaiMaster(rightsMonth: number): Promise<TargetTicker[]> {
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
        item.marginName === '貸借' &&
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

// 対象銘柄 = JQuantsYutaiMasterでrightsMonthsに対象月を含み、marginNameが'貸借'の銘柄。
export async function resolveTargetTickers(rightsMonth: number): Promise<TargetTicker[]> {
  return scanMarginEligibleYutaiMaster(rightsMonth);
}
