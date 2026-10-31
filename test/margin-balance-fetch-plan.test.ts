import { CURSOR_KEY, BACKFILL_DAYS, todayJst, planFetchDates } from '../lambda/margin-balance-batch/fetch-plan';

describe('todayJst', () => {
  it('JST 20:00 は同じ日付', () => {
    expect(todayJst(Date.parse('2026-10-23T11:00:00Z'))).toBe('2026-10-23');
  });
  it('JST 0:30 で日付が変わる', () => {
    expect(todayJst(Date.parse('2026-10-23T15:30:00Z'))).toBe('2026-10-24');
  });
});

describe('planFetchDates', () => {
  it('初回(カーソル無し)は3年前から', () => {
    const r = planFetchDates({ today: '2026-10-23', lastFetchedDate: null, maxDates: 40 });
    expect(r).toHaveLength(40);
    expect(r[0]).toBe('2023-10-24');
    expect(r[1]).toBe('2023-10-25');
    expect([...r].sort()).toEqual(r);
    for (const d of r) {
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      expect([0, 6]).not.toContain(dow);
    }
  });
  it('初回で上限が大きければ今日まで', () => {
    const r = planFetchDates({ today: '2026-10-23', lastFetchedDate: null, maxDates: 10000 });
    expect(r).toHaveLength(731); // 年末年始休場(12/31・1/2・1/3)の平日7日を除く
    expect(r[r.length - 1]).toBe('2026-10-23');
  });
  it('カーソル日を取り直す', () => {
    expect(planFetchDates({ today: '2026-10-23', lastFetchedDate: '2026-10-21', maxDates: 40 }))
      .toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
  });
  it('週末を跨ぐ', () => {
    expect(planFetchDates({ today: '2026-10-26', lastFetchedDate: '2026-10-23', maxDates: 40 }))
      .toEqual(['2026-10-23', '2026-10-26']);
  });
  it('祝日を飛ばす', () => {
    expect(planFetchDates({ today: '2026-11-04', lastFetchedDate: '2026-11-02', maxDates: 40 }))
      .toEqual(['2026-11-02', '2026-11-04']);
  });
  it('追いつき中は上限で古い日から切る', () => {
    expect(planFetchDates({ today: '2026-10-23', lastFetchedDate: '2026-09-01', maxDates: 3 }))
      .toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
  });
  it('最新まで取得済みならカーソル日の取り直しだけ', () => {
    expect(planFetchDates({ today: '2026-10-24', lastFetchedDate: '2026-10-23', maxDates: 40 })).toEqual(['2026-10-23']);
    expect(planFetchDates({ today: '2026-10-23', lastFetchedDate: '2026-10-23', maxDates: 40 })).toEqual(['2026-10-23']);
  });
  it('カーソルが未来なら空', () => {
    expect(planFetchDates({ today: '2026-10-23', lastFetchedDate: '2026-10-26', maxDates: 40 })).toEqual([]);
  });
  it('backfillDays で初回の起点が変わる', () => {
    expect(planFetchDates({ today: '2026-10-23', lastFetchedDate: null, maxDates: 40, backfillDays: 2 }))
      .toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
  });
});

describe('定数', () => {
  it('CURSOR_KEY と BACKFILL_DAYS', () => {
    expect(CURSOR_KEY).toEqual({ ticker: '__cursor__', date: 'taisyaku' });
    expect(BACKFILL_DAYS).toBe(1095);
  });
});
