/**
 * Payout watchdog, gen-8: verifyGen8HolderProposal against a scripted chain (the happy path and every refusal path),
 * the gen-8 lane of the tick (4-arg approve through the module, dry run, mismatch, the gen-8 holder distributor's
 * runway, the gen-8-only health probe) and the lane configuration. The Roles module itself: test/PayoutRolesPolicy.spec.ts
 * and the fork / local end-to-end specs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { holderBatchId, weekSecret } from "./evmCreatorChoice.js";
import { gen8CheckMoments, gen8EligibleAt, gen8HardSkip, type Gen8LeafFileV2 } from "./evmGen8HoldThrough.js";
import { holderAuthTargets, type HolderProposal } from "./payoutWatchdog.js";
import { GEN8_APPROVE_IFACE, GEN8_PROPOSE_IFACE, gen8ApproveCalldata, gen8CreatorAt, verifyGen8HolderProposal, type Gen8VerifyConfig, type Gen8VerifyDeps } from "./payoutWatchdogGen8.js";
import { replayTransfers, type Gen8WatchdogChain } from "./payoutWatchdogGen8Chain.js";
import { DISTRIBUTOR_IFACE, type ScannedVaultEvent, type WatchdogChain, type WatchdogSender } from "./payoutWatchdogChain.js";
import { indexerRoles, operatorKeysInEnv, watchdogConfig, watchdogLanes, type WatchdogConfig } from "./payoutWatchdogConfig.js";
import { emptyMemory, runWatchdogTick } from "./payoutWatchdogWorker.js";
import { buildGen8LeafFileV2, type BuildPool } from "../tests/gen8/gen8LeafFileV2.js";

const E18 = 10n ** 18n;
const CHAIN = 56;
const MASTER = "gen8-watchdog-test-master";
const a = (n: number) => ethers.getAddress("0x" + n.toString(16).padStart(40, "0"));
const V8 = a(0x8aa);
const D8 = a(0x8bb);
const ROLES = a(0xe0);
const SAFE = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
const OP = a(0xa1);
const CR = a(0xc1);
const PM = a(0x9a); // a census exclusion (PoolManager)
const K = a(0xf9); // a contract holder
const R = a(0xf8); // a risk-excluded wallet
const X = a(0xf7); // a wallet that never held the coin
const [H1, H2, H3, H4] = [a(0xf1), a(0xf2), a(0xf3), a(0xf4)];
const DEAD = "0x000000000000000000000000000000000000dEaD";
const T1 = a(0xd1);
const T2 = a(0xd2);
const P1 = "0x" + "11".repeat(32);
const P2 = "0x" + "22".repeat(32);

const WEEK_ID = "2026-10-26";
const START = new Date(`${WEEK_ID}T00:00:00Z`);
const MOMENTS = gen8CheckMoments(weekSecret(MASTER, CHAIN, WEEK_ID), CHAIN, START).map((d) => Math.floor(d.getTime() / 1000));
const PROPOSAL_TIME = Math.floor(Date.parse("2026-11-02T00:10:00Z") / 1000);
const PROPOSAL_BLOCK = 5_000;
const SUPPLY = 1_000_000_000n * E18;
const MIN_PAYOUT = 10n ** 15n;
const CFG: Gen8VerifyConfig = { minPayoutWei: MIN_PAYOUT, claimWindowDays: 60, excluded: new Set(), riskExcluded: new Set(), masterSecret: MASTER, maxExcludedBps: 2_000 };

const lc = (s: string) => s.toLowerCase();
const T = (n: bigint) => n * E18;

type Pool = { id: string; token: string; pot: bigint; launchBlock: number; launchedAt: number; checks: Array<{ index: number; block: number }>; balances: Record<number, Record<string, bigint>> };

/** Balances at a block: the named wallets, the rest of the supply in the PoolManager. */
function withPm(m: Record<string, bigint>): Record<string, bigint> {
  const held = Object.values(m).reduce((s, v) => s + v, 0n);
  return { ...m, [PM]: SUPPLY - held };
}

function pools(): Pool[] {
  const p1: Pool = { id: P1, token: T1, pot: E18, launchBlock: 100, launchedAt: Math.floor(START.getTime() / 1000) - 86_400, checks: [0, 1, 2, 3].map((i) => ({ index: i, block: 1_000 + i * 100 })), balances: {} };
  for (const c of p1.checks) {
    p1.balances[c.block] = withPm({
      [H1]: T(2_000_000n),
      [H2]: T(1_000_000n + BigInt(c.index) * 100_000n),
      [H3]: c.index === 3 ? T(50_000n) : T(500_000n), // below 0.01% at the last check: out
      [H4]: c.index === 1 ? T(150_000n) : T(900_000n), // its lowest balance counts
      [K]: T(3_000_000n),
      [CR]: T(4_000_000n),
      [DEAD]: T(1_000_000n),
      [OP]: T(100_000n),
      [R]: T(120_000n),
    });
  }
  const p2: Pool = { id: P2, token: T2, pot: 2n * 10n ** 17n, launchBlock: 1_150, launchedAt: MOMENTS[1] + 120, checks: [2, 3].map((i) => ({ index: i, block: 1_000 + i * 100 })), balances: {} };
  for (const c of p2.checks) p2.balances[c.block] = withPm({ [H1]: T(300_000n), [H4]: T(700_000n), [H2]: T(1_000n) /* dust: below 0.01% */ });
  return [p1, p2];
}

