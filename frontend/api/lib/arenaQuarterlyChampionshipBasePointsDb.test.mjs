import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = String(process.env.DATABASE_URL || "").trim();

async function insertEpoch(pool, { id, chainId, year, quarter, opensAt, closesAt }) {
  await pool.query(
    `insert into public.arena_championship_epochs
       (id,event_type,chain_id,year,quarter,state,opens_at,closes_at)
     values ($1,'quarterly_championship',$2,$3,$4,'open',$5,$6)
     on conflict (id) do nothing`,
    [id, chainId, year, quarter, opensAt, closesAt],
  );
}

async function insertSeason(pool, { id, chainId, year, month, quarter, epochId }) {
  await pool.query(
    `insert into public.arena_league_seasons
       (id,chain_id,label,state,week,month,quarter,year,reset_at,active,mwl_epoch_key,championship_epoch_id)
     values ($1,$2,$3,'live',1,$4,$5,$6,$7,false,$1,$8)`,
    [id, chainId, `MWL ${id}`, month, quarter, year, `${year}-${String(month).padStart(2, "0")}-28T00:00:00Z`, epochId],
  );
}

async function insertEntry(pool, { seasonId, token, name = "Imported Token", symbol = "IMPT" }) {
  await pool.query(
    `insert into public.arena_league_entries
       (season_id,token_address,token_name,symbol,points,wins,losses,finished_fights)
     values ($1,$2,$3,$4,0,0,0,0)`,
    [seasonId, token, name, symbol],
  );
}

async function insertPoint(pool, { id = null, seasonId, token, kind, points, createdAt, battleId = null }) {
  const result = await pool.query(
    `insert into public.arena_league_point_events
       (id,season_id,token_address,kind,points,battle_id,created_at)
     values (coalesce($1::uuid,gen_random_uuid()),$2,$3,$4,$5,$6,$7)
     on conflict (id) do nothing
     returning id`,
    [id, seasonId, token, kind, points, battleId, createdAt],
  );
  return result.rows[0]?.id || id;
}

async function standing(pool, epochId, token) {
  const result = await pool.query(
    `select token_address,base_points,mwl_bonus_points,total_points
       from public.arena_championship_entries
      where epoch_id=$1 and token_address=$2`,
    [epochId, token],
  );
  return result.rows[0] || null;
}

test("authoritative MWL point ledger feeds one continuous quarterly base standing exactly once", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const chainId = 560077;
  const token = "SoLCaseSensitiveImportedMintABC";
  const q3 = `quarterly-championship-2026-q3-c${chainId}`;
  const q4 = `quarterly-championship-2026-q4-c${chainId}`;
  try {
    await insertEpoch(pool, {
      id: q3,
      chainId,
      year: 2026,
      quarter: 3,
      opensAt: "2026-07-01T00:00:00Z",
      closesAt: "2026-10-01T00:00:00Z",
    });
    await insertEpoch(pool, {
      id: q4,
      chainId,
      year: 2026,
      quarter: 4,
      opensAt: "2026-10-01T00:00:00Z",
      closesAt: "2027-01-01T00:00:00Z",
    });

    await insertSeason(pool, { id: `mwl-2026-m07-c${chainId}`, chainId, year: 2026, month: 7, quarter: 3, epochId: q3 });
    await insertSeason(pool, { id: `mwl-2026-m08-c${chainId}`, chainId, year: 2026, month: 8, quarter: 3, epochId: q3 });
    await insertSeason(pool, { id: `mwl-2026-m10-c${chainId}`, chainId, year: 2026, month: 10, quarter: 4, epochId: q4 });
    for (const seasonId of [`mwl-2026-m07-c${chainId}`, `mwl-2026-m08-c${chainId}`, `mwl-2026-m10-c${chainId}`]) {
      await insertEntry(pool, { seasonId, token });
    }

    const julyEvent = await insertPoint(pool, {
      seasonId: `mwl-2026-m07-c${chainId}`,
      token,
      kind: "battle_win",
      points: 3,
      battleId: "battle-july",
      createdAt: "2026-07-10T12:00:00Z",
    });

    let q3Standing = await standing(pool, q3, token);
    assert.equal(Number(q3Standing.base_points), 3);
    assert.equal(q3Standing.token_address, token, "imported/Solana-style token identity must stay case-sensitive");

    const mirroredJuly = await pool.query(
      `select source_kind,source_id,points from public.arena_championship_point_events
        where epoch_id=$1 and token_address=$2 and source_kind='mwl_base'`,
      [q3, token],
    );
    assert.equal(mirroredJuly.rows.length, 1, "one eligible MWL event must create one Championship point event");
    assert.equal(mirroredJuly.rows[0].source_id, julyEvent);

    await insertPoint(pool, {
      id: julyEvent,
      seasonId: `mwl-2026-m07-c${chainId}`,
      token,
      kind: "battle_win",
      points: 3,
      battleId: "battle-july",
      createdAt: "2026-07-10T12:00:00Z",
    });
    q3Standing = await standing(pool, q3, token);
    assert.equal(Number(q3Standing.base_points), 3, "replay of the same source event must not double-credit");

    await insertPoint(pool, {
      seasonId: `mwl-2026-m08-c${chainId}`,
      token,
      kind: "checkin",
      points: 0.1,
      createdAt: "2026-08-02T09:00:00Z",
    });
    await insertPoint(pool, {
      seasonId: `mwl-2026-m08-c${chainId}`,
      token,
      kind: "dispatch",
      points: 0.25,
      createdAt: "2026-08-03T09:00:00Z",
    });
    const drawEvent = await insertPoint(pool, {
      seasonId: `mwl-2026-m08-c${chainId}`,
      token,
      kind: "battle_draw",
      points: 0,
      battleId: "battle-draw",
      createdAt: "2026-08-04T09:00:00Z",
    });

    q3Standing = await standing(pool, q3, token);
    assert.equal(Number(q3Standing.base_points), 3.35, "monthly MWL rollover must not reset quarterly accumulation");
    const drawMirror = await pool.query(
      `select points from public.arena_championship_point_events
        where epoch_id=$1 and source_kind='mwl_base' and source_id=$2`,
      [q3, drawEvent],
    );
    assert.equal(drawMirror.rows.length, 1, "zero-point authoritative draw still has exact source-event identity");
    assert.equal(Number(drawMirror.rows[0].points), 0);

    await insertPoint(pool, {
      seasonId: `mwl-2026-m10-c${chainId}`,
      token,
      kind: "battle_loss",
      points: 1,
      battleId: "battle-october",
      createdAt: "2026-10-05T12:00:00Z",
    });
    const q4Standing = await standing(pool, q4, token);
    assert.equal(Number(q4Standing.base_points), 1);
    q3Standing = await standing(pool, q3, token);
    assert.equal(Number(q3Standing.base_points), 3.35, "quarter rollover must not contaminate the prior quarter");

    const lateEvent = await insertPoint(pool, {
      seasonId: `mwl-2026-m08-c${chainId}`,
      token,
      kind: "battle_loss",
      points: 1,
      battleId: "late-q3-event",
      createdAt: "2026-10-02T12:00:00Z",
    });
    const lateMirror = await pool.query(
      `select 1 from public.arena_championship_point_events where source_kind='mwl_base' and source_id=$1`,
      [lateEvent],
    );
    assert.equal(lateMirror.rows.length, 0, "late event outside its bound quarter must not be credited into another quarter");
    q3Standing = await standing(pool, q3, token);
    assert.equal(Number(q3Standing.base_points), 3.35);
  } finally {
    await pool.end();
  }
});
