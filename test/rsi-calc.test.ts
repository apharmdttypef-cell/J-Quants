import { calcRsi, computeRsiSnapshot, toRsiLabel } from '../lambda/shared/rsi-calc';

// startから1ずつ動く系列。stepsの各要素(+1/-1/0)を順に足していく。
function walk(start: number, steps: number[]): number[] {
  const closes = [start];
  for (const step of steps) closes.push(closes[closes.length - 1] + step);
  return closes;
}

function repeat<T>(value: T, count: number): T[] {
  return Array.from({ length: count }, () => value);
}

const alternating14 = [1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1];

describe('calcRsi', () => {
  test('#1 returns null with only 14 closes', () => {
    expect(calcRsi(walk(100, repeat(1, 13)))).toBeNull();
  });

  test('#2 returns 100 when every day rises', () => {
    expect(calcRsi(walk(100, repeat(1, 14)))).toBe(100);
  });

  test('#3 returns 0 when every day falls', () => {
    expect(calcRsi(walk(100, repeat(-1, 14)))).toBe(0);
  });

  test('#4 returns 50 when the price never moves', () => {
    expect(calcRsi(repeat(100, 15))).toBe(50);
  });

  test('#5 returns 50 when rises and falls alternate evenly', () => {
    expect(calcRsi(walk(100, alternating14))).toBe(50);
  });

  test('#6 applies Wilder smoothing after the initial average', () => {
    // 初期平均 上昇0.5/下落0.5 → +2で 上昇1.25/下落0.25、RS=5
    expect(calcRsi([10, 11, 10, 12], 2)).toBeCloseTo(83.333, 2);
  });

  test('#7 returns null when only 14 closes remain after dropping missing values', () => {
    const closes = [...walk(100, repeat(1, 13)), null, Number.NaN, undefined];
    expect(calcRsi(closes)).toBeNull();
  });

  test('#8 ignores missing values', () => {
    const clean = walk(100, [1, -1, 2, -1, 1, 1, -2, 1, 1, -1, 2, 1, -1, 1]);
    const withGaps = [clean[0], null, ...clean.slice(1, 7), Number.NaN, ...clean.slice(7), undefined];
    expect(calcRsi(withGaps)).toBe(calcRsi(clean));
  });

  test('#9 smooths over the whole series, not only the last 15 closes', () => {
    const closes = walk(100, [...repeat(1, 45), ...alternating14]);
    expect(closes).toHaveLength(60);
    expect(calcRsi(closes.slice(-15))).toBe(50);
    expect(calcRsi(closes)).toBeGreaterThan(50);
  });

  test('#10 returns null when only 14 closes follow a split', () => {
    const closes = [...walk(1000, repeat(1, 19)), 500, ...walk(501, repeat(1, 12))];
    expect(calcRsi(closes)).toBeNull();
  });

  test('#11 uses only the closes from the split day onwards', () => {
    const afterSplit = walk(500, alternating14.map((step) => step * 3));
    const closes = [...walk(1000, repeat(1, 19)), ...afterSplit];
    expect(calcRsi(closes)).toBe(calcRsi(afterSplit));
  });

  test('#12 does not treat a fall to 0.56 of the previous close as a split', () => {
    expect(calcRsi([...repeat(100, 14), 56])).toBe(0);
  });

  test('#13 treats a fall to exactly 0.55 of the previous close as a split', () => {
    expect(calcRsi([...repeat(100, 14), 55])).toBeNull();
  });

  test('#14 uses only the closes after the last of two splits', () => {
    const afterSecond = walk(25, alternating14);
    const closes = [...repeat(100, 5), 50, ...repeat(50, 5), ...afterSecond];
    expect(calcRsi(closes)).toBe(calcRsi(afterSecond));
  });

  test('#15 uses only the closes from a reverse split day onwards', () => {
    const afterMerge = walk(200, alternating14.map((step) => step * 2));
    const closes = [...repeat(100, 20), ...afterMerge];
    expect(calcRsi(closes)).toBe(calcRsi(afterMerge));
  });

  test('#16 does not treat a rise to 1.8 times the previous close as a reverse split', () => {
    expect(calcRsi([...repeat(100, 14), 180])).toBe(100);
  });
});

describe('toRsiLabel', () => {
  test.each([
    [70.0, 'high'],
    [69.99, 'neutral'],
    [30.0, 'low'],
    [30.01, 'neutral'],
    [null, 'na'],
  ] as const)('%p -> %s', (rsi, label) => {
    expect(toRsiLabel(rsi)).toBe(label);
  });
});

describe('computeRsiSnapshot', () => {
  // 2026-10-01から1日ずつ日付を振った株価行(新しい順で返す = Queryの降順と同じ)
  function rows(closes: number[]): Array<Record<string, unknown>> {
    return closes
      .map((close, i) => {
        const date = new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10);
        return { ticker: '1234', date, close };
      })
      .reverse();
  }

  test('computes from rows in any order, rounds rsi14 to one decimal, and reports the latest date', () => {
    // 初期14差分は上昇10回・下落4回(平均上昇10/14、平均下落4/14)→ 最後の+1で平滑化
    const closes = walk(100, [1, 1, 1, 1, 1, -1, 1, 1, -1, 1, 1, -1, 1, -1, 1]);
    const snapshot = computeRsiSnapshot(rows(closes), '2026-10-20');
    const exact = calcRsi(closes)!;
    expect(snapshot).toEqual({ rsi14: Math.round(exact * 10) / 10, rsiLabel: toRsiLabel(exact), rsiAsOf: '2026-10-16' });
  });

  test('labels from the unrounded value', () => {
    // 上昇69.96・下落30.04だけの15件 → RSI=69.96。丸めると70.0になるが、丸め前は70未満
    const closes = walk(1000, [69.96, -30.04, ...repeat(0, 12)]);
    const exact = calcRsi(closes)!;
    expect(exact).toBeLessThan(70);
    expect(Math.round(exact * 10) / 10).toBe(70);
    expect(computeRsiSnapshot(rows(closes), '2026-10-16').rsiLabel).toBe('neutral');
  });

  test('is na when the latest close is 8 days old', () => {
    // 最新は2026-10-15
    expect(computeRsiSnapshot(rows(walk(100, repeat(1, 14))), '2026-10-23')).toEqual({
      rsi14: null,
      rsiLabel: 'na',
      rsiAsOf: null,
    });
  });

  test('still computes when the latest close is exactly 7 days old', () => {
    expect(computeRsiSnapshot(rows(walk(100, repeat(1, 14))), '2026-10-22')).toEqual({
      rsi14: 100,
      rsiLabel: 'high',
      rsiAsOf: '2026-10-15',
    });
  });

  test('is na with no price rows', () => {
    expect(computeRsiSnapshot([], '2026-10-22')).toEqual({ rsi14: null, rsiLabel: 'na', rsiAsOf: null });
  });

  test('skips rows without a numeric close or a date string', () => {
    const valid = rows(walk(100, repeat(1, 14)));
    const withBroken = [{ ticker: '1234', date: '2026-10-16', close: null }, ...valid, { ticker: '1234', close: 99 }];
    expect(computeRsiSnapshot(withBroken, '2026-10-16')).toEqual({ rsi14: 100, rsiLabel: 'high', rsiAsOf: '2026-10-15' });
  });
});
