// Live battle countdown (founder, 2026-10-01): big, with seconds, between the two coins.
// Pure so it can be tested; the component only supplies Date.now() once a second.

const HOUR_MS = 60 * 60 * 1000;
const FINAL_MS = 5 * 60 * 1000;

function pad(value) {
  return String(value).padStart(2, "0");
}

/**
 * @param {string|number|Date|null|undefined} endsAt battle end time
 * @param {number} nowMs
 * @returns {{ text: string, urgency: "normal"|"hour"|"final"|"settling", remainingMs: number } | null}
 *   null when the end time is missing or unreadable.
 */
export function presentBattleCountdown(endsAt, nowMs) {
  if (endsAt === null || endsAt === undefined || endsAt === "") return null;
  const endMs = endsAt instanceof Date ? endsAt.getTime() : typeof endsAt === "number" ? endsAt : Date.parse(String(endsAt));
  if (!Number.isFinite(endMs) || !Number.isFinite(nowMs)) return null;

  const remainingMs = Math.max(0, endMs - nowMs);
  if (remainingMs <= 0) return { text: "Settling", urgency: "settling", remainingMs: 0 };

  // Round up so the clock reads 00:00:01 in the last second and never shows 00:00:00 while live.
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const days = Math.floor(hours / 24);
  // Up to 99 h the hours count straight through (a 48 h vote battle reads 47:59:59); a 7-day
  // metrics battle reads 6D 23:59:59.
  const text = hours >= 100 ? `${days}D ${pad(hours % 24)}:${pad(minutes)}:${pad(seconds)}` : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;

  const urgency = remainingMs <= FINAL_MS ? "final" : remainingMs <= HOUR_MS ? "hour" : "normal";
  return { text, urgency, remainingMs };
}
