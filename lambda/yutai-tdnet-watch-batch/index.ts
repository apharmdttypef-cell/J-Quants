import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { findTicker } from '../shared/kabuyutai-client';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const UNIT_SHARES = 100;
const TDNET_BASE_URL = 'https://www.release.tdnet.info';
const USER_AGENT = 'Mozilla/5.0 (compatible; JQuantsYutaiBot/1.0)';
const REQUEST_INTERVAL_MS = Number(process.env.TDNET_REQUEST_INTERVAL_MS ?? '1000');
// 週次実行なので、直近7日分を毎回チェックすれば取りこぼしが無い(冪等: 既に処理済みの
// 銘柄は次のkabuyutai.com再取得で同じ内容がそのままupsertされるだけで実害は無い)。
const LOOKBACK_DAYS = Number(process.env.TDNET_LOOKBACK_DAYS ?? '7');
// 実際の表記ゆれ(新設/一部変更/廃止 等)は実機で確認しながら調整する。
const YUTAI_KEYWORDS = ['株主優待'];

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Disclosure {
  code: string;
  companyName: string;
  title: string;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

// TDnetの証券コードは5桁(末尾0付き)で出現する。JQuantsYutaiMasterの4桁tickerとは
// 先頭4桁を取れば一致する(実データで確認済み。ただし複数実例での検証は未了、
// docs/superpowers/notes/2026-08-20-tdnet-list-page-format.md参照)。
function toTicker(tdnetCode: string): string {
  return tdnetCode.slice(0, 4);
}

function parseDayPage(html: string): Disclosure[] {
  const disclosures: Disclosure[] = [];
  for (const rowMatch of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const row = rowMatch[1];
    const codeMatch = row.match(/class="[^"]*kjCode[^"]*"[^>]*>(\d+)</);
    const nameMatch = row.match(/class="[^"]*kjName[^"]*"[^>]*>([^<]+)</);
    const titleMatch = row.match(/class="[^"]*kjTitle[^"]*"[^>]*><a[^>]*>([^<]+)</);
    if (!codeMatch || !nameMatch || !titleMatch) continue;

    disclosures.push({ code: codeMatch[1], companyName: nameMatch[1].trim(), title: titleMatch[1].trim() });
  }
  return disclosures;
}

function isYutaiRelated(title: string): boolean {
  return YUTAI_KEYWORDS.some((keyword) => title.includes(keyword));
}

function totalPagesFor(html: string): number {
  const match = html.match(/(\d+)～(\d+)件\s*\/\s*全(\d+)件/);
  if (!match) return 1;
  const perPage = Number(match[2]) - Number(match[1]) + 1;
  const total = Number(match[3]);
  return perPage > 0 ? Math.max(1, Math.ceil(total / perPage)) : 1;
}

async function fetchDayDisclosures(dateStr: string): Promise<Disclosure[]> {
  const firstUrl = `${TDNET_BASE_URL}/inbs/I_list_001_${dateStr}.html`;
  const firstResponse = await fetch(firstUrl, { headers: { 'User-Agent': USER_AGENT } });
  if (firstResponse.status === 404) return []; // その日は開示が無かった
  if (!firstResponse.ok) {
    throw new Error(`TDnet error ${firstResponse.status} fetching ${firstUrl}`);
  }
  const firstHtml = await firstResponse.text();
  const disclosures = parseDayPage(firstHtml);
  const totalPages = totalPagesFor(firstHtml);

  for (let page = 2; page <= totalPages; page++) {
    await sleep(REQUEST_INTERVAL_MS);
    const url = `${TDNET_BASE_URL}/inbs/I_list_${String(page).padStart(3, '0')}_${dateStr}.html`;
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) {
      throw new Error(`TDnet error ${response.status} fetching ${url}`);
    }
    disclosures.push(...parseDayPage(await response.text()));
  }

  return disclosures;
}

export const handler = async (): Promise<void> => {
  const matchedTickers = new Set<string>();

  for (let daysAgo = 0; daysAgo < LOOKBACK_DAYS; daysAgo++) {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    const dateStr = formatDate(date);

    try {
      const disclosures = await fetchDayDisclosures(dateStr);
      for (const disclosure of disclosures) {
        if (isYutaiRelated(disclosure.title)) {
          matchedTickers.add(toTicker(disclosure.code));
        }
      }
    } catch (error) {
      console.error(`Failed to fetch TDnet disclosures for ${dateStr}`, error);
    }

    await sleep(REQUEST_INTERVAL_MS);
  }

  for (const ticker of matchedTickers) {
    try {
      const entry = await findTicker(ticker);
      if (!entry) {
        console.warn(`${ticker}: matched a yutai-related TDnet disclosure but not found on kabuyutai.com; skipping`);
        continue;
      }
      if (entry.value === undefined || entry.rightsMonths.length === 0) {
        console.warn(`${ticker}: found on kabuyutai.com but value/rightsMonths incomplete; skipping`);
        continue;
      }

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
      console.log(`${ticker}: upserted yutai master from TDnet-triggered re-sync`);
    } catch (error) {
      console.error(`${ticker}: failed to re-sync from TDnet match`, error);
    }
  }
};
