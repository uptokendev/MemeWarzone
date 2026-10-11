/**
 * Gen-8 fee attribution (D1 = A, design 3.4; audit 10.2). Pure maths, no RPC, no DB.
 *
 * Per trade (attribution, reward_events, recruiter credit): the slices of one HookFee, by the trader's profile at
 * trade time (tx.from + the DBC link SQL), with the gen-7 / DBC bps of the WHOLE fee F:
 *   league 3750 (weekly 30% of it, monthly the rest), recruiter / squad / airdrop by profile (dbcFeeSplit.profileBps),
 *   creator = HookFee.creatorShare (560 bps, kept in the hook, never routed), protocol = the router part minus the rest.
 * After graduation the router part (fee - creatorShare) is protocol in full (audit 10.2). Graduation fee G: recruiter /
 * squad / airdrop 1500 / 250 / 0 (linked), 1750 / 250 / 0 (OG), 0 / 0 / 1750 (unlinked), by the creator's profile
 * stored at launch; protocol the rest.
 *
 * Per run (money): MwzFeeSplitter.route(runId, recruiter, squad, airdrop, root) checks
 *   rsaMin <= recruiter + squad + airdrop <= rsaMax and squad <= squadMax, from bands(B, G) of the run totals.
 * rsaMin = floor(1500 B / 10000) + floor(1750 G / 10000). The sum of per-trade floors can be BELOW that by up to one
 * wei per trade, so a run built by summing per-trade slices reverts OutOfBand. The run amounts are therefore computed
 * from aggregate sums: per profile, the summed fee, then one floor per (profile, bucket). That can still sit a few wei
 * under rsaMin (one floor per profile instead of one per run); planRunAmounts tops the run up to rsaMin with the
 * difference in the airdrop bucket and records it as rounding. A larger gap means the indexer is missing fees and the
 * run is refused.
 *
 * The run amounts are cumulative: target = aggregate(all fees covered by every run so far + this one) minus what the
 * confirmed runs already paid per bucket. A rounding top-up or a capped run is then corrected by the next run, and
 * nothing is ever paid twice.
 */
import { ethers } from "ethers";
import { profileBps, type DbcFeeProfile } from "../dbc/dbcFeeSplit.js";

export type Gen8Profile = DbcFeeProfile;
export const GEN8_PROFILES: Gen8Profile[] = ["standard_linked", "standard_unlinked", "og_linked"];

export const BPS = 10_000n;
export const LEAGUE_BPS = 3_750n;
export const WEEKLY_OF_LEAGUE_BPS = 3_000n;
export const TRADE_RSA_MIN_BPS = 1_500n;
export const TRADE_RSA_MAX_BPS = 1_750n;
export const GRAD_RSA_MIN_BPS = 1_750n;
export const GRAD_RSA_MAX_BPS = 2_000n;
export const SQUAD_MAX_BPS = 250n;
/** Largest rounding gap the planner tops up (one wei per profile and bucket floor, with margin). */
export const MAX_ROUNDING_WEI = 16n;

const floorBps = (amount: bigint, bps: bigint) => (amount * bps) / BPS;

export function gradProfileBps(profile: Gen8Profile): { recruiter: bigint; squad: bigint; airdrop: bigint } {
  if (profile === "og_linked") return { recruiter: 1_750n, squad: 250n, airdrop: 0n };
  if (profile === "standard_linked") return { recruiter: 1_500n, squad: 250n, airdrop: 0n };
  return { recruiter: 0n, squad: 0n, airdrop: 1_750n };
}

export type Gen8Slices = {
  fee: bigint;
  creatorShare: bigint;
  routerAmount: bigint;
  leagueWeekly: bigint;
  leagueMonthly: bigint;
  recruiter: bigint;
  squad: bigint;
  airdrop: bigint;
  protocol: bigint;
};

/** One HookFee. `graduated` is HookFee.graduated (the phase the fee was charged in). */
export function gen8TradeSlices(input: { fee: bigint; creatorShare: bigint; graduated: boolean; profile: Gen8Profile }): Gen8Slices {
  const fee = BigInt(input.fee);
  const creatorShare = BigInt(input.creatorShare);
  if (creatorShare > fee || fee < 0n) throw new Error("gen-8 HookFee: creator share above the fee");
  const routerAmount = fee - creatorShare;
  if (input.graduated) {
    return { fee, creatorShare, routerAmount, leagueWeekly: 0n, leagueMonthly: 0n, recruiter: 0n, squad: 0n, airdrop: 0n, protocol: routerAmount };
  }
  const league = floorBps(fee, LEAGUE_BPS);
  const leagueWeekly = floorBps(league, WEEKLY_OF_LEAGUE_BPS);
  const leagueMonthly = league - leagueWeekly;
  const bps = profileBps(input.profile);
  const recruiter = floorBps(fee, bps.recruiter);
  const squad = floorBps(fee, bps.squad);
  const airdrop = floorBps(fee, bps.airdrop);
  const protocol = routerAmount - league - recruiter - squad - airdrop;
  if (protocol < 0n) throw new Error("gen-8 HookFee: slices exceed the router part");
  return { fee, creatorShare, routerAmount, leagueWeekly, leagueMonthly, recruiter, squad, airdrop, protocol };
}

