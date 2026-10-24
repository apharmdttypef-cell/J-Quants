import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';

// J-Quants版の信用残が書いていた source。taisyaku.jp版(source='taisyaku')とカーソル行は含まない。
export const LEGACY_MARGIN_SOURCES = ['weekly', 'daily-alert'] as const;

export function isLegacyMarginRow(item: Record<string, unknown>): boolean {
  return (LEGACY_MARGIN_SOURCES as readonly unknown[]).includes(item.source);
}

export async function findLegacyMarginKeys(
  ddbDocClient: DynamoDBDocumentClient,
  tableName: string,
): Promise<{ keys: Array<{ ticker: string; date: string }>; countsBySource: Record<string, number> }> {
  const keys: Array<{ ticker: string; date: string }> = [];
  const countsBySource: Record<string, number> = {};
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: '#source IN (:weekly, :dailyAlert)',
        ProjectionExpression: 'ticker, #date, #source',
        ExpressionAttributeNames: { '#date': 'date', '#source': 'source' },
        ExpressionAttributeValues: { ':weekly': 'weekly', ':dailyAlert': 'daily-alert' },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of result.Items ?? []) {
      if (!isLegacyMarginRow(item)) continue;
      keys.push({ ticker: item.ticker as string, date: item.date as string });
      const source = item.source as string;
      countsBySource[source] = (countsBySource[source] ?? 0) + 1;
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return { keys, countsBySource };
}
