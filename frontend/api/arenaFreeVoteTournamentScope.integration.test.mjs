/**
 * Free-vote uniqueness is scoped per tournament (20261003_000006), against a
 * real local Postgres with the certified Arena schema
 * (CI: .github/workflows/tournament-admin-backend-contract.yml).
 *
 *   ARENA_SCHEMA_GATE_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/arena_schema_gate \
 *     node --test api/arenaFreeVoteTournamentScope.integration.test.mjs
 *
 * Runs only against a loopback database: it creates and deletes rows.
 */
import assert from "node:assert/strict";
import test from "node:test";

const gateUrl = process.env.ARENA_SCHEMA_GATE_DATABASE_URL || "";
let skip = "ARENA_SCHEMA_GATE_DATABASE_URL not set";
if (gateUrl) {
  const host = new URL(gateUrl).hostname;
  skip = ["127.0.0.1", "localhost", "::1"].includes(host) ? false : `refusing non-local database host ${host}`;
}
if (!skip) {
  process.env.DATABASE_URL = gateUrl;
  process.env.PG_DISABLE_SSL = "1";
}

const WALLET = "0x9999999999999999999999999999999999999999";
const TOKEN_A = "0x1111111111111111111111111111111111111111";
const TOKEN_B = "0x2222222222222222222222222222222222222222";
const suffix = Date.now().toString(36);

// Same statement shape as arenaTournamentVotes.js (regulation) and
// arenaFinalSalvo.js (salvo): ON CONFLICT DO NOTHING, no conflict target.
async function freeVote(db, { tournamentId, matchId, battleId, roundNumber = 1, phase = "regulation", salvoIndex = null, side = "left", wallet = WALLET }) {
  const result = await db.query(
    `insert into public.arena_contest_actions (
       chain_id, tournament_id, match_id, battle_id, round_number, phase, salvo_index,
       side, wallet, action_type, boost_units, points,
       gross_native_raw, pool_native_raw, protocol_native_raw, confirmed_at
     ) values (97,$1,$2,$3,$4,$5,$6,$7,$8,'free_vote',0,1,0,0,0,now())
     on conflict do nothing
     returning id`,
    [tournamentId, matchId, battleId, roundNumber, phase, salvoIndex, side, wallet],
  );
  return Boolean(result.rows[0]);
}

