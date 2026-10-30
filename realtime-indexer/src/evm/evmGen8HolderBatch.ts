/**
 * Gen-8 holder batch planner. Pool ids are bytes32, not campaign addresses. The batch id uses program
 * "airdrop_holders_gen8", so it cannot collide with a gen-6 or gen-7 batch for the same week.
 *
 * This module builds the leaf file, the operator propose calldata, and the Safe batch. It does not send any of
 * them. The Safe batch is approveHolderBatch (4 arguments, including claimDeadline) plus authorizeBatch.
 * executeHolderBatch is not in the batch.
 *
 * Barkswap (DogeOS): pool ids are the pool address left-padded to bytes32 (evmGen8Bark.ts barkPoolId), so the plan is
 * keyed the same way, but MwzBarkCreatorChoiceVault.proposeHolderBatch takes the coins (address[]), not pool ids:
 * pass `barkswapCoins` (pool id -> coin) and the propose call and the leaf file name the coins.
 */
import { ethers } from "ethers";
import { allocateToHolders, holderLeaves, type HolderBalance } from "../dbc/dbcCreatorChoice.js";
import { fitPotsToRoom, holderBatchId, merklePlan } from "./evmCreatorChoice.js";
import { GEN8_APPROVE_HOLDER_BATCH_SELECTOR } from "./evmGen8Abi.js";
import { GEN8_HOLDER_RULE, checkGen8LeafFileShape, gen8HolderShares, type Gen8LeafCheck, type Gen8LeafFileV2 } from "./evmGen8HoldThrough.js";

export const GEN8_HOLDER_PROGRAM = "airdrop_holders_gen8";
export const GEN8_MIN_CLAIM_WINDOW_SEC = 7 * 86_400;
export const GEN8_MAX_CLAIM_WINDOW_SEC = 365 * 86_400;
const PUBLISH_WINDOW_SEC = 6 * 86_400;

const APPROVE_IFACE = new ethers.Interface([
  "function approveHolderBatch(bytes32 batchId, bytes32 root, uint256 total, uint64 claimDeadline)",
  "function authorizeBatch(bytes32 batchId, uint256 maxAmount, uint64 publishAfter, uint64 publishDeadline)",
  "function executeHolderBatch(bytes32 batchId)",
  "function proposeHolderBatch(bytes32 batchId, bytes32 root, uint64 claimDeadline, bytes32[] ids, uint256[] amounts)",
]);
const BARK_PROPOSE_IFACE = new ethers.Interface([
  "function proposeHolderBatch(bytes32 batchId, bytes32 root, uint64 claimDeadline, address[] coins, uint256[] amounts)",
]);

export function gen8PoolId(id: string): string {
  const raw = String(id || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(raw)) throw new Error(`gen-8 holder batch pool id must be bytes32, got ${id}`);
  return raw;
}

/**
 * claimDeadline = executableAt + claimWindowDays. The vault requires
 * executableAt + 7 days <= deadline <= now + 365 days. A 60-day window with a 24 h delay fits. A 6-day window does not.
 */
export function gen8ClaimDeadline(nowSec: number, holderBatchDelaySec: number, claimWindowDays: number): number {
  if (!Number.isInteger(nowSec) || nowSec <= 0) throw new Error("nowSec required");
  if (!Number.isInteger(holderBatchDelaySec) || holderBatchDelaySec < 0) throw new Error("holder batch delay required");
  if (!Number.isInteger(claimWindowDays) || claimWindowDays < 1) throw new Error("claim window required");
  const executableAt = nowSec + holderBatchDelaySec;
  const min = executableAt + GEN8_MIN_CLAIM_WINDOW_SEC;
  const max = nowSec + GEN8_MAX_CLAIM_WINDOW_SEC;
  const wanted = executableAt + claimWindowDays * 86_400;
  if (wanted < min || wanted > max) {
    throw new Error(`claim deadline ${wanted} is outside [${min}, ${max}]`);
  }
  return wanted;
}

