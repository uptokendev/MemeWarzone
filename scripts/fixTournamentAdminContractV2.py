from pathlib import Path
import re

helper_path = Path('frontend/api/lib/arenaTournamentAdminContract.js')
helper = helper_path.read_text()

# Complete dashboard PATCH contract: buyInNative and environment are editable while chain_id stays immutable.
old_edit = '''export async function handleTournamentAdminEdit(req, res, id) {
  const body = await readJson(req);
  return withLockedUpcomingMutation(req, res, id, body, "edit", async ({ row, body: payload }) => {
    const nextKind = normalizeTournamentType(payload.kind ?? payload.tournamentType ?? row.tournament_type ?? row.battle_mode);
    const nextDuration = normalizeRoundDuration(nextKind, payload.roundDurationHours ?? row.round_duration_hours);
    const nextStartMode = normalizeStartMode(payload.startMode ?? row.start_mode ?? "manual");
    const nextStartsAt = requiredDate(payload.startsAt ?? row.starts_at, "startsAt");
    const nextOpen = requiredDate(payload.registrationOpensAt ?? row.registration_opens_at, "registrationOpensAt");
    const nextClose = requiredDate(payload.registrationClosesAt ?? row.registration_closes_at, "registrationClosesAt");
    validateWindows({ registrationOpensAt: nextOpen, registrationClosesAt: nextClose, startsAt: nextStartsAt, startMode: nextStartMode });
    const nextCap = payload.cap == null ? Number(row.cap) : parseExactBracketCap(payload.cap);
    return {
      name: payload.name == null ? row.name : requiredText(payload.name, "name"),
      terms: payload.terms == null ? row.terms : text(payload.terms),
      startsAt: nextStartsAt,
      cap: nextCap,
      battleMode: nextKind === "vote" ? "vote" : "normal",
      tournamentType: nextKind,
      registrationMode: row.registration_mode,
      registrationState: row.registration_state,
      registrationOpensAt: nextOpen,
      registrationClosesAt: nextClose,
      startMode: nextStartMode,
      roundDurationHours: nextDuration,
      sponsorReference: payload.sponsorReference == null ? row.sponsor_reference : text(payload.sponsorReference) || null,
    };
  });
}'''
new_edit = '''export async function handleTournamentAdminEdit(req, res, id) {
  const body = await readJson(req);
  return withLockedUpcomingMutation(req, res, id, body, "edit", async ({ row, body: payload }) => {
    const nextKind = normalizeTournamentType(payload.kind ?? payload.tournamentType ?? row.tournament_type ?? row.battle_mode);
    const nextDuration = normalizeRoundDuration(nextKind, payload.roundDurationHours ?? row.round_duration_hours);
    const nextStartMode = normalizeStartMode(payload.startMode ?? row.start_mode ?? "manual");
    const nextStartsAt = requiredDate(payload.startsAt ?? row.starts_at, "startsAt");
    const nextOpen = requiredDate(payload.registrationOpensAt ?? row.registration_opens_at, "registrationOpensAt");
    const nextClose = requiredDate(payload.registrationClosesAt ?? row.registration_closes_at, "registrationClosesAt");
    validateWindows({ registrationOpensAt: nextOpen, registrationClosesAt: nextClose, startsAt: nextStartsAt, startMode: nextStartMode });
    const nextCap = payload.cap == null ? Number(row.cap) : parseExactBracketCap(payload.cap);
    const nextBuyIn = payload.buyInNative == null && payload.buy_in_native == null
      ? Number(row.buy_in_native || 0)
      : optionalNonnegativeNumber(payload.buyInNative ?? payload.buy_in_native, "buyInNative");
    const envIdentity = normalizeEnvironment(Number(row.chain_id), payload.environment ?? row.environment);
    return {
      name: payload.name == null ? row.name : requiredText(payload.name, "name"),
      terms: payload.terms == null ? row.terms : text(payload.terms),
      startsAt: nextStartsAt,
      cap: nextCap,
      buyInNative: nextBuyIn,
      environment: envIdentity.environment,
      solanaCluster: envIdentity.solanaCluster,
      battleMode: nextKind === "vote" ? "vote" : "normal",
      tournamentType: nextKind,
      registrationMode: row.registration_mode,
      registrationState: row.registration_state,
      registrationOpensAt: nextOpen,
      registrationClosesAt: nextClose,
      startMode: nextStartMode,
      roundDurationHours: nextDuration,
      sponsorReference: payload.sponsorReference == null ? row.sponsor_reference : text(payload.sponsorReference) || null,
    };
  });
}'''
if old_edit not in helper:
    raise SystemExit('edit handler anchor missing')