test("free votes are unique per tournament, match, round, phase and wallet", { skip }, async (t) => {
  const { pool } = await import("../server/db.js");
  const tournaments = [`fv-t1-${suffix}`, `fv-t2-${suffix}`];
  const battles = [`fv-b1-${suffix}`, `fv-b2-${suffix}`, `fv-solo-${suffix}`];
  t.after(async () => {
    await pool.query("delete from public.arena_contest_actions where battle_id = any($1::text[])", [battles]);
    await pool.query("delete from public.arena_battles where id = any($1::text[])", [battles]);
    await pool.query("delete from public.arena_tournaments where id = any($1::text[])", [tournaments]);
    await pool.end();
  });

  const index = (await pool.query(
    "select indexdef from pg_indexes where schemaname = 'public' and indexname = 'arena_contest_actions_regulation_free_vote_uidx'",
  )).rows[0]?.indexdef || "";
  assert.match(index, /\(tournament_id, COALESCE\(match_id, battle_id\), round_number, phase, wallet\) NULLS NOT DISTINCT/);
  const salvoIndex = (await pool.query(
    "select indexdef from pg_indexes where schemaname = 'public' and indexname = 'arena_contest_actions_salvo_free_vote_uidx'",
  )).rows[0]?.indexdef || "";
  assert.match(salvoIndex, /\(tournament_id, COALESCE\(match_id, battle_id\), round_number, phase, salvo_index, wallet\) NULLS NOT DISTINCT/);

  for (const id of tournaments) {
    await pool.query(
      `insert into public.arena_tournaments (id, chain_id, name, status, starts_at, cap, battle_mode, round_duration_hours,
         contest_scoring_version, competition_generation, native_symbol)
       values ($1, 97, $1, 'upcoming', now() - interval '1 hour', 4, 'vote', 24, 'vote_tournament_v1', 'arena_competition_v2', 'BNB')`,
      [id],
    );
  }
  const insertBattle = (id, source, tournamentId) => pool.query(
    `insert into public.arena_battles (id, chain_id, state, source, stake_native, native_symbol, challenger_token, defender_token,
       tournament_id, participants, started_at, ends_at, battle_mode, contest_scoring_version, competition_generation, duration_hours)
     values ($1, 97, 'live', $2, 0, 'BNB', $3, $4, $5, '[]'::jsonb, now(), now() + interval '1 hour', 'vote', 'vote_tournament_v1', 'arena_competition_v2', 24)`,
    [id, source, TOKEN_A, TOKEN_B, tournamentId],
  );
  await insertBattle(battles[0], "tournament", tournaments[0]);
  await insertBattle(battles[1], "tournament", tournaments[1]);
  await insertBattle(battles[2], "queue", null);

  await t.test("same wallet, m1 round 1, two tournaments: both accepted", async () => {
    assert.equal(await freeVote(pool, { tournamentId: tournaments[0], matchId: "m1", battleId: battles[0] }), true);
    assert.equal(await freeVote(pool, { tournamentId: tournaments[1], matchId: "m1", battleId: battles[1] }), true);
  });

  await t.test("same wallet twice in one tournament/match/round: second refused (either side)", async () => {
    assert.equal(await freeVote(pool, { tournamentId: tournaments[0], matchId: "m1", battleId: battles[0], side: "right" }), false);
    assert.equal(await freeVote(pool, { tournamentId: tournaments[0], matchId: "m1", battleId: battles[0] }), false);
    // A different round of the same match is a new vote.
    assert.equal(await freeVote(pool, { tournamentId: tournaments[0], matchId: "m1", battleId: battles[0], roundNumber: 2 }), true);
  });

  await t.test("Final Salvo: one vote per shot per tournament, independent across tournaments", async () => {
    const shot = { matchId: "m1", phase: "salvo", salvoIndex: 1 };
    assert.equal(await freeVote(pool, { ...shot, tournamentId: tournaments[0], battleId: battles[0] }), true);
    assert.equal(await freeVote(pool, { ...shot, tournamentId: tournaments[0], battleId: battles[0], side: "right" }), false);
    assert.equal(await freeVote(pool, { ...shot, tournamentId: tournaments[1], battleId: battles[1] }), true);
    assert.equal(await freeVote(pool, { ...shot, tournamentId: tournaments[0], battleId: battles[0], salvoIndex: 2 }), true);
  });

  await t.test("standalone Vote Battle (tournament_id NULL): double vote still refused", async () => {
    const { recordVoteBattleFreeVote } = await import("./lib/arenaBattleVoteRuntime.js");
    const battle = (await pool.query("select * from public.arena_battles where id = $1", [battles[2]])).rows[0];
    const query = (text, params) => pool.query(text, params);
    const first = await recordVoteBattleFreeVote(query, battle, { wallet: WALLET, side: "left" });
    assert.ok(first.inserted, "first standalone vote recorded");
    const second = await recordVoteBattleFreeVote(query, battle, { wallet: WALLET, side: "right" });
    assert.equal(second.inserted, null);
    assert.equal(second.existingSide, "left");
    // A raw insert with NULL tournament_id and NULL match_id also collides (NULLS NOT DISTINCT).
    assert.equal(await freeVote(pool, { tournamentId: null, matchId: null, battleId: battles[2], side: "right" }), false);
    const rows = (await pool.query(
      "select count(*)::int as c from public.arena_contest_actions where battle_id = $1 and action_type = 'free_vote'",
      [battles[2]],
    )).rows[0].c;
    assert.equal(rows, 1);
  });
});
