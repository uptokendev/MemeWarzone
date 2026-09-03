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

function liveBracket() {
  const r = MOCK_TOURNAMENT_ROSTER.map((entry) => entry.tokenAddress);
  const r1Winners = [r[0], r[2], r[4], r[6], r[8], r[10], r[12], r[14]];
  return {
    rounds: [
      {
        round: 1,
        matches: [
          pair(1, 1, r[0], r[1], r[0], "mock-battle-r1-1"),
          pair(1, 2, r[2], r[3], r[2], "mock-battle-r1-2"),
          pair(1, 3, r[4], r[5], r[4], "mock-battle-r1-3"),
          pair(1, 4, r[6], r[7], r[6], "mock-battle-r1-4"),
          pair(1, 5, r[8], r[9], r[8], "mock-battle-r1-5"),
          pair(1, 6, r[10], r[11], r[10], "mock-battle-r1-6"),
          pair(1, 7, r[12], r[13], r[12], "mock-battle-r1-7"),
          pair(1, 8, r[14], r[15], r[14], "mock-battle-r1-8"),
        ],
      },
      {
        round: 2,
        matches: [
          pair(2, 1, r1Winners[0], r1Winners[1], r1Winners[0], "mock-battle-qf-1"),
          pair(2, 2, r1Winners[2], r1Winners[3], null, "mock-battle-qf-2"),
          pair(2, 3, r1Winners[4], r1Winners[5], r1Winners[4], "mock-battle-qf-3"),
          pair(2, 4, r1Winners[6], r1Winners[7], null, "mock-battle-qf-4"),
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

export function getMockTournamentEvents() {
  return [
    { ...MOCK_TOURNAMENT_EVENTS[0] },
    { ...MOCK_TOURNAMENT_EVENTS[1], bracket: liveBracket() },
  ];
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
