/** Compact count for model statistics: 950, 12.3k, 1.2M. */
export function formatCompactCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0';
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0).replace(/\.0$/, '')}M`;
}

/** Model extent along each axis from its world-space bounds, in glTF units (meters). */
export function formatModelSize(bounds?: { min: number[]; max: number[] }): string | null {
  if (!bounds || bounds.min.length !== 3 || bounds.max.length !== 3) return null;
  const extent = bounds.max.map((max, axis) => max - bounds.min[axis]);
  if (!extent.every((value) => Number.isFinite(value) && value >= 0)) return null;
  const format = (value: number) => (value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2));
  return extent.map(format).join(' × ');
}
