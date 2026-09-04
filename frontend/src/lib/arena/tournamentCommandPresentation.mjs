export function tournamentHref(id) {
  const value = String(id || "").trim();
  if (!value) return "/warzone/tournaments";
  return `/warzone/tournaments/${encodeURIComponent(value)}`;
}

export function battleFightHref(battleId) {
  const value = String(battleId || "").trim();
  if (!value) return null;
  return `/warzone/battles/${encodeURIComponent(value)}`;
}

export function presentTournamentStatus(status, tab) {
  const raw = String(status || "").toLowerCase();
  if (raw === "live") return { key: "live", label: "LIVE" };
  if (raw === "completed" || raw === "finished") return { key: "finished", label: "FINISHED" };
  if (raw === "deploying") return { key: "deploying", label: "DEPLOYING" };
  if (raw === "scheduled") return { key: "upcoming", label: "UPCOMING" };
  if (tab === "live") return { key: "live", label: "LIVE" };
  if (tab === "results") return { key: "finished", label: "FINISHED" };
  return { key: "upcoming", label: "UPCOMING" };
}

export function presentTournamentMode(source = {}) {
  const raw = String(source?.battleMode || source?.battle_mode || source?.mode || "").trim().toLowerCase();
  if (raw === "vote") return { key: "vote", label: "VOTE" };
  if (raw === "normal") return { key: "normal", label: "NORMAL" };
  return null;
}

export function presentTournamentChain(source = {}) {
  const chainId = Number(source?.chainId ?? source?.chain_id);
  if (!Number.isFinite(chainId) || chainId <= 0) return null;
  if (chainId === 101 || chainId === 102) return { chainId, label: "SOLANA" };
  if (chainId === 4663 || chainId === 46630) return { chainId, label: "ROBINHOOD" };
  return { chainId, label: "BNB" };
}

export function presentTournamentRegistration(source = {}) {
  const stage = String(source?.bracketStage || source?.bracket_stage || "").trim().toLowerCase();
  const mode = String(source?.registrationMode || source?.registration_mode || "").trim().toLowerCase();
  if (mode === "open") return { key: "open", label: "REGISTRATION OPEN" };
  if (mode === "closed") return { key: "closed", label: "REGISTRATION CLOSED" };
  if (stage === "registration") return { key: "open", label: "REGISTRATION OPEN" };
  return null;
}

export function presentTournamentBuyIn(source = {}) {
  const amount = Number(source?.buyInNative ?? source?.buy_in_native);
  const symbol = String(source?.nativeSymbol || source?.native_symbol || "").trim();
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    amount,
    symbol: symbol || null,
    label: symbol ? `${amount} ${symbol}` : String(amount),
  };
}

