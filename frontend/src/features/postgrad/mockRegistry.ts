import type { Battle, EventCardContract, LeagueSeason, MockTokenProfile, RankingPayload, TradeRoomFilter, WarPool } from "@/features/postgrad/contracts";

const now = new Date("2026-05-21T00:00:00.000Z");

function atMinutes(offsetMinutes: number) {
  return new Date(now.getTime() + offsetMinutes * 60_000).toISOString();
}

export const mockTokenProfiles: MockTokenProfile[] = [
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
    thesis: "Momentum-led attack token that thrives on rapid challenge cycles and strong featured placement visibility.",
    commanderNotes: [
      "Best suited for live battle lane tests.",
      "Good sample for watchlist-heavy War Room behavior.",
      "Use this token when testing featured placement logic.",
    ],
    socials: {
      website: "https://mock.memewar.zone/storm-doge",
      x: "https://x.com/stormdoge",
      telegram: "https://t.me/stormdoge",
    },
    watchlistCount: 1821,
    sentiment: "heating_up",
    battleStyle: "momentum",
    mockTrades: [
      { timeLabel: "2m ago", side: "buy", sizeLabel: "$8.2K", traderLabel: "AlphaSquad" },
      { timeLabel: "5m ago", side: "buy", sizeLabel: "$5.4K", traderLabel: "Whale-12" },
      { timeLabel: "9m ago", side: "sell", sizeLabel: "$2.1K", traderLabel: "ScoutNode" },
    ],
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
    thesis: "Sponsored contender designed to test rivalry placements, tactical boosts, and event deployment cards.",
    commanderNotes: [
      "Use in sponsorship and featured rotation tests.",
      "Paired against Glitch Ape in the default live duel.",
    ],
    socials: {
      website: "https://mock.memewar.zone/moon-ops",
      x: "https://x.com/moonops",
      telegram: "https://t.me/moonops",
    },
    watchlistCount: 1193,
    sentiment: "stable",
    battleStyle: "whale_surge",
    mockTrades: [
      { timeLabel: "1m ago", side: "buy", sizeLabel: "$12.7K", traderLabel: "WhaleArc" },
      { timeLabel: "7m ago", side: "sell", sizeLabel: "$3.2K", traderLabel: "NightShift" },
      { timeLabel: "11m ago", side: "buy", sizeLabel: "$4.8K", traderLabel: "OpsDesk" },
    ],
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
    thesis: "Community-led climber token intended to stress-test league movement, score history, and slower-burn accumulation states.",
    commanderNotes: [
      "Useful for seasonal league positioning and archive UI.",
      "Lower liquidity than the featured pair for edge-case comparisons.",
    ],
    socials: {
      website: "https://mock.memewar.zone/glitch-ape",
      x: "https://x.com/glitchape",
      telegram: "https://t.me/glitchape",
    },
    watchlistCount: 802,
    sentiment: "stable",
    battleStyle: "holder_grind",
    mockTrades: [
      { timeLabel: "4m ago", side: "buy", sizeLabel: "$3.1K", traderLabel: "HoldLine" },
      { timeLabel: "13m ago", side: "buy", sizeLabel: "$2.6K", traderLabel: "RankRush" },
      { timeLabel: "18m ago", side: "sell", sizeLabel: "$1.3K", traderLabel: "BridgeTwo" },
    ],
  },
  {
    id: "redline-rats",
    campaignAddress: "0xD4e5f60718293aBcD4Ef5061728394Aa11223344",
    name: "Redline Rats",
    symbol: "RATS",
    logoUri: "/assets/tokens/rat.jpg",
    graduatedAt: atMinutes(-520),
    marketCapUsd: 2110000,
    liquidityUsd: 462000,
    holders: 6884,
    battleEligible: true,
    tacticalTags: ["Battle Favorite", "Featured"],
    thesis: "Fast-moving battle favorite for live score swings, heavy trader count spikes, and war-pool testing.",
    commanderNotes: [
      "Primary left-side live battle sample.",
      "Ideal for testing battle settlement and pool-routing layouts.",
    ],
    socials: {
      website: "https://mock.memewar.zone/redline-rats",
      x: "https://x.com/redlinerats",
      telegram: "https://t.me/redlinerats",
    },
    watchlistCount: 2110,
    sentiment: "heating_up",
    battleStyle: "community_swarm",
    mockTrades: [
      { timeLabel: "30s ago", side: "buy", sizeLabel: "$14.3K", traderLabel: "RallyRoom" },
      { timeLabel: "3m ago", side: "buy", sizeLabel: "$6.8K", traderLabel: "MouseKing" },
      { timeLabel: "8m ago", side: "sell", sizeLabel: "$2.4K", traderLabel: "VaultNine" },
    ],
  },
  {
    id: "astro-frogs",
    campaignAddress: "0xE5f60718293aBcD4Ef5061728394Aa1122334455",
    name: "Astro Frogs",
    symbol: "AFRG",
    logoUri: "/assets/logo.png",
    graduatedAt: atMinutes(-430),
    marketCapUsd: 760000,
    liquidityUsd: 149000,
    holders: 2234,
    battleEligible: true,
    tacticalTags: ["Queue Ready"],
    thesis: "Queue-focused challenger used to test open-for-battle states, challenge CTA flow, and matchup creation.",
    commanderNotes: [
      "Represents a token waiting for a direct challenge or matchmaker fill.",
      "Good for testing pending and accepted battle transitions later.",
    ],
    socials: {
      website: "https://mock.memewar.zone/astro-frogs",
      x: "https://x.com/astrofrogs",
      telegram: "https://t.me/astrofrogs",
    },
    watchlistCount: 514,
    sentiment: "volatile",
    battleStyle: "momentum",
    mockTrades: [
      { timeLabel: "6m ago", side: "buy", sizeLabel: "$2.2K", traderLabel: "FrogLink" },
      { timeLabel: "14m ago", side: "buy", sizeLabel: "$1.8K", traderLabel: "LaunchScout" },
      { timeLabel: "19m ago", side: "sell", sizeLabel: "$0.9K", traderLabel: "PondDesk" },
    ],
  },
  {
    id: "neon-shib",
    campaignAddress: "0xF60718293aBcD4Ef5061728394Aa112233445566",
    name: "Neon Shib",
    symbol: "NSHB",
    logoUri: "/assets/logo.png",
    graduatedAt: atMinutes(-300),
    marketCapUsd: 640000,
    liquidityUsd: 128000,
    holders: 1812,
    battleEligible: true,
    tacticalTags: ["Queue Ready", "Draft Rivalry"],
    thesis: "Secondary queue test token that helps exercise alternate challenge flows, token intel, and smaller-cap comparisons.",
    commanderNotes: [
      "Use alongside Astro Frogs for queue-side testing.",
      "Good sample for lower-holder watchlist rendering.",
    ],
    socials: {
      website: "https://mock.memewar.zone/neon-shib",
      x: "https://x.com/neonshib",
      telegram: "https://t.me/neonshib",
    },
    watchlistCount: 433,
    sentiment: "volatile",
    battleStyle: "holder_grind",
    mockTrades: [
      { timeLabel: "4m ago", side: "sell", sizeLabel: "$1.1K", traderLabel: "GlowDesk" },
      { timeLabel: "10m ago", side: "buy", sizeLabel: "$2.0K", traderLabel: "NeonLoop" },
      { timeLabel: "17m ago", side: "buy", sizeLabel: "$1.4K", traderLabel: "ShardFive" },
    ],
  },
  {
    id: "circuit-wolf",
    campaignAddress: "0x170718293aBcD4Ef5061728394Aa112233445577",
    name: "Circuit Wolf",
    symbol: "CWLF",
    logoUri: "/assets/logo.png",
    graduatedAt: atMinutes(-250),
    marketCapUsd: 540000,
    liquidityUsd: 98000,
    holders: 1604,
    battleEligible: true,
    tacticalTags: ["Arena Ready"],
    thesis: "Fresh post-grad token reserved for creator-side queue testing, especially first-time Open for Battle actions.",
    commanderNotes: [
      "Use this coin to test the direct creator launch flow from /arena/battles.",
      "Intentionally starts outside the live lane and queue so the page has a clean ready state.",
    ],
    socials: {
      website: "https://mock.memewar.zone/circuit-wolf",
      x: "https://x.com/circuitwolf",
      telegram: "https://t.me/circuitwolf",
    },
    watchlistCount: 287,
    sentiment: "stable",
    battleStyle: "momentum",
    mockTrades: [
      { timeLabel: "8m ago", side: "buy", sizeLabel: "$1.9K", traderLabel: "CurrentDesk" },
      { timeLabel: "15m ago", side: "buy", sizeLabel: "$1.2K", traderLabel: "QueuePilot" },
      { timeLabel: "22m ago", side: "sell", sizeLabel: "$0.7K", traderLabel: "StaticNode" },
    ],
  },
  {
    id: "sleep-driver",
    campaignAddress: "0x2808293aBcD4Ef5061728394Aa11223344557788",
    name: "Sleep Driver",
    symbol: "SLDR",
    logoUri: "/assets/logo.png",
    graduatedAt: atMinutes(-210),
    marketCapUsd: 410000,
    liquidityUsd: 72000,
    holders: 1291,
    battleEligible: false,
    tacticalTags: ["Cooldown"],
    thesis: "Lower-liquidity token intentionally held out of battle eligibility so the creator controls page can show a clear blocked state.",
    commanderNotes: [
      "Use this coin to test unavailable reasons and disabled battle actions.",
      "Keeps the revised battles page from showing only positive/ready states.",
    ],
    socials: {
      website: "https://mock.memewar.zone/sleep-driver",
      x: "https://x.com/sleepdriver",
      telegram: "https://t.me/sleepdriver",
    },
    watchlistCount: 196,
    sentiment: "stable",
    battleStyle: "holder_grind",
    mockTrades: [
      { timeLabel: "12m ago", side: "buy", sizeLabel: "$0.8K", traderLabel: "CooldownOps" },
      { timeLabel: "18m ago", side: "sell", sizeLabel: "$0.5K", traderLabel: "DriftLine" },
      { timeLabel: "27m ago", side: "buy", sizeLabel: "$0.6K", traderLabel: "NightRelay" },
    ],
  },
];

