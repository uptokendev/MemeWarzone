export const BATTLE_DURATIONS = [
  { hours: 24, label: "24 hours" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
] as const;

/** Vote Battles: free votes + boosts, short clocks (1 hour up to 24 hours). */
export const VOTE_BATTLE_DURATIONS = [
  { hours: 1, label: "1 hour" },
  { hours: 6, label: "6 hours" },
  { hours: 12, label: "12 hours" },
  { hours: 24, label: "24 hours" },
] as const;

export type BattleMode = "normal" | "vote";
export type VoteBattleDurationHours = (typeof VOTE_BATTLE_DURATIONS)[number]["hours"];

export function parseBattleDurationHours(value: unknown, fallback = 24): 24 | 72 | 168 {
  const n = Number(value);
  if (n === 24 || n === 72 || n === 168) return n;
  if (n === 1) return 24;
  if (n === 3) return 72;
  if (n === 7) return 168;
  return fallback === 72 || fallback === 168 ? fallback : 24;
}

export function parseVoteBattleDurationHours(value: unknown, fallback: VoteBattleDurationHours = 24): VoteBattleDurationHours {
  const n = Number(value);
  if (n === 1 || n === 6 || n === 12 || n === 24) return n;
  return fallback;
}

export function parseBattleMode(value: unknown): BattleMode {
  return String(value ?? "").trim().toLowerCase() === "vote" ? "vote" : "normal";
}

export function battleDurationOptions(mode: BattleMode): ReadonlyArray<{ hours: number; label: string }> {
  return mode === "vote" ? VOTE_BATTLE_DURATIONS : BATTLE_DURATIONS;
}

/** The duration a battle of this mode accepts: vote 1/6/12/24 h, metrics 24 h / 3 d / 7 d. */
export function parseBattleDurationHoursForMode(mode: BattleMode | string | undefined | null, value: unknown, fallback = 24): number {
  return parseBattleMode(mode) === "vote"
    ? parseVoteBattleDurationHours(value, parseVoteBattleDurationHours(fallback, 24))
    : parseBattleDurationHours(value, fallback);
}

export function battleDurationLabel(hours: unknown): string {
  const n = Number(hours);
  const match = BATTLE_DURATIONS.find((item) => item.hours === n) || VOTE_BATTLE_DURATIONS.find((item) => item.hours === n);
  return match?.label || "24 hours";
}
