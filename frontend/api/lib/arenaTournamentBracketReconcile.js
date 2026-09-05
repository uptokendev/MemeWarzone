/** 4c.3: idempotent lagged tournament bracket repair. Money winner only. No MWL, no settlement. */

function ident(value) {
  return String(value || "").trim();
}

function isEvmAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** EVM addresses compare case-insensitively; Solana pubkeys stay exact. */
export function tokensEqual(left, right) {
  const a = ident(left);
  const b = ident(right);
  if (!a || !b) return false;
  if (isEvmAddress(a) && isEvmAddress(b)) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function tokenKey(value) {
  const raw = ident(value);
  if (!raw) return "";
  return isEvmAddress(raw) ? raw.toLowerCase() : raw;
}

export function unorderedPairKey(left, right) {
  const a = tokenKey(left);
  const b = tokenKey(right);
  if (!a || !b) return "";
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function fail(reason, extra = {}) {
  return {
    ok: false,
    action: "block",
    reason,
    nextBracket: null,
    finished: false,
    winner: "",
    matchWinner: "",
    battlesToInsert: [],
    battlesToAttach: [],
    ...extra,
  };
}

function skip(reason, extra = {}) {
  return {
    ok: true,
    action: "skip",
    reason,
    nextBracket: null,
    finished: false,
    winner: "",
    matchWinner: "",
    battlesToInsert: [],
    battlesToAttach: [],
    ...extra,
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseRounds(bracket) {
  let value = bracket;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!Array.isArray(value.rounds)) return null;
  return value.rounds;
}

function findMatchLocation(rounds, battleId) {
  const id = String(battleId || "");
  if (!id) return null;
  for (let roundIndex = 0; roundIndex < rounds.length; roundIndex += 1) {
    const matches = Array.isArray(rounds[roundIndex]?.matches) ? rounds[roundIndex].matches : [];
    for (let matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
      if (String(matches[matchIndex]?.battleId || "") === id) {
        return { roundIndex, matchIndex, match: matches[matchIndex] };
      }
    }
  }
  return null;
}

function attachedBattleIds(rounds) {
  const ids = new Set();
  for (const round of rounds) {
    for (const match of round?.matches || []) {
      const id = String(match?.battleId || "");
      if (id) ids.add(id);
    }
  }
  return ids;
}

function chainIdOf(row) {
  const n = Number(row?.chain_id ?? row?.chainId);
  return Number.isFinite(n) ? n : NaN;
}

function createdAtMs(row) {
  const n = Date.parse(row?.created_at || row?.createdAt || 0);
  return Number.isFinite(n) ? n : 0;
}

function unusedOrphans({ tournament, battle, existingBattles, rounds }) {
  const tournamentId = ident(tournament?.id || tournament?.tournamentId);
  const expectedChain = chainIdOf(tournament);
  const battleChain = chainIdOf(battle);
  const chain = Number.isFinite(expectedChain) ? expectedChain : battleChain;
  const attached = attachedBattleIds(rounds);
  const currentId = String(battle?.id || "");
  const unused = [];
  for (const row of Array.isArray(existingBattles) ? existingBattles : []) {
    if (ident(row?.tournament_id || row?.tournamentId) !== tournamentId) continue;
    if (ident(row?.source) !== "tournament") continue;
    const rowChain = chainIdOf(row);
    if (Number.isFinite(chain) && Number.isFinite(rowChain) && rowChain !== chain) continue;
    const id = String(row?.id || "");
    if (!id || id === currentId || attached.has(id)) continue;
    unused.push(row);
  }
  unused.sort((a, b) => {
    const time = createdAtMs(a) - createdAtMs(b);
    if (time !== 0) return time;
    return String(a.id).localeCompare(String(b.id));
  });
  return unused;
}

function takeOrphanForPair(orphans, tokenA, tokenB) {
  const key = unorderedPairKey(tokenA, tokenB);
  if (!key) return null;
  const index = orphans.findIndex((row) => unorderedPairKey(row.challenger_token || row.challengerToken, row.defender_token || row.defenderToken) === key);
  if (index < 0) return null;
  return orphans.splice(index, 1)[0];
}

function matchWinnerIsParticipant(match, winner) {
  const a = ident(match?.tokenA || match?.token_a);
  const b = ident(match?.tokenB || match?.token_b);
  if (b) return tokensEqual(winner, a) || tokensEqual(winner, b);
  return tokensEqual(winner, a);
}

function validatedRoundWinners(matches) {
  const list = Array.isArray(matches) ? matches : [];
  const winners = [];
  for (const match of list) {
    const winner = ident(match?.winner);
    if (!winner) return { complete: false, invalid: false, winners: [] };
    if (!matchWinnerIsParticipant(match, winner)) {
      return { complete: false, invalid: true, reason: "round-winner-not-in-match", winners: [] };
    }
    winners.push(winner);
  }
  return { complete: list.length > 0, invalid: false, winners };
}

export function attachInsertedBattleId(bracket, tokenA, tokenB, battleId) {
  const rounds = Array.isArray(bracket?.rounds) ? bracket.rounds : [];
  const last = rounds[rounds.length - 1];
  for (const match of last?.matches || []) {
    if (match?.bye || match?.battleId) continue;
    if (!ident(match?.tokenB || match?.token_b)) continue;
    const a = match.tokenA || match.token_a;
    const b = match.tokenB || match.token_b;
    if (unorderedPairKey(a, b) === unorderedPairKey(tokenA, tokenB)) {
      match.battleId = battleId;
      return true;
    }
  }
  return false;
}

export function planTournamentBracketReconcile({ tournament, battle, existingBattles } = {}) {
  const battleState = ident(battle?.state);
  if (battleState !== "finished") return fail("battle-not-finished");
  const tournamentId = ident(tournament?.id || tournament?.tournamentId);
  const battleTournamentId = ident(battle?.tournament_id || battle?.tournamentId);
  if (ident(battle?.source) !== "tournament" || !battleTournamentId) return fail("not-tournament-battle");
  if (!tournamentId || battleTournamentId !== tournamentId) return fail("battle-tournament-mismatch");

  const moneyWinner = ident(battle?.money_winner_token || battle?.moneyWinnerToken);
  if (!moneyWinner) return fail("missing-money-winner");

  const challenger = ident(battle?.challenger_token || battle?.challengerToken);
  const defender = ident(battle?.defender_token || battle?.defenderToken);
  if (!tokensEqual(moneyWinner, challenger) && !tokensEqual(moneyWinner, defender)) {
    return fail("money-winner-not-in-battle");
  }

  const tournamentChain = chainIdOf(tournament);
  const battleChain = chainIdOf(battle);
  if (Number.isFinite(tournamentChain) && Number.isFinite(battleChain) && tournamentChain !== battleChain) {
    return fail("chain-mismatch");
  }

  const status = ident(tournament?.status);
  const persistedWinner = ident(tournament?.winner_token || tournament?.winnerToken);
  if (status === "finished") {
    if (tokensEqual(persistedWinner, moneyWinner)) {
      return skip("already-finished", { winner: persistedWinner, matchWinner: moneyWinner });
    }
    return fail("finished-winner-mismatch", { winner: persistedWinner, matchWinner: moneyWinner });
  }
  if (status !== "live") return fail("tournament-not-live");

  const rounds = parseRounds(tournament?.bracket);
  if (!rounds) return fail("invalid-bracket");
  const location = findMatchLocation(rounds, battle?.id);
  if (!location) return fail("battle-not-in-bracket");

  if (!matchWinnerIsParticipant(location.match, moneyWinner)) return fail("winner-not-in-match");

  const recorded = ident(location.match.winner);
  if (recorded && !tokensEqual(recorded, moneyWinner)) return fail("match-winner-mismatch");

  const nextRoundExists = location.roundIndex < rounds.length - 1;
  const alreadyRecorded = Boolean(recorded);

  if (alreadyRecorded && nextRoundExists) {
    return skip("already-advanced", { matchWinner: moneyWinner });
  }

  const nextBracket = { rounds: cloneJson(rounds) };
  const clonedMatch = nextBracket.rounds[location.roundIndex].matches[location.matchIndex];
  if (!alreadyRecorded) clonedMatch.winner = moneyWinner;

  if (nextRoundExists) {
    return {
      ok: true,
      action: "apply",
      reason: "ok",
      nextBracket,
      finished: false,
      winner: "",
      matchWinner: moneyWinner,
      battlesToInsert: [],
      battlesToAttach: [],
    };
  }

  const last = nextBracket.rounds[nextBracket.rounds.length - 1];
  const lastMatches = Array.isArray(last?.matches) ? last.matches : [];
  const validated = validatedRoundWinners(lastMatches);
  if (validated.invalid) return fail(validated.reason || "round-winner-not-in-match");
  const winners = validated.winners;
  const lastComplete = Boolean(validated.complete);

  if (!lastComplete) {
    if (alreadyRecorded) return skip("match-already-recorded", { matchWinner: moneyWinner });
    return {
      ok: true,
      action: "apply",
      reason: "ok",
      nextBracket,
      finished: false,
      winner: "",
      matchWinner: moneyWinner,
      battlesToInsert: [],
      battlesToAttach: [],
    };
  }

  if (lastMatches.length === 1) {
    return {
      ok: true,
      action: "apply",
      reason: "ok",
      nextBracket,
      finished: true,
      winner: winners[0],
      matchWinner: moneyWinner,
      battlesToInsert: [],
      battlesToAttach: [],
    };
  }

  const orphans = unusedOrphans({ tournament, battle, existingBattles, rounds: nextBracket.rounds });
  const nextMatches = [];
  const battlesToInsert = [];
  const battlesToAttach = [];
  const nextRoundNumber = Number(last.round || location.roundIndex + 1) + 1;
  for (let i = 0; i < winners.length; i += 2) {
    const a = winners[i];
    const b = winners[i + 1];
    const id = `r${nextRoundNumber}-m${nextMatches.length + 1}`;
    if (!b) {
      nextMatches.push({
        id,
        tokenA: a,
        tokenB: null,
        battleId: null,
        winner: a,
        bye: true,
      });
      continue;
    }
    const orphan = takeOrphanForPair(orphans, a, b);
    if (orphan) {
      battlesToAttach.push({ tokenA: a, tokenB: b, battleId: String(orphan.id) });
      nextMatches.push({
        id,
        tokenA: a,
        tokenB: b,
        battleId: String(orphan.id),
        winner: null,
        bye: false,
      });
    } else {
      battlesToInsert.push({ tokenA: a, tokenB: b });
      nextMatches.push({
        id,
        tokenA: a,
        tokenB: b,
        battleId: null,
        winner: null,
        bye: false,
      });
    }
  }
  nextBracket.rounds.push({ round: nextRoundNumber, matches: nextMatches });

  const nextWinners = validatedRoundWinners(nextMatches).winners;
  const byeFinish = nextMatches.length === 1 && nextWinners.length === 1;
  return {
    ok: true,
    action: "apply",
    reason: "ok",
    nextBracket,
    finished: byeFinish,
    winner: byeFinish ? nextWinners[0] : "",
    matchWinner: moneyWinner,
    battlesToInsert,
    battlesToAttach,
  };
}
