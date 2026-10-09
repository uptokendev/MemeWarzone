/**
 * Payout watchdog (founder, 2026-10-08: "Safe module: yes"): pure rules. A separate key holding ONE Zodiac Roles
 * role on the treasury Safe ("payout-watchdog", scripts/lib/payoutRolesPolicy.ts) makes, in the Safe's name and only
 * after checking them itself:
 *
 *   (a) CreatorRewardsVaultV2.approveHolderBatch(batchId, root, total) for a weekly holder batch the creator-choice
 *       operator proposed, once the root and every per-campaign amount have been recomputed here from chain data
 *       (the proposing transaction's calldata, the vault, Transfer logs of each coin's token) and found equal;
 *   (b) RewardDistributor.authorizeBatch for the deterministic batch ids of the coming weeks on each listed holder
 *       and airdrop distributor, at the listed cap, never an id outside the formulas below.
 *
 * Chain and database work: payoutWatchdogChain.ts / payoutWatchdogWorker.ts. Audit:
 * docs/evm-launch/audit/PAYOUT_ROLES_MODULE.md.
 */
import { ethers } from "ethers";
import {
  CHOICE,
  DEAD,
  DEFAULT_HOLDER_PROGRAM,
  allocateToHolders,
  checkLeafFile,
  holderBatchId,
  holderLeaves,
  merklePlan,
  previousWeek,
  snapshotMoment,
  weekOf,
  weekSecret,
  type LeafFile,
} from "./evmCreatorChoice.js";

export const PAYOUT_WATCHDOG_ROLE = "payout-watchdog";
export const PAYOUT_WATCHDOG_ROLE_KEY = ethers.encodeBytes32String(PAYOUT_WATCHDOG_ROLE);
export const DAY_S = 86_400;
export const WEEK_S = 7 * DAY_S;
/** Each batch id may be published from its week's end for 6 days (scripts/make-*-calls.mjs). */
export const PUBLISH_WINDOW_S = 6 * DAY_S;
export const AIRDROP_PROGRAMS = ["airdrop_trader", "airdrop_creator"] as const;
export const MAIN_POT = "main";

// ------------------------------------------------------------------------------------ batch id schedules

/** frontend/scripts/weekly-airdrop/materialize.mjs weeklyContractBatchId (main pot: no suffix). */
export function weeklyContractBatchId(chainId: number, epochId: string, program: string, pot: string = MAIN_POT): string {
  const base = `mwz-weekly-airdrop:${chainId}:${epochId}:${program}`;
  return ethers.keccak256(ethers.toUtf8Bytes(!pot || pot === MAIN_POT ? base : `${base}:${pot}`));
}

export type AuthTarget = { batchId: string; maxAmount: bigint; publishAfter: number; publishDeadline: number; label: string };

/** Monday 00:00 UTC (unix seconds) of the week containing `nowSec`. */
export function mondayOf(nowSec: number): number {
  return Math.floor(weekOf(new Date(nowSec * 1000)).start.getTime() / 1000);
}

/**
 * Holder batch ids (scripts/make-holder-batch-preauth-calls.mjs): week W's batch is built on the Monday that ends it,
 * so authorizeBatch(holderBatchId(chain, W, program), cap, W + 7 d, W + 13 d). From the week just finished (while its
 * window is open) through `weeks` weeks from the current one.
 */
export function holderAuthTargets(input: { chainId: number; program: string; capWei: bigint; nowSec: number; weeks: number }): AuthTarget[] {
  const out: AuthTarget[] = [];
  const current = mondayOf(input.nowSec);
  for (let i = -1; i < input.weeks; i += 1) {
    const start = current + i * WEEK_S;
    const end = start + WEEK_S;
    if (end + PUBLISH_WINDOW_S <= input.nowSec) continue;
    const weekId = new Date(start * 1000).toISOString().slice(0, 10);
    out.push({ batchId: holderBatchId(input.chainId, weekId, input.program), maxAmount: input.capWei, publishAfter: end, publishDeadline: end + PUBLISH_WINDOW_S, label: `${weekId} ${input.program}` });
  }
  return out;
}

/**
 * Airdrop batch ids (scripts/make-airdrop-setup-calls.mjs): the draw of epoch E (the week that ends at Monday M) runs
 * on M, so authorizeBatch(weeklyContractBatchId(chain, E, program, pot), cap, M, M + 6 d), both programs. From the epoch
 * that ended at the last Monday (while its window is open) through `weeks` epochs after it.
 */
