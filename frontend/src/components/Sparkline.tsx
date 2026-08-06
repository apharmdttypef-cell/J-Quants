interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
}

export function Sparkline({ values, width = 96, height = 28 }: SparklineProps) {
  if (values.length < 2) {
    return <svg width={width} height={height} aria-hidden="true" />;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = width / (values.length - 1);

  const points = values
    .map((value, index) => {
      const x = index * step;
      const y = height - ((value - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const trendUp = values[values.length - 1] >= values[0];

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke={trendUp ? 'var(--up)' : 'var(--down)'}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
