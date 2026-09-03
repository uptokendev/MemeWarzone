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
    scheduleLabel: status.key === "upcoming" ? (startsLabel ? `STARTS ${startsLabel}` : null) : endsLabel ? `ENDS ${endsLabel}` : null,
    bracketStage: stage || null,
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
