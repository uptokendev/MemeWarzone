// Creator fee claims on the Solana launchpad, read from the chain.
//
// claim_creator_fees (programs/memewarzone_solana/src/fee_escrow.rs) pays the
// creator straight from the coin's fee accounts and does two things we can
// read back without our database:
//   - it adds the amount to CreatorFeeVault.total_claimed (a running total on
//     the vault account), and
//   - it emits CreatorFeeClaimed { campaign, creator, creator_fee_vault,
//     amount_lamports, total_claimed } in the transaction logs.
// The running total is exact and costs nothing (the payouts page already
// reads the vault for "claimable"); the events give the dates, amounts and
// transaction links. Nothing here signs or sends; every call is a read.

import { createHash } from "node:crypto";

import { encodeBase58 } from "../dev-fix/solana-v4-primitives.js";
import { CREATOR_FEE_VAULT_BYTES, SOLANA_LAUNCHPAD_PROGRAM_ID } from "./solanaCreatorFeeMath.js";

const PROGRAM_DATA_PREFIX = "Program data: ";

/** Anchor sha256("event:CreatorFeeClaimed")[0..8]. */
export const CREATOR_FEE_CLAIMED_DISCRIMINATOR = createHash("sha256").update("event:CreatorFeeClaimed").digest().subarray(0, 8);
/** discriminator + campaign + creator + creator_fee_vault + amount_lamports + total_claimed. */
export const CREATOR_FEE_CLAIMED_BYTES = 8 + 32 * 3 + 8 + 8;

// CreatorFeeVault: discriminator, campaign, creator, pending_lamports,
// total_received, total_claimed, bump, version (98 bytes, pinned by
// creator_fee_vault_account_size_is_stable).
const VAULT_CAMPAIGN = 8;
const VAULT_CREATOR = 40;
const VAULT_PENDING = 72;
const VAULT_RECEIVED = 80;
const VAULT_CLAIMED = 88;

/** Decodes a CreatorFeeVault account body, or null when it is not one. */
export function decodeCreatorFeeVault(data) {
  if (!data || data.length !== CREATOR_FEE_VAULT_BYTES) return null;
  return {
    campaign: encodeBase58(data.subarray(VAULT_CAMPAIGN, VAULT_CAMPAIGN + 32)),
    creator: encodeBase58(data.subarray(VAULT_CREATOR, VAULT_CREATOR + 32)),
    pendingLamports: data.readBigUInt64LE(VAULT_PENDING),
    totalReceivedLamports: data.readBigUInt64LE(VAULT_RECEIVED),
    totalClaimedLamports: data.readBigUInt64LE(VAULT_CLAIMED),
  };
}

const INVOKE_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[\d+\]$/;
const EXIT_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed.*)$/;

/**
 * Every CreatorFeeClaimed the launchpad emitted in one transaction's logs.
 * Only "Program data:" lines written while the launchpad itself is executing
 * count, so another program cannot pass one off. `logIndex` is the line's
 * position in the log, stable for a given transaction.
 */
export function decodeCreatorFeeClaimedEvents(logMessages, { programId = SOLANA_LAUNCHPAD_PROGRAM_ID } = {}) {
  const out = [];
  const stack = [];
  (logMessages || []).forEach((line, logIndex) => {
    const text = String(line || "");
    const invoke = INVOKE_RE.exec(text);
    if (invoke) { stack.push(invoke[1]); return; }
    const exit = EXIT_RE.exec(text);
    if (exit) { if (stack[stack.length - 1] === exit[1]) stack.pop(); return; }
    if (!text.startsWith(PROGRAM_DATA_PREFIX) || stack[stack.length - 1] !== programId) return;
    let data;
    try {
      data = Buffer.from(text.slice(PROGRAM_DATA_PREFIX.length).trim(), "base64");
    } catch {
      return;
    }
    if (data.length !== CREATOR_FEE_CLAIMED_BYTES || !data.subarray(0, 8).equals(CREATOR_FEE_CLAIMED_DISCRIMINATOR)) return;
    out.push({
      logIndex,
      campaign: encodeBase58(data.subarray(8, 40)),
      creator: encodeBase58(data.subarray(40, 72)),
      creatorFeeVault: encodeBase58(data.subarray(72, 104)),
      amountLamports: data.readBigUInt64LE(104),
      totalClaimedLamports: data.readBigUInt64LE(112),
    });
  });
  return out;
}

/** The claims in one getTransaction result (failed transactions pay nothing). */
export function creatorFeeClaimsFromTransaction(tx, { signature, programId } = {}) {
  if (!tx || tx.meta?.err) return [];
  const sig = signature || tx.transaction?.signatures?.[0] || tx.signature || null;
  const blockTime = Number.isFinite(Number(tx.blockTime)) && tx.blockTime ? new Date(Number(tx.blockTime) * 1000).toISOString() : null;
  return decodeCreatorFeeClaimedEvents(tx.meta?.logMessages, { programId }).map((event) => ({
    ...event,
    signature: sig,
    slot: Number(tx.slot || 0) || null,
    blockTime,
  }));
}

// --------------------------------------------------------------------------
// Bounded chain read of one vault's claim history.

