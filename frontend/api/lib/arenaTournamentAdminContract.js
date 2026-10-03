import { randomBytes } from "crypto";

import { pool } from "../../server/db.js";
import { isAddress, isSolanaAddress, json, readJson } from "../../server/http.js";
import { requireAdminOrOps } from "./apiAuth.js";
import { isSolanaChainId, nativeSymbolFor } from "./chainNative.js";
import { optionalChainId } from "./arenaTournamentChainIdentity.js";
import {
  isVoteTournamentRoundHours,
  VOTE_TOURNAMENT_MAX_ROUND_HOURS,
  VOTE_TOURNAMENT_MIN_ROUND_HOURS,
} from "./arenaTournamentVoteRuntime.mjs";

const REGISTRATION_MODES = new Set(["open", "invite_only", "invite_plus_open"]);
const REGISTRATION_STATES = new Set(["pending", "open", "closed"]);
const START_MODES = new Set(["manual", "scheduled"]);
const ENVIRONMENTS = new Set(["staging", "production"]);
const MAX_INVITES_PER_REQUEST = 256;

// Scoring path and competition generation are fixed by the Tournament kind.
// contest_scoring_version is NOT NULL without a default (20260903_000104), so a
// create that omits it never reaches the table. Both kinds run on Arena
// competition V2: the Vote runtime (finalizer, bracket service, boosts) refuses
// anything else, and Battle Points V3 / Tournament buy-in V2 / boosts require it.
const KIND_GENERATION = Object.freeze({
  battle: Object.freeze({ contestScoringVersion: "battle_points_v3", competitionGeneration: "arena_competition_v2" }),
  vote: Object.freeze({ contestScoringVersion: "vote_tournament_v1", competitionGeneration: "arena_competition_v2" }),
});

// Vote Tournament rounds: whole hours from 1 to 48 (default 24). The vote runtime
// (match resolver, bracket service, finalizer, Final Salvo finalizer) accepts the
// same range through isVoteTournamentRoundHours.
export const VOTE_TOURNAMENT_DEFAULT_ROUND_HOURS = 24;

function text(value) {
  return String(value ?? "").trim();
}

function bodyValue(body, camel, snake = camel) {
  return body?.[camel] ?? body?.[snake];
}

function parseTimestamp(value, field, { required = false } = {}) {
  if (value == null || value === "") {
    if (required) throw new Error(`${field} is required`);
    return null;
  }
  const time = Date.parse(String(value));
  if (!Number.isFinite(time)) throw new Error(`${field} must be a valid timestamp`);
  return new Date(time).toISOString();
}

export function isSafePowerOfTwo(value) {
  if (!Number.isSafeInteger(value) || value < 1) return false;
  let n = value;
  while (n > 1) {
    if (n % 2 !== 0) return false;
    n /= 2;
  }
  return true;
}

function parseExactBracketCap(value) {
  const cap = Number(value);
  if (!Number.isSafeInteger(cap) || cap < 4 || !isSafePowerOfTwo(cap)) {
    throw new Error("cap must be an exact power of two of at least 4");
  }
  return cap;
}

function normalizeTournamentKind(body) {
  const raw = text(bodyValue(body, "kind", "tournament_type") ?? body?.battleMode ?? body?.battle_mode).toLowerCase();
  if (raw === "battle" || raw === "normal") return { tournamentType: "battle", battleMode: "normal" };
  if (raw === "vote") return { tournamentType: "vote", battleMode: "vote" };
  throw new Error("kind/tournament_type must be battle or vote");
}

export function tournamentGenerationForKind(kind) {
  const generation = KIND_GENERATION[kind];
  if (!generation) throw new Error("kind/tournament_type must be battle or vote");
  return generation;
}

export function normalizeRoundDuration(kind, value) {
  if (value == null || value === "") {
    if (kind === "vote") return VOTE_TOURNAMENT_DEFAULT_ROUND_HOURS;
    throw new Error("Battle Tournament round duration must be exactly 12 or 24 hours");
  }
  const hours = Number(value);
  if (kind === "battle") {
    if (hours !== 12 && hours !== 24) throw new Error("Battle Tournament round duration must be exactly 12 or 24 hours");
    return hours;
  }
  if (!isVoteTournamentRoundHours(hours)) {
    throw new Error(`Vote Tournament round duration must be a whole number of hours from ${VOTE_TOURNAMENT_MIN_ROUND_HOURS} to ${VOTE_TOURNAMENT_MAX_ROUND_HOURS}`);
  }
  return hours;
}

/**
 * A coin or wallet address in the Tournament chain's own format. EVM addresses
 * are stored lowercased, the same form public opt-in stores entries in
 * (normalizeWalletFlexible), so the (tournament_id, token_address) unique key
 * cannot hold two case variants of one coin. Solana base58 is case-sensitive and
 * is kept exactly.
 */
