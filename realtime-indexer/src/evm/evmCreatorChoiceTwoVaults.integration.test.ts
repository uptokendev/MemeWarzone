/**
 * Gen-7's own fees stack (founder decision 2026-10-08): one operator key works the gen-6 CreatorRewardsVaultV2 and
 * gen-7's own vault on the same chain. Against a real (throwaway) Postgres with the migrations applied and two
 * scripted vaults: the gen-7 vault waits for the per-vault key (migration 20261008_000040) while gen-6 runs as
 * before; then both vaults publish and propose their own weekly holder batch (own batch id, own Claim Center
 * batch, own leaf file), one transaction in flight per chain across both vaults (shared nonce), each job resolved
 * through its own vault.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { ethers } from "ethers";

process.env.DBC_THROWAY_PG_PORT = "55448";
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
// The production guard (db/migrations/20260710_000002): one live airdrop batch per chain, epoch and program.
await pg.pool.query(fs.readFileSync(new URL("db/migrations/20260710_000002_weekly_airdrop_automation_guards.sql", root), "utf8"));

const { DEFAULT_CHOICE_CONFIG } = await import("./evmCreatorChoicePass.js");
const { runChoiceLanes, holderBatchesKeyedByVault } = await import("./evmCreatorChoiceLanes.js");
const { weekOf, weekSecret, snapshotMoment, holderBatchId, checkLeafFile } = await import("./evmCreatorChoice.js");
type ChoiceChain = import("./evmCreatorChoiceChain.js").ChoiceChain;
type ChoiceSender = import("./evmCreatorChoiceChain.js").ChoiceSender;
type VaultCall = import("./evmCreatorChoiceChain.js").VaultCall;

const CHAIN = 56;
const VAULT6 = "0x00000000000000000000000000000000000006aa";
const VAULT7 = "0x00000000000000000000000000000000000007aa";
const DIST6 = "0x00000000000000000000000000000000000006bb";
const DIST7 = "0x00000000000000000000000000000000000007bb";
const FACTORY6 = "0x00000000000000000000000000000000000006fa";
const FACTORY7 = "0x00000000000000000000000000000000000007fa";
const AUTHORITY = "0x00000000000000000000000000000000000000a0";
const HOLD6 = "0x00000000000000000000000000000000000006c1";
const HOLD7 = "0x00000000000000000000000000000000000007c1";
const CREATOR = "0x00000000000000000000000000000000000000e1";
const H1 = "0x00000000000000000000000000000000000000f1";
const H2 = "0x00000000000000000000000000000000000000f2";
const E18 = 10n ** 18n;
const operator = new ethers.Wallet("0x" + "33".repeat(32));

type Vault = {
  vault: string;
  dist: string;
  factory: string;
  holder: Record<string, bigint>;
  proposals: Map<string, { root: string; total: bigint; executableAt: bigint; claimDeadline: bigint }>;
  simulated: VaultCall[];
};

const BLOCK_TIME = 1_790_000_000n;

function chainOf(v: Vault): ChoiceChain {
  return {
    vault: ethers.getAddress(v.vault),
    async latestBlock() {
      return { number: 1_000, timestamp: BLOCK_TIME };
    },
    async vaultInfo() {
      return {
        operator: operator.address, admin: AUTHORITY, factory: v.factory, holderDistributor: ethers.getAddress(v.dist), holderBatchDelay: 86_400n,
        limits: { paused: false, buyPerTx: E18, buybackPerCampaignWeek: 3n * E18, buyInterval: 21_600n, impactBps: 50n, holderBatchPerWeek: 10n * E18 },
      };
    },
    async routeAuthority() {
      return AUTHORITY;
    },
    async cfg() {
      return { creator: CREATOR, choice: 2, creatorPct: 0, pool: null, quote: null };
    },
    async balances(c) {
      return { holder: v.holder[c.toLowerCase()] ?? 0n, holderQuote: 0n, buyback: 0n, buybackQuote: 0n, heldTokens: 0n, spentInWeek: 0n };
    },
    async quoteRoutePool() {
      return null;
    },
    async curve() {
      return { token: ethers.ZeroAddress, launched: false, graduationPending: false, currentPrice: 10n ** 9n, netRaised: 0n, nativeTarget: 100n * E18 };
    },
    async quoteBuy(_c, amount) {
      return { tokensOut: amount, totalCost: amount, fee: 0n };
    },
    async tradingEnabled() {
      return true;
    },
    async simulate(call) {
      v.simulated.push(call);
      if (call.fn === "executeHolderBatch") return { ok: false, revert: "NotApproved" };
      return { ok: true, gas: 150_000n, returnData: ethers.zeroPadValue("0x05", 32) };
    },
    async isContract() {
      return false;
    },
    async proposedInReceipt(hash) {
      return v.proposals.get(hash) ?? null;
    },
  };
}

/** One key: one nonce sequence and one receipt book for both vaults; each sender signs to its own vault. */
type KeyState = { latest: number; pending: number; receipts: Map<string, { status: number; blockNumber: number }>; signed: Array<{ to: string; call: VaultCall; nonce: number }>; sent: Set<string> };

