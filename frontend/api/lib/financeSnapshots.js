// Finance snapshots: the chain-derived finance reads, stored in the database.
//
// Why: every finance page used to read the chain on the request: fee-routing
// balances and wiring, payout vaults, creator fee vaults, arena pools, the
// operator fill cap, the indexer LP read, Binance spot. The caches were in the
// process (60 s) and were lost on every redeploy, so a page waited on dozens of
// public-RPC calls (Robinhood ~1 s each, Solana rate-limited) before it showed
// anything. Now the same builders run in the background (cron:finance-snapshots
// every 5 minutes, or a manual "Refresh now") and store the finished JSON in
// public.finance_snapshots. A request reads the row.
//
// Rules:
//   - The payload is exactly what the builder returned (JSON), so a fresh
//     snapshot gives the same numbers as a live read. Unknown stays unknown.
//   - A row older than REFRESH_MS is still served; a rebuild starts in the
//     background (one per key per process). Older than STALE_MS it is served
//     with stale: true, never blocked on RPC.
//   - No row yet (first run, or the table is not installed): build live once,
//     shared by every concurrent caller, and store it.
//   - A failed rebuild keeps the last good payload and records the error.
//
// Read-only towards the chain: the builders only call view methods.

import { AsyncLocalStorage } from "node:async_hooks";

export const SNAPSHOT_MIGRATION = "db/migrations/20261006_000001_finance_snapshots.sql";
export const SNAPSHOT_REFRESH_MS = Math.max(60_000, Number(process.env.FINANCE_SNAPSHOT_REFRESH_MS || 5 * 60_000) || 5 * 60_000);
export const SNAPSHOT_STALE_MS = Math.max(SNAPSHOT_REFRESH_MS, Number(process.env.FINANCE_SNAPSHOT_STALE_MS || 15 * 60_000) || 15 * 60_000);
// Without the table, a process-only copy is reused this long (the old cache TTL).
const MEMORY_ONLY_TTL_MS = 60_000;
// A DB row read in this process is reused this long before the row is read again.
const ROW_MEMO_MS = 15_000;
const TABLE_RECHECK_MS = 5 * 60_000;
const FAILURE_RETRY_MS = 60_000;

const usage = new AsyncLocalStorage();

/** Runs `fn` and collects every snapshot it read: [{key, builtAt, ageMs, stale, source}]. */
export function trackSnapshots(fn) {
  const used = [];
  return usage.run(used, async () => ({ value: await fn(), used }));
}

/** Runs `fn` with `used` (an array) collecting the snapshots it reads. */
export function runWithSnapshotUsage(used, fn) {
  return usage.run(used, fn);
}

function noteUsage(entry) {
  const list = usage.getStore();
  if (list && !list.some((e) => e.key === entry.key)) list.push(entry);
}

/**
 * The `snapshot` block a finance response carries: when the chain data was
 * read (the oldest snapshot used) and whether any part is stale.
 */
export function snapshotMeta(used, { nowMs = Date.now(), staleMs = SNAPSHOT_STALE_MS } = {}) {
  if (!used?.length) return null;
  let oldest = null;
  for (const entry of used) {
    if (!entry.builtAt) continue;
    if (!oldest || entry.builtAt < oldest) oldest = entry.builtAt;
  }
  const ageMs = oldest ? Math.max(0, nowMs - Date.parse(oldest)) : null;
  return {
    asOf: oldest,
    ageSeconds: ageMs == null ? null : Math.round(ageMs / 1000),
    stale: ageMs != null && ageMs > staleMs,
    staleAfterSeconds: Math.round(staleMs / 1000),
    sources: used.map((e) => ({ key: e.key, asOf: e.builtAt, source: e.source, ...(e.error ? { lastError: e.error } : {}) })),
  };
}

/** A stored snapshot block with its age recomputed for now. */
export function ageSnapshotMeta(meta, { nowMs = Date.now(), staleMs = SNAPSHOT_STALE_MS } = {}) {
  if (!meta?.asOf) return meta;
  const ageMs = Math.max(0, nowMs - Date.parse(meta.asOf));
  return { ...meta, ageSeconds: Math.round(ageMs / 1000), stale: ageMs > staleMs, staleAfterSeconds: Math.round(staleMs / 1000) };
}