export function normalizeTournamentAddress(chainId, value, field) {
  const raw = text(value);
  if (isSolanaChainId(chainId)) {
    if (!isSolanaAddress(raw)) throw new Error(`${field} must be a Solana base58 address`);
    return raw;
  }
  if (!isAddress(raw)) throw new Error(`${field} must be a 0x-prefixed 40-hex EVM address`);
  return raw.toLowerCase();
}

export function normalizeInviteList(chainId, list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error("invites must be an array of { tokenAddress, ownerWallet? }");
  if (list.length > MAX_INVITES_PER_REQUEST) throw new Error(`At most ${MAX_INVITES_PER_REQUEST} invites per request`);
  const byToken = new Map();
  for (const item of list) {
    const isString = typeof item === "string";
    const tokenAddress = normalizeTournamentAddress(chainId, isString ? item : item?.tokenAddress ?? item?.token_address, "Invite token address");
    const ownerRaw = isString ? "" : text(item?.ownerWallet ?? item?.owner_wallet);
    const ownerWallet = ownerRaw ? normalizeTournamentAddress(chainId, ownerRaw, "Invite owner wallet") : null;
    if (!byToken.has(tokenAddress)) byToken.set(tokenAddress, { tokenAddress, ownerWallet });
  }
  return [...byToken.values()];
}

function tokenMatchSql(chainId, column, param) {
  return isSolanaChainId(chainId) ? `${column} = ${param}` : `lower(${column}) = lower(${param})`;
}

/**
 * Upsert invites inside the caller's transaction. A re-invite of a declined or
 * expired coin goes back to pending; an accepted invite keeps its status. Legacy
 * rows written before addresses were normalized are matched case-insensitively
 * on EVM so they are updated instead of duplicated.
 */
async function upsertInvites(db, tournamentId, chainId, invites) {
  for (const invite of invites) {
    const updated = await db.query(
      `update public.arena_tournament_invites
          set owner_wallet = coalesce($3, owner_wallet),
              status = case when status in ('declined', 'expired') then 'pending' else status end,
              updated_at = now()
        where tournament_id = $1 and ${tokenMatchSql(chainId, "token_address", "$2")}
        returning id`,
      [tournamentId, invite.tokenAddress, invite.ownerWallet],
    );
    if (updated.rows[0]) continue;
    await db.query(
      `insert into public.arena_tournament_invites (tournament_id, token_address, owner_wallet)
       values ($1,$2,$3)
       on conflict (tournament_id, token_address) do nothing`,
      [tournamentId, invite.tokenAddress, invite.ownerWallet],
    );
  }
}

async function listAdminInvites(db, tournamentId) {
  const result = await db.query(
    `select token_address, owner_wallet, status, created_at, updated_at
       from public.arena_tournament_invites
      where tournament_id = $1
      order by created_at asc, token_address asc`,
    [tournamentId],
  );
  return result.rows.map((row) => ({
    tokenAddress: String(row.token_address),
    ownerWallet: row.owner_wallet || null,
    status: String(row.status || "pending"),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  }));
}

export function normalizeEnvironment(chainId, body) {
  const explicit = text(bodyValue(body, "environment", "runtime_environment")).toLowerCase();
  if (!ENVIRONMENTS.has(explicit)) throw new Error("environment must be staging or production");
  if (chainId === 97 && explicit !== "staging") throw new Error("BNB chain 97 requires staging environment");
  if (chainId === 56 && explicit !== "production") throw new Error("BNB chain 56 requires production environment");
  if (chainId === 46630 && explicit !== "staging") throw new Error("Robinhood chain 46630 requires staging environment");
  if (chainId === 4663 && explicit !== "production") throw new Error("Robinhood chain 4663 requires production environment");
  if (chainId === 101) {
    const supplied = text(bodyValue(body, "solanaCluster", "solana_cluster") ?? body?.cluster).toLowerCase();
    const expected = explicit === "staging" ? "devnet" : "mainnet-beta";
    const cluster = supplied || expected;
    if (cluster !== expected) throw new Error(`Solana ${explicit} requires ${expected}`);
    return { environment: explicit, solanaCluster: expected };
  }
  if (![56, 97, 4663, 46630].includes(chainId)) throw new Error("Unsupported Tournament chain/environment");
  return { environment: explicit, solanaCluster: null };
}

function normalizeBuyIn(value) {
  const buyIn = Number(value ?? 0);
  if (!Number.isFinite(buyIn) || buyIn < 0) throw new Error("buyInNative must be a non-negative native-asset amount");
  return buyIn;
}

function expectedVersion(body) {
  const raw = bodyValue(body, "expectedStateVersion", "expected_state_version");
  if (raw == null || raw === "") return null;
  const version = Number(raw);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("expectedStateVersion must be a positive integer when supplied");
  return version;
}

export async function requireTournamentAdminAuth(req, res, routeLabel) {
  const auth = await requireAdminOrOps(req, res, { routeLabel, allowOps: true });
  if (!auth) return null;
  // Tournament administration is never anonymous, including environments where
  // the shared helper may otherwise permit a disabled-enforcement fallback.
  if (!["admin", "ops-key"].includes(String(auth.mode || "").toLowerCase()) || auth.anonymous === true) {
    json(res, 401, { ok: false, error: "Tournament admin authentication is required", code: "ADMIN_AUTH_REQUIRED" });
    return null;
  }
  return auth;
}

