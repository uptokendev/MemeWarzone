function text(value) {
  return String(value || "").trim();
}

function isEvm(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(text(value));
}

function identity(value) {
  const raw = text(value);
  return isEvm(raw) ? raw.toLowerCase() : raw;
}

export function tournamentVoteTokensEqual(left, right) {
  const a = identity(left);
  const b = identity(right);
  return Boolean(a && b && a === b);
}

export function parseTournamentVoteBracket(bracket) {
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

function findActiveRound(rounds) {
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const matches = Array.isArray(rounds[index]?.matches) ? rounds[index].matches : [];
    if (matches.some((match) => !match?.bye && !text(match?.winner))) {
      return { index, round: rounds[index], matches };
    }
  }
  return null;
}

export function resolveTournamentVoteMatch({ tournament, matchRef, selectedToken } = {}) {
  if (text(tournament?.status) !== "live") {
    return { ok: false, reason: "tournament-not-live" };
  }

  const rounds = parseTournamentVoteBracket(tournament?.bracket);
  if (!rounds) return { ok: false, reason: "invalid-bracket" };

  const active = findActiveRound(rounds);
  if (!active) return { ok: false, reason: "no-active-round" };

  const ref = text(matchRef);
  if (!ref) return { ok: false, reason: "missing-match-ref" };

  const match = active.matches.find((candidate) =>
    text(candidate?.id) === ref || text(candidate?.battleId || candidate?.battle_id) === ref
  );
  if (!match) return { ok: false, reason: "match-not-active" };
  if (match?.bye) return { ok: false, reason: "bye-match" };
  if (text(match?.winner)) return { ok: false, reason: "match-finished" };

  const tokenA = text(match?.tokenA || match?.token_a);
  const tokenB = text(match?.tokenB || match?.token_b);
  if (!tokenA || !tokenB) return { ok: false, reason: "invalid-match-participants" };

  const selected = text(selectedToken);
  if (selected && !tournamentVoteTokensEqual(selected, tokenA) && !tournamentVoteTokensEqual(selected, tokenB)) {
    return { ok: false, reason: "selected-token-not-in-match" };
  }

  const roundNumber = Number(active.round?.round ?? active.index + 1);
  return {
    ok: true,
    reason: "ok",
    roundNumber: Number.isFinite(roundNumber) ? roundNumber : active.index + 1,
    matchId: text(match?.id) || `r${active.index + 1}-match`,
    battleId: text(match?.battleId || match?.battle_id) || null,
    tokenA,
    tokenB,
    selectedToken: selected || null,
  };
}

export function tournamentVoteSummary(rows, match) {
  const counts = new Map([
    [identity(match?.tokenA), 0],
    [identity(match?.tokenB), 0],
  ]);

  for (const row of Array.isArray(rows) ? rows : []) {
    const key = identity(row?.selected_token || row?.selectedToken);
    if (counts.has(key)) counts.set(key, Number(counts.get(key) || 0) + 1);
  }

  const leftVotes = Number(counts.get(identity(match?.tokenA)) || 0);
  const rightVotes = Number(counts.get(identity(match?.tokenB)) || 0);
  return {
    tokenA: match?.tokenA || "",
    tokenB: match?.tokenB || "",
    leftVotes,
    rightVotes,
    totalVotes: leftVotes + rightVotes,
  };
}