type Over = {
  pools?: Pool[];
  /** Block time of a check block (default: its moment + 30 s). */
  checkTime?: (block: number, index: number) => number;
  /** What the operator used as a check's holders (default: the rule's eligible holders). */
  operatorHolders?: (poolId: string, index: number, holders: Array<{ owner: string; amount: bigint }>) => Array<{ owner: string; amount: bigint }>;
  operatorSoft?: Set<string>;
  potBefore?: (poolId: string) => bigint;
  weekId?: string;
  claimWindowDays?: number;
  extraShares?: Map<string, Map<string, bigint>>;
  supplyOnChain?: bigint;
  choice?: number;
  /** The vault's creator history (default: CR from launch). `watchdogCreators` overrides what the watchdog reads. */
  creators?: Array<{ block: number; creator: string }>;
  watchdogCreators?: Array<{ block: number; creator: string }>;
};

function scenario(over: Over = {}) {
  const ps = over.pools ?? pools();
  const times = new Map<number, number>();
  for (const p of ps) {
    times.set(p.launchBlock, p.launchedAt);
    for (const c of p.checks) times.set(c.block, over.checkTime ? over.checkTime(c.block, c.index) : MOMENTS[c.index] + 30);
  }
  times.set(PROPOSAL_BLOCK, PROPOSAL_TIME);
  const census = new Set([lc(PM)]);
  const noContracts = new Set<string>(); // only known contracts are skipped (founder 2026-10-22)
  const soft = over.operatorSoft ?? new Set<string>();
  // One history for every pool in the test; it starts at each pool's own launch block (CoinRegistered).
  const atLaunch = (p: Pool, h: Array<{ block: number; creator: string }>) => h.map((c, i) => (i === 0 ? { ...c, block: p.launchBlock } : c));
  const creatorsOf = (p: Pool) => atLaunch(p, over.creators ?? [{ block: p.launchBlock, creator: CR }]);
  const build: BuildPool[] = ps.map((p) => {
    return {
      poolId: p.id,
      token: p.token,
      pot: p.pot,
      launchedAt: p.launchedAt,
      checks: p.checks.map((c) => {
        // The operator: the vault's creator when it takes the check, and the wallets its soft list removed there.
        const skip = gen8HardSkip({ token: p.token, vault: V8, operator: OP, creator: gen8CreatorAt(creatorsOf(p), c.block), censusExclusions: census });
        const bal = new Map(Object.entries(p.balances[c.block]).map(([w, v]) => [lc(w), v]));
        const holders = gen8EligibleAt(bal, skip, soft, noContracts).holders;
        const softExcluded = [...bal.entries()].filter(([w, v]) => v > 0n && !skip.has(w) && soft.has(w)).map(([w]) => w);
        return { index: c.index, block: c.block, blockTime: times.get(c.block)!, supply: SUPPLY, holders: over.operatorHolders ? over.operatorHolders(p.id, c.index, holders) : holders, softExcluded };
      }),
    };
  });
  const weekId = over.weekId ?? WEEK_ID;
  const executableAt = PROPOSAL_TIME + 86_400;
  const claimDeadline = executableAt + (over.claimWindowDays ?? 60) * 86_400;
  const { file, ids, amounts } = buildGen8LeafFileV2({ chainId: CHAIN, vault: V8, holderDistributor: D8, weekId, claimDeadline, minPayoutWei: MIN_PAYOUT, pools: build, extraShares: over.extraShares });
  const total = amounts.reduce((s, x) => s + x, 0n);
  const proposal: HolderProposal = {
    chainId: CHAIN, vault: V8, program: "airdrop_holders_gen8", batchId: file.batchId, root: file.root, total,
    executableAt: BigInt(executableAt), claimDeadline: BigInt(claimDeadline), blockNumber: PROPOSAL_BLOCK, blockTime: PROPOSAL_TIME,
    txHash: "0x" + "ab".repeat(32), txTo: V8, txData: GEN8_PROPOSE_IFACE.encodeFunctionData("proposeHolderBatch", [file.batchId, file.root, claimDeadline, ids, amounts]),
  };
  const byId = new Map(ps.map((p) => [lc(p.id), p]));
  const deps: Gen8VerifyDeps = {
    async vault() {
      return { holderDistributor: D8, operator: OP };
    },
    async coin(id) {
      const p = byId.get(lc(id));
      if (!p) return null;
      const creators = over.watchdogCreators ? atLaunch(p, over.watchdogCreators) : creatorsOf(p);
      return { choice: over.choice ?? 2, token: p.token, creator: creators[creators.length - 1].creator, registeredToken: p.token, launchBlock: p.launchBlock, creators };
    },
    async blockTime(b) {
      if (!times.has(b)) throw new Error(`no block ${b}`);
      return times.get(b)!;
    },
    async census(token, _launch, blocks) {
      const p = ps.find((x) => lc(x.token) === lc(token))!;
      const at = new Map<number, Map<string, bigint>>();
      const supplyAt = new Map<number, bigint>();
      for (const b of blocks) {
        at.set(b, new Map(Object.entries(p.balances[b] ?? {}).map(([w, v]) => [lc(w), v])));
        supplyAt.set(b, SUPPLY);
      }
      return { at, supplyAt, end: { block: 9_999, replayed: SUPPLY, onChain: over.supplyOnChain ?? SUPPLY } };
    },
    async holderBalanceBefore(id) {
      return over.potBefore ? over.potBefore(lc(id)) : byId.get(lc(id))!.pot;
    },
    async censusExclusions() {
      return census;
    },
  };
  return { file, proposal, deps, ids, amounts };
}

