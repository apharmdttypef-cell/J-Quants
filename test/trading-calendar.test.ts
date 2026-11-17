import {
  isTradingDay,
  settlementDate,
  businessDaysAfter,
  calendarDaysBetween,
  getLocalTradingCalendar,
  isJpHoliday,
  rightsDateForMonth,
  nextRightsDate,
  toRightsDay,
  todayJst,
  type CalendarDay,
} from '../lambda/shared/trading-calendar';

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

test('businessDaysAfter(n=1) returns the next single trading day, skipping a holiday gap', () => {
  const calendar: CalendarDay[] = [
    { date: '2026-08-10', holDiv: '1' }, // 月(基準日)
    { date: '2026-08-11', holDiv: '3' }, // 火(山の日、祝日=非営業日)
    { date: '2026-08-12', holDiv: '1' }, // 水(次の営業日)
  ];
  expect(businessDaysAfter(calendar, '2026-08-10', 1)).toBe('2026-08-12');
});

test('businessDaysAfter(n=2) matches settlementDate for the same calendar/date', () => {
  const calendar: CalendarDay[] = [
    { date: '2026-08-14', holDiv: '1' },
    { date: '2026-08-15', holDiv: '0' },
    { date: '2026-08-16', holDiv: '0' },
    { date: '2026-08-17', holDiv: '1' },
    { date: '2026-08-18', holDiv: '1' },
  ];
  expect(businessDaysAfter(calendar, '2026-08-14', 2)).toBe(settlementDate(calendar, '2026-08-14'));
});

// 品貸日数の正しい定義(日証金の用語集): 開始日=約定日のT+2(=settlementDate)、
// 終了日=そのT+2日の翌営業日。実データ(taisyaku.jp、7203)で検証済みの2ケースを
// 権利日→settlementDate→businessDaysAfter→calendarDaysBetween のフルパスで再現する。
// (2026-08-11 火は山の日で非営業日、08-08/09は週末)
describe('品貸日数(days) formula reproduces real taisyaku.jp data points for 7203', () => {
  const calendar: CalendarDay[] = [
    { date: '2026-08-05', holDiv: '1' }, // 水
    { date: '2026-08-06', holDiv: '1' }, // 木
    { date: '2026-08-07', holDiv: '1' }, // 金
    { date: '2026-08-08', holDiv: '0' }, // 土
    { date: '2026-08-09', holDiv: '0' }, // 日
    { date: '2026-08-10', holDiv: '1' }, // 月
    { date: '2026-08-11', holDiv: '3' }, // 火(山の日)
    { date: '2026-08-12', holDiv: '1' }, // 水
    { date: '2026-08-13', holDiv: '1' }, // 木
    { date: '2026-08-14', holDiv: '1' }, // 金
    { date: '2026-08-17', holDiv: '1' }, // 月
    { date: '2026-08-18', holDiv: '1' }, // 火
  ];

  function daysFor(rightsDate: string): number {
    const settlement = settlementDate(calendar, rightsDate);
    const followingTradingDay = businessDaysAfter(calendar, settlement, 1);
    return calendarDaysBetween(settlement, followingTradingDay);
  }

  test('2026-08-13 (Thu) -> 1 day', () => {
    expect(daysFor('2026-08-13')).toBe(1);
  });

  test('2026-08-12 (Wed) -> 3 days', () => {
    expect(daysFor('2026-08-12')).toBe(3);
  });

  test('2026-08-06 (Thu) -> 2 days', () => {
    expect(daysFor('2026-08-06')).toBe(2);
  });
});

