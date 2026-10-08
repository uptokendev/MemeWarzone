/**
 * The creator streak's reward line (founder, 2026-10-08): every 7 days in a row earns a free upvote.
 * Lives outside the league briefing card on purpose: league scoring never reads upvotes.
 */
export function CreatorStreakRewardLine({
  streak,
  alreadyCheckedIn,
  daysToReward,
  rewardsReady,
}: {
  streak: number;
  alreadyCheckedIn: boolean;
  daysToReward: number;
  rewardsReady: number;
}) {
  const togo = alreadyCheckedIn ? `${daysToReward} to go` : daysToReward === 1 ? "today" : `${daysToReward} to go, today included`;
  return (
    <p className="mt-1 max-w-2xl text-xs text-mw-muted">
      Streak {streak} day{streak === 1 ? "" : "s"}. Every 7 days in a row earns a free upvote ({togo})
      {rewardsReady ? `. Free upvotes ready: ${rewardsReady}` : ""}. One check-in per UTC day.
    </p>
  );
}

/** Extra toast line after a check-in that completed 7 days in a row. */
export function streakRewardToastLine(earned: unknown) {
  return earned ? "You earned a free upvote." : "";
}
