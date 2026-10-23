/**
 * Gen-8 holder rule (founder, 2026-10-21 / 2026-10-22): the Solana DBC hold-through rule on BNB 56 and Robinhood 4663.
 * Pure. Shared by the creator-choice operator and the payout watchdog, so both compute the same checks and payouts.
 *
 *   week secret  = evmCreatorChoice.weekSecret(EVM_BUYBACK_SEED_SECRET, chainId, weekId)   (the chain's week secret)
 *   check i      = start of quarter i + HMAC(week secret, "holders-check:" + chainId + ":" + i) mod quarter, i = 0..3
 *   a check is read from a block whose time is in [moment i, moment i+1) (the last one: until the week ends)
 *   every check whose moment is at or after the coin's launch must be present in the batch
 *   a wallet counts with its LOWEST balance if it held >= 0.01% of the token's totalSupply at EVERY check
 *   (dbcCreatorChoice.holdThroughBalances), then pro rata (allocateToHolders), then the payout minimum (holderLeaves)
 *
 * Who is a holder at a check: a positive balance, not in
 * the hard skip list (gen8HardSkip: 0xdEaD, zero, the token, the vault, the operator, the coin's human creator and the
 * census exclusions: PoolManager, hook, launcher, reserve lock, escrow, Infinity vault, side pools) and not in the soft
 * list (EVM_HOLDER_EXCLUDED_WALLETS and risk-excluded wallets). Soft exclusions are bounded by the watchdog
 * (PAYOUT_WATCHDOG_MAX_EXCLUDED_BPS) exactly as for gen-6/7.
 * Contracts (founder, 2026-10-22): only KNOWN contracts are skipped (the hard skip list above plus the manual list).
 * Any other address counts as a holder whether or not it has code, so nobody can make a batch fail by deploying code
 * at an address after a check, and no archive RPC is needed. A contract that cannot claim lets its share expire; the
 * Safe recovers it and creditUnclaimedHolders returns it to the same coins' holders.
 */
import crypto from "node:crypto";
import { ethers } from "ethers";
import { allocateToHolders, holdThroughBalances, type HolderBalance } from "../dbc/dbcCreatorChoice.js";
import { DEAD, WEEK_MS, holderBatchId } from "./evmCreatorChoice.js";

export const GEN8_HOLDER_RULE = "hold-through-v1";
export const GEN8_CHECKS = 4;
const QUARTER_MS = WEEK_MS / GEN8_CHECKS;

const lc = (a: string) => String(a || "").toLowerCase();

/** Check i falls inside quarter i of the week (milliseconds, from the chain's week secret). */
export function gen8CheckMoments(secret: string, chainId: number, weekStart: Date): Date[] {
  return Array.from({ length: GEN8_CHECKS }, (_, i) => {
    const digest = crypto.createHmac("sha256", secret).update(`holders-check:${chainId}:${i}`).digest();
    const offset = Number(digest.readBigUInt64BE(0) % BigInt(QUARTER_MS));
    return new Date(weekStart.getTime() + i * QUARTER_MS + offset);
  });
}

/** The check due at `now`: the latest one whose moment has passed; null before the first. */
export function gen8DueCheck(moments: Date[], now: Date): number | null {
  let due: number | null = null;
  moments.forEach((at, i) => {
    if (now.getTime() >= at.getTime()) due = i;
  });
  return due;
}

/** Window (unix seconds) a check's block time must fall in: [moment i, moment i+1), the last until the week ends. */
export function gen8CheckWindow(moments: Date[], index: number, weekEnd: Date): { from: number; to: number } {
  const from = Math.floor(moments[index].getTime() / 1000);
  const next = index + 1 < moments.length ? moments[index + 1] : weekEnd;
  return { from, to: Math.floor(next.getTime() / 1000) };
}

/** The checks a coin launched at `launchedAtSec` must have this week: every one whose moment is at or after launch. */
export function gen8RequiredChecks(moments: Date[], launchedAtSec: number): number[] {
  return moments.map((m, i) => (Math.floor(m.getTime() / 1000) >= launchedAtSec ? i : -1)).filter((i) => i >= 0);
}

/** The hard skip list of one coin (lowercase). `censusExclusions` = evm_gen8_holder_exclusions for the chain. */
export function gen8HardSkip(input: { token: string; vault: string; operator: string; creator: string | null; censusExclusions: Iterable<string> }): Set<string> {
  const skip = new Set<string>([DEAD, lc(ethers.ZeroAddress), lc(input.token), lc(input.vault), lc(input.operator)]);
  if (input.creator) skip.add(lc(input.creator));
  for (const w of input.censusExclusions) skip.add(lc(w));
  return skip;
}

/**
 * Holders at one check from raw balances (same semantics as payoutWatchdog eligibleAt). `contracts` stays in the
 * signature for the gen-6/7-style callers; gen-8 passes an EMPTY set (only known contracts are skipped, via `skip`).
 * softExcluded / eligibleSupply let the watchdog bound the configured + risk exclusions.
 */
