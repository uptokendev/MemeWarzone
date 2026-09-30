/**
 * The creator-choice pass against a real (throwaway) Postgres with the migration applied, and a scripted chain:
 * record before send, one transaction in flight, resume after restart, never twice, the holder week end to end
 * (snapshot, publish, propose, Safe wait, execute, Claim Center open), veto, refusals.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { ethers } from "ethers";

process.env.DBC_THROWAY_PG_PORT ||= "55447";
const { startThrowawayPostgres } = await import("../../../scripts/dbc/throwaway-postgres.mjs" as string);
const pg = await startThrowawayPostgres();
test.after(async () => {
  await pg.stop();
});

const root = new URL("../../../", import.meta.url);
for (const f of ["db/migrations/20260930_000001_evm_gen5_indexing.sql", "db/migrations/20260930_300001_evm_creator_choice_operator.sql"]) {
  await pg.pool.query(fs.readFileSync(new URL(f, root), "utf8"));
}
await pg.pool.query(`
  create table public.reward_batches (id uuid primary key default gen_random_uuid(), reward_type text, chain text, token_symbol text,
    status text, total_amount numeric, recipient_count int, claimable_count int, claimed_count int, failed_count int, source text,
    metadata jsonb, published_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now());
  create table public.reward_ledger (id uuid primary key default gen_random_uuid(), reward_type text, source_id text, source_label text,
    wallet_address text, chain text, token_symbol text, amount numeric, status text, metadata jsonb, claimable_at timestamptz,
    claim_error text, created_at timestamptz default now(), updated_at timestamptz default now());
  create table public.reward_batch_items (id uuid primary key default gen_random_uuid(), batch_id uuid, reward_ledger_id uuid,
    wallet_address text, amount numeric, status text, metadata jsonb);
`);

const { runEvmCreatorChoicePass, DEFAULT_CHOICE_CONFIG } = await import("./evmCreatorChoicePass.js");
const { weekOf, weekSecret, snapshotMoment, weekCommitment, holderBatchId, checkLeafFile, verifyProof, merkleLeaf } = await import("./evmCreatorChoice.js");
type ChoiceChain = import("./evmCreatorChoiceChain.js").ChoiceChain;
type ChoiceSender = import("./evmCreatorChoiceChain.js").ChoiceSender;
type VaultCall = import("./evmCreatorChoiceChain.js").VaultCall;
type SimResult = import("./evmCreatorChoiceChain.js").SimResult;

const CHAIN = 56;
const VAULT = "0x00000000000000000000000000000000000000aa";
const DIST = "0x00000000000000000000000000000000000000bb";
const FACTORY = "0x00000000000000000000000000000000000000fa";
const AUTHORITY = "0x00000000000000000000000000000000000000a0";
const HOLD = "0x00000000000000000000000000000000000000c1"; // holders coin
const SPLIT = "0x00000000000000000000000000000000000000c2"; // split coin
const BUY = "0x00000000000000000000000000000000000000c3"; // buyback coin, graduated native pool
const CURVE = "0x00000000000000000000000000000000000000c4"; // buyback coin, still on the curve
const POOL = "0x00000000000000000000000000000000000000d3";
const CREATOR = "0x00000000000000000000000000000000000000e1";
const H1 = "0x00000000000000000000000000000000000000f1";
const H2 = "0x00000000000000000000000000000000000000f2";
const CONTRACT_HOLDER = "0x00000000000000000000000000000000000000f9";
const E18 = 10n ** 18n;
const operator = new ethers.Wallet("0x" + "22".repeat(32));

type World = {
  blockTime: bigint;
  blockNumber: number;
  operator: string;
  paused: boolean;
  routeAuthority: string;
  cfg: Record<string, { choice: number; pool: string | null; quote: string | null }>;
  bal: Record<string, { holder: bigint; buyback: bigint; buybackQuote: bigint; holderQuote: bigint; heldTokens: bigint }>;
  curve: Record<string, { launched: boolean; pending: boolean; price: bigint; net: bigint; target: bigint }>;
  sim: (call: VaultCall) => SimResult | null;
  proposals: Map<string, { root: string; total: bigint; executableAt: bigint; claimDeadline: bigint }>;
  simulated: VaultCall[];
};

function makeWorld(): World {
  const zero = () => ({ holder: 0n, buyback: 0n, buybackQuote: 0n, holderQuote: 0n, heldTokens: 0n });
  return {
    blockTime: 1_790_000_000n,
    blockNumber: 1_000,
    operator: operator.address,
    paused: false,
    routeAuthority: AUTHORITY,
    cfg: { [HOLD]: { choice: 2, pool: null, quote: null }, [SPLIT]: { choice: 3, pool: null, quote: null }, [BUY]: { choice: 4, pool: POOL, quote: null }, [CURVE]: { choice: 4, pool: null, quote: null } },
    bal: { [HOLD]: zero(), [SPLIT]: zero(), [BUY]: zero(), [CURVE]: zero() },
    curve: {
      [HOLD]: { launched: false, pending: false, price: 10n ** 9n, net: 0n, target: 100n * E18 },
      [SPLIT]: { launched: false, pending: false, price: 10n ** 9n, net: 0n, target: 100n * E18 },
      [BUY]: { launched: true, pending: false, price: 10n ** 9n, net: 0n, target: 100n * E18 },
      [CURVE]: { launched: false, pending: false, price: 10n ** 9n, net: 0n, target: 100n * E18 },
    },
    sim: () => null,
    proposals: new Map(),
    simulated: [],
  };
}

function chainOf(w: World): ChoiceChain {
  return {
    vault: ethers.getAddress(VAULT),
    async latestBlock() {
      return { number: w.blockNumber, timestamp: w.blockTime };
    },
    async vaultInfo() {
      return {
        operator: w.operator, admin: AUTHORITY, factory: FACTORY, holderDistributor: ethers.getAddress(DIST), holderBatchDelay: 86_400n,
        limits: { paused: w.paused, buyPerTx: E18, buybackPerCampaignWeek: 3n * E18, buyInterval: 21_600n, impactBps: 50n, holderBatchPerWeek: 10n * E18 },
      };
    },
    async routeAuthority() {
      return w.routeAuthority;
    },
    async cfg(c) {
      const x = w.cfg[c.toLowerCase()];
      return { creator: CREATOR, choice: x.choice, creatorPct: x.choice === 3 ? 25 : 0, pool: x.pool && ethers.getAddress(x.pool), quote: x.quote };
    },
    async balances(c) {
      return { ...w.bal[c.toLowerCase()], spentInWeek: 0n };
    },
    async quoteRoutePool() {
      return null;
    },
    async curve(c) {
      const x = w.curve[c.toLowerCase()];
      return { token: ethers.ZeroAddress, launched: x.launched, graduationPending: x.pending, currentPrice: x.price, netRaised: x.net, nativeTarget: x.target };
    },
    async quoteBuy(_c, amount) {
      // Flat 2% fee, a linear curve: after = before * (1 + amount / 1e18 * 1%)
      const fee = (amount * 200n) / 10_200n;
      const cost = amount - fee;
      const p0 = 10n ** 9n;
      const after = p0 + (p0 * cost) / (100n * E18);
      const tokensOut = (cost * E18 * 2n) / (p0 + after);
      return { tokensOut, totalCost: amount, fee };
    },
    async tradingEnabled() {
      return true;
    },
    async simulate(call) {
      w.simulated.push(call);
      const r = w.sim(call);
      if (r) return r;
      if (call.fn === "executeHolderBatch") return { ok: false, revert: "NotApproved" };
      // syncLpFees: the locker paid nothing new (delta 0), so a bound pool is not synced.
      return { ok: true, gas: 150_000n, returnData: ethers.zeroPadValue(call.fn === "syncLpFees" ? "0x00" : "0x05", 32) };
    },
    async isContract(a) {
      return a.toLowerCase() === CONTRACT_HOLDER;
    },
    async proposedInReceipt(hash) {
      return w.proposals.get(hash) ?? null;
    },
  };
}

type SenderState = { latest: number; pending: number; receipts: Map<string, { status: number; blockNumber: number }>; broadcasts: string[]; failBroadcast: boolean; signed: VaultCall[] };

function senderOf(s: SenderState, onBroadcast?: (raw: string) => Promise<void>): ChoiceSender {
  let n = 0;
  return {
    address: operator.address,
    async getNonce(tag) {
      return tag === "latest" ? s.latest : s.pending;
    },
    async getReceipt(hash) {
      return s.receipts.get(hash) ?? null;
    },
    async sign(call, _gas, nonce) {
      n += 1;
      s.signed.push(call);
      const raw = ethers.hexlify(ethers.toUtf8Bytes(`raw:${nonce}:${n}:${call.fn}`));
      return { raw, hash: ethers.keccak256(raw) };
    },
    async broadcast(raw) {
      if (onBroadcast) await onBroadcast(raw);
      s.broadcasts.push(raw);
      if (s.failBroadcast) throw new Error("rpc down");
      s.pending += 1;
    },
  };
}

function newSender(): SenderState {
  return { latest: 7, pending: 7, receipts: new Map(), broadcasts: [], failBroadcast: false, signed: [] };
}

const CFG = { ...DEFAULT_CHOICE_CONFIG, masterSecret: "test-master", minSpendWei: 10n ** 15n, minPayoutWei: 10n ** 12n };
const coins = [
  { campaign: HOLD, token: "0x00000000000000000000000000000000000001c1", creator: CREATOR, createdBlock: 1, choice: 2, stage: "trading" as const, pool: null },
  { campaign: SPLIT, token: "0x00000000000000000000000000000000000001c2", creator: CREATOR, createdBlock: 1, choice: 3, stage: "trading" as const, pool: null },
  { campaign: BUY, token: "0x00000000000000000000000000000000000001c3", creator: CREATOR, createdBlock: 1, choice: 4, stage: "graduated" as const, pool: POOL },
  { campaign: CURVE, token: "0x00000000000000000000000000000000000001c4", creator: CREATOR, createdBlock: 1, choice: 4, stage: "trading" as const, pool: null },
];
const census = async ({ campaign }: { campaign: string }) =>
  campaign === HOLD
    ? [{ wallet: H1, amount: 300n }, { wallet: H2, amount: 100n }, { wallet: CREATOR, amount: 999n }, { wallet: CONTRACT_HOLDER, amount: 500n }, { wallet: VAULT, amount: 1n }]
    : [{ wallet: H1, amount: 1n }, { wallet: H2, amount: 1n }];

async function reset() {
  await pg.pool.query(`truncate public.evm_creator_choice_jobs, public.evm_holder_batches, public.evm_holder_snapshots, public.evm_holder_snapshot_runs,
    public.evm_creator_choice_weeks, public.reward_batches, public.reward_ledger, public.reward_batch_items`);
}

/** Wednesday of a week, after its snapshot moment and after every buyback moment of the day. */
function midWeek(): Date {
  const start = weekOf(new Date("2026-09-30T00:00:00Z")).start;
  const snap = snapshotMoment(weekSecret(CFG.masterSecret, CHAIN, "2026-09-28"), CHAIN, start);
  const t = new Date("2026-10-04T23:59:00Z");
  assert.ok(t.getTime() > snap.getTime());
  return t;
}

