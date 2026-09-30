/**
 * EVM creator-choice operator (launch generation, BNB 56 + Robinhood 4663): pure rules only.
 * The EVM twin of src/dbc/dbcCreatorChoice.ts (Solana D5). Chain and database work lives in
 * evmCreatorChoiceChain.ts and evmCreatorChoicePass.ts.
 *
 * Weeks are the airdrop runner's weeks (Monday 00:00 UTC). One secret per chain and week, derived from
 * EVM_BUYBACK_SEED_SECRET: its sha256 is published before the week starts and the week secret itself after
 * the week ends, so anyone can recompute every buyback moment and the holder snapshot moment afterwards.
 *   week secret      = HMAC-SHA256(master, "evm-week:" + chainId + ":" + weekId)
 *   commitment       = sha256(week secret)
 *   holder snapshot  = HMAC(week secret, "holders-snapshot:" + chainId) mod week
 *   buyback moment i = HMAC(week secret, chainId + "|" + campaign + "|" + day + "|" + i) mod day   (spec C6)
 *   conversion i     = HMAC(week secret, "convert|" + chainId + "|" + campaign + "|" + day + "|" + i) mod day
 * The chain enforces the bounds (vault limits()), not the moments.
 */
import crypto from "node:crypto";
import { ethers } from "ethers";
import { allocateToHolders, holderLeaves, type HolderBalance } from "../dbc/dbcCreatorChoice.js";

export { allocateToHolders, holderLeaves, type HolderBalance };

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;
export const DEAD = "0x000000000000000000000000000000000000dead";

/** CreatorRewardsVaultV2.Choice. */
export const CHOICE = { unset: 0, keep: 1, holders: 2, split: 3, buyback: 4 } as const;

/** Same week as the airdrop runner and the Solana worker: Monday 00:00 UTC. */
export function weekOf(at: Date): { weekId: string; start: Date; end: Date } {
  const start = new Date(at);
  const day = start.getUTCDay();
  start.setUTCDate(start.getUTCDate() + (day === 0 ? -6 : 1 - day));
  start.setUTCHours(0, 0, 0, 0);
  return { weekId: start.toISOString().slice(0, 10), start, end: new Date(start.getTime() + WEEK_MS) };
}

export function previousWeek(now: Date) {
  return weekOf(new Date(now.getTime() - WEEK_MS));
}

/** The Monday run may start once the new week is five minutes old. */
export function weeklyRunDue(now: Date): boolean {
  const day = now.getUTCDay();
  const minutesIntoWeek = ((day + 6) % 7) * 1440 + now.getUTCHours() * 60 + now.getUTCMinutes();
  return minutesIntoWeek >= 5;
}

export function weekSecret(masterSecret: string, chainId: number, weekId: string): string {
  if (!masterSecret) throw new Error("EVM_BUYBACK_SEED_SECRET is required");
  return crypto.createHmac("sha256", masterSecret).update(`evm-week:${chainId}:${weekId}`).digest("hex");
}

