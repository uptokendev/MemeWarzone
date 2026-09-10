from pathlib import Path
import re

helper_path = Path('frontend/api/lib/arenaTournamentAdminContract.js')
helper = helper_path.read_text()

helper = helper.replace(
'''function parseExactBracketCap(value) {
  const cap = Number(value);
  if (!Number.isSafeInteger(cap) || cap < 4 || (cap & (cap - 1)) !== 0) {
    throw new Error("cap must be an exact power of two of at least 4");
  }
  return cap;
}''',
'''function isSafePowerOfTwo(value) {
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
}''')

helper = helper.replace(
'''function expectedVersion(body) {
  const raw = bodyValue(body, "expectedStateVersion", "expected_state_version");
  const version = Number(raw);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("expectedStateVersion is required and must be a positive integer");
  return version;
}''',
'''function expectedVersion(body) {
  const raw = bodyValue(body, "expectedStateVersion", "expected_state_version");
  if (raw == null || raw === "") return null;
  const version = Number(raw);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("expectedStateVersion must be a positive integer when supplied");
  return version;
}''')

helper = helper.replace(
'  if (String(auth.mode || "").toLowerCase() === "disabled" || auth.anonymous === true) {',
'  if (!["admin", "ops-key"].includes(String(auth.mode || "").toLowerCase()) || auth.anonymous === true) {')

helper = helper.replace(
'''    createdAt: row.created_at || null,
  };''',
'''    createdAt: row.created_at || null,
    inviteCount: Array.isArray(row.invite_wallets) ? row.invite_wallets.length : 0,
  };''')

helper = helper.replace(
'''         sponsor_reference, state_version, exact_bracket_required
     ) values ($1,$2,$3,'upcoming','custom',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,1,true)''',
'''         sponsor_reference, state_version, exact_bracket_required, admin_contract_version, invite_wallets
     ) values ($1,$2,$3,'upcoming','custom',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,1,true,1,$21::jsonb)''')
helper = helper.replace(
'''       roundDurationHours, sponsorReference],''',
'''       roundDurationHours, sponsorReference, JSON.stringify(Array.isArray(body.inviteWallets) ? body.inviteWallets.map(text).filter(Boolean) : [])],''')
helper = helper.replace('json(res, 201, { ok: true, item: adminItem(inserted.rows[0], 0) });',
                        'json(res, 201, { ok: true, tournament: adminItem(inserted.rows[0], 0) });')
helper = helper.replace('json(res, 200, { ok: true, item: adminItem(update.rows[0], await countEntries(pool, id)) });',
                        'json(res, 200, { ok: true, tournament: adminItem(update.rows[0], await countEntries(pool, id)) });')
helper = helper.replace('json(res, 200, { ok: true, item: adminItem(updated.rows[0], await countEntries(pool, id)) });',
                        'json(res, 200, { ok: true, tournament: adminItem(updated.rows[0], await countEntries(pool, id)) });')

old_locked = '''  let chainId;
  let version;
  try {
    chainId = optionalChainId(body.chainId ?? body.chain_id);
    if (chainId == null) throw new Error("chainId is required");
    version = expectedVersion(body);
  } catch (error) {
    json(res, 400, { ok: false, error: String(error?.message || error), code: "INVALID_TOURNAMENT_MUTATION" });
    return true;
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const found = await client.query("select * from public.arena_tournaments where id = $1 and chain_id = $2 for update", [id, chainId]);
    const row = found.rows[0];'''
new_locked = '''  let chainId = null;
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
    const row = found.rows[0];'''
if old_locked not in helper:
    raise SystemExit('locked mutation anchor missing')
helper = helper.replace(old_locked, new_locked, 1)

old_version = '''    if (row.state_version == null || Number(row.state_version) !== version) {
      await client.query("rollback");
      json(res, 409, { ok: false, error: "Tournament was modified by another admin", code: "TOURNAMENT_STATE_CONFLICT", stateVersion: row.state_version });
      return true;
    }
    const next = await mutate({ client, row, body, admin, chainId });'''
new_version = '''    if (body.expectedStatus && String(row.status) !== String(body.expectedStatus)) {
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
    const next = await mutate({ client, row, body, admin, chainId });'''
if old_version not in helper:
    raise SystemExit('version mutation anchor missing')
helper = helper.replace(old_version, new_version, 1)