export const featuredTokens = mockTokenProfiles.slice(0, 3);

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

export const mockLeagueSeason: LeagueSeason = {
  id: "season-01",
  label: "Season One",
  state: "live",
  week: 4,
  rewardPoolUsd: 150000,
  resetAt: atMinutes(60 * 24 * 6),
  divisions: ["bronze", "silver", "gold", "apex"],
  entries: [
    { tokenId: "redline-rats", tokenName: "Redline Rats", symbol: "RATS", division: "apex", points: 144, wins: 12, losses: 2, streak: 4, movement: "promoted" },
    { tokenId: "storm-doge", tokenName: "Storm Doge", symbol: "SDOGE", division: "gold", points: 131, wins: 11, losses: 3, streak: 3, movement: "promoted" },
    { tokenId: "moon-ops", tokenName: "Moon Ops", symbol: "MOPS", division: "gold", points: 118, wins: 9, losses: 4, streak: 1, movement: "safe" },
    { tokenId: "glitch-ape", tokenName: "Glitch Ape", symbol: "GAPE", division: "silver", points: 94, wins: 7, losses: 6, streak: -1, movement: "safe" },
    { tokenId: "astro-frogs", tokenName: "Astro Frogs", symbol: "AFRG", division: "silver", points: 81, wins: 6, losses: 7, streak: 2, movement: "safe" },
    { tokenId: "neon-shib", tokenName: "Neon Shib", symbol: "NSHB", division: "bronze", points: 63, wins: 4, losses: 8, streak: -2, movement: "relegated" },
  ],
};

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

export function getMockTokenById(tokenId?: string | null) {
  return mockTokenProfiles.find((token) => token.id === tokenId) ?? null;
}

export function getMockTokenRouteById(tokenId?: string | null) {
  const token = getMockTokenById(tokenId);
  if (!token) return null;
  const preferred = String(token.tokenAddress || token.campaignAddress || "").toLowerCase();
  return preferred ? `/token/${preferred}` : null;
}

export function getMockBattleById(battleId?: string | null) {
  return [...liveBattles, ...openForBattleQueue].find((battle) => battle.id === battleId) ?? null;
}

export function getMockBattleForToken(tokenId?: string | null) {
  if (!tokenId) return null;
  return [...liveBattles, ...openForBattleQueue].find((battle) =>
    battle.participants.some((participant) => participant.tokenId === tokenId),
  ) ?? null;
}
