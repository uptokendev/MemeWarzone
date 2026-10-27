/**
 * Test support: builds a gen-8 v2 hold-through leaf file and its propose arguments with the SHARED rule
 * (evmGen8HoldThrough.ts gen8HolderShares, holderLeaves, merklePlan, holderBatchId), the way the creator-choice
 * operator builds it. Tests only: the watchdog never builds files, it recomputes them.
 */
import { ethers } from "ethers";
import { holderLeaves, type HolderBalance } from "../../dbc/dbcCreatorChoice.js";
import { holderBatchId, merklePlan } from "../../evm/evmCreatorChoice.js";
import { GEN8_HOLDER_RULE, gen8HolderShares, type Gen8LeafFileV2 } from "../../evm/evmGen8HoldThrough.js";

export type BuildPool = {
  poolId: string;
  token: string;
  pot: bigint;
  launchedAt: number;
  /** softExcluded: the wallets the configured / risk lists removed at that check (the operator records them). */
  checks: Array<{ index: number; block: number; blockTime: number; supply: bigint; holders: HolderBalance[]; softExcluded?: string[] }>;
};

export function buildGen8LeafFileV2(input: {
  chainId: number;
  vault: string;
  holderDistributor: string;
  weekId: string;
  claimDeadline: number;
  minPayoutWei: bigint;
  pools: BuildPool[];
  /** Optional extra share per pool (a tampering operator): added on top of the rule's shares. */
  extraShares?: Map<string, Map<string, bigint>>;
}): { file: Gen8LeafFileV2; ids: string[]; amounts: bigint[] } {
  const perPool = new Map<string, Map<string, bigint>>();
  for (const pool of input.pools) {
    const shares = gen8HolderShares(pool.pot, pool.checks.map((c) => ({ supply: c.supply, holders: c.holders })));
    for (const [w, a] of input.extraShares?.get(pool.poolId.toLowerCase()) ?? []) shares.set(w, (shares.get(w) ?? 0n) + a);
    perPool.set(pool.poolId.toLowerCase(), shares);
  }
  const { leaves, paidByPool } = holderLeaves(perPool, input.minPayoutWei);
  const entries = [...leaves.entries()]
    .map(([account, amount]) => ({ account: ethers.getAddress(account), amount }))
    .sort((a, b) => (a.account.toLowerCase() < b.account.toLowerCase() ? -1 : 1));
  if (!entries.length) throw new Error("nobody is paid");
  const { root } = merklePlan(entries);
  const total = entries.reduce((s, e) => s + e.amount, 0n);
  const pools = input.pools
    .map((p) => ({ ...p, poolId: p.poolId.toLowerCase(), amount: paidByPool.get(p.poolId.toLowerCase()) ?? 0n }))
    .filter((p) => p.amount > 0n)
    .sort((a, b) => (a.poolId < b.poolId ? -1 : 1));
  const file: Gen8LeafFileV2 = {
    kind: "mwz-evm-gen8-holder-batch",
    version: 2,
    rule: GEN8_HOLDER_RULE,
    chainId: input.chainId,
    vault: ethers.getAddress(input.vault),
    holderDistributor: ethers.getAddress(input.holderDistributor),
    weekId: input.weekId,
    batchId: holderBatchId(input.chainId, input.weekId, "airdrop_holders_gen8"),
    program: "airdrop_holders_gen8",
    claimDeadline: input.claimDeadline,
    root,
    total: total.toString(),
    pools: pools.map((p) => ({
      poolId: p.poolId,
      token: ethers.getAddress(p.token),
      amount: p.amount.toString(),
      pot: p.pot.toString(),
      launchedAt: p.launchedAt,
      checks: p.checks.map((c) => ({ index: c.index, block: c.block, blockTime: c.blockTime, supply: c.supply.toString(), holders: c.holders.length, softExcluded: [...new Set((c.softExcluded ?? []).map((w) => w.toLowerCase()))].sort() })),
    })),
    leaves: entries.map((e) => ({
      account: e.account,
      amount: e.amount.toString(),
      parts: pools
        .map((p) => ({ poolId: p.poolId, amount: perPool.get(p.poolId)?.get(e.account.toLowerCase()) ?? 0n }))
        .filter((x) => x.amount > 0n)
        .map((x) => ({ poolId: x.poolId, amount: x.amount.toString() })),
    })),
  };
  return { file, ids: pools.map((p) => p.poolId), amounts: pools.map((p) => p.amount) };
}
