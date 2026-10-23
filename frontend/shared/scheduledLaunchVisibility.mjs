// Unix second at which a timed launch is still closed, or null once the coin
// is public. Solana uses the draft schedule. Gen-8 also uses the pool openAt,
// including a deploy the draft mark stored without a schedule.
export function tradingPageClosedUntil({ status, scheduledLaunchAt, gen8OpenAt, nowSec }) {
  const now = Number(nowSec);
  const times = [];
  const scheduled = Number(scheduledLaunchAt);
  const open = Number(gen8OpenAt);
  if (String(status || "").toLowerCase() === "scheduled" && Number.isFinite(scheduled) && scheduled > now) {
    times.push(scheduled);
  }
  if (Number.isFinite(open) && open > now) times.push(open);
  if (!times.length) return null;
  return Math.max(...times);
}
