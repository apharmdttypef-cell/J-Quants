export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 1 });
}

export function formatVolume(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('ja-JP');
}

export function formatPercent(value: number | null): string {
  if (value === null) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

// 日本市場の慣例: 上昇=赤(up)、下落=緑(down)。米国式とは逆なので注意。
export function trendClass(value: number | null): string {
  if (value === null || value === 0) return 'pct--flat';
  return value > 0 ? 'pct--up' : 'pct--down';
}

// 財務サマリの値はAPIから文字列で返る(大きい桁数のため)。空文字はデータなしを表す。
export function formatFinancialYen(raw: string | undefined): string {
  if (!raw) return '—';
  const value = Number(raw);
  if (Number.isNaN(value)) return '—';
  // 兆/億単位で読みやすく丸める
  if (Math.abs(value) >= 1_0000_0000_0000) return `${(value / 1_0000_0000_0000).toFixed(1)}兆円`;
  if (Math.abs(value) >= 1_0000_0000) return `${(value / 1_0000_0000).toFixed(1)}億円`;
  return `${value.toLocaleString('ja-JP')}円`;
}
