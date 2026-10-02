// 逆日歩予測 精度検証: 実績取得の対象銘柄を、既にObject Lockで凍結済みの
// スナップショットA(forecast-snapshots/rightsDate=2026-09-28/asof=2026-09-26T0000JST/run=run=1/)
// のforecast.jsonからそのまま読み込む。評価母集団を後から増減させないための唯一の正典。
// asofLabelが '2026-09-26T0000JST' 固定なのは、このLambdaが2026-09-28権利日専用の
// 検証実行が前提のため(実際にこの時刻でスナップショットAが発火・完了済み)。
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

export interface FrozenTarget {
  ticker: string;
  companyName: string;
  value: number | null;
  unitShares: number;
  requiredShares: number;
  closePrice: number | null;
  days: number;
}

interface FrozenForecastRecord {
  ticker: string;
  companyName: string;
  value: number | null;
  unitShares: number;
  requiredShares: number;
  closePrice: number | null;
  days: number;
}

interface FrozenForecastJson {
  records: FrozenForecastRecord[];
}

async function streamToString(stream: import('stream').Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function loadSnapshotATargets(
  s3Client: S3Client,
  bucket: string,
  snapshotAKey: string,
): Promise<FrozenTarget[]> {
  const result = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: snapshotAKey }));
  const body = await streamToString(result.Body as import('stream').Readable);
  const parsed = JSON.parse(body) as FrozenForecastJson;

  return parsed.records.map((r) => ({
    ticker: r.ticker,
    companyName: r.companyName,
    value: r.value,
    unitShares: r.unitShares,
    requiredShares: r.requiredShares,
    closePrice: r.closePrice,
    days: r.days,
  }));
}