function pass(w: World, s: SenderState, over: Record<string, unknown> = {}) {
  return runEvmCreatorChoicePass({
    db: pg.pool, chainId: CHAIN, chain: chainOf(w), sender: senderOf(s, over.onBroadcast as any), cfg: CFG, send: true,
    census, api: (over.api as any) ?? null, now: (over.now as Date) ?? midWeek(), coins,
  });
}

test("dry run: publishes the week commitment and takes the holder snapshot, signs and sends nothing", async () => {
  await reset();
  const w = makeWorld();
  w.bal[BUY].buyback = E18 / 2n;
  const s = newSender();
  const report = await runEvmCreatorChoicePass({ db: pg.pool, chainId: CHAIN, chain: chainOf(w), sender: senderOf(s), cfg: CFG, send: false, census, api: null, now: midWeek(), coins });
  assert.equal(report.send, false);
  assert.equal(s.signed.length, 0);
  assert.equal((await pg.pool.query(`select count(*)::int n from public.evm_creator_choice_jobs`)).rows[0].n, 0);
  const weeks = (await pg.pool.query(`select week_id, commitment, secret from public.evm_creator_choice_weeks order by week_id`)).rows;
  assert.deepEqual(weeks.map((r: any) => r.week_id), ["2026-09-28", "2026-10-05"]);
  assert.equal(weeks[0].commitment, weekCommitment(weekSecret(CFG.masterSecret, CHAIN, "2026-09-28")));
  assert.equal(weeks[0].secret, null);
  // Wallets only: no creator, no contract, no vault.
  const snap = (await pg.pool.query(`select wallet, amount::text from public.evm_holder_snapshots where campaign_address = $1 order by wallet`, [HOLD])).rows;
  assert.deepEqual(snap, [{ wallet: H1, amount: "300" }, { wallet: H2, amount: "100" }]);
  assert.ok(report.steps.some((x) => x.kind === "buyback" && x.decision === "dry-run" && x.action === "buyback_pool"));
});

