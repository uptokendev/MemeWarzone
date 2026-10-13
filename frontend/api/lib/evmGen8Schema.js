/**
 * Guard for the gen-8 indexer tables (db/migrations/20261011_000010_evm_gen8_indexer.sql). The API ships before the
 * migration is applied on every database, so every gen-8 read first asks whether its table exists (to_regclass, cached
 * for a minute per pool) and falls back to the pre-gen-8 behaviour when it does not. A read that still meets a missing
 * table or column (42P01 / 42703) is treated the same way. Never throws.
 */
const TTL_MS = 60_000;
const cache = new WeakMap(); // db -> { at, value }

const EMPTY = Object.freeze({ pools: false, accruals: false, routeRuns: false, sidePools: false, phase: false });

export function isSchemaMissingError(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

/**
 * Which gen-8 tables exist on `db` ({ pools, accruals, routeRuns, sidePools, phase }). `phase` is the column probe of
 * the fix-round migration (20261012_000012: evm_gen8_pools.open_at and last_phase); it is on only when both exist, and
 * only then do readers apply the price-phase rule (graduated = latched AND last_phase 'post').
 */
export async function gen8Tables(db, { now = Date.now() } = {}) {
  if (!db || typeof db.query !== "function") return EMPTY;
  const hit = cache.get(db);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  try {
    const { rows } = await db.query(
      `select to_regclass('public.evm_gen8_pools') is not null as pools,
              to_regclass('public.evm_gen8_fee_accruals') is not null as accruals,
              to_regclass('public.evm_gen8_route_runs') is not null as route_runs,
              to_regclass('public.evm_gen8_side_pools') is not null as side_pools,
              (select count(*) = 2 from pg_attribute
                where attrelid = to_regclass('public.evm_gen8_pools') and attname in ('open_at', 'last_phase') and not attisdropped) as phase`,
    );
    const r = rows?.[0] || {};
    const value = Object.freeze({ pools: Boolean(r.pools), accruals: Boolean(r.accruals), routeRuns: Boolean(r.route_runs), sidePools: Boolean(r.side_pools), phase: Boolean(r.pools && r.phase) });
    cache.set(db, { at: now, value });
    return value;
  } catch (error) {
    console.warn("[gen8] schema check failed; gen-8 reads off", error?.message || error);
    return EMPTY;
  }
}

/** Test hook. */
export function clearGen8SchemaCache(db) {
  if (db) cache.delete(db);
}