const MAX_SIGNATURE_PAGES = 3;
const SIGNATURE_PAGE = 1000;
const MAX_TRANSACTIONS = 120;
const REFRESH_MS = 10 * 60_000;
const MAX_CACHE_ENTRIES = 500;
const historyCache = new Map();

export function clearCreatorClaimHistoryCache() {
  historyCache.clear();
}

/**
 * Reads every claim of one creator fee vault from its signature history:
 * getSignaturesForAddress(vault), then getTransaction for each successful
 * signature, then the CreatorFeeClaimed events naming that vault. Bounded
 * (3 signature pages, 120 transactions) and cached: a vault's history can
 * only change when its total_claimed changes, so an entry is kept for as long
 * as the running total matches, and a vault is re-read at most once every
 * 10 minutes even when it does not.
 *
 * @param {object} input
 * @param {(method: string, params: unknown[]) => Promise<any>} input.rpc
 * @param {string} input.vault
 * @param {bigint} input.totalClaimedLamports  the vault's running total right now
 * @returns {Promise<{claims: object[], complete: boolean, sumLamports: bigint, cached: boolean, readAt: string, error?: string}>}
 */
export async function readCreatorClaimHistory({ rpc, vault, totalClaimedLamports, programId = SOLANA_LAUNCHPAD_PROGRAM_ID, nowMs = Date.now() }) {
  const want = BigInt(totalClaimedLamports || 0n);
  const hit = historyCache.get(vault);
  if (hit && (hit.totalClaimed === want || nowMs - hit.at < REFRESH_MS)) {
    return { ...hit.value, cached: true, complete: hit.value.sumLamports === want };
  }
  if (want === 0n) {
    const value = { claims: [], complete: true, sumLamports: 0n, readAt: new Date(nowMs).toISOString() };
    historyCache.set(vault, { at: nowMs, totalClaimed: want, value });
    return { ...value, cached: false };
  }

  const signatures = [];
  let before;
  let truncated = false;
  for (let page = 0; page < MAX_SIGNATURE_PAGES; page += 1) {
    const batch = await rpc("getSignaturesForAddress", [vault, { limit: SIGNATURE_PAGE, ...(before ? { before } : {}) }]);
    const rows = Array.isArray(batch) ? batch : [];
    for (const row of rows) if (row && !row.err && row.signature) signatures.push(row.signature);
    if (rows.length < SIGNATURE_PAGE) break;
    before = rows[rows.length - 1].signature;
    if (page === MAX_SIGNATURE_PAGES - 1) truncated = true;
  }

  const claims = [];
  let sum = 0n;
  let read = 0;
  // Oldest first, so a capped read still lists the early claims in order.
  for (const signature of signatures.reverse()) {
    if (read >= MAX_TRANSACTIONS) { truncated = true; break; }
    read += 1;
    const tx = await rpc("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
    for (const claim of creatorFeeClaimsFromTransaction(tx, { signature, programId })) {
      if (claim.creatorFeeVault !== vault) continue;
      claims.push(claim);
      sum += claim.amountLamports;
    }
    // Stop as soon as the events add up to the running total.
    if (sum === want) break;
  }
  claims.sort((a, b) => String(a.blockTime || "").localeCompare(String(b.blockTime || "")) || a.logIndex - b.logIndex);
  const value = { claims, complete: sum === want, sumLamports: sum, readAt: new Date(nowMs).toISOString(), ...(truncated && sum !== want ? { error: "History read was capped before the claims added up." } : {}) };
  if (historyCache.size >= MAX_CACHE_ENTRIES) historyCache.delete(historyCache.keys().next().value);
  historyCache.set(vault, { at: nowMs, totalClaimed: want, value });
  return { ...value, cached: false };
}

// --------------------------------------------------------------------------
// Reconciliation

/**
 * Earned should equal paid + claimable. On Solana that is true by
 * construction (claim_creator_fees pays exactly the surplus, and every
 * creator slice lands in the escrow), so a gap means a record is missing or
 * the fee accounts hold lamports that were not trade fees (for example rent
 * the account no longer needs). Pure; raw atomic strings or bigints in.
 */
export function reconcileCreatorFees({ earnedRaw, paidRaw, claimableRaw, toleranceRaw = 0n }) {
  if (earnedRaw == null || paidRaw == null || claimableRaw == null) {
    return { status: "unknown", earnedRaw: earnedRaw == null ? null : String(earnedRaw), paidRaw: paidRaw == null ? null : String(paidRaw), claimableRaw: claimableRaw == null ? null : String(claimableRaw), gapRaw: null };
  }
  const earned = BigInt(earnedRaw);
  const accounted = BigInt(paidRaw) + BigInt(claimableRaw);
  const gap = earned - accounted;
  const abs = gap < 0n ? -gap : gap;
  return {
    status: abs <= BigInt(toleranceRaw) ? "balanced" : gap > 0n ? "earned_more" : "accounted_more",
    earnedRaw: earned.toString(),
    paidRaw: BigInt(paidRaw).toString(),
    claimableRaw: BigInt(claimableRaw).toString(),
    gapRaw: gap.toString(),
  };
}