test("send: recorded before broadcast, one transaction in flight, resumed by receipt, the moment never twice", async () => {
  await reset();
  const w = makeWorld();
  w.bal[BUY].buyback = E18 / 2n;
  const s = newSender();
  let recordedFirst = false;
  const onBroadcast = async (raw: string) => {
    const r = await pg.pool.query(`select status from public.evm_creator_choice_jobs where tx_hash = $1`, [ethers.keccak256(raw)]);
    recordedFirst = r.rows[0]?.status === "sending";
  };
  const p1 = await pass(w, s, { onBroadcast });
  const sent = p1.steps.filter((x) => x.decision === "sent" && x.txHash);
  assert.equal(sent.length, 1);
  assert.equal(recordedFirst, true);
  const job = (await pg.pool.query(`select * from public.evm_creator_choice_jobs`)).rows[0];
  assert.equal(job.action, "buyback_pool");
  assert.equal(job.status, "sending");
  assert.equal(job.raw_tx, s.broadcasts[0]);
  assert.equal(job.amount_raw, String(E18 / 2n));
  assert.equal(job.chain_time, String(w.blockTime));

  // No receipt yet, nonce unused: the same bytes are re-broadcast and nothing new is sent.
  const p2 = await pass(w, s);
  assert.ok(p2.inFlight);
  assert.equal(s.broadcasts.length, 2);
  assert.equal(s.broadcasts[1], s.broadcasts[0]);
  assert.equal(p2.steps.filter((x) => x.decision === "sent" && x.txHash).length, 0);

  // Receipt: confirmed. The moment is used, so the buyback is not sent again.
  s.receipts.set(job.tx_hash, { status: 1, blockNumber: 1001 });
  s.latest = 8;
  const p3 = await pass(w, s);
  assert.equal((await pg.pool.query(`select status from public.evm_creator_choice_jobs where id = $1`, [job.id])).rows[0].status, "confirmed");
  assert.ok(!p3.steps.some((x) => x.kind === "buyback" && (x.decision === "sent" || x.decision === "queued")));
  // A second live job for the same moment is refused by the database itself.
  await assert.rejects(
    pg.pool.query(
      `insert into public.evm_creator_choice_jobs (chain_id, vault_address, subject, action, moment_key, operator_address, nonce, tx_hash, raw_tx, status, chain_time)
       values ($1,$2,$3,'buyback_pool',$4,'x',9,'0xdead','0x','sending',1)`,
      [CHAIN, VAULT, BUY, job.moment_key],
    ),
  );
});