export type Gen8LeafFile = {
  kind: "mwz-evm-gen8-holder-batch";
  version: 1;
  chainId: number;
  vault: string;
  holderDistributor: string;
  weekId: string;
  batchId: string;
  program: typeof GEN8_HOLDER_PROGRAM;
  claimDeadline: number;
  root: string;
  total: string;
  /** `coin` on Barkswap only (the vault is keyed by coin). */
  pools: Array<{ poolId: string; coin?: string; amount: string }>;
  leaves: Array<{ account: string; amount: string; parts: Array<{ poolId: string; amount: string }> }>;
};

export type Gen8PlannedCall = { contract: string; to: string; fn: string; args: unknown[]; data: string; note: string };

export type Gen8HolderPlan = {
  file: Gen8LeafFile | null;
  reason: string;
  /** Empty. This planner never broadcasts. */
  sends: [];
  propose: { fn: "proposeHolderBatch"; args: [string, string, bigint, string[], bigint[]]; data: string } | null;
  safe: { applied: false; executes: false; calls: Gen8PlannedCall[] } | null;
};

function leafParts(perCoin: Map<string, Map<string, bigint>>, account: string): Array<{ poolId: string; amount: string }> {
  const key = account.toLowerCase();
  const parts: Array<{ poolId: string; amount: bigint }> = [];
  for (const [poolId, shares] of perCoin) {
    for (const [owner, amount] of shares) if (owner.toLowerCase() === key && amount > 0n) parts.push({ poolId, amount });
  }
  return parts.sort((a, b) => (a.poolId < b.poolId ? -1 : 1)).map((p) => ({ poolId: p.poolId, amount: p.amount.toString() }));
}

