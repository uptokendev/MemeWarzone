import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const migration103 = path.join(root, "db/migrations/20260903_000103_arena_tournament_battle_modes.sql");
const migration104 = path.join(root, "db/migrations/20260903_000104_arena_vote_boost_sponsorship_v1_foundation.sql");

for (const file of [migration103, migration104]) {
  assert.ok(fs.existsSync(file), `missing migration: ${file}`);
}

const sql103 = fs.readFileSync(migration103, "utf8");
const sql104 = fs.readFileSync(migration104, "utf8");

const staticChecks = [
  [sql104, /battle_mode IN \('normal', 'vote'\)/i, "normal/vote tournament mode constraint"],
  [sql104, /CHECK \(round_duration_hours = 24\)/i, "24h tournament duration lock"],
  [sql104, /contest_scoring_version IN \('battle_points_v3', 'vote_tournament_v1'\)/i, "distinct normal/vote scoring paths"],
  [sql104, /NEW\.battle_mode := tournament_mode;/i, "battle inherits tournament mode"],
  [sql104, /NEW\.contest_scoring_version := tournament_scoring_version;/i, "battle inherits scoring path"],
  [sql104, /vote_tournament_v1/i, "vote tournament scoring path exists"],
  [sql104, /CREATE TABLE IF NOT EXISTS public\.arena_vote_tiebreaks/i, "Final Salvo schema exists"],
  [sql104, /CREATE TABLE IF NOT EXISTS public\.arena_contest_actions/i, "contest action ledger exists"],
  [sql104, /arena_contest_actions_regulation_free_vote_uidx/i, "regulation uniqueness exists"],
  [sql104, /arena_contest_actions_salvo_free_vote_uidx/i, "salvo reset uniqueness exists"],
  [sql104, /CREATE TABLE IF NOT EXISTS public\.arena_battle_points_v3/i, "Battle Points V3 storage exists"],
  [sql104, /pool_generation text NOT NULL DEFAULT 'war_pool_v1'/i, "historical WarPool generation preserved"],
  [sql104, /allocation_version text NOT NULL DEFAULT 'winner85_mwl10_protocol5'/i, "historical allocation remains interpretable"],
  [sql104, /CREATE TABLE IF NOT EXISTS public\.arena_postgrad_league_v2_ledger/i, "Post-Grad League V2 ledger exists"],
  [sql104, /CREATE TABLE IF NOT EXISTS public\.sponsorship_events/i, "sponsorship event schema exists"],
  [sql104, /event_type IN \('normal_tournament', 'vote_tournament', 'monthly_mwl', 'quarterly_championship'\)/i, "event type excludes normal battle"],
  [sql104, /'FOUNDING', 'Founding', 0, 999, 4900, 9900, 24900/i, "FOUNDING tier seeded exactly"],
  [sql104, /'EARLY', 'Early', 1000, 4999, 9900, 19900, 49900/i, "EARLY tier seeded exactly"],
  [sql104, /'GROWING', 'Growing', 5000, 24999, 24900, 49900, 119900/i, "GROWING tier seeded exactly"],
  [sql104, /'ESTABLISHED', 'Established', 25000, 99999, 59900, 119900, 299900/i, "ESTABLISHED tier seeded exactly"],
  [sql104, /'LARGE', 'Large', 100000, 499999, 149900, 299900, 749900/i, "LARGE tier seeded exactly"],
  [sql104, /'MAJOR', 'Major', 500000, NULL, 299900, 749900, 1500000/i, "MAJOR tier seeded exactly"],
];

for (const [source, pattern, label] of staticChecks) {
  assert.match(source, pattern, `missing invariant: ${label}`);
}

assert.doesNotMatch(sql104, /\bBOOST_RULES_NOT_CONFIGURED\b/, "new migration must remove the boost fail-closed dependency");

const integerMoneyChecks = [
  /boost_units bigint/i,
  /gross_native_raw bigint/i,
  /pool_native_raw bigint/i,
  /protocol_native_raw bigint/i,
  /raw_native_amount bigint/i,
  /prize_native_raw bigint/i,
  /sponsorship_prize_native_raw bigint/i,
  /minimum_native_raw bigint/i,
  /requested_native_raw bigint/i,
  /gross_native_raw bigint/i,
];
for (const pattern of integerMoneyChecks) {
  assert.match(sql104, pattern, `money field missing raw integer semantics for ${pattern}`);
}

const databaseUrl = process.env.ARENA_SCHEMA_GATE_DATABASE_URL;
if (!databaseUrl) {
  console.log("arena_tournament_mode_schema=static_ok");
  process.exit(0);
}