test("restart: a broadcast that failed stays 'sending'; its nonce used elsewhere without a receipt makes it 'dropped'", async () => {
  await reset();
  const w = makeWorld();
  w.bal[BUY].buyback = E18 / 2n;
  const s = newSender();
  s.failBroadcast = true;
  const p1 = await pass(w, s);
  assert.equal(p1.steps.find((x) => x.decision === "sent" && x.txHash)?.error, "rpc down");
  const job = (await pg.pool.query(`select * from public.evm_creator_choice_jobs`)).rows[0];
  assert.equal(job.status, "sending");
  assert.match(job.last_error, /rpc down/);
  // "Restart": a fresh sender, the nonce went to another transaction.
  const s2 = newSender();
  s2.latest = 9;
  s2.pending = 9;
  await pass(w, s2);
  assert.equal((await pg.pool.query(`select status from public.evm_creator_choice_jobs where id = $1`, [job.id])).rows[0].status, "dropped");
  // The dropped job frees its moment: this pass may send it again (it did not land).
  const again = (await pg.pool.query(`select count(*)::int n from public.evm_creator_choice_jobs where status = 'sending'`)).rows[0].n;
  assert.equal(again, 1);
});

test("refusals: another operator or a paused operator sends nothing; the route authority key is refused outright", async () => {
  await reset();
  const w = makeWorld();
  w.bal[BUY].buyback = E18 / 2n;
  w.operator = AUTHORITY;
  const s = newSender();
  const p = await pass(w, s);
  assert.equal(p.operatorOk, false);
  assert.equal(s.signed.length, 0);
  assert.match(String(p.steps[0].reason), /vault operator is/);
  w.operator = operator.address;
  w.paused = true;
  const p2 = await pass(w, s);
  assert.equal(p2.operatorOk, false);
  assert.equal(s.signed.length, 0);
  w.paused = false;
  w.routeAuthority = operator.address;
  await assert.rejects(pass(w, s), /route authority/);
});

