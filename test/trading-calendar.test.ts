import { isTradingDay, settlementDate, calendarDaysBetween, fetchTradingCalendar, type CalendarDay } from '../lambda/shared/trading-calendar';

const mockFetch = jest.fn();
beforeEach(() => {
  mockFetch.mockReset();
  (global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;
});

test('isTradingDay treats HolDiv 1 (business day) and 2 (half day) as trading days', () => {
  expect(isTradingDay({ date: '2026-08-17', holDiv: '1' })).toBe(true);
  expect(isTradingDay({ date: '2026-08-17', holDiv: '2' })).toBe(true);
  expect(isTradingDay({ date: '2026-08-17', holDiv: '0' })).toBe(false);
  expect(isTradingDay({ date: '2026-08-17', holDiv: '3' })).toBe(false);
});

test('settlementDate returns the 2nd trading day after tradeDate (T+2)', () => {
  const calendar: CalendarDay[] = [
    { date: '2026-08-14', holDiv: '1' }, // 金(基準日)
    { date: '2026-08-15', holDiv: '0' }, // 土
    { date: '2026-08-16', holDiv: '0' }, // 日
    { date: '2026-08-17', holDiv: '1' }, // 月(T+1)
    { date: '2026-08-18', holDiv: '1' }, // 火(T+2)
  ];
  expect(settlementDate(calendar, '2026-08-14')).toBe('2026-08-18');
});

test('calendarDaysBetween counts calendar days including weekends', () => {
  expect(calendarDaysBetween('2026-08-14', '2026-08-18')).toBe(4);
});

test('fetchTradingCalendar calls /markets/calendar with from/to and returns the data array', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ data: [{ Date: '2026-08-14', HolDiv: '1' }] }),
  });

  const result = await fetchTradingCalendar('https://api.jquants.com/v2', 'test-api-key', '2026-08-01', '2026-08-31');

  expect(mockFetch).toHaveBeenCalledWith(
    'https://api.jquants.com/v2/markets/calendar?from=2026-08-01&to=2026-08-31',
    { headers: { 'x-api-key': 'test-api-key' } },
  );
  expect(result).toEqual([{ date: '2026-08-14', holDiv: '1' }]);
});
