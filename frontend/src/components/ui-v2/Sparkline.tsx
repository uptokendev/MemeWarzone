import { sparklinePoints } from "@/lib/uiV2Format.mjs";

/** Line sparkline from a series of numbers. Colour follows first vs last value. */
export function Sparkline({ values, width = 80, height = 28, label }: { values: number[]; width?: number; height?: number; label?: string }) {
  const points = sparklinePoints(values, width, height);
  if (!points) return null;
  const finite = values.filter((v) => Number.isFinite(v));
  const up = finite[finite.length - 1] >= finite[0];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <polyline points={points} fill="none" stroke={up ? "var(--mw-up)" : "var(--mw-down)"} strokeWidth={1.6} />
    </svg>
  );
}
