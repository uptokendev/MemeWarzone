import {
  BONUS_POLICY_STATUS,
  CHAMPIONSHIP_EVENT_TYPE,
  CHAMPIONSHIP_STATE,
  canonicalChampionshipId,
  championshipPublicDto,
  quarterBoundsUtc,
} from "./arenaQuarterlyChampionshipMath.mjs";

function text(value) {
  return String(value || "").trim();
}

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function ensureChampionshipEpoch(db, { chainId, year, quarter }) {
  const chain = positiveInt(chainId);
  const y = positiveInt(year);
  const q = positiveInt(quarter);
  if (!chain || !y || !q || q > 4) throw new Error("invalid Championship epoch identity");
  const id = canonicalChampionshipId({ chainId: chain, year: y, quarter: q });
  const { opensAt, closesAt } = quarterBoundsUtc({ year: y, quarter: q });
  await db.query(
    `insert into public.arena_championship_epochs
       (id,event_type,chain_id,year,quarter,state,opens_at,closes_at)
     values ($1,$2,$3,$4,$5,'open',$6,$7)
     on conflict (chain_id,year,quarter) do nothing`,
    [id, CHAMPIONSHIP_EVENT_TYPE, chain, y, q, opensAt, closesAt],
  );
  const result = await db.query(
    `select * from public.arena_championship_epochs
      where chain_id=$1 and year=$2 and quarter=$3
      limit 1`,
    [chain, y, q],
  );
  const epoch = result.rows?.[0];
  if (!epoch) throw new Error("Championship epoch could not be resolved");
  if (String(epoch.id) !== id || String(epoch.event_type) !== CHAMPIONSHIP_EVENT_TYPE) {
    const error = new Error("Championship identity conflict");
    error.code = "CHAMPIONSHIP_IDENTITY_CONFLICT";
    throw error;
  }
  return epoch;
}

async function activeBonusPolicy(db, chainId) {
  const result = await db.query(
    `select version,chain_id
       from public.arena_championship_bonus_policies
      where active=true and status='approved' and (chain_id=$1 or chain_id is null)
      order by case when chain_id=$1 then 0 else 1 end,version asc`,
    [chainId],
  );
  if (!result.rows?.length) return { ok: false, status: BONUS_POLICY_STATUS.NOT_CONFIGURED, reason: "CHAMPIONSHIP_BONUS_POLICY_NOT_CONFIGURED" };
  const exact = result.rows.filter((row) => Number(row.chain_id) === Number(chainId));
  const candidates = exact.length ? exact : result.rows.filter((row) => row.chain_id == null);
  if (candidates.length !== 1) return { ok: false, status: BONUS_POLICY_STATUS.NOT_CONFIGURED, reason: "CHAMPIONSHIP_BONUS_POLICY_AMBIGUOUS" };
  const policy = candidates[0];
  const rules = await db.query(
    `select placement,bonus_points
       from public.arena_championship_bonus_rules
      where policy_version=$1
      order by placement asc`,
    [policy.version],
  );
  if (!rules.rows?.length) return { ok: false, status: BONUS_POLICY_STATUS.NOT_CONFIGURED, reason: "CHAMPIONSHIP_BONUS_POLICY_EMPTY" };
  return { ok: true, status: BONUS_POLICY_STATUS.CONFIGURED, version: String(policy.version), rules: rules.rows };
}

async function snapshotMwlResults(db, seasonId) {
  const existing = await db.query(
    `select * from public.arena_championship_mwl_results
      where season_id=$1 order by final_rank asc`,
    [seasonId],
  );
  if (existing.rows?.length) return existing.rows;

  const rows = await db.query(
    `select token_address,token_name,symbol,points,wins,losses,finished_fights
       from public.arena_league_entries
      where season_id=$1
      order by points desc,wins desc,token_address asc`,
    [seasonId],
  );
  let rank = 0;
  for (const row of rows.rows || []) {
    rank += 1;
    await db.query(
      `insert into public.arena_championship_mwl_results
         (season_id,token_address,token_name,symbol,final_rank,mwl_points,wins,losses,finished_fights)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (season_id,token_address) do nothing`,
      [seasonId, row.token_address, row.token_name || "", row.symbol || "", rank, row.points || 0, row.wins || 0, row.losses || 0, row.finished_fights || 0],
    );
  }
  return (await db.query(
    `select * from public.arena_championship_mwl_results
      where season_id=$1 order by final_rank asc`,
    [seasonId],
  )).rows || [];
}

