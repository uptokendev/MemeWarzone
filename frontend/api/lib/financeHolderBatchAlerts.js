// Holder batches of every CreatorRewardsVaultV2 (gen-6 and gen-7's own vault): alerts for the Fee routing page
// (financeFeeRouting.js, rebuilt in the background by cron:finance-snapshots), so a weekly Safe step that was
// not done never stops holder payouts silently.
//
// Why there is recurring Safe work at all (read from the contracts, 2026-10-08):
//   - CreatorRewardsVaultV2.executeHolderBatch reverts NotApproved until the admin (Safe) calls
//     approveHolderBatch(batchId, root, total) with the exact root and total the operator proposed
//     (contracts/CreatorRewardsVaultV2.sol:434-439, 478-489). That approval binds a root that only exists after the
//     week, so it cannot be given ahead: one Safe approval per vault and week, by design (audit 5 M1).
//   - executeHolderBatch funds RewardDistributor.createBatch, which reverts BatchNotAuthorized / BatchTooEarly /
//     BatchAuthExpired / BatchAboveAuthorizedMax unless the owner (Safe) called authorizeBatch(batchId, maxAmount,
//     publishAfter, publishDeadline) (contracts/RewardDistributor.sol:78-118). Batch ids are deterministic
//     (keccak256("mwz-weekly-airdrop:<chain>:<week>:<program>")), so this one CAN be given weeks ahead, like the
//     weekly airdrop's (scripts/make-airdrop-setup-calls.mjs).
//
// Alerts, per vault (registry.holderLanes):
//   1. A proposed batch still waiting for the Safe: warning after 24 h, critical after 4 days (the weekly
//      authorization window is 6 days and the next week's batch follows). A failed batch out of retries: critical.
//      A built / proposing / executing batch the worker has not moved for 6 h: warning.
//   2. Distributor pre-authorization: the consecutive weeks from the current week whose batch id is authorized,
//      not consumed and not past its publish deadline. Fewer than FINANCE_HOLDER_PREAUTH_WARN_WEEKS (default 3)
//      left: warning naming the last covered week, raised N weeks before the authorizations run out. None at
//      all: warning when the vault has holders or split coins (each week's Safe batch must then include
//      authorizeBatch), info otherwise.
//   3. Payout watchdog (founder 2026-10-08, Safe module: realtime-indexer/src/evm/payoutWatchdogWorker.ts): when its
//      heartbeat (public.payout_watchdog_state) is fresh, the module enabled, the role held and sends on, the watchdog
//      approves and authorizes in the Safe's name. Then (1) alerts only when a proposed batch has waited
//      PAYOUT_WATCHDOG_APPROVE_GRACE_HOURS (2) without approval (the watchdog refused it: mismatch or missing data), and
//      (2) only when the runway falls 2 weeks below the watchdog's horizon. A stale heartbeat (older than
//      PAYOUT_WATCHDOG_STALE_MINUTES, 15) is critical: "watchdog down", and the Safe-by-hand alerts apply again. The
//      watchdog's own open alerts (reward_alerts, reward_type 'payout_watchdog') are listed here too.
import { id as keccakId } from "ethers";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
export const HOLDER_PREAUTH_LOOKAHEAD_WEEKS = 12;
const DEFAULT_WARN_WEEKS = 3;

/** Monday 00:00 UTC week, as the operator worker and the weekly airdrop use. */
export function holderWeekOf(ms) {
  const start = new Date(ms);
  const day = start.getUTCDay();
  start.setUTCDate(start.getUTCDate() + (day === 0 ? -6 : 1 - day));
  start.setUTCHours(0, 0, 0, 0);
  return { weekId: start.toISOString().slice(0, 10), startMs: start.getTime(), endMs: start.getTime() + WEEK_MS };
}

/** The holder distributor batch id (realtime-indexer/src/evm/evmCreatorChoice.ts holderBatchId). */
export function holderBatchIdFor(chainId, weekId, program = "airdrop_holders") {
  return keccakId(`mwz-weekly-airdrop:${Number(chainId)}:${weekId}:${program}`);
}

