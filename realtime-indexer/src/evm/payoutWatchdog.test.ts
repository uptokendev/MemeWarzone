/**
 * Payout watchdog: pure rules (id schedules = the existing generators', authorization plan, holder batch
 * recomputation), the tick against a scripted chain (match, mismatch, missing data, dry run, health alerts, Roles
 * refusals) and the key refusal. The Roles module itself is exercised in the hardhat specs
 * (test/PayoutRolesPolicy.spec.ts, test/PayoutRolesModule.fork.spec.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { allocateToHolders, buildLeafFile, holderBatchId, snapshotMoment, weekOf, weekSecret, type LeafFile } from "./evmCreatorChoice.js";
import {
  PAYOUT_WATCHDOG_ROLE_KEY,
  PROPOSE_IFACE,
  airdropAuthTargets,
  authorizationPlan,
  coveredWeeks,
  holderAuthTargets,
  probeVerdict,
  verifyHolderProposal,
  weeklyContractBatchId,
  type AuthState,
  type CensusRange,
  type HolderProposal,
  type VerifyConfig,
  type VerifyDeps,
} from "./payoutWatchdog.js";
import { assertWatchdogKeyAllowed, enabledWatchdogChains, otherKeyAddresses, watchdogConfig, watchdogWallet } from "./payoutWatchdogConfig.js";
import { emptyMemory, raiseAlert, runWatchdogTick } from "./payoutWatchdogWorker.js";
import { DISTRIBUTOR_IFACE, WATCHDOG_VAULT_IFACE, execCalldata, type ScannedVaultEvent, type WatchdogChain, type WatchdogSender } from "./payoutWatchdogChain.js";
import type { WatchdogConfig } from "./payoutWatchdogConfig.js";

const { holderPreauthCalls } = await import("../../../scripts/make-holder-batch-preauth-calls.mjs" as string);
const { airdropSetupCalls } = await import("../../../scripts/make-airdrop-setup-calls.mjs" as string);
const { weeklyContractBatchId: runnerBatchId } = await import("../../../frontend/scripts/weekly-airdrop/materialize.mjs" as string);

const E18 = 10n ** 18n;
const CHAIN = 56;
const V = "0x00000000000000000000000000000000000006aa";
const D = "0x00000000000000000000000000000000000006bb";
const A = "0x00000000000000000000000000000000000006cc";
const ROLES = "0x00000000000000000000000000000000000000e0";
const SAFE = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
const OPERATOR = "0x00000000000000000000000000000000000000a1";
const C1 = "0x00000000000000000000000000000000000000c1";
const C2 = "0x00000000000000000000000000000000000000c2";
const T1 = "0x00000000000000000000000000000000000000d1";
const T2 = "0x00000000000000000000000000000000000000d2";
const CREATOR = "0x00000000000000000000000000000000000000e1";
const K = "0x00000000000000000000000000000000000000f9"; // a contract holder
const H1 = "0x00000000000000000000000000000000000000f1";
const H2 = "0x00000000000000000000000000000000000000f2";
const H3 = "0x00000000000000000000000000000000000000f3";
const H4 = "0x00000000000000000000000000000000000000f4";
const MASTER = "watchdog-test-master";

const PROPOSAL_TIME = Math.floor(Date.parse("2026-10-05T00:10:00Z") / 1000);
const WEEK = weekOf(new Date("2026-09-30T00:00:00Z"));
const MOMENT = Math.floor(snapshotMoment(weekSecret(MASTER, CHAIN, WEEK.weekId), CHAIN, WEEK.start).getTime() / 1000);
const SNAP_BLOCK = 1_000;

// ------------------------------------------------------------------------------------ schedules

test("holder and airdrop authorization targets are exactly the existing generators' ids, caps and windows", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const nowSec = Math.floor(now.getTime() / 1000);
  const ours = holderAuthTargets({ chainId: CHAIN, program: "airdrop_holders_gen7", capWei: 32n * E18, nowSec, weeks: 12 });
  const theirs = holderPreauthCalls({ chainId: CHAIN, distributor: D, cap: 32n * E18, program: "airdrop_holders_gen7", weeks: 12, now });
  // Ours also covers the week just finished while its window is open (2026-09-28: window to 2026-10-11).
  assert.equal(ours[0].label, "2026-09-28 airdrop_holders_gen7");
  assert.deepEqual(ours.slice(1).map((t) => [t.batchId, String(t.maxAmount), String(t.publishAfter), String(t.publishDeadline)]), theirs.map((c: any) => c.args.map(String)));

  const a = airdropAuthTargets({ chainId: 4663, pot: "gen7", capWei: 15n * 10n ** 17n, nowSec, weeks: 12 });
  const b = airdropSetupCalls({ chainId: 4663, pots: [{ pot: "gen7", vault: A, distributor: D, cap: 15n * 10n ** 17n, operator: null, wire: false }], weeks: 12, now });
  // The generator starts at the coming Monday; ours adds the epoch that ended last Monday while its window is open.
  assert.equal(a.length, b.length + 2);
  assert.deepEqual(a.slice(2).map((t) => [t.batchId, String(t.maxAmount), String(t.publishAfter), String(t.publishDeadline)]), b.map((c: any) => c.args.map(String)));
  for (const pot of ["main", "gen7"]) assert.equal(weeklyContractBatchId(56, "2026-10-05", "airdrop_trader", pot), runnerBatchId(56, "2026-10-05", "airdrop_trader", pot));
  // A week whose window has passed is never a target.
  const late = holderAuthTargets({ chainId: CHAIN, program: "airdrop_holders", capWei: 1n, nowSec: Math.floor(Date.parse("2026-10-11T23:59:59Z") / 1000) + 1, weeks: 1 });
  assert.ok(late.every((t) => t.publishDeadline > Math.floor(Date.parse("2026-10-12T00:00:00Z") / 1000)));
});

test("authorization plan: never re-authorizes a live, consumed, created or revoked id, nor a past window; covered weeks", () => {
  const nowSec = Math.floor(Date.parse("2026-10-08T12:00:00Z") / 1000);
  const t = holderAuthTargets({ chainId: CHAIN, program: "airdrop_holders", capWei: E18, nowSec, weeks: 6 });
  const st = (o: Partial<AuthState>): AuthState => ({ maxAmount: 0n, publishAfter: 0, publishDeadline: 0, authorized: false, consumed: false, exists: false, ...o });
  const states = new Map<string, AuthState>([
    [t[0].batchId.toLowerCase(), st({ consumed: true, exists: true, maxAmount: E18 })],
    [t[1].batchId.toLowerCase(), st({ authorized: true, maxAmount: E18, publishDeadline: t[1].publishDeadline })],
    [t[2].batchId.toLowerCase(), st({ maxAmount: E18 })], // revoked by the Safe
  ]);
  const plan = authorizationPlan(t, states, nowSec);
  assert.deepEqual(plan.skipped.map((s) => s.reason), ["consumed", "live", "revoked"]);
  assert.deepEqual(plan.toAuthorize.map((x) => x.batchId), t.slice(3).map((x) => x.batchId));
  assert.equal(coveredWeeks(t, states, nowSec), 2);
});

test("probe verdicts", () => {
  assert.equal(probeVerdict(null), "ok");
  assert.equal(probeVerdict("GS104"), "module_disabled");
  assert.equal(probeVerdict("NoMembership"), "not_member");
  assert.equal(probeVerdict("ConditionViolation(AllowanceExceeded)"), "ok");
  assert.equal(probeVerdict("ConditionViolation(FunctionNotAllowed)"), "refused");
});

// ------------------------------------------------------------------------------------ a real-shaped holder batch

type Coin = { campaign: string; token: string; pot: bigint; balances: Record<string, bigint> };
const COINS: Coin[] = [
  { campaign: C1, token: T1, pot: 56n * 10n ** 16n, balances: { [H1]: 300n * E18, [H2]: 100n * E18, [CREATOR]: 1_000n * E18, [K]: 500n * E18, [H3]: 1n * E18 } },
  { campaign: C2, token: T2, pot: 10n ** 17n, balances: { [H1]: 50n * E18, [H4]: 150n * E18 } },
];
const MIN_PAYOUT = 10n ** 15n;
const CFG: VerifyConfig = { minPayoutWei: MIN_PAYOUT, claimWindowDays: 60, excluded: new Set(), riskExcluded: new Set(), masterSecret: MASTER, snapshotToleranceSec: 12 * 3600, censusLagBlocks: 50, maxExcludedBps: 2_000 };

/** The operator's own build (same functions it calls), from the eligible balances. */
function build(opts: { coins?: Coin[]; excluded?: Set<string> } = {}) {
  const coins = opts.coins ?? COINS;
  const skip = new Set([CREATOR, K, ...(opts.excluded ?? [])]);
  const perCoin = new Map<string, Map<string, bigint>>();
  const snapshots = [];
  for (const c of coins) {
    const holders = Object.entries(c.balances).filter(([w]) => !skip.has(w)).map(([owner, amount]) => ({ owner, amount }));
    perCoin.set(c.campaign, allocateToHolders(c.pot, holders));
    snapshots.push({ campaign: c.campaign, token: c.token, block: SNAP_BLOCK, holders: holders.length, pot: c.pot });
  }
  const executableAt = BigInt(PROPOSAL_TIME + 86_400);
  const claimDeadline = PROPOSAL_TIME - 600 + 86_400 + 60 * 86_400;
  const file = buildLeafFile({ chainId: CHAIN, vault: V, holderDistributor: D, weekId: WEEK.weekId, claimDeadline, weekCommitment: "c", perCoin, minPayout: MIN_PAYOUT, snapshots })!;
  const data = PROPOSE_IFACE.encodeFunctionData("proposeHolderBatch", [file.batchId, file.root, BigInt(file.claimDeadline), file.campaigns.map((c) => c.campaign), file.campaigns.map((c) => BigInt(c.amount))]);
  const proposal: HolderProposal = {
    chainId: CHAIN, vault: ethers.getAddress(V), program: "airdrop_holders", batchId: file.batchId, root: file.root, total: BigInt(file.total),
    executableAt, claimDeadline: BigInt(file.claimDeadline), blockNumber: 2_000, blockTime: PROPOSAL_TIME, txHash: "0x" + "ab".repeat(32), txTo: ethers.getAddress(V), txData: data,
  };
  return { file, proposal };
}

