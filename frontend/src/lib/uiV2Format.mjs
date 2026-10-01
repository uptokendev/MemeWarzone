/** Pure helpers for the ui-v2 primitives (UI redesign). No data fetching. */

/** SVG polyline points for a sparkline, or null when fewer than two finite values. */
export function sparklinePoints(values, width, height) {
  const pts = (Array.isArray(values) ? values : []).map(Number).filter((v) => Number.isFinite(v));
  if (pts.length < 2) return null;
  const max = Math.max(...pts);
  const min = Math.min(...pts);
  const span = max - min || 1;
  const step = width / (pts.length - 1);
  return pts.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`).join(" ");
}

function toMs(target) {
  if (target == null || target === "") return NaN;
  if (target instanceof Date) return target.getTime();
  if (typeof target === "number") return target;
  return Date.parse(String(target));
}

/** "2d 4h", "3h 05m", "4m 09s"; null once the target has passed or is unreadable. */
export function formatCountdown(target, now = Date.now()) {
  const ms = toMs(target);
  if (!Number.isFinite(ms)) return null;
  const left = Math.floor((ms - now) / 1000);
  if (left <= 0) return null;
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  return `${m}m ${pad(s)}s`;
}