export function weekCommitment(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

function moment(secret: string, label: string, windowStartMs: number, windowMs: number): Date {
  const digest = crypto.createHmac("sha256", secret).update(label).digest();
  const offset = Number(digest.readBigUInt64BE(0) % BigInt(windowMs));
  return new Date(windowStartMs + offset);
}

export function snapshotMoment(secret: string, chainId: number, weekStart: Date): Date {
  return moment(secret, `holders-snapshot:${chainId}`, weekStart.getTime(), WEEK_MS);
}

function dayStartOf(day: Date): Date {
  const d = new Date(day);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Up to perDay moments for one coin on one day, sorted. kind "buyback" is spec C6's formula. */
export function dayMoments(secret: string, chainId: number, campaign: string, day: Date, perDay: number, kind: "buyback" | "convert" = "buyback"): Date[] {
  const start = dayStartOf(day);
  const key = start.toISOString().slice(0, 10);
  const c = campaign.toLowerCase();
  const out: Date[] = [];
  for (let i = 0; i < perDay; i += 1) {
    const label = kind === "buyback" ? `${chainId}|${c}|${key}|${i}` : `convert|${chainId}|${c}|${key}|${i}`;
    out.push(moment(secret, label, start.getTime(), DAY_MS));
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/**
 * The latest moment that has passed (yesterday or today), if it is not in `used`. Moments are never caught up:
 * a moment missed (worker down, interval, nothing to spend) is simply skipped, so a buy never lands at a time that
 * anyone could predict from the previous one. Keys are "YYYY-MM-DD:i" (i = the moment's rank that day).
 */
export function dueMomentKey(input: {
  masterSecret: string;
  chainId: number;
  campaign: string;
  now: Date;
  perDay: number;
  kind?: "buyback" | "convert";
  used: Set<string>;
}): string | null {
  let latest: { at: number; key: string } | null = null;
  for (const day of [new Date(input.now.getTime() - DAY_MS), input.now]) {
    const secret = weekSecret(input.masterSecret, input.chainId, weekOf(day).weekId);
    const moments = dayMoments(secret, input.chainId, input.campaign, day, input.perDay, input.kind ?? "buyback");
    for (let i = 0; i < moments.length; i += 1) {
      const at = moments[i].getTime();
      if (at > input.now.getTime()) continue;
      if (!latest || at >= latest.at) latest = { at, key: `${moments[i].toISOString().slice(0, 10)}:${i}` };
    }
  }
  return latest && !input.used.has(latest.key) ? latest.key : null;
}

// ------------------------------------------------------------------------------------ vault limits

export type VaultLimits = {
  paused: boolean;
  buyPerTx: bigint;
  buybackPerCampaignWeek: bigint;
  buyInterval: bigint;
  impactBps: bigint;
  holderBatchPerWeek: bigint;
};

/** The vault's week for its weekly caps: block.timestamp / 1 weeks (unix weeks, not Monday weeks). */
export function vaultWeek(unixSeconds: bigint | number): bigint {
  return BigInt(unixSeconds) / 604_800n;
}

/**
 * Native the vault would let one buyback (curve, or pool on a native pool, or a native to quote conversion)
 * spend now: the balance, the per-tx cap and what is left of the coin's weekly cap. spentThisWeek must be the
 * vault's own counter for the current vault week (the caller zeroes a counter from an earlier week).
 */
export function buybackBudget(input: { balance: bigint; limits: VaultLimits; spentThisWeek: bigint }): bigint {
  const weekLeft = input.limits.buybackPerCampaignWeek > input.spentThisWeek ? input.limits.buybackPerCampaignWeek - input.spentThisWeek : 0n;
  let b = input.balance;
  if (b > input.limits.buyPerTx) b = input.limits.buyPerTx;
  if (b > weekLeft) b = weekLeft;
  return b > 0n ? b : 0n;
}

/** Room below the vault's 95% curve-progress line: (netRaised + amountIn) * 1e4 <= target * 9500. */
export function curveRoom(netRaised: bigint, target: bigint): bigint {
  const line = (target * 9_500n) / 10_000n;
  return line > netRaised ? line - netRaised : 0n;
}

/**
 * Price after a buy on a linear curve, from the quote alone: the average price paid is the midpoint of the
 * price before and after, so after = 2 * cost / tokens - before (prices in wei per whole token, 1e18).
 */
export function linearCurvePriceAfter(priceBefore: bigint, costNoFee: bigint, tokensOut: bigint): bigint {
  if (tokensOut <= 0n) return priceBefore;
  const avg = (costNoFee * 10n ** 18n) / tokensOut;
  const after = 2n * avg - priceBefore;
  return after > priceBefore ? after : priceBefore;
}

export function impactBps(before: bigint, after: bigint): number {
  if (before <= 0n) return Number.POSITIVE_INFINITY;
  return Number(((after - before) * 10_000_000n) / before) / 1_000;
}

/** Largest spend (<= budget, >= minSpend) whose estimate stays within maxImpactBps; binary search. */
export async function sizeWithinImpact(
  budget: bigint,
  minSpend: bigint,
  maxImpactBps: number,
  estimate: (amountIn: bigint) => Promise<number | null>,
): Promise<bigint | null> {
  if (budget < minSpend || budget <= 0n) return null;
  const full = await estimate(budget);
  if (full != null && full <= maxImpactBps) return budget;
  let lo = minSpend;
  let hi = budget;
  let best: bigint | null = null;
  for (let i = 0; i < 40 && lo <= hi; i += 1) {
    const mid = (lo + hi) / 2n;
    const e = await estimate(mid);
    if (e != null && e <= maxImpactBps) {
      best = mid;
      lo = mid + 1n;
    } else {
      hi = mid - 1n;
    }
  }
  return best;
}

// ------------------------------------------------------------------------------------ holder batch

/**
 * The holder distributor batch id: the same id scripts/deploy-evm-treasury-router-v4.ts holderBatchId()
 * and the weekly runner's weeklyContractBatchId(chain, epoch, "airdrop_holders") produce.
 */
export function holderBatchId(chainId: number, weekId: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`mwz-weekly-airdrop:${chainId}:${weekId}:airdrop_holders`));
}

/** Pots above the week's room are scaled down pro rata (floor); what is not paid stays in the vault. */
export function fitPotsToRoom(pots: Map<string, bigint>, room: bigint): Map<string, bigint> {
  const total = [...pots.values()].reduce((s, v) => s + v, 0n);
  if (total <= room) return new Map(pots);
  const out = new Map<string, bigint>();
  if (room <= 0n) return out;
  for (const [k, v] of pots) {
    const scaled = (v * room) / total;
    if (scaled > 0n) out.set(k, scaled);
  }
  return out;
}

/** OpenZeppelin StandardMerkleTree leaf, as RewardDistributor.claim checks it. */
export function merkleLeaf(account: string, amount: bigint): string {
  const inner = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [ethers.getAddress(account), amount]));
  return ethers.keccak256(inner);
}

