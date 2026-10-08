/**
 * Safe pre-authorization runway per airdrop pot (founder, 2026-10-08: everything automated, nothing
 * recurring that can be overlooked when busy).
 *
 * The only recurring Safe step is RewardDistributor.authorizeBatch for future weeks
 * (scripts/make-airdrop-setup-calls.mjs, 12 weeks by default, max 26, both pots in one batch). The
 * weekly runner calls checkAirdropRunway before it draws: it reads batchAuthorization for this week and
 * the weeks after it on every pot's distributor and
 *
 *   - this week not authorized on a pot        -> critical reward_alert ("NOT authorized"), loud log
 *   - fewer than AIRDROP_AUTH_ALERT_WEEKS (3)
 *     authorized weeks left after this one     -> warning reward_alert, loud log
 *   - enough runway                            -> any open runway alert for that pot is resolved
 *
 * It also lists expired batches with money left (the 60-day claim window is over): those need the
 * recovery Safe batch (scripts/make-airdrop-recovery-batch.ts) to roll back into their own pot.
 *
 * Alerts land in public.reward_alerts (reward ops + the Finance Payouts page read them) and, when
 * AIRDROP_ALERT_EMAIL is set, go out by email through the existing notify provider (api/lib/notify.js).
 * A failed read is itself an alert; the check never blocks the draw.
 */
import { Contract } from "ethers";
import { DAY_MS } from "./config.mjs";
import { weeklyContractBatchId } from "./materialize.mjs";
import { MAIN_POT, POT_LABELS, isMainPot } from "./pots.mjs";

export const AUTH_RUNWAY_ALERT_KIND = "airdrop_authorization_runway";
export const RECOVERY_DUE_ALERT_KIND = "airdrop_recovery_due";
export const DRAW_PROGRAMS = Object.freeze(["airdrop_trader", "airdrop_creator"]);
export const DEFAULT_ALERT_WEEKS = 3;
export const MAX_AUTH_WEEKS = 26;

const WEEK_MS = 7 * DAY_MS;

export function alertWeeks(env = process.env) {
  const raw = Number(String(env.AIRDROP_AUTH_ALERT_WEEKS ?? "").trim() || DEFAULT_ALERT_WEEKS);
  return Number.isFinite(raw) ? Math.min(MAX_AUTH_WEEKS, Math.max(1, Math.floor(raw))) : DEFAULT_ALERT_WEEKS;
}

/** epochId (Monday the week starts) of the week that ends at `end`. */
export function epochIdForEnd(end) {
  return new Date(end.getTime() - WEEK_MS).toISOString().slice(0, 10);
}

/** Is one batch id usable now or later (or already used)? */
export function authorizationCovers(auth, nowSec) {
  if (!auth) return false;
  if (auth.consumed) return true;
  return Boolean(auth.authorized) && Number(auth.publishDeadline) >= nowSec;
}

/**
 * Consecutive covered weeks starting at the week that ends at `currentEnd` (the week this run draws).
 * readAuth(batchId) -> { authorized, consumed, publishDeadline } | null.
 */
export async function authorizationRunway({ chainId, pot = MAIN_POT, currentEnd, now = new Date(), readAuth, maxWeeks = MAX_AUTH_WEEKS }) {
  const nowSec = Math.floor(now.getTime() / 1000);
  let covered = 0;
  let firstMissing = null;
  for (let week = 0; week < maxWeeks; week += 1) {
    const end = new Date(currentEnd.getTime() + week * WEEK_MS);
    const epochId = epochIdForEnd(end);
    const missing = [];
    for (const program of DRAW_PROGRAMS) {
      const batchId = weeklyContractBatchId(chainId, epochId, program, pot);
      if (!authorizationCovers(await readAuth(batchId), nowSec)) missing.push({ program, batchId });
    }
    if (missing.length) {
      firstMissing = { epochId, weekEnd: end.toISOString(), missing };
      break;
    }
    covered += 1;
  }
  const lastCoveredEnd = covered ? new Date(currentEnd.getTime() + (covered - 1) * WEEK_MS) : null;
  return {
    chainId,
    pot,
    currentEpochId: epochIdForEnd(currentEnd),
    coveredWeeks: covered,
    weeksAhead: covered - 1,
    lastCoveredEpochId: lastCoveredEnd ? epochIdForEnd(lastCoveredEnd) : null,
    firstMissing,
  };
}

