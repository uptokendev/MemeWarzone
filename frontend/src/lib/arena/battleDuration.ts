export const BATTLE_DURATIONS = [
  { hours: 24, label: "24 hours" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
] as const;

export function parseBattleDurationHours(value: unknown, fallback = 24): 24 | 72 | 168 {
  const n = Number(value);
  if (n === 24 || n === 72 || n === 168) return n;
  if (n === 1) return 24;
  if (n === 3) return 72;
  if (n === 7) return 168;
  return fallback === 72 || fallback === 168 ? fallback : 24;
}

export function battleDurationLabel(hours: unknown): string {
  const match = BATTLE_DURATIONS.find((item) => item.hours === Number(hours));
  return match?.label || "24 hours";
}