export function airdropAuthTargets(input: { chainId: number; pot: string; capWei: bigint; nowSec: number; weeks: number }): AuthTarget[] {
  const out: AuthTarget[] = [];
  const lastEnd = mondayOf(input.nowSec);
  for (let i = 0; i <= input.weeks; i += 1) {
    const end = lastEnd + i * WEEK_S;
    if (end + PUBLISH_WINDOW_S <= input.nowSec) continue;
    const epochId = new Date((end - WEEK_S) * 1000).toISOString().slice(0, 10);
    for (const program of AIRDROP_PROGRAMS) {
      out.push({
        batchId: weeklyContractBatchId(input.chainId, epochId, program, input.pot),
        maxAmount: input.capWei,
        publishAfter: end,
        publishDeadline: end + PUBLISH_WINDOW_S,
        label: input.pot === MAIN_POT ? `${epochId} ${program}` : `${epochId} ${program} (${input.pot} pot)`,
      });
    }
  }
  return out;
}

export type AuthState = { maxAmount: bigint; publishAfter: number; publishDeadline: number; authorized: boolean; consumed: boolean; exists: boolean };
export type AuthSkip = { target: AuthTarget; reason: "live" | "consumed" | "exists" | "revoked" | "expired" };

/**
 * Which targets need authorizeBatch now. Never: an id already authorized (whatever its parameters: re-authorizing
 * overwrites, which only the Safe should decide), consumed or created, an id the Safe revoked (maxAmount set but not
 * authorized), or one whose publish window has passed. Earliest first.
 */
export function authorizationPlan(targets: AuthTarget[], states: Map<string, AuthState>, nowSec: number): { toAuthorize: AuthTarget[]; skipped: AuthSkip[] } {
  const toAuthorize: AuthTarget[] = [];
  const skipped: AuthSkip[] = [];
  for (const t of [...targets].sort((a, b) => a.publishAfter - b.publishAfter || a.batchId.localeCompare(b.batchId))) {
    const s = states.get(t.batchId.toLowerCase());
    if (t.publishDeadline <= nowSec) skipped.push({ target: t, reason: "expired" });
    else if (s?.consumed) skipped.push({ target: t, reason: "consumed" });
    else if (s?.exists) skipped.push({ target: t, reason: "exists" });
    else if (s?.authorized) skipped.push({ target: t, reason: "live" });
    else if (s && s.maxAmount > 0n) skipped.push({ target: t, reason: "revoked" });
    else toAuthorize.push(t);
  }
  return { toAuthorize, skipped };
}

/** Consecutive weeks (from the first target) whose ids are all authorized-and-open, consumed or created. */
export function coveredWeeks(targets: AuthTarget[], states: Map<string, AuthState>, nowSec: number): number {
  const byWeek = new Map<number, AuthTarget[]>();
  for (const t of targets) byWeek.set(t.publishAfter, [...(byWeek.get(t.publishAfter) || []), t]);
  let n = 0;
  for (const week of [...byWeek.keys()].sort((a, b) => a - b)) {
    const ok = byWeek.get(week)!.every((t) => {
      const s = states.get(t.batchId.toLowerCase());
      return Boolean(s && (s.consumed || s.exists || (s.authorized && s.publishDeadline > nowSec)));
    });
    if (!ok) break;
    n += 1;
  }
  return n;
}

// ------------------------------------------------------------------------------------ holder batch verification

export const PROPOSE_IFACE = new ethers.Interface([
  "function proposeHolderBatch(bytes32 batchId, bytes32 root, uint64 claimDeadline, address[] campaigns, uint256[] amounts) returns (uint256 total)",
]);

export type HolderProposal = {
  chainId: number;
  vault: string;
  program: string;
  batchId: string;
  root: string;
  total: bigint;
  executableAt: bigint;
  claimDeadline: bigint;
  blockNumber: number;
  blockTime: number;
  txHash: string;
  /** The proposing transaction: who it went to and its input (EOA operator -> vault, so the calldata is the call). */
  txTo: string | null;
  txData: string;
};

export type VaultFacts = { holderDistributor: string; operator: string; holderBatchDelay: bigint };
export type CoinFacts = { choice: number; creator: string; pool: string | null; token: string };

/** Balances of a token at block `from` and every Transfer in (from, to], in order. */
export type CensusRange = { base: Map<string, bigint>; changes: Array<{ block: number; from: string; to: string; value: bigint }> };

export type VerifyDeps = {
  vault(): Promise<VaultFacts>;
  coin(campaign: string): Promise<CoinFacts>;
  blockTime(block: number): Promise<number>;
  census(token: string, campaign: string, fromBlock: number, toBlock: number): Promise<CensusRange>;
  isContract(address: string): Promise<boolean>;
};