helper = helper.replace(old_edit, new_edit, 1)

old_update_sql = '''    const update = await client.query(
      `update public.arena_tournaments
          set name=$3, registration_mode=$4, terms=$5, starts_at=$6, cap=$7,
              battle_mode=$8, tournament_type=$9, registration_state=$10,
              registration_opens_at=$11, registration_closes_at=$12, start_mode=$13,
              round_duration_hours=$14, sponsor_reference=$15,
              state_version=state_version+1, updated_at=now()
        where id=$1 and chain_id=$2 and state_version=$16
        returning *`,
      [id, chainId, next.name ?? row.name, next.registrationMode ?? row.registration_mode, next.terms ?? row.terms,
       next.startsAt ?? row.starts_at, next.cap ?? row.cap, next.battleMode ?? row.battle_mode,
       next.tournamentType ?? row.tournament_type, next.registrationState ?? row.registration_state,
       next.registrationOpensAt ?? row.registration_opens_at, next.registrationClosesAt ?? row.registration_closes_at,
       next.startMode ?? row.start_mode, next.roundDurationHours ?? row.round_duration_hours,
       next.sponsorReference === undefined ? row.sponsor_reference : next.sponsorReference, version],
    );'''
new_update_sql = '''    const update = await client.query(
      `update public.arena_tournaments
          set name=$3, registration_mode=$4, terms=$5, starts_at=$6, cap=$7,
              battle_mode=$8, tournament_type=$9, registration_state=$10,
              registration_opens_at=$11, registration_closes_at=$12, start_mode=$13,
              round_duration_hours=$14, sponsor_reference=$15, buy_in_native=$16,
              environment=$17, solana_cluster=$18,
              state_version=state_version+1, updated_at=now()
        where id=$1 and chain_id=$2 and state_version=$19
        returning *`,
      [id, chainId, next.name ?? row.name, next.registrationMode ?? row.registration_mode, next.terms ?? row.terms,
       next.startsAt ?? row.starts_at, next.cap ?? row.cap, next.battleMode ?? row.battle_mode,
       next.tournamentType ?? row.tournament_type, next.registrationState ?? row.registration_state,
       next.registrationOpensAt ?? row.registration_opens_at, next.registrationClosesAt ?? row.registration_closes_at,
       next.startMode ?? row.start_mode, next.roundDurationHours ?? row.round_duration_hours,
       next.sponsorReference === undefined ? row.sponsor_reference : next.sponsorReference,
       next.buyInNative === undefined ? row.buy_in_native : next.buyInNative,
       next.environment ?? row.environment, next.solanaCluster === undefined ? row.solana_cluster : next.solanaCluster,
       version],
    );'''
if old_update_sql not in helper:
    raise SystemExit('mutation update SQL anchor missing')
helper = helper.replace(old_update_sql, new_update_sql, 1)

# Export validators for executable boundary tests.
helper = helper.replace('function isSafePowerOfTwo(value) {', 'export function isSafePowerOfTwo(value) {', 1)
helper = helper.replace('function normalizeEnvironment(chainId, environmentRaw) {', 'export function normalizeEnvironment(chainId, environmentRaw) {', 1)
helper = helper.replace('function normalizeRoundDuration(kind, value) {', 'export function normalizeRoundDuration(kind, value) {', 1)
helper_path.write_text(helper)

arena_path = Path('frontend/api/arenaTournaments.js')
arena = arena_path.read_text()

# New-generation admin tournaments cannot START while registration is still open/pending.
status_anchor = '''    if (row.status !== "upcoming") {
      await client.query("rollback");
      return json(res, 409, { ok: false, error: "Tournament is not upcoming", code: "TOURNAMENT_ALREADY_STARTED" });
    }

    const clock = await client.query("select now() as now");'''
status_replacement = '''    if (row.status !== "upcoming") {
      await client.query("rollback");
      return json(res, 409, { ok: false, error: "Tournament is not upcoming", code: "TOURNAMENT_ALREADY_STARTED" });
    }
    if (Number(row.admin_contract_version || 0) === 1 && row.registration_state !== "closed") {
      await client.query("rollback");
      return json(res, 409, {
        ok: false,
        error: "Tournament registration must be closed before start.",
        code: "TOURNAMENT_REGISTRATION_NOT_CLOSED",
        registrationState: row.registration_state,
      });
    }

    const clock = await client.query("select now() as now");'''
