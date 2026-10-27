/**
 * Payout watchdog, gen-8 (founder 2026-10-22: automate the gen-8 holder approval before launch). Pure rules: the
 * independent recomputation of a weekly holder batch the creator-choice operator proposed on the gen-8
 * MwzCreatorChoiceVault (BNB 56, Robinhood 4663), before the watchdog approves it through its Roles role with
 * approveHolderBatch(bytes32 batchId, bytes32 root, uint256 total, uint64 claimDeadline) (selector 0xc62732bb).
 *
 * The rule is the shared one (evmGen8HoldThrough.ts, also used by the operator): four secret checks per week from the
 * chain's week secret, each read from a block inside its window, every check at or after the coin's launch present,
 * the LOWEST balance across the checks counts when it is >= 0.01% of totalSupply at EVERY check, then pro rata of the
 * coin's pot, then the minimum payout across coins, then the merkle root.
 *
 * The published leaf file (Gen8LeafFileV2) is a source of hints only: which blocks the checks were read from, each
 * pool's pot before the minimum payout, and the wallets the operator's configured / risk lists removed at each check.
 * All are bounded here: a check block's time lies within PAYOUT_WATCHDOG_GEN8_CHECK_TOLERANCE_MIN (30) after the check's
 * secret moment; the pot is within the coin's holder balance just before the proposal; the soft-excluded wallets remove
 * at most PAYOUT_WATCHDOG_MAX_EXCLUDED_BPS of a check's eligible supply, and those not on the watchdog's own current
 * lists at most PAYOUT_WATCHDOG_MAX_UNLISTED_EXCLUDED_BPS (each one is reported in a warning).
 *
 * Contracts (founder 2026-10-22, "only skip known contracts"): no code check. Only the hard skip list (gen8HardSkip,
 * with the vault's creator AT EACH CHECK BLOCK, replayed from CoinRegistered and CreatorTransferred) and the soft list
 * remove a holder; any other address with a balance is paid, contract or not. Every wallet, balance, supply, share, leaf, per-pool amount, total
 * and root is rebuilt from the chain (the proposing calldata, the vault, the token's Transfer logs) and compared.
 * Any difference: not approved. Chain reads: payoutWatchdogGen8Chain.ts. Loop: payoutWatchdogWorker.ts.
 */
import { ethers } from "ethers";
import { holderLeaves, type HolderBalance } from "../dbc/dbcCreatorChoice.js";
import { CHOICE, holderBatchId, merklePlan, previousWeek, weekSecret } from "./evmCreatorChoice.js";
import { GEN8_APPROVE_HOLDER_BATCH_SELECTOR } from "./evmGen8Abi.js";
import {
  checkGen8LeafFileShape,
  gen8CheckMoments,
  gen8CheckWindow,
  gen8EligibleAt,
  gen8HardSkip,
  gen8HolderShares,
  gen8RequiredChecks,
  type Gen8LeafFileV2,
} from "./evmGen8HoldThrough.js";
import { GEN8_HOLDER_PROGRAM } from "./evmGen8HolderBatch.js";
import type { HolderProposal } from "./payoutWatchdog.js";

const DAY_S = 86_400;

export const GEN8_PROPOSE_IFACE = new ethers.Interface([
  "function proposeHolderBatch(bytes32 batchId, bytes32 root, uint64 claimDeadline, bytes32[] ids, uint256[] amounts) returns (uint256 total)",
]);
export const GEN8_APPROVE_IFACE = new ethers.Interface([
  "function approveHolderBatch(bytes32 batchId, bytes32 root, uint256 total, uint64 claimDeadline)",
]);

/** approveHolderBatch(batchId, root, total, claimDeadline) calldata; refuses anything but selector 0xc62732bb. */
export function gen8ApproveCalldata(batchId: string, root: string, total: bigint, claimDeadline: bigint): string {
  const data = GEN8_APPROVE_IFACE.encodeFunctionData("approveHolderBatch", [batchId, root, total, claimDeadline]);
  if (data.slice(0, 10) !== GEN8_APPROVE_HOLDER_BATCH_SELECTOR) throw new Error(`gen-8 approve selector ${data.slice(0, 10)}`);
  return data;
}

export type Gen8VaultFacts = { holderDistributor: string; operator: string };

/** A registered coin: the vault's cfg(id) and its CoinRegistered log (emitted in the launch transaction). */
/**
 * A registered coin: the vault's cfg(id) now and its creator history. `creators` starts with CoinRegistered's creator
 * at the launch block, then one entry per CreatorTransferred (block, next), in chain order; the creator at block b is the
 * last entry with block <= b. `creator` is cfg(id).creator now (must equal the last entry).
 */
