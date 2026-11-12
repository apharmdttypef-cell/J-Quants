// 廃止予告の判定を入れる前に記録されたTDnetイベントから、マスタにabolitionNoticeを付け直す一回限りのスクリプト。
// 実行例: npx ts-node scripts/backfill-abolition-notice.ts            (対象の表示だけ)
//         npx ts-node scripts/backfill-abolition-notice.ts --execute  (書き込み)
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { applyAbolitionNoticeTargets, findAbolitionNoticeTargets } from './lib/abolition-notice-backfill';

const YUTAI_TDNET_EVENT_TABLE_NAME = process.env.YUTAI_TDNET_EVENT_TABLE_NAME ?? 'JQuantsYutaiTdnetEvent';
const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME ?? 'JQuantsYutaiMaster';

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

async function main() {
  const execute = process.argv.includes('--execute');

  const targets = await findAbolitionNoticeTargets(ddbDocClient, YUTAI_TDNET_EVENT_TABLE_NAME, YUTAI_MASTER_TABLE_NAME);
  console.log(`対象: ${targets.length}銘柄`);
  for (const target of targets) {
    console.log(`${target.ticker} ${target.notice.disclosedAt} ${target.notice.title} (イベント${target.eventIds.length}件)`);
  }

  if (!execute) {
    console.log('ドライランです。書き込むには --execute を付けて再実行してください。');
    return;
  }

  await applyAbolitionNoticeTargets(ddbDocClient, YUTAI_TDNET_EVENT_TABLE_NAME, YUTAI_MASTER_TABLE_NAME, targets);
  console.log(`書き込みました: ${targets.length}銘柄`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