function deps(over: { coins?: Coin[]; later?: CensusRange["changes"]; choice?: number; snapTime?: number; tokenOf?: string } = {}): VerifyDeps {
  const coins = over.coins ?? COINS;
  return {
    async vault() {
      return { holderDistributor: ethers.getAddress(D), operator: ethers.getAddress(OPERATOR), holderBatchDelay: 86_400n };
    },
    async coin(campaign) {
      const c = coins.find((x) => x.campaign === campaign)!;
      return { choice: over.choice ?? 2, creator: ethers.getAddress(CREATOR), pool: null, token: ethers.getAddress(over.tokenOf ?? c.token) };
    },
    async blockTime(block) {
      return block === SNAP_BLOCK ? (over.snapTime ?? MOMENT + 120) : MOMENT + 120 + (block - SNAP_BLOCK);
    },
    async census(token, _campaign, _from, toBlock) {
      const c = coins.find((x) => x.token.toLowerCase() === token.toLowerCase())!;
      return { base: new Map(Object.entries(c.balances)), changes: (over.later ?? []).filter((ch) => ch.block > SNAP_BLOCK && ch.block <= toBlock && token.toLowerCase() === T1) };
    },
    async isContract(address) {
      return address.toLowerCase() === K;
    },
  };
}

test("verify: a batch built by the operator's own code from the chain's balances matches, root and total recomputed", async () => {
  const { file, proposal } = build();
  const r = await verifyHolderProposal(proposal, file, deps(), CFG);
  assert.equal(r.ok, true, r.ok ? "" : r.reasons.join("; "));
  if (r.ok) {
    assert.equal(r.root, file.root);
    assert.equal(r.total, BigInt(file.total));
    assert.equal(r.weekId, "2026-09-28");
  }
  // Same without the seed (block only bounded to the week).
  assert.equal((await verifyHolderProposal(proposal, file, deps(), { ...CFG, masterSecret: null })).ok, true);
});