function senderOf(k: KeyState, vault: string): ChoiceSender {
  return {
    address: operator.address,
    async getNonce(tag) {
      return tag === "latest" ? k.latest : k.pending;
    },
    async getReceipt(hash) {
      return k.receipts.get(hash) ?? null;
    },
    async sign(call, _gas, nonce) {
      k.signed.push({ to: vault, call, nonce });
      const raw = ethers.hexlify(ethers.toUtf8Bytes(`raw:${vault}:${nonce}:${k.signed.length}:${call.fn}`));
      return { raw, hash: ethers.keccak256(raw) };
    },
    async broadcast(raw) {
      // A re-broadcast of the same signed bytes uses no new nonce.
      if (k.sent.has(raw)) return;
      k.sent.add(raw);
      k.pending += 1;
    },
  };
}

const CFG = { ...DEFAULT_CHOICE_CONFIG, masterSecret: "two-vaults", minSpendWei: 10n ** 15n, minPayoutWei: 10n ** 12n };
const coins6 = [{ campaign: HOLD6, token: "0x00000000000000000000000000000000000016c1", creator: CREATOR, createdBlock: 1, choice: 2, stage: "trading" as const, pool: null }];
const coins7 = [{ campaign: HOLD7, token: "0x00000000000000000000000000000000000017c1", creator: CREATOR, createdBlock: 1, choice: 2, stage: "trading" as const, pool: null, campaignGeneration: 6 }];
const census = async () => [{ wallet: H1, amount: 300n }, { wallet: H2, amount: 100n }];

function midWeek(): Date {
  const start = weekOf(new Date("2026-09-30T00:00:00Z")).start;
  const snap = snapshotMoment(weekSecret(CFG.masterSecret, CHAIN, "2026-09-28"), CHAIN, start);
  const t = new Date("2026-10-04T23:59:00Z");
  assert.ok(t.getTime() > snap.getTime());
  return t;
}
const MONDAY = new Date("2026-10-05T00:10:00Z");

function lanesFor(v6: Vault, v7: Vault, k: KeyState) {
  return [
    { vault: ethers.getAddress(v6.vault), program: "airdrop_holders", label: "gen-6" as const, chain: chainOf(v6), sender: senderOf(k, v6.vault) },
    { vault: ethers.getAddress(v7.vault), program: "airdrop_holders_gen7", label: "gen-7" as const, chain: chainOf(v7), sender: senderOf(k, v7.vault) },
  ];
}

function world(): { v6: Vault; v7: Vault; k: KeyState } {
  return {
    v6: { vault: VAULT6, dist: DIST6, factory: FACTORY6, holder: { [HOLD6]: 4n * E18 }, proposals: new Map(), simulated: [] },
    v7: { vault: VAULT7, dist: DIST7, factory: FACTORY7, holder: { [HOLD7]: 2n * E18 }, proposals: new Map(), simulated: [] },
    k: { latest: 7, pending: 7, receipts: new Map(), signed: [], sent: new Set() },
  };
}

function run(v6: Vault, v7: Vault, k: KeyState, round: number, now: Date) {
  return runChoiceLanes({
    db: pg.pool, chainId: CHAIN, lanes: lanesFor(v6, v7, k), cfg: CFG, send: true, census, api: null, round, now,
    coinsFor: (vault: string) => (vault.toLowerCase() === VAULT6 ? coins6 : coins7),
  });
}

async function reset() {
  await pg.pool.query(`truncate public.evm_creator_choice_jobs, public.evm_holder_batches, public.evm_holder_snapshots, public.evm_holder_snapshot_runs,
    public.evm_creator_choice_weeks, public.reward_batches, public.reward_ledger, public.reward_batch_items`);
}

