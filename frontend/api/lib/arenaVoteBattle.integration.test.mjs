/**
 * Vote Battle end to end against the real schema, inside one transaction
 * that is rolled back at the end: nothing persists.
 *
 *   STAGING_DATABASE_URL=... node --test api/lib/arenaVoteBattle.integration.test.mjs
 *
 * Covers, on the live (staging) schema: the vote-mode battle row and its
 * constraints / triggers, free votes (one per wallet), boost contest
 * actions at 2 pts per unit, settlement by points, an exact tie entering
 * Final Salvo (chain_id + match_id on the tiebreak row) and the salvo
 * resolution writing the settlement.
 */
import assert from "node:assert/strict";
import test from "node:test";

const url = process.env.STAGING_DATABASE_URL || process.env.DATABASE_URL || "";
if (url && !process.env.DATABASE_URL) process.env.DATABASE_URL = url;

const CHAIN_ID = 97;
const tokenA = "0x1111111111111111111111111111111111111111";
const tokenB = "0x2222222222222222222222222222222222222222";

function savepointPool(client) {
  let depth = 0;
  return {
    connect: async () => ({
      query: (text, params) => {
        const sql = String(text).trim().toLowerCase();
        if (sql === "begin") { depth += 1; return client.query(`savepoint vb_${depth}`); }
        if (sql === "commit") { const d = depth; depth -= 1; return client.query(`release savepoint vb_${d}`); }
        if (sql === "rollback") { const d = depth; depth -= 1; return client.query(`rollback to savepoint vb_${d}`); }
        return client.query(text, params);
      },
      release() {},
    }),
    query: (text, params) => client.query(text, params),
  };
}

async function insertVoteBattle(client, id, { endsAt, durationHours = 6 }) {
  await client.query(
    `insert into public.arena_battles (
       id, chain_id, state, source, stake_native, offered_stake_native, offer_from_token, offer_count,
       duration_hours, offered_duration_hours, native_symbol, challenger_token, defender_token, tournament_id,
       participants, challenger_start_mcap_usd, defender_start_mcap_usd, winner_token, started_at, ends_at, finished_at,
       creator_address, featured, battle_mode, contest_scoring_version, competition_generation
     ) values ($1,$2,'live','queue',0.1,0.1,$3,0,$4,$4,'BNB',$3,$5,null,$6::jsonb,100,100,null,now() - interval '6 hours',$7::timestamptz,null,
       '0x3333333333333333333333333333333333333333',false,'vote','vote_tournament_v1','arena_competition_v2')`,
    [id, CHAIN_ID, tokenA, durationHours, tokenB, JSON.stringify([
      { tokenId: tokenA, tokenAddress: tokenA, tokenName: "Alpha", symbol: "ALPHA" },
      { tokenId: tokenB, tokenAddress: tokenB, tokenName: "Beta", symbol: "BETA" },
    ]), endsAt],
  );
}