test("verify: the operator's census read a few blocks after the snapshot block; a block inside the lag window reproduces it", async () => {
  // The operator's DB census already contained a transfer h2 -> h1 of 50 at block 1003.
  const later = [{ block: 1_003, from: H2, to: H1, value: 50n * E18 }];
  const coinsLater = [{ ...COINS[0], balances: { ...COINS[0].balances, [H1]: 350n * E18, [H2]: 50n * E18 } }, COINS[1]];
  const { file, proposal } = build({ coins: coinsLater });
  assert.equal((await verifyHolderProposal(proposal, file, deps({ later }), CFG)).ok, true);
  assert.equal((await verifyHolderProposal(proposal, file, deps({ later }), { ...CFG, censusLagBlocks: 2 })).ok, false);
});

test("verify: every tampering or inconsistency is a mismatch and is never approved", async () => {
  const { file, proposal } = build();
  const cases: Array<[string, HolderProposal, LeafFile | null, VerifyDeps, VerifyConfig]> = [];
  // A different root on chain than the operator's published file.
  cases.push(["root", { ...proposal, root: ethers.ZeroHash.replace(/0$/, "1") }, file, deps(), CFG]);
  // Calldata pays one campaign one wei more (event total moved with it).
  const amounts = file.campaigns.map((c, i) => BigInt(c.amount) + (i === 0 ? 1n : 0n));
  const tdata = PROPOSE_IFACE.encodeFunctionData("proposeHolderBatch", [file.batchId, file.root, BigInt(file.claimDeadline), file.campaigns.map((c) => c.campaign), amounts]);
  cases.push(["calldata amount", { ...proposal, txData: tdata, total: proposal.total + 1n }, file, deps(), CFG]);
  // A leaf file that moves wei from h2 to h1 (root recomputed so it is internally consistent).
  const stolen = build({ coins: [{ ...COINS[0], balances: { ...COINS[0].balances, [H1]: 390n * E18, [H2]: 10n * E18 } }, COINS[1]] });
  cases.push(["allocation", stolen.proposal, stolen.file, deps(), CFG]);
  // Not last week's id.
  cases.push(["week", { ...proposal, blockTime: PROPOSAL_TIME + 7 * 86_400 }, file, deps(), CFG]);
  // Snapshot block before the week's secret moment / outside the week.
  cases.push(["moment", proposal, file, deps({ snapTime: MOMENT - 10 }), CFG]);
  cases.push(["outside week", proposal, file, deps({ snapTime: Math.floor(WEEK.end.getTime() / 1000) + 5 }), { ...CFG, masterSecret: null }]);
  // Not a holders / split coin; token is not the campaign's.
  cases.push(["choice", proposal, file, deps({ choice: 4 }), CFG]);
  cases.push(["token", proposal, file, deps({ tokenOf: T2 }), CFG]);
  // Proposed through something else than a direct call on the vault.
  cases.push(["to", { ...proposal, txTo: ethers.getAddress(D) }, file, deps(), CFG]);
  // Claim deadline far outside the configured window.
  cases.push(["deadline", { ...proposal, executableAt: proposal.executableAt - 10n * 86_400n }, file, deps(), CFG]);
  for (const [name, p, f, d, c] of cases) {
    const r = await verifyHolderProposal(p, f, d, c);
    assert.equal(r.ok, false, `${name} must not match`);
    if (!r.ok) assert.equal(r.kind, "mismatch", `${name}: ${r.reasons}`);
  }
});

