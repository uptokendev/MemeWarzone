import { z } from "zod";

export const graduatedTokenSchema = z.object({
  id: z.string(),
  campaignAddress: z.string(),
  name: z.string(),
  symbol: z.string(),
  logoUri: z.string().url().or(z.string().startsWith("/")).optional(),
  graduatedAt: z.string(),
  marketCapUsd: z.number().nonnegative(),
  liquidityUsd: z.number().nonnegative(),
  holders: z.number().int().nonnegative(),
  battleEligible: z.boolean(),
  tacticalTags: z.array(z.string()).default([]),
});

export const mockTokenProfileSchema = graduatedTokenSchema.extend({
  thesis: z.string(),
  commanderNotes: z.array(z.string()).default([]),
  socials: z.object({
    website: z.string(),
    x: z.string(),
    telegram: z.string(),
  }),
  watchlistCount: z.number().int().nonnegative(),
  sentiment: z.enum(["heating_up", "stable", "volatile"]),
  battleStyle: z.enum(["momentum", "holder_grind", "whale_surge", "community_swarm"]),
  mockTrades: z.array(
    z.object({
      timeLabel: z.string(),
      side: z.enum(["buy", "sell"]),
      sizeLabel: z.string(),
      traderLabel: z.string(),
    }),
  ).default([]),
});

export const battleStateSchema = z.enum([
  "waiting",
  "challenged",
  "live",
  "finished",
  "expired",
  // Legacy states still appear in older mock payloads.
  "draft",
  "open_for_battle",
  "pending",
  "accepted",
  "completed",
  "settled",
  "cancelled",
]);

export const POST_GRAD_BATTLE_TRANSITIONS = {
  waiting: ["live", "expired"],
  challenged: ["live", "expired"],
  live: ["finished"],
  finished: [],
  expired: [],
  draft: ["waiting"],
  open_for_battle: ["waiting", "live", "expired"],
  pending: ["live", "expired"],
  accepted: ["live", "expired"],
  completed: ["finished"],
  settled: [],
  cancelled: ["expired"],
} as const satisfies Record<z.infer<typeof battleStateSchema>, readonly z.infer<typeof battleStateSchema>[]>;

export const battleParticipantSchema = z.object({
  tokenId: z.string(),
  campaignAddress: z.string().optional(),
  tokenAddress: z.string().nullable().optional(),
  tokenName: z.string(),
  symbol: z.string(),
  imageUrl: z.string().nullable().optional(),
  logoUri: z.string().nullable().optional(),
  score: z.number().nonnegative(),
  priceChangePct: z.number(),
  volumeUsd: z.number().nonnegative(),
  volume24h: z.number().nonnegative().optional(),
  volume24hUsd: z.number().nonnegative().optional(),
  uniqueTraders: z.number().int().nonnegative(),
  traderCount: z.number().int().nonnegative().optional(),
  holderCount: z.number().int().nonnegative().optional(),
  holders: z.number().int().nonnegative().optional(),
  holdersDelta: z.number().int(),
  marketCap: z.number().nonnegative().optional(),
  marketCapUsd: z.number().nonnegative().optional(),
  isLeading: z.boolean().optional(),
});

export const battleSchema = z.object({
  id: z.string(),
  state: battleStateSchema,
  format: z.enum(["duel", "rumble", "event_match"]),
  startedAt: z.string().optional(),
  endsAt: z.string().optional(),
  settlementAt: z.string().optional(),
  featured: z.boolean().default(false),
  arenaLane: z.enum(["live_battles", "open_for_battle", "events_and_leagues"]),
  scoreBasis: z.string().optional(),
  leaderSide: z.enum(["left", "right", "tied"]).nullable().optional(),
  updatedAt: z.string().optional(),
  participants: z.array(battleParticipantSchema).min(2),
});

export const warPoolEntrySchema = z.object({
  battleId: z.string(),
  sideTokenId: z.string(),
  amountUsd: z.number().positive(),
  enteredAt: z.string(),
  payoutEligible: z.boolean(),
});

export const warPoolSchema = z.object({
  battleId: z.string(),
  state: z.enum(["open", "locked", "settling", "paid"]),
  totalPotUsd: z.number().nonnegative(),
  cutoffAt: z.string(),
  routingBreakdown: z.object({
    winnersUsd: z.number().nonnegative(),
    protocolUsd: z.number().nonnegative(),
    featuredUsd: z.number().nonnegative(),
  }),
  entries: z.array(warPoolEntrySchema).default([]),
});

export const eventTypeSchema = z.enum([
  "battle_weekend",
  "battle_night",
  "featured_rivalry",
  "tournament",
  "seasonal_league",
]);

export const eventStatusSchema = z.enum(["scheduled", "deploying", "live", "completed"]);
export const tournamentBracketStageSchema = z.enum(["registration", "quarterfinals", "semifinals", "finals", "completed"]);

export const POST_GRAD_EVENT_TRANSITIONS = {
  scheduled: ["deploying", "live"],
  deploying: ["live"],
  live: ["completed"],
  completed: [],
} as const satisfies Record<z.infer<typeof eventStatusSchema>, readonly z.infer<typeof eventStatusSchema>[]>;

export const TOURNAMENT_BRACKET_STAGES = [
  "registration",
  "quarterfinals",
  "semifinals",
  "finals",
  "completed",
] as const satisfies readonly z.infer<typeof tournamentBracketStageSchema>[];

export const leagueDivisionSchema = z.enum(["bronze", "silver", "gold", "apex"]);
export const leagueMovementSchema = z.enum(["promoted", "safe", "relegated"]);
export const leagueSeasonStateSchema = z.enum(["preseason", "live", "playoffs", "completed"]);
export const quickTradeSideSchema = z.enum(["buy", "sell"]);
export const quickTradeStatusSchema = z.enum(["queued", "filled", "rejected"]);
export const weeklyRewardStatusSchema = z.enum(["locked", "claimable", "claimed"]);
export const weeklyRewardTierSchema = z.enum(["watchlist_boost", "fee_rebate", "featured_slot_draw", "war_pool_credit"]);

export const eventSchema = z.object({
  id: z.string(),
  type: eventTypeSchema,
  title: z.string(),
  status: eventStatusSchema,
  startsAt: z.string(),
  endsAt: z.string(),
  participantCount: z.number().int().nonnegative(),
  summary: z.string(),
});

export type GraduatedToken = z.infer<typeof graduatedTokenSchema>;
export type MockTokenProfile = z.infer<typeof mockTokenProfileSchema>;
export type Battle = z.infer<typeof battleSchema>;
export type BattleParticipant = z.infer<typeof battleParticipantSchema>;
export type WarPool = z.infer<typeof warPoolSchema>;
export type EventCardContract = z.infer<typeof eventSchema>;
export type BattleState = z.infer<typeof battleStateSchema>;
export type EventStatus = z.infer<typeof eventStatusSchema>;
export type TournamentBracketStage = z.infer<typeof tournamentBracketStageSchema>;
export type LeagueDivision = z.infer<typeof leagueDivisionSchema>;
export type LeagueMovement = z.infer<typeof leagueMovementSchema>;
export type LeagueSeasonState = z.infer<typeof leagueSeasonStateSchema>;
export type QuickTradeSide = z.infer<typeof quickTradeSideSchema>;
export type QuickTradeStatus = z.infer<typeof quickTradeStatusSchema>;
export type WeeklyRewardStatus = z.infer<typeof weeklyRewardStatusSchema>;
export type WeeklyRewardTier = z.infer<typeof weeklyRewardTierSchema>;
