import { randomBytes } from "crypto";

import { pool } from "../../server/db.js";
import { json, readJson } from "../../server/http.js";
import { requireAdminOrOps } from "./apiAuth.js";
import { nativeSymbolFor } from "./chainNative.js";
import { optionalChainId } from "./arenaTournamentChainIdentity.js";

const REGISTRATION_MODES = new Set(["open", "invite_only", "invite_plus_open"]);
const REGISTRATION_STATES = new Set(["pending", "open", "closed"]);
const START_MODES = new Set(["manual", "scheduled"]);
const ENVIRONMENTS = new Set(["staging", "production"]);

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

export function normalizeRoundDuration(kind, value) {
  if (value == null || value === "") return kind === "vote" ? 24 : null;
  const hours = Number(value);
  if (kind === "battle") {
    if (hours !== 12 && hours !== 24) throw new Error("Battle Tournament round duration must be exactly 12 or 24 hours");
    return hours;
  }
  if (!Number.isInteger(hours) || hours < 1) throw new Error("Vote Tournament round duration must be an integer of at least 1 hour");
  return hours;
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
  try {
    const name = text(body.name);
    if (!name) throw new Error("name is required");
    const chainId = optionalChainId(body.chainId ?? body.chain_id);
    if (chainId == null) throw new Error("chainId is required");
    const env = normalizeEnvironment(chainId, body);
    const kind = normalizeTournamentKind(body);
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
    const registrationState = Date.now() >= Date.parse(registrationOpensAt) && Date.now() < Date.parse(registrationClosesAt) ? "open" : "pending";
    const id = `tourney-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const inserted = await pool.query(
      `insert into public.arena_tournaments (
         id, chain_id, name, status, origin, registration_mode, registration_state,
         registration_opens_at, registration_closes_at, start_mode, buy_in_native,
         native_symbol, terms, starts_at, cap, created_by, battle_mode,
         tournament_type, environment, solana_cluster, round_duration_hours,
         sponsor_reference, state_version, exact_bracket_required, admin_contract_version, invite_wallets
     ) values ($1,$2,$3,'upcoming','custom',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,1,true,1,$21::jsonb)
       returning *`,
      [id, chainId, name, registrationMode, registrationState, registrationOpensAt, registrationClosesAt,
       startMode, buyInNative, nativeSymbolFor(chainId), text(body.terms), startsAt, cap,
       String(admin.mode || "admin"), kind.battleMode, kind.tournamentType, env.environment, env.solanaCluster,
       roundDurationHours, sponsorReference, JSON.stringify(Array.isArray(body.inviteWallets) ? body.inviteWallets.map(text).filter(Boolean) : [])],
    );
    const invites = Array.isArray(body.invites) ? body.invites : [];
    for (const invite of invites) {
      const token = text(invite?.tokenAddress ?? invite);
      if (!token) continue;
      await pool.query(
        `insert into public.arena_tournament_invites (tournament_id, token_address, owner_wallet)
         values ($1,$2,$3) on conflict (tournament_id, token_address) do nothing`,
        [id, token, text(invite?.ownerWallet) || null],
      );
    }
    json(res, 201, { ok: true, tournament: adminItem(inserted.rows[0], 0) });
  } catch (error) {
    json(res, 400, { ok: false, error: String(error?.message || error), code: "INVALID_TOURNAMENT_CONTRACT" });
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
       version],
    );
    if (!update.rows[0]) {
      await client.query("rollback");
      json(res, 409, { ok: false, error: "Tournament state changed concurrently", code: "TOURNAMENT_STATE_CONFLICT" });
      return true;
    }
    await client.query("commit");
    json(res, 200, { ok: true, tournament: adminItem(update.rows[0], await countEntries(pool, id)) });
    return true;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    json(res, 503, { ok: false, error: "Tournament storage is unavailable", detail: String(error?.message || error) });
    return true;
  } finally {
    client.release();
  }
}

export function handleTournamentAdminEdit(req, res, id) {
  return lockedMutation(req, res, id, "admin/arena/tournaments/edit", async ({ row, body }) => {
    if (row.status !== "upcoming") return { ok: false, code: "TOURNAMENT_NOT_UPCOMING", error: "Only upcoming tournaments can be edited" };
    try {
      const kind = normalizeTournamentKind({ kind: bodyValue(body, "kind", "tournament_type") ?? row.tournament_type ?? row.battle_mode });
      const cap = body.cap == null ? Number(row.cap) : parseExactBracketCap(body.cap);
      const duration = normalizeRoundDuration(kind.tournamentType, bodyValue(body, "roundDurationHours", "round_duration_hours") ?? row.round_duration_hours);
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
      const identity = normalizeEnvironment(Number(row.chain_id), {
        environment: body.environment ?? row.environment,
        solanaCluster: bodyValue(body, "solanaCluster", "solana_cluster") ?? row.solana_cluster,
      });
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

export async function handleTournamentRemoveUnpaidEntrant(req, res, id, wallet) {
  const admin = await requireTournamentAdminAuth(req, res, "admin/arena/tournaments/remove-unpaid-entrant");
  if (!admin) return true;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const found = await client.query("select * from public.arena_tournaments where id = $1 for update", [id]);
    const row = found.rows[0];
    if (!row) { await client.query("rollback"); json(res, 404, { ok: false, code: "TOURNAMENT_NOT_FOUND" }); return true; }
    if (row.status !== "upcoming") { await client.query("rollback"); json(res, 409, { ok: false, code: "TOURNAMENT_NOT_UPCOMING" }); return true; }
    const entry = await client.query("select * from public.arena_tournament_entries where tournament_id = $1 and lower(owner_wallet) = lower($2) for update", [id, wallet]);
    if (!entry.rows[0]) { await client.query("rollback"); json(res, 404, { ok: false, code: "TOURNAMENT_ENTRY_NOT_FOUND" }); return true; }
    if (entry.rows[0].buy_in_paid) { await client.query("rollback"); json(res, 409, { ok: false, code: "PAID_ENTRANT_IMMUTABLE", error: "Paid entrant cannot be removed" }); return true; }
    if (Number(row.buy_in_native || 0) > 0) { await client.query("rollback"); json(res, 409, { ok: false, code: "PAYMENT_RECONCILIATION_REQUIRED", error: "Positive-buy-in entrant requires authoritative chain reconciliation before removal" }); return true; }
    await client.query("delete from public.arena_tournament_entries where tournament_id = $1 and lower(owner_wallet) = lower($2)", [id, wallet]);
    const updated = await client.query("update public.arena_tournaments set state_version = state_version + 1, updated_at = now() where id = $1 and state_version = $2 returning *", [id, Number(row.state_version)]);
    if (!updated.rows[0]) { await client.query("rollback"); json(res, 409, { ok: false, code: "TOURNAMENT_STATE_CONFLICT" }); return true; }
    await client.query("commit");
    json(res, 200, { ok: true, tournament: adminItem(updated.rows[0], await countEntries(pool, id)) });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    json(res, 503, { ok: false, error: "Tournament storage is unavailable", detail: String(error?.message || error) });
  } finally {
    client.release();
  }
  return true;
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
  const remove = path.match(/\/admin\/arena\/tournaments\/([^/]+)\/entrants\/([^/]+)$/);
  if (remove && method === "DELETE") return handleTournamentRemoveUnpaidEntrant(req, res, decodeURIComponent(remove[1]), decodeURIComponent(remove[2]));
  return false;
}