/** One Graduated event (gradFeeNative goes to the router bucket in full; no league share). */
export function gen8GraduationSlices(input: { gradFee: bigint; profile: Gen8Profile }): Gen8Slices {
  const fee = BigInt(input.gradFee);
  const bps = gradProfileBps(input.profile);
  const recruiter = floorBps(fee, bps.recruiter);
  const squad = floorBps(fee, bps.squad);
  const airdrop = floorBps(fee, bps.airdrop);
  return { fee, creatorShare: 0n, routerAmount: fee, leagueWeekly: 0n, leagueMonthly: 0n, recruiter, squad, airdrop, protocol: fee - recruiter - squad - airdrop };
}

/** MwzFeeSplitter.bands(B, G), integer for integer (pinned against the contract in the tests). */
export function splitterBands(bondingFees: bigint, gradFees: bigint) {
  const league = floorBps(bondingFees, LEAGUE_BPS);
  const weekly = floorBps(league, WEEKLY_OF_LEAGUE_BPS);
  const monthly = league - weekly;
  const rsaMin = floorBps(bondingFees, TRADE_RSA_MIN_BPS) + floorBps(gradFees, GRAD_RSA_MIN_BPS);
  const rsaMax = floorBps(bondingFees, TRADE_RSA_MAX_BPS) + floorBps(gradFees, GRAD_RSA_MAX_BPS);
  const squadMax = floorBps(bondingFees + gradFees, SQUAD_MAX_BPS);
  return { weekly, monthly, rsaMin, rsaMax, squadMax };
}

export type Bands = ReturnType<typeof splitterBands>;

export type ProfileSums = { bonding: Record<Gen8Profile, bigint>; grad: Record<Gen8Profile, bigint> };

export function emptyProfileSums(): ProfileSums {
  return {
    bonding: { standard_linked: 0n, standard_unlinked: 0n, og_linked: 0n },
    grad: { standard_linked: 0n, standard_unlinked: 0n, og_linked: 0n },
  };
}

export function addToSums(sums: ProfileSums, row: { kind: "trade" | "graduation"; phase: "bonding" | "post"; profile: Gen8Profile | null; fee: bigint }): ProfileSums {
  if (!row.profile) return sums;
  if (row.kind === "graduation") sums.grad[row.profile] += BigInt(row.fee);
  else if (row.phase === "bonding") sums.bonding[row.profile] += BigInt(row.fee);
  return sums;
}

/** Recruiter / squad / airdrop owed for the given fee sums: one floor per (profile, bucket), never per trade. */
export function aggregateTargets(sums: ProfileSums): { recruiter: bigint; squad: bigint; airdrop: bigint } {
  let recruiter = 0n;
  let squad = 0n;
  let airdrop = 0n;
  for (const p of GEN8_PROFILES) {
    const t = profileBps(p);
    const g = gradProfileBps(p);
    recruiter += floorBps(sums.bonding[p], t.recruiter) + floorBps(sums.grad[p], g.recruiter);
    squad += floorBps(sums.bonding[p], t.squad) + floorBps(sums.grad[p], g.squad);
    airdrop += floorBps(sums.bonding[p], t.airdrop) + floorBps(sums.grad[p], g.airdrop);
  }
  return { recruiter, squad, airdrop };
}

/** The naive run (sum of per-trade floors). Kept only to prove in the tests why it is not used. */
export function perTradeFloorSum(rows: Array<{ recruiter: bigint; squad: bigint; airdrop: bigint }>) {
  return rows.reduce((acc, r) => ({ recruiter: acc.recruiter + r.recruiter, squad: acc.squad + r.squad, airdrop: acc.airdrop + r.airdrop }), { recruiter: 0n, squad: 0n, airdrop: 0n });
}

export type RunPlan =
  | { ok: true; recruiter: bigint; squad: bigint; airdrop: bigint; roundingAirdrop: bigint; carried: { recruiter: bigint; squad: bigint; airdrop: bigint } }
  | { ok: false; reason: string; recruiter: bigint; squad: bigint; airdrop: bigint };

/**
 * Fit the cumulative targets (owed minus paid) into this run's band. Order of the checks: squad cap, then the upper
 * bound (excess carried to the next run: airdrop first, then recruiter, then squad), then the lower bound (rounding
 * top-up into airdrop, at most MAX_ROUNDING_WEI; a bigger gap refuses the run: fees in the run that the indexer has
 * not attributed yet).
 */