test("verify: configured / risk exclusions are bounded; a missing file is 'missing', not a mismatch", async () => {
  // h1 excluded on C1 (300 of 401 eligible tokens = 75%): over the 20% bound.
  const ex = build({ excluded: new Set([H1]) });
  const r = await verifyHolderProposal(ex.proposal, ex.file, deps(), { ...CFG, riskExcluded: new Set([H1]) });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reasons[0], /exclusions remove/);
  // Under the bound (h3: 1 of 401) the same rule reproduces the operator's exclusion.
  const small = build({ excluded: new Set([H3]) });
  assert.equal((await verifyHolderProposal(small.proposal, small.file, deps(), { ...CFG, riskExcluded: new Set([H3]) })).ok, true);
  // ...but the watchdog must know the exclusion: without it, the census disagrees with the file.
  assert.equal((await verifyHolderProposal(small.proposal, small.file, deps(), CFG)).ok, false);
  const { proposal } = build();
  const m = await verifyHolderProposal(proposal, null, deps(), CFG);
  assert.deepEqual(m.ok ? null : m.kind, "missing");
});

// ------------------------------------------------------------------------------------ the tick

function tickConfig(over: Partial<WatchdogConfig> = {}): WatchdogConfig {
  return {
    chainId: CHAIN, send: true, roles: ethers.getAddress(ROLES), safe: SAFE,
    vaults: [{ vault: ethers.getAddress(V), program: "airdrop_holders", label: "gen-6", startBlock: 1, holderCapWei: null }],
    airdrops: [{ label: "main airdrop", kind: "airdrop", address: ethers.getAddress(A), pot: "main", capWei: 5n * E18 }],
    weeks: 2, intervalMs: 60_000, lookbackBlocks: 10_000, logChunk: 5_000, censusLagBlocks: 50, snapshotToleranceSec: 12 * 3600, maxExcludedBps: 2_000,
    maxTxPerTick: 10, minPayoutWei: MIN_PAYOUT, claimWindowDays: 60, excluded: new Set(), masterSecret: MASTER, ...over,
  };
}