function hashPair(a: string, b: string): string {
  return ethers.keccak256(ethers.concat(a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a]));
}

/**
 * The same tree the weekly airdrop builds (frontend/scripts/weekly-airdrop/materialize.mjs merklePlan):
 * leaves in the given order, adjacent pairs hashed commutatively, an odd node promoted.
 */
export function merklePlan(entries: Array<{ account: string; amount: bigint }>): { root: string; leaves: string[]; proofs: string[][] } {
  if (!entries.length) throw new Error("cannot build an empty holder tree");
  const leaves = entries.map((e) => merkleLeaf(e.account, e.amount));
  const levels = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next: string[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? hashPair(cur[i], cur[i + 1]) : cur[i]);
    levels.push(next);
  }
  const proofs = leaves.map((_, leafIndex) => {
    const proof: string[] = [];
    let index = leafIndex;
    for (let l = 0; l < levels.length - 1; l += 1) {
      const level = levels[l];
      const pair = index % 2 === 0 ? index + 1 : index - 1;
      if (pair < level.length) proof.push(level[pair]);
      index = Math.floor(index / 2);
    }
    return proof;
  });
  return { root: levels[levels.length - 1][0], leaves, proofs };
}

export function verifyProof(root: string, leaf: string, proof: string[]): boolean {
  let h = leaf;
  for (const p of proof) h = hashPair(h, p);
  return h.toLowerCase() === root.toLowerCase();
}

export type LeafFile = {
  kind: "mwz-evm-holder-batch";
  version: 1;
  chainId: number;
  vault: string;
  holderDistributor: string;
  weekId: string;
  batchId: string;
  claimDeadline: number;
  leafEncoding: string;
  pairSorting: string;
  root: string;
  total: string;
  /** Exactly proposeHolderBatch's campaigns[] and amounts[], in calldata order. */
  campaigns: Array<{ campaign: string; amount: string }>;
  /**
   * Tree order: account ascending. `parts` (E19) says which campaign each wei of the leaf came from, campaign
   * ascending; the parts add up to the leaf. After the claim window the unclaimed leaves' parts are credited back
   * to those campaigns' holders (scripts/make-holder-recovery-batch.ts). Not part of the merkle leaf.
   */
  leaves: Array<{ account: string; amount: string; parts?: Array<{ campaign: string; amount: string }> }>;
  snapshot: { weekCommitment: string; perCampaign: Array<{ campaign: string; token: string; block: number; holders: number; pot: string }> };
};

/**
 * Builds the week's leaf file from the per-coin holder allocations. Accounts are checksummed and sorted, so
 * the root is a function of the content alone; campaigns keep only the amounts that reach a leaf.
 */
export function buildLeafFile(input: {
  chainId: number;
  vault: string;
  holderDistributor: string;
  weekId: string;
  claimDeadline: number;
  weekCommitment: string;
  perCoin: Map<string, Map<string, bigint>>;
  minPayout: bigint;
  snapshots: Array<{ campaign: string; token: string; block: number; holders: number; pot: bigint }>;
}): LeafFile | null {
  const { leaves, paidByPool } = holderLeaves(input.perCoin, input.minPayout);
  const entries = [...leaves.entries()]
    .map(([account, amount]) => ({ account: ethers.getAddress(account), amount }))
    .sort((a, b) => (a.account.toLowerCase() < b.account.toLowerCase() ? -1 : 1));
  const total = entries.reduce((s, e) => s + e.amount, 0n);
  if (total <= 0n) return null;
  const campaigns = [...paidByPool.entries()]
    .filter(([, v]) => v > 0n)
    .map(([campaign, amount]) => ({ campaign: ethers.getAddress(campaign), amount }))
    .sort((a, b) => (a.campaign.toLowerCase() < b.campaign.toLowerCase() ? -1 : 1));
  const byCampaign = campaigns.reduce((s, c) => s + c.amount, 0n);
  if (byCampaign !== total) throw new Error(`holder leaves (${total}) and campaign amounts (${byCampaign}) disagree`);
  const { root } = merklePlan(entries);
  return {
    kind: "mwz-evm-holder-batch",
    version: 1,
    chainId: input.chainId,
    vault: ethers.getAddress(input.vault),
    holderDistributor: ethers.getAddress(input.holderDistributor),
    weekId: input.weekId,
    batchId: holderBatchId(input.chainId, input.weekId),
    claimDeadline: input.claimDeadline,
    leafEncoding: "keccak256(bytes.concat(keccak256(abi.encode(account, amount))))",
    pairSorting: "openzeppelins_commutative_hash",
    root,
    total: total.toString(),
    campaigns: campaigns.map((c) => ({ campaign: c.campaign, amount: c.amount.toString() })),
    leaves: entries.map((e) => ({ account: e.account, amount: e.amount.toString(), parts: leafParts(input.perCoin, e.account) })),
    snapshot: {
      weekCommitment: input.weekCommitment,
      perCampaign: input.snapshots.map((s) => ({ campaign: ethers.getAddress(s.campaign), token: ethers.getAddress(s.token), block: s.block, holders: s.holders, pot: s.pot.toString() })),
    },
  };
}

