const ART = {
  RATS: "/assets/tokens/rat.jpg",
  SDOGE: "/assets/tokens/sdo.jpg",
  MOPS: "/assets/tokens/mop.jpg",
  GAPE: "/assets/tokens/gap.jpg",
};

export const MOCK_TOURNAMENT_ROSTER = [
  { tokenAddress: "0xD4e5f60718293aBcD4Ef5061728394Aa11223344", tokenName: "Redline Rats", symbol: "RATS", imageUrl: ART.RATS, logoUri: ART.RATS },
  { tokenAddress: "0xA1b2c3d4e5f60718293aBcD4Ef5061728394Aa11", tokenName: "Storm Doge", symbol: "SDOGE", imageUrl: ART.SDOGE, logoUri: ART.SDOGE },
  { tokenAddress: "0xB2c3d4e5f60718293aBcD4Ef5061728394Aa1122", tokenName: "Moon Ops", symbol: "MOPS", imageUrl: ART.MOPS, logoUri: ART.MOPS },
  { tokenAddress: "0xC3d4e5f60718293aBcD4Ef5061728394Aa112233", tokenName: "Glitch Ape", symbol: "GAPE", imageUrl: ART.GAPE, logoUri: ART.GAPE },
  { tokenAddress: "0xE5f60718293aBcD4Ef5061728394Aa1122334455", tokenName: "Astro Frogs", symbol: "AFRG" },
  { tokenAddress: "0xF60718293aBcD4Ef5061728394Aa112233445566", tokenName: "Neon Shib", symbol: "NSHB" },
  { tokenAddress: "0xa18293aBcD4Ef5061728394Aa11223344556677", tokenName: "Volt Pepe", symbol: "VPEP" },
  { tokenAddress: "0xb293aBcD4Ef5061728394Aa1122334455667788", tokenName: "Iron Doge", symbol: "IDOG" },
  { tokenAddress: "0xc3aBcD4Ef5061728394Aa112233445566778899", tokenName: "Solar Cat", symbol: "SCAT" },
  { tokenAddress: "0xd4BcD4Ef5061728394Aa11223344556677889900", tokenName: "Pixel Fox", symbol: "PFOX" },
  { tokenAddress: "0xe5D4Ef5061728394Aa1122334455667788990011", tokenName: "Night Owl", symbol: "NOWL" },
  { tokenAddress: "0xf6Ef5061728394Aa112233445566778899001122", tokenName: "Amber Bull", symbol: "ABUL" },
  { tokenAddress: "0x175061728394Aa11223344556677889900112233", tokenName: "Chrome Wolf", symbol: "CWLF" },
  { tokenAddress: "0x2861728394Aa1122334455667788990011223344", tokenName: "Radar Duck", symbol: "RDUK" },
  { tokenAddress: "0x39728394Aa112233445566778899001122334455", tokenName: "Pulse Bear", symbol: "PBER" },
  { tokenAddress: "0x4a8394Aa11223344556677889900112233445566", tokenName: "Forge Crab", symbol: "FCRB" },
];

function pair(round, index, tokenA, tokenB, winner = null, battleId = null) {
  return {
    id: `r${round}-m${index}`,
    tokenA,
    tokenB,
    winner,
    battleId,
    bye: false,
  };
}

function upcomingBracket() {
  return { rounds: [] };
}

