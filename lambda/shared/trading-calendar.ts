// J-Quants取引カレンダー(/markets/calendar、Freeプランで利用可)。
// HolDiv: 0=非営業日, 1=営業日, 2=東証半日立会日(受渡計算上は営業日扱い), 3=非営業日(祝日取引あり)
export interface CalendarDay {
  date: string;
  holDiv: string;
}

interface RawCalendarDay {
  Date: string;
  HolDiv: string;
}

interface CalendarResponse {
  data: RawCalendarDay[];
}

export function isTradingDay(day: CalendarDay): boolean {
  return day.holDiv === '1' || day.holDiv === '2';
}

export async function fetchTradingCalendar(
  apiBaseUrl: string,
  apiKey: string,
  from: string,
  to: string,
): Promise<CalendarDay[]> {
  const params = new URLSearchParams({ from, to });
  const response = await fetch(`${apiBaseUrl}/markets/calendar?${params}`, { headers: { 'x-api-key': apiKey } });
  if (!response.ok) {
    throw new Error(`J-Quants API error ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as CalendarResponse;
  return body.data.map((d) => ({ date: d.Date, holDiv: d.HolDiv }));
}

// dateのn営業日後を返す(n=1なら翌営業日、n=2はsettlementDateが計算するT+2と同じ)。
// calendarにはdateより後の日を十分な件数(最低n営業日分)含めておくこと。
export function businessDaysAfter(calendar: CalendarDay[], date: string, n: number): string {
  const upcoming = calendar
    .filter((d) => d.date > date && isTradingDay(d))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (upcoming.length < n) {
    throw new Error(`Not enough trading calendar data after ${date} to compute T+${n}`);
  }
  return upcoming[n - 1].date;
}

// tradeDateのT+2営業日(受渡日)を返す。calendarにはtradeDateより後の日を
// 十分な件数(最低2営業日分)含めておくこと。
export function settlementDate(calendar: CalendarDay[], tradeDate: string): string {
  return businessDaysAfter(calendar, tradeDate, 2);
}

export function calendarDaysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

// ---------------------------------------------------------------------------
// フェーズ1暫定対応: J-QuantsのFreeプラン「12週間遅延」制約が/markets/calendarにも
// 適用されることが実機で判明した(直近の営業日を要求すると400エラー)。この機能は
// 常に「今日〜近い未来」の営業日を必要とするため、J-Quantsに頼らず日本の祝日を
// ローカルで計算する。スタンダードプラン移行後、この制約が無くなっていないか
// fetchTradingCalendar(上記のJ-Quants呼び出し版)で再確認すること。
// ---------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, '0');
const toDateStr = (year: number, month: number, day: number) => `${year}-${pad2(month)}-${pad2(day)}`;

// year年month月のn番目のweekday(0=日,...,6=土)の日付(1〜31)を返す。
function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstWeekday = first.getUTCDay();
  const offset = (weekday - firstWeekday + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

// 春分の日・秋分の日の近似計算式(2000〜2099年で概ね正確。官報の公式決定とは
// 数年先でずれる可能性があるが、個人アプリの営業日目安としては十分)。
function vernalEquinoxDay(year: number): number {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}
function autumnalEquinoxDay(year: number): number {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

// その年の祝日(振替休日・国民の休日を含まない基本分)。
function baseHolidaysForYear(year: number): Set<string> {
  const dates = new Set<string>();
  dates.add(toDateStr(year, 1, 1)); // 元日
  dates.add(toDateStr(year, 1, nthWeekdayOfMonth(year, 1, 1, 2))); // 成人の日
  dates.add(toDateStr(year, 2, 11)); // 建国記念の日
  dates.add(toDateStr(year, 2, 23)); // 天皇誕生日(令和以降)
  dates.add(toDateStr(year, 3, vernalEquinoxDay(year))); // 春分の日
  dates.add(toDateStr(year, 4, 29)); // 昭和の日
  dates.add(toDateStr(year, 5, 3)); // 憲法記念日
  dates.add(toDateStr(year, 5, 4)); // みどりの日
  dates.add(toDateStr(year, 5, 5)); // こどもの日
  dates.add(toDateStr(year, 7, nthWeekdayOfMonth(year, 7, 1, 3))); // 海の日
  dates.add(toDateStr(year, 8, 11)); // 山の日
  dates.add(toDateStr(year, 9, nthWeekdayOfMonth(year, 9, 1, 3))); // 敬老の日
  dates.add(toDateStr(year, 9, autumnalEquinoxDay(year))); // 秋分の日
  dates.add(toDateStr(year, 10, nthWeekdayOfMonth(year, 10, 1, 2))); // スポーツの日
  dates.add(toDateStr(year, 11, 3)); // 文化の日
  dates.add(toDateStr(year, 11, 23)); // 勤労感謝の日
  return dates;
}

const addDays = (dateStr: string, n: number): string => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayOfWeek = (dateStr: string): number => new Date(`${dateStr}T00:00:00Z`).getUTCDay();

const holidayCache = new Map<number, Set<string>>();

// 振替休日(祝日が日曜のとき、後続の非祝日の平日を休日にする)・国民の休日
// (祝日に挟まれた非祝日の平日を休日にする)を適用した、その年の全祝日集合。
function allHolidaysForYear(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;

  const result = new Set(baseHolidaysForYear(year));

  // 振替休日
  for (const dateStr of [...result]) {
    if (dayOfWeek(dateStr) !== 0) continue;
    let next = addDays(dateStr, 1);
    while (result.has(next)) next = addDays(next, 1);
    result.add(next);
  }

  // 国民の休日: 前日・翌日が祝日で自身は非祝日・非日曜の平日
  for (const dateStr of [...result]) {
    const middle = addDays(dateStr, 1);
    const afterMiddle = addDays(dateStr, 2);
    if (!result.has(middle) && result.has(afterMiddle) && dayOfWeek(middle) !== 0) {
      result.add(middle);
    }
  }

  holidayCache.set(year, result);
  return result;
}

export function isJpHoliday(dateStr: string): boolean {
  const year = Number(dateStr.slice(0, 4));
  return allHolidaysForYear(year).has(dateStr);
}

// fetchTradingCalendarの代替(J-Quantsを呼ばずローカルで完結)。土日・日本の祝日を
// 非営業日(holDiv '0')、それ以外を営業日(holDiv '1')として、from〜to(両端含む)を返す。
export function getLocalTradingCalendar(from: string, to: string): CalendarDay[] {
  const days: CalendarDay[] = [];
  let cursor = from;
  while (cursor <= to) {
    const dow = dayOfWeek(cursor);
    const isWeekend = dow === 0 || dow === 6;
    const holDiv = !isWeekend && !isJpHoliday(cursor) ? '1' : '0';
    days.push({ date: cursor, holDiv });
    cursor = addDays(cursor, 1);
  }
  return days;
}

// year年month月の最終営業日から2営業日前(権利付き最終日T)を返す。calendarにその月の
// 営業日が1件も含まれない場合はundefined。優待マスタのrightsMonths(権利確定月)から
// 実際の権利付き最終日を都度計算するために使う(JQuantsYutaiRightsDateテーブル廃止に伴う)。
export function rightsDateForMonth(calendar: CalendarDay[], year: number, month: number): string | undefined {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const tradingDays = calendar.filter(isTradingDay).map((d) => d.date).sort();
  const monthTradingDays = tradingDays.filter((d) => d.startsWith(prefix));
  const record = monthTradingDays[monthTradingDays.length - 1];
  if (!record) return undefined;
  const idx = tradingDays.indexOf(record);
  return idx >= 2 ? tradingDays[idx - 2] : undefined;
}