async function countEntries(db, id) {
  const result = await db.query("select count(*)::int as count from public.arena_tournament_entries where tournament_id = $1", [id]);
  return Number(result.rows[0]?.count || 0);
}

function adminItem(row, participantCount = 0) {
  return {
    id: String(row.id),
    type: "tournament",
    title: String(row.name || ""),
    name: String(row.name || ""),
    status: String(row.status || "upcoming"),
    chainId: Number(row.chain_id),
    chain_id: Number(row.chain_id),
    environment: row.environment || null,
    runtime_environment: row.environment || null,
    solana_cluster: row.solana_cluster || null,
    kind: row.tournament_type === "vote" || row.battle_mode === "vote" ? "vote" : row.tournament_type === "battle" || row.battle_mode === "normal" ? "battle" : "unknown",
    tournament_type: row.tournament_type || null,
    battle_mode: row.battle_mode || null,
    origin: row.origin || null,
    contestScoringVersion: row.contest_scoring_version || null,
    contest_scoring_version: row.contest_scoring_version || null,
    competitionGeneration: row.competition_generation || null,
    competition_generation: row.competition_generation || null,
    adminContractVersion: row.admin_contract_version == null ? null : Number(row.admin_contract_version),
    participantCount,
    cap: Number(row.cap || 0),
    buyInNative: Number(row.buy_in_native || 0),
    buy_in_native: Number(row.buy_in_native || 0),
    nativeSymbol: String(row.native_symbol || nativeSymbolFor(row.chain_id)),
    native_symbol: String(row.native_symbol || nativeSymbolFor(row.chain_id)),
    registrationMode: String(row.registration_mode || "open"),
    registration_mode: String(row.registration_mode || "open"),
    registrationState: String(row.registration_state || "pending"),
    registration_state: String(row.registration_state || "pending"),
    registrationOpensAt: row.registration_opens_at || null,
    registration_opens_at: row.registration_opens_at || null,
    registrationClosesAt: row.registration_closes_at || null,
    registration_closes_at: row.registration_closes_at || null,
    startMode: row.start_mode || null,
    start_mode: row.start_mode || null,
    startsAt: row.starts_at || null,
    starts_at: row.starts_at || null,
    endsAt: row.ends_at || null,
    ends_at: row.ends_at || null,
    roundDurationHours: row.round_duration_hours == null ? null : Number(row.round_duration_hours),
    round_duration_hours: row.round_duration_hours == null ? null : Number(row.round_duration_hours),
    terms: String(row.terms || ""),
    sponsorReference: row.sponsor_reference || null,
    sponsor_reference: row.sponsor_reference || null,
    stateVersion: row.state_version == null ? null : Number(row.state_version),
    state_version: row.state_version == null ? null : Number(row.state_version),
    bracket: row.bracket || [],
    createdBy: row.created_by || null,
    createdAt: row.created_at || null,
    inviteCount: Array.isArray(row.invite_wallets) ? row.invite_wallets.length : 0,
  };
}

async function readAdminBody(req, res) {
  try {
    return { ok: true, body: await readJson(req) };
  } catch (error) {
    json(res, 400, { ok: false, error: String(error?.message || error), code: "INVALID_REQUEST" });
    return { ok: false, body: null };
  }
}

export async function handleTournamentAdminList(req, res) {
  const admin = await requireTournamentAdminAuth(req, res, "admin/arena/tournaments/list");
  if (!admin) return true;
  let chainId = null;
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.searchParams.has("chainId")) chainId = optionalChainId(url.searchParams.get("chainId"));
  } catch {
    return json(res, 400, { ok: false, error: "Invalid Arena chain id", code: "INVALID_CHAIN" }), true;
  }
  const params = [];
  const where = chainId == null ? "" : " where chain_id = $1";
  if (chainId != null) params.push(chainId);
  const result = await pool.query(`select * from public.arena_tournaments${where} order by created_at desc`, params);
  const items = [];
  for (const row of result.rows) items.push(adminItem(row, await countEntries(pool, row.id)));
  json(res, 200, { items, updatedAt: new Date().toISOString() });
  return true;
}