export type VerifyConfig = {
  minPayoutWei: bigint;
  claimWindowDays: number;
  /** Configured EVM_HOLDER_EXCLUDED_WALLETS (lowercase). */
  excluded: Set<string>;
  /** Risk-excluded wallets (the same table the operator reads). */
  riskExcluded: Set<string>;
  /** EVM_BUYBACK_SEED_SECRET when available: the snapshot block must follow the week's secret moment. */
  masterSecret: string | null;
  snapshotToleranceSec: number;
  censusLagBlocks: number;
  /** Most of a coin's otherwise-eligible supply the configured + risk exclusions may remove (bps). */
  maxExcludedBps: number;
};

export type VerifyResult =
  | { ok: true; weekId: string; root: string; total: bigint; leaves: number; campaigns: number; blocks: Record<string, number> }
  | { ok: false; kind: "mismatch" | "missing"; reasons: string[] };

const lc = (a: string) => String(a || "").toLowerCase();
const sameAddr = (a: string | null | undefined, b: string | null | undefined) => lc(a || "") === lc(b || "");

function mismatch(reason: string): VerifyResult {
  return { ok: false, kind: "mismatch", reasons: [reason] };
}

function eligibleAt(
  balances: Map<string, bigint>,
  skip: Set<string>,
  soft: Set<string>,
  contracts: Set<string>,
): { holders: Array<{ owner: string; amount: bigint }>; softExcluded: bigint; eligibleSupply: bigint } {
  const holders: Array<{ owner: string; amount: bigint }> = [];
  let softExcluded = 0n;
  let eligibleSupply = 0n;
  for (const [wallet, amount] of balances) {
    if (amount <= 0n || skip.has(wallet) || contracts.has(wallet)) continue;
    eligibleSupply += amount;
    if (soft.has(wallet)) {
      softExcluded += amount;
      continue;
    }
    holders.push({ owner: wallet, amount });
  }
  return { holders, softExcluded, eligibleSupply };
}

/**
 * Independently recomputes a proposed holder batch and compares it with the proposal on chain. The leaf file is
 * only a source of two hints per coin (which snapshot block, and the pot before the minimum-payout rule), and both
 * are bounded here: the block must lie in the week (after its secret moment when the seed is known) and the pot is
 * the coin's own; every wallet and amount is rebuilt from the token's Transfer logs, the vault's view of the coin
 * and the same allocation and merkle code the operator uses. Any difference: not approved.
 */