// J-QuantsのFreeプラン「12週間遅延」制約が/markets/calendarにも適用されることが実機で
// 判明した(直近12週間分の営業日を要求すると400エラー)ため、暫定対応としてJ-Quantsに
// 頼らないローカル祝日計算に切り替える(スタンダードプラン移行後、この制約が無くなって
// いないか再確認すること)。
describe('isJpHoliday: known 2026 holidays, verified against public calendars', () => {
  test('元日(固定日) 2026-01-01', () => {
    expect(isJpHoliday('2026-01-01')).toBe(true);
  });

  test('成人の日(1月第2月曜) 2026-01-12', () => {
    expect(isJpHoliday('2026-01-12')).toBe(true);
    expect(isJpHoliday('2026-01-05')).toBe(false); // 第1月曜は対象外
  });

  test('春分の日(近似計算) 2026-03-20', () => {
    expect(isJpHoliday('2026-03-20')).toBe(true);
  });

  test('秋分の日(近似計算) 2026-09-23', () => {
    expect(isJpHoliday('2026-09-23')).toBe(true);
  });

  test('振替休日: 憲法記念日(2026-05-03、日曜)の振替が2026-05-06(水)に発生', () => {
    // 5/3(日,憲法記念日)→5/4(月,みどりの日で振替不可)→5/5(火,こどもの日で振替不可)→5/6(水,振替休日)
    expect(isJpHoliday('2026-05-03')).toBe(true);
    expect(isJpHoliday('2026-05-04')).toBe(true);
    expect(isJpHoliday('2026-05-05')).toBe(true);
    expect(isJpHoliday('2026-05-06')).toBe(true);
    expect(isJpHoliday('2026-05-07')).toBe(false);
  });

  test('国民の休日: 敬老の日(2026-09-21)と秋分の日(2026-09-23)に挟まれた2026-09-22', () => {
    expect(isJpHoliday('2026-09-21')).toBe(true);
    expect(isJpHoliday('2026-09-22')).toBe(true);
    expect(isJpHoliday('2026-09-23')).toBe(true);
  });

  test('通常の平日は祝日ではない', () => {
    expect(isJpHoliday('2026-08-18')).toBe(false); // 火曜、山の日(8/11)の翌週
  });
});

describe('getLocalTradingCalendar', () => {
  test('marks weekends and holidays as non-trading (holDiv 0), ordinary weekdays as trading (holDiv 1)', () => {
    const calendar = getLocalTradingCalendar('2026-08-08', '2026-08-12');
    expect(calendar).toEqual([
      { date: '2026-08-08', holDiv: '0' }, // 土
      { date: '2026-08-09', holDiv: '0' }, // 日
      { date: '2026-08-10', holDiv: '1' }, // 月
      { date: '2026-08-11', holDiv: '0' }, // 火、山の日
      { date: '2026-08-12', holDiv: '1' }, // 水
    ]);
  });

  test('marks the TSE year-end closures (12/31, 1/2, 1/3) as non-trading', () => {
    const calendar = getLocalTradingCalendar('2026-12-30', '2027-01-05');
    expect(calendar).toEqual([
      { date: '2026-12-30', holDiv: '1' }, // 水、大納会
      { date: '2026-12-31', holDiv: '0' }, // 木、休場
      { date: '2027-01-01', holDiv: '0' }, // 金、元日
      { date: '2027-01-02', holDiv: '0' }, // 土
      { date: '2027-01-03', holDiv: '0' }, // 日
      { date: '2027-01-04', holDiv: '1' }, // 月、大発会
      { date: '2027-01-05', holDiv: '1' },
    ]);
  });

  test('reproduces the same 品貸日数 formula results as the manually-constructed calendar fixture above', () => {
    const calendar = getLocalTradingCalendar('2026-08-01', '2026-08-20');
    const settlement = settlementDate(calendar, '2026-08-13');
    const followingTradingDay = businessDaysAfter(calendar, settlement, 1);
    expect(calendarDaysBetween(settlement, followingTradingDay)).toBe(1);
  });
});

describe('rightsDateForMonth', () => {
  test('2026-08 (月末最終営業日8/31・月曜) -> 2026-08-27(T、2営業日前)', () => {
    const calendar = getLocalTradingCalendar('2026-08-01', '2026-08-31');
    expect(rightsDateForMonth(calendar, 2026, 8, null)).toBe('2026-08-27');
  });

  test('2026-02 (月末最終営業日2/27・金曜) -> 2026-02-25(T、2営業日前)', () => {
    const calendar = getLocalTradingCalendar('2026-02-01', '2026-02-28');
    expect(rightsDateForMonth(calendar, 2026, 2, null)).toBe('2026-02-25');
  });

  test('2026-12 (大納会12/30・水曜) -> 2026-12-28(T、2営業日前)', () => {
    const calendar = getLocalTradingCalendar('2026-12-01', '2026-12-31');
    expect(rightsDateForMonth(calendar, 2026, 12, null)).toBe('2026-12-28');
  });

  test('該当月に営業日が1件も無いカレンダーではundefinedを返す', () => {
    const calendar = getLocalTradingCalendar('2026-08-01', '2026-08-31');
    expect(rightsDateForMonth(calendar, 2026, 9, null)).toBeUndefined();
  });
});