function tableMissing(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

function readOnlyTx(error) {
  return error?.code === "25006";
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** JSON copy of a payload: what the browser would receive (no BigInt, no hidden fields). */
export function jsonCopy(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

/**
 * @param {object} options
 * @param {{query: Function}} options.db
 * @param {() => number} [options.nowMs]
 * @param {number} [options.refreshMs]
 * @param {number} [options.staleMs]
 * @param {boolean} [options.background]  start a rebuild in the background when a row is old (default true)
 * @param {object} [options.log]
 */
export function createSnapshotCache({ db, nowMs = () => Date.now(), refreshMs = SNAPSHOT_REFRESH_MS, staleMs = SNAPSHOT_STALE_MS, background = true, log = console } = {}) {
  const memo = new Map(); // key -> { value, builtAt, error, readAt, source }
  const building = new Map(); // key -> Promise<value>
  const reading = new Map(); // key -> Promise<row|null>
  const failures = new Map(); // key -> { error, at }: a failed live build with no copy to serve
  let missingUntil = 0;
  let writeBlockedLogged = false;

  const tableUsable = () => nowMs() >= missingUntil;

  async function readRow(key) {
    if (!db || !tableUsable()) return null;
    if (reading.has(key)) return reading.get(key);
    const job = (async () => {
      try {
        const { rows } = await db.query(
          "select payload, built_at, error, error_at from public.finance_snapshots where key = $1",
          [key],
        );
        const row = rows?.[0];
        if (!row || row.payload == null) return row ? { value: null, builtAt: null, error: row.error || null } : null;
        return { value: row.payload, builtAt: iso(row.built_at), error: row.error && row.error_at && row.built_at && new Date(row.error_at) > new Date(row.built_at) ? row.error : null };
      } catch (error) {
        if (tableMissing(error)) missingUntil = nowMs() + TABLE_RECHECK_MS;
        else log.warn?.(`[finance/snapshots] read ${key} failed`, error?.message || error);
        return null;
      } finally {
        reading.delete(key);
      }
    })();
    reading.set(key, job);
    return job;
  }

  async function writeRow(key, kind, value, builtAt, buildMs) {
    if (!db || !tableUsable()) return;
    try {
      await db.query(
        `insert into public.finance_snapshots (key, kind, payload, built_at, build_ms, error, error_at, updated_at)
         values ($1, $2, $3::jsonb, $4, $5, null, null, now())
         on conflict (key) do update set kind = excluded.kind, payload = excluded.payload, built_at = excluded.built_at,
           build_ms = excluded.build_ms, error = null, error_at = null, updated_at = now()`,
        [key, kind, JSON.stringify(value), builtAt, Math.max(0, Math.round(buildMs))],
      );
    } catch (error) {
      if (tableMissing(error)) missingUntil = nowMs() + TABLE_RECHECK_MS;
      else if (readOnlyTx(error)) { if (!writeBlockedLogged) { writeBlockedLogged = true; log.warn?.("[finance/snapshots] database is read-only here; snapshots stay in this process"); } }
      else log.warn?.(`[finance/snapshots] write ${key} failed`, error?.message || error);
    }
  }

  async function writeError(key, kind, message) {
    if (!db || !tableUsable()) return;
    try {
      await db.query(
        `insert into public.finance_snapshots (key, kind, error, error_at, updated_at) values ($1, $2, $3, now(), now())
         on conflict (key) do update set error = excluded.error, error_at = excluded.error_at, updated_at = now()`,
        [key, kind, String(message || "Rebuild failed.").slice(0, 500)],
      );
    } catch {
      // The last good payload stays; nothing else to do.
    }
  }

  /** Rebuilds one key now (shared by concurrent callers) and stores it. */
  function refresh(key, kind, build) {
    if (building.has(key)) return building.get(key);
    const job = (async () => {
      const started = nowMs();
      try {
        const built = jsonCopy(await build());
        const builtAt = new Date(nowMs()).toISOString();
        failures.delete(key);
        memo.set(key, { value: built, builtAt, error: null, readAt: nowMs(), source: "live" });
        await writeRow(key, kind, built, builtAt, nowMs() - started);
        return built;
      } catch (error) {
        const message = String(error?.message || error || "Rebuild failed.").slice(0, 500);
        const hit = memo.get(key);
        if (hit) hit.error = message;
        failures.set(key, { error, at: nowMs() });
        await writeError(key, kind, message);
        throw error;
      } finally {
        building.delete(key);
      }
    })();
    building.set(key, job);
    return job;
  }

  function refreshInBackground(key, kind, build) {
    if (!background || building.has(key)) return;
    refresh(key, kind, build).catch((error) => log.warn?.(`[finance/snapshots] background rebuild ${key} failed`, error?.message || error));
  }

  function serve(key, entry) {
    const ageMs = entry.builtAt ? nowMs() - Date.parse(entry.builtAt) : null;
    noteUsage({ key, builtAt: entry.builtAt, ageMs, stale: ageMs != null && ageMs > staleMs, source: entry.source, error: entry.error || null });
    return entry.value;
  }

  /**
   * The snapshot for `key`: from this process, else from the database, else
   * built live. Never waits on `build` when any copy exists.
   */
  async function get(key, kind, build) {
    const now = nowMs();
    const hit = memo.get(key);
    const usable = tableUsable() && db;
    if (hit && (now - hit.readAt < ROW_MEMO_MS || !usable)) {
      const age = hit.builtAt ? now - Date.parse(hit.builtAt) : Infinity;
      if (age >= (usable ? refreshMs : MEMORY_ONLY_TTL_MS)) refreshInBackground(key, kind, build);
      return serve(key, hit);
    }
    const row = await readRow(key);
    if (row?.value != null) {
      // A newer copy built in this process wins over an older row.
      const entry = hit && hit.builtAt && row.builtAt && hit.builtAt > row.builtAt
        ? { ...hit, readAt: nowMs() }
        : { value: row.value, builtAt: row.builtAt, error: row.error, readAt: nowMs(), source: "db" };
      memo.set(key, entry);
      const age = entry.builtAt ? nowMs() - Date.parse(entry.builtAt) : Infinity;
      if (age >= refreshMs) refreshInBackground(key, kind, build);
      return serve(key, entry);
    }
    if (hit) {
      // Row unreadable but this process has a copy: serve it, rebuild if old.
      const age = hit.builtAt ? nowMs() - Date.parse(hit.builtAt) : Infinity;
      if (age >= refreshMs) refreshInBackground(key, kind, build);
      hit.readAt = nowMs();
      return serve(key, hit);
    }
    // Nothing to serve. A source that just failed is not called again on every
    // request: the same error is returned for a minute.
    const failed = failures.get(key);
    if (failed && nowMs() - failed.at < FAILURE_RETRY_MS) throw failed.error;
    await refresh(key, kind, build);
    return serve(key, memo.get(key));
  }

  /** Metadata of every stored snapshot (no payloads), for the status view. */
  async function list() {
    if (!db) return { installed: false, rows: [] };
    try {
      const { rows } = await db.query(
        "select key, kind, built_at, build_ms, error, error_at, updated_at from public.finance_snapshots order by key",
      );
      return {
        installed: true,
        rows: rows.map((r) => {
          const builtAt = iso(r.built_at);
          const ageMs = builtAt ? nowMs() - Date.parse(builtAt) : null;
          return { key: r.key, kind: r.kind, builtAt, buildMs: r.build_ms ?? null, ageSeconds: ageMs == null ? null : Math.round(ageMs / 1000), stale: ageMs == null || ageMs > staleMs, error: r.error || null, errorAt: iso(r.error_at) };
        }),
      };
    } catch (error) {
      if (tableMissing(error)) return { installed: false, rows: [], migration: SNAPSHOT_MIGRATION };
      throw error;
    }
  }

  function clear() {
    memo.clear();
  }

  return { get, refresh, list, clear, readRow };
}

const caches = new WeakMap();
/** One snapshot cache per database handle (the API pool in production). */
export function snapshotCacheFor(db) {
  if (!db || typeof db !== "object") return createSnapshotCache({ db: null });
  if (!caches.has(db)) caches.set(db, createSnapshotCache({ db }));
  return caches.get(db);
}

// Snapshot keys. One place, so the cron and the request paths agree.
export const snapshotKeys = Object.freeze({
  feeRouting: (network, days) => `fee-routing:${network.chainId}:${network.cluster || ""}:${days}`,
  payouts: (network, days) => `payouts:${network.chainId}:${network.cluster || ""}:${days}`,
  indexerLp: (network) => `indexer-lp:${network.chainId}:${network.cluster || ""}`,
  upvoteApproval: (network) => `upvote-approval:${network.chainId}`,
  spot: (asset) => `spot:${asset}`,
  summary: (months) => `summary:${months}`,
});
