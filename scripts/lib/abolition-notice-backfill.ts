// 廃止予告(lambda/shared/yutai-abolition.ts)の判定を導入する前に'update'/'start'として
// 記録された開示から、まだマスタに残っている銘柄へabolitionNoticeを付け直す。
// 設計: docs/superpowers/specs/2026-11-12-yutai-change-apply-design.md
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { isAbolitionNotice, latestAbolitionNotice, type AbolitionNotice } from '../../lambda/shared/yutai-abolition';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = { send: (command: any) => Promise<any> };

export interface AbolitionNoticeTarget {
  ticker: string;
  notice: AbolitionNotice;
  eventIds: string[];
}

interface EventRow {
  eventId: string;
  ticker: string;
  disclosedAt: string;
  title: string;
}

async function scanCandidateEvents(client: Client, eventTableName: string): Promise<EventRow[]> {
  const rows: EventRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: eventTableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': 'ALL' },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of result.Items ?? []) {
      // 'abolition'は既に削除済みの銘柄なので対象外。
      if (item.eventType !== 'update' && item.eventType !== 'start') continue;
      if (typeof item.disclosureTitle !== 'string' || !isAbolitionNotice(item.disclosureTitle)) continue;
      rows.push({ eventId: item.eventId, ticker: item.ticker, disclosedAt: item.disclosedAt, title: item.disclosureTitle });
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return rows;
}

export async function findAbolitionNoticeTargets(
  client: Client,
  eventTableName: string,
  masterTableName: string,
): Promise<AbolitionNoticeTarget[]> {
  const byTicker = new Map<string, EventRow[]>();
  for (const row of await scanCandidateEvents(client, eventTableName)) {
    byTicker.set(row.ticker, [...(byTicker.get(row.ticker) ?? []), row]);
  }

  const targets: AbolitionNoticeTarget[] = [];
  for (const [ticker, rows] of byTicker) {
    const master = await client.send(new GetCommand({ TableName: masterTableName, Key: { ticker } }));
    if (!master.Item) continue;
    const notice = latestAbolitionNotice(rows);
    if (!notice) continue;
    targets.push({ ticker, notice, eventIds: rows.map((r) => r.eventId) });
  }
  return targets;
}

export async function applyAbolitionNoticeTargets(
  client: Client,
  eventTableName: string,
  masterTableName: string,
  targets: AbolitionNoticeTarget[],
): Promise<void> {
  for (const target of targets) {
    // 確認から実行までの間に行が消えていたら作り直さない(UpdateCommandは行が無いと新規作成する)。
    await client.send(
      new UpdateCommand({
        TableName: masterTableName,
        Key: { ticker: target.ticker },
        UpdateExpression: 'SET abolitionNotice = :notice',
        ConditionExpression: 'attribute_exists(ticker)',
        ExpressionAttributeValues: { ':notice': target.notice },
      }),
    );
    for (const eventId of target.eventIds) {
      await client.send(
        new UpdateCommand({
          TableName: eventTableName,
          Key: { pk: 'ALL', eventId },
          UpdateExpression: 'SET eventType = :type',
          ExpressionAttributeValues: { ':type': 'abolition-notice' },
        }),
      );
    }
  }
}