export async function applyMwlChampionshipBonus(db, seasonId) {
  const transferResult = await db.query(
    `select t.*,e.state as epoch_state,e.chain_id
       from public.arena_championship_mwl_transfers t
       join public.arena_championship_epochs e on e.id=t.epoch_id
      where t.season_id=$1
      for update of t`,
    [seasonId],
  );
  const transfer = transferResult.rows?.[0];
  if (!transfer) return { ok: false, reason: "CHAMPIONSHIP_TRANSFER_NOT_FOUND" };
  if (transfer.status === "applied") {
    return { ok: true, idempotent: true, status: "applied", policyVersion: transfer.policy_version, epochId: transfer.epoch_id };
  }
  if (transfer.epoch_state !== CHAMPIONSHIP_STATE.OPEN) {
    return { ok: false, reason: "CHAMPIONSHIP_EPOCH_CLOSED", status: transfer.status, epochId: transfer.epoch_id };
  }

  const policy = await activeBonusPolicy(db, Number(transfer.chain_id));
  if (!policy.ok) return { ok: true, pending: true, status: "pending_policy", policyStatus: policy.status, reason: policy.reason, epochId: transfer.epoch_id };

  const rules = new Map(policy.rules.map((rule) => [Number(rule.placement), Number(rule.bonus_points)]));
  const finalRows = await snapshotMwlResults(db, seasonId);
  let credited = 0;
  for (const row of finalRows) {
    const points = rules.get(Number(row.final_rank));
    if (!(points > 0)) continue;
    const result = await db.query(
      `with inserted as (
         insert into public.arena_championship_point_events
           (epoch_id,token_address,source_kind,source_id,source_season_id,points,policy_version,metadata)
         values ($1,$2,'mwl_bonus',$3,$3,$4,$5,jsonb_build_object('finalRank',$6::integer))
         on conflict (epoch_id,source_kind,source_id,token_address) do nothing
         returning points
       )
       insert into public.arena_championship_entries
         (epoch_id,token_address,token_name,symbol,mwl_bonus_points)
       select $1,$2,$7,$8,points from inserted
       on conflict (epoch_id,token_address) do update
         set token_name=excluded.token_name,
             symbol=excluded.symbol,
             mwl_bonus_points=public.arena_championship_entries.mwl_bonus_points + excluded.mwl_bonus_points
       returning token_address`,
      [transfer.epoch_id, row.token_address, seasonId, points, policy.version, row.final_rank, row.token_name || "", row.symbol || ""],
    );
    if (result.rowCount > 0) credited += 1;
  }

  await db.query(
    `update public.arena_championship_mwl_transfers
        set status='applied',policy_version=$2,applied_at=coalesce(applied_at,now()),updated_at=now()
      where season_id=$1`,
    [seasonId, policy.version],
  );
  return { ok: true, status: "applied", policyVersion: policy.version, epochId: transfer.epoch_id, credited };
}

