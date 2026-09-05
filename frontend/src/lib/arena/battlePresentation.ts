import type { Battle, BattleParticipant } from "@/features/postgrad/contracts";

function safeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatCompactUsd(value?: number | null): string {
  const amount = Math.max(0, safeNumber(value));
  if (amount >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(2)}B`;
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;
  return `$${amount.toFixed(0)}`;
}

export function formatSignedPct(value?: number | null, digits = 1): string {
  const amount = safeNumber(value);
  const prefix = amount > 0 ? "+" : "";
  return `${prefix}${amount.toFixed(digits)}%`;
}

export function formatSignedCount(value?: number | null): string {
  const amount = Math.trunc(safeNumber(value));
  const prefix = amount > 0 ? "+" : "";
  return `${prefix}${amount}`;
}

export function battleScoreLabel(battle: Battle): string {
  const basis = String((battle as { scoreBasis?: string }).scoreBasis || "").toLowerCase();
  const settlementVersion = String((battle as { settlementVersion?: string }).settlementVersion || "").toLowerCase();
  if (basis.includes("battle_points") || settlementVersion.includes("battle_points")) return "Battle points";
  return "Score";
}

export function battleLeaderIndex(battle: Battle): 0 | 1 | null {
  if (battle.leaderSide === "left") return 0;
  if (battle.leaderSide === "right") return 1;
  const index = battle.participants.findIndex((participant) => participant.isLeading === true);
  return index === 0 || index === 1 ? index : null;
}

export function battlePointGap(battle: Battle): number {
  const left = safeNumber(battle.participants[0]?.score);
  const right = safeNumber(battle.participants[1]?.score);
  return Math.abs(left - right);
}

function relativeDuration(target: string): string | null {
  const millis = Date.parse(target) - Date.now();
  if (!Number.isFinite(millis)) return null;
  if (millis <= 0) return "Closing now";
  const totalMinutes = Math.max(1, Math.floor(millis / 60_000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${minutes}m left`;
}

function absoluteDate(value?: string | null): string {
  if (!value) return "Unscheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unscheduled";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function battleClockLabel(battle: Battle): string {
  if (battle.state === "finished") {
    return battle.settlementAt ? `Settled ${absoluteDate(battle.settlementAt)}` : "Finished";
  }
  if (battle.state === "live") {
    return relativeDuration(battle.endsAt) || (battle.endsAt ? `Ends ${absoluteDate(battle.endsAt)}` : "Live now");
  }
  if (battle.state === "matched") return "Stakes due";
  if (battle.state === "challenged") return "Challenge awaiting response";
  return battle.startedAt ? `Opened ${absoluteDate(battle.startedAt)}` : "Awaiting rival";
}

export function battleDurationLabel(hours?: number | null): string {
  const total = Math.max(0, Math.trunc(safeNumber(hours)));
  if (total === 168) return "7 days";
  if (total === 72) return "3 days";
  if (total === 24) return "24 hours";
  if (!total) return "Undecided";
  if (total % 24 === 0) return `${total / 24} days`;
  return `${total} hours`;
}

export function battleChainLabel(chainId?: number | null): string {
  if (chainId === 101 || chainId === 102) return "Solana";
  if (chainId === 4663 || chainId === 46630) return "Robinhood";
  return "BNB Chain";
}

export function battleScoreShare(participant: BattleParticipant | undefined, battle: Battle): number {
  const total = battle.participants.slice(0, 2).reduce((sum, item) => sum + Math.max(0, safeNumber(item?.score)), 0);
  if (total <= 0) return 50;
  return Math.max(0, Math.min(100, Math.round((Math.max(0, safeNumber(participant?.score)) / total) * 100)));
}