export function planRunAmounts(target: { recruiter: bigint; squad: bigint; airdrop: bigint }, bands: Pick<Bands, "rsaMin" | "rsaMax" | "squadMax">, maxRounding = MAX_ROUNDING_WEI): RunPlan {
  let recruiter = target.recruiter > 0n ? target.recruiter : 0n;
  let squad = target.squad > 0n ? target.squad : 0n;
  let airdrop = target.airdrop > 0n ? target.airdrop : 0n;
  const carried = { recruiter: 0n, squad: 0n, airdrop: 0n };
  if (squad > bands.squadMax) {
    carried.squad += squad - bands.squadMax;
    squad = bands.squadMax;
  }
  let over = recruiter + squad + airdrop - bands.rsaMax;
  if (over > 0n) {
    const cut = (have: bigint) => (over < have ? over : have);
    const a = cut(airdrop); airdrop -= a; carried.airdrop += a; over -= a;
    const r = cut(recruiter); recruiter -= r; carried.recruiter += r; over -= r;
    const s = cut(squad); squad -= s; carried.squad += s; over -= s;
  }
  const sum = recruiter + squad + airdrop;
  let roundingAirdrop = 0n;
  if (sum < bands.rsaMin) {
    const gap = bands.rsaMin - sum;
    if (gap > maxRounding) return { ok: false, reason: `run ${gap.toString()} wei under rsaMin: fees not attributed yet`, recruiter, squad, airdrop };
    roundingAirdrop = gap;
    airdrop += gap;
  }
  return { ok: true, recruiter, squad, airdrop, roundingAirdrop, carried };
}

export const PROFILE_CODE: Record<Gen8Profile, number> = { standard_linked: 0, standard_unlinked: 1, og_linked: 2 };

/**
 * Leaf of the accrualRoot (the format published with each run; evm_gen8_route_runs.leaves keeps the rows):
 *   keccak256(bytes.concat(keccak256(abi.encode(
 *     uint256 chainId, address splitter, uint256 runId, bytes32 txHash, uint256 logIndex, uint8 kind,
 *     address trader, uint8 profile, uint256 fee, uint256 weekly, uint256 monthly, uint256 recruiter, uint256 squad,
 *     uint256 airdrop, uint256 protocol))))
 * kind 0 = bonding HookFee, 1 = Graduated, 2 = post-graduation HookFee, 3 = the run's rounding top-up (txHash 0,
 * logIndex 0, trader 0, airdrop = the top-up). Double hashing as OpenZeppelin StandardMerkleTree (no second preimage).
 * Leaves are sorted by (blockNumber, logIndex) (rounding last); pairs are hashed sorted (commutative, as
 * OpenZeppelin MerkleProof); an odd node is paired with itself.
 */
export type Gen8Leaf = {
  chainId: number;
  splitter: string;
  runId: bigint;
  txHash: string;
  logIndex: number;
  kind: 0 | 1 | 2 | 3;
  trader: string;
  profile: Gen8Profile | null;
  fee: bigint;
  weekly: bigint;
  monthly: bigint;
  recruiter: bigint;
  squad: bigint;
  airdrop: bigint;
  protocol: bigint;
};

const LEAF_TYPES = ["uint256", "address", "uint256", "bytes32", "uint256", "uint8", "address", "uint8", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"];

export function gen8LeafHash(l: Gen8Leaf): string {
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(LEAF_TYPES, [
      l.chainId, l.splitter, l.runId, l.txHash, l.logIndex, l.kind, l.trader || ethers.ZeroAddress, l.profile ? PROFILE_CODE[l.profile] : 255,
      l.fee, l.weekly, l.monthly, l.recruiter, l.squad, l.airdrop, l.protocol,
    ]),
  );
  return ethers.keccak256(ethers.concat([inner]));
}

function hashPair(a: string, b: string): string {
  return BigInt(a) <= BigInt(b) ? ethers.keccak256(ethers.concat([a, b])) : ethers.keccak256(ethers.concat([b, a]));
}

export function merkleRoot(leafHashes: string[]): string {
  if (!leafHashes.length) return ethers.ZeroHash;
  let level = [...leafHashes];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(hashPair(level[i]!, level[i + 1] ?? level[i]!));
    level = next;
  }
  return level[0]!;
}

export function merkleProof(leafHashes: string[], index: number): string[] {
  const proof: string[] = [];
  let level = [...leafHashes];
  let i = index;
  while (level.length > 1) {
    proof.push(level[i ^ 1] ?? level[i]!);
    const next: string[] = [];
    for (let k = 0; k < level.length; k += 2) next.push(hashPair(level[k]!, level[k + 1] ?? level[k]!));
    level = next;
    i = Math.floor(i / 2);
  }
  return proof;
}

export function verifyProof(leaf: string, proof: string[], root: string): boolean {
  let h = leaf;
  for (const p of proof) h = hashPair(h, p);
  return h.toLowerCase() === root.toLowerCase();
}
