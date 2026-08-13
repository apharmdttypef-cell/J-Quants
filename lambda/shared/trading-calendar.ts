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