export function planGen8HolderWeek(input: {
  chainId: number;
  vault: string;
  holderDistributor: string;
  weekId: string;
  nowSec: number;
  holderBatchDelaySec: number;
  claimWindowDays: number;
  minPayoutWei: bigint;
  roomWei: bigint;
  /** Authorization cap on the holder distributor. The Safe call is refused above it. */
  authCapWei: bigint;
  pots: Map<string, bigint>;
  holders: Map<string, HolderBalance[]>;
  /** Barkswap only: pool id -> coin. Every planned pool must have its coin. */
  barkswapCoins?: Map<string, string>;
}): Gen8HolderPlan {
  const empty = (reason: string): Gen8HolderPlan => ({ file: null, reason, sends: [], propose: null, safe: null });
  if (input.pots.size === 0) return empty("no holder balance this week");
  if (input.roomWei <= 0n) return empty("the vault's weekly holder cap is used up");
  if (input.authCapWei <= 0n) return empty("the holder authorization cap is not set");
  let claimDeadline: number;
  try {
    claimDeadline = gen8ClaimDeadline(input.nowSec, input.holderBatchDelaySec, input.claimWindowDays);
  } catch (error) {
    return empty(error instanceof Error ? error.message : String(error));
  }
  const pots = new Map<string, bigint>();
  for (const [id, amount] of input.pots) pots.set(gen8PoolId(id), amount);
  const holders = new Map<string, HolderBalance[]>();
  for (const [id, rows] of input.holders) holders.set(gen8PoolId(id), rows);
  const fitted = fitPotsToRoom(pots, input.roomWei);
  const perCoin = new Map<string, Map<string, bigint>>();
  for (const [poolId, pot] of fitted) perCoin.set(poolId, allocateToHolders(pot, holders.get(poolId) ?? []));
  const { leaves, paidByPool } = holderLeaves(perCoin, input.minPayoutWei);
  const entries = [...leaves.entries()]
    .map(([account, amount]) => ({ account: ethers.getAddress(account), amount }))
    .sort((a, b) => (a.account.toLowerCase() < b.account.toLowerCase() ? -1 : 1));
  const total = entries.reduce((sum, entry) => sum + entry.amount, 0n);
  if (total <= 0n) return empty("every holder is below the minimum payout");
  if (total > input.authCapWei) return empty(`holder batch total ${total} is above the authorization cap ${input.authCapWei}`);
  const pools = [...paidByPool.entries()]
    .filter(([, amount]) => amount > 0n)
    .map(([poolId, amount]) => ({ poolId, amount }))
    .sort((a, b) => (a.poolId < b.poolId ? -1 : 1));
  const byPool = pools.reduce((sum, pool) => sum + pool.amount, 0n);
  const coinOf = (poolId: string): string => {
    const coin = input.barkswapCoins?.get(poolId);
    if (!coin || !ethers.isAddress(coin)) throw new Error(`no coin for Barkswap pool id ${poolId}`);
    return coin.toLowerCase();
  };
  if (byPool !== total) throw new Error(`holder leaves (${total}) and pool amounts (${byPool}) disagree`);
  const { root } = merklePlan(entries);
  const batchId = holderBatchId(input.chainId, input.weekId, GEN8_HOLDER_PROGRAM);
  const file: Gen8LeafFile = {
    kind: "mwz-evm-gen8-holder-batch",
    version: 1,
    chainId: input.chainId,
    vault: ethers.getAddress(input.vault),
    holderDistributor: ethers.getAddress(input.holderDistributor),
    weekId: input.weekId,
    batchId,
    program: GEN8_HOLDER_PROGRAM,
    claimDeadline,
    root,
    total: total.toString(),
    pools: pools.map((pool) => (input.barkswapCoins ? { poolId: pool.poolId, coin: coinOf(pool.poolId), amount: pool.amount.toString() } : { poolId: pool.poolId, amount: pool.amount.toString() })),
    leaves: entries.map((entry) => ({ account: entry.account, amount: entry.amount.toString(), parts: leafParts(perCoin, entry.account) })),
  };
  const bark = Boolean(input.barkswapCoins);
  const poolIds = file.pools.map((pool) => (bark ? pool.coin! : pool.poolId));
  const amounts = file.pools.map((pool) => BigInt(pool.amount));
  const proposeArgs = [file.batchId, file.root, BigInt(file.claimDeadline), poolIds, amounts] as [string, string, bigint, string[], bigint[]];
  const executableAt = input.nowSec + input.holderBatchDelaySec;
  const approveData = APPROVE_IFACE.encodeFunctionData("approveHolderBatch", [file.batchId, file.root, total, file.claimDeadline]);
  if (approveData.slice(0, 10) !== GEN8_APPROVE_HOLDER_BATCH_SELECTOR) {
    throw new Error(`approve calldata selector ${approveData.slice(0, 10)} is not ${GEN8_APPROVE_HOLDER_BATCH_SELECTOR}`);
  }
  const calls: Gen8PlannedCall[] = [
    {
      contract: bark ? "MwzBarkCreatorChoiceVault" : "MwzCreatorChoiceVault",
      to: file.vault,
      fn: "approveHolderBatch",
      args: [file.batchId, file.root, total.toString(), String(file.claimDeadline)],
      data: approveData,
      note: "Safe approves this exact root, total and claim deadline. Not sent by the planner.",
    },
    {
      contract: "RewardDistributor",
      to: file.holderDistributor,
      fn: "authorizeBatch",
      args: [file.batchId, total.toString(), String(executableAt), String(executableAt + PUBLISH_WINDOW_SEC)],
      data: APPROVE_IFACE.encodeFunctionData("authorizeBatch", [file.batchId, total, executableAt, executableAt + PUBLISH_WINDOW_SEC]),
      note: "publishable when the vault veto window ends, for 6 days",
    },
  ];
  if (calls.some((call) => call.fn === "executeHolderBatch")) throw new Error("the Safe proposal must not execute the batch");
  return {
    file,
    reason: "built",
    sends: [],
    propose: { fn: "proposeHolderBatch", args: proposeArgs, data: (bark ? BARK_PROPOSE_IFACE : APPROVE_IFACE).encodeFunctionData("proposeHolderBatch", proposeArgs) },
    safe: { applied: false, executes: false, calls },
  };
}

// ------------------------------------------------------------------------------------ version 2 (hold-through)

/** One coin's week for the v2 planner: its holder pot on chain and every check it was required to have, in order. */
export type Gen8PoolWeek = {
  poolId: string;
  token: string;
  /** Launch block time (unix seconds): which checks the coin had to have (gen8RequiredChecks). */
  launchedAt: number;
  /** vault.holderBalance(id) at build time. */
  pot: bigint;
  /** The checks, index ascending; `balances` are the stored holders of the check (gen8EligibleAt, soft ones removed). */
  checks: Array<Gen8LeafCheck & { balances: HolderBalance[] }>;
};