function liveQuarterFinalsBracket(battlePrefix) {
  const r = MOCK_TOURNAMENT_ROSTER.map((entry) => entry.tokenAddress);
  const r1Winners = [r[0], r[2], r[4], r[6], r[8], r[10], r[12], r[14]];
  return {
    rounds: [
      {
        round: 1,
        matches: [
          pair(1, 1, r[0], r[1], r[0], `${battlePrefix}-r1-1`),
          pair(1, 2, r[2], r[3], r[2], `${battlePrefix}-r1-2`),
          pair(1, 3, r[4], r[5], r[4], `${battlePrefix}-r1-3`),
          pair(1, 4, r[6], r[7], r[6], `${battlePrefix}-r1-4`),
          pair(1, 5, r[8], r[9], r[8], `${battlePrefix}-r1-5`),
          pair(1, 6, r[10], r[11], r[10], `${battlePrefix}-r1-6`),
          pair(1, 7, r[12], r[13], r[12], `${battlePrefix}-r1-7`),
          pair(1, 8, r[14], r[15], r[14], `${battlePrefix}-r1-8`),
        ],
      },
      {
        round: 2,
        matches: [
          pair(2, 1, r1Winners[0], r1Winners[1], null, `${battlePrefix}-qf-1`),
          pair(2, 2, r1Winners[2], r1Winners[3], null, `${battlePrefix}-qf-2`),
          pair(2, 3, r1Winners[4], r1Winners[5], null, `${battlePrefix}-qf-3`),
          pair(2, 4, r1Winners[6], r1Winners[7], null, `${battlePrefix}-qf-4`),
        ],
      },
      {
        round: 3,
        matches: [
          pair(3, 1, r1Winners[0], r1Winners[2], null, null),
          pair(3, 2, r1Winners[4], r1Winners[6], null, null),
        ],
      },
      {
        round: 4,
        matches: [pair(4, 1, r1Winners[0], r1Winners[4], null, null)],
      },
    ],
  };
}

function liveBracket() {
  return liveQuarterFinalsBracket("mock-normal");
}

function voteLiveBracket() {
  return liveQuarterFinalsBracket("mock-vote");
}

function participant(entry, extra = {}) {
  return {
    tokenId: entry.tokenAddress,
    tokenAddress: entry.tokenAddress,
    tokenName: extra.tokenName || entry.tokenName,
    symbol: extra.symbol || entry.symbol,
    imageUrl: extra.imageUrl === undefined ? entry.imageUrl || null : extra.imageUrl,
    logoUri: extra.logoUri === undefined ? entry.logoUri || null : extra.logoUri,
    score: extra.score ?? 0,
    priceChangePct: extra.priceChangePct ?? 0,
    volumeUsd: extra.volumeUsd ?? 0,
    uniqueTraders: extra.uniqueTraders ?? 0,
    holdersDelta: extra.holdersDelta ?? 0,
    holderCount: extra.holderCount,
    marketCapUsd: extra.marketCapUsd,
    voteScore: extra.voteScore,
    boostScore: extra.boostScore,
  };
}

function mockLiveBattle({ id, tournamentId, battleMode, left, right, startedOffset = -180 }) {
  const startedAt = new Date(Date.now() + startedOffset * 60_000).toISOString();
  const endsAt = new Date(Date.now() + (1440 + startedOffset) * 60_000).toISOString();
  return {
    id,
    state: "live",
    format: "duel",
    startedAt,
    endsAt,
    settlementAt: endsAt,
    featured: false,
    arenaLane: "live_battles",
    chainId: 56,
    source: "tournament",
    tournamentId,
    battleMode,
    durationHours: 24,
    nativeSymbol: "BNB",
    participants: [left, right],
  };
}

