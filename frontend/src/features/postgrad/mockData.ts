import type {
  Battle,
  EventCardContract,
  GraduatedToken,
  RankingPayload,
  TradeRoomFilter,
  WarPool,
} from "@/features/postgrad/contracts";

const now = new Date("2026-05-21T00:00:00.000Z");

function atMinutes(offsetMinutes: number) {
  return new Date(now.getTime() + offsetMinutes * 60_000).toISOString();
}

export const featuredTokens: GraduatedToken[] = [
  {
    id: "storm-doge",
    campaignAddress: "0xA1b2c3d4e5f60718293aBcD4Ef5061728394Aa11",
    name: "Storm Doge",
    symbol: "SDOGE",
    logoUri: "/assets/tokens/sdo.jpg",
    graduatedAt: atMinutes(-640),
    marketCapUsd: 1920000,
    liquidityUsd: 415000,
    holders: 6120,
    battleEligible: true,
    tacticalTags: ["Featured", "High Velocity"],
  },
  {
    id: "moon-ops",
    campaignAddress: "0xB2c3d4e5f60718293aBcD4Ef5061728394Aa1122",
    name: "Moon Ops",
    symbol: "MOPS",
    logoUri: "/assets/tokens/mop.jpg",
    graduatedAt: atMinutes(-980),
    marketCapUsd: 1345000,
    liquidityUsd: 286000,
    holders: 4480,
    battleEligible: true,
    tacticalTags: ["Sponsored", "Rivalry Ready"],
  },
  {
    id: "glitch-ape",
    campaignAddress: "0xC3d4e5f60718293aBcD4Ef5061728394Aa112233",
    name: "Glitch Ape",
    symbol: "GAPE",
    logoUri: "/assets/tokens/gap.jpg",
    graduatedAt: atMinutes(-1280),
    marketCapUsd: 980000,
    liquidityUsd: 223000,
    holders: 3714,
    battleEligible: true,
    tacticalTags: ["League Climber"],
  },
];

export const liveBattles: Battle[] = [
  {
    id: "battle-redline-vs-sdoge",
    state: "live",
    format: "duel",
    startedAt: atMinutes(-14),
    endsAt: atMinutes(31),
    settlementAt: atMinutes(35),
    featured: true,
    arenaLane: "live_battles",
    participants: [
      {
        tokenId: "redline-rats",
        tokenName: "Redline Rats",
        symbol: "RATS",
        imageUrl: "/assets/tokens/rat.jpg",
        logoUri: "/assets/tokens/rat.jpg",
        score: 71.3,
        priceChangePct: 8.2,
        volumeUsd: 193000,
        uniqueTraders: 412,
        holdersDelta: 58,
      },
      {
        tokenId: "storm-doge",
        tokenName: "Storm Doge",
        symbol: "SDOGE",
        imageUrl: "/assets/tokens/sdo.jpg",
        logoUri: "/assets/tokens/sdo.jpg",
        score: 68.8,
        priceChangePct: 6.5,
        volumeUsd: 177000,
        uniqueTraders: 389,
        holdersDelta: 41,
      },
    ],
  },
  {
    id: "battle-mops-vs-gape",
    state: "live",
    format: "duel",
    startedAt: atMinutes(-7),
    endsAt: atMinutes(38),
    settlementAt: atMinutes(42),
    featured: false,
    arenaLane: "live_battles",
    participants: [
      {
        tokenId: "moon-ops",
        tokenName: "Moon Ops",
        symbol: "MOPS",
        imageUrl: "/assets/tokens/mop.jpg",
        logoUri: "/assets/tokens/mop.jpg",
        score: 55.1,
        priceChangePct: 5.4,
        volumeUsd: 141000,
        uniqueTraders: 256,
        holdersDelta: 26,
      },
      {
        tokenId: "glitch-ape",
        tokenName: "Glitch Ape",
        symbol: "GAPE",
        imageUrl: "/assets/tokens/gap.jpg",
        logoUri: "/assets/tokens/gap.jpg",
        score: 57.7,
        priceChangePct: 7.1,
        volumeUsd: 149500,
        uniqueTraders: 279,
        holdersDelta: 33,
      },
    ],
  },
];