function scriptedChain(opts: { proposal: HolderProposal; enabled?: boolean; probe?: string | null; refuse?: (to: string, data: string) => string | null; authorized?: Set<string> }) {
  const sims: Array<{ to: string; data: string }> = [];
  const chain: WatchdogChain = {
    async latestBlock() {
      return { number: 3_000, timestamp: PROPOSAL_TIME + 600 };
    },
    async isModuleEnabled() {
      return opts.enabled ?? true;
    },
    async safeOwners() {
      return [];
    },
    async rolesWiring() {
      return { owner: SAFE, avatar: SAFE, target: SAFE };
    },
    async vaultOperator() {
      return ethers.getAddress(OPERATOR);
    },
    async vaultHolderDistributor() {
      return ethers.getAddress(D);
    },
    async vaultHolderCap() {
      return 32n * E18;
    },
    async communityAirdropOperator() {
      return null;
    },
    async scanVault(): Promise<ScannedVaultEvent[]> {
      const p = opts.proposal;
      return [{ name: "HolderBatchProposed", batchId: p.batchId.toLowerCase(), blockNumber: p.blockNumber, txHash: p.txHash, args: { root: p.root, total: p.total, executableAt: p.executableAt, claimDeadline: p.claimDeadline } }];
    },
    async proposal() {
      return opts.proposal;
    },
    verifyDeps() {
      return deps();
    },
    async authStates(_d, ids) {
      return new Map(ids.map((id) => [id.toLowerCase(), { maxAmount: opts.authorized?.has(id.toLowerCase()) ? 1n : 0n, publishAfter: 0, publishDeadline: 4_000_000_000, authorized: Boolean(opts.authorized?.has(id.toLowerCase())), consumed: false, exists: false }]));
    },
    async simulate(_roles, _from, to, data, shouldRevert) {
      if (shouldRevert === false) return opts.probe ?? null;
      sims.push({ to, data });
      return opts.refuse?.(to, data) ?? null;
    },
  };
  const sent: Array<{ to: string; data: string }> = [];
  const sender: WatchdogSender = {
    address: "0x00000000000000000000000000000000000000b7",
    async exec(_roles, to, data) {
      sent.push({ to, data });
      return { hash: "0x" + String(sent.length).padStart(64, "0"), status: 1, gasUsed: 100_000n };
    },
  };
  return { chain, sender, sent, sims };
}