export function getMockTournamentBattles() {
  const r = MOCK_TOURNAMENT_ROSTER;
  return [
    mockLiveBattle({
      id: "mock-normal-qf-1",
      tournamentId: "event-tournament-live-04",
      battleMode: "normal",
      left: participant(r[0], { score: 71.2, marketCapUsd: 1920000, holderCount: 6120, volumeUsd: 193000 }),
      right: participant(r[1], { score: 70.8, marketCapUsd: 1880000, holderCount: 5980, volumeUsd: 177000 }),
    }),
    mockLiveBattle({
      id: "mock-normal-qf-2",
      tournamentId: "event-tournament-live-04",
      battleMode: "normal",
      left: participant(r[2], { score: 82.4, marketCapUsd: 2410000, holderCount: 7040, volumeUsd: 221000 }),
      right: participant(r[3], { score: 51.1, marketCapUsd: 980000, holderCount: 2210, volumeUsd: 64000 }),
    }),
    mockLiveBattle({
      id: "mock-normal-qf-3",
      tournamentId: "event-tournament-live-04",
      battleMode: "normal",
      left: participant(r[4], { score: 60, marketCapUsd: 1100000, holderCount: 3300, volumeUsd: 88000 }),
      right: participant(r[5], { score: 60, marketCapUsd: 1100000, holderCount: 3300, volumeUsd: 88000 }),
    }),
    mockLiveBattle({
      id: "mock-normal-qf-4",
      tournamentId: "event-tournament-live-04",
      battleMode: "normal",
      left: participant(r[6], { score: 0, marketCapUsd: 0, holderCount: 0, volumeUsd: 0 }),
      right: participant(r[7], { score: 0, marketCapUsd: 0, holderCount: 0, volumeUsd: 0 }),
    }),
    mockLiveBattle({
      id: "mock-vote-qf-1",
      tournamentId: "event-tournament-vote-05",
      battleMode: "vote",
      left: participant(r[0], { voteScore: 412, boostScore: 18 }),
      right: participant(r[1], { voteScore: 389, boostScore: 11 }),
    }),
    mockLiveBattle({
      id: "mock-vote-qf-2",
      tournamentId: "event-tournament-vote-05",
      battleMode: "vote",
      left: participant(r[2], { voteScore: 0, boostScore: 0 }),
      right: participant(r[3], { voteScore: 0, boostScore: 0 }),
    }),
    mockLiveBattle({
      id: "mock-vote-qf-3",
      tournamentId: "event-tournament-vote-05",
      battleMode: "vote",
      left: participant(r[8], {
        symbol: "SUPERLONGDOGEXXX",
        tokenName: "The Super Long Community War Token",
        voteScore: null,
      }),
      right: participant(r[9], { imageUrl: null, logoUri: null, voteScore: null }),
    }),
    mockLiveBattle({
      id: "mock-vote-qf-4",
      tournamentId: "event-tournament-vote-05",
      battleMode: "vote",
      left: participant(r[10], { voteScore: 128, boostScore: 40 }),
      right: participant(r[11], { voteScore: 44, boostScore: 9 }),
    }),
  ];
}

export function getMockTournamentBattleMetrics(battleId) {
  const id = String(battleId || "").trim();
  const pack = (left, right, extra = {}) => ({
    settlementMode: extra.vote ? "vote" : "battle_points_v2",
    leaderSide: extra.leaderSide ?? (left === right ? null : left > right ? "left" : "right"),
    pointDifference: Math.abs(left - right),
    dataHealth: extra.delay
      ? { healthy: false, status: "data_delay", reasons: ["stale"] }
      : { healthy: true, status: "healthy", reasons: [] },
    sides: {
      left: {
        pointsReady: extra.unavailable ? false : true,
        points: { total: left },
        current: { marketCapUsd: extra.leftMcap ?? left * 10000, holders: extra.leftHolders ?? 1000, healthy: !extra.delay },
        eligibleBattleVolumeUsd: extra.leftVol ?? 1000,
      },
      right: {
        pointsReady: extra.unavailable ? false : true,
        points: { total: right },
        current: { marketCapUsd: extra.rightMcap ?? right * 10000, holders: extra.rightHolders ?? 1000, healthy: !extra.delay },
        eligibleBattleVolumeUsd: extra.rightVol ?? 1000,
      },
    },
    state: extra.delay ? "live" : "live",
  });
  if (id === "mock-normal-qf-1") return pack(71.2, 70.8);
  if (id === "mock-normal-qf-2") return pack(82.4, 51.1);
  if (id === "mock-normal-qf-3") return pack(60, 60, { leaderSide: null });
  if (id === "mock-normal-qf-4") return pack(0, 0, { delay: true, leaderSide: null });
  if (id === "mock-vote-qf-1") return { ...pack(412, 389, { vote: true }), state: "live" };
  if (id === "mock-vote-qf-2") return { ...pack(0, 0, { vote: true, leaderSide: null }), state: "live" };
  if (id === "mock-vote-qf-3") return pack(0, 0, { unavailable: true, vote: true, leaderSide: null });
  if (id === "mock-vote-qf-4") return { ...pack(128, 44, { vote: true }), state: "live" };
  return null;
}