export type Gen8CoinFacts = { choice: number; token: string; creator: string; registeredToken: string; launchBlock: number; creators: Array<{ block: number; creator: string }> };

/** The vault's creator of a coin at the end of `block` (lowercase). */
export function gen8CreatorAt(creators: Gen8CoinFacts["creators"], block: number): string | null {
  let out: string | null = null;
  for (const c of creators) if (c.block <= block) out = c.creator.toLowerCase();
  return out;
}

/** A wallet the operator's soft list removed at a check although it is on neither of the watchdog's current lists. */
export type Gen8UnlistedExclusion = { poolId: string; index: number; block: number; wallet: string; amount: bigint };

export const GEN8_DEFAULT_CHECK_TOLERANCE_SEC = 30 * 60;
export const GEN8_DEFAULT_MAX_UNLISTED_EXCLUDED_BPS = 200;

/**
 * One Transfer replay of a token from its launch block: the balance of every non-zero address after the last Transfer
 * at or before each requested block, the replayed supply (minted minus burned) there, and at the end of the replay the
 * replayed supply against the token's totalSupply() read at that same block (proves the replay misses no mint / burn).
 */
export type Gen8Census = {
  at: Map<number, Map<string, bigint>>;
  supplyAt: Map<number, bigint>;
  end: { block: number; replayed: bigint; onChain: bigint };
};

export type Gen8VerifyDeps = {
  vault(): Promise<Gen8VaultFacts>;
  coin(poolId: string): Promise<Gen8CoinFacts | null>;
  blockTime(block: number): Promise<number>;
  census(token: string, launchBlock: number, blocks: number[]): Promise<Gen8Census>;
  /** The pool's holderBalance at the end of block `block - 1` (just before anything in the proposal's block). */
  holderBalanceBefore(poolId: string, block: number): Promise<bigint>;
  /** The chain's census exclusions (gen8HolderExclusions of the gen-8 config + the side pools). */
  censusExclusions(): Promise<Iterable<string>>;
};

export type Gen8VerifyConfig = {
  minPayoutWei: bigint;
  claimWindowDays: number;
  /** EVM_HOLDER_EXCLUDED_WALLETS (lowercase). */
  excluded: Set<string>;
  /** Risk-excluded wallets (the same table the operator reads). */
  riskExcluded: Set<string>;
  /** EVM_BUYBACK_SEED_SECRET. Without it the check moments cannot be derived and nothing is approved. */
  masterSecret: string | null;
  /**
   * The chain's secret of the batch's week itself (evmCreatorChoice.weekSecret), for a Safe signer who was given only
   * that week's secret (scripts/evm-gen8-holder-batch-verify.mjs --week-secret). The watchdog never sets it.
   */
  weekSecret?: string | null;
  /** Most of a coin's eligible supply the file's soft-excluded wallets may remove at any check (bps). */
  maxExcludedBps: number;
  /** Most of it the soft-excluded wallets NOT on `excluded` / `riskExcluded` today may remove (bps; default 200). */
  maxUnlistedExcludedBps?: number;
  /** A check block's time must be within this many seconds after the check's moment (default 1800). */
  checkToleranceSec?: number;
};

export type Gen8VerifyResult =
  | { ok: true; weekId: string; root: string; total: bigint; claimDeadline: bigint; leaves: number; pools: number; checks: Record<string, number[]>; unlisted: Gen8UnlistedExclusion[] }
  | { ok: false; kind: "mismatch" | "missing"; reasons: string[] };

const lc = (a: string) => String(a || "").toLowerCase();
const sameAddr = (a: string | null | undefined, b: string | null | undefined) => lc(a || "") === lc(b || "");
const mismatch = (reason: string): Gen8VerifyResult => ({ ok: false, kind: "mismatch", reasons: [reason] });
const missing = (reason: string): Gen8VerifyResult => ({ ok: false, kind: "missing", reasons: [reason] });

function big(v: unknown, what: string): bigint {
  const s = String(v ?? "");
  if (!/^\d+$/.test(s)) throw new Error(`${what} is not a non-negative integer: ${s}`);
  return BigInt(s);
}

/**
 * Recomputes a proposed gen-8 holder batch from chain data and compares it with the proposal. Returns ok only when the
 * proposal is exactly what the shared rule gives for the chain's balances at the checked blocks.
 */