export type Gen8HolderPlanV2 = {
  file: Gen8LeafFileV2 | null;
  reason: string;
  /** Empty. This planner never broadcasts. */
  sends: [];
  propose: { fn: "proposeHolderBatch"; args: [string, string, bigint, string[], bigint[]]; data: string } | null;
  /** The manual fallback: what the Safe signs (approveHolderBatch 4 args + authorizeBatch); never executes. */
  safe: { applied: false; executes: false; calls: Gen8PlannedCall[] } | null;
};

/** MwzCreatorChoiceVault.MAX_BATCH_COINS: the largest pots first, the rest roll over. */
export const GEN8_MAX_BATCH_COINS = 200;

/**
 * The week's v2 (hold-through) leaf file: per coin gen8HolderShares over its checks (lowest balance, 0.01% at every
 * check) of its pot fitted into the vault's weekly room (and the distributor authorization, when known), then one leaf
 * per wallet with the payout minimum (holderLeaves). `pools` lists only coins that move money (amount > 0): the vault
 * refuses a zero amount. A coin's unpaid part stays in its holder balance and rolls over.
 */
export function planGen8HolderWeekV2(input: {
  chainId: number;
  vault: string;
  holderDistributor: string;
  weekId: string;
  nowSec: number;
  holderBatchDelaySec: number;
  claimWindowDays: number;
  minPayoutWei: bigint;
  /** maxHolderBatchPerWeek minus what the vault already counts for its current week. */
  roomWei: bigint;
  /** The distributor authorization's maxAmount when it exists (the batch must fit it), else an optional config cap. */
  authCapWei: bigint | null;
  pools: Gen8PoolWeek[];
}): Gen8HolderPlanV2 {
  const empty = (reason: string): Gen8HolderPlanV2 => ({ file: null, reason, sends: [], propose: null, safe: null });
  const withPot = input.pools.filter((p) => p.pot > 0n && p.checks.length > 0);
  if (!withPot.length) return empty("no holder balance with its checks this week");
  let room = input.roomWei;
  if (input.authCapWei != null && input.authCapWei < room) room = input.authCapWei;
  if (room <= 0n) return empty(input.roomWei <= 0n ? "the vault's weekly holder cap is used up" : "the holder authorization cap is zero");
  let claimDeadline: number;
  try {
    claimDeadline = gen8ClaimDeadline(input.nowSec, input.holderBatchDelaySec, input.claimWindowDays);
  } catch (error) {
    return empty(error instanceof Error ? error.message : String(error));
  }
  const byId = new Map<string, Gen8PoolWeek>();
  for (const p of withPot) {
    const id = gen8PoolId(p.poolId);
    if (byId.has(id)) throw new Error(`pool ${id} twice`);
    const idx = p.checks.map((c) => c.index);
    if (idx.some((v, i) => i > 0 && v <= idx[i - 1])) throw new Error(`pool ${id}: checks must be in index order`);
    byId.set(id, p);
  }
  const top = [...byId.entries()]
    .sort((a, b) => (b[1].pot > a[1].pot ? 1 : b[1].pot < a[1].pot ? -1 : a[0] < b[0] ? -1 : 1))
    .slice(0, GEN8_MAX_BATCH_COINS);
  const fitted = fitPotsToRoom(new Map(top.map(([id, p]) => [id, p.pot])), room);
  const perCoin = new Map<string, Map<string, bigint>>();
  for (const [id, pot] of fitted) {
    const p = byId.get(id)!;
    perCoin.set(id, gen8HolderShares(pot, p.checks.map((c) => ({ supply: BigInt(c.supply), holders: c.balances }))));
  }
  const { leaves, paidByPool } = holderLeaves(perCoin, input.minPayoutWei);
  const entries = [...leaves.entries()]
    .map(([account, amount]) => ({ account: ethers.getAddress(account), amount }))
    .sort((a, b) => (a.account.toLowerCase() < b.account.toLowerCase() ? -1 : 1));
  const total = entries.reduce((sum, entry) => sum + entry.amount, 0n);
  if (total <= 0n) return empty("no wallet held through every check above the minimum payout");
  const pools = [...paidByPool.entries()]
    .filter(([, amount]) => amount > 0n)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([poolId, amount]) => {
      const p = byId.get(poolId)!;
      return {
        poolId,
        token: ethers.getAddress(p.token),
        amount: amount.toString(),
        pot: fitted.get(poolId)!.toString(),
        launchedAt: p.launchedAt,
        checks: p.checks.map((c) => ({ index: c.index, block: c.block, blockTime: c.blockTime, supply: String(c.supply), holders: c.holders, softExcluded: [...c.softExcluded].map((w) => w.toLowerCase()).sort() })),
      };
    });
  const byPool = pools.reduce((sum, pool) => sum + BigInt(pool.amount), 0n);
  if (byPool !== total) throw new Error(`holder leaves (${total}) and pool amounts (${byPool}) disagree`);
  const { root } = merklePlan(entries);
  const file: Gen8LeafFileV2 = {
    kind: "mwz-evm-gen8-holder-batch",
    version: 2,
    rule: GEN8_HOLDER_RULE,
    chainId: input.chainId,
    vault: ethers.getAddress(input.vault),
    holderDistributor: ethers.getAddress(input.holderDistributor),
    weekId: input.weekId,
    batchId: holderBatchId(input.chainId, input.weekId, GEN8_HOLDER_PROGRAM),
    program: GEN8_HOLDER_PROGRAM,
    claimDeadline,
    root,
    total: total.toString(),
    pools,
    leaves: entries.map((entry) => ({ account: entry.account, amount: entry.amount.toString(), parts: leafParts(perCoin, entry.account) })),
  };
  checkGen8LeafFileShape(file);
  const proposeArgs = gen8ProposeArgs(file);
  const executableAt = input.nowSec + input.holderBatchDelaySec;
  return {
    file,
    reason: "built",
    sends: [],
    propose: { fn: "proposeHolderBatch", args: proposeArgs, data: APPROVE_IFACE.encodeFunctionData("proposeHolderBatch", proposeArgs) },
    safe: { applied: false, executes: false, calls: gen8SafeCalls(file, executableAt) },
  };
}