/** ok | warning | critical, and the words for the alert. */
export function runwayVerdict(runway, threshold = DEFAULT_ALERT_WEEKS) {
  const label = POT_LABELS[runway.pot] || `${runway.pot} pot`;
  const fix = `Renew from the Safe: node scripts/make-airdrop-setup-calls.mjs --chain ${runway.chainId} --vault .. --distributor .. [--gen7-vault .. --gen7-distributor ..] --cap .. --skip-wiring writes one batch that renews every pot.`;
  if (runway.coveredWeeks === 0) {
    return {
      level: "critical",
      title: `Airdrop ${label} on chain ${runway.chainId}: this week (${runway.currentEpochId}) is NOT pre-authorized`,
      message: `The Safe has not authorized this week's batch ids on the ${label} distributor, so this week's draw cannot be funded. ${fix}`,
    };
  }
  if (runway.weeksAhead < threshold) {
    return {
      level: "warning",
      title: `Airdrop ${label} on chain ${runway.chainId}: pre-authorization runs out after ${runway.lastCoveredEpochId}`,
      message: `${runway.weeksAhead} authorized week(s) left after this one (alert below ${threshold}). ${fix}`,
    };
  }
  return { level: "ok", title: null, message: null };
}

async function resolveOpen(client, { kind, chainId, pot }) {
  await client.query(
    `update public.reward_alerts
        set status='resolved',resolved_at=now(),resolved_by='weekly_airdrop_runner'
      where status='open' and reward_type='airdrop' and metadata->>'kind'=$1
        and metadata->>'chainId'=$2 and coalesce(metadata->>'pot','${MAIN_POT}')=$3`,
    [kind, String(chainId), pot],
  );
}

async function emailAlert({ title, message }, env) {
  const to = String(env.AIRDROP_ALERT_EMAIL || "").trim();
  if (!to) return;
  try {
    const { sendEmailNotification } = await import("../../api/lib/notify.js");
    await sendEmailNotification({ to, subject: `[MemeWarzone] ${title}`, text: message });
  } catch (error) {
    console.error("[weekly-airdrop] alert email failed", error?.message || error);
  }
}

/**
 * Writes (or clears) the runway alert of one pot. writeAlert is candidates.mjs writeRewardAlert.
 * Returns the verdict. dryRun logs only.
 */
export async function syncRunwayAlert(client, { runway, threshold, writeAlert, dryRun = false, env = process.env, log = console }) {
  const verdict = runwayVerdict(runway, threshold);
  const metadata = {
    kind: AUTH_RUNWAY_ALERT_KIND,
    chainId: runway.chainId,
    pot: runway.pot,
    coveredWeeks: runway.coveredWeeks,
    weeksAhead: runway.weeksAhead,
    lastCoveredEpochId: runway.lastCoveredEpochId,
    firstMissing: runway.firstMissing,
    threshold,
  };
  if (verdict.level === "ok") {
    log.log(`[weekly-airdrop] ${runway.pot} pot chain ${runway.chainId}: authorized through ${runway.lastCoveredEpochId} (${runway.weeksAhead} week(s) after this one)`);
  } else {
    log.error(`[weekly-airdrop] ${verdict.level.toUpperCase()}: ${verdict.title}. ${verdict.message}`);
  }
  if (dryRun) return verdict;
  await resolveOpen(client, { kind: AUTH_RUNWAY_ALERT_KIND, chainId: runway.chainId, pot: runway.pot });
  if (verdict.level !== "ok") {
    await writeAlert(client, { severity: verdict.level, title: verdict.title, message: verdict.message, metadata });
    await emailAlert(verdict, env);
  }
  return verdict;
}

/** Expired batches with money left, per pot (from DB candidates, confirmed on chain). */
export async function syncRecoveryDueAlert(client, { chainId, pot, expired, writeAlert, dryRun = false, env = process.env, log = console }) {
  const label = POT_LABELS[pot] || `${pot} pot`;
  if (!expired.length) {
    if (!dryRun) await resolveOpen(client, { kind: RECOVERY_DUE_ALERT_KIND, chainId, pot });
    return null;
  }
  const total = expired.reduce((sum, item) => sum + BigInt(item.unclaimed), 0n);
  const alert = {
    title: `Airdrop ${label} on chain ${chainId}: ${expired.length} expired batch(es) hold unclaimed money`,
    message: `${total} wei is past its 60-day claim window (${expired.map((item) => item.label).join("; ")}). Run npx hardhat run scripts/make-airdrop-recovery-batch.ts on this chain and sign the Safe batch; it rolls the money back into this pot.`,
  };
  log.error(`[weekly-airdrop] RECOVERY DUE: ${alert.title}`);
  if (dryRun) return alert;
  await resolveOpen(client, { kind: RECOVERY_DUE_ALERT_KIND, chainId, pot });
  await writeAlert(client, {
    severity: "warning",
    ...alert,
    metadata: { kind: RECOVERY_DUE_ALERT_KIND, chainId, pot, totalWei: total.toString(), expired: expired.map((item) => ({ ...item, unclaimed: String(item.unclaimed) })) },
  });
  await emailAlert(alert, env);
  return alert;
}