export async function verifyGen8HolderProposal(p: HolderProposal, file: Gen8LeafFileV2 | null, deps: Gen8VerifyDeps, cfg: Gen8VerifyConfig): Promise<Gen8VerifyResult> {
  // 1. The proposing transaction is exactly the 4-argument proposeHolderBatch on this vault, with what the event says.
  if (p.program !== GEN8_HOLDER_PROGRAM) return mismatch(`program ${p.program} is not ${GEN8_HOLDER_PROGRAM}`);
  if (!sameAddr(p.txTo, p.vault)) return mismatch(`the proposing transaction went to ${p.txTo}, not the vault`);
  let decoded: ethers.TransactionDescription | null = null;
  try {
    decoded = GEN8_PROPOSE_IFACE.parseTransaction({ data: p.txData });
  } catch {
    decoded = null;
  }
  if (!decoded || decoded.name !== "proposeHolderBatch") return mismatch("the proposing transaction is not the gen-8 proposeHolderBatch(bytes32,bytes32,uint64,bytes32[],uint256[])");
  const [cBatchId, cRoot, cDeadline, cIdsRaw, cAmountsRaw] = decoded.args as unknown as [string, string, bigint, string[], bigint[]];
  const cIds = [...cIdsRaw].map(lc);
  const cAmounts = [...cAmountsRaw].map((a) => BigInt(a));
  if (!sameAddr(cBatchId, p.batchId) || !sameAddr(cRoot, p.root) || BigInt(cDeadline) !== p.claimDeadline) return mismatch("calldata id / root / deadline differ from the event");
  if (!cIds.length || cIds.length !== cAmounts.length) return mismatch("calldata pool ids and amounts are empty or of different lengths");
  if (new Set(cIds).size !== cIds.length) return mismatch("calldata names a pool twice");
  const calldataTotal = cAmounts.reduce((s, a) => s + a, 0n);
  if (calldataTotal !== p.total) return mismatch(`calldata amounts add up to ${calldataTotal}, the event says ${p.total}`);

  // 2. The id is last week's gen-8 holder id for this chain; the deadline is the configured claim window.
  const week = previousWeek(new Date(p.blockTime * 1000));
  if (!sameAddr(holderBatchId(p.chainId, week.weekId, GEN8_HOLDER_PROGRAM), p.batchId)) return mismatch(`batch id is not holderBatchId(${p.chainId}, ${week.weekId}, ${GEN8_HOLDER_PROGRAM})`);
  const window = BigInt(cfg.claimWindowDays * DAY_S);
  const span = p.claimDeadline - p.executableAt;
  if (span > window || span < window - 2n * BigInt(DAY_S)) return mismatch(`claim deadline is ${span} s after executableAt, expected about ${window}`);

  // 3. The leaf file: shape, and it must name this vault, distributor, chain, week, batch, root, total and deadline.
  if (!file) return missing("no leaf file for this batch");
  const secret = cfg.weekSecret || (cfg.masterSecret ? weekSecret(cfg.masterSecret, p.chainId, week.weekId) : null);
  if (!secret) return missing("EVM_BUYBACK_SEED_SECRET is not set: the week's check moments cannot be derived");
  try {
    checkGen8LeafFileShape(file);
  } catch (error) {
    return mismatch(`leaf file: ${error instanceof Error ? error.message : String(error)}`);
  }
  const vault = await deps.vault();
  if (!sameAddr(file.vault, p.vault) || Number(file.chainId) !== p.chainId || file.weekId !== week.weekId || !sameAddr(file.batchId, p.batchId)) return mismatch("leaf file is for another vault, chain, week or batch");
  if (!sameAddr(file.holderDistributor, vault.holderDistributor)) return mismatch("leaf file names another holder distributor than the vault's");
  if (!sameAddr(file.root, p.root) || String(file.total) !== p.total.toString() || BigInt(file.claimDeadline) !== p.claimDeadline) return mismatch("leaf file root / total / claim deadline differ from the proposal");
  if (file.pools.length !== cIds.length || file.pools.some((pool, i) => lc(pool.poolId) !== cIds[i] || big(pool.amount, "pool amount") !== cAmounts[i])) {
    return mismatch("leaf file pools differ from the proposing calldata (ids, amounts or order)");
  }

  // 4. Per pool: the coin, its launch, the checks, the census at every check block, the pot, the shares.
  const moments = gen8CheckMoments(secret, p.chainId, week.start);
  const census = new Set([...(await deps.censusExclusions())].map(lc));
  const listed = new Set<string>([...cfg.excluded, ...cfg.riskExcluded].map(lc));
  const tolerance = cfg.checkToleranceSec ?? GEN8_DEFAULT_CHECK_TOLERANCE_SEC;
  const maxUnlistedBps = BigInt(cfg.maxUnlistedExcludedBps ?? GEN8_DEFAULT_MAX_UNLISTED_EXCLUDED_BPS);
  const unlisted: Gen8UnlistedExclusion[] = [];
  const noContracts = new Set<string>(); // H1: only known contracts are skipped (gen8HardSkip)
  const partsByPool = new Map<string, Map<string, bigint>>();
  for (const leaf of file.leaves) {
    for (const part of leaf.parts) {
      const id = lc(part.poolId);
      const m = partsByPool.get(id) ?? new Map<string, bigint>();
      m.set(lc(leaf.account), big(part.amount, "leaf part"));
      partsByPool.set(id, m);
    }
  }
  const perPool = new Map<string, Map<string, bigint>>();
  const checksUsed: Record<string, number[]> = {};
  for (const pool of file.pools) {
    const id = lc(pool.poolId);
    const coin = await deps.coin(id);
    if (!coin) return mismatch(`pool ${id} is not registered on the vault`);
    if (coin.choice !== CHOICE.holders && coin.choice !== CHOICE.split) return mismatch(`pool ${id} is not a holders or split coin in the vault`);
    if (!sameAddr(coin.token, coin.registeredToken)) return mismatch(`pool ${id}: the vault's token ${coin.token} is not the registered ${coin.registeredToken}`);
    if (!sameAddr(pool.token, coin.token)) return mismatch(`pool ${id}: token ${pool.token} is not the coin's ${coin.token}`);
    if (!coin.creators.length || coin.creators[0].block !== coin.launchBlock) return mismatch(`pool ${id}: the creator history does not start at the launch block`);
    if (!sameAddr(coin.creators[coin.creators.length - 1].creator, coin.creator)) return missing(`pool ${id}: the replayed creator differs from cfg(id).creator (a transfer while reading?)`);
    const launchedAt = await deps.blockTime(coin.launchBlock);
    if (Number(pool.launchedAt) !== launchedAt) return mismatch(`pool ${id}: launchedAt ${pool.launchedAt} is not the launch block time ${launchedAt}`);

    const required = gen8RequiredChecks(moments, launchedAt);
    if (!required.length) return mismatch(`pool ${id}: launched after the week's last check; it has no holders this week`);
    const checks = [...pool.checks].sort((a, b) => a.index - b.index);
    const given = checks.map((c) => c.index);
    if (given.length !== required.length || given.some((x, i) => x !== required[i])) return mismatch(`pool ${id}: checks ${JSON.stringify(given)}, the rule requires ${JSON.stringify(required)}`);
    for (const c of checks) {
      if (!Number.isInteger(Number(c.block)) || Number(c.block) < coin.launchBlock) return mismatch(`pool ${id}: check ${c.index} block ${c.block} is before the launch block ${coin.launchBlock}`);
      if (Number(c.block) >= p.blockNumber) return mismatch(`pool ${id}: check ${c.index} block ${c.block} is not before the proposal`);
      const t = await deps.blockTime(Number(c.block));
      if (t !== Number(c.blockTime)) return mismatch(`pool ${id}: check ${c.index} block ${c.block} has time ${t}, the file says ${c.blockTime}`);
      const w = gen8CheckWindow(moments, c.index, week.end);
      if (t < w.from || t >= w.to) return mismatch(`pool ${id}: check ${c.index} block ${c.block} (${t}) is outside its window [${w.from}, ${w.to})`);
      if (t > w.from + tolerance) return mismatch(`pool ${id}: check ${c.index} block ${c.block} (${t}) is ${t - w.from} s after the check's moment ${w.from}, more than the ${tolerance} s tolerance`);
      if (!Array.isArray(c.softExcluded) || c.softExcluded.some((x) => !/^0x[0-9a-f]{40}$/.test(lc(x)))) return mismatch(`pool ${id}: check ${c.index} has no valid softExcluded list`);
    }

    const pot = big(pool.pot, "pot");
    if (pot <= 0n) return mismatch(`pool ${id}: pot ${pool.pot}`);
    const before = await deps.holderBalanceBefore(id, p.blockNumber);
    if (pot > before) return mismatch(`pool ${id}: pot ${pot} is above its holder balance ${before} before the proposal`);

    const blocks = [...new Set(checks.map((c) => Number(c.block)))].sort((a, b) => a - b);
    const range = await deps.census(coin.token, coin.launchBlock, blocks);
    if (range.end.replayed !== range.end.onChain) return mismatch(`pool ${id}: the Transfer replay gives supply ${range.end.replayed} at block ${range.end.block}, totalSupply() is ${range.end.onChain}`);
    const states: Array<{ supply: bigint; holders: HolderBalance[] }> = [];
    for (const c of checks) {
      const balances = range.at.get(Number(c.block));
      const supply = range.supplyAt.get(Number(c.block));
      if (!balances || supply === undefined) return missing(`pool ${id}: no census at block ${c.block}`);
      if (supply !== big(c.supply, "check supply")) return mismatch(`pool ${id}: check ${c.index} supply ${c.supply}, the chain has ${supply} at block ${c.block}`);
      // The vault's creator at THIS check block (H2), the census exclusions, and the file's soft list for this check (M1).
      const skip = gen8HardSkip({ token: coin.token, vault: p.vault, operator: vault.operator, creator: gen8CreatorAt(coin.creators, Number(c.block)), censusExclusions: census });
      const soft = new Set(c.softExcluded.map(lc));
      const { holders, softExcluded, eligibleSupply } = gen8EligibleAt(balances, skip, soft, noContracts);
      if (holders.length !== Number(c.holders)) return mismatch(`pool ${id}: check ${c.index} at block ${c.block} has ${holders.length} holders, the file says ${c.holders}`);
      if (eligibleSupply > 0n && softExcluded * 10_000n > eligibleSupply * BigInt(cfg.maxExcludedBps)) {
        return mismatch(`pool ${id}: at check ${c.index} configured / risk exclusions remove ${softExcluded} of ${eligibleSupply} eligible tokens (over ${cfg.maxExcludedBps} bps): needs a person`);
      }
      let unlistedSupply = 0n;
      for (const w of soft) {
        const amount = balances.get(w) ?? 0n;
        if (amount <= 0n || skip.has(w) || listed.has(w)) continue;
        unlistedSupply += amount;
        unlisted.push({ poolId: id, index: c.index, block: Number(c.block), wallet: w, amount });
      }
      if (eligibleSupply > 0n && unlistedSupply * 10_000n > eligibleSupply * maxUnlistedBps) {
        return mismatch(`pool ${id}: at check ${c.index} wallets on neither of today's configured / risk lists remove ${unlistedSupply} of ${eligibleSupply} eligible tokens (over ${maxUnlistedBps} bps): needs a person`);
      }
      states.push({ supply, holders });
    }
    const shares = gen8HolderShares(pot, states);
    const expected = partsByPool.get(id) ?? new Map<string, bigint>();
    for (const [wallet, amount] of expected) {
      if (shares.get(wallet) !== amount) return mismatch(`pool ${id}: ${wallet} gets ${shares.get(wallet) ?? 0n} under the rule, the file says ${amount}`);
    }
    perPool.set(id, shares);
    checksUsed[id] = blocks;
  }

  // 5. Across pools: the minimum payout, one leaf per wallet, per-pool amounts, total and root, rebuilt here.
  const { leaves, paidByPool } = holderLeaves(perPool, cfg.minPayoutWei);
  const entries = [...leaves.entries()]
    .map(([account, amount]) => ({ account: ethers.getAddress(account), amount }))
    .sort((a, b) => (lc(a.account) < lc(b.account) ? -1 : 1));
  if (!entries.length) return mismatch("the recomputed batch pays nobody");
  const fileLeaves = file.leaves.map((l) => `${lc(l.account)}:${big(l.amount, "leaf amount")}`).sort();
  const ours = entries.map((e) => `${lc(e.account)}:${e.amount}`).sort();
  if (fileLeaves.length !== ours.length || fileLeaves.some((x, i) => x !== ours[i])) return mismatch("recomputed leaves differ from the leaf file");
  for (let i = 0; i < cIds.length; i += 1) {
    const paid = paidByPool.get(cIds[i]) ?? 0n;
    if (paid !== cAmounts[i]) return mismatch(`pool ${cIds[i]}: recomputed amount ${paid}, proposed ${cAmounts[i]}`);
  }
  const paidPools = [...paidByPool.entries()].filter(([, v]) => v > 0n).map(([id]) => id);
  if (paidPools.length !== cIds.length) return mismatch("the recomputed batch pays a different set of pools");
  const total = entries.reduce((s, e) => s + e.amount, 0n);
  if (total !== p.total) return mismatch(`recomputed total ${total} differs from the proposed ${p.total}`);
  const { root } = merklePlan(entries);
  if (!sameAddr(root, p.root)) return mismatch(`recomputed root ${root} differs from the proposed ${p.root}`);
  return { ok: true, weekId: week.weekId, root, total, claimDeadline: p.claimDeadline, leaves: entries.length, pools: cIds.length, checks: checksUsed, unlisted };
}