/** proposeHolderBatch(batchId, root, claimDeadline, ids, amounts) exactly as the v2 file says. */
export function gen8ProposeArgs(file: Pick<Gen8LeafFileV2, "batchId" | "root" | "claimDeadline" | "pools">): [string, string, bigint, string[], bigint[]] {
  return [file.batchId, file.root, BigInt(file.claimDeadline), file.pools.map((p) => gen8PoolId(p.poolId)), file.pools.map((p) => BigInt(p.amount))];
}

/** The Safe's part for a v2 file (manual fallback): approveHolderBatch (4 args) and authorizeBatch. Never executes. */
export function gen8SafeCalls(file: Pick<Gen8LeafFileV2, "vault" | "holderDistributor" | "batchId" | "root" | "total" | "claimDeadline">, executableAt: number): Gen8PlannedCall[] {
  const total = BigInt(file.total);
  const approveData = APPROVE_IFACE.encodeFunctionData("approveHolderBatch", [file.batchId, file.root, total, file.claimDeadline]);
  if (approveData.slice(0, 10) !== GEN8_APPROVE_HOLDER_BATCH_SELECTOR) {
    throw new Error(`approve calldata selector ${approveData.slice(0, 10)} is not ${GEN8_APPROVE_HOLDER_BATCH_SELECTOR}`);
  }
  return [
    {
      contract: "MwzCreatorChoiceVault",
      to: file.vault,
      fn: "approveHolderBatch",
      args: [file.batchId, file.root, total.toString(), String(file.claimDeadline)],
      data: approveData,
      note: "Safe approves this exact root, total and claim deadline. Not sent by the operator.",
    },
    {
      contract: "RewardDistributor",
      to: file.holderDistributor,
      fn: "authorizeBatch",
      args: [file.batchId, total.toString(), String(executableAt), String(executableAt + PUBLISH_WINDOW_SEC)],
      data: APPROVE_IFACE.encodeFunctionData("authorizeBatch", [file.batchId, total, executableAt, executableAt + PUBLISH_WINDOW_SEC]),
      note: "only when the week is not pre-authorized: publishable when the vault veto window ends, for 6 days",
    },
  ];
}