export function getMockTournamentEvents() {
  return MOCK_TOURNAMENT_EVENTS.map((event) => {
    if (event.id === "event-tournament-live-04") return { ...event, bracket: liveBracket() };
    if (event.id === "event-tournament-vote-05") return { ...event, bracket: voteLiveBracket() };
    return { ...event };
  });
}

export const MOCK_TOURNAMENT_EVENTS = [
  {
    id: "event-tournament-03",
    type: "tournament",
    title: "Rookie Crown Qualifier",
    status: "scheduled",
    startsAt: new Date("2026-05-22T22:00:00.000Z").toISOString(),
    endsAt: new Date("2026-05-23T22:00:00.000Z").toISOString(),
    participantCount: 16,
    summary: "The next Warzone crown is up for grabs.",
    chainId: 56,
    registrationMode: "open",
    bracketStage: "registration",
    nativeSymbol: "BNB",
    entrants: MOCK_TOURNAMENT_ROSTER,
  },
  {
    id: "event-tournament-live-04",
    type: "tournament",
    title: "Rookie Crown Qualifier",
    status: "live",
    startsAt: new Date("2026-05-21T18:00:00.000Z").toISOString(),
    endsAt: new Date("2026-05-22T18:00:00.000Z").toISOString(),
    participantCount: 16,
    summary: "Quarter Finals are live.",
    chainId: 56,
    registrationMode: "closed",
    bracketStage: "quarterfinals",
    nativeSymbol: "BNB",
    battleMode: "normal",
    durationHours: 24,
    cap: 16,
    entrants: MOCK_TOURNAMENT_ROSTER,
  },
  {
    id: "event-tournament-vote-05",
    type: "tournament",
    title: "Community War Cup",
    status: "live",
    startsAt: new Date("2026-05-21T18:00:00.000Z").toISOString(),
    endsAt: new Date("2026-05-22T18:00:00.000Z").toISOString(),
    participantCount: 16,
    summary: "Vote Quarter Finals are live.",
    chainId: 56,
    registrationMode: "closed",
    bracketStage: "quarterfinals",
    nativeSymbol: "BNB",
    battleMode: "vote",
    durationHours: 24,
    cap: 16,
    entrants: MOCK_TOURNAMENT_ROSTER,
  },
];

export function getMockTournamentDetails(eventId) {
  const id = String(eventId || "").trim();
  if (id === "event-tournament-live-04") {
    return {
      event: {
        ...MOCK_TOURNAMENT_EVENTS[1],
        buyInNative: 0,
        cap: 16,
      },
      entries: MOCK_TOURNAMENT_ROSTER.map((entry) => ({
        tokenAddress: entry.tokenAddress,
        ownerWallet: "mock-owner",
        buyInIntent: true,
        buyInPaid: true,
        symbol: entry.symbol,
        tokenName: entry.tokenName,
        imageUrl: entry.imageUrl,
        logoUri: entry.logoUri,
      })),
      bracket: liveBracket(),
    };
  }
  if (id === "event-tournament-vote-05") {
    return {
      event: {
        ...MOCK_TOURNAMENT_EVENTS[2],
        buyInNative: 0,
        cap: 16,
      },
      entries: MOCK_TOURNAMENT_ROSTER.map((entry) => ({
        tokenAddress: entry.tokenAddress,
        ownerWallet: "mock-owner",
        buyInIntent: true,
        buyInPaid: true,
        symbol: entry.symbol,
        tokenName: entry.tokenName,
        imageUrl: entry.imageUrl,
        logoUri: entry.logoUri,
      })),
      bracket: voteLiveBracket(),
    };
  }
  if (id === "event-tournament-03") {
    return {
      event: {
        ...MOCK_TOURNAMENT_EVENTS[0],
        buyInNative: 0,
        cap: 16,
      },
      entries: MOCK_TOURNAMENT_ROSTER.map((entry) => ({
        tokenAddress: entry.tokenAddress,
        ownerWallet: "mock-owner",
        buyInIntent: true,
        buyInPaid: false,
        symbol: entry.symbol,
        tokenName: entry.tokenName,
        imageUrl: entry.imageUrl,
        logoUri: entry.logoUri,
      })),
      bracket: upcomingBracket(),
    };
  }
  return null;
}
