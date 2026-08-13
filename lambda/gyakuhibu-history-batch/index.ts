import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { fetchTaisyakuCsv, parseTaisyakuCsv } from './taisyaku-client';

const YUTAI_RIGHTS_DATE_TABLE_NAME = process.env.YUTAI_RIGHTS_DATE_TABLE_NAME!;
const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const GYAKUHIBU_ACTUAL_TABLE_NAME = process.env.GYAKUHIBU_ACTUAL_TABLE_NAME!;
// taisyaku.jpが公開しているのは直近3年分のみ(それより古いデータは非公開)。
const MAX_HISTORY_YEARS = 3;

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface RightsDateRow {
  ticker: string;
  rightsDate: string;
}

async function listPastRightsDates(): Promise<RightsDateRow[]> {
  const rows: RightsDateRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  const today = new Date().toISOString().slice(0, 10);

  do {
    const result = await ddbDocClient.send(
      new ScanCommand({ TableName: YUTAI_RIGHTS_DATE_TABLE_NAME, ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of result.Items ?? []) {
      if (typeof item.ticker === 'string' && typeof item.rightsDate === 'string' && item.rightsDate < today) {
        rows.push({ ticker: item.ticker, rightsDate: item.rightsDate });
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return rows;
}

function isWithinPublishedRange(rightsDate: string): boolean {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - MAX_HISTORY_YEARS);
  return rightsDate >= cutoff.toISOString().slice(0, 10);
}

async function alreadyFetched(ticker: string, rightsDate: string): Promise<boolean> {
  const result = await ddbDocClient.send(
    new GetCommand({ TableName: GYAKUHIBU_ACTUAL_TABLE_NAME, Key: { ticker, rightsDate } }),
  );
  return result.Item !== undefined;
}

async function getUnitShares(ticker: string): Promise<number | undefined> {
  const result = await ddbDocClient.send(new GetCommand({ TableName: YUTAI_MASTER_TABLE_NAME, Key: { ticker } }));
  return typeof result.Item?.unitShares === 'number' ? result.Item.unitShares : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// taisyaku.jpへの連続リクエストの間隔。公開されたレート制限は無いが、個人利用の
// バッチとして無配慮に連打しないための最低限の間隔(数百ms〜数秒程度あれば十分)。
const BETWEEN_REQUESTS_DELAY_MS = Number(process.env.TAISYAKU_REQUEST_INTERVAL_MS ?? '1000');

export const handler = async (): Promise<void> => {
  const rows = await listPastRightsDates();

  for (const { ticker, rightsDate } of rows) {
    if (!isWithinPublishedRange(rightsDate)) continue;

    // taisyaku.jpへの実リクエストを行った場合だけループ末尾で待機する
    // (alreadyFetched/getUnitSharesでスキップした行まで待つのは無駄なため)。
    let attemptedFetch = false;
    try {
      if (await alreadyFetched(ticker, rightsDate)) continue;

      const unitShares = await getUnitShares(ticker);
      if (unitShares === undefined) {
        console.warn(`${ticker}: no unitShares in yutai master, skipping ${rightsDate}`);
        continue;
      }

      attemptedFetch = true;
      const csv = await fetchTaisyakuCsv(ticker, rightsDate, rightsDate);
      const point = parseTaisyakuCsv(csv, rightsDate, unitShares, ticker);
      if (!point) {
        // 品貸料が発生しなかった(または対象日がCSVに含まれていなかった)場合でも、
        // 「確認済みで実績なし」の行を書いておかないとalreadyFetchedが常にfalseになり、
        // 毎日この権利日を再スクレイピングし続けてしまう(Fix 2)。
        console.log(`${ticker}: no lending fee on ${rightsDate} (not a margin-shortage event); recording as checked`);
        await ddbDocClient.send(
          new PutCommand({
            TableName: GYAKUHIBU_ACTUAL_TABLE_NAME,
            Item: { ticker, rightsDate, totalAmount: 0, days: 0, avgRate: 0, noGyakuhibu: true },
          }),
        );
        continue;
      }

      await ddbDocClient.send(
        new PutCommand({
          TableName: GYAKUHIBU_ACTUAL_TABLE_NAME,
          Item: { ticker, rightsDate: point.rightsDate, totalAmount: point.totalAmount, days: point.days, avgRate: point.avgRate },
        }),
      );
      console.log(`${ticker}: upserted actual gyakuhibu for ${rightsDate}`);
    } catch (error) {
      console.error(`${ticker}: failed to fetch/upsert actual gyakuhibu for ${rightsDate}`, error);
    } finally {
      // 権利日1件ごとにtaisyaku.jpへ最大3リクエスト飛ばすため、次の権利日に移る前に
      // 一呼吸置く(実際にリクエストした場合のみ。成功・失敗いずれでも待つ)。
      if (attemptedFetch) await sleep(BETWEEN_REQUESTS_DELAY_MS);
    }
  }
};
