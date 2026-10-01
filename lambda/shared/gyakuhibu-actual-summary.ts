// JQuantsGyakuhibuActualの履歴から「前回」と「前年同月」を選び、必要株数ベースの
// 概算コストに組み直す。純関数のみ(DynamoDBには触れない)。

export interface GyakuhibuActualRef {
  rightsDate: string;
  // 1株1日あたりの品貸料率。株数にも日数にも依存しない。
  avgRate: number;
  days: number;
  // 1株あたりのその権利日の品貸料(= avgRate × days)。taisyaku.jpの生の値に相当する。
  perShareRate: number;
  // perShareRate × 株数。
  cost: number;
  // requiredSharesが未取得で、単元株数で代用したことを画面に示すためのフラグ。
  basedOnUnitShares: boolean;
}

export interface ActualRowInput {
  rightsDate?: unknown;
  avgRate?: unknown;
  days?: unknown;
}

interface UsableRow {
  rightsDate: string;
  avgRate: number;
  days: number;
}

// JQuantsGyakuhibuActual.totalAmountは記録当時のunitSharesを掛けた値なので、
// 必要株数が変わると意味が合わなくなる。avgRateとdaysは株数に依存しないため、
// ここから組み直す(設計書の「コストの再計算」参照)。totalAmountは読まない。
function toRef(row: UsableRow, shares: number, basedOnUnitShares: boolean): GyakuhibuActualRef {
  const perShareRate = row.avgRate * row.days;
  return {
    rightsDate: row.rightsDate,
    avgRate: row.avgRate,
    days: row.days,
    perShareRate,
    cost: perShareRate * shares,
    basedOnUnitShares,
  };
}

// 逆日歩が付かなかった権利日はavgRate=0・days=0で記録される。これは「コスト0円」
// という有用な情報なので、days>0や真偽値で捨ててはならない。数値かどうかだけを見る。
// NaN/Infinityはtypeofでは数値だがコストをNaN/Infinityにしてしまうので有限値のみ通す。
function usableRows(rows: ActualRowInput[]): UsableRow[] {
  const usable: UsableRow[] = [];
  for (const row of rows) {
    if (typeof row.rightsDate !== 'string') continue;
    if (typeof row.avgRate !== 'number' || !Number.isFinite(row.avgRate)) continue;
    if (typeof row.days !== 'number' || !Number.isFinite(row.days)) continue;
    usable.push({ rightsDate: row.rightsDate, avgRate: row.avgRate, days: row.days });
  }
  return usable.sort((a, b) => a.rightsDate.localeCompare(b.rightsDate));
}

export function summarizeActuals(
  rows: ActualRowInput[],
  nextRightsDate: string | undefined,
  requiredShares: number | null,
  unitShares: number,
): { last: GyakuhibuActualRef | null; sameMonthLastYear: GyakuhibuActualRef | null } {
  const basedOnUnitShares = requiredShares === null;
  const shares = requiredShares ?? unitShares;
  const sorted = usableRows(rows);
  if (sorted.length === 0) return { last: null, sameMonthLastYear: null };

  const last = toRef(sorted[sorted.length - 1], shares, basedOnUnitShares);

  // 権利月ごとに需給の季節性が出る(同じ銘柄でも3月と9月で逆日歩が大きく違う)ため、
  // 直近の権利日だけでなく「次回と同じ月の前年」も見せる。
  let sameMonthLastYear: GyakuhibuActualRef | null = null;
  if (nextRightsDate !== undefined) {
    const targetYear = Number(nextRightsDate.slice(0, 4)) - 1;
    const targetMonth = nextRightsDate.slice(5, 7);
    const prefix = `${targetYear}-${targetMonth}`;
    // 同月に複数行あることは通常ないが、あれば遅い方(sorted末尾側)を採る。
    const match = sorted.filter((row) => row.rightsDate.startsWith(prefix)).pop();
    if (match) sameMonthLastYear = toRef(match, shares, basedOnUnitShares);
  }

  return { last, sameMonthLastYear };
}