test("tick: a matching batch is approved through the module, the runway is filled, in that order and nothing else", async () => {
  const { file, proposal } = build();
  const s = scriptedChain({ proposal });
  const report = await runWatchdogTick({ db: null, cfg: tickConfig(), chain: s.chain, sender: s.sender, memory: emptyMemory(), riskExcluded: async () => new Set(), leafFile: async () => file, log: () => {} });
  assert.equal(report.roleOk && report.moduleEnabled && report.wiringOk, true);
  const approve = s.sent[0];
  assert.equal(approve.to, ethers.getAddress(V));
  assert.equal(approve.data, WATCHDOG_VAULT_IFACE.encodeFunctionData("approveHolderBatch", [file.batchId, file.root, BigInt(file.total)]));
  const auths = s.sent.slice(1).map((x) => DISTRIBUTOR_IFACE.parseTransaction({ data: x.data })!);
  assert.ok(auths.every((a) => a.name === "authorizeBatch"));
  // Holder distributor (week just finished + 2) and main airdrop (2 programs x (last epoch + 2)).
  assert.equal(s.sent.slice(1).filter((x) => x.to === ethers.getAddress(D)).length, 3);
  assert.equal(s.sent.slice(1).filter((x) => x.to === ethers.getAddress(A)).length, 6);
  assert.ok(s.sent.slice(1).filter((x) => x.to === ethers.getAddress(A)).every((x) => DISTRIBUTOR_IFACE.parseTransaction({ data: x.data })!.args[1] === 5n * E18));
  assert.equal(execCalldata(V, approve.data).slice(0, 10), ethers.id("execTransactionWithRole(address,uint256,bytes,uint8,bytes32,bool)").slice(0, 10));
  assert.ok(execCalldata(V, approve.data).includes(PAYOUT_WATCHDOG_ROLE_KEY.slice(2)));
});

test("tick: dry run decides and alerts but signs nothing; a mismatch is never approved and raises a critical alert once", async () => {
  const { file, proposal } = build();
  const dry = scriptedChain({ proposal });
  const r1 = await runWatchdogTick({ db: null, cfg: tickConfig({ send: false }), chain: dry.chain, sender: dry.sender, memory: emptyMemory(), riskExcluded: async () => new Set(), leafFile: async () => file, log: () => {} });
  assert.equal(dry.sent.length, 0);
  assert.ok(r1.actions.some((a) => a.kind === "approve" && a.decision === "dry-run"));
  assert.ok(r1.actions.filter((a) => a.kind === "authorize").every((a) => a.decision === "dry-run"));

  const bad = { ...proposal, root: "0x" + "11".repeat(32) };
  const m = scriptedChain({ proposal: bad });
  const memory = emptyMemory();
  const alerts: any[] = [];
  const db = recordingDb(alerts);
  const r2 = await runWatchdogTick({ db, cfg: tickConfig(), chain: m.chain, sender: m.sender, memory, riskExcluded: async () => new Set(), leafFile: async () => file, log: () => {} });
  assert.ok(r2.actions.some((a) => a.kind === "approve" && a.decision === "mismatch"));
  assert.equal(m.sent.filter((x) => x.to === ethers.getAddress(V)).length, 0);
  assert.equal(alerts.filter((a) => a.kind === "payout_watchdog_mismatch" && a.severity === "critical").length, 1);
  // Next tick: cached verdict, no recomputation, no second alert.
  await runWatchdogTick({ db, cfg: tickConfig(), chain: m.chain, sender: m.sender, memory, riskExcluded: async () => new Set(), leafFile: async () => file, log: () => {} });
  assert.equal(alerts.filter((a) => a.kind === "payout_watchdog_mismatch").length, 1);
});