export async function verifyHolderProposal(p: HolderProposal, file: LeafFile | null, deps: VerifyDeps, cfg: VerifyConfig): Promise<VerifyResult> {
  // 1. The proposing transaction is exactly proposeHolderBatch on this vault with what the event says.
  if (!sameAddr(p.txTo, p.vault)) return mismatch(`the proposing transaction went to ${p.txTo}, not the vault`);
  let decoded: ethers.TransactionDescription | null = null;
  try {
    decoded = PROPOSE_IFACE.parseTransaction({ data: p.txData });
  } catch {
    decoded = null;
  }
  if (!decoded || decoded.name !== "proposeHolderBatch") return mismatch("the proposing transaction is not proposeHolderBatch");
  const [cBatchId, cRoot, cDeadline, cCampaigns, cAmounts] = decoded.args as unknown as [string, string, bigint, string[], bigint[]];
  if (!sameAddr(cBatchId, p.batchId) || !sameAddr(cRoot, p.root) || BigInt(cDeadline) !== p.claimDeadline) return mismatch("calldata id / root / deadline differ from the event");
  const calldataTotal = cAmounts.reduce((s, a) => s + BigInt(a), 0n);
  if (calldataTotal !== p.total) return mismatch(`calldata amounts add up to ${calldataTotal}, the event says ${p.total}`);

  // 2. The id is last week's for this vault's program; the deadline is the configured claim window.
  const week = previousWeek(new Date(p.blockTime * 1000));
  if (!sameAddr(holderBatchId(p.chainId, week.weekId, p.program), p.batchId)) return mismatch(`batch id is not holderBatchId(${p.chainId}, ${week.weekId}, ${p.program})`);
  const vault = await deps.vault();
  const window = BigInt(cfg.claimWindowDays * DAY_S);
  const span = p.claimDeadline - p.executableAt;
  if (span > window || span < window - 2n * BigInt(DAY_S)) return mismatch(`claim deadline is ${span} s after executableAt, expected about ${window}`);

  // 3. The leaf file names the hints; it must agree with the chain on everything it states.
  if (!file) return { ok: false, kind: "missing", reasons: ["no leaf file for this batch"] };
  try {
    checkLeafFile(file);
  } catch (error) {
    return mismatch(`leaf file: ${error instanceof Error ? error.message : String(error)}`);
  }
  if ((file.program ?? DEFAULT_HOLDER_PROGRAM) !== p.program) return mismatch(`leaf file program ${file.program ?? DEFAULT_HOLDER_PROGRAM} is not ${p.program}`);
  if (!sameAddr(file.vault, p.vault) || !sameAddr(file.batchId, p.batchId) || file.weekId !== week.weekId || Number(file.chainId) !== p.chainId) return mismatch("leaf file is for another vault, week or chain");
  if (!sameAddr(file.holderDistributor, vault.holderDistributor)) return mismatch("leaf file names another holder distributor than the vault's");
  if (!file.leaves.every((l) => Array.isArray(l.parts) && l.parts.length)) return { ok: false, kind: "missing", reasons: ["leaf file has no per-campaign parts"] };
  if (file.campaigns.length !== cCampaigns.length || file.campaigns.some((c, i) => !sameAddr(c.campaign, cCampaigns[i]) || BigInt(c.amount) !== BigInt(cAmounts[i]))) {
    return mismatch("leaf file campaigns differ from the proposing calldata");
  }

  // 4. Per coin: the census at the snapshot block (or the few blocks after it the operator's census may have read),
  // the vault's exclusions, the allocation; it must reproduce this coin's part of every leaf.
  const weekStart = Math.floor(week.start.getTime() / 1000);
  const weekEnd = Math.floor(week.end.getTime() / 1000);
  const moment = cfg.masterSecret ? Math.floor(snapshotMoment(weekSecret(cfg.masterSecret, p.chainId, week.weekId), p.chainId, week.start).getTime() / 1000) : null;
  const partsByCoin = new Map<string, Map<string, bigint>>();
  for (const l of file.leaves) {
    for (const part of l.parts!) {
      const c = lc(part.campaign);
      const m = partsByCoin.get(c) ?? new Map<string, bigint>();
      m.set(lc(l.account), BigInt(part.amount));
      partsByCoin.set(c, m);
    }
  }
  const perCoin = new Map<string, Map<string, bigint>>();
  const blocks: Record<string, number> = {};
  const contractCache = new Map<string, boolean>();
  const isContract = async (w: string) => {
    if (!contractCache.has(w)) contractCache.set(w, await deps.isContract(w));
    return contractCache.get(w)!;
  };
  const seen = new Set<string>();
  for (const snap of file.snapshot.perCampaign) {
    const campaign = lc(snap.campaign);
    if (seen.has(campaign)) return mismatch(`campaign ${campaign} listed twice in the snapshot`);
    seen.add(campaign);
    const pot = BigInt(snap.pot);
    if (pot <= 0n) return mismatch(`campaign ${campaign}: pot ${snap.pot}`);
    const coin = await deps.coin(campaign);
    if (coin.choice !== CHOICE.holders && coin.choice !== CHOICE.split) return mismatch(`campaign ${campaign} is not a holders or split coin in the vault`);
    if (!sameAddr(coin.token, snap.token)) return mismatch(`campaign ${campaign}: token ${snap.token} is not the campaign's ${coin.token}`);
    const at = await deps.blockTime(Number(snap.block));
    if (at < weekStart || at >= weekEnd) return mismatch(`campaign ${campaign}: snapshot block ${snap.block} is outside week ${week.weekId}`);
    if (moment != null && (at < moment || at > moment + cfg.snapshotToleranceSec)) return mismatch(`campaign ${campaign}: snapshot block ${snap.block} (${at}) is not within ${cfg.snapshotToleranceSec} s after the week's secret moment ${moment}`);
    const skip = new Set<string>([DEAD, lc(ethers.ZeroAddress), campaign, lc(p.vault), lc(coin.creator), lc(coin.token), lc(vault.operator)]);
    if (coin.pool) skip.add(lc(coin.pool));
    const soft = new Set<string>([...cfg.excluded, ...cfg.riskExcluded]);
    const range = await deps.census(coin.token, campaign, Number(snap.block), Number(snap.block) + cfg.censusLagBlocks);
    const balances = new Map(range.base);
    const candidates = [Number(snap.block), ...new Set(range.changes.map((c) => c.block))];
    const expected = partsByCoin.get(campaign) ?? new Map<string, bigint>();
    let chosen: Map<string, bigint> | null = null;
    let lastReason = "no census block reproduces this coin's leaf parts";
    let ci = 0;
    for (const block of candidates) {
      while (ci < range.changes.length && range.changes[ci].block <= block) {
        const ch = range.changes[ci++];
        if (ch.from !== lc(ethers.ZeroAddress)) balances.set(ch.from, (balances.get(ch.from) || 0n) - ch.value);
        if (ch.to !== lc(ethers.ZeroAddress)) balances.set(ch.to, (balances.get(ch.to) || 0n) + ch.value);
      }
      const contracts = new Set<string>();
      for (const [w, amount] of balances) if (amount > 0n && !skip.has(w) && (await isContract(w))) contracts.add(w);
      const { holders, softExcluded, eligibleSupply } = eligibleAt(balances, skip, soft, contracts);
      if (holders.length !== Number(snap.holders)) {
        lastReason = `census at block ${block} has ${holders.length} holders, the snapshot says ${snap.holders}`;
        continue;
      }
      if (eligibleSupply > 0n && softExcluded * 10_000n > eligibleSupply * BigInt(cfg.maxExcludedBps)) {
        return mismatch(`campaign ${campaign}: configured / risk exclusions remove ${softExcluded} of ${eligibleSupply} eligible tokens (over ${cfg.maxExcludedBps} bps): needs a person`);
      }
      const shares = allocateToHolders(pot, holders);
      let ok = true;
      for (const [wallet, amount] of expected) {
        if (shares.get(wallet) !== amount) {
          ok = false;
          lastReason = `census at block ${block}: ${wallet} would get ${shares.get(wallet) ?? 0n} of ${campaign}, the file says ${amount}`;
          break;
        }
      }
      if (ok) {
        chosen = shares;
        blocks[campaign] = block;
        break;
      }
    }
    if (!chosen) return mismatch(`campaign ${campaign}: ${lastReason}`);
    perCoin.set(campaign, chosen);
  }

  // 5. Across coins: the minimum payout, one leaf per wallet, the per-campaign amounts and the root, rebuilt here.
  const { leaves, paidByPool } = holderLeaves(perCoin, cfg.minPayoutWei);
  const entries = [...leaves.entries()].map(([account, amount]) => ({ account: ethers.getAddress(account), amount })).sort((a, b) => (lc(a.account) < lc(b.account) ? -1 : 1));
  if (!entries.length) return mismatch("the recomputed batch pays nobody");
  const fileLeaves = file.leaves.map((l) => `${lc(l.account)}:${BigInt(l.amount)}`).sort();
  const ours = entries.map((e) => `${lc(e.account)}:${e.amount}`).sort();
  if (fileLeaves.length !== ours.length || fileLeaves.some((x, i) => x !== ours[i])) return mismatch("recomputed leaves differ from the leaf file");
  for (let i = 0; i < cCampaigns.length; i += 1) {
    if ((paidByPool.get(lc(cCampaigns[i])) ?? 0n) !== BigInt(cAmounts[i])) return mismatch(`campaign ${cCampaigns[i]}: recomputed amount ${paidByPool.get(lc(cCampaigns[i])) ?? 0n}, proposed ${cAmounts[i]}`);
  }
  const paidCampaigns = [...paidByPool.entries()].filter(([, v]) => v > 0n).map(([c]) => c);
  if (paidCampaigns.length !== cCampaigns.length) return mismatch("the recomputed batch pays a different set of campaigns");
  const total = entries.reduce((s, e) => s + e.amount, 0n);
  if (total !== p.total) return mismatch(`recomputed total ${total} differs from the proposed ${p.total}`);
  const { root } = merklePlan(entries);
  if (!sameAddr(root, p.root)) return mismatch(`recomputed root ${root} differs from the proposed ${p.root}`);
  return { ok: true, weekId: week.weekId, root, total, leaves: entries.length, campaigns: cCampaigns.length, blocks };
}

// ------------------------------------------------------------------------------------ Roles probe

/** What a role probe (eth_call of execTransactionWithRole on a neutral call) says about the module. */
export type ProbeVerdict = "ok" | "module_disabled" | "not_member" | "refused" | "error";

export function probeVerdict(revert: string | null): ProbeVerdict {
  if (revert == null) return "ok";
  if (/GS104|ModuleNotEnabled|not.*enabled module/i.test(revert)) return "module_disabled";
  if (/NoMembership/.test(revert)) return "not_member";
  if (/ConditionViolation\(AllowanceExceeded\)/.test(revert)) return "ok";
  if (/ConditionViolation|NotAuthorized|TargetAddressNotAllowed|FunctionNotAllowed/.test(revert)) return "refused";
  return "error";
}
