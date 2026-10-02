import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { fetchAllListings } from '../shared/kabuyutai-client';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
// 2018年10月の東証売買単位統一以降、内国株の単元株数は原則100株固定
// (有価証券上場規程第427条の2により100株以外への変更は認められていない)。スクレイピング不要。
// ただし優待の権利獲得に必要な実際の株数は単元株数と一致するとは限らない(例: 第一興商は
// 単元100株だが優待には200株必要、2026-09-04発見)。正確な必要株数は
// yutai-detail-sync-batchが個別ページの株数段階表から取ってrequiredSharesに書く
// (minInvestmentから逆算する方式は推定値が不安定なため廃止した)。
// minInvestment(必要投資金額)は引き続き保存するが、用途は一覧ページから優待価値を
// 近似する計算(kabuyutai-clientのestimateValueFromYield)と、requiredShares × 株価が
// 大きく外れていないかの突き合わせ材料にとどまる。必要株数の算出には使わない。
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
            'SET companyName = :companyName, #content = :content, #value = :value, unitShares = :unitShares, minInvestment = :minInvestment, rightsMonths = :rightsMonths, detailUrl = :detailUrl, listBadge = :listBadge',
          ExpressionAttributeNames: { '#content': 'content', '#value': 'value' },
          ExpressionAttributeValues: {
            ':companyName': entry.companyName,
            ':content': entry.content,
            ':value': entry.value ?? null,
            ':unitShares': UNIT_SHARES,
            ':minInvestment': entry.minInvestment ?? null,
            ':rightsMonths': entry.rightsMonths,
            ':detailUrl': entry.detailUrl ?? null,
            ':listBadge': entry.listBadge ?? null,
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