test("tick: module disabled / role missing / Roles refusal / allowance used up: alerts, nothing sent past the refusal", async () => {
  const { file, proposal } = build();
  const off = scriptedChain({ proposal, enabled: false });
  const alerts: any[] = [];
  const r = await runWatchdogTick({ db: recordingDb(alerts), cfg: tickConfig(), chain: off.chain, sender: off.sender, memory: emptyMemory(), leafFile: async () => file, log: () => {} });
  assert.equal(r.moduleEnabled, false);
  assert.equal(off.sent.length, 0);
  assert.ok(alerts.some((a) => a.kind === "payout_watchdog_module" && a.severity === "critical"));

  const nm = scriptedChain({ proposal, probe: "NoMembership" });
  const alerts2: any[] = [];
  await runWatchdogTick({ db: recordingDb(alerts2), cfg: tickConfig(), chain: nm.chain, sender: nm.sender, memory: emptyMemory(), leafFile: async () => file, log: () => {} });
  assert.equal(nm.sent.length, 0);
  assert.ok(alerts2.some((a) => a.kind === "payout_watchdog_role"));

  const refuse = scriptedChain({ proposal, refuse: (to) => (to === ethers.getAddress(A) ? "ConditionViolation(AllowanceExceeded)" : to === ethers.getAddress(D) ? "ConditionViolation(ParameterGreaterThanAllowed)" : null) });
  const alerts3: any[] = [];
  await runWatchdogTick({ db: recordingDb(alerts3), cfg: tickConfig(), chain: refuse.chain, sender: refuse.sender, memory: emptyMemory(), riskExcluded: async () => new Set(), leafFile: async () => file, log: () => {} });
  assert.deepEqual(refuse.sent.map((x) => x.to), [ethers.getAddress(V)]);
  assert.ok(alerts3.some((a) => a.kind === "payout_watchdog_allowance" && a.severity === "warning"));
  assert.ok(alerts3.some((a) => a.kind === "payout_watchdog_refused" && a.severity === "critical"));

  // An airdrop distributor without a cap is not touched.
  const nocap = scriptedChain({ proposal });
  await runWatchdogTick({ db: null, cfg: tickConfig({ airdrops: [{ label: "main airdrop", kind: "airdrop", address: ethers.getAddress(A), pot: "main", capWei: null }] }), chain: nocap.chain, sender: nocap.sender, memory: emptyMemory(), riskExcluded: async () => new Set(), leafFile: async () => file, log: () => {} });
  assert.equal(nocap.sent.filter((x) => x.to === ethers.getAddress(A)).length, 0);
});

test("tick: the leaf file missing is retried, not approved, not a mismatch", async () => {
  const { proposal } = build();
  const s = scriptedChain({ proposal });
  const r = await runWatchdogTick({ db: null, cfg: tickConfig({ airdrops: [] }), chain: s.chain, sender: s.sender, memory: emptyMemory(), riskExcluded: async () => new Set(), leafFile: async () => null, log: () => {} });
  assert.ok(r.actions.some((a) => a.kind === "approve" && a.decision === "missing"));
  assert.equal(s.sent.filter((x) => x.to === ethers.getAddress(V)).length, 0);
});

