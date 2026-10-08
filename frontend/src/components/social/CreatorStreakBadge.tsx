import { useCreatorStreak } from "@/lib/creatorStreaks";

/** Shown from this many days in a row; a 1- or 2-day streak says little. */
export const STREAK_BADGE_MIN_DAYS = 3;

/**
 * "🔥 12-day streak": the creator checked in every day (founder, 2026-10-08). Shown on the coin card,
 * the coin page and the creator's profile while the streak is alive.
 */
export function CreatorStreakBadge({ wallet, compact = false, className = "" }: { wallet?: string | null; compact?: boolean; className?: string }) {
  const days = useCreatorStreak(wallet);
  if (days < STREAK_BADGE_MIN_DAYS) return null;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-[#7A3A0C] bg-[#2A1609] px-2 py-0.5 font-mw-mono text-xs font-semibold text-mw-accent-soft ${className}`}
      title={`The creator checked in ${days} days in a row`}
      data-creator-streak={days}
    >
      🔥 {days}{compact ? "d" : "-day streak"}
    </span>
  );
}