export function presentTournamentMoment(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function presentTournamentDateLabel(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" }).toUpperCase();
}

export function presentTournamentDateTimeLabel(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const day = presentTournamentDateLabel(value);
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return day && time ? `${day} · ${time}` : day;
}

export function readBracketRounds(source) {
  if (!source) return [];
  if (Array.isArray(source.rounds)) return source.rounds;
  if (Array.isArray(source.bracket?.rounds)) return source.bracket.rounds;
  if (Array.isArray(source.bracket)) return source.bracket;
  if (Array.isArray(source)) return source;
  return [];
}

export function presentTournamentEntrantPreview(event, limit = 4) {
  const listed = Array.isArray(event?.entrants) ? event.entrants : Array.isArray(event?.entries) ? event.entries : [];
  const identities = {};
  for (const entry of listed) {
    const tokenAddress = String(entry?.tokenAddress || entry?.tokenId || "").trim();
    if (!tokenAddress) continue;
    identities[tokenAddress] = {
      tokenAddress,
      symbol: String(entry.symbol || "").replace(/^\$/, "") || null,
      tokenName: String(entry.tokenName || entry.name || "").trim() || null,
      imageUrl: entry.imageUrl || entry.logoUri || null,
    };
  }
  const ordered = [];
  const seen = new Set();
  for (const entry of listed) {
    const tokenAddress = String(entry?.tokenAddress || entry?.tokenId || "").trim();
    if (!tokenAddress || seen.has(tokenAddress.toLowerCase())) continue;
    seen.add(tokenAddress.toLowerCase());
    ordered.push(identities[tokenAddress]);
  }
  if (!ordered.length) {
    for (const round of readBracketRounds(event)) {
      for (const match of round.matches || []) {
        for (const token of [match.tokenA, match.tokenB]) {
          const tokenAddress = String(token || "").trim();
          if (!tokenAddress || seen.has(tokenAddress.toLowerCase())) continue;
          seen.add(tokenAddress.toLowerCase());
          ordered.push(identities[tokenAddress] || { tokenAddress, symbol: null, tokenName: null, imageUrl: null });
        }
      }
    }
  }
  const count = Number.isFinite(Number(event?.participantCount)) ? Number(event.participantCount) : ordered.length;
  const preview = ordered.slice(0, limit);
  return {
    preview,
    extra: Math.max(0, count - preview.length),
  };
}

export function presentTournamentChampion(event, entries = []) {
  const listed = [
    ...(Array.isArray(event?.entrants) ? event.entrants : []),
    ...(Array.isArray(event?.entries) ? event.entries : []),
    ...(Array.isArray(entries) ? entries : []),
  ];
  const named = (tokenAddress) => {
    const raw = String(tokenAddress || "").trim();
    if (!raw) return null;
    const hit = listed.find((entry) => String(entry?.tokenAddress || entry?.tokenId || "").toLowerCase() === raw.toLowerCase());
    return {
      tokenAddress: raw,
      symbol: String(hit?.symbol || "").replace(/^\$/, "") || null,
      tokenName: String(hit?.tokenName || hit?.name || "").trim() || null,
      imageUrl: hit?.imageUrl || hit?.logoUri || null,
    };
  };
  const direct = event?.winnerToken || event?.winner_token || event?.championToken;
  if (direct && typeof direct === "object") {
    const tokenAddress = String(direct.tokenAddress || direct.tokenId || "").trim();
    if (tokenAddress) return { ...named(tokenAddress), ...direct, tokenAddress };
  }
  if (typeof direct === "string" && direct.trim()) return named(direct);
  const rounds = readBracketRounds(event);
  const last = rounds[rounds.length - 1];
  if (!last || !Array.isArray(last.matches) || last.matches.length !== 1) return null;
  const winner = String(last.matches[0]?.winner || "").trim();
  if (!winner) return null;
  return named(winner);
}

export function presentAuthoritativeLiveBattleCount(event) {
  const rounds = readBracketRounds(event);
  if (!rounds.length) return null;
  let count = 0;
  for (const round of rounds) {
    for (const match of round.matches || []) {
      if (match.battleId && !match.winner && match.bye !== true) count += 1;
    }
  }
  return count;
}

export function presentAuthoritativeRemaining(event) {
  const rounds = readBracketRounds(event);
  if (!rounds.length) return null;
  const all = new Set();
  const lost = new Set();
  const key = (value) => String(value || "").trim().toLowerCase();
  let settled = false;
  for (const round of rounds) {
    for (const match of round.matches || []) {
      const left = key(match.tokenA);
      const right = key(match.tokenB);
      if (left) all.add(left);
      if (right) all.add(right);
      const winner = key(match.winner);
      if (winner && right && match.bye !== true) {
        settled = true;
        if (left && left !== winner) lost.add(left);
        if (right && right !== winner) lost.add(right);
      }
    }
  }
  if (!all.size) return null;
  if (!settled) return all.size;
  return Math.max(0, all.size - lost.size);
}

function fieldSizes(cap) {
  const n = Number(cap);
  if (Number.isFinite(n) && n >= 2 && (n & (n - 1)) === 0) {
    const sizes = [];
    for (let value = n; value >= 1; value /= 2) sizes.push(value);
    return sizes;
  }
  return [16, 8, 4, 2, 1];
}

function stageIndexFromBracketStage(stage, sizes) {
  const raw = String(stage || "").trim().toLowerCase();
  if (raw === "completed" || raw === "finished") return sizes.length - 1;
  if (raw === "finals" || raw === "final") return Math.max(0, sizes.indexOf(2));
  if (raw === "semifinals" || raw === "semi") return Math.max(0, sizes.indexOf(4));
  if (raw === "quarterfinals" || raw === "quarter") return Math.max(0, sizes.indexOf(8) >= 0 ? sizes.indexOf(8) : sizes.indexOf(sizes[0]));
  if (raw === "registration" || raw === "round1" || raw === "r1") return 0;
  return 0;
}

function labelsForSize(size, isLast) {
  if (isLast || size === 1) return { short: "CHAMPION", long: "CHAMPION" };
  if (size === 2) return { short: "FINAL", long: "FINAL" };
  if (size === 4) return { short: "SF", long: "SEMI FINALS" };
  if (size === 8) return { short: "QF", long: "QUARTER FINALS" };
  return { short: "R1", long: "ROUND 1" };
}

export function presentTournamentProgression(event) {
  const cap = Number(event?.cap || event?.participantCount || 16);
  const sizes = fieldSizes(cap);
  const rounds = readBracketRounds(event);
  const champion = presentTournamentChampion(event);
  let currentIndex = stageIndexFromBracketStage(event?.bracketStage || event?.bracket_stage, sizes);
  const completed = sizes.map(() => false);

  if (rounds.length) {
    const sorted = [...rounds].sort((left, right) => Number(left.round || 0) - Number(right.round || 0));
    for (let i = 0; i < sizes.length; i += 1) {
      if (sizes[i] === 1) {
        completed[i] = Boolean(champion);
        continue;
      }
      const round = sorted[i];
      const matches = Array.isArray(round?.matches) ? round.matches : [];
      completed[i] = matches.length > 0 && matches.every((match) => Boolean(match.winner) || match.bye === true);
    }
    const open = completed.findIndex((done, index) => !done && sizes[index] !== 1);
    currentIndex = open >= 0 ? open : sizes.length - 1;
  } else {
    const stage = String(event?.bracketStage || event?.bracket_stage || "").toLowerCase();
    for (let i = 0; i < sizes.length; i += 1) completed[i] = i < currentIndex;
    if (stage === "completed" || stage === "finished") {
      for (let i = 0; i < sizes.length - 1; i += 1) completed[i] = true;
      completed[sizes.length - 1] = Boolean(champion);
      currentIndex = sizes.length - 1;
    }
  }

  const nodes = sizes.map((size, index) => {
    const labels = labelsForSize(size, index === sizes.length - 1);
    const isChampion = size === 1;
    const nodeComplete = isChampion ? Boolean(champion) && completed[index] : completed[index];
    return {
      size,
      key: labels.short,
      label: labels.long,
      shortLabel: labels.short,
      complete: nodeComplete,
      current: !nodeComplete && index === currentIndex,
    };
  });

  return {
    cap: sizes[0],
    nodes,
    championReady: Boolean(champion),
  };
}

export function presentTournamentCard(event, options = {}) {
  const tab = options.tab || null;
  const status = presentTournamentStatus(event?.status, tab);
  const mode = presentTournamentMode(event);
  const chain = presentTournamentChain(event);
  const registration = presentTournamentRegistration(event);
  const buyIn = presentTournamentBuyIn(event);
  const startsAt = event?.startsAt || event?.starts_at;
  const endsAt = event?.endsAt || event?.ends_at;
  const startsLabel = presentTournamentMoment(startsAt);
  const endsLabel = presentTournamentMoment(endsAt);
  const dateLabel = presentTournamentDateLabel(startsAt || endsAt);
  const participantCount = Number(event?.participantCount ?? event?.participant_count);
  const stage = String(event?.bracketStage || event?.bracket_stage || "").trim();
  const id = String(event?.id || "").trim();
  const cap = Number(event?.cap ?? event?.participant_count ?? participantCount);
  const dateTimeLabel = presentTournamentDateTimeLabel(startsAt || endsAt);
  const preview = presentTournamentEntrantPreview(event);
  const champion = presentTournamentChampion(event);
  const liveBattleCount = presentAuthoritativeLiveBattleCount(event);
  const remaining = presentAuthoritativeRemaining(event);
  const progression = presentTournamentProgression({ ...event, cap: Number.isFinite(cap) ? cap : 16 });
  const primaryCta = status.key === "live" ? "View tournament" : status.key === "finished" ? "View results" : "Enter tournament";
  const bracketCta = status.key === "finished" ? "Final bracket" : "View bracket";

  return {
    id,
    href: tournamentHref(id),
    title: String(event?.title || "Tournament").trim() || "Tournament",
    summary: String(event?.summary || "").trim() || null,
    status,
    mode,
    chain,
    registration,
    buyIn,
    participantCount: Number.isFinite(participantCount) ? participantCount : null,
    participantLabel: Number.isFinite(participantCount) ? `${participantCount} COINS` : null,
    startsLabel,
    endsLabel,
    dateLabel,
    dateTimeLabel,
    scheduleLabel: status.key === "upcoming" ? (startsLabel ? `STARTS ${startsLabel}` : null) : endsLabel ? `ENDS ${endsLabel}` : null,
    bracketStage: stage || null,
    cap: Number.isFinite(cap) && cap > 0 ? cap : null,
    preview: preview.preview,
    extraEntrants: preview.extra,
    champion,
    liveBattleCount,
    remaining,
    progression,
    primaryCta,
    bracketCta,
    focused: Boolean(options.focused),
  };
}

export function presentTournamentEmpty(tab, source) {
  if (source === "empty") {
    return {
      kind: "unavailable",
      title: "TOURNAMENT DATA UNAVAILABLE",
      body: "Tournament data is not available right now.",
    };
  }
  if (tab === "live") {
    return {
      kind: "live",
      title: "NO LIVE TOURNAMENTS",
      body: "Next scheduled tournament appears here.",
    };
  }
  if (tab === "results") {
    return {
      kind: "results",
      title: "NO FINISHED TOURNAMENTS",
      body: "Completed tournaments appear here after settlement.",
    };
  }
  return {
    kind: "upcoming",
    title: "NO UPCOMING TOURNAMENTS",
    body: "Next scheduled tournament appears here.",
  };
}

export function presentTournamentStandingsEmpty() {
  return {
    title: "STANDINGS INITIALIZING",
    body: "Positions appear after settled competition.",
  };
}

export function presentTournamentBracketEmpty() {
  return {
    title: "BRACKET PENDING",
    body: "The bracket appears here after the roster locks.",
  };
}

export function presentTournamentMatchesEmpty() {
  return {
    title: "NO TOURNAMENT FIGHTS YET",
    body: "Tournament fights appear here after the bracket is deployed.",
  };
}