export const openForBattleQueue: Battle[] = [
  {
    id: "queue-astrofrogs",
    state: "open_for_battle",
    format: "duel",
    endsAt: atMinutes(60),
    featured: false,
    arenaLane: "open_for_battle",
    participants: [
      {
        tokenId: "astro-frogs",
        tokenName: "Astro Frogs",
        symbol: "AFRG",
        score: 0,
        priceChangePct: 2.9,
        volumeUsd: 88000,
        uniqueTraders: 122,
        holdersDelta: 14,
      },
      {
        tokenId: "pending-rival",
        tokenName: "Awaiting Rival",
        symbol: "TBD",
        score: 0,
        priceChangePct: 0,
        volumeUsd: 0,
        uniqueTraders: 0,
        holdersDelta: 0,
      },
    ],
  },
  {
    id: "queue-neonshib",
    state: "open_for_battle",
    format: "duel",
    endsAt: atMinutes(90),
    featured: false,
    arenaLane: "open_for_battle",
    participants: [
      {
        tokenId: "neon-shib",
        tokenName: "Neon Shib",
        symbol: "NSHB",
        score: 0,
        priceChangePct: 1.8,
        volumeUsd: 60300,
        uniqueTraders: 91,
        holdersDelta: 9,
      },
      {
        tokenId: "pending-rival-two",
        tokenName: "Awaiting Rival",
        symbol: "TBD",
        score: 0,
        priceChangePct: 0,
        volumeUsd: 0,
        uniqueTraders: 0,
        holdersDelta: 0,
      },
    ],
  },
];

export const scheduledEvents: EventCardContract[] = [
  {
    id: "event-battle-night-01",
    type: "battle_night",
    title: "Battle Night: Founder Grudge Match",
    status: "scheduled",
    startsAt: atMinutes(180),
    endsAt: atMinutes(320),
    participantCount: 12,
    summary: "Twelve graduated tokens enter a timed rotation bracket with boosted arena placement.",
  },
  {
    id: "event-weekend-02",
    type: "battle_weekend",
    title: "Weekend Siege",
    status: "live",
    startsAt: atMinutes(-60),
    endsAt: atMinutes(720),
    participantCount: 24,
    summary: "Open deployment weekend with pooled scoring, featured rivalries, and live lane coverage.",
  },
  {
    id: "event-tournament-03",
    type: "tournament",
    title: "Rookie Crown Qualifier",
    status: "scheduled",
    startsAt: atMinutes(1440),
    endsAt: atMinutes(1800),
    participantCount: 16,
    summary: "Single-elimination tournament seeded from battle activity and holder growth.",
  },
];

export const arenaRankings: RankingPayload[] = [
  {
    key: "trending",
    generatedAt: now.toISOString(),
    entries: [
      { rank: 1, tokenId: "storm-doge", label: "Storm Doge", metricLabel: "Heat", metricValue: "98.4", deltaLabel: "+12.3%" },
      { rank: 2, tokenId: "moon-ops", label: "Moon Ops", metricLabel: "Heat", metricValue: "94.1", deltaLabel: "+9.4%" },
      { rank: 3, tokenId: "glitch-ape", label: "Glitch Ape", metricLabel: "Heat", metricValue: "89.7", deltaLabel: "+7.1%" },
    ],
  },
  {
    key: "volume",
    generatedAt: now.toISOString(),
    entries: [
      { rank: 1, tokenId: "redline-rats", label: "Redline Rats", metricLabel: "24h Volume", metricValue: "$193K", deltaLabel: "+41 traders" },
      { rank: 2, tokenId: "storm-doge", label: "Storm Doge", metricLabel: "24h Volume", metricValue: "$177K", deltaLabel: "+27 traders" },
      { rank: 3, tokenId: "glitch-ape", label: "Glitch Ape", metricLabel: "24h Volume", metricValue: "$149K", deltaLabel: "+18 traders" },
    ],
  },
  {
    key: "battle_activity",
    generatedAt: now.toISOString(),
    entries: [
      { rank: 1, tokenId: "moon-ops", label: "Moon Ops", metricLabel: "Battles", metricValue: "8 queued", deltaLabel: "2 wins" },
      { rank: 2, tokenId: "astro-frogs", label: "Astro Frogs", metricLabel: "Battles", metricValue: "5 queued", deltaLabel: "1 live" },
      { rank: 3, tokenId: "storm-doge", label: "Storm Doge", metricLabel: "Battles", metricValue: "4 active", deltaLabel: "featured" },
    ],
  },
];

export const battleWarPool: WarPool = {
  battleId: "battle-redline-vs-sdoge",
  state: "open",
  totalPotUsd: 48200,
  cutoffAt: atMinutes(18),
  routingBreakdown: {
    winnersUsd: 41000,
    protocolUsd: 5200,
    featuredUsd: 2000,
  },
  entries: [
    {
      battleId: "battle-redline-vs-sdoge",
      sideTokenId: "redline-rats",
      amountUsd: 1800,
      enteredAt: atMinutes(-10),
      payoutEligible: true,
    },
    {
      battleId: "battle-redline-vs-sdoge",
      sideTokenId: "storm-doge",
      amountUsd: 1200,
      enteredAt: atMinutes(-8),
      payoutEligible: true,
    },
  ],
};

export const defaultTradeRoomFilters: TradeRoomFilter = {
  search: "",
  watchlistOnly: false,
  minimumLiquidityUsd: 100000,
  sort: "heat",
  postGradOnly: true,
};
