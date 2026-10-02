import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Context } from 'aws-lambda';
import { fetchDetailPage, type ListBadge } from '../shared/kabuyutai-client';
import { deriveBenefitScalars, parseBenefitDetail } from '../shared/kabuyutai-detail';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const REQUEST_INTERVAL_MS = Number(process.env.KABUYUTAI_REQUEST_INTERVAL_MS ?? '1000');
// 優待条件は銘柄あたり年1回も変わらないことが多い。90日あれば、取りこぼしの
// 再取得には十分で、かつ全銘柄を取り直し続ける無駄も避けられる。
const COOLDOWN_DAYS = Number(process.env.YUTAI_DETAIL_COOLDOWN_DAYS ?? '90');
// 1リクエスト/秒なので300件で約5分。Step Functions経由では最大バケット(3000台・
// 274件)がこれを下回るため実際には発動しない。codePrefixを省いた全銘柄の手動実行と、
// 将来バケットが育ったときの安全弁として置く。超えた分は次回実行に持ち越される。
const MAX_DETAIL_FETCHES_PER_RUN = Number(process.env.MAX_DETAIL_FETCHES_PER_RUN ?? '300');
// 残り実行時間がこれを下回ったらループを打ち切る。実際の制約は件数ではなく実行時間で、
// Lambdaのタイムアウトは Lambda.Unknown として表に出てStep Functionsのリトライヤーに
// 一致しない(lib/j-quants-stack.ts参照)。タイムアウトすると後続バケットが丸ごと
// 走らなくなるため、進行中の1件(ページ取得 + DynamoDB書き込み)を終えて正常終了できる
// だけの余裕を残して自分から止まる。打ち切った分はconditionCheckedAtが未更新なので
// 次回実行に持ち越される。
const TIME_BUDGET_MARGIN_MS = 60_000;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export interface DetailSyncEvent {
  // '1'〜'9'。銘柄コードの先頭がこれで始まる銘柄だけを処理する(Step Functionsの
  // Mapが渡す)。省略時は全銘柄。
  codePrefix?: string;
  // 名指しした銘柄だけを、クールダウンとcodePrefixを無視して処理する。
  tickers?: string[];
  maxFetches?: number;
}

