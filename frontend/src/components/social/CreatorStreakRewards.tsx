/**
 * The creator streak's reward line (founder, 2026-10-08): every 7 days in a row earns a free upvote.
 * Lives outside the league briefing card on purpose: league scoring never reads upvotes.
 */
export function CreatorStreakRewardLine({
  streak,
  currentStreak,
  alreadyCheckedIn,
  daysToReward,
  rewardsReady,
}: {
  streak: number;
  currentStreak?: number;
  alreadyCheckedIn: boolean;
  daysToReward: number;
  rewardsReady: number;
}) {
  const now = alreadyCheckedIn ? streak : Number(currentStreak ?? Math.max(0, streak - 1));
  // Days done in the current run of 7 (a run that just completed shows all 7); today's check-in fills
  // the next dot.
  const filled = alreadyCheckedIn && daysToReward === 7 && streak > 0 ? 7 : Math.max(0, Math.min(7, 7 - daysToReward));
  const headline = alreadyCheckedIn
    ? `🔥 ${streak}-day streak. Checked in today.`
    : now > 0
      ? `🔥 ${now}-day streak. Check in today for day ${streak}.`
      : "Check in today to start a streak.";
  const reward = alreadyCheckedIn
    ? daysToReward === 7 ? "Free upvote earned today." : `Free upvote in ${daysToReward} more day${daysToReward === 1 ? "" : "s"}.`
    : daysToReward === 1 ? "Today's check-in earns a free upvote." : `Free upvote in ${daysToReward} check-ins, today included.`;
  return (
    <div className="mt-1.5 max-w-2xl" data-streak-progress={filled}>
      <p className="m-0 text-sm font-semibold text-mw-text">{headline}</p>
      <div className="mt-1.5 flex items-center gap-1" aria-label={`${filled} of 7 days toward a free upvote`}>
        {Array.from({ length: 7 }).map((_, i) => (
          <span
            key={i}
            className={`h-2 w-6 rounded-full ${i < filled ? "bg-mw-accent" : !alreadyCheckedIn && i === filled ? "border border-mw-accent bg-transparent" : "bg-[#262C33]"}`}
          />
        ))}
        <span className="ml-1.5 font-mw-mono text-xs text-mw-muted">{filled}/7</span>
      </div>
      <p className="m-0 mt-1 text-xs text-mw-muted">
        {reward}
        {rewardsReady ? ` Free upvotes ready: ${rewardsReady}, use them in a coin's Upvote button.` : ""} One check-in per UTC day.
      </p>
    </div>
  );
}

/** Extra toast line after a check-in that completed 7 days in a row. */
export function streakRewardToastLine(earned: unknown) {
  return earned ? "You earned a free upvote." : "";
}