test("before the per-vault key: the gen-7 vault waits with a reason, the gen-6 vault runs exactly as before", async () => {
  await reset();
  assert.equal(await holderBatchesKeyedByVault(pg.pool), false);
  const { v6, v7, k } = world();
  const out = await run(v6, v7, k, 0, midWeek());
  const g6 = out.find((o) => o.lane.label === "gen-6")!;
  const g7 = out.find((o) => o.lane.label === "gen-7")!;
  assert.ok(g6.report && !g6.error);
  assert.match(String(g7.error), /20261008_000040_evm_holder_batches_per_vault\.sql/);
  assert.equal(g7.report, undefined);
  // The gen-7 vault was never touched: no simulation, no snapshot of its coin.
  assert.equal(v7.simulated.length, 0);
  const runs = (await pg.pool.query(`select campaign_address from public.evm_holder_snapshot_runs order by 1`)).rows.map((r: any) => r.campaign_address);
  assert.deepEqual(runs, [HOLD6]);
});

test("both vaults: own batch id, own leaf file, own Claim Center batch; one transaction in flight across both; jobs resolved per vault", async () => {
  await pg.pool.query(fs.readFileSync(new URL("db/migrations/20261008_000040_evm_holder_batches_per_vault.sql", root), "utf8"));
  // Re-runnable.
  await pg.pool.query(fs.readFileSync(new URL("db/migrations/20261008_000040_evm_holder_batches_per_vault.sql", root), "utf8"));
  assert.equal(await holderBatchesKeyedByVault(pg.pool), true);
  await reset();
  const { v6, v7, k } = world();
  await run(v6, v7, k, 0, midWeek()); // snapshots of both coins
  assert.equal((await pg.pool.query(`select count(*)::int n from public.evm_holder_snapshot_runs`)).rows[0].n, 2);

  // Monday, round 0: gen-6 first. It publishes and proposes; gen-7 publishes but queues behind the key's tx in flight.
  const r0 = await run(v6, v7, k, 0, MONDAY);
  assert.deepEqual(r0.map((o) => o.lane.label), ["gen-6", "gen-7"]);
  for (const o of r0) assert.ok(o.report, String(o.error));
  assert.equal(k.signed.length, 1);
  assert.equal(k.signed[0].to, VAULT6);
  assert.equal(k.signed[0].nonce, 7);
  const r0g7 = r0.find((o) => o.lane.label === "gen-7")!.report!;
  assert.ok(r0g7.inFlight);
  assert.ok(r0g7.steps.some((s) => s.action === "propose_holder_batch" && s.decision === "queued"));

  const batches = (await pg.pool.query(`select vault_address, batch_id, status, leaf_file from public.evm_holder_batches where week_id = '2026-09-28' order by vault_address`)).rows;
  assert.equal(batches.length, 2);
  const b6 = batches.find((b: any) => b.vault_address === VAULT6);
  const b7 = batches.find((b: any) => b.vault_address === VAULT7);
  assert.equal(b6.batch_id, holderBatchId(CHAIN, "2026-09-28"));
  assert.equal(b6.batch_id, ethers.keccak256(ethers.toUtf8Bytes("mwz-weekly-airdrop:56:2026-09-28:airdrop_holders")), "gen-6 id unchanged");
  assert.equal(b7.batch_id, ethers.keccak256(ethers.toUtf8Bytes("mwz-weekly-airdrop:56:2026-09-28:airdrop_holders_gen7")));
  assert.equal(b6.status, "proposing");
  assert.equal(b7.status, "built");
  assert.equal(b6.leaf_file.program, undefined, "gen-6 leaf files carry no program field");
  assert.equal(b7.leaf_file.program, "airdrop_holders_gen7");
  assert.equal(b7.leaf_file.holderDistributor, ethers.getAddress(DIST7));
  assert.deepEqual(checkLeafFile(b7.leaf_file), { root: b7.leaf_file.root, total: 2n * E18 });
  const rb = (await pg.pool.query(`select metadata from public.reward_batches order by metadata->>'program'`)).rows.map((r: any) => r.metadata);
  assert.deepEqual(rb.map((m: any) => m.program), ["airdrop_holders", "airdrop_holders_gen7"]);
  assert.equal(rb[1].distributorAddress, ethers.getAddress(DIST7));
  assert.equal(rb[1].creatorVault, ethers.getAddress(VAULT7));
  const sources = (await pg.pool.query(`select distinct split_part(source_id, ':', 2) p from public.reward_ledger order by 1`)).rows.map((r: any) => r.p);
  assert.deepEqual(sources, ["airdrop_holders", "airdrop_holders_gen7"]);

  // Gen-6's proposal lands. Round 1: gen-7 first. Its pass resolves gen-6's job through the gen-6 vault, then sends.
  const job6 = (await pg.pool.query(`select * from public.evm_creator_choice_jobs where vault_address = $1`, [VAULT6])).rows[0];
  k.receipts.set(job6.tx_hash, { status: 1, blockNumber: 1001 });
  k.latest = k.pending;
  v6.proposals.set(job6.tx_hash, { root: b6.leaf_file.root, total: 4n * E18, executableAt: BLOCK_TIME + 86_400n, claimDeadline: BigInt(b6.leaf_file.claimDeadline) });
  const r1 = await run(v6, v7, k, 1, MONDAY);
  assert.deepEqual(r1.map((o) => o.lane.label), ["gen-7", "gen-6"]);
  assert.equal((await pg.pool.query(`select status from public.evm_holder_batches where vault_address = $1 and week_id = '2026-09-28'`, [VAULT6])).rows[0].status, "proposed");
  assert.equal(k.signed.length, 2);
  assert.equal(k.signed[1].to, VAULT7);
  assert.equal(k.signed[1].nonce, 8, "the same key's next nonce");
  const call7 = k.signed[1].call as any;
  assert.equal(call7.fn, "proposeHolderBatch");
  assert.equal(call7.args[0], b7.batch_id);
  // Never two transactions in flight for the key.
  assert.equal((await pg.pool.query(`select count(*)::int n from public.evm_creator_choice_jobs where status = 'sending'`)).rows[0].n, 1);
  // The gen-6 vault waits for its Safe approval, without touching gen-7's job.
  const r1g6 = r1.find((o) => o.lane.label === "gen-6")!.report!;
  assert.ok(r1g6.steps.some((s) => s.kind === "holders" && /Safe to approve/.test(String(s.reason ?? ""))) || r1g6.inFlight);

  // Gen-7's proposal lands; round 2 (gen-6 first) resolves it through the gen-7 vault.
  const job7 = (await pg.pool.query(`select * from public.evm_creator_choice_jobs where vault_address = $1`, [VAULT7])).rows[0];
  k.receipts.set(job7.tx_hash, { status: 1, blockNumber: 1002 });
  k.latest = k.pending;
  v7.proposals.set(job7.tx_hash, { root: b7.leaf_file.root, total: 2n * E18, executableAt: BLOCK_TIME + 86_400n, claimDeadline: BigInt(b7.leaf_file.claimDeadline) });
  await run(v6, v7, k, 2, MONDAY);
  const after = (await pg.pool.query(`select vault_address, status from public.evm_holder_batches where week_id = '2026-09-28' order by vault_address`)).rows;
  assert.deepEqual(after, [{ vault_address: VAULT6, status: "proposed" }, { vault_address: VAULT7, status: "proposed" }]);
  // Nothing proposed twice, for either vault.
  assert.equal((await pg.pool.query(`select count(*)::int n from public.evm_creator_choice_jobs where action = 'propose_holder_batch'`)).rows[0].n, 2);
});