remove_pattern = re.compile(r'export async function handleTournamentRemoveUnpaidEntrant\(req, res, id, tokenAddress\) \{.*?\n\}\n\nexport async function handleTournamentAdminContractRoute', re.S)
remove_replacement = '''export async function handleTournamentRemoveUnpaidEntrant(req, res, id, wallet) {
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

export async function handleTournamentAdminContractRoute'''
helper, count = remove_pattern.subn(remove_replacement, helper, count=1)
if count != 1:
    raise SystemExit('remove entrant function anchor missing')

helper = helper.replace(r'const open = path.match(/\/admin\/arena\/tournaments\/([^/]+)\/open-registration$/);',
                        r'const open = path.match(/\/admin\/arena\/tournaments\/([^/]+)\/registration\/open$/);')
helper = helper.replace(r'const close = path.match(/\/admin\/arena\/tournaments\/([^/]+)\/close-registration$/);',
                        r'const close = path.match(/\/admin\/arena\/tournaments\/([^/]+)\/registration\/close$/);')
helper = helper.replace('async function adminAuth(req, res, routeLabel) {', 'export async function requireTournamentAdminAuth(req, res, routeLabel) {')
helper = helper.replace('await adminAuth(req, res,', 'await requireTournamentAdminAuth(req, res,')
helper_path.write_text(helper)

arena_path = Path('frontend/api/arenaTournaments.js')
arena = arena_path.read_text()
import_anchor = 'import { requireAdminOrOps } from "./lib/apiAuth.js";\n'
if import_anchor not in arena:
    raise SystemExit('arena auth import anchor missing')
arena = arena.replace(import_anchor, import_anchor + 'import { handleTournamentAdminContractRoute, requireTournamentAdminAuth } from "./lib/arenaTournamentAdminContract.js";\n', 1)
arena = arena.replace('const ownsTransaction = typeof db.connect === "function";', 'const ownsTransaction = db === pool;', 1)
arena = arena.replace('const admin = await requireAdminOrOps(req, res, { routeLabel: "admin/arena/tournaments/start", allowOps: true });',
                      'const admin = await requireTournamentAdminAuth(req, res, "admin/arena/tournaments/start");', 1)
arena = arena.replace('const admin = await requireAdminOrOps(req, res, { routeLabel: "admin/arena/tournaments/reconcile-bracket", allowOps: true });',
                      'const admin = await requireTournamentAdminAuth(req, res, "admin/arena/tournaments/reconcile-bracket");', 1)
handler_anchor = '''  try {
    if (path.startsWith("/admin/arena/tournaments") || path.startsWith("/api/admin/arena/tournaments")) {'''
handler_new = '''  try {
    const handledAdminContract = await handleTournamentAdminContractRoute(req, res, { method, path });
    if (handledAdminContract) return;
    if (path.startsWith("/admin/arena/tournaments") || path.startsWith("/api/admin/arena/tournaments")) {'''
if handler_anchor not in arena:
    raise SystemExit('arena handler anchor missing')
arena = arena.replace(handler_anchor, handler_new, 1)
arena_path.write_text(arena)

migration_path = Path('db/migrations/20260910_000002_arena_tournament_admin_contract.sql')
migration = migration_path.read_text()
migration = migration.replace('  ADD COLUMN IF NOT EXISTS admin_contract_version integer;',
'''  ADD COLUMN IF NOT EXISTS admin_contract_version integer,
  ADD COLUMN IF NOT EXISTS invite_wallets jsonb NOT NULL DEFAULT '[]'::jsonb;''')
migration = migration.replace(
'''  ADD CONSTRAINT arena_tournaments_round_duration_check CHECK (
    (battle_mode = 'normal' AND round_duration_hours IN (12, 24))
    OR (battle_mode = 'vote' AND round_duration_hours >= 1)
  );''',
'''  ADD CONSTRAINT arena_tournaments_round_duration_check CHECK (
    admin_contract_version IS NULL
    OR (battle_mode = 'normal' AND round_duration_hours IN (12, 24))
    OR (battle_mode = 'vote' AND round_duration_hours >= 1)
  );''')
mode_anchor = '''ALTER TABLE public.arena_tournaments
  DROP CONSTRAINT IF EXISTS arena_tournaments_admin_contract_version_check;'''
if mode_anchor not in migration:
    raise SystemExit('migration mode anchor missing')
