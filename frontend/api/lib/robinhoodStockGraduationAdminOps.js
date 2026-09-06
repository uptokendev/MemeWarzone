import { pool } from "../../server/db.js";
import {
  RegistryVersionConflictError,
  deriveEffectiveAuthority,
  evaluateRobinhoodStockHealth,
} from "./robinhoodStockGraduationRegistry.js";

export async function rescanRobinhoodStockHealthVersioned({ id, expectedVersion, operatorIdentity, reason = "manual rescan" }) {
  const initial = await pool.query(`select * from public.robinhood_stock_token_registry where id=$1::uuid`, [id]);
  if (!initial.rows[0]) return null;
  const health = await evaluateRobinhoodStockHealth(initial.rows[0]);

  const client = await pool.connect();
  try {
    await client.query("begin");
    const locked = await client.query(`select * from public.robinhood_stock_token_registry where id=$1::uuid for update`, [id]);
    const row = locked.rows[0];
    if (!row) {
      await client.query("rollback");
      return null;
    }
    if (Number(row.state_version) !== Number(expectedVersion)) {
      throw new RegistryVersionConflictError({ id: row.id, stateVersion: Number(row.state_version) });
    }

    const staged = {
      ...row,
      automated_health_status: health.status,
      automated_health_reason: health.reason,
      oracle_feed_address: health.route?.oracleFeed ?? row.oracle_feed_address,
      acquisition_pool_address: health.route?.acquisitionPool ?? row.acquisition_pool_address,
      route_enabled: health.route?.enabled ?? false,
      last_health_check_at: new Date(),
    };
    const authority = deriveEffectiveAuthority(staged, { healthFresh: true });
    const updated = await client.query(
      `update public.robinhood_stock_token_registry
          set automated_health_status=$2,
              automated_health_reason=$3,
              oracle_feed_address=$4,
              acquisition_pool_address=$5,
              route_enabled=$6,
              enabled_for_graduation=$7,
              enabled_for_discovery=$8,
              enabled_for_trading=$9,
              last_health_check_at=now(),
              state_version=state_version+1,
              updated_at=now()
        where id=$1::uuid returning *`,
      [id, health.status, health.reason, health.route?.oracleFeed ?? row.oracle_feed_address, health.route?.acquisitionPool ?? row.acquisition_pool_address, health.route?.enabled ?? false, authority.enabledForGraduation, authority.enabledForDiscovery, authority.enabledForTrading],
    );
    const next = updated.rows[0];
    await client.query(
      `insert into public.robinhood_stock_token_registry_audit
        (registry_id, action, reason, operator_identity, previous_state, next_state, previous_version, next_version)
       values ($1,'rescan',$2,$3,$4::jsonb,$5::jsonb,$6,$7)`,
      [id, String(reason || "manual rescan"), operatorIdentity, JSON.stringify(row), JSON.stringify(next), Number(row.state_version), Number(next.state_version)],
    );
    await client.query("commit");
    return next;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
