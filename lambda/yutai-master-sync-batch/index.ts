import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { fetchAllListings } from '../shared/kabuyutai-client';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
// 2018年10月の東証売買単位統一以降、内国株の単元株数は原則100株固定
// (有価証券上場規程第427条の2により100株以外への変更は認められていない)。スクレイピング不要。
// ただし優待の権利獲得に必要な実際の株数は単元株数と一致するとは限らない(例: 第一興商は
// 単元100株だが優待には200株必要、2026-09-04発見)。minInvestment(必要投資金額)を別途保存し、
// yutai-risk-precompute-batchが現在株価と突き合わせて実際の必要株数を逆算する。
const UNIT_SHARES = 100;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async (): Promise<void> => {
  const entries = await fetchAllListings();
  let upserted = 0;
  let skipped = 0;
  let failed = 0;

  // 年複数回権利確定の銘柄は月ごとのページに重複掲載される(rightsMonths自体に全ての月が
  // 入っているため、同一ticker・同一内容のentryが複数回来る)。複数回upsertされても
  // 内容は同じなので実害は無い(冪等)。
  for (const entry of entries) {
    if (entry.rightsMonths.length === 0) {
      console.warn(`${entry.ticker}: could not parse rightsMonths; skipping`);
      skipped++;
      continue;
    }

    try {
      await ddbDocClient.send(
        new UpdateCommand({
          TableName: YUTAI_MASTER_TABLE_NAME,
          Key: { ticker: entry.ticker },
          UpdateExpression:
            'SET companyName = :companyName, #content = :content, #value = :value, unitShares = :unitShares, minInvestment = :minInvestment, rightsMonths = :rightsMonths',
          ExpressionAttributeNames: { '#content': 'content', '#value': 'value' },
          ExpressionAttributeValues: {
            ':companyName': entry.companyName,
            ':content': entry.content,
            ':value': entry.value ?? null,
            ':unitShares': UNIT_SHARES,
            ':minInvestment': entry.minInvestment ?? null,
            ':rightsMonths': entry.rightsMonths,
          },
        }),
      );
      upserted++;
    } catch (error) {
      failed++;
      console.error(`${entry.ticker}: failed to upsert yutai master`, error);
    }
  }

  console.log(`yutai-master-sync-batch: upserted ${upserted}, skipped ${skipped}, failed ${failed} (of ${entries.length} listed)`);
};