/** eth_call data for RewardDistributor.batchAuthorization(bytes32). */
export function batchAuthorizationCallData(batchId) {
  return `${keccakId("batchAuthorization(bytes32)").slice(0, 10)}${String(batchId).replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
}

/** Decodes (uint256 maxAmount, uint64 publishAfter, uint64 publishDeadline, bool authorized, bool consumed). */
export function decodeBatchAuthorization(hex) {
  const text = String(hex || "").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]*$/.test(text) || text.length < 64 * 5) throw new Error("malformed batchAuthorization return");
  const word = (i) => BigInt(`0x${text.slice(i * 64, (i + 1) * 64)}`);
  return { maxAmount: word(0), publishAfter: Number(word(1)), publishDeadline: Number(word(2)), authorized: word(3) !== 0n, consumed: word(4) !== 0n };
}

function short(address) {
  const a = String(address || "");
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function warnWeeks(env) {
  const n = Number(env?.FINANCE_HOLDER_PREAUTH_WARN_WEEKS);
  return Number.isFinite(n) && n >= 1 && n <= HOLDER_PREAUTH_LOOKAHEAD_WEEKS ? Math.floor(n) : DEFAULT_WARN_WEEKS;
}

async function safeRows(db, sql, params) {
  try {
    const r = await db.query(sql, params);
    return { rows: r?.rows || [], error: null };
  } catch (error) {
    return { rows: [], error };
  }
}

function hoursSince(nowMs, at) {
  const t = at ? Date.parse(new Date(at).toISOString()) : NaN;
  return Number.isFinite(t) ? Math.floor((nowMs - t) / HOUR_MS) : null;
}

/**
 * The weekly holder batches of one vault that need someone: alerts from public.evm_holder_batches (operator worker).
 * A missing table (worker not installed) gives nothing.
 */
async function batchStateAlerts({ db, chainId, lane, nowMs, verifyBase, watchdog = null, env = {} }) {
  const out = [];
  const { rows, error } = await safeRows(db, `
    select week_id, batch_id, status, attempt, last_reason, created_at, updated_at
      from public.evm_holder_batches
     where chain_id = $1 and vault_address = $2 and status in ('built', 'proposing', 'proposed', 'executing', 'failed')
     order by week_id`, [Number(chainId), String(lane.vault).toLowerCase()]);
  if (error) {
    if (error.code === "42P01" || error.code === "42703") return out;
    out.push({ level: "warning", message: `Holder batches of the ${lane.label} creator vault ${short(lane.vault)} could not be read: ${String(error.message || "query failed").slice(0, 160)}.` });
    return out;
  }
  for (const row of rows) {
    if (!row?.week_id || !row?.status) continue;
    const week = String(row.week_id);
    const where = `Holder batch ${week} of the ${lane.label} creator vault ${short(lane.vault)}`;
    const file = `${verifyBase}/api/evm/holder-batch?chainId=${chainId}&weekId=${week}&vault=${String(lane.vault).toLowerCase()}`;
    if (row.status === "proposed") {
      const waiting = /Safe/.test(String(row.last_reason || ""));
      const hours = hoursSince(nowMs, row.created_at);
      if (watchdog?.active) {
        // The watchdog approves a matching batch within minutes; still waiting after the grace means it refused it.
        const grace = graceHours(env);
        if (!waiting || hours == null || hours < grace) continue;
        out.push({
          level: "critical",
          message: `${where} has waited ${hours} h and the payout watchdog has not approved it (${row.last_reason}): it found a mismatch or could not check it; see its alerts. Holders are not paid until the Safe signers verify and sign batch H by hand: node scripts/evm-holder-batch-verify.mjs --chain ${chainId} --file "${file}" --auth-max <wei>.`,
        });
        continue;
      }
      if (!waiting || hours == null || hours < 24) continue;
      out.push({
        level: hours >= 96 ? "critical" : "warning",
        message: `${where} has waited ${hours} h: ${row.last_reason}. Holders are not paid until the Safe signs batch H: node scripts/evm-holder-batch-verify.mjs --chain ${chainId} --file "${file}" --auth-max <wei>.`,
      });
    } else if (row.status === "failed") {
      if (Number(row.attempt || 0) < 3) continue;
      out.push({ level: "critical", message: `${where} failed and is out of retries (${row.last_reason || "no reason recorded"}). Its holder money stays in the vault until a person looks.` });
    } else {
      const hours = hoursSince(nowMs, row.updated_at);
      if (hours == null || hours < 6) continue;
      out.push({ level: "warning", message: `${where} has been '${row.status}' for ${hours} h. The creator-choice operator worker has not moved it: check that it runs and that the operator has gas.` });
    }
  }
  return out;
}

/**
 * Distributor pre-authorization coverage of one vault: consecutive weeks from the current one whose batch id is
 * authorized, unconsumed and still inside its publish window.
 */
export async function readPreauthorizedWeeks({ readEvmCall, urls, fetchImpl, chainId, distributor, program, nowMs, weeks = HOLDER_PREAUTH_LOOKAHEAD_WEEKS }) {
  const nowSec = Math.floor(nowMs / 1000);
  let covered = 0;
  let lastWeek = null;
  let anyAuthorized = false;
  let firstWeek = null;
  for (let i = 0; i < weeks; i += 1) {
    const week = holderWeekOf(nowMs + i * WEEK_MS);
    if (i === 0) firstWeek = week.weekId;
    const call = await readEvmCall({ urls, to: distributor, data: batchAuthorizationCallData(holderBatchIdFor(chainId, week.weekId, program)), fetchImpl });
    const auth = decodeBatchAuthorization(call.hex);
    const live = auth.authorized && !auth.consumed && auth.publishDeadline > nowSec;
    if (auth.authorized) anyAuthorized = true;
    if (!live) break;
    covered += 1;
    lastWeek = week.weekId;
  }
  return { covered, lastWeek, firstWeek, anyAuthorized };
}

async function holderCoinCount(db, chainId, vault) {
  const { rows, error } = await safeRows(db, `
    select count(*)::int as n from public.evm_campaign_gen5_state
     where chain_id = $1 and fee_vault = $2 and fee_choice in (2, 3)`, [Number(chainId), String(vault).toLowerCase()]);
  if (error) return null;
  const n = Number(rows[0]?.n);
  return Number.isFinite(n) ? n : null;
}

async function preauthAlerts({ db, ctx, chainId, lane, nowMs, env, watchdog = null }) {
  const n = warnWeeks(env);
  let cov;
  try {
    cov = await readPreauthorizedWeeks({ readEvmCall: ctx.readers.readEvmCall, urls: ctx.urls, fetchImpl: ctx.fetchImpl, chainId, distributor: lane.distributor, program: lane.program, nowMs });
  } catch (error) {
    return [{ level: "warning", message: `Holder batch authorizations on the ${lane.label} holder distributor ${short(lane.distributor)} could not be read (${String(error?.message || "rpc error").slice(0, 120)}), so nobody is told before they run out.` }];
  }
  const howTo = `Authorize the next ${HOLDER_PREAUTH_LOOKAHEAD_WEEKS} weeks' batch ids (program ${lane.program}) with authorizeBatch on ${short(lane.distributor)}; approveHolderBatch on the vault stays a weekly Safe step.`;
  if (watchdog?.active) {
    // The watchdog keeps `weeks` weeks authorized (its allowance adds one week per week): alert when it falls behind.
    const keep = Math.min(HOLDER_PREAUTH_LOOKAHEAD_WEEKS, watchdog.weeks);
    const behind = Math.max(1, keep - 2);
    if (cov.covered >= behind) return [];
    return [{ level: cov.covered < n ? "critical" : "warning", message: `Holder batch pre-authorizations on the ${lane.label} holder distributor ${short(lane.distributor)} cover ${cov.covered} week${cov.covered === 1 ? "" : "s"}${cov.lastWeek ? ` (through ${cov.lastWeek})` : ""} although the payout watchdog keeps ${keep}: it is not authorizing (allowance used up, refused by the module, or out of gas; see its alerts). ${howTo}` }];
  }
  if (cov.covered === 0) {
    const coins = await holderCoinCount(db, chainId, lane.vault);
    const level = coins && coins > 0 ? "warning" : "info";
    const why = coins && coins > 0 ? `${coins} holders or split coin${coins === 1 ? "" : "s"} use this vault, so` : "When a coin chooses holders or split,";
    return [{ level, message: `No holder batch is pre-authorized on the ${lane.label} holder distributor ${short(lane.distributor)} from week ${cov.firstWeek}${cov.anyAuthorized ? " (an authorization exists but is consumed or expired)" : ""}. ${why} every weekly Safe batch must include authorizeBatch, or the batch cannot execute. ${howTo}` }];
  }
  if (cov.covered < n) {
    return [{ level: "warning", message: `Holder batch pre-authorizations on the ${lane.label} holder distributor ${short(lane.distributor)} run out after week ${cov.lastWeek} (${cov.covered} week${cov.covered === 1 ? "" : "s"} left, alert at ${n}). ${howTo}` }];
  }
  return [];
}