const refuse = async (s: { file: Gen8LeafFileV2 | null; proposal: HolderProposal; deps: Gen8VerifyDeps }, re: RegExp, cfg: Gen8VerifyConfig = CFG, kind = "mismatch") => {
  const r = await verifyGen8HolderProposal(s.proposal, s.file, s.deps, cfg);
  assert.equal(r.ok, false, `expected a refusal matching ${re}`);
  if (!r.ok) {
    assert.equal(r.kind, kind, r.reasons.join("; "));
    assert.match(r.reasons.join("; "), re);
  }
};

// ------------------------------------------------------------------------------------ verification

test("gen-8 verify: a batch built with the shared rule from the chain's balances matches, root and total recomputed", async () => {
  for (let i = 0; i + 1 < MOMENTS.length; i += 1) assert.ok(MOMENTS[i + 1] - MOMENTS[i] > 120, "test windows are wide enough");
  const s = scenario();
  const r = await verifyGen8HolderProposal(s.proposal, s.file, s.deps, CFG);
  assert.equal(r.ok, true, r.ok ? "" : r.reasons.join("; "));
  if (!r.ok) return;
  assert.equal(r.root, s.file.root);
  assert.equal(r.total, s.proposal.total);
  assert.equal(r.pools, 2);
  assert.deepEqual(r.checks[lc(P1)], [1_000, 1_100, 1_200, 1_300]);
  assert.deepEqual(r.checks[lc(P2)], [1_200, 1_300]);
  // The rule: H3 fell under 0.01% at the last check; CR / OP / DEAD / PM (known) are skipped; K, an unknown contract, IS
  // paid (founder 2026-10-22: only known contracts are skipped); H4 counts with its lowest.
  const accounts = s.file.leaves.map((l) => lc(l.account));
  assert.ok(!accounts.includes(lc(H3)) && !accounts.includes(lc(CR)) && !accounts.includes(lc(OP)) && !accounts.includes(lc(PM)));
  assert.ok(accounts.includes(lc(H1)) && accounts.includes(lc(H4)) && accounts.includes(lc(R)) && accounts.includes(lc(K)));
  assert.deepEqual(r.unlisted, []);
  const p1Parts = new Map(s.file.leaves.flatMap((l) => l.parts.filter((p) => p.poolId === lc(P1)).map((p) => [lc(l.account), BigInt(p.amount)] as const)));
  const p1Held = { [lc(H1)]: T(2_000_000n), [lc(H2)]: T(1_000_000n), [lc(H4)]: T(150_000n), [lc(K)]: T(3_000_000n), [lc(R)]: T(120_000n) };
  const sum = Object.values(p1Held).reduce((x, y) => x + y, 0n);
  assert.equal(p1Parts.get(lc(H4)), (E18 * p1Held[lc(H4)]) / sum);
});

test("gen-8 verify: the payout minimum drops a small wallet and the pool pays less than its pot; still a match", async () => {
  const H5 = a(0xf5);
  const ps = pools();
  ps[1].pot = 5n * 10n ** 15n;
  for (const c of ps[1].checks) ps[1].balances[c.block] = withPm({ [H1]: T(300_000n), [H4]: T(700_000n), [H5]: T(200_000n) });
  const s = scenario({ pools: ps });
  assert.ok(!s.file.leaves.some((l) => lc(l.account) === lc(H5)), "H5's share is below the minimum");
  assert.ok(BigInt(s.file.pools.find((p) => p.poolId === lc(P2))!.amount) < ps[1].pot);
  const r = await verifyGen8HolderProposal(s.proposal, s.file, s.deps, CFG);
  assert.equal(r.ok, true, r.ok ? "" : r.reasons.join("; "));
});

test("gen-8 verify: a missing check is refused", async () => {
  const s = scenario();
  s.file.pools[0].checks = s.file.pools[0].checks.filter((c) => c.index !== 1);
  await refuse(s, /checks \[0,2,3\], the rule requires \[0,1,2,3\]/);
  // A check the coin did not need (P2 launched after check 1) is refused too.
  const t = scenario();
  const p2 = t.file.pools.find((p) => p.poolId === lc(P2))!;
  p2.checks = [{ index: 1, block: 1_100, blockTime: MOMENTS[1] + 30, supply: SUPPLY.toString(), holders: 2, softExcluded: [] }, ...p2.checks];
  await refuse(t, /the rule requires \[2,3\]/);
});

