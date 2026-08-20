import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { fetchAllListings } from '../shared/kabuyutai-client';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
// 2018年10月の東証売買単位統一以降、内国株の単元株数は原則100株固定
// (有価証券上場規程第427条の2により100株以外への変更は認められていない)。スクレイピング不要。
const UNIT_SHARES = 100;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async (): Promise<void> => {
  const entries = await fetchAllListings();
  let upserted = 0;
  let skipped = 0;

  // 年複数回権利確定の銘柄は月ごとのページに重複掲載される(rightsMonths自体に全ての月が
  // 入っているため、同一ticker・同一内容のentryが複数回来る)。複数回upsertされても
  // 内容は同じなので実害は無い(冪等)。
  for (const entry of entries) {
    if (entry.value === undefined) {
      console.warn(`${entry.ticker}: could not extract value from content "${entry.content}"; skipping`);
      skipped++;
      continue;
    }
    if (entry.rightsMonths.length === 0) {
      console.warn(`${entry.ticker}: could not parse rightsMonths; skipping`);
      skipped++;
      continue;
    }

    try {
      await ddbDocClient.send(
        new PutCommand({
          TableName: YUTAI_MASTER_TABLE_NAME,
          Item: {
            ticker: entry.ticker,
            companyName: entry.companyName,
            content: entry.content,
            value: entry.value,
            unitShares: UNIT_SHARES,
            rightsMonths: entry.rightsMonths,
          },
        }),
      );
      upserted++;
    } catch (error) {
      console.error(`${entry.ticker}: failed to upsert yutai master`, error);
    }
  }

  console.log(`yutai-master-sync-batch: upserted ${upserted}, skipped ${skipped} (of ${entries.length} listed)`);
};
