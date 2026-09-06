import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { fetchAllListings, KabuyutaiEntry } from '../shared/kabuyutai-client';

const YUTAI_MASTER_TABLE_NAME = process.env.YUTAI_MASTER_TABLE_NAME!;
const UNIT_SHARES = 100;
const TDNET_BASE_URL = 'https://www.release.tdnet.info';
const USER_AGENT = 'Mozilla/5.0 (compatible; JQuantsYutaiBot/1.0)';
const REQUEST_INTERVAL_MS = Number(process.env.TDNET_REQUEST_INTERVAL_MS ?? '1000');
// 週次実行なので、直近7日分をカバーすれば理屈上は取りこぼしが無いはずだが、実行が
// 多少遅れたり単発の日次フェッチが失敗したりした場合に備えて2日分の重なりを持たせる
// (冪等: 既に処理済みの銘柄は次のkabuyutai.com再取得で同じ内容がそのままupsertされるだけで実害は無い)。
const LOOKBACK_DAYS = Number(process.env.TDNET_LOOKBACK_DAYS ?? '9');
// 実際の表記ゆれ(新設/一部変更/廃止 等)は実機で確認しながら調整する。
const YUTAI_KEYWORDS = ['株主優待'];
// 上記に加えてこのキーワードも含む場合、優待「廃止」の開示とみなす。kabuyutai.comの
// 最新一覧に見当たらない、という状態と組み合わさった時だけ本当の廃止として削除する
// (トランジェントなスクレイピング失敗だけでは削除しない、というゲート)。
const ABOLITION_KEYWORDS = ['廃止'];

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

function isAbolitionRelated(title: string): boolean {
  return ABOLITION_KEYWORDS.some((keyword) => title.includes(keyword));
}

function totalPagesFor(html: string): number {
  // 件数バナーの区切りはHTMLエンティティのリテラル"&nbsp;"で出現する(実データで確認済み:
  // docs/superpowers/notes/2026-08-20-tdnet-list-page-format.md、および本ファイルのテストの
  // dayListHtml()ヘルパー参照)。\sはエンティティ文字列にはマッチしないため、素の空白・
  // &nbsp;・全角/半角スラッシュいずれの表記ゆれにも対応する。
  const match = html.match(/(\d+)～(\d+)件(?:\s|&nbsp;|／|\/)*全(\d+)件/);
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
  // ticker -> その銘柄にマッチした開示のうち、廃止キーワードを含むものが1件でもあったか
  // (同一tickerに複数の開示がヒットし得るため、どれか1つでもtrueならtrueのまま保持する)。
  const matchedTickers = new Map<string, boolean>();
  let failedDays = 0;

  for (let daysAgo = 0; daysAgo < LOOKBACK_DAYS; daysAgo++) {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    const dateStr = formatDate(date);

    try {
      const disclosures = await fetchDayDisclosures(dateStr);
      for (const disclosure of disclosures) {
        if (isYutaiRelated(disclosure.title)) {
          const ticker = toTicker(disclosure.code);
          const sawAbolitionAlready = matchedTickers.get(ticker) ?? false;
          matchedTickers.set(ticker, sawAbolitionAlready || isAbolitionRelated(disclosure.title));
        }
      }
    } catch (error) {
      failedDays++;
      console.error(`Failed to fetch TDnet disclosures for ${dateStr}`, error);
    }

    await sleep(REQUEST_INTERVAL_MS);
  }

  // 全日分が失敗した場合はサイト側の構造変化・Bot対策等の可能性が高く、「開示0件だった」
  // と区別が付かないまま黙って成功扱いになるのを避けるため、Lambda呼び出し自体を失敗させる。
  // 一部の日だけ失敗した場合は部分的な結果でも処理を続行する(投げない)。
  if (failedDays === LOOKBACK_DAYS) {
    throw new Error(`All ${LOOKBACK_DAYS} days failed to fetch from TDnet; treating this run as failed rather than silently reporting success`);
  }

  if (matchedTickers.size === 0) return;

  // ticker毎にfindTicker(最悪12ヶ月×複数ページ走査)を呼ぶと、マッチ銘柄数によっては
  // Lambdaのタイムアウトに近づく(特に廃止銘柄は見つからないので必ずフルスキャンになる)。
  // サイト全体を1回だけ走査してMapを作り、各tickerはそこから引く方式にコストを固定する。
  const listings = await fetchAllListings();
  const listingsByTicker = new Map<string, KabuyutaiEntry>(listings.map((entry) => [entry.ticker, entry]));

  for (const [ticker, sawAbolitionKeyword] of matchedTickers) {
    try {
      const entry = listingsByTicker.get(ticker);
      if (!entry) {
        if (sawAbolitionKeyword) {
          // 廃止を示す開示があり、かつ最新のkabuyutai.com一覧にも見当たらない
          // (両方のシグナルが揃って初めて削除する。片方だけでは一時的な取得失敗の
          // 可能性があるため警告に留める)。
          await ddbDocClient.send(new DeleteCommand({ TableName: YUTAI_MASTER_TABLE_NAME, Key: { ticker } }));
          console.log(`${ticker}: yutai program appears discontinued (abolition disclosure + not found on kabuyutai.com); deleted from master`);
        } else {
          console.warn(`${ticker}: matched a yutai-related TDnet disclosure but not found on kabuyutai.com; skipping`);
        }
        continue;
      }
      if (entry.rightsMonths.length === 0) {
        console.warn(`${ticker}: found on kabuyutai.com but rightsMonths incomplete; skipping`);
        continue;
      }

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
      console.log(`${ticker}: upserted yutai master from TDnet-triggered re-sync`);
    } catch (error) {
      console.error(`${ticker}: failed to re-sync from TDnet match`, error);
    }
  }
};