export async function handleTournamentAdminCreate(req, res) {
  const admin = await requireTournamentAdminAuth(req, res, "admin/arena/tournaments/create");
  if (!admin) return true;
  const parsed = await readAdminBody(req, res);
  if (!parsed.ok) return true;
  const body = parsed.body;
  let values;
  let invites;
  let id;
  try {
    const name = text(body.name);
    if (!name) throw new Error("name is required");
    const chainId = optionalChainId(body.chainId ?? body.chain_id);
    if (chainId == null) throw new Error("chainId is required");
    const env = normalizeEnvironment(chainId, body);
    const kind = normalizeTournamentKind(body);
    const generation = tournamentGenerationForKind(kind.tournamentType);
    const cap = parseExactBracketCap(body.cap);
    const registrationMode = text(bodyValue(body, "registrationMode", "registration_mode") || "open");
    if (!REGISTRATION_MODES.has(registrationMode)) throw new Error("Invalid registrationMode");
    const registrationOpensAt = parseTimestamp(bodyValue(body, "registrationOpensAt", "registration_opens_at"), "registrationOpensAt", { required: true });
    const registrationClosesAt = parseTimestamp(bodyValue(body, "registrationClosesAt", "registration_closes_at"), "registrationClosesAt", { required: true });
    if (Date.parse(registrationClosesAt) <= Date.parse(registrationOpensAt)) throw new Error("registrationClosesAt must be after registrationOpensAt");
    const startMode = text(bodyValue(body, "startMode", "start_mode") || "scheduled");
    if (!START_MODES.has(startMode)) throw new Error("startMode must be manual or scheduled");
    const startsAt = parseTimestamp(bodyValue(body, "startsAt", "starts_at"), "startsAt", { required: true });
    if (startMode === "scheduled" && Date.parse(startsAt) < Date.parse(registrationClosesAt)) throw new Error("Scheduled start must be at or after registration closes");
    const roundDurationHours = normalizeRoundDuration(kind.tournamentType, bodyValue(body, "roundDurationHours", "round_duration_hours"));
    const buyInNative = normalizeBuyIn(bodyValue(body, "buyInNative", "buy_in_native"));
    const sponsorReference = text(bodyValue(body, "sponsorReference", "sponsor_reference")) || null;
    invites = normalizeInviteList(chainId, body.invites);
    const registrationState = Date.now() >= Date.parse(registrationOpensAt) && Date.now() < Date.parse(registrationClosesAt) ? "open" : "pending";
    id = `tourney-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    values = [id, chainId, name, registrationMode, registrationState, registrationOpensAt, registrationClosesAt,
      startMode, buyInNative, nativeSymbolFor(chainId), text(body.terms), startsAt, cap,
      String(admin.mode || "admin"), kind.battleMode, kind.tournamentType, env.environment, env.solanaCluster,
      roundDurationHours, sponsorReference, JSON.stringify(Array.isArray(body.inviteWallets) ? body.inviteWallets.map(text).filter(Boolean) : []),
      generation.contestScoringVersion, generation.competitionGeneration];
  } catch (error) {
    json(res, 400, { ok: false, error: String(error?.message || error), code: "INVALID_TOURNAMENT_CONTRACT" });
    return true;
  }
  // Tournament and its invites commit together: an invalid invite never leaves
  // a half-configured invite-only tournament behind.
  const client = await pool.connect();
  try {
    await client.query("begin");
    const inserted = await client.query(
      `insert into public.arena_tournaments (
         id, chain_id, name, status, origin, registration_mode, registration_state,
         registration_opens_at, registration_closes_at, start_mode, buy_in_native,
         native_symbol, terms, starts_at, cap, created_by, battle_mode,
         tournament_type, environment, solana_cluster, round_duration_hours,
         sponsor_reference, state_version, exact_bracket_required, admin_contract_version, invite_wallets,
         contest_scoring_version, competition_generation
     ) values ($1,$2,$3,'upcoming','custom',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,1,true,1,$21::jsonb,$22,$23)
       returning *`,
      values,
    );
    await upsertInvites(client, id, Number(inserted.rows[0].chain_id), invites);
    await client.query("commit");
    json(res, 201, { ok: true, tournament: adminItem(inserted.rows[0], 0), invites: await listAdminInvites(pool, id) });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    const constraint = String(error?.code || "").startsWith("23");
    json(res, constraint ? 400 : 503, {
      ok: false,
      error: constraint ? "Tournament violates a storage constraint" : "Tournament storage is unavailable",
      code: constraint ? "INVALID_TOURNAMENT_CONTRACT" : "TOURNAMENT_STORAGE_UNAVAILABLE",
      detail: String(error?.message || error),
    });
  } finally {
    client.release();
  }
  return true;
}

async function lockedMutation(req, res, id, routeLabel, mutate) {
  const admin = await requireTournamentAdminAuth(req, res, routeLabel);
  if (!admin) return true;
  const parsed = await readAdminBody(req, res);
  if (!parsed.ok) return true;
  const body = parsed.body;
  let chainId = null;
  let version = null;
  try {
    const rawChain = body.chainId ?? body.chain_id;
    if (rawChain != null && rawChain !== "") chainId = optionalChainId(rawChain);
    version = expectedVersion(body);
  } catch (error) {
    json(res, 400, { ok: false, error: String(error?.message || error), code: "INVALID_TOURNAMENT_MUTATION" });
    return true;
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const found = chainId == null
      ? await client.query("select * from public.arena_tournaments where id = $1 for update", [id])
      : await client.query("select * from public.arena_tournaments where id = $1 and chain_id = $2 for update", [id, chainId]);
    const row = found.rows[0];
    if (!row) {
      await client.query("rollback");
      json(res, 404, { ok: false, error: "Tournament not found", code: "TOURNAMENT_CHAIN_MISMATCH" });
      return true;
    }
    if (body.expectedStatus && String(row.status) !== String(body.expectedStatus)) {
      await client.query("rollback");
      json(res, 409, { ok: false, error: "Tournament status changed", code: "TOURNAMENT_STATE_CONFLICT", status: row.status, stateVersion: row.state_version });
      return true;
    }
    if (version != null && (row.state_version == null || Number(row.state_version) !== version)) {
      await client.query("rollback");
      json(res, 409, { ok: false, error: "Tournament was modified by another admin", code: "TOURNAMENT_STATE_CONFLICT", stateVersion: row.state_version });
      return true;
    }
    chainId = Number(row.chain_id);
    version = Number(row.state_version);
    const next = await mutate({ client, row, body, admin, chainId });
    if (!next?.ok) {
      await client.query("rollback");
      json(res, next?.http || 409, { ok: false, error: next?.error || "Tournament mutation rejected", code: next?.code || "TOURNAMENT_STATE_INVALID" });
      return true;
    }
    const update = await client.query(
      `update public.arena_tournaments
          set name = $3, registration_mode = $4, registration_state = $5,
              registration_opens_at = $6, registration_closes_at = $7, start_mode = $8,
              starts_at = $9, cap = $10, terms = $11, sponsor_reference = $12,
              battle_mode = $13, tournament_type = $14, round_duration_hours = $15,
              status = $16, buy_in_native = $17, environment = $18, solana_cluster = $19,
              contest_scoring_version = $21, competition_generation = $22,
              state_version = state_version + 1, updated_at = now()
        where id = $1 and chain_id = $2 and state_version = $20
        returning *`,
      [id, chainId, next.name ?? row.name, next.registrationMode ?? row.registration_mode,
       next.registrationState ?? row.registration_state, next.registrationOpensAt ?? row.registration_opens_at,
       next.registrationClosesAt ?? row.registration_closes_at, next.startMode ?? row.start_mode,
       next.startsAt ?? row.starts_at, next.cap ?? row.cap, next.terms ?? row.terms,
       next.sponsorReference !== undefined ? next.sponsorReference : row.sponsor_reference,
       next.battleMode ?? row.battle_mode, next.tournamentType ?? row.tournament_type,
       next.roundDurationHours ?? row.round_duration_hours, next.status ?? row.status,
       next.buyInNative === undefined ? row.buy_in_native : next.buyInNative,
       next.environment ?? row.environment,
       next.solanaCluster === undefined ? row.solana_cluster : next.solanaCluster,
       version,
       next.contestScoringVersion ?? row.contest_scoring_version,
       next.competitionGeneration ?? row.competition_generation],
    );
    if (!update.rows[0]) {
      await client.query("rollback");
      json(res, 409, { ok: false, error: "Tournament state changed concurrently", code: "TOURNAMENT_STATE_CONFLICT" });
      return true;
    }
    await client.query("commit");
    try {
      const { notifyTournamentEvent, tournamentNotificationForTransition } = await import("./arenaLifecycleNotifications.js");
      const eventType = tournamentNotificationForTransition(row, update.rows[0]);
      if (eventType) await notifyTournamentEvent(pool, update.rows[0], eventType);
    } catch (error) {
      console.warn("[arena-tournament-admin] notify failed", error?.message || error);
    }
    const payload = { ok: true, tournament: adminItem(update.rows[0], await countEntries(pool, id)) };
    if (next.includeInvites) payload.invites = await listAdminInvites(pool, id);
    json(res, 200, payload);
    return true;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    json(res, 503, { ok: false, error: "Tournament storage is unavailable", detail: String(error?.message || error) });
    return true;
  } finally {
    client.release();
  }
}

/**
 * Chain, environment and Solana cluster are the Tournament's identity: they pick
 * the buy-in treasury, the market data and which deployment serves it. They are
 * set once at create. An edit may restate them, or fill a legacy row that never
 * stored them, but may never switch them.
 */
export function lockedTournamentIdentity(row, body) {
  const chainId = Number(row.chain_id);
  const storedEnvironment = text(row.environment).toLowerCase();
  const storedCluster = text(row.solana_cluster).toLowerCase();
  const suppliedEnvironment = text(bodyValue(body, "environment", "runtime_environment")).toLowerCase();
  const suppliedCluster = text(bodyValue(body, "solanaCluster", "solana_cluster") ?? body?.cluster).toLowerCase();
  if (storedEnvironment && suppliedEnvironment && suppliedEnvironment !== storedEnvironment) {
    throw new Error(`Tournament environment is locked to ${storedEnvironment}; create a new tournament for ${suppliedEnvironment}`);
  }
  if (storedCluster && suppliedCluster && suppliedCluster !== storedCluster) {
    throw new Error(`Solana cluster is locked to ${storedCluster}; create a new tournament for ${suppliedCluster}`);
  }
  return normalizeEnvironment(chainId, {
    environment: storedEnvironment || suppliedEnvironment,
    solanaCluster: storedCluster || suppliedCluster,
  });
}

export function handleTournamentAdminEdit(req, res, id) {
  return lockedMutation(req, res, id, "admin/arena/tournaments/edit", async ({ client, row, body }) => {
    if (row.status !== "upcoming") return { ok: false, code: "TOURNAMENT_NOT_UPCOMING", error: "Only upcoming tournaments can be edited" };
    try {
      const identity = lockedTournamentIdentity(row, body);
      const kind = normalizeTournamentKind({ kind: bodyValue(body, "kind", "tournament_type") ?? row.tournament_type ?? row.battle_mode });
      const generation = tournamentGenerationForKind(kind.tournamentType);
      const cap = body.cap == null ? Number(row.cap) : parseExactBracketCap(body.cap);
      const kindChanged = kind.tournamentType !== (row.tournament_type || (row.battle_mode === "vote" ? "vote" : "battle"));
      const suppliedDuration = bodyValue(body, "roundDurationHours", "round_duration_hours");
      // Switching kind without a new duration takes that kind's default (24h).
      const duration = normalizeRoundDuration(kind.tournamentType, suppliedDuration ?? (kindChanged ? 24 : row.round_duration_hours));
      const registrationMode = text(bodyValue(body, "registrationMode", "registration_mode") ?? row.registration_mode);
      if (!REGISTRATION_MODES.has(registrationMode)) throw new Error("Invalid registrationMode");
      const opens = parseTimestamp(bodyValue(body, "registrationOpensAt", "registration_opens_at") ?? row.registration_opens_at, "registrationOpensAt", { required: true });
      const closes = parseTimestamp(bodyValue(body, "registrationClosesAt", "registration_closes_at") ?? row.registration_closes_at, "registrationClosesAt", { required: true });
      if (Date.parse(closes) <= Date.parse(opens)) throw new Error("registrationClosesAt must be after registrationOpensAt");
      const startMode = text(bodyValue(body, "startMode", "start_mode") ?? row.start_mode);
      if (!START_MODES.has(startMode)) throw new Error("Invalid startMode");
      const startsAt = parseTimestamp(bodyValue(body, "startsAt", "starts_at") ?? row.starts_at, "startsAt", { required: true });
      if (startMode === "scheduled" && Date.parse(startsAt) < Date.parse(closes)) throw new Error("Scheduled start must be at or after registration closes");
      const buyInNative = bodyValue(body, "buyInNative", "buy_in_native") == null
        ? Number(row.buy_in_native || 0)
        : normalizeBuyIn(bodyValue(body, "buyInNative", "buy_in_native"));
      const enrolled = await countEntries(client, id);
      if (cap < enrolled) {
        return { ok: false, http: 409, code: "TOURNAMENT_CAP_BELOW_ENTRANTS", error: `Bracket size ${cap} is below the ${enrolled} coins already registered` };
      }
      // An entrant registered (and may have paid) against the stored buy-in. The
      // price cannot move under them; remove unpaid entrants or cancel first.
      if (enrolled > 0 && buyInNative !== Number(row.buy_in_native || 0)) {
        return { ok: false, http: 409, code: "TOURNAMENT_BUY_IN_LOCKED", error: "Buy-in cannot change once coins are registered" };
      }
      if (enrolled > 0 && kindChanged) {
        return { ok: false, http: 409, code: "TOURNAMENT_KIND_LOCKED", error: "Tournament type cannot change once coins are registered" };
      }
      // Admin-contract rows always carry the canonical generation for their kind.
      // A legacy row keeps whatever generation it was created on unless its kind
      // changes (which is only possible with nobody registered).
      const canonicalGeneration = Number(row.admin_contract_version) === 1 || kindChanged;
      return {
        ok: true,
        name: text(body.name ?? row.name),
        cap,
        buyInNative,
        environment: identity.environment,
        solanaCluster: identity.solanaCluster,
        roundDurationHours: duration,
        registrationMode,
        registrationOpensAt: opens,
        registrationClosesAt: closes,
        startMode,
        startsAt,
        terms: body.terms == null ? row.terms : text(body.terms),
        sponsorReference: bodyValue(body, "sponsorReference", "sponsor_reference") === undefined ? row.sponsor_reference : text(bodyValue(body, "sponsorReference", "sponsor_reference")) || null,
        battleMode: kind.battleMode,
        tournamentType: kind.tournamentType,
        contestScoringVersion: canonicalGeneration ? generation.contestScoringVersion : undefined,
        competitionGeneration: canonicalGeneration ? generation.competitionGeneration : undefined,
      };
    } catch (error) {
      return { ok: false, http: 400, code: "INVALID_TOURNAMENT_CONTRACT", error: String(error?.message || error) };
    }
  });
}

export function handleTournamentRegistrationState(req, res, id, target) {
  return lockedMutation(req, res, id, `admin/arena/tournaments/${target}-registration`, async ({ row }) => {
    if (row.status !== "upcoming") return { ok: false, code: "TOURNAMENT_NOT_UPCOMING", error: "Registration can change only while tournament is upcoming" };
    if (!REGISTRATION_STATES.has(target)) return { ok: false, code: "INVALID_REGISTRATION_STATE" };
    return { ok: true, registrationState: target };
  });
}

export function handleTournamentCancel(req, res, id) {
  return lockedMutation(req, res, id, "admin/arena/tournaments/cancel", async ({ client, row }) => {
    if (row.status !== "upcoming") return { ok: false, code: "TOURNAMENT_NOT_UPCOMING", error: "Only an upcoming tournament can be cancelled" };
    if (Number(row.buy_in_native || 0) > 0) {
      const enrolled = await countEntries(client, id);
      if (enrolled > 0) return { ok: false, code: "PAYMENT_RECONCILIATION_REQUIRED", error: "Positive-buy-in tournament has entrants; reconcile chain payments before cancellation" };
    }
    return { ok: true, status: "cancelled", registrationState: "closed" };
  });
}

/**
 * Remove one unpaid entry: tournament + token (+ owner wallet). An owner wallet
 * can register several coins in one tournament (entries are unique per token),
 * so the wallet alone never selects what to delete. Callers that do not send
 * tokenAddress still work when the wallet holds exactly one entry; with more
 * than one the request is refused instead of deleting them all.
 */
export async function handleTournamentRemoveUnpaidEntrant(req, res, id, wallet) {
  const admin = await requireTournamentAdminAuth(req, res, "admin/arena/tournaments/remove-unpaid-entrant");
  if (!admin) return true;
  let requestedToken = "";
  try {
    const url = new URL(req.url, "http://localhost");
    requestedToken = text(url.searchParams.get("tokenAddress") ?? url.searchParams.get("token_address"));
  } catch {
    requestedToken = "";
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const found = await client.query("select * from public.arena_tournaments where id = $1 for update", [id]);
    const row = found.rows[0];
    if (!row) { await client.query("rollback"); json(res, 404, { ok: false, code: "TOURNAMENT_NOT_FOUND" }); return true; }
    if (row.status !== "upcoming") { await client.query("rollback"); json(res, 409, { ok: false, code: "TOURNAMENT_NOT_UPCOMING" }); return true; }
    const chainId = Number(row.chain_id);
    const params = [id, wallet];
    let tokenClause = "";
    if (requestedToken) {
      params.push(requestedToken);
      tokenClause = ` and ${tokenMatchSql(chainId, "token_address", "$3")}`;
    }
    const entries = await client.query(
      `select * from public.arena_tournament_entries
        where tournament_id = $1 and lower(owner_wallet) = lower($2)${tokenClause}
        for update`,
      params,
    );
    if (!entries.rows[0]) { await client.query("rollback"); json(res, 404, { ok: false, code: "TOURNAMENT_ENTRY_NOT_FOUND" }); return true; }
    if (entries.rows.length > 1) {
      await client.query("rollback");
      json(res, 409, { ok: false, code: "TOURNAMENT_ENTRY_TOKEN_REQUIRED", error: "This wallet registered more than one coin; pass tokenAddress to pick the entry" });
      return true;
    }
    const entry = entries.rows[0];
    if (entry.buy_in_paid) { await client.query("rollback"); json(res, 409, { ok: false, code: "PAID_ENTRANT_IMMUTABLE", error: "Paid entrant cannot be removed" }); return true; }
    if (Number(row.buy_in_native || 0) > 0) { await client.query("rollback"); json(res, 409, { ok: false, code: "PAYMENT_RECONCILIATION_REQUIRED", error: "Positive-buy-in entrant requires authoritative chain reconciliation before removal" }); return true; }
    await client.query("delete from public.arena_tournament_entries where id = $1 and tournament_id = $2 and buy_in_paid = false", [entry.id, id]);
    const updated = await client.query("update public.arena_tournaments set state_version = state_version + 1, updated_at = now() where id = $1 and state_version = $2 returning *", [id, Number(row.state_version)]);
    if (!updated.rows[0]) { await client.query("rollback"); json(res, 409, { ok: false, code: "TOURNAMENT_STATE_CONFLICT" }); return true; }
    await client.query("commit");
    json(res, 200, { ok: true, removed: { tokenAddress: String(entry.token_address), ownerWallet: String(entry.owner_wallet) }, tournament: adminItem(updated.rows[0], await countEntries(pool, id)) });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    json(res, 503, { ok: false, error: "Tournament storage is unavailable", detail: String(error?.message || error) });
  } finally {
    client.release();
  }
  return true;
}

export async function handleTournamentInviteList(req, res, id) {
  const admin = await requireTournamentAdminAuth(req, res, "admin/arena/tournaments/invites/list");
  if (!admin) return true;
  const found = await pool.query("select * from public.arena_tournaments where id = $1", [id]);
  if (!found.rows[0]) { json(res, 404, { ok: false, code: "TOURNAMENT_NOT_FOUND" }); return true; }
  json(res, 200, { ok: true, tournament: adminItem(found.rows[0], await countEntries(pool, id)), invites: await listAdminInvites(pool, id) });
  return true;
}

/**
 * Add invited coins to an upcoming tournament. Same lock, status and
 * state-version checks as every other admin mutation: no invite changes once a
 * tournament is live, finished or cancelled.
 */
export function handleTournamentInviteAdd(req, res, id) {
  return lockedMutation(req, res, id, "admin/arena/tournaments/invites/add", async ({ client, row, body }) => {
    if (row.status !== "upcoming") return { ok: false, code: "TOURNAMENT_NOT_UPCOMING", error: "Invites can change only while the tournament is upcoming" };
    let invites;
    try {
      invites = normalizeInviteList(Number(row.chain_id), body.invites ?? (body.tokenAddress ? [body] : null));
    } catch (error) {
      return { ok: false, http: 400, code: "INVALID_TOURNAMENT_INVITE", error: String(error?.message || error) };
    }
    if (!invites.length) return { ok: false, http: 400, code: "INVALID_TOURNAMENT_INVITE", error: "At least one invite tokenAddress is required" };
    await upsertInvites(client, String(row.id), Number(row.chain_id), invites);
    return { ok: true, includeInvites: true };
  });
}

/**
 * Withdraw one invite. A coin that already registered keeps its entry; removing
 * its invite first would leave an invite-only roster with an uninvited coin, so
 * the unpaid entrant must be removed before the invite.
 */
export function handleTournamentInviteRemove(req, res, id, tokenAddress) {
  return lockedMutation(req, res, id, "admin/arena/tournaments/invites/remove", async ({ client, row }) => {
    if (row.status !== "upcoming") return { ok: false, code: "TOURNAMENT_NOT_UPCOMING", error: "Invites can change only while the tournament is upcoming" };
    const chainId = Number(row.chain_id);
    const token = text(tokenAddress);
    if (!token) return { ok: false, http: 400, code: "INVALID_TOURNAMENT_INVITE", error: "tokenAddress is required" };
    const entered = await client.query(
      `select 1 from public.arena_tournament_entries where tournament_id = $1 and ${tokenMatchSql(chainId, "token_address", "$2")} limit 1`,
      [String(row.id), token],
    );
    if (entered.rows[0]) {
      return { ok: false, http: 409, code: "TOURNAMENT_INVITE_HAS_ENTRANT", error: "This coin is already registered; remove the unpaid entrant before withdrawing its invite" };
    }
    const removed = await client.query(
      `delete from public.arena_tournament_invites where tournament_id = $1 and ${tokenMatchSql(chainId, "token_address", "$2")} returning id`,
      [String(row.id), token],
    );
    if (!removed.rows[0]) return { ok: false, http: 404, code: "TOURNAMENT_INVITE_NOT_FOUND", error: "No invite for this coin" };
    return { ok: true, includeInvites: true };
  });
}

export async function handleTournamentAdminContractRoute(req, res, { method, path }) {
  if (!(path.startsWith("/admin/arena/tournaments") || path.startsWith("/api/admin/arena/tournaments"))) return false;
  const root = /\/admin\/arena\/tournaments$/;
  if (method === "GET" && root.test(path)) return handleTournamentAdminList(req, res);
  if (method === "POST" && root.test(path)) return handleTournamentAdminCreate(req, res);
  const edit = path.match(/\/admin\/arena\/tournaments\/([^/]+)$/);
  if (edit && method === "PATCH") return handleTournamentAdminEdit(req, res, decodeURIComponent(edit[1]));
  const open = path.match(/\/admin\/arena\/tournaments\/([^/]+)\/registration\/open$/);
  if (open && method === "POST") return handleTournamentRegistrationState(req, res, decodeURIComponent(open[1]), "open");
  const close = path.match(/\/admin\/arena\/tournaments\/([^/]+)\/registration\/close$/);
  if (close && method === "POST") return handleTournamentRegistrationState(req, res, decodeURIComponent(close[1]), "closed");
  const cancel = path.match(/\/admin\/arena\/tournaments\/([^/]+)\/cancel$/);
  if (cancel && method === "POST") return handleTournamentCancel(req, res, decodeURIComponent(cancel[1]));
  const invites = path.match(/\/admin\/arena\/tournaments\/([^/]+)\/invites$/);
  if (invites && method === "GET") return handleTournamentInviteList(req, res, decodeURIComponent(invites[1]));
  if (invites && method === "POST") return handleTournamentInviteAdd(req, res, decodeURIComponent(invites[1]));
  const invite = path.match(/\/admin\/arena\/tournaments\/([^/]+)\/invites\/([^/]+)$/);
  if (invite && method === "DELETE") return handleTournamentInviteRemove(req, res, decodeURIComponent(invite[1]), decodeURIComponent(invite[2]));
  const remove = path.match(/\/admin\/arena\/tournaments\/([^/]+)\/entrants\/([^/]+)$/);
  if (remove && method === "DELETE") return handleTournamentRemoveUnpaidEntrant(req, res, decodeURIComponent(remove[1]), decodeURIComponent(remove[2]));
  return false;
}