test("vote battle on the live schema: votes, boosts, settlement, Final Salvo", { skip: url ? false : "STAGING_DATABASE_URL not set" }, async () => {
  const { pool } = await import("../../server/db.js");
  const runtime = await import("./arenaBattleVoteRuntime.js");
  const finalizer = await import("./arenaVoteTournamentFinalizationService.js");
  const client = await pool.connect();
  const q = (text, params) => client.query(text, params);
  const fakePool = savepointPool(client);
  const suffix = Date.now().toString(36);
  const decisiveId = `vbtest-${suffix}-a`;
  const tiedId = `vbtest-${suffix}-b`;
  try {
    await client.query("begin");

    // A 6-hour vote battle is accepted by the mode-aware duration check and
    // the normal-mode trigger leaves its scoring columns alone.
    await insertVoteBattle(client, decisiveId, { endsAt: new Date(Date.now() + 3600_000).toISOString() });
    const battle = await runtime.loadVoteBattle(q, decisiveId);
    assert.equal(battle.battle_mode, "vote");
    assert.equal(battle.contest_scoring_version, "vote_tournament_v1");
    assert.equal(battle.competition_generation, "arena_competition_v2");
    assert.equal(Number(battle.duration_hours), 6);
    await client.query("savepoint pre_bad");
    await assert.rejects(
      () => insertVoteBattle(client, `${decisiveId}-bad`, { endsAt: new Date(Date.now() + 3600_000).toISOString(), durationHours: 72 }),
      /arena_battles_duration_check/,
    );
    await client.query("rollback to savepoint pre_bad");

    // Free votes: one per wallet, second attempt reports the used side.
    const availability = runtime.voteBattleAvailability(battle);
    assert.equal(availability.ok, true);
    const v1 = await runtime.recordVoteBattleFreeVote(q, battle, { wallet: "0xaaaa000000000000000000000000000000000001", side: "left" });
    assert.ok(v1.inserted);
    const v2 = await runtime.recordVoteBattleFreeVote(q, battle, { wallet: "0xaaaa000000000000000000000000000000000002", side: "right" });
    assert.ok(v2.inserted);
    const dup = await runtime.recordVoteBattleFreeVote(q, battle, { wallet: "0xaaaa000000000000000000000000000000000001", side: "right" });
    assert.equal(dup.inserted, null);
    assert.equal(dup.existingSide, "left");

    // A confirmed boost of 3 units on the right side scores 6 points.
    await client.query(
      `insert into public.arena_contest_actions (chain_id, tournament_id, battle_id, match_id, round_number, phase, salvo_index, side, wallet,
         action_type, boost_units, points, gross_native_raw, pool_native_raw, protocol_native_raw, tx_hash, log_index, confirmed_at)
       values ($1, null, $2, null, 1, 'regulation', null, 'right', $3, 'boost', 3, 6, 3000, 2700, 300, $4, 0, now())`,
      [CHAIN_ID, decisiveId, "0xaaaa000000000000000000000000000000000003", `0x${suffix.padEnd(64, "0")}`],
    );
    const score = await runtime.voteBattleScore(q, battle);
    assert.deepEqual(score, { leftPoints: 1, rightPoints: 7 });
    const rows = await runtime.listVoteBattleVotes(q, battle);
    assert.equal(rows.length, 2);

    // Not due yet.
    const early = await finalizer.finalizeDueVoteTournamentBattle(fakePool, decisiveId);
    assert.equal(early.settled, false);
    assert.equal(early.reason, "regulation-still-live");

    // Due: right wins 7-1, settlement lands with the operator-facing fields.
    // (5 minutes back: the finalizer compares against the local clock, and a
    // WSL clock can trail the database clock by more than a second.)
    await client.query(`update public.arena_battles set ends_at = now() - interval '5 minutes' where id = $1`, [decisiveId]);
    const settled = await finalizer.finalizeDueVoteTournamentBattle(fakePool, decisiveId);
    assert.equal(settled.settled, true, JSON.stringify(settled));
    assert.equal(settled.standalone, true);
    assert.equal(settled.winnerSide, "right");
    assert.equal(settled.winnerToken, tokenB);
    const after = (await client.query(
      `select state, winner_token, money_winner_token, mwl_result, mwl_draw, mwl_winner_token, settlement_version,
              settlement_scoring_version, settled_at, finished_at, participants
         from public.arena_battles where id = $1`,
      [decisiveId],
    )).rows[0];
    assert.equal(after.state, "finished");
    assert.equal(after.money_winner_token, tokenB);
    assert.equal(after.winner_token, tokenB);
    assert.equal(after.mwl_result, "right_win");
    assert.equal(after.mwl_draw, false);
    assert.equal(after.mwl_winner_token, tokenB);
    assert.equal(Number(after.settlement_version), 4);
    assert.equal(after.settlement_scoring_version, "vote_tournament_v1");
    assert.ok(after.settled_at && after.finished_at);
    assert.deepEqual(after.participants.map((p) => [p.votePoints, p.isLeading]), [[1, false], [7, true]]);
    const idempotent = await finalizer.finalizeDueVoteTournamentBattle(fakePool, decisiveId);
    assert.equal(idempotent.settled, true);
    assert.equal(idempotent.idempotent, true);
    const league = await client.query(
      `select token_address, kind, points from public.arena_league_point_events where battle_id = $1 order by token_address`,
      [decisiveId],
    );
    assert.deepEqual(league.rows.map((r) => [r.token_address, r.kind]), [[tokenA, "battle_loss"], [tokenB, "battle_win"]]);

    // Exact tie: Final Salvo begins with the identity the table requires.
    await insertVoteBattle(client, tiedId, { endsAt: new Date(Date.now() - 300_000).toISOString(), durationHours: 1 });
    const tied = await runtime.loadVoteBattle(q, tiedId);
    await runtime.recordVoteBattleFreeVote(q, tied, { wallet: "0xbbbb000000000000000000000000000000000001", side: "left" });
    await runtime.recordVoteBattleFreeVote(q, tied, { wallet: "0xbbbb000000000000000000000000000000000002", side: "right" });
    const salvo = await finalizer.finalizeDueVoteTournamentBattle(fakePool, tiedId);
    assert.equal(salvo.settled, false);
    assert.equal(salvo.phase, "final-salvo");
    const tiebreak = (await client.query(`select * from public.arena_vote_tiebreaks where battle_id = $1`, [tiedId])).rows[0];
    assert.ok(tiebreak, "tiebreak row");
    assert.equal(Number(tiebreak.chain_id), CHAIN_ID);
    assert.equal(tiebreak.match_id, tiedId);
    assert.equal(tiebreak.tournament_id, null);
    assert.equal(Number(tiebreak.round_number), 1);
    assert.equal(tiebreak.state, "salvo");
    assert.equal(Number(tiebreak.current_salvo_index), 1);
    assert.equal(runtime.voteBattleAvailability(tied, { tiebreak }).code, "FINAL_SALVO_ACTIVE");

    // One salvo vote for the left side, shot clock elapsed: still not
    // resolved after a single shot (best of five), so the next shot opens.
    await client.query(
      `insert into public.arena_contest_actions (chain_id, tournament_id, battle_id, match_id, round_number, phase, salvo_index, side, wallet,
         action_type, boost_units, points, gross_native_raw, pool_native_raw, protocol_native_raw, confirmed_at)
       values ($1, null, $2, $2, 1, 'salvo', 1, 'left', $3, 'free_vote', 0, 1, 0, 0, 0, now())`,
      [CHAIN_ID, tiedId, "0xbbbb000000000000000000000000000000000003"],
    );
    await client.query(`update public.arena_vote_tiebreaks set shot_ends_at = now() - interval '5 minutes' where battle_id = $1`, [tiedId]);
    const shot1 = await finalizer.advanceDueFinalSalvo(fakePool, tiedId);
    assert.equal(shot1.advanced, true, JSON.stringify(shot1));
    assert.equal(shot1.resolved, false);
    assert.deepEqual(shot1.uniqueVotes, { left: 1, right: 0 });
    assert.equal((await client.query(`select state from public.arena_battles where id = $1`, [tiedId])).rows[0].state, "live");

    await client.query("rollback");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
});