test("curve buyback: the API is asked with the vault as actor, within the caps; ImpactTooHigh halves the amount", async () => {
  await reset();
  const w = makeWorld();
  w.bal[CURVE].buyback = 2n * E18;
  const asked: any[] = [];
  const api = async (req: any) => {
    asked.push(req);
    return { signature: `0x${"ab".repeat(65)}`, deadline: 1_790_000_600n };
  };
  let impactRefusals = 1;
  w.sim = (call) => {
    if (call.fn === "buybackCurve" && impactRefusals > 0) {
      impactRefusals -= 1;
      return { ok: false, revert: "ImpactTooHigh" };
    }
    return null;
  };
  const s = newSender();
  const p = await pass(w, s, { api });
  const step = p.steps.find((x) => x.action === "buyback_curve" && x.decision === "sent");
  assert.ok(step, JSON.stringify(p.steps));
  assert.equal(asked.length, 2);
  assert.equal(asked[0].vault, ethers.getAddress(VAULT));
  assert.equal(asked[0].campaign, ethers.getAddress(CURVE));
  assert.ok(asked[0].amountIn <= E18); // per-buy cap
  assert.equal(asked[1].amountIn, asked[0].amountIn / 2n);
  const call = s.signed[0] as any;
  assert.equal(call.fn, "buybackCurve");
  assert.equal(call.args[1], asked[1].amountIn);
  assert.equal(call.args[2], asked[1].minOut);
  // minOut: the campaign's quote less 1%.
  const q = await chainOf(w).quoteBuy(CURVE, asked[1].amountIn);
  assert.equal(asked[1].minOut, (q.tokensOut * 9_900n) / 10_000n);
});

