import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  closeChampionshipEpoch,
  finalizeMwlForChampionship,
  readChampionshipStanding,
} from "./arenaQuarterlyChampionship.js";

const { Pool } = pg;
const databaseUrl = String(process.env.DATABASE_URL || "").trim();

async function insertSeason(pool, { id, month, entries }) {
  await pool.query(
    `insert into public.arena_league_seasons
       (id,chain_id,label,state,week,month,quarter,year,reset_at,active,mwl_epoch_key)
     values ($1,56,$2,'live',1,$3,3,2026,'2026-09-30T00:00:00Z',true,$1)`,
    [id, `Major War League 2026-${String(month).padStart(2, "0")}`, month],
  );
  for (const entry of entries) {
    await pool.query(
      `insert into public.arena_league_entries
         (season_id,token_address,token_name,symbol,points,wins,losses,finished_fights)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, entry.token, entry.name, entry.symbol, entry.points, entry.wins, entry.losses || 0, entry.fights || 5],
    );
  }
}

test("Quarterly Championship DB lifecycle is continuous, exact-once, close-safe, and legacy-safe", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const policySeed = await pool.query(`select count(*)::int as count from public.arena_championship_bonus_policies`);
    assert.equal(Number(policySeed.rows[0].count), 0, "production migration must not invent MWL bonus constants");

    await pool.query(
      `insert into public.arena_tournaments
         (id,chain_id,name,status,origin,registration_mode,buy_in_native,native_symbol,terms,starts_at,cap,created_by)
       values ('legacy-qf-2026-q2-c56',56,'Historical Quarter Finals','finished','quarter_finals','invite_only',0,'BNB','historical compatibility row','2026-06-01T00:00:00Z',8,'legacy')`,
    );

    await insertSeason(pool, {
      id: "mwl-2026-m07-c56",
      month: 7,
      entries: [
        { token: "alpha", name: "Alpha", symbol: "ALPHA", points: 30, wins: 8 },
        { token: "bravo", name: "Bravo", symbol: "BRAVO", points: 29, wins: 9 },
        { token: "charlie", name: "Charlie", symbol: "CHARLIE", points: 28, wins: 10 },
      ],
    });

    const julyNoPolicy = await finalizeMwlForChampionship(pool, "mwl-2026-m07-c56");
    assert.equal(julyNoPolicy.ok, true);
    assert.equal(julyNoPolicy.mwlWinner.token_address, "alpha");
    assert.equal(julyNoPolicy.quarterlyChampionshipId, "quarterly-championship-2026-q3-c56");
    assert.equal(julyNoPolicy.bonusTransfer.status, "pending_policy");
    assert.equal(julyNoPolicy.bonusTransfer.pending, true);
    assert.equal(julyNoPolicy.bonusTransfer.reason, "CHAMPIONSHIP_BONUS_POLICY_NOT_CONFIGURED");

    const julySeason = await pool.query(`select state,active,quarter_finals_tournament_id from public.arena_league_seasons where id='mwl-2026-m07-c56'`);
    assert.equal(julySeason.rows[0].state, "completed");
    assert.equal(julySeason.rows[0].active, false);
    assert.equal(julySeason.rows[0].quarter_finals_tournament_id, null);

    const julySnapshot = await pool.query(`select token_address,final_rank from public.arena_championship_mwl_results where season_id='mwl-2026-m07-c56' order by final_rank`);
    assert.deepEqual(julySnapshot.rows.map((row) => [row.token_address, row.final_rank]), [["alpha", 1], ["bravo", 2], ["charlie", 3]]);
    const beforePolicyStanding = await readChampionshipStanding(pool, { epochId: julyNoPolicy.quarterlyChampionshipId });
    assert.equal(beforePolicyStanding.entries.length, 0);
    assert.equal(beforePolicyStanding.pendingBonusTransfers, 1);

    // TEST FIXTURE ONLY. These values prove configurable placement transfer;
    // they are deliberately not seeded by the production migration.
    await pool.query(
      `insert into public.arena_championship_bonus_policies
         (version,status,active,approved_by,approved_at)
       values ('TEST_FIXTURE_V1','approved',true,'ci-fixture',now())`,
    );
    await pool.query(
      `insert into public.arena_championship_bonus_rules (policy_version,placement,bonus_points)
       values ('TEST_FIXTURE_V1',1,7),('TEST_FIXTURE_V1',2,3)`,
    );

    const julyApplied = await finalizeMwlForChampionship(pool, "mwl-2026-m07-c56");
    assert.equal(julyApplied.ok, true);
    assert.equal(julyApplied.idempotent, true);
    assert.equal(julyApplied.bonusTransfer.status, "applied");
    assert.equal(julyApplied.bonusTransfer.credited, 2);

    let live = await readChampionshipStanding(pool, { epochId: julyNoPolicy.quarterlyChampionshipId });
    assert.deepEqual(live.entries.map((entry) => [entry.tokenAddress, entry.mwlBonusPoints]), [["alpha", 7], ["bravo", 3]]);
    assert.equal(live.entries.some((entry) => entry.tokenAddress === "charlie"), false, "non-qualifying placement must not receive a bonus");

    const julyReplay = await finalizeMwlForChampionship(pool, "mwl-2026-m07-c56");
    assert.equal(julyReplay.ok, true);
    assert.equal(julyReplay.bonusTransfer.idempotent, true);
    live = await readChampionshipStanding(pool, { epochId: julyNoPolicy.quarterlyChampionshipId });
    assert.deepEqual(live.entries.map((entry) => [entry.tokenAddress, entry.mwlBonusPoints]), [["alpha", 7], ["bravo", 3]], "replay must not double-credit");

    await insertSeason(pool, {
      id: "mwl-2026-m08-c56",
      month: 8,
      entries: [
        { token: "bravo", name: "Bravo", symbol: "BRAVO", points: 32, wins: 10 },
        { token: "charlie", name: "Charlie", symbol: "CHARLIE", points: 31, wins: 9 },
        { token: "alpha", name: "Alpha", symbol: "ALPHA", points: 30, wins: 8 },
      ],
    });
    const augustApplied = await finalizeMwlForChampionship(pool, "mwl-2026-m08-c56");
    assert.equal(augustApplied.ok, true);
    assert.equal(augustApplied.bonusTransfer.status, "applied");
    live = await readChampionshipStanding(pool, { epochId: julyNoPolicy.quarterlyChampionshipId });
    assert.deepEqual(live.entries.map((entry) => [entry.tokenAddress, entry.mwlBonusPoints]), [["bravo", 10], ["alpha", 7], ["charlie", 3]]);
    assert.equal(live.entries[0].tokenAddress, "bravo", "a later MWL must be able to change Championship rank");

    const alphaEvents = await pool.query(`select source_id,points from public.arena_championship_point_events where token_address='alpha' order by source_id`);
    assert.deepEqual(alphaEvents.rows.map((row) => row.source_id), ["mwl-2026-m07-c56"], "August rank 3 must not receive an unauthorized bonus");

    const qfRows = await pool.query(`select id,name,origin from public.arena_tournaments where origin='quarter_finals' order by id`);
    assert.deepEqual(qfRows.rows, [{ id: "legacy-qf-2026-q2-c56", name: "Historical Quarter Finals", origin: "quarter_finals" }], "new MWL close must not create or rewrite quarter-final tournaments");

    const earlyClose = await closeChampionshipEpoch(pool, {
      epochId: julyNoPolicy.quarterlyChampionshipId,
      nowMs: Date.parse("2026-09-30T23:59:59.000Z"),
    });
    assert.equal(earlyClose.ok, false);
    assert.equal(earlyClose.reason, "CHAMPIONSHIP_EPOCH_NOT_ENDED");

    const closed = await closeChampionshipEpoch(pool, {
      epochId: julyNoPolicy.quarterlyChampionshipId,
      nowMs: Date.parse("2026-10-01T00:00:01.000Z"),
    });
    assert.equal(closed.ok, true);
    assert.equal(closed.idempotent, false);
    assert.equal(closed.payoutPolicy, "NOT_AUTHORITATIVE");
    assert.equal(closed.championship.state, "closed");
    assert.equal(closed.championship.entries[0].tokenAddress, "bravo");

    const closedReplay = await closeChampionshipEpoch(pool, {
      epochId: julyNoPolicy.quarterlyChampionshipId,
      nowMs: Date.parse("2026-10-02T00:00:00.000Z"),
    });
    assert.equal(closedReplay.ok, true);
    assert.equal(closedReplay.idempotent, true);
    assert.equal(closedReplay.championship.entries[0].tokenAddress, "bravo");

    await insertSeason(pool, {
      id: "mwl-2026-m09-c56",
      month: 9,
      entries: [
        { token: "charlie", name: "Charlie", symbol: "CHARLIE", points: 40, wins: 12 },
        { token: "alpha", name: "Alpha", symbol: "ALPHA", points: 39, wins: 11 },
      ],
    });
    const lateMwl = await finalizeMwlForChampionship(pool, "mwl-2026-m09-c56");
    assert.equal(lateMwl.ok, false);
    assert.equal(lateMwl.reason, "CHAMPIONSHIP_EPOCH_CLOSED");
    const septemberState = await pool.query(`select state,active,finalized_at from public.arena_league_seasons where id='mwl-2026-m09-c56'`);
    assert.equal(septemberState.rows[0].state, "live");
    assert.equal(septemberState.rows[0].active, true);
    assert.equal(septemberState.rows[0].finalized_at, null);

    const afterClose = await readChampionshipStanding(pool, { epochId: julyNoPolicy.quarterlyChampionshipId });
    assert.equal(afterClose.entries[0].tokenAddress, "bravo");
    assert.deepEqual(afterClose.entries.map((entry) => [entry.tokenAddress, entry.totalPoints]), closed.championship.entries.map((entry) => [entry.tokenAddress, entry.totalPoints]));
  } finally {
    await pool.end();
  }
});
