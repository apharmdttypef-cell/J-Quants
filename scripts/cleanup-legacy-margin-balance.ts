// J-Quants版の信用残(`source`=`weekly`/`daily-alert`)を`JQuantsMarginBalance`から消す一回限りのスクリプト。
// taisyaku.jpのバックフィル完了(カーソル行`lastFetchedDate`が直近の営業日)を確認してから手動で実行する。
// PITRが有効なので誤削除は復旧できる。
// 実行例: npx ts-node scripts/cleanup-legacy-margin-balance.ts            (件数の表示だけ)
//         npx ts-node scripts/cleanup-legacy-margin-balance.ts --execute  (削除)
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { batchDelete } from '../lambda/shared/dynamodb-batch';
import { findLegacyMarginKeys } from './lib/legacy-margin-balance';

const MARGIN_BALANCE_TABLE_NAME = process.env.MARGIN_BALANCE_TABLE_NAME ?? 'JQuantsMarginBalance';

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

async function main() {
  const execute = process.argv.includes('--execute');

  const { keys, countsBySource } = await findLegacyMarginKeys(ddbDocClient, MARGIN_BALANCE_TABLE_NAME);
  console.log(`対象テーブル: ${MARGIN_BALANCE_TABLE_NAME}`);
  console.log(`旧データ件数: ${keys.length}`, countsBySource);
  console.log('先頭5件のキー:', keys.slice(0, 5));

  if (!execute) {
    console.log('ドライランです。削除するには --execute を付けて再実行してください。');
    return;
  }

  await batchDelete(ddbDocClient, MARGIN_BALANCE_TABLE_NAME, keys);
  console.log(`削除しました: ${keys.length}件`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