test("holder week: publish, propose, wait for the Safe, execute after the veto window, Claim Center opens", async () => {
  await reset();
  const w = makeWorld();
  w.bal[HOLD].holder = 4n * E18;
  w.bal[SPLIT].holder = E18;
  const s = newSender();
  await pass(w, s); // Sunday: snapshots
  assert.equal((await pg.pool.query(`select count(*)::int n from public.evm_holder_snapshot_runs`)).rows[0].n, 2);

  const monday = new Date("2026-10-05T00:10:00Z");
  const p1 = await pass(w, s, { now: monday });
  const batchId = holderBatchId(CHAIN, "2026-09-28");
  const batch = (await pg.pool.query(`select * from public.evm_holder_batches where week_id = '2026-09-28'`)).rows[0];
  assert.equal(batch.status, "proposing");
  assert.equal(batch.batch_id, batchId);
  const file = batch.leaf_file;
  assert.deepEqual(checkLeafFile(file), { root: file.root, total: 5n * E18 });
  assert.equal(file.leaves.length, 2);
  // H1 holds 3/4 of HOLD and 1/2 of SPLIT.
  assert.equal(file.leaves.find((l: any) => l.account.toLowerCase() === H1).amount, String(3n * E18 + E18 / 2n));
  // The week's secret is revealed now that the week is over.
  const wk = (await pg.pool.query(`select secret from public.evm_creator_choice_weeks where week_id = '2026-09-28'`)).rows[0];
  assert.equal(wk.secret, weekSecret(CFG.masterSecret, CHAIN, "2026-09-28"));
  // Published to the Claim Center before anything was sent: one batch, one ledger row per leaf, with proofs.
  const rb = (await pg.pool.query(`select * from public.reward_batches`)).rows;
  assert.equal(rb.length, 1);
  assert.equal(rb[0].status, "funding_check");
  assert.equal(rb[0].metadata.distributorAddress, ethers.getAddress(DIST));
  assert.equal(rb[0].metadata.contractBatchId, batchId);
  const ledger = (await pg.pool.query(`select * from public.reward_ledger order by wallet_address`)).rows;
  assert.equal(ledger.length, 2);
  for (const l of ledger) assert.ok(verifyProof(file.root, merkleLeaf(l.wallet_address, BigInt(l.amount)), l.metadata.merkleProof));
  const proposeJob = (await pg.pool.query(`select * from public.evm_creator_choice_jobs where action = 'propose_holder_batch'`)).rows[0];
  const call = s.signed.find((c) => c.fn === "proposeHolderBatch") as any;
  assert.deepEqual(call.args[3], file.campaigns.map((c: any) => c.campaign));
  assert.deepEqual(call.args[4], file.campaigns.map((c: any) => BigInt(c.amount)));
  assert.ok(p1.steps.some((x) => x.action === "propose_holder_batch" && x.decision === "sent"));

  // Confirmed: the event must carry the published root and total.
  s.receipts.set(proposeJob.tx_hash, { status: 1, blockNumber: 1002 });
  s.latest = s.pending;
  w.proposals.set(proposeJob.tx_hash, { root: file.root, total: 5n * E18, executableAt: w.blockTime + 86_400n, claimDeadline: BigInt(file.claimDeadline) });
  const p2 = await pass(w, s, { now: monday });
  assert.equal((await pg.pool.query(`select status from public.evm_holder_batches where week_id = '2026-09-28'`)).rows[0].status, "proposed");
  assert.ok(p2.steps.some((x) => x.kind === "holders" && x.decision === "wait" && /Safe to approve/.test(String(x.reason))));

  // Safe approved, window over: execute.
  w.sim = (c) => (c.fn === "executeHolderBatch" ? { ok: true, gas: 200_000n, returnData: "0x" } : null);
  await pass(w, s, { now: monday });
  const exec = (await pg.pool.query(`select * from public.evm_creator_choice_jobs where action = 'execute_holder_batch'`)).rows[0];
  assert.equal(exec.subject, batchId);
  assert.equal((await pg.pool.query(`select status from public.evm_holder_batches where week_id = '2026-09-28'`)).rows[0].status, "executing");
  s.receipts.set(exec.tx_hash, { status: 1, blockNumber: 1003 });
  s.latest = s.pending;
  w.sim = (c) => (c.fn === "executeHolderBatch" ? { ok: false, revert: "BadBatch" } : null);
  await pass(w, s, { now: monday });
  assert.equal((await pg.pool.query(`select status from public.evm_holder_batches where week_id = '2026-09-28'`)).rows[0].status, "executed");
  assert.equal((await pg.pool.query(`select status from public.reward_batches`)).rows[0].status, "claim_open");
  assert.deepEqual((await pg.pool.query(`select distinct status from public.reward_ledger`)).rows, [{ status: "claimable" }]);
  // Nothing is proposed twice for the week.
  await pass(w, s, { now: monday });
  assert.equal((await pg.pool.query(`select count(*)::int n from public.evm_creator_choice_jobs where action = 'propose_holder_batch'`)).rows[0].n, 1);
});

