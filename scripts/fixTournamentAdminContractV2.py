from pathlib import Path
import re

helper_path = Path('frontend/api/lib/arenaTournamentAdminContract.js')
helper = helper_path.read_text()

# Complete CREATE persistence for the new admin generation.
create_pattern = re.compile(r'''(sponsor_reference, state_version, exact_bracket_required\n\s*\) values \(\$1,\$2,\$3,'upcoming','custom',\$4,\$5,\$6,\$7,\$8,\$9,\$10,\$11,\$12,\$13,\$14,\$15,\$16,\$17,\$18,\$19,\$20,1,true\))''')
create_replacement = '''sponsor_reference, state_version, exact_bracket_required, admin_contract_version, invite_wallets
     ) values ($1,$2,$3,'upcoming','custom',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,1,true,1,$21::jsonb)'''
helper, n = create_pattern.subn(create_replacement, helper, count=1)
if n != 1:
    raise SystemExit('create persistence structural anchor missing')

# Complete the dashboard PATCH contract on the already-generated helper.
edit_pattern = re.compile(r'''export function handleTournamentAdminEdit\(req, res, id\) \{.*?\n\}\n\nexport function handleTournamentRegistrationState''', re.S)
edit_replacement = '''export function handleTournamentAdminEdit(req, res, id) {
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

export function handleTournamentRegistrationState'''
helper, n = edit_pattern.subn(edit_replacement, helper, count=1)
if n != 1:
    raise SystemExit('edit handler structural anchor missing')

# Extend the locked mutation UPDATE with editable chain-native buy-in and canonical environment fields.
update_pattern = re.compile(r'''    const update = await client\.query\(\n      `update public\.arena_tournaments\n          set name = \$3, registration_mode = \$4, registration_state = \$5,\n              registration_opens_at = \$6, registration_closes_at = \$7, start_mode = \$8,\n              starts_at = \$9, cap = \$10, terms = \$11, sponsor_reference = \$12,\n              battle_mode = \$13, tournament_type = \$14, round_duration_hours = \$15,\n              status = \$16, state_version = state_version \+ 1, updated_at = now\(\)\n        where id = \$1 and chain_id = \$2 and state_version = \$17\n        returning \*`,\n      \[id, chainId, next\.name \?\? row\.name, next\.registrationMode \?\? row\.registration_mode,\n       next\.registrationState \?\? row\.registration_state, next\.registrationOpensAt \?\? row\.registration_opens_at,\n       next\.registrationClosesAt \?\? row\.registration_closes_at, next\.startMode \?\? row\.start_mode,\n       next\.startsAt \?\? row\.starts_at, next\.cap \?\? row\.cap, next\.terms \?\? row\.terms,\n       next\.sponsorReference !== undefined \? next\.sponsorReference : row\.sponsor_reference,\n       next\.battleMode \?\? row\.battle_mode, next\.tournamentType \?\? row\.tournament_type,\n       next\.roundDurationHours \?\? row\.round_duration_hours, next\.status \?\? row\.status, version\],\n    \);''', re.S)
update_replacement = '''    const update = await client.query(
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
    );'''
helper, n = update_pattern.subn(update_replacement, helper, count=1)
if n != 1:
    raise SystemExit('mutation update SQL structural anchor missing')

# Export pure validators for executable boundary tests.
helper = helper.replace('function isSafePowerOfTwo(value) {', 'export function isSafePowerOfTwo(value) {', 1)
helper = helper.replace('function normalizeEnvironment(chainId, body) {', 'export function normalizeEnvironment(chainId, body) {', 1)
helper = helper.replace('function normalizeRoundDuration(kind, value) {', 'export function normalizeRoundDuration(kind, value) {', 1)
helper_path.write_text(helper)

arena_path = Path('frontend/api/arenaTournaments.js')
arena = arena_path.read_text()
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

old_reconcile = 'const reconcile = path.match(/\\/admin\\/arena\\/tournaments\\/([^/]+)\\/reconcile-bracket$/);'
new_reconcile = 'const reconcile = path.match(/\\/admin\\/arena\\/tournaments\\/([^/]+)\\/(?:reconcile|reconcile-bracket)$/);'
if old_reconcile not in arena:
    raise SystemExit('reconcile route anchor missing')
arena = arena.replace(old_reconcile, new_reconcile, 1)
start_response = '''      item: mapAdmin(updated.rows[0], start.roster.length),
      bracket,'''
if start_response not in arena:
    raise SystemExit('start response anchor missing')
arena = arena.replace(start_response, '''      item: mapAdmin(updated.rows[0], start.roster.length),
      tournament: mapAdmin(updated.rows[0], start.roster.length),
      bracket,''', 1)
arena_path.write_text(arena)

migration_path = Path('db/migrations/20260910_000002_arena_tournament_admin_contract.sql')
migration = migration_path.read_text()
wrong_salvo = re.compile(r'''\n-- Regulation duration follows the persisted Vote Tournament duration while Final\n-- Salvo timing remains immutable at 60-second shots/sudden death\.\nALTER TABLE public\.arena_vote_tiebreaks\n  DROP CONSTRAINT IF EXISTS arena_vote_tiebreaks_timing_check;\nALTER TABLE public\.arena_vote_tiebreaks\n  DROP CONSTRAINT IF EXISTS arena_vote_tiebreaks_identity_check;\nALTER TABLE public\.arena_vote_tiebreaks\n  ADD CONSTRAINT arena_vote_tiebreaks_timing_check CHECK \(\n    regulation_duration_seconds >= 3600\n    AND regulation_duration_seconds % 3600 = 0\n    AND salvo_duration_seconds = 60\n    AND sudden_death_shot_seconds = 60\n  \);\n''')
migration, removed = wrong_salvo.subn('\n', migration, count=1)
if removed != 1:
    raise SystemExit('incorrect Final Salvo block not found')
migration = migration.replace('''  IF tournament_mode = 'boost' THEN
    RAISE EXCEPTION 'Legacy boost Tournament battles remain fail-closed';
  END IF;
''', '', 1)
migration_path.write_text(migration)

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
  assert.match(helper, /buy_in_native = \\$17/);
  assert.match(helper, /environment = \\$18, solana_cluster = \\$19/);
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