function graceHours(env) {
  const n = Number(env?.PAYOUT_WATCHDOG_APPROVE_GRACE_HOURS);
  return Number.isFinite(n) && n >= 1 && n <= 96 ? Math.floor(n) : 2;
}

function staleMinutes(env) {
  const n = Number(env?.PAYOUT_WATCHDOG_STALE_MINUTES);
  return Number.isFinite(n) && n >= 2 && n <= 24 * 60 ? Math.floor(n) : 15;
}

/**
 * The payout watchdog's heartbeat for a chain (public.payout_watchdog_state), or null when it never ran (table or row
 * missing). active = fresh, module enabled, role held, sends on: the watchdog does the recurring Safe steps.
 */
export async function readPayoutWatchdog(db, chainId, { env = process.env, nowMs = Date.now() } = {}) {
  const { rows, error } = await safeRows(db, `
    select watchdog_address, roles_address, send, module_enabled, role_ok, last_tick_at, last_ok_at, last_error, status
      from public.payout_watchdog_state where chain_id = $1`, [Number(chainId)]);
  if (error || !rows[0]?.watchdog_address) return null;
  const r = rows[0];
  const ageMin = r.last_tick_at ? Math.floor((nowMs - Date.parse(new Date(r.last_tick_at).toISOString())) / 60_000) : null;
  const fresh = ageMin != null && ageMin <= staleMinutes(env);
  const weeks = Number(r.status?.weeks) > 0 ? Number(r.status.weeks) : 12;
  return {
    watchdog: r.watchdog_address, roles: r.roles_address, send: Boolean(r.send), moduleEnabled: Boolean(r.module_enabled), roleOk: Boolean(r.role_ok),
    lastTickAt: r.last_tick_at, ageMinutes: ageMin, fresh, weeks, lastError: r.last_error || null,
    active: fresh && Boolean(r.send) && Boolean(r.module_enabled) && Boolean(r.role_ok),
  };
}