/** reward_alerts in memory: the dedupe select, the insert, the resolve. */
function recordingDb(alerts: any[]) {
  return {
    async query(sql: string, params: unknown[] = []) {
      if (/select id from public.reward_alerts/.test(sql)) {
        return { rows: alerts.filter((a) => a.status === "open" && a.kind === params[1] && String(a.chainId) === params[2] && (a.subject ?? "") === params[3]) };
      }
      if (/insert into public.reward_alerts/.test(sql)) {
        const meta = JSON.parse(String(params[4]));
        alerts.push({ severity: params[0], title: params[2], status: "open", ...meta });
        return { rows: [] };
      }
      if (/update public.reward_alerts/.test(sql)) {
        for (const a of alerts) if (a.kind === params[1] && String(a.chainId) === params[2] && (params.length < 4 || (a.subject ?? "") === params[3])) a.status = "resolved";
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

test("raiseAlert writes one open alert per kind, chain and subject", async () => {
  const alerts: any[] = [];
  const db = recordingDb(alerts);
  for (let i = 0; i < 3; i += 1) await raiseAlert(db, { severity: "critical", kind: "k", chainId: 56, subject: "s", title: "t", message: "m" });
  await raiseAlert(db, { severity: "critical", kind: "k", chainId: 4663, subject: "s", title: "t", message: "m" });
  assert.equal(alerts.length, 2);
});

// ------------------------------------------------------------------------------------ key refusal and config

test("key: refused when it equals any other key in the env, a known operator, the Safe or an on-chain role holder", () => {
  const key = "0x" + "42".repeat(32);
  const addr = new ethers.Wallet(key).address;
  assert.doesNotThrow(() => assertWatchdogKeyAllowed(addr, {}));
  for (const name of ["EVM_CREATOR_CHOICE_OPERATOR_PRIVATE_KEY_56", "AIRDROP_OPERATOR_PRIVATE_KEY_GEN7_4663", "IMPORT_FEE_PAYOUT_OPERATOR_PK_56", "DEPLOYER_PRIVATE_KEY", "RECRUITER_PAYOUT_OPERATOR_PK"]) {
    assert.throws(() => assertWatchdogKeyAllowed(addr, { [name]: key.slice(2) }), new RegExp(name));
  }
  assert.doesNotThrow(() => assertWatchdogKeyAllowed(addr, { PAYOUT_WATCHDOG_PK_56: key }));
  assert.throws(() => assertWatchdogKeyAllowed("0x20652bdb1d986220fEc30f4733587F279403E773", {}), /creator-choice/);
  assert.throws(() => assertWatchdogKeyAllowed("0xdcf07EB07e6D6722c246161e7530dc905F9eaA50", {}), /airdrop/);
  assert.throws(() => assertWatchdogKeyAllowed(SAFE, {}), /Safe/);
  assert.throws(() => assertWatchdogKeyAllowed(addr, {}, [{ address: addr.toLowerCase(), label: "Safe owner" }]), /Safe owner/);
  assert.throws(() => watchdogWallet(56, { PAYOUT_WATCHDOG_PK_56: key, EVM_CREATOR_CHOICE_OPERATOR_PRIVATE_KEY: key }), /refuses/);
  assert.equal(watchdogWallet(56, { PAYOUT_WATCHDOG_PK_56: key })!.address, addr);
  assert.equal(otherKeyAddresses({ SOME_PRIVATE_KEY: "not a key", X_PK: "0x" + "11".repeat(32) }).length, 1);
});

test("config: chains, send flag, vaults from the operator's variables, airdrop distributors and caps", () => {
  const env = {
    PAYOUT_WATCHDOG_ENABLED_56: "true",
    PAYOUT_WATCHDOG_ENABLED_4663: "0",
    PAYOUT_WATCHDOG_ROLES_56: ROLES,
    EVM_CREATOR_VAULT_V2_56: `${V}@123`,
    EVM_GEN7_CREATOR_VAULT_56: "0x00000000000000000000000000000000000007aa@456",
    REWARD_DISTRIBUTOR_ADDRESS_56: A,
    PAYOUT_WATCHDOG_GEN7_AIRDROP_DISTRIBUTOR_56: D,
    PAYOUT_WATCHDOG_AIRDROP_CAP_WEI_56: String(5n * E18),
  };
  assert.deepEqual(enabledWatchdogChains(env), [56]);
  const cfg = watchdogConfig(56, env);
  assert.equal(cfg.send, false);
  assert.equal(cfg.safe, SAFE);
  assert.deepEqual(cfg.vaults.map((v) => [v.label, v.program, v.startBlock]), [["gen-6", "airdrop_holders", 123], ["gen-7", "airdrop_holders_gen7", 456]]);
  assert.deepEqual(cfg.airdrops.map((a) => [a.pot, a.address, a.capWei]), [["main", ethers.getAddress(A), 5n * E18], ["gen7", ethers.getAddress(D), 5n * E18]]);
  assert.equal(cfg.weeks, 12);
  assert.equal(watchdogConfig(56, { ...env, PAYOUT_WATCHDOG_SEND: "true", PAYOUT_WATCHDOG_WEEKS: "40" }).weeks, 26);
  assert.equal(holderBatchId(56, "2026-09-28", "airdrop_holders").length, 66);
});