test("a gen-7 proposal event that does not match its leaf file fails only the gen-7 batch", async () => {
  await reset();
  const { v6, v7, k } = world();
  await run(v6, v7, k, 0, midWeek());
  await run(v6, v7, k, 1, MONDAY); // gen-7 first: it proposes
  const job7 = (await pg.pool.query(`select * from public.evm_creator_choice_jobs where vault_address = $1`, [VAULT7])).rows[0];
  assert.ok(job7);
  k.receipts.set(job7.tx_hash, { status: 1, blockNumber: 1 });
  k.latest = k.pending;
  v7.proposals.set(job7.tx_hash, { root: ethers.ZeroHash, total: 1n, executableAt: 0n, claimDeadline: 0n });
  await run(v6, v7, k, 0, MONDAY);
  const rows = (await pg.pool.query(`select vault_address, status, attempt from public.evm_holder_batches where week_id = '2026-09-28' order by vault_address`)).rows;
  assert.deepEqual(rows.find((r: any) => r.vault_address === VAULT7), { vault_address: VAULT7, status: "failed", attempt: 1000 });
  assert.notEqual(rows.find((r: any) => r.vault_address === VAULT6).status, "failed");
  const programs = (await pg.pool.query(`select metadata->>'program' p, status from public.reward_batches order by 1`)).rows;
  assert.deepEqual(programs, [{ p: "airdrop_holders", status: "funding_check" }, { p: "airdrop_holders_gen7", status: "archived" }]);
});