test("holder week: a Safe veto archives the publication; a refused proposal fails, archives and rebuilds", async () => {
  await reset();
  const w = makeWorld();
  w.bal[HOLD].holder = E18;
  const s = newSender();
  await pass(w, s);
  const monday = new Date("2026-10-05T00:10:00Z");
  // The vault refuses the content: failed, publication archived, rebuilt next pass.
  w.sim = (c) => (c.fn === "proposeHolderBatch" ? { ok: false, revert: "CapExceeded" } : null);
  const p1 = await pass(w, s, { now: monday });
  assert.ok(p1.steps.some((x) => x.action === "propose_holder_batch" && x.decision === "blocked" && x.reason === "CapExceeded"));
  let b = (await pg.pool.query(`select status, attempt from public.evm_holder_batches where week_id = '2026-09-28'`)).rows[0];
  assert.deepEqual(b, { status: "failed", attempt: 1 });
  assert.equal((await pg.pool.query(`select status from public.reward_batches`)).rows[0].status, "archived");
  w.sim = () => null;
  await pass(w, s, { now: monday });
  b = (await pg.pool.query(`select status from public.evm_holder_batches where week_id = '2026-09-28'`)).rows[0];
  assert.equal(b.status, "proposing");
  assert.equal((await pg.pool.query(`select count(*)::int n from public.reward_batches where status <> 'archived'`)).rows[0].n, 1);
  const job = (await pg.pool.query(`select * from public.evm_creator_choice_jobs where action = 'propose_holder_batch'`)).rows[0];
  const file = (await pg.pool.query(`select leaf_file from public.evm_holder_batches where week_id = '2026-09-28'`)).rows[0].leaf_file;
  s.receipts.set(job.tx_hash, { status: 1, blockNumber: 1 });
  s.latest = s.pending;
  w.proposals.set(job.tx_hash, { root: file.root, total: BigInt(file.total), executableAt: w.blockTime, claimDeadline: BigInt(file.claimDeadline) });
  // Vetoed on chain: executeHolderBatch says BadBatch and we never executed it.
  w.sim = (c) => (c.fn === "executeHolderBatch" ? { ok: false, revert: "BadBatch" } : null);
  await pass(w, s, { now: monday });
  assert.equal((await pg.pool.query(`select status from public.evm_holder_batches where week_id = '2026-09-28'`)).rows[0].status, "vetoed");
  assert.equal((await pg.pool.query(`select count(*)::int n from public.reward_batches where status = 'archived'`)).rows[0].n, 2);
  assert.deepEqual((await pg.pool.query(`select distinct status from public.reward_ledger`)).rows, [{ status: "cancelled" }]);
});

test("a proposal event that does not match the published leaf file fails the batch", async () => {
  await reset();
  const w = makeWorld();
  w.bal[HOLD].holder = E18;
  const s = newSender();
  await pass(w, s);
  const monday = new Date("2026-10-05T00:10:00Z");
  await pass(w, s, { now: monday });
  const job = (await pg.pool.query(`select * from public.evm_creator_choice_jobs where action = 'propose_holder_batch'`)).rows[0];
  s.receipts.set(job.tx_hash, { status: 1, blockNumber: 1 });
  s.latest = s.pending;
  w.proposals.set(job.tx_hash, { root: ethers.ZeroHash, total: 1n, executableAt: 0n, claimDeadline: 0n });
  await pass(w, s, { now: monday });
  assert.deepEqual((await pg.pool.query(`select status, attempt from public.evm_holder_batches where week_id = '2026-09-28'`)).rows[0], { status: "failed", attempt: 1000 });
  assert.equal((await pg.pool.query(`select status from public.reward_batches`)).rows[0].status, "archived");
  // Not rebuilt: the batch id is taken on chain.
  await pass(w, s, { now: monday });
  assert.equal((await pg.pool.query(`select count(*)::int n from public.evm_creator_choice_jobs where action = 'propose_holder_batch'`)).rows[0].n, 1);
});
