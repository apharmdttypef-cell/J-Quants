// SoftHompo(https://softhompo.a.la9.jp/Data/StockData.html)の日次株価データ。
// 東証「株式相場表」を加工したCSVで、1日1ファイルに東証の全銘柄が入っている。
// 前営業日分が翌営業日の朝に公表される。

export interface SoftHompoBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

// 見出し行(3行目)。午前・午後で「始値〜終値」の4列が2回並ぶ。
export const SOFTHOMPO_CSV_HEADER: readonly string[] = [
  '! コード',
  'フラグ',
  '売買単位',
  '銘柄名',
  '始値(円)',
  '高値(円)',
  '安値(円)',
  '終値(円)',
  '始値(円)',
  '高値(円)',
  '安値(円)',
  '終値(円)',
  '最終気配(円)',
  '前日比(円)',
  '売買高加重平均価格(円)',
  '売買高(千株)',
  '売買代金(千円)',
];

// 見出しや列数が想定と違う(仕様変更・エラーページなど)場合に投げる。バッチを失敗させて気づけるようにする。
export class SoftHompoCsvFormatError extends Error {}

// 値にカンマは含まれない(実ファイルで確認)。各行の末尾にカンマがあり、空の列が1つ付くので落とす。
function splitRow(line: string): string[] {
  const cols = line.split(',').map((col) => col.replace(/^"|"$/g, ''));
  if (cols[cols.length - 1] === '') cols.pop();
  return cols;
}

// 取引の無かった場の値は「－」(全角ハイフン)。
function toNumber(raw: string): number | null {
  if (raw === '' || raw === '－') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function maxOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function minOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

// 銘柄コード → 1日分の四本値と出来高。終日取引の無かった銘柄は含めない。
export function parseSoftHompoCsv(csvText: string): Map<string, SoftHompoBar> {
  const lines = csvText.replace(/^﻿/, '').split(/\r?\n/);

  const headerLine = lines.find((line) => line.startsWith('"! コード"'));
  if (headerLine === undefined) {
    throw new SoftHompoCsvFormatError('softhompo: heading row not found');
  }
  const header = splitRow(headerLine);
  if (
    header.length !== SOFTHOMPO_CSV_HEADER.length ||
    header.some((name, i) => name !== SOFTHOMPO_CSV_HEADER[i])
  ) {
    throw new SoftHompoCsvFormatError(`softhompo: unexpected heading row: ${headerLine}`);
  }

  const bars = new Map<string, SoftHompoBar>();
  for (const line of lines) {
    // 見出し・ページ見出しなどのコメント行は「"!」で始まる
    if (line === '' || line.startsWith('"!')) continue;

    const cols = splitRow(line);
    if (cols.length !== SOFTHOMPO_CSV_HEADER.length) {
      throw new SoftHompoCsvFormatError(`softhompo: expected ${SOFTHOMPO_CSV_HEADER.length} columns but got ${cols.length}: ${line}`);
    }

    const [amOpen, amHigh, amLow, amClose, pmOpen, pmHigh, pmLow, pmClose] = cols.slice(4, 12).map(toNumber);
    const close = pmClose ?? amClose;
    if (close === null) continue;

    const volumeThousands = toNumber(cols[15]);
    bars.set(cols[0], {
      open: (amOpen ?? pmOpen)!,
      high: maxOf(amHigh, pmHigh)!,
      low: minOf(amLow, pmLow)!,
      close,
      volume: volumeThousands === null ? null : Math.round(volumeThousands * 1000),
    });
  }
  return bars;
}