export async function finalizeMwlForChampionship(pool, seasonId) {
  const id = text(seasonId);
  if (!id) return { ok: false, reason: "MWL_SEASON_REQUIRED" };
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query(`select * from public.arena_league_seasons where id=$1 for update`, [id]);
    const season = result.rows?.[0];
    if (!season) {
      await client.query("rollback");
      return { ok: false, reason: "MWL_SEASON_NOT_FOUND" };
    }
    const epoch = await ensureChampionshipEpoch(client, { chainId: season.chain_id, year: season.year, quarter: season.quarter });
    if (epoch.state !== CHAMPIONSHIP_STATE.OPEN && !season.finalized_at) {
      await client.query("rollback");
      return { ok: false, reason: "CHAMPIONSHIP_EPOCH_CLOSED", championshipId: epoch.id };
    }

    await client.query(
      `update public.arena_league_seasons
          set regular_season_closed=true,
              frozen_at=coalesce(frozen_at,now()),
              finalized_at=coalesce(finalized_at,now()),
              state='completed',
              active=false,
              championship_epoch_id=$2,
              updated_at=now()
        where id=$1`,
      [id, epoch.id],
    );

    const snapshot = await snapshotMwlResults(client, id);
    await client.query(
      `insert into public.arena_championship_mwl_transfers (season_id,epoch_id,status)
       values ($1,$2,'pending_policy')
       on conflict (season_id) do nothing`,
      [id, epoch.id],
    );
    const transfer = await applyMwlChampionshipBonus(client, id);
    if (!transfer.ok && transfer.reason !== "CHAMPIONSHIP_EPOCH_CLOSED") {
      await client.query("rollback");
      return transfer;
    }
    await client.query("commit");
    return {
      ok: true,
      idempotent: Boolean(season.finalized_at),
      seasonId: id,
      chainId: Number(season.chain_id),
      year: Number(season.year),
      quarter: Number(season.quarter),
      mwlWinner: snapshot[0] || null,
      quarterlyChampionshipId: String(epoch.id),
      championshipEventType: CHAMPIONSHIP_EVENT_TYPE,
      bonusTransfer: transfer,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function readEpochRows(db, epoch) {
  if (epoch.state === CHAMPIONSHIP_STATE.CLOSED) {
    const final = await db.query(
      `select token_address,token_name,symbol,final_rank,base_points,mwl_bonus_points,total_points
         from public.arena_championship_final_standings
        where epoch_id=$1 order by final_rank asc`,
      [epoch.id],
    );
    return { entries: [], finalEntries: final.rows || [] };
  }
  const live = await db.query(
    `select token_address,token_name,symbol,base_points,mwl_bonus_points,total_points,
            row_number() over (order by total_points desc,token_address asc)::int as rank
       from public.arena_championship_entries
      where epoch_id=$1
      order by total_points desc,token_address asc`,
    [epoch.id],
  );
  return { entries: live.rows || [], finalEntries: [] };
}

export async function readChampionshipStanding(db, { chainId, year, quarter, epochId } = {}) {
  let result;
  if (epochId) {
    result = await db.query(`select * from public.arena_championship_epochs where id=$1 limit 1`, [text(epochId)]);
  } else {
    result = await db.query(
      `select * from public.arena_championship_epochs where chain_id=$1 and year=$2 and quarter=$3 limit 1`,
      [positiveInt(chainId), positiveInt(year), positiveInt(quarter)],
    );
  }
  const epoch = result.rows?.[0];
  if (!epoch) return null;
  const rows = await readEpochRows(db, epoch);
  const dto = championshipPublicDto(epoch, rows.entries, rows.finalEntries);
  const pending = await db.query(
    `select count(*)::int as count from public.arena_championship_mwl_transfers where epoch_id=$1 and status='pending_policy'`,
    [epoch.id],
  );
  return {
    ...dto,
    pendingBonusTransfers: Number(pending.rows?.[0]?.count || 0),
    bonusPolicyStatus: Number(pending.rows?.[0]?.count || 0) > 0 ? BONUS_POLICY_STATUS.NOT_CONFIGURED : null,
  };
}

export async function closeChampionshipEpoch(pool, { chainId, year, quarter, epochId, nowMs = Date.now() } = {}) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const params = epochId ? [text(epochId)] : [positiveInt(chainId), positiveInt(year), positiveInt(quarter)];
    const where = epochId ? "id=$1" : "chain_id=$1 and year=$2 and quarter=$3";
    const result = await client.query(`select * from public.arena_championship_epochs where ${where} for update`, params);
    const epoch = result.rows?.[0];
    if (!epoch) {
      await client.query("rollback");
      return { ok: false, reason: "CHAMPIONSHIP_EPOCH_NOT_FOUND" };
    }
    if (epoch.state === CHAMPIONSHIP_STATE.CLOSED) {
      await client.query("commit");
      return { ok: true, idempotent: true, championship: await readChampionshipStanding(pool, { epochId: epoch.id }), payoutPolicy: "NOT_AUTHORITATIVE" };
    }
    const closesAtMs = new Date(epoch.closes_at).getTime();
    if (!Number.isFinite(closesAtMs) || Number(nowMs) < closesAtMs) {
      await client.query("rollback");
      return { ok: false, reason: "CHAMPIONSHIP_EPOCH_NOT_ENDED", closesAt: epoch.closes_at };
    }
    const pending = await client.query(
      `select count(*)::int as count from public.arena_championship_mwl_transfers where epoch_id=$1 and status<>'applied'`,
      [epoch.id],
    );
    if (Number(pending.rows?.[0]?.count || 0) > 0) {
      await client.query("rollback");
      return { ok: false, reason: "CHAMPIONSHIP_BONUS_TRANSFERS_PENDING", pendingTransfers: Number(pending.rows[0].count) };
    }

    const standing = await client.query(
      `select token_address,token_name,symbol,base_points,mwl_bonus_points,total_points,
              row_number() over (order by total_points desc,token_address asc)::int as final_rank
         from public.arena_championship_entries
        where epoch_id=$1
        order by total_points desc,token_address asc`,
      [epoch.id],
    );
    const finalizedAt = new Date(Number(nowMs)).toISOString();
    for (const row of standing.rows || []) {
      await client.query(
        `insert into public.arena_championship_final_standings
           (epoch_id,token_address,token_name,symbol,final_rank,base_points,mwl_bonus_points,total_points,finalized_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (epoch_id,token_address) do nothing`,
        [epoch.id, row.token_address, row.token_name || "", row.symbol || "", row.final_rank, row.base_points || 0, row.mwl_bonus_points || 0, row.total_points || 0, finalizedAt],
      );
    }
    await client.query(
      `update public.arena_championship_epochs
          set state='closed',closed_at=coalesce(closed_at,$2),updated_at=now()
        where id=$1 and state='open'`,
      [epoch.id, finalizedAt],
    );
    await client.query("commit");
    return { ok: true, idempotent: false, championship: await readChampionshipStanding(pool, { epochId: epoch.id }), payoutPolicy: "NOT_AUTHORITATIVE" };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
