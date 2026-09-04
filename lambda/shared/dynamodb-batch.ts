import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// DynamoDBのBatchWriteItemは25件までしか受け付け、スロットリング時はUnprocessedItemsに
// 未処理分を積んで200番台で返す(エラーにはならない)。ここでリトライしないと、書き込みが
// エラーなく黙って欠落する(margin-balance-batchのテーブル一括パージ作業で実際に踏んだ不具合と同じ)。
export async function batchUpsert(
  ddbDocClient: DynamoDBDocumentClient,
  tableName: string,
  items: Record<string, unknown>[],
): Promise<void> {
  for (let i = 0; i < items.length; i += 25) {
    let pending: { PutRequest: { Item: Record<string, unknown> } }[] = items
      .slice(i, i + 25)
      .map((Item) => ({ PutRequest: { Item } }));
    let attempt = 0;

    while (pending.length > 0) {
      const result = await ddbDocClient.send(new BatchWriteCommand({ RequestItems: { [tableName]: pending } }));
      const unprocessed = (result.UnprocessedItems?.[tableName] ?? []) as typeof pending;
      if (unprocessed.length === 0) break;

      attempt += 1;
      if (attempt > 10) {
        throw new Error(`batchUpsert: too many retries, ${unprocessed.length} items still unprocessed`);
      }
      await sleep(Math.min(2000, 100 * 2 ** attempt));
      pending = unprocessed;
    }
  }
}
