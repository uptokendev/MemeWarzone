/** 4c.1: tournament start roster. Paid buy-in is required when buy_in_native > 0. */

export function isExactTournamentBracketSize(value) {
  const size = Number(value);
  return Number.isInteger(size) && size >= 2 && (size & (size - 1)) === 0;
}

export function tournamentStartRoster(entries, { buyInNative } = {}) {
  const list = Array.isArray(entries) ? entries : [];

  // Normal Tournaments are single-elimination without synthetic byes.
  // Reject the start roster before seeding when it cannot form an exact bracket.
  if (!isExactTournamentBracketSize(list.length)) {
    return {
      ok: false,
      reason: "invalid-bracket-size",
      code: "TOURNAMENT_EXACT_BRACKET_REQUIRED",
      roster: [],
      unpaid: [],
      participantCount: list.length,
    };
  }

  const buyIn = Number(buyInNative || 0);
  if (!(buyIn > 0)) {
    return { ok: true, reason: "no-buy-in", roster: list, unpaid: [] };
  }
  const unpaid = list.filter((entry) => entry?.buyInPaid !== true);
  if (unpaid.length) {
    return {
      ok: false,
      reason: "unpaid-roster",
      code: "UNPAID_TOURNAMENT_ROSTER",
      roster: [],
      unpaid,
    };
  }
  return { ok: true, reason: "paid", roster: list, unpaid: [] };
}
