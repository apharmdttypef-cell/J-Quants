import { getLocalTradingCalendar, isTradingDay } from '../shared/trading-calendar';
import { shiftIsoDate } from '../shared/gyakuhibu-forecast';

// 取得済み日付を記録するカーソル行のキー(信用残テーブル内。銘柄行とは ticker で区別する)
export const CURSOR_KEY = { ticker: '__cursor__', date: 'taisyaku' } as const;

// 初回(カーソル無し)に遡る日数。3年 = 3 × 365
export const BACKFILL_DAYS = 3 * 365;

// 「今日」はJST。UTCの15:00以降は翌日になる
export function todayJst(now: number): string {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// その回に取得する申込日を昇順で返す。
// - カーソル日自体も毎回取り直す(当日分が途中公表だった場合に備える)
// - 追いつき中は古い日から maxDates 件で切る(カーソルを連続した成功日で表すため)
// - 営業日はローカル祝日計算に従う。12/31等の休場日が含まれうるが、0件の日は
//   handler側で休場日とみなして進める(today の0件だけ「未公表」として打ち切る)
export function planFetchDates(args: {
  today: string;
  lastFetchedDate: string | null;
  maxDates: number;
  backfillDays?: number;
}): string[] {
  const { today, lastFetchedDate, maxDates, backfillDays = BACKFILL_DAYS } = args;
  const from = lastFetchedDate ?? shiftIsoDate(today, -backfillDays);
  if (from > today) return [];
  return getLocalTradingCalendar(from, today)
    .filter(isTradingDay)
    .map((d) => d.date)
    .slice(0, maxDates);
}