/** Heartbeat, module / role health and the watchdog's own open alerts for one chain. */
export async function payoutWatchdogAlerts({ db, chainId, watchdog, env = process.env }) {
  const out = [];
  const expected = ["1", "true", "yes"].includes(String(env?.[`PAYOUT_WATCHDOG_EXPECTED_${chainId}`] || "").trim().toLowerCase());
  if (!watchdog) {
    if (expected) out.push({ level: "critical", message: `The payout watchdog has never reported on chain ${chainId} (no heartbeat in payout_watchdog_state) although PAYOUT_WATCHDOG_EXPECTED_${chainId} is set. Holder approvals and distributor authorizations need the Safe signers by hand.` });
    return out;
  }
  if (!watchdog.fresh) {
    out.push({ level: "critical", message: `The payout watchdog on chain ${chainId} is down: last heartbeat ${watchdog.ageMinutes == null ? "unknown" : `${watchdog.ageMinutes} min ago`}${watchdog.lastError ? ` (${String(watchdog.lastError).slice(0, 160)})` : ""}. Until it runs again the Safe signers approve holder batches and renew authorizations by hand.` });
  } else if (!watchdog.moduleEnabled || !watchdog.roleOk) {
    out.push({ level: "critical", message: `The payout watchdog on chain ${chainId} runs but cannot act: ${!watchdog.moduleEnabled ? "the Roles module is not enabled on the Safe" : "it does not hold its role on the Roles module"}. The Safe signers do the weekly steps by hand meanwhile.` });
  } else if (!watchdog.send) {
    out.push({ level: "info", message: `The payout watchdog on chain ${chainId} runs in dry run (PAYOUT_WATCHDOG_SEND is off): it checks and reports but signs nothing; the Safe signers still do the weekly steps.` });
  }
  const { rows } = await safeRows(db, `
    select severity, title, message from public.reward_alerts
     where status = 'open' and reward_type = 'payout_watchdog' and metadata->>'chainId' = $1
     order by created_at desc limit 10`, [String(chainId)]);
  for (const row of rows.filter((x) => x?.title)) out.push({ level: row.severity === "critical" ? "critical" : row.severity === "info" ? "info" : "warning", message: `${row.title}. ${row.message}` });
  return out;
}

/** Every alert for every holder lane of the registry. Never throws. */
export async function holderBatchAlerts({ db, ctx, registry, chainId, env = process.env, nowMs = Date.now() }) {
  const lanes = (registry?.holderLanes || []).filter((l) => l?.vault && l?.distributor);
  if (!lanes.length) return [];
  const verifyBase = String(env?.FINANCE_PUBLIC_API_BASE || "https://api.memewar.zone").replace(/\/+$/, "");
  const out = [];
  let watchdog = null;
  try {
    watchdog = await readPayoutWatchdog(db, chainId, { env, nowMs });
    out.push(...(await payoutWatchdogAlerts({ db, chainId, watchdog, env })));
  } catch (error) {
    out.push({ level: "warning", message: `Payout watchdog state could not be read: ${String(error?.message || error).slice(0, 160)}.` });
  }
  for (const lane of lanes) {
    try {
      out.push(...(await batchStateAlerts({ db, chainId, lane, nowMs, verifyBase, watchdog, env })));
      out.push(...(await preauthAlerts({ db, ctx, chainId, lane, nowMs, env, watchdog })));
    } catch (error) {
      out.push({ level: "warning", message: `Holder batch checks for the ${lane.label} creator vault failed: ${String(error?.message || error).slice(0, 160)}.` });
    }
  }
  return out;
}