if status_anchor not in arena:
    raise SystemExit('start state anchor missing')
arena = arena.replace(status_anchor, status_replacement, 1)

# Dashboard authoritative alias while preserving historical reconcile-bracket callers.
arena = arena.replace(
'const reconcile = path.match(/\\/admin\\/arena\\/tournaments\\/([^/]+)\\/reconcile-bracket$/);',
'const reconcile = path.match(/\\/admin\\/arena\\/tournaments\\/([^/]+)\\/(?:reconcile|reconcile-bracket)$/);', 1)

# Preserve historical item while adding dashboard-authoritative tournament shape.
start_response = '''      item: mapAdmin(updated.rows[0], start.roster.length),
      bracket,'''
if start_response not in arena:
    raise SystemExit('start response anchor missing')
arena = arena.replace(start_response,
'''      item: mapAdmin(updated.rows[0], start.roster.length),
      tournament: mapAdmin(updated.rows[0], start.roster.length),
      bracket,''', 1)
arena_path.write_text(arena)

migration_path = Path('db/migrations/20260910_000002_arena_tournament_admin_contract.sql')
migration = migration_path.read_text()

# Remove the V1 patch's incorrect dependency on a non-existent regulation column.
# Regulation duration belongs to arena_tournaments.round_duration_hours and drives battle.ends_at.
wrong_salvo = re.compile(r'''\n-- Regulation duration follows the persisted Vote Tournament duration while Final\n-- Salvo timing remains immutable at 60-second shots/sudden death\.\nALTER TABLE public\.arena_vote_tiebreaks\n  DROP CONSTRAINT IF EXISTS arena_vote_tiebreaks_timing_check;\nALTER TABLE public\.arena_vote_tiebreaks\n  DROP CONSTRAINT IF EXISTS arena_vote_tiebreaks_identity_check;\nALTER TABLE public\.arena_vote_tiebreaks\n  ADD CONSTRAINT arena_vote_tiebreaks_timing_check CHECK \(\n    regulation_duration_seconds >= 3600\n    AND regulation_duration_seconds % 3600 = 0\n    AND salvo_duration_seconds = 60\n    AND sudden_death_shot_seconds = 60\n  \);\n''')
migration, removed = wrong_salvo.subn('\n', migration, count=1)
if removed != 1:
    raise SystemExit('incorrect Final Salvo block not found')

# Historical boost rows, if any, remain historical data/runtime; do not introduce a new fail-closed semantic here.
migration = migration.replace(
'''  IF tournament_mode = 'boost' THEN
    RAISE EXCEPTION 'Legacy boost Tournament battles remain fail-closed';
  END IF;
''', '', 1)

migration_path.write_text(migration)

# Extend focused executable/static tests.
test_path = Path('frontend/api/arenaTournamentAdminContract.test.mjs')
test = test_path.read_text()
old_final_test = '''test("Vote regulation evolves while Final Salvo remains exactly 60 seconds", () => {
  assert.match(migration, /regulation_duration_seconds >= 3600/);
  assert.match(migration, /regulation_duration_seconds % 3600 = 0/);
  assert.match(migration, /salvo_duration_seconds = 60/);
  assert.match(migration, /sudden_death_shot_seconds = 60/);
});'''
new_final_test = '''test("Vote regulation evolves through tournament duration without rewriting Final Salvo schema", () => {
  assert.match(migration, /make_interval\\(hours => tournament_round_hours\\)/);
  assert.doesNotMatch(migration, /regulation_duration_seconds/);
  assert.doesNotMatch(migration, /ALTER TABLE public\\.arena_vote_tiebreaks/);
});

test("dashboard edit contract persists buyInNative and environment identity", () => {
  assert.match(helper, /buy_in_native=\\$16/);
  assert.match(helper, /environment=\\$17, solana_cluster=\\$18/);
  assert.match(helper, /normalizeEnvironment\\(Number\\(row\\.chain_id\\)/);
});

test("new-generation START requires registration closed and reconcile keeps dashboard alias", () => {
  assert.match(arena, /TOURNAMENT_REGISTRATION_NOT_CLOSED/);
  assert.match(arena, /\\(\\?:reconcile\\|reconcile-bracket\\)/);
  assert.match(arena, /tournament: mapAdmin/);
});'''
if old_final_test not in test:
    raise SystemExit('focused Final Salvo test anchor missing')
test = test.replace(old_final_test, new_final_test, 1)
test_path.write_text(test)