const DISTRIBUTOR_READ_ABI = [
  "function batchAuthorization(bytes32) view returns (uint256 maxAmount,uint64 publishAfter,uint64 publishDeadline,bool authorized,bool consumed)",
  "function batches(bytes32) view returns (bytes32 merkleRoot,uint256 totalFunded,uint256 totalClaimed,uint64 claimDeadline,bool paused,bool exists)",
];

async function expiredWithMoney(client, { chainId, pot, distributor, nowSec }) {
  const { rows } = await client.query(
    `select metadata->>'contractBatchId' as batch_id, metadata->>'epochId' as epoch_id, metadata->>'program' as program
       from public.reward_batches
      where reward_type='airdrop' and chain::text=$1 and status<>'archived'
        and coalesce(metadata->>'airdropPot','${MAIN_POT}')=$2
        and metadata->>'program' in ('airdrop_trader','airdrop_creator')
        and (metadata->>'claimDeadline') ~ '^[0-9]+$' and (metadata->>'claimDeadline')::bigint < $3
        and coalesce((metadata->>'onChainBatchCreated')::boolean,false)`,
    [String(chainId), pot, nowSec],
  );
  const expired = [];
  for (const row of rows) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(row.batch_id || ""))) continue;
    const batch = await distributor.batches(row.batch_id);
    const unclaimed = BigInt(batch.totalFunded) - BigInt(batch.totalClaimed);
    if (batch.exists && unclaimed > 0n && Number(batch.claimDeadline) !== 0 && nowSec > Number(batch.claimDeadline)) {
      expired.push({ batchId: row.batch_id, label: `${row.epoch_id} ${row.program}`, unclaimed });
    }
  }
  return expired;
}

/**
 * The runner's entry point: every pot's runway and recovery check, alerts written. Never throws; a
 * failed read becomes a warning alert so the draw still runs.
 */
export async function checkAirdropRunway(client, { chainId, pots, currentEnd, writeAlert, providerFor, dryRun = false, now = new Date(), env = process.env, log = console }) {
  const threshold = alertWeeks(env);
  const results = [];
  for (const potConfig of pots) {
    const pot = potConfig.pot || MAIN_POT;
    try {
      if (!potConfig.distributorAddress) throw new Error(`no distributor configured for the ${pot} pot`);
      const distributor = new Contract(potConfig.distributorAddress, DISTRIBUTOR_READ_ABI, providerFor(chainId));
      const runway = await authorizationRunway({
        chainId,
        pot,
        currentEnd,
        now,
        readAuth: (batchId) => distributor.batchAuthorization(batchId),
      });
      const verdict = await syncRunwayAlert(client, { runway, threshold, writeAlert, dryRun, env, log });
      const expired = await expiredWithMoney(client, { chainId, pot, distributor, nowSec: Math.floor(now.getTime() / 1000) });
      await syncRecoveryDueAlert(client, { chainId, pot, expired, writeAlert, dryRun, env, log });
      results.push({ pot, runway, verdict, expiredCount: expired.length });
    } catch (error) {
      const message = error?.message || String(error);
      log.error(`[weekly-airdrop] could not check the Safe pre-authorization of the ${pot} pot on chain ${chainId}: ${message}`);
      if (!dryRun) {
        await writeAlert(client, {
          severity: "warning",
          title: `Airdrop ${isMainPot(pot) ? "main" : pot} pot on chain ${chainId}: pre-authorization check failed`,
          message,
          metadata: { kind: `${AUTH_RUNWAY_ALERT_KIND}_read_failed`, chainId, pot },
        });
      }
      results.push({ pot, error: message });
    }
  }
  return results;
}

