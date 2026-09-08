import { isRobinhoodChainId, isSolanaChainId, nativeSymbolFor } from "./chainNative.js";

export const EVENT_SPONSORSHIP_TYPES = Object.freeze({
  NORMAL_TOURNAMENT: "normal_tournament",
  VOTE_TOURNAMENT: "vote_tournament",
  MAJOR_WAR_LEAGUE: "monthly_mwl",
  MWL_QUARTER_FINALS: "mwl_quarter_finals",
});

export const ELIGIBLE_EVENT_SPONSORSHIP_TYPES = new Set(Object.values(EVENT_SPONSORSHIP_TYPES));

export function nativeAssetForEventSponsorship(chainId) {
  const id = Number(chainId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("event sponsorship chainId is invalid");
  if (isSolanaChainId(id)) return { symbol: "SOL", decimals: 9, family: "solana" };
  if (isRobinhoodChainId(id)) return { symbol: "ETH", decimals: 18, family: "evm" };
  if (id === 56 || id === 97) return { symbol: "BNB", decimals: 18, family: "evm" };
  throw new Error(`event sponsorship chain ${id} is unsupported`);
}

function asIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function ended(value, nowMs) {
  if (!value) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time <= nowMs;
}

function canonicalStateAllowsSponsorship(state) {
  return !["cancelled", "completed", "finished"].includes(String(state || "").toLowerCase());
}

async function loadRegistryEvent(db, eventRef, chainId = null) {
  const ref = String(eventRef || "").trim();
  if (!ref) return null;
  const params = [ref];
  let chainFilter = "";
  if (chainId != null && chainId !== "") {
    const parsed = Number(chainId);
    if (!Number.isInteger(parsed) || parsed <= 0) return null;
    params.push(parsed);
    chainFilter = `and chain_id = $${params.length}`;
  }
  const result = await db.query(
    `select id, event_type, event_reference_id, chain_id, starts_at, ends_at, sponsorship_open,
            prize_native_raw, sponsorship_prize_native_raw, created_at, updated_at
       from public.sponsorship_events
      where (id::text = $1 or event_reference_id = $1)
        ${chainFilter}
      order by created_at desc
      limit 1`,
    params,
  );
  return result.rows?.[0] || null;
}

async function resolveTournament(db, event) {
  const result = await db.query(
    `select id, chain_id, status, origin, starts_at, ends_at, battle_mode,
            competition_generation, contest_scoring_version
       from public.arena_tournaments
      where id = $1 and chain_id = $2
      limit 1`,
    [String(event.event_reference_id), Number(event.chain_id)],
  );
  return result.rows?.[0] || null;
}

async function resolveLeague(db, event) {
  const result = await db.query(
    `select id, chain_id, state, active, reset_at, frozen_at, quarter_finals_tournament_id, created_at, updated_at
       from public.arena_league_seasons
      where id::text = $1 and chain_id = $2
      limit 1`,
    [String(event.event_reference_id), Number(event.chain_id)],
  );
  return result.rows?.[0] || null;
}

async function resolveQuarterFinals(db, event) {
  const result = await db.query(
    `select t.id as tournament_id, t.chain_id, t.status, t.origin, t.starts_at, t.ends_at, t.battle_mode,
            t.competition_generation, t.contest_scoring_version,
            s.id as league_id, s.state as league_state, s.active as league_active,
            s.quarter_finals_tournament_id
       from public.arena_tournaments t
       join public.arena_league_seasons s
         on s.chain_id = t.chain_id
        and s.quarter_finals_tournament_id = t.id
      where t.id = $1
        and t.chain_id = $2
        and t.origin = 'quarter_finals'
      limit 1`,
    [String(event.event_reference_id), Number(event.chain_id)],
  );
  return result.rows?.[0] || null;
}

function resolvedBase(event, canonical, nowMs) {
  const chainId = Number(event.chain_id);
  const nativeAsset = nativeAssetForEventSponsorship(chainId);
  const startsAt = asIso(canonical?.starts_at || event.starts_at);
  const endsAt = asIso(canonical?.ends_at || event.ends_at);
  const canonicalState = String(canonical?.status || canonical?.state || "unknown");
  const sponsorability = Boolean(event.sponsorship_open) && canonicalStateAllowsSponsorship(canonicalState) && !ended(endsAt, nowMs);
  return {
    eventId: String(event.id),
    eventReferenceId: String(event.event_reference_id),
    eventType: String(event.event_type),
    chainId,
    nativeAsset,
    startsAt,
    endsAt,
    canonicalState,
    sponsorshipOpen: Boolean(event.sponsorship_open),
    sponsorable: sponsorability,
    sponsorabilityReason: sponsorability ? null : !event.sponsorship_open ? "registry_closed" : ended(endsAt, nowMs) ? "event_ended" : "canonical_event_closed",
  };
}

export async function resolveSponsorableEvent(db, { eventRef, chainId = null, nowMs = Date.now() } = {}) {
  if (!db || typeof db.query !== "function") throw new Error("event sponsorship resolver requires a database client");
  const event = await loadRegistryEvent(db, eventRef, chainId);
  if (!event) return { ok: false, code: "EVENT_NOT_FOUND", sponsorable: false };
  if (!ELIGIBLE_EVENT_SPONSORSHIP_TYPES.has(String(event.event_type))) {
    return { ok: false, code: "EVENT_CLASS_INELIGIBLE", sponsorable: false, eventId: String(event.id), eventType: String(event.event_type), chainId: Number(event.chain_id) };
  }

  if (String(event.event_type) === EVENT_SPONSORSHIP_TYPES.MAJOR_WAR_LEAGUE) {
    const league = await resolveLeague(db, event);
    if (!league) return { ok: false, code: "CANONICAL_MWL_NOT_FOUND", sponsorable: false, eventId: String(event.id), eventType: String(event.event_type), chainId: Number(event.chain_id) };
    const base = resolvedBase(event, league, nowMs);
    return { ok: true, ...base, canonical: { kind: "major_war_league", parentEventId: String(league.id), childEventId: null } };
  }

  if (String(event.event_type) === EVENT_SPONSORSHIP_TYPES.MWL_QUARTER_FINALS) {
    const qf = await resolveQuarterFinals(db, event);
    if (!qf) return { ok: false, code: "MWL_QUARTER_FINALS_RELATIONSHIP_INVALID", sponsorable: false, eventId: String(event.id), eventType: String(event.event_type), chainId: Number(event.chain_id) };
    const base = resolvedBase(event, { ...qf, state: qf.status }, nowMs);
    return {
      ok: true,
      ...base,
      canonical: {
        kind: "mwl_quarter_finals",
        parentEventId: String(qf.league_id),
        childEventId: String(qf.tournament_id),
        relationship: "arena_league_seasons.quarter_finals_tournament_id=arena_tournaments.id",
      },
    };
  }

  const tournament = await resolveTournament(db, event);
  if (!tournament) return { ok: false, code: "CANONICAL_TOURNAMENT_NOT_FOUND", sponsorable: false, eventId: String(event.id), eventType: String(event.event_type), chainId: Number(event.chain_id) };
  if (String(tournament.origin || "") === "quarter_finals") {
    return { ok: false, code: "MWL_QUARTER_FINALS_REQUIRES_CANONICAL_RELATIONSHIP", sponsorable: false, eventId: String(event.id), eventType: String(event.event_type), chainId: Number(event.chain_id) };
  }
  const battleMode = String(tournament.battle_mode || "normal").toLowerCase();
  const expectedVote = String(event.event_type) === EVENT_SPONSORSHIP_TYPES.VOTE_TOURNAMENT;
  if (expectedVote !== (battleMode === "vote")) {
    return { ok: false, code: "TOURNAMENT_MODE_MISMATCH", sponsorable: false, eventId: String(event.id), eventType: String(event.event_type), chainId: Number(event.chain_id) };
  }
  const base = resolvedBase(event, tournament, nowMs);
  return {
    ok: true,
    ...base,
    canonical: {
      kind: expectedVote ? "vote_tournament" : "normal_tournament",
      parentEventId: null,
      childEventId: String(tournament.id),
      battleMode,
    },
  };
}

export async function resolveEventFromQuote(db, quoteId, nowMs = Date.now()) {
  const id = String(quoteId || "").trim();
  if (!id) return { ok: false, code: "QUOTE_ID_REQUIRED", sponsorable: false };
  const quote = (await db.query(
    `select id, event_id, chain_id, sponsor_wallet, requested_native_raw, expires_at
       from public.sponsorship_payment_quotes
      where id = $1
      limit 1`,
    [id],
  )).rows?.[0];
  if (!quote) return { ok: false, code: "QUOTE_NOT_FOUND", sponsorable: false };
  const resolved = await resolveSponsorableEvent(db, { eventRef: quote.event_id, chainId: quote.chain_id, nowMs });
  return { ...resolved, quote };
}

export function assertEventSponsorshipQuoteUsable(resolution, nowMs = Date.now()) {
  if (!resolution?.ok) throw new Error(resolution?.code || "EVENT_SPONSORSHIP_EVENT_INVALID");
  if (!resolution.sponsorable) throw new Error(resolution.sponsorabilityReason || "EVENT_SPONSORSHIP_CLOSED");
  if (resolution.quote?.expires_at && new Date(resolution.quote.expires_at).getTime() <= nowMs) throw new Error("EVENT_SPONSORSHIP_QUOTE_EXPIRED");
  return resolution;
}

export function publicSponsorActive({ sponsorshipStatus, paymentStatus } = {}) {
  return String(sponsorshipStatus) === "active" && String(paymentStatus) === "confirmed";
}

export function deterministicFoundingSponsorOrder(rows = []) {
  return [...rows].sort((a, b) => {
    const at = new Date(a.confirmed_at || 0).getTime();
    const bt = new Date(b.confirmed_at || 0).getTime();
    if (at !== bt) return at - bt;
    const blockA = BigInt(String(a.block_number ?? 0));
    const blockB = BigInt(String(b.block_number ?? 0));
    if (blockA !== blockB) return blockA < blockB ? -1 : 1;
    const proofA = String(a.payment_identity || a.signature_reference || a.tx_hash || "");
    const proofB = String(b.payment_identity || b.signature_reference || b.tx_hash || "");
    const proofCmp = proofA.localeCompare(proofB);
    if (proofCmp) return proofCmp;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });
}

export function tierMinimumColumnForEventType(eventType) {
  const type = String(eventType || "");
  if (type === EVENT_SPONSORSHIP_TYPES.NORMAL_TOURNAMENT || type === EVENT_SPONSORSHIP_TYPES.VOTE_TOURNAMENT || type === EVENT_SPONSORSHIP_TYPES.MWL_QUARTER_FINALS) return "tournament_min_usd_cents";
  if (type === EVENT_SPONSORSHIP_TYPES.MAJOR_WAR_LEAGUE) return "mwl_min_usd_cents";
  throw new Error("Unsupported sponsorship event type");
}

export function eventSponsorshipContractSummary() {
  return {
    eligibleEventTypes: [...ELIGIBLE_EVENT_SPONSORSHIP_TYPES],
    explicitlyIneligible: ["battle", "quarterly_championship", "unknown", "legacy"],
    allocationBps: { prize: 7000, marketing: 2000, protocol: 1000 },
    nativeAssets: { bnb: "BNB", solana: "SOL", robinhood: "ETH" },
    advertisingSystem: "separate:sponsorship_applications",
  };
}