function psql(sql) {
  return execFileSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-c", sql], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

function psqlFile(file) {
  return execFileSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-f", file], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

function expectPsqlFailure(sql, pattern, label) {
  try {
    psql(sql);
    assert.fail(`expected failure: ${label}`);
  } catch (error) {
    const stderr = String(error.stderr || error.message || "");
    assert.match(stderr, pattern, label);
  }
}

const chain = [
  "db/migrations/20260826_000001_arena_identity_schema.sql",
  "db/migrations/20260827_000001_arena_vote_ingest.sql",
  "db/migrations/20260827_000002_arena_war_pool_escrow.sql",
  "db/migrations/20260827_000003_arena_league_scorecard.sql",
  "db/migrations/20260827_000004_arena_battle_counter_offers.sql",
  "db/migrations/20260827_000005_arena_battle_matched.sql",
  "db/migrations/20260827_000006_arena_battle_duration.sql",
  "db/migrations/20260828_000007_arena_tournament_support.sql",
  "db/migrations/20260829_000001_arena_settle_idempotency.sql",
  "db/migrations/20260902_000003_arena_battle_metrics.sql",
  "db/migrations/20260902_000004_arena_battle_v2_corrections.sql",
  "db/migrations/20260903_000001_arena_import_token_profile_v2.sql",
  "db/migrations/20260903_000002_arena_battle_points_v2_settlement.sql",
  "db/migrations/20260903_000103_arena_tournament_battle_modes.sql",
  "db/migrations/20260903_000104_arena_vote_boost_sponsorship_v1_foundation.sql",
];

for (const file of chain) {
  psqlFile(path.join(root, file));
}

psqlFile(migration104);

psql(`
  INSERT INTO public.arena_tournaments (
    id, chain_id, name, status, origin, registration_mode, buy_in_native, native_symbol, terms, starts_at, ends_at,
    cap, battle_mode, round_duration_hours, contest_scoring_version, competition_generation
  ) VALUES
    ('tour_normal', 56, 'Normal', 'upcoming', 'custom', 'open', 0, 'BNB', '', now(), now() + interval '1 day', 16, 'normal', 24, 'battle_points_v3', 'arena_competition_v2'),
    ('tour_vote', 56, 'Vote', 'upcoming', 'custom', 'open', 0, 'BNB', '', now(), now() + interval '1 day', 16, 'vote', 24, 'vote_tournament_v1', 'arena_competition_v2');
`);

psql(`
  INSERT INTO public.arena_battles (
    id, chain_id, state, source, stake_native, native_symbol, tournament_id, participants, started_at
  ) VALUES
    ('battle_normal', 56, 'live', 'tournament', 0, 'BNB', 'tour_normal', '[]'::jsonb, now()),
    ('battle_vote', 56, 'live', 'tournament', 0, 'BNB', 'tour_vote', '[]'::jsonb, now());
`);

const battleModeRows = psql(`
  SELECT string_agg(
    id || ':' || battle_mode || ':' || contest_scoring_version || ':' || EXTRACT(EPOCH FROM (ends_at - started_at))::bigint,
    ','
    ORDER BY id
  )
  FROM public.arena_battles
  WHERE id IN ('battle_normal', 'battle_vote');
`).trim();
assert.match(battleModeRows, /battle_normal:normal:battle_points_v3:86400/);
assert.match(battleModeRows, /battle_vote:vote:vote_tournament_v1:86400/);

expectPsqlFailure(
  `
    INSERT INTO public.arena_tournaments (
      id, chain_id, name, status, origin, registration_mode, buy_in_native, native_symbol, terms, starts_at, ends_at,
      cap, battle_mode, round_duration_hours, contest_scoring_version, competition_generation
    ) VALUES (
      'tour_invalid_hours', 56, 'Invalid', 'upcoming', 'custom', 'open', 0, 'BNB', '', now(), now() + interval '1 day',
      16, 'vote', 12, 'vote_tournament_v1', 'arena_competition_v2'
    );
  `,
  /arena_tournaments_round_duration_check/,
  "all tournament modes remain locked to 24h",
);

psql(`
  INSERT INTO public.arena_vote_tiebreaks (
    battle_id, tournament_id, round_number, state, regulation_left_points, regulation_right_points, current_salvo_index
  ) VALUES ('battle_vote', 'tour_vote', 2, 'pending', 10, 10, 0);
`);

psql(`
  INSERT INTO public.arena_contest_actions (
    chain_id, tournament_id, battle_id, match_id, round_number, phase, side, wallet, action_type, points
  ) VALUES
    (56, 'tour_vote', 'battle_vote', 'battle_vote', 2, 'regulation', 'left', 'wallet_a', 'free_vote', 1);
`);

expectPsqlFailure(
  `
    INSERT INTO public.arena_contest_actions (
      chain_id, tournament_id, battle_id, match_id, round_number, phase, side, wallet, action_type, points
    ) VALUES
      (56, 'tour_vote', 'battle_vote', 'battle_vote', 2, 'regulation', 'right', 'wallet_a', 'free_vote', 1);
  `,
  /arena_contest_actions_regulation_free_vote_uidx/,
  "regulation free-vote uniqueness blocks the second side choice",
);

psql(`
  INSERT INTO public.arena_contest_actions (
    chain_id, tournament_id, battle_id, match_id, round_number, phase, salvo_index, side, wallet, action_type, points
  ) VALUES
    (56, 'tour_vote', 'battle_vote', 'battle_vote', 2, 'salvo', 1, 'left', 'wallet_a', 'free_vote', 1),
    (56, 'tour_vote', 'battle_vote', 'battle_vote', 2, 'salvo', 2, 'right', 'wallet_a', 'free_vote', 1);
`);

expectPsqlFailure(
  `
    INSERT INTO public.arena_contest_actions (
      chain_id, tournament_id, battle_id, match_id, round_number, phase, salvo_index, side, wallet, action_type, points
    ) VALUES
      (56, 'tour_vote', 'battle_vote', 'battle_vote', 2, 'salvo', 2, 'left', 'wallet_a', 'free_vote', 1);
  `,
  /arena_contest_actions_salvo_free_vote_uidx/,
  "salvo uniqueness resets per shot rather than per match",
);

psql(`
  INSERT INTO public.arena_battle_points_v3 (
    battle_id, token_id, side, boost_curve_version, boost_units, boost_gross_native_raw, boost_pool_native_raw, boost_protocol_native_raw
  ) VALUES
    ('battle_normal', 'token_left', 'left', 'founder_pending', 5, 5000000000000000000, 4500000000000000000, 500000000000000000);
`);

psql(`
  INSERT INTO public.arena_postgrad_league_v2_ledger (
    chain_id, monthly_epoch, quarterly_epoch, source_pool, raw_native_amount
  ) VALUES (56, '2026-09', '2026-Q3', 'battle_normal', 1000000000000000000);
`);

psql(`
  INSERT INTO public.sponsorship_events (
    id, event_type, event_reference_id, chain_id, sponsorship_open, prize_native_raw, sponsorship_prize_native_raw
  ) VALUES
    ('11111111-1111-1111-1111-111111111111', 'vote_tournament', 'tour_vote', 56, true, 0, 0);
`);

expectPsqlFailure(
  `
    INSERT INTO public.sponsorship_events (
      event_type, event_reference_id, chain_id, sponsorship_open, prize_native_raw, sponsorship_prize_native_raw
    ) VALUES
      ('normal_battle', 'battle_vote', 56, true, 0, 0);
  `,
  /sponsorship_events_event_type_check/,
  "normal battles are excluded from sponsorship events",
);

psql(`
  INSERT INTO public.sponsor_profiles (
    id, project_name, wallet, status, founding_sponsor, founding_sponsor_badge
  ) VALUES (
    '22222222-2222-2222-2222-222222222222', 'Founding Sponsor', 'wallet_founder', 'approved', true, 'FOUNDING SPONSOR MEMEWARZONE 2026'
  );
`);

psql(`
  INSERT INTO public.sponsorship_payment_quotes (
    id, event_id, chain_id, sponsor_profile_id, sponsor_wallet, pricing_version, minimum_usd_cents, minimum_native_raw,
    native_usd_reference_micro_cents, oracle_timestamp, expires_at, nonce
  ) VALUES (
    '33333333-3333-3333-3333-333333333333',
    '11111111-1111-1111-1111-111111111111',
    56,
    '22222222-2222-2222-2222-222222222222',
    'wallet_founder',
    'founder_v1',
    4900,
    10000000000000000,
    4900000,
    now(),
    now() + interval '5 minutes',
    'nonce-1'
  );
`);

const tierRows = psql(`
  SELECT string_agg(code || ':' || tournament_min_usd_cents || ':' || mwl_min_usd_cents || ':' || quarterly_min_usd_cents, ',' ORDER BY sort_order)
  FROM public.sponsorship_price_tiers;
`).trim();
assert.match(tierRows, /FOUNDING:4900:9900:24900/);
assert.match(tierRows, /MAJOR:299900:749900:1500000/);

const warPoolRow = psql(`
  INSERT INTO public.arena_war_pools (battle_id)
  VALUES ('battle_pool')
  RETURNING pool_generation, allocation_version;
`).trim();
assert.match(warPoolRow, /war_pool_v1/);
assert.match(warPoolRow, /winner85_mwl10_protocol5/);

const historyRead = psql(`
  INSERT INTO public.arena_battles (
    id, chain_id, state, source, stake_native, native_symbol, participants, settlement_version, settlement_scoring_version, contest_scoring_version
  ) VALUES (
    'battle_history', 56, 'finished', 'queue', 0, 'BNB', '[]'::jsonb, 1, 'mcap_pct_change', 'mcap_pct_change'
  );
  INSERT INTO public.arena_battles (
    id, chain_id, state, source, stake_native, native_symbol, participants, settlement_version, settlement_scoring_version, contest_scoring_version
  ) VALUES (
    'battle_history_v2', 56, 'finished', 'queue', 0, 'BNB', '[]'::jsonb, 2, 'battle_points_v2', 'battle_points_v2'
  );
  SELECT settlement_scoring_version, contest_scoring_version
  FROM public.arena_battles
  WHERE id IN ('battle_history', 'battle_history_v2')
  ORDER BY id;
`).trim();
assert.match(historyRead, /mcap_pct_change/);
assert.match(historyRead, /battle_points_v2/);

console.log("arena_tournament_mode_schema=replay_ok");
