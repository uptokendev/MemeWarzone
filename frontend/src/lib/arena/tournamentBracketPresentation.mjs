function roundLabel(round, totalRounds) {
  const remaining = Number(totalRounds) - Number(round);
  if (remaining === 0) return "CHAMPIONSHIP";
  if (remaining === 1) return "FINAL";
  if (remaining === 2) return "SEMI";
  if (remaining === 3) return "QUARTER";
  return `R${round}`;
}

function tokenHint(value, identities = {}) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const key = raw.toLowerCase();
  const named = identities[raw] || identities[key] || null;
  return {
    tokenAddress: raw,
    symbol: String(named?.symbol || "").replace(/^\$/, "") || null,
    name: named?.tokenName || named?.name || null,
    imageUrl: named?.imageUrl || named?.logoUri || null,
  };
}

function presentNode(tokenAddress, identities, winnerAddress) {
  const hint = tokenHint(tokenAddress, identities);
  if (!hint) return null;
  const winner = String(winnerAddress || "").trim();
  const won = Boolean(winner && winner.toLowerCase() === String(hint.tokenAddress).toLowerCase());
  const lost = Boolean(winner && !won);
  return { ...hint, won, lost };
}

export function presentSymmetricBracket(rounds, identities = {}) {
  const list = (Array.isArray(rounds) ? rounds : [])
    .map((round) => ({
      round: Number(round?.round) || 0,
      matches: Array.isArray(round?.matches) ? round.matches : [],
    }))
    .filter((round) => round.round > 0 && round.matches.length)
    .sort((left, right) => left.round - right.round);

  if (!list.length) {
    return { empty: true, left: [], right: [], championship: null, labels: [] };
  }

  const totalRounds = list.length;
  const championshipRound = list[list.length - 1];
  const hasChampionship = championshipRound.matches.length === 1;
  const columnRounds = hasChampionship ? list.slice(0, -1) : list;

  const left = [];
  const right = [];
  for (const round of columnRounds) {
    const mid = Math.ceil(round.matches.length / 2);
    const label = roundLabel(round.round, hasChampionship ? totalRounds : totalRounds + 1);
    left.push({
      round: round.round,
      label,
      matches: round.matches.slice(0, mid).map((match) => presentBracketMatch(match, identities)),
    });
    right.push({
      round: round.round,
      label,
      matches: round.matches.slice(mid).map((match) => presentBracketMatch(match, identities)),
    });
  }

  const championship = hasChampionship
    ? presentChampionship(championshipRound.matches[0], identities)
    : null;

  return {
    empty: false,
    left,
    right: right.map((column) => column).reverse(),
    championship,
    labels: left.map((column) => column.label),
  };
}

export function presentBracketMatch(match, identities = {}) {
  const winner = String(match?.winner || "").trim() || null;
  const live = !winner && Boolean(match?.battleId);
  return {
    id: String(match?.id || ""),
    battleId: String(match?.battleId || "").trim() || null,
    bye: match?.bye === true || !match?.tokenB,
    winner,
    live,
    left: presentNode(match?.tokenA, identities, winner),
    right: presentNode(match?.tokenB, identities, winner),
  };
}

export function presentChampionship(match, identities = {}) {
  const presented = presentBracketMatch(match, identities);
  const champion = presented.winner
    ? presented.left?.won
      ? presented.left
      : presented.right?.won
        ? presented.right
        : null
    : null;
  return {
    ...presented,
    champion,
  };
}

export function identitiesFromEntries(entries = []) {
  const map = {};
  for (const entry of entries) {
    const tokenAddress = String(entry?.tokenAddress || entry?.tokenId || "").trim();
    if (!tokenAddress) continue;
    map[tokenAddress] = {
      symbol: entry.symbol,
      tokenName: entry.tokenName || entry.name,
      imageUrl: entry.imageUrl || entry.logoUri,
    };
    map[tokenAddress.toLowerCase()] = map[tokenAddress];
  }
  return map;
}