/** E19: one leaf's amount per campaign, from the same per-coin shares holderLeaves summed. */
function leafParts(perCoin: Map<string, Map<string, bigint>>, account: string): Array<{ campaign: string; amount: string }> {
  const key = account.toLowerCase();
  const parts: Array<{ campaign: string; amount: bigint }> = [];
  for (const [campaign, shares] of perCoin) {
    for (const [owner, amount] of shares) if (owner.toLowerCase() === key && amount > 0n) parts.push({ campaign: ethers.getAddress(campaign), amount });
  }
  return parts
    .sort((a, b) => (a.campaign.toLowerCase() < b.campaign.toLowerCase() ? -1 : 1))
    .map((p) => ({ campaign: p.campaign, amount: p.amount.toString() }));
}

/**
 * E19: when the leaves carry parts, each leaf's parts add up to the leaf and each campaign's parts add up to that
 * campaign's amount. Throws on any mismatch; a file without parts passes (older files).
 */
export function checkLeafParts(file: Pick<LeafFile, "leaves" | "campaigns">): boolean {
  if (!file.leaves.some((l) => l.parts)) return false;
  const byCampaign = new Map<string, bigint>();
  for (const l of file.leaves) {
    if (!Array.isArray(l.parts) || !l.parts.length) throw new Error(`leaf ${l.account} has no parts`);
    let sum = 0n;
    for (const p of l.parts) {
      const a = BigInt(p.amount);
      if (a <= 0n) throw new Error(`non-positive part for ${l.account}`);
      const c = ethers.getAddress(p.campaign).toLowerCase();
      byCampaign.set(c, (byCampaign.get(c) || 0n) + a);
      sum += a;
    }
    if (sum !== BigInt(l.amount)) throw new Error(`parts of ${l.account} (${sum}) do not add up to its leaf (${l.amount})`);
  }
  if (byCampaign.size !== file.campaigns.length) throw new Error("leaf parts name a different set of campaigns");
  for (const c of file.campaigns) {
    if (byCampaign.get(ethers.getAddress(c.campaign).toLowerCase()) !== BigInt(c.amount)) throw new Error(`leaf parts for ${c.campaign} do not add up to its amount`);
  }
  return true;
}

/** Recomputes a leaf file's root and total and checks its internal consistency. Throws on any mismatch. */
export function checkLeafFile(file: LeafFile): { root: string; total: bigint } {
  if (file?.kind !== "mwz-evm-holder-batch" || file.version !== 1) throw new Error("not a version 1 holder leaf file");
  if (!Array.isArray(file.leaves) || !file.leaves.length) throw new Error("leaf file has no leaves");
  const seen = new Set<string>();
  const entries = file.leaves.map((l) => {
    const account = ethers.getAddress(l.account);
    if (seen.has(account.toLowerCase())) throw new Error(`duplicate account ${account}`);
    seen.add(account.toLowerCase());
    const amount = BigInt(l.amount);
    if (amount <= 0n) throw new Error(`non-positive amount for ${account}`);
    return { account, amount };
  });
  const total = entries.reduce((s, e) => s + e.amount, 0n);
  if (total.toString() !== String(file.total)) throw new Error(`total ${file.total} does not match the leaves (${total})`);
  const byCampaign = file.campaigns.reduce((s, c) => s + BigInt(c.amount), 0n);
  if (byCampaign !== total) throw new Error(`campaign amounts (${byCampaign}) do not add up to the total (${total})`);
  const { root } = merklePlan(entries);
  if (root.toLowerCase() !== String(file.root).toLowerCase()) throw new Error(`root ${file.root} does not match the leaves (${root})`);
  if (holderBatchId(file.chainId, file.weekId).toLowerCase() !== String(file.batchId).toLowerCase()) throw new Error("batch id is not this chain and week's holder batch id");
  checkLeafParts(file);
  return { root, total };
}