export function gen8EligibleAt(
  balances: Map<string, bigint>,
  skip: Set<string>,
  soft: Set<string>,
  contracts: Set<string>,
): { holders: HolderBalance[]; softExcluded: bigint; eligibleSupply: bigint } {
  const holders: HolderBalance[] = [];
  let softExcluded = 0n;
  let eligibleSupply = 0n;
  for (const [raw, amount] of balances) {
    const wallet = lc(raw);
    if (amount <= 0n || skip.has(wallet) || contracts.has(wallet)) continue;
    eligibleSupply += amount;
    if (soft.has(wallet)) {
      softExcluded += amount;
      continue;
    }
    holders.push({ owner: wallet, amount });
  }
  holders.sort((a, b) => a.owner.localeCompare(b.owner));
  return { holders, softExcluded, eligibleSupply };
}

/** One coin's shares of `pot` from its checks (each: totalSupply and the holders at that check). */
export function gen8HolderShares(pot: bigint, checks: Array<{ supply: bigint; holders: HolderBalance[] }>): Map<string, bigint> {
  return allocateToHolders(pot, holdThroughBalances(checks.map((c) => ({ supply: c.supply, balances: c.holders }))));
}

/**
 * One check of one pool. `softExcluded`: the wallets the operator left out at this check because they were on the
 * configured or risk list AT THAT TIME (lowercase, sorted). The watchdog accepts this list within its bounds instead
 * of re-reading lists that may have changed since the check.
 */
export type Gen8LeafCheck = { index: number; block: number; blockTime: number; supply: string; holders: number; softExcluded: string[] };

/**
 * The published leaf file of one weekly gen-8 holder batch (version 2: hold-through). `pools[].amount` is what the
 * proposal moves for the pool (after the payout minimum); `pot` is the pool's holder pot the shares were computed from
 * (after the vault's weekly room); `checks` are the hints the watchdog verifies against the chain.
 */
export type Gen8LeafFileV2 = {
  kind: "mwz-evm-gen8-holder-batch";
  version: 2;
  rule: typeof GEN8_HOLDER_RULE;
  chainId: number;
  vault: string;
  holderDistributor: string;
  weekId: string;
  batchId: string;
  program: "airdrop_holders_gen8";
  claimDeadline: number;
  root: string;
  total: string;
  pools: Array<{ poolId: string; token: string; amount: string; pot: string; launchedAt: number; checks: Gen8LeafCheck[] }>;
  leaves: Array<{ account: string; amount: string; parts: Array<{ poolId: string; amount: string }> }>;
};

/** Structural checks of a v2 file (no chain): ids, sums, one leaf per account, parts add up per leaf and per pool. */
export function checkGen8LeafFileShape(file: Gen8LeafFileV2): void {
  if (file.kind !== "mwz-evm-gen8-holder-batch" || file.version !== 2 || file.rule !== GEN8_HOLDER_RULE) throw new Error("not a gen-8 v2 hold-through leaf file");
  if (file.program !== "airdrop_holders_gen8") throw new Error(`program ${file.program}`);
  if (lc(holderBatchId(file.chainId, file.weekId, file.program)) !== lc(file.batchId)) throw new Error("batch id is not holderBatchId(chain, week, program)");
  const seen = new Set<string>();
  const byPool = new Map<string, bigint>();
  let total = 0n;
  for (const leaf of file.leaves) {
    const account = lc(leaf.account);
    if (seen.has(account)) throw new Error(`account ${account} twice`);
    seen.add(account);
    const amount = BigInt(leaf.amount);
    if (amount <= 0n) throw new Error(`account ${account}: amount ${leaf.amount}`);
    const parts = leaf.parts.reduce((s, p) => s + BigInt(p.amount), 0n);
    if (parts !== amount) throw new Error(`account ${account}: parts ${parts} != ${amount}`);
    for (const p of leaf.parts) byPool.set(lc(p.poolId), (byPool.get(lc(p.poolId)) ?? 0n) + BigInt(p.amount));
    total += amount;
  }
  if (total !== BigInt(file.total)) throw new Error(`leaves add up to ${total}, file says ${file.total}`);
  const pools = new Set<string>();
  for (const pool of file.pools) {
    const id = lc(pool.poolId);
    if (pools.has(id)) throw new Error(`pool ${id} twice`);
    pools.add(id);
    if ((byPool.get(id) ?? 0n) !== BigInt(pool.amount)) throw new Error(`pool ${id}: parts ${byPool.get(id) ?? 0n} != ${pool.amount}`);
    if (BigInt(pool.amount) > BigInt(pool.pot)) throw new Error(`pool ${id}: amount above its pot`);
    const idx = pool.checks.map((c) => c.index);
    if (new Set(idx).size !== idx.length || idx.some((i) => !Number.isInteger(i) || i < 0 || i >= GEN8_CHECKS)) throw new Error(`pool ${id}: bad check indices`);
  }
  for (const id of byPool.keys()) if (!pools.has(id)) throw new Error(`leaf parts name pool ${id} that is not in pools`);
}