interface MasterRow {
  ticker: string;
  detailUrl: string | undefined;
  listBadge: ListBadge | undefined;
  conditionCheckedAt: string | undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// deadline(ミリ秒のエポック)を実際に過ぎるまで待つ。setTimeoutがタイマーの分解能の
// ぶんだけ早く起きる環境があるため、1回のsleepで済ませず経過を見て待ち直す。
// 1リクエスト/秒という外部への約束はこの関数だけが担保しているので、早起きの可能性を
// 残さない。deadlineを既に過ぎていれば1度も待たない。
async function sleepUntil(deadline: number): Promise<void> {
  for (let remaining = deadline - Date.now(); remaining > 0; remaining = deadline - Date.now()) {
    await sleep(remaining);
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function cooldownCutoff(): string {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - COOLDOWN_DAYS);
  return cutoff.toISOString().slice(0, 10);
}

function isListBadge(value: unknown): value is ListBadge {
  return value === 'chouki' || value === 'choukinomi' || value === null;
}

async function scanMaster(): Promise<MasterRow[]> {
  const rows: MasterRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({
        TableName: YUTAI_MASTER_TABLE_NAME,
        // 1,642銘柄の全属性を読むと無駄が大きい。判定に必要な4項目だけを取る。
        ProjectionExpression: 'ticker, detailUrl, listBadge, conditionCheckedAt',
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of result.Items ?? []) {
      if (typeof item.ticker !== 'string') continue;
      rows.push({
        ticker: item.ticker,
        detailUrl: typeof item.detailUrl === 'string' ? item.detailUrl : undefined,
        // 「バッジなし(null)」と「まだ一覧ページを取り直していない(undefined)」は
        // 別物。前者はクロス可の根拠になるが、後者は何の情報も無い。
        listBadge: isListBadge(item.listBadge) ? item.listBadge : undefined,
        conditionCheckedAt: typeof item.conditionCheckedAt === 'string' ? item.conditionCheckedAt : undefined,
      });
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return rows;
}

function selectTargets(rows: MasterRow[], event: DetailSyncEvent): MasterRow[] {
  if (event.tickers && event.tickers.length > 0) {
    const wanted = new Set(event.tickers);
    return rows.filter((row) => wanted.has(row.ticker));
  }

  const cutoff = cooldownCutoff();
  return rows.filter((row) => {
    if (event.codePrefix && !row.ticker.startsWith(event.codePrefix)) return false;
    return row.conditionCheckedAt === undefined || row.conditionCheckedAt < cutoff;
  });
}

// contextはLambdaランタイムが渡す第2引数。残り実行時間を見るためだけに使うので
// 必要なメソッドだけを型に要求し、省略も許す(単体テストはeventだけで呼ぶ)。
type RemainingTime = Pick<Context, 'getRemainingTimeInMillis'>;

export const handler = async (event: DetailSyncEvent = {}, context?: RemainingTime): Promise<void> => {
  const limit = event.maxFetches ?? MAX_DETAIL_FETCHES_PER_RUN;
  const targets = selectTargets(await scanMaster(), event).slice(0, limit);

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let requested = 0;
  let processed = 0;
  let stoppedEarly = false;
  // 直前のリクエストを開始した時刻。待つのは「前回の開始からREQUEST_INTERVAL_MS経過
  // するまで」で、毎回まるごとREQUEST_INTERVAL_MS待つのではない。固定で待つとページ
  // 取得の時間と直列に積み上がり(実測で1ページ約2秒 → 1銘柄3秒)、最大バケット274件が
  // 約14分になってLambdaのタイムアウトに達してしまう。開始時刻を基準にすれば
  // 「リクエスト開始の間隔 ≧ REQUEST_INTERVAL_MS」は保ったまま、274件が約274秒で済む。
  let lastRequestStartedAt: number | undefined;
  const warningCounts = new Map<string, number>();

  for (const row of targets) {
    if (context !== undefined && context.getRemainingTimeInMillis() < TIME_BUDGET_MARGIN_MS) {
      stoppedEarly = true;
      console.warn(
        `yutai-detail-sync-batch: stopping early with ${targets.length - processed} targets left ` +
          `(${context.getRemainingTimeInMillis()}ms remaining); the rest is picked up by the next run`,
      );
      break;
    }
    processed++;

    if (row.detailUrl === undefined) {
      // 一覧ページの再同期(yutai-master-sync-batch)がまだ走っていない行。
      console.warn(`${row.ticker}: no detailUrl on the master row; run yutai-master-sync-batch first`);
      skipped++;
      continue;
    }

    // 2回目以降のリクエストの前だけ待つ。先頭で待つと1件だけの単一銘柄モードが
    // 無駄に遅くなる。fetchが失敗しても待つ(待機はtryの外)ので、リクエスト間隔は
    // 成否によらずREQUEST_INTERVAL_MS以上になる。
    if (lastRequestStartedAt !== undefined) {
      await sleepUntil(lastRequestStartedAt + REQUEST_INTERVAL_MS);
    }
    // 待機後に記録する(= 実際にリクエストを出す直前の時刻)。次の待機はここから数える。
    lastRequestStartedAt = Date.now();
    requested++;

    try {
      const groups = parseBenefitDetail(await fetchDetailPage(row.detailUrl));
      const derived = deriveBenefitScalars(groups, row.listBadge);

      await ddbDocClient.send(
        new UpdateCommand({
          TableName: YUTAI_MASTER_TABLE_NAME,
          Key: { ticker: row.ticker },
          UpdateExpression:
            'SET benefitGroups = :benefitGroups, requiredShares = :requiredShares, holdingKind = :holdingKind, ' +
            'holdingMinMonths = :holdingMinMonths, crossEligible = :crossEligible, minTierValueYen = :minTierValueYen, ' +
            'benefitParseWarning = :benefitParseWarning, conditionCheckedAt = :conditionCheckedAt',
          ExpressionAttributeValues: {
            ':benefitGroups': groups,
            ':requiredShares': derived.requiredShares,
            ':holdingKind': derived.holdingKind,
            ':holdingMinMonths': derived.holdingMinMonths,
            ':crossEligible': derived.crossEligible,
            ':minTierValueYen': derived.minTierValueYen,
            ':benefitParseWarning': derived.benefitParseWarning,
            // 解析できなかった行にもconditionCheckedAtを書く。書かないと毎回同じ
            // 銘柄を取り直し、サイト構造が直るまで他の銘柄が進まなくなる。
            ':conditionCheckedAt': todayIso(),
          },
        }),
      );

      if (derived.benefitParseWarning !== null) {
        for (const reason of derived.benefitParseWarning.split(',')) {
          warningCounts.set(reason, (warningCounts.get(reason) ?? 0) + 1);
        }
      }
      updated++;
    } catch (error) {
      // 1銘柄の失敗で残りを止めない(本プロジェクトの他バッチと同じ方針)。
      // conditionCheckedAtを書いていないので次回また対象になる。
      failed++;
      console.error(`${row.ticker}: failed to fetch/parse the detail page`, error);
    }
  }

  const warningSummary =
    warningCounts.size > 0
      ? [...warningCounts].map(([reason, count]) => `${reason}=${count}`).join(' ')
      : 'none';
  console.log(
    `yutai-detail-sync-batch: codePrefix=${event.codePrefix ?? 'all'} targets=${targets.length} ` +
      `updated=${updated} skipped=${skipped} failed=${failed} stoppedEarly=${stoppedEarly} ` +
      `warnings: ${warningSummary}`,
  );
};