migration = migration.replace(mode_anchor,
'''ALTER TABLE public.arena_tournaments
  DROP CONSTRAINT IF EXISTS arena_tournaments_battle_mode_check;
ALTER TABLE public.arena_tournaments
  ADD CONSTRAINT arena_tournaments_battle_mode_check CHECK (battle_mode IN ('normal', 'boost', 'vote'));

''' + mode_anchor, 1)
migration = migration.replace(
'''  IF tournament_mode = 'normal' AND tournament_round_hours NOT IN (12, 24) THEN''',
'''  IF tournament_mode = 'boost' THEN
    RAISE EXCEPTION 'Legacy boost Tournament battles remain fail-closed';
  END IF;
  IF tournament_mode = 'normal' AND tournament_round_hours NOT IN (12, 24) THEN''')
migration = migration.replace('\nCOMMIT;\n', '''
-- Regulation duration follows the persisted Vote Tournament duration while Final
-- Salvo timing remains immutable at 60-second shots/sudden death.
ALTER TABLE public.arena_vote_tiebreaks
  DROP CONSTRAINT IF EXISTS arena_vote_tiebreaks_timing_check;
ALTER TABLE public.arena_vote_tiebreaks
  DROP CONSTRAINT IF EXISTS arena_vote_tiebreaks_identity_check;
ALTER TABLE public.arena_vote_tiebreaks
  ADD CONSTRAINT arena_vote_tiebreaks_timing_check CHECK (
    regulation_duration_seconds >= 3600
    AND regulation_duration_seconds % 3600 = 0
    AND salvo_duration_seconds = 60
    AND sudden_death_shot_seconds = 60
  );

COMMIT;
''')
migration_path.write_text(migration)

test_path = Path('frontend/api/arenaTournamentAdminContract.test.mjs')
test_path.write_text(r'''import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const helper = fs.readFileSync(new URL("./lib/arenaTournamentAdminContract.js", import.meta.url), "utf8");
const arena = fs.readFileSync(new URL("./arenaTournaments.js", import.meta.url), "utf8");
const migration = fs.readFileSync(new URL("../../db/migrations/20260910_000002_arena_tournament_admin_contract.sql", import.meta.url), "utf8");

test("Tournament admin auth fails closed against legacy-open fallback", () => {
  assert.match(helper, /\["admin", "ops-key"\]\.includes/);
  assert.doesNotMatch(helper, /mode.*=== "disabled"/);
});

test("new admin contract enforces safe power-of-two caps >= 4 without 32-bit bitwise JS", () => {
  assert.match(helper, /function isSafePowerOfTwo/);
  assert.match(helper, /cap < 4 \|\| !isSafePowerOfTwo\(cap\)/);
  assert.doesNotMatch(helper, /cap & \(cap - 1\)/);
});

test("dashboard mutation routes and response shape are authoritative", () => {
  assert.match(helper, /registration\\\/open/);
  assert.match(helper, /registration\\\/close/);
  assert.match(helper, /entrants\\\/\(\[\^\/\]\+\)/);
  assert.match(helper, /tournament: adminItem/);
});

test("CREATE persists canonical generation, environment, cluster, duration, sponsor and invite wallets", () => {
  for (const token of ["admin_contract_version", "environment", "solana_cluster", "round_duration_hours", "sponsor_reference", "invite_wallets"]) {
    assert.match(helper, new RegExp(token));
    assert.match(migration, new RegExp(token));
  }
  assert.match(helper, /Battle Tournament round duration must be exactly 12 or 24 hours/);
  assert.match(helper, /Vote Tournament round duration must be an integer of at least 1 hour/);
});

test("START uses existing pool client and admin routes dispatch through authenticated contract", () => {
  assert.match(arena, /const ownsTransaction = db === pool;/);
  assert.match(arena, /handleTournamentAdminContractRoute/);
  assert.match(arena, /requireTournamentAdminAuth\(req, res, "admin\/arena\/tournaments\/start"\)/);
});

test("Vote regulation evolves while Final Salvo remains exactly 60 seconds", () => {
  assert.match(migration, /regulation_duration_seconds >= 3600/);
  assert.match(migration, /regulation_duration_seconds % 3600 = 0/);
  assert.match(migration, /salvo_duration_seconds = 60/);
  assert.match(migration, /sudden_death_shot_seconds = 60/);
});
''')