test("gen-8 verify: a check block outside its window is refused (the operator's file is otherwise honest)", async () => {
  await refuse(scenario({ checkTime: (b, i) => (i === 1 ? MOMENTS[1] - 10 : MOMENTS[i] + 30) }), /check 1 block 1100 .* is outside its window/);
  await refuse(scenario({ checkTime: (b, i) => (i === 2 ? MOMENTS[3] + 5 : MOMENTS[i] + 30) }), /check 2 block 1200 .* is outside its window/);
  // M2: inside the window but more than the tolerance (30 min) after the moment: refused; a wider tolerance accepts it.
  const late = scenario({ checkTime: (b, i) => (i === 2 ? MOMENTS[2] + 31 * 60 : MOMENTS[i] + 30) });
  await refuse(late, /check 2 block 1200 .* is 1860 s after the check's moment .* more than the 1800 s tolerance/);
  const wide = await verifyGen8HolderProposal(late.proposal, late.file, late.deps, { ...CFG, checkToleranceSec: 3_600 });
  assert.equal(wide.ok, true, wide.ok ? "" : wide.reasons.join("; "));
  // An honest operator a few minutes behind the moment (census + pass lag) passes the default.
  const lag = scenario({ checkTime: (b, i) => MOMENTS[i] + 12 * 60 });
  assert.equal((await verifyGen8HolderProposal(lag.proposal, lag.file, lag.deps, CFG)).ok, true);
  // The file's stated block time must be the chain's.
  const s = scenario();
  s.file.pools[0].checks[0].blockTime += 1;
  await refuse(s, /check 0 block 1000 has time .*, the file says/);
});

test("gen-8 verify: a pot above the pool's holder balance before the proposal is refused", async () => {
  await refuse(scenario({ potBefore: (id) => (id === lc(P1) ? E18 - 1n : 10n ** 17n * 2n) }), /pot 1000000000000000000 is above its holder balance 999999999999999999/);
});

test("gen-8 verify: an extra wallet, a contract holder or a soft-excluded wallet left out are refused", async () => {
  // Extra wallet X in the operator's holder list at every check.
  await refuse(scenario({ operatorHolders: (_id, _i, h) => [...h, { owner: lc(X), amount: T(1_000_000n) }] }), /has \d+ holders, the file says \d+/);
  // An operator that still leaves out an unknown contract holder (K): only known contracts are skipped, so refused.
  await refuse(scenario({ operatorHolders: (_id, _i, h) => h.filter((x) => x.owner !== lc(K)) }), /has \d+ holders, the file says \d+/);
  // A share moved to a wallet that holds nothing (same holder count, same pot): the parts differ.
  await refuse(scenario({ extraShares: new Map([[lc(P1), new Map([[lc(H1), -5n * 10n ** 16n], [lc(X), 5n * 10n ** 16n]])]]) }), /gets \d+ under the rule, the file says/);
});

test("gen-8 verify: soft exclusions come from the file per check, bounded (total and not-on-today's-lists); unlisted ones are reported", async () => {
  // (a) the file's soft list removes more than PAYOUT_WATCHDOG_MAX_EXCLUDED_BPS of the eligible supply: needs a person.
  const big = new Set([lc(H1)]); // H1 holds about a quarter of P1's eligible supply
  await refuse(scenario({ operatorSoft: big }), /exclusions remove .*\(over 2000 bps\): needs a person/, { ...CFG, riskExcluded: big });
  // Listed today and small: a match, nothing reported.
  const small = new Set([lc(R)]);
  const listed = scenario({ operatorSoft: small });
  const ok = await verifyGen8HolderProposal(listed.proposal, listed.file, listed.deps, { ...CFG, excluded: small });
  assert.equal(ok.ok, true, ok.ok ? "" : ok.reasons.join("; "));
  if (ok.ok) assert.deepEqual(ok.unlisted, []);
  // (b) the file names R but today's lists do not (it left the risk list since): within 2% it is accepted and reported.
  const r2 = await verifyGen8HolderProposal(listed.proposal, listed.file, listed.deps, CFG);
  assert.equal(r2.ok, true, r2.ok ? "" : r2.reasons.join("; "));
  if (r2.ok) {
    assert.deepEqual([...new Set(r2.unlisted.map((u) => u.wallet))], [lc(R)]);
    assert.deepEqual(r2.unlisted.map((u) => u.index), [0, 1, 2, 3]);
  }
  // (b) above PAYOUT_WATCHDOG_MAX_UNLISTED_EXCLUDED_BPS (H2, about 14%, on no list): refused even within the total bound.
  const unlisted = scenario({ operatorSoft: new Set([lc(H2)]) });
  await refuse(unlisted, /wallets on neither of today's configured \/ risk lists remove .*\(over 200 bps\): needs a person/);
  const higher = await verifyGen8HolderProposal(unlisted.proposal, unlisted.file, unlisted.deps, { ...CFG, maxUnlistedExcludedBps: 2_000 });
  assert.equal(higher.ok, true, higher.ok ? "" : higher.reasons.join("; "));
  // The soft list is required on every check; a file that omits a soft-listed wallet from it pays nobody differently but
  // its holder count is then wrong.
  const noList = scenario();
  delete (noList.file.pools[0].checks[0] as any).softExcluded;
  await refuse(noList, /check 0 has no valid softExcluded list/);
  const dropped = scenario({ operatorSoft: small });
  dropped.file.pools[0].checks[0].softExcluded = [];
  await refuse(dropped, /check 0 at block 1000 has \d+ holders, the file says \d+/, { ...CFG, excluded: small });
});

test("gen-8 verify: the creator skipped at each check is the vault's creator at that block (a mid-week transfer)", async () => {
  // CR is the creator until block 1150, then H2 (acceptCreator). The operator skips CR at checks 0-1 and H2 at 2-3.
  const creators = [{ block: 100, creator: CR }, { block: 1_150, creator: H2 }];
  const s = scenario({ creators });
  const r = await verifyGen8HolderProposal(s.proposal, s.file, s.deps, CFG);
  assert.equal(r.ok, true, r.ok ? "" : r.reasons.join("; "));
  // Neither paid: CR is skipped at checks 0-1, H2 at checks 2-3 (hold-through needs every check).
  const accounts = s.file.leaves.map((l) => lc(l.account));
  assert.ok(!accounts.includes(lc(CR)) && !accounts.includes(lc(H2)));
  // An operator that used the creator of today at every check (H2 throughout) is refused.
  const stale = scenario({ creators: [{ block: 100, creator: H2 }], watchdogCreators: creators });
  await refuse(stale, /0x00000000000000000000000000000000000000c1 gets 0 under the rule, the file says \d+/);
  // A history that disagrees with cfg(id).creator now is retried, not decided.
  const t = scenario({ creators });
  const deps = { ...t.deps, coin: async (id: string) => ({ ...(await t.deps.coin(id))!, creator: X }) };
  await refuse({ ...t, deps }, /replayed creator differs/, CFG, "missing");
});

test("gen-8 verify: wrong batch id, wrong deadline, wrong program are refused", async () => {
  await refuse(scenario({ weekId: "2026-10-19" }), /batch id is not holderBatchId\(56, 2026-10-26, airdrop_holders_gen8\)/);
  await refuse(scenario({ claimWindowDays: 10 }), /claim deadline is \d+ s after executableAt, expected about 5184000/);
  const s = scenario();
  await refuse({ ...s, proposal: { ...s.proposal, program: "airdrop_holders_gen7" } }, /program airdrop_holders_gen7 is not airdrop_holders_gen8/);
  const g7 = holderBatchId(CHAIN, WEEK_ID, "airdrop_holders_gen7");
  await refuse({ ...s, proposal: { ...s.proposal, batchId: g7, txData: GEN8_PROPOSE_IFACE.encodeFunctionData("proposeHolderBatch", [g7, s.file.root, s.proposal.claimDeadline, s.ids, s.amounts]) } }, /batch id is not holderBatchId/);
});

test("gen-8 verify: tampered parts, amounts, root, calldata and file fields are refused", async () => {
  // Move 1 wei of P1 from one leaf to another (leaf sums and total stay consistent).
  const s = scenario();
  const [l0, l1] = s.file.leaves.filter((l) => l.parts.some((p) => p.poolId === lc(P1)));
  const p0 = l0.parts.find((p) => p.poolId === lc(P1))!;
  const p1 = l1.parts.find((p) => p.poolId === lc(P1))!;
  p0.amount = String(BigInt(p0.amount) - 1n);
  l0.amount = String(BigInt(l0.amount) - 1n);
  p1.amount = String(BigInt(p1.amount) + 1n);
  l1.amount = String(BigInt(l1.amount) + 1n);
  await refuse(s, /under the rule, the file says/);

  const base = scenario();
  // The proposal's root differs from what the rule gives (file follows the proposal).
  const fake = "0x" + "33".repeat(32);
  await refuse({ ...base, file: { ...base.file, root: fake }, proposal: { ...base.proposal, root: fake, txData: GEN8_PROPOSE_IFACE.encodeFunctionData("proposeHolderBatch", [base.file.batchId, fake, base.proposal.claimDeadline, base.ids, base.amounts]) } }, /recomputed root .* differs/);
  // Calldata amounts vs the event; event root vs calldata; not sent to the vault; the 3-arg (gen-6/7) propose.
  await refuse({ ...base, proposal: { ...base.proposal, total: base.proposal.total + 1n } }, /calldata amounts add up to/);
  await refuse({ ...base, proposal: { ...base.proposal, root: fake } }, /calldata id \/ root \/ deadline differ/);
  await refuse({ ...base, proposal: { ...base.proposal, txTo: a(0x1234) } }, /went to .*, not the vault/);
  const g6 = new ethers.Interface(["function proposeHolderBatch(bytes32 batchId, bytes32 root, uint64 claimDeadline, address[] campaigns, uint256[] amounts)"]);
  await refuse({ ...base, proposal: { ...base.proposal, txData: g6.encodeFunctionData("proposeHolderBatch", [base.file.batchId, base.file.root, base.proposal.claimDeadline, [T1, T2], base.amounts]) } }, /not the gen-8 proposeHolderBatch/);
  // File fields.
  await refuse({ ...base, file: { ...base.file, holderDistributor: a(0x777) } }, /another holder distributor/);
  await refuse({ ...base, file: { ...base.file, vault: a(0x778) } }, /another vault, chain, week or batch/);
  await refuse({ ...base, file: { ...base.file, pools: [...base.file.pools].reverse() } }, /pools differ from the proposing calldata/);
  await refuse({ ...base, file: { ...base.file, pools: base.file.pools.map((p, i) => (i === 0 ? { ...p, token: T2 } : p)) } }, /token .* is not the coin's/);
  await refuse({ ...base, file: { ...base.file, pools: base.file.pools.map((p, i) => (i === 0 ? { ...p, launchedAt: p.launchedAt + 1 } : p)) } }, /launchedAt .* is not the launch block time/);
  await refuse({ ...base, file: { ...base.file, pools: base.file.pools.map((p, i) => (i === 0 ? { ...p, checks: p.checks.map((c, j) => (j === 0 ? { ...c, supply: "1" } : c)) } : p)) } }, /check 0 supply 1, the chain has/);
  await refuse({ ...base, file: { ...base.file, version: 1 as any } }, /leaf file: not a gen-8 v2 hold-through leaf file/);
  // Chain-side facts.
  await refuse(scenario({ supplyOnChain: SUPPLY + 1n }), /Transfer replay gives supply .* totalSupply\(\) is/);
  await refuse(scenario({ choice: 4 }), /not a holders or split coin/);
});

test("gen-8 verify: no leaf file or no week secret is 'missing' (retried), never approved", async () => {
  const s = scenario();
  await refuse({ ...s, file: null }, /no leaf file/, CFG, "missing");
  await refuse(s, /EVM_BUYBACK_SEED_SECRET is not set/, { ...CFG, masterSecret: null }, "missing");
});

test("gen-8 chain: the Transfer replay gives balances and supply at each block, mints and burns counted", () => {
  const z = ethers.ZeroAddress.toLowerCase();
  const r = replayTransfers(
    [
      { block: 10, from: z, to: "a", value: 100n },
      { block: 12, from: "a", to: "b", value: 30n },
      { block: 15, from: "b", to: z, value: 10n },
      { block: 20, from: "a", to: "c", value: 5n },
    ],
    [12, 11, 16],
  );
  assert.deepEqual([...r.at.get(11)!], [["a", 100n]]);
  assert.deepEqual([...r.at.get(12)!], [["a", 70n], ["b", 30n]]);
  assert.deepEqual([...r.at.get(16)!], [["a", 70n], ["b", 20n]]);
  assert.equal(r.supplyAt.get(16), 90n);
  assert.equal(r.supply, 90n);
});

// ------------------------------------------------------------------------------------ the tick, gen-8 lane

function gen8Cfg(over: Partial<WatchdogConfig> = {}): WatchdogConfig {
  return {
    chainId: CHAIN, send: true, roles: ROLES, safe: SAFE, vaults: [], airdrops: [],
    gen8Vaults: [{ label: "gen-8", vault: V8, program: "airdrop_holders_gen8", startBlock: 50, hook: null, expectedRouter: null, holderCapWei: null }],
    weeks: 2, intervalMs: 60_000, lookbackBlocks: 10_000, logChunk: 5_000, censusLagBlocks: 0, snapshotToleranceSec: 0, maxExcludedBps: 2_000,
    maxTxPerTick: 10, minPayoutWei: MIN_PAYOUT, claimWindowDays: 60, excluded: new Set(), masterSecret: MASTER, ...over,
  };
}

function gen8Chain(s: ReturnType<typeof scenario>, opts: { withGen8?: boolean; refuse?: (to: string, data: string) => string | null; probe?: string | null; approvedBy?: { from: string; to: string | null } } = {}) {
  const sims: Array<{ to: string; data: string; shouldRevert?: boolean }> = [];
  const g: Gen8WatchdogChain = {
    async scan(): Promise<ScannedVaultEvent[]> {
      const p = s.proposal;
      const proposed: ScannedVaultEvent = { name: "HolderBatchProposed", batchId: lc(p.batchId), blockNumber: p.blockNumber, txHash: p.txHash, args: { root: p.root, total: p.total, executableAt: p.executableAt, claimDeadline: p.claimDeadline } };
      if (!opts.approvedBy) return [proposed];
      return [proposed, { name: "HolderBatchApproved", batchId: lc(p.batchId), blockNumber: p.blockNumber + 1, txHash: "0x" + "cd".repeat(32), args: {} }];
    },
    async txInfo() {
      return opts.approvedBy ?? { from: a(0x1), to: null };
    },
    async operator() {
      return OP;
    },
    async holderDistributor() {
      return D8;
    },
    async holderCap() {
      return 32n * E18;
    },
    verifyDeps() {
      return s.deps;
    },
  };
  const chain: WatchdogChain = {
    async latestBlock() {
      return { number: 6_000, timestamp: PROPOSAL_TIME + 600 };
    },
    async isModuleEnabled() {
      return true;
    },
    async safeOwners() {
      return [];
    },
    async rolesWiring() {
      return { owner: SAFE, avatar: SAFE, target: SAFE };
    },
    async vaultOperator() {
      return OP;
    },
    async vaultHolderDistributor() {
      throw new Error("the gen-6/7 reader must not be used for gen-8");
    },
    async vaultHolderCap() {
      throw new Error("the gen-6/7 reader must not be used for gen-8");
    },
    async communityAirdropOperator() {
      return null;
    },
    async scanVault() {
      throw new Error("the gen-6/7 scan must not be used for gen-8");
    },
    async proposal() {
      return s.proposal;
    },
    verifyDeps() {
      throw new Error("the gen-6/7 verifier must not be used for gen-8");
    },
    async authStates(_d, ids) {
      return new Map(ids.map((id) => [lc(id), { maxAmount: 0n, publishAfter: 0, publishDeadline: 0, authorized: false, consumed: false, exists: false }]));
    },
    async simulate(_roles, _from, to, data, shouldRevert) {
      sims.push({ to, data, shouldRevert });
      if (shouldRevert === false) return opts.probe ?? null;
      return opts.refuse?.(to, data) ?? null;
    },
    ...(opts.withGen8 === false ? {} : { gen8: g }),
  };
  const sent: Array<{ to: string; data: string }> = [];
  const sender: WatchdogSender = {
    address: a(0xb7),
    async exec(_roles, to, data) {
      sent.push({ to, data });
      return { hash: "0x" + String(sent.length).padStart(64, "0"), status: 1, gasUsed: 100_000n };
    },
  };
  return { chain, sender, sent, sims };
}

function recordingDb(alerts: any[]) {
  return {
    async query(sql: string, params: unknown[] = []) {
      if (/insert into public\.reward_alerts/.test(sql)) alerts.push({ severity: params[0], kind: JSON.parse(String(params[4])).kind, title: params[2] });
      return { rows: [] as any[] };
    },
  };
}

test("tick gen-8: a matching batch is approved with the 4-arg selector through the module, then the gen-8 runway; the probe is the gen-8 call", async () => {
  const s = scenario();
  const c = gen8Chain(s);
  const report = await runWatchdogTick({ db: null, cfg: gen8Cfg(), chain: c.chain, sender: c.sender, memory: emptyMemory(), riskExcluded: async () => new Set(), gen8LeafFile: async () => s.file, gen8CensusExclusions: async () => [lc(PM)], log: () => {} });
  assert.equal(report.roleOk && report.moduleEnabled && report.wiringOk, true, JSON.stringify(report));
  const probe = c.sims.find((x) => x.shouldRevert === false)!;
  assert.equal(probe.to, V8);
  assert.equal(probe.data, gen8ApproveCalldata(ethers.ZeroHash, ethers.ZeroHash, 0n, 1n));
  const approve = c.sent[0];
  assert.equal(approve.to, V8);
  assert.equal(approve.data.slice(0, 10), "0xc62732bb");
  assert.deepEqual(GEN8_APPROVE_IFACE.decodeFunctionData("approveHolderBatch", approve.data).map(String), [s.file.batchId, s.file.root, String(s.proposal.total), String(s.proposal.claimDeadline)]);
  const auths = c.sent.slice(1);
  assert.ok(auths.length > 0 && auths.every((x) => x.to === D8));
  const targets = holderAuthTargets({ chainId: CHAIN, program: "airdrop_holders_gen8", capWei: 32n * E18, nowSec: PROPOSAL_TIME + 600, weeks: 2 });
  assert.deepEqual(auths.map((x) => DISTRIBUTOR_IFACE.decodeFunctionData("authorizeBatch", x.data).map(String)), targets.map((t) => [t.batchId, String(t.maxAmount), String(t.publishAfter), String(t.publishDeadline)]));
  assert.ok(report.actions.some((x) => x.kind === "approve" && x.decision === "sent"));
});

test("tick gen-8: dry run signs nothing; a mismatch is never approved and raises one critical alert; no gen-8 reader alerts", async () => {
  const s = scenario();
  const dry = gen8Chain(s);
  const r1 = await runWatchdogTick({ db: null, cfg: gen8Cfg({ send: false }), chain: dry.chain, sender: dry.sender, memory: emptyMemory(), riskExcluded: async () => new Set(), gen8LeafFile: async () => s.file, gen8CensusExclusions: async () => [lc(PM)], log: () => {} });
  assert.equal(dry.sent.length, 0);
  assert.ok(r1.actions.some((x) => x.kind === "approve" && x.decision === "dry-run"));

  const bad = scenario({ extraShares: new Map([[lc(P1), new Map([[lc(H1), -(10n ** 16n)], [lc(X), 10n ** 16n]])]]) });
  const m = gen8Chain(bad);
  const alerts: any[] = [];
  const memory = emptyMemory();
  for (let i = 0; i < 2; i += 1) {
    await runWatchdogTick({ db: recordingDb(alerts) as any, cfg: gen8Cfg(), chain: m.chain, sender: m.sender, memory, riskExcluded: async () => new Set(), gen8LeafFile: async () => bad.file, gen8CensusExclusions: async () => [lc(PM)], log: () => {} });
  }
  assert.equal(m.sent.filter((x) => x.to === V8).length, 0);
  assert.equal(alerts.filter((x) => x.kind === "payout_watchdog_mismatch" && x.severity === "critical").length, 1);
  assert.equal(memory.verdicts[lc(bad.file.batchId)].kind, "mismatch");

  const none = gen8Chain(s, { withGen8: false });
  const alerts2: any[] = [];
  await runWatchdogTick({ db: recordingDb(alerts2) as any, cfg: gen8Cfg(), chain: none.chain, sender: none.sender, memory: emptyMemory(), gen8LeafFile: async () => s.file, log: () => {} });
  assert.equal(none.sent.length, 0);
  assert.ok(alerts2.some((x) => x.kind === "payout_watchdog_config"));
});

test("tick gen-8: a Roles refusal of the approve is a critical alert and nothing is sent to the vault", async () => {
  const s = scenario();
  const c = gen8Chain(s, { refuse: (to) => (to === V8 ? "ConditionViolation(FunctionNotAllowed)" : null) });
  const alerts: any[] = [];
  await runWatchdogTick({ db: recordingDb(alerts) as any, cfg: gen8Cfg(), chain: c.chain, sender: c.sender, memory: emptyMemory(), riskExcluded: async () => new Set(), gen8LeafFile: async () => s.file, gen8CensusExclusions: async () => [lc(PM)], log: () => {} });
  assert.equal(c.sent.filter((x) => x.to === V8).length, 0);
  assert.ok(alerts.some((x) => x.kind === "payout_watchdog_refused" && x.severity === "critical"));
});

test("tick gen-8: soft exclusions not on today's lists are approved within the bound and reported in a warning", async () => {
  const s = scenario({ operatorSoft: new Set([lc(R)]) });
  const c = gen8Chain(s);
  const alerts: any[] = [];
  await runWatchdogTick({ db: recordingDb(alerts) as any, cfg: gen8Cfg(), chain: c.chain, sender: c.sender, memory: emptyMemory(), riskExcluded: async () => new Set(), gen8LeafFile: async () => s.file, gen8CensusExclusions: async () => [lc(PM)], log: () => {} });
  assert.equal(c.sent.filter((x) => x.to === V8).length, 1, "approved");
  assert.ok(alerts.some((x) => x.kind === "payout_watchdog_gen8_unlisted_exclusion" && x.severity === "warning"));
});

test("tick H0: an operator key in the watchdog's env: nothing is sent (dry run) and a critical alert", async () => {
  const s = scenario();
  const c = gen8Chain(s);
  const alerts: any[] = [];
  const r = await runWatchdogTick({ db: recordingDb(alerts) as any, cfg: gen8Cfg({ colocatedOperatorKeys: ["EVM_GEN8_OPERATOR_KEY_56"] }), chain: c.chain, sender: c.sender, memory: emptyMemory(), riskExcluded: async () => new Set(), gen8LeafFile: async () => s.file, gen8CensusExclusions: async () => [lc(PM)], log: () => {} });
  assert.equal(c.sent.length, 0);
  assert.equal(r.send, false);
  assert.ok(r.actions.some((x) => x.kind === "approve" && x.decision === "dry-run"));
  assert.ok(alerts.some((x) => x.kind === "payout_watchdog_key_colocated" && x.severity === "critical"));
});

test("tick H0: an approval on the gen-8 vault not made by this watchdog through the module is alerted (Safe: warning, other: critical)", async () => {
  const s = scenario();
  const kinds = async (approvedBy: { from: string; to: string | null }) => {
    const c = gen8Chain(s, { approvedBy });
    const alerts: any[] = [];
    await runWatchdogTick({ db: recordingDb(alerts) as any, cfg: gen8Cfg(), chain: c.chain, sender: c.sender, memory: emptyMemory(), riskExcluded: async () => new Set(), gen8LeafFile: async () => s.file, gen8CensusExclusions: async () => [lc(PM)], log: () => {} });
    assert.equal(c.sent.filter((x) => x.to === V8).length, 0, "an approved batch is not approved again");
    return alerts.filter((x) => x.kind === "payout_watchdog_gen8_external_approval").map((x) => x.severity);
  };
  assert.deepEqual(await kinds({ from: a(0xb7), to: ROLES }), []);
  assert.deepEqual(await kinds({ from: a(0x123), to: SAFE }), ["warning"]);
  assert.deepEqual(await kinds({ from: a(0x123), to: ROLES }), ["critical"]);
  assert.deepEqual(await kinds({ from: a(0x123), to: a(0x999) }), ["critical"]);
});

test("config: PAYOUT_WATCHDOG_LANES restricts the lanes; gen-8 cap from PAYOUT_WATCHDOG_HOLDER_CAP_WEI; a typo throws", () => {
  const env: NodeJS.ProcessEnv = {
    EVM_CREATOR_VAULT_V2_56: "0x6Cb44e3dB907801a04FA7A056Fbe79799298AF66@100",
    REWARD_DISTRIBUTOR_ADDRESS_56: "0xF170a2C97953754c2C1105E2AcC522Bc8e764D75",
    EVM_GEN8_CHOICE_VAULT_56: "0xaf11784a69964A576716a5e4b514341F4437CAd3@64000000",
    PAYOUT_WATCHDOG_HOLDER_CAP_WEI_56: "5000000000000000000",
  };
  const all = watchdogConfig(56, env);
  assert.equal(all.vaults.length, 1);
  assert.equal(all.airdrops.length, 1);
  assert.equal(all.gen8Vaults?.length, 1);
  assert.equal(all.gen8Vaults?.[0].holderCapWei, 5n * E18);
  const only8 = watchdogConfig(56, { ...env, PAYOUT_WATCHDOG_LANES_56: "gen8" });
  assert.deepEqual([only8.vaults.length, only8.airdrops.length, only8.gen8Vaults?.length], [0, 0, 1]);
  const no8 = watchdogConfig(56, { ...env, PAYOUT_WATCHDOG_LANES_56: "gen6, airdrop" });
  assert.deepEqual([no8.vaults.length, no8.airdrops.length, no8.gen8Vaults?.length], [1, 1, 0]);
  assert.throws(() => watchdogLanes(56, { PAYOUT_WATCHDOG_LANES_56: "gen-8" }), /unknown lane gen-8/);
  assert.equal(all.gen8CheckToleranceSec, 1800);
  assert.equal(all.maxUnlistedExcludedBps, 200);
  assert.equal(watchdogConfig(56, { ...env, PAYOUT_WATCHDOG_GEN8_CHECK_TOLERANCE_MIN: "45", PAYOUT_WATCHDOG_MAX_UNLISTED_EXCLUDED_BPS: "50" }).gen8CheckToleranceSec, 2700);
  assert.deepEqual(all.colocatedOperatorKeys, []);
});

test("H0: operator keys in the env and INDEXER_ROLE", () => {
  const env = { EVM_GEN8_OPERATOR_KEY_56: "0xabc", EVM_CREATOR_CHOICE_OPERATOR_PRIVATE_KEY: "x", EVM_GEN8_OPERATOR_KEY: "", OTHER_KEY: "1" };
  const found = operatorKeysInEnv(env);
  assert.equal(found.length, 2); // the empty one and OTHER_KEY are not operator keys
  assert.deepEqual(found, [...found].sort());
  assert.ok(found.includes("EVM_CREATOR_CHOICE_OPERATOR_PRIVATE_KEY"));
  assert.ok(found.includes("EVM_GEN8_OPERATOR_KEY_56"));
  assert.deepEqual(watchdogConfig(4663, { EVM_GEN8_OPERATOR_KEY_4663: "k" }).colocatedOperatorKeys, ["EVM_GEN8_OPERATOR_KEY_4663"]);
  const r = (env: NodeJS.ProcessEnv) => { const x = indexerRoles(env); return [x.indexer, x.watchdog]; };
  assert.deepEqual(r({}), [true, true], "default: as before");
  assert.deepEqual(r({ EVM_GEN8_OPERATOR_KEY_56: "k" }), [true, false], "default with an operator key: no watchdog in the indexer");
  assert.deepEqual(r({ INDEXER_ROLE: "payout-watchdog" }), [false, true]);
  assert.deepEqual(r({ INDEXER_ROLE: "indexer" }), [true, false]);
  assert.deepEqual(r({ INDEXER_ROLE: "indexer,payout-watchdog", EVM_GEN8_OPERATOR_KEY: "k" }), [true, true]);
  assert.throws(() => indexerRoles({ INDEXER_ROLE: "watchdog" }), /unknown role watchdog/);
});