describe('nextRightsDate', () => {
  test('returns undefined when rightsMonths is empty', () => {
    expect(nextRightsDate([], null)).toBeUndefined();
  });

  test('returns a date matching the YYYY-MM-DD format for a non-empty rightsMonths', () => {
    const result = nextRightsDate([8], null);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('keeps the current month through its rights date and moves to next year the day after', () => {
    expect(nextRightsDate([10], null, '2026-10-28')).toBe('2026-10-28');
    expect(nextRightsDate([10], null, '2026-10-29')).toBe('2027-10-27');
  });

  test('the returned date is always today or later', () => {
    const today = todayJst();
    const result = nextRightsDate([1, 4, 7, 10], null);
    expect(result).toBeDefined();
    expect(result! >= today).toBe(true);
  });
});

describe('todayJst', () => {
  test('uses the JST date, which is a day ahead of UTC between 00:00 and 09:00 JST', () => {
    expect(todayJst(Date.parse('2026-10-28T15:00:00Z'))).toBe('2026-10-29'); // JST 10/29 00:00
    expect(todayJst(Date.parse('2026-10-28T14:59:59Z'))).toBe('2026-10-28'); // JST 10/28 23:59
  });
});

describe('rightsDateForMonth with rightsDay', () => {
  test('20日が平日(2026-05-20水) -> 2026-05-18', () => {
    const calendar = getLocalTradingCalendar('2026-05-01', '2026-05-31');
    expect(rightsDateForMonth(calendar, 2026, 5, 20)).toBe('2026-05-18');
  });

  test('20日が日曜(2026-09-20)なら直前の営業日9/18が権利確定日 -> 2026-09-16', () => {
    const calendar = getLocalTradingCalendar('2026-09-01', '2026-09-30');
    expect(rightsDateForMonth(calendar, 2026, 9, 20)).toBe('2026-09-16');
  });

  test('20日が祝日(2026-03-20春分の日)なら3/19が権利確定日 -> 2026-03-17', () => {
    const calendar = getLocalTradingCalendar('2026-03-01', '2026-03-31');
    expect(rightsDateForMonth(calendar, 2026, 3, 20)).toBe('2026-03-17');
  });

  test('15日(2026-05-15金) -> 2026-05-13', () => {
    const calendar = getLocalTradingCalendar('2026-05-01', '2026-05-31');
    expect(rightsDateForMonth(calendar, 2026, 5, 15)).toBe('2026-05-13');
  });

  test('taisyaku.jpの実績がある日付と一致する(2678: 2025-11-18, 2025-05-16 / 8227: 2026-02-18)', () => {
    const calendar = getLocalTradingCalendar('2025-01-01', '2026-12-31');
    expect(rightsDateForMonth(calendar, 2025, 11, 20)).toBe('2025-11-18');
    expect(rightsDateForMonth(calendar, 2025, 5, 20)).toBe('2025-05-16');
    expect(rightsDateForMonth(calendar, 2026, 2, 20)).toBe('2026-02-18');
  });

  test('nullは月末(従来どおり)', () => {
    const calendar = getLocalTradingCalendar('2026-08-01', '2026-08-31');
    expect(rightsDateForMonth(calendar, 2026, 8, null)).toBe('2026-08-27');
  });
});

describe('nextRightsDate with rightsDay', () => {
  test('20日締めの5月・11月で、11/17時点の次の権利付き最終日は2026-11-18', () => {
    expect(nextRightsDate([5, 11], 20, '2026-11-17')).toBe('2026-11-18');
  });

  test('11/19時点では翌年5月の2027-05-18', () => {
    expect(nextRightsDate([5, 11], 20, '2026-11-19')).toBe('2027-05-18');
  });
});

describe('toRightsDay', () => {
  test.each([
    [20, 20],
    [15, 15],
    [1, 1],
    [31, 31],
    [null, null],
    [undefined, null],
    [0, null],
    [32, null],
    [20.5, null],
    ['20', null],
  ])('toRightsDay(%p) -> %p', (input, expected) => {
    expect(toRightsDay(input)).toBe(expected);
  });
});
