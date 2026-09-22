/**
 * Selection + loop logic for the `resolve-due` operator command.
 *
 * Settlement and on-chain resolution are two different things. The API worker
 * (frontend/scripts/run-arena-battle-realtime-worker.mjs) settles a battle in
 * the database: it scores it, writes the winner and flips state to 'finished'.
 * Nothing in that path talks to Solana. The arena pool on chain stays LIVE
 * until someone runs the resolver, which until now meant a human typing
 * `resolve --battle-id <id>`.
 *
 * This module is the scan that closes that gap: it asks the database which
 * chain-101 battles are settled, and hands each one to the existing
 * runOperatorJob('resolve'). It deliberately holds no chain logic and signs
 * nothing of its own -- planning, simulation and sending stay in
 * arena-operator-resolve.mjs, which is already tested.
 *
 * Everything here is pure and injectable so the loop can be tested without a
 * database or an RPC.
 */

export const SOLANA_ARENA_CHAIN_ID = 101;
export const DEFAULT_LOOKBACK_DAYS = 7;
export const DEFAULT_SCAN_LIMIT = 25;
export const DEFAULT_INTERVAL_MS = 30_000;

/**
 * Finished Solana battles, oldest settlement first, inside a lookback window.
 *
 * The window exists so a long-lived loop does not re-read the whole history
 * from chain on every pass. Anything older than the window that was never
 * resolved is a manual `resolve --battle-id` job, not a job for a scheduler
 * that is meant to keep up with live traffic.
 */
export function buildDueResolveQuery({ lookbackDays = DEFAULT_LOOKBACK_DAYS, limit = DEFAULT_SCAN_LIMIT } = {}) {
  const positive = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  };
  const days = positive(lookbackDays, DEFAULT_LOOKBACK_DAYS);
  const rows = positive(limit, DEFAULT_SCAN_LIMIT);
  return {
    text: `select id, chain_id, state, money_winner_token, mwl_draw, mwl_result, mwl_winner_token,
                  challenger_end_mcap_usd, defender_end_mcap_usd, settlement_version,
                  coalesce(settled_at, finished_at, updated_at) as resolved_ordering
             from public.arena_battles
            where chain_id = $1
              and state = 'finished'
              and coalesce(settled_at, finished_at, updated_at) >= now() - ($2 || ' days')::interval
            order by coalesce(settled_at, finished_at, updated_at) asc
            limit $3`,
    params: [SOLANA_ARENA_CHAIN_ID, String(days), rows],
  };
}

/**
 * A pass never re-reads a battle the previous pass proved is already resolved
 * on chain. `settled` holds those ids; everything else is retried, because a
 * block is usually a transient RPC read rather than a verdict.
 */
export function selectDueBattles(rows, { settled } = {}) {
  const done = settled instanceof Set ? settled : new Set();
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const id = String(row?.id || "").trim();
    if (!id || seen.has(id) || done.has(id)) continue;
    if (Number(row?.chain_id) !== SOLANA_ARENA_CHAIN_ID) continue;
    if (String(row?.state || "") !== "finished") continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

/**
 * Maps a runOperatorJob result onto what the loop should do next.
 *
 * 'resolved' is terminal: the pool is resolved on chain and the id is never
 * read again. 'planned' is a dry run that would have sent. 'blocked' is
 * retried on the next pass.
 */
export function classifyResolveOutcome(result) {
  if (!result) return { state: "blocked", reason: "no-result", terminal: false };
  if (result.ok && result.action === "sent") {
    return { state: "resolved", reason: result.reason || "resolved", terminal: true, signature: result.signature || null };
  }
  if (result.ok && result.action === "skip") {
    return { state: "already-resolved", reason: result.reason || "skip", terminal: true, signature: null };
  }
  if (result.ok && result.sent === false) {
    return { state: "planned", reason: result.reason || "plan-only", terminal: false, signature: null };
  }
  return { state: "blocked", reason: result.reason || "unknown", terminal: false, signature: null };
}

/** One pass: load the due rows, resolve each, report what happened. */
export async function runResolveDuePass({ loadDueRows, resolveBattle, settled, logger = console } = {}) {
  if (typeof loadDueRows !== "function") throw new Error("loadDueRows is required");
  if (typeof resolveBattle !== "function") throw new Error("resolveBattle is required");
  const done = settled instanceof Set ? settled : new Set();
  const rows = selectDueBattles(await loadDueRows(), { settled: done });
  const outcomes = [];
  for (const row of rows) {
    const id = String(row.id);
    let outcome;
    try {
      outcome = classifyResolveOutcome(await resolveBattle(row));
    } catch (error) {
      outcome = { state: "blocked", reason: String(error?.message || error), terminal: false, signature: null };
    }
    if (outcome.terminal) done.add(id);
    if (outcome.state === "blocked") {
      logger.warn?.(`[arena-operator-scan] ${id} blocked: ${outcome.reason}`);
    } else if (outcome.state !== "already-resolved") {
      logger.log?.(`[arena-operator-scan] ${id} ${outcome.state}${outcome.signature ? ` ${outcome.signature}` : ""}`);
    }
    outcomes.push({ battleId: id, ...outcome });
  }
  return {
    scanned: rows.length,
    resolved: outcomes.filter((o) => o.state === "resolved").length,
    alreadyResolved: outcomes.filter((o) => o.state === "already-resolved").length,
    planned: outcomes.filter((o) => o.state === "planned").length,
    blocked: outcomes.filter((o) => o.state === "blocked").length,
    outcomes,
  };
}

/**
 * Repeats the pass until `stop()` says otherwise. Passes never overlap: a slow
 * chain read delays the next pass rather than stacking a second one on top of
 * it, so a battle is never resolved twice concurrently.
 *
 * `stop` is polled both before a pass and again before the sleep, so shutdown
 * does not wait out a full interval. It must therefore be idempotent -- a
 * predicate that mutates a counter on each call will stop early.
 */
export async function runResolveDueWatch({
  loadDueRows,
  resolveBattle,
  intervalMs = DEFAULT_INTERVAL_MS,
  stop,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console,
} = {}) {
  const settled = new Set();
  const wait = Math.max(1_000, Number(intervalMs) || DEFAULT_INTERVAL_MS);
  const shouldStop = typeof stop === "function" ? stop : () => false;
  const totals = { passes: 0, scanned: 0, resolved: 0, alreadyResolved: 0, planned: 0, blocked: 0 };
  while (!shouldStop()) {
    let summary;
    try {
      summary = await runResolveDuePass({ loadDueRows, resolveBattle, settled, logger });
    } catch (error) {
      logger.warn?.(`[arena-operator-scan] pass failed: ${String(error?.message || error)}`);
      summary = { scanned: 0, resolved: 0, alreadyResolved: 0, planned: 0, blocked: 0, outcomes: [] };
    }
    totals.passes += 1;
    for (const key of ["scanned", "resolved", "alreadyResolved", "planned", "blocked"]) totals[key] += summary[key];
    if (shouldStop()) break;
    await sleep(wait);
  }
  return totals;
}
