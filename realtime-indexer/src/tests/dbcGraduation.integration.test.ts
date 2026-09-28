import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { startThrowawayPostgres } from "../../../scripts/dbc/throwaway-postgres.mjs";

process.env.ABLY_API_KEY ||= "test:key";
process.env.PG_DISABLE_SSL = "1";
process.env.SOLANA_RPC_HTTP ||= "http://127.0.0.1:8899";

const pg = await startThrowawayPostgres();
process.env.DATABASE_URL = pg.url;
test.after(async () => {
  await pg.stop();
});

test.afterEach(async () => {
  await pg.pool.query(`update public.dbc_graduation_jobs set status = 'done' where status in ('ready', 'sending')`);
});

const { upsertGraduationJob, resolvePendingGraduation, advanceGraduationJob } = await import("../dbc/dbcGraduationKeeper.js");
const { nextGraduationStep, readConfigSnapshot, readPoolSnapshot, PARTNER_WITHDRAW_BIT } = await import("../dbc/dbcGraduationState.js");

const collector = Keypair.generate();
const creator = Keypair.generate();
const vault = Keypair.generate();

function stubConnection(state: {
  statuses?: Map<string, any>;
  txs?: Map<string, any>;
  height?: number;
  sent?: Buffer[];
  balance?: number;
}) {
  state.statuses ||= new Map();
  state.txs ||= new Map();
  state.sent ||= [];
  state.height ??= 200;
  return {
    async getLatestBlockhash() {
      return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 250 };
    },
    async getSignatureStatuses(sigs: string[]) {
      return { value: sigs.map((s) => state.statuses!.get(s) ?? null) };
    },
    async getBlockHeight() { return state.height!; },
    async getSlot() { return state.height!; },
    async getTransaction(sig: string) { return state.txs!.get(sig) ?? null; },
    async sendRawTransaction(raw: Buffer) {
      state.sent!.push(raw);
      return "SentSig111111111111111111111111111111111111111111111111111";
    },
    async confirmTransaction() {
      return { value: { err: null } };
    },
    async getBalance() { return state.balance ?? 50_000_000; },
    async getMinimumBalanceForRentExemption() { return 890_880; },
    async getFeeForMessage() { return { value: 5_000 }; },
    async getTokenAccountBalance() { return { value: { amount: "1000" } }; },
    sent: state.sent,
  };
}

function poolState(over: Record<string, unknown> = {}) {
  return {
    isMigrated: 0,
    migrationProgress: 1,
    migrationFeeWithdrawStatus: 0,
    quoteReserve: 1_500_000_000n,
    protocolMigrationQuoteFeeAmount: 2_340_000n,
    protocolMigrationBaseFeeAmount: 1_000n,
    creator: creator.publicKey,
    baseMint: Keypair.generate().publicKey,
    config: Keypair.generate().publicKey,
    quoteVault: vault.publicKey,
    baseVault: Keypair.generate().publicKey,
    ...over,
  };
}

function stubClient(state: ReturnType<typeof poolState>, captured: { calls: string[] } = { calls: [] }) {
  const cfg = {
    migrationQuoteThreshold: 1_500_000_000n,
    lockedVestingConfig: { totalLockedVestingAmount: 20_000_000_000_000n },
    quoteMint: new PublicKey("So11111111111111111111111111111111111111112"),
  };
  return {
    state: {
      async getPool() { return { poolState: state }; },
      async getPoolConfig() { return { poolConfig: cfg }; },
    },
    migration: {
      async createLocker() {
        captured.calls.push("createLocker");
        const tx = new Transaction();
        tx.add(SystemProgram.transfer({ fromPubkey: collector.publicKey, toPubkey: creator.publicKey, lamports: 1 }));
        return tx;
      },
      async migrateToDammV2() {
        captured.calls.push("migrate");
        const tx = new Transaction();
        tx.add(SystemProgram.transfer({ fromPubkey: collector.publicKey, toPubkey: creator.publicKey, lamports: 1 }));
        return { transaction: tx, firstPositionNftKeypair: Keypair.generate(), secondPositionNftKeypair: Keypair.generate() };
      },
    },
    partner: {
      async partnerWithdrawMigrationFee() {
        captured.calls.push("withdraw");
        const tx = new Transaction();
        tx.add(SystemProgram.transfer({ fromPubkey: collector.publicKey, toPubkey: creator.publicKey, lamports: 1 }));
        return tx;
      },
    },
    captured,
  };
}

async function insertCampaign(poolAddr: string) {
  await pg.pool.query(
    `insert into public.campaigns (chain_id, campaign_address, creator_address, token_address, launch_type, is_active, meta)
     values (101, $1, $2, $3, 'dbc', true, '{}'::jsonb)
     on conflict (chain_id, campaign_address) do nothing`,
    [poolAddr, creator.publicKey.toBase58(), Keypair.generate().publicKey.toBase58()],
  );
}

test("tables exist on throwaway postgres", async () => {
  const jobs = await pg.pool.query(`select to_regclass('public.dbc_graduation_jobs') as name`);
  const comps = await pg.pool.query(`select to_regclass('public.dbc_graduation_compensations') as name`);
  assert.equal(jobs.rows[0].name, "dbc_graduation_jobs");
  assert.equal(comps.rows[0].name, "dbc_graduation_compensations");
});

test("Meteora-first: already migrated skips locker and migrate, withdraws next", async () => {
  const poolAddr = Keypair.generate().publicKey.toBase58();
  await insertCampaign(poolAddr);
  await upsertGraduationJob(pg.pool, { pool: poolAddr, creator: creator.publicKey.toBase58() });
  const state = poolState({ isMigrated: 1, migrationProgress: 3 });
  const captured = { calls: [] as string[] };
  const client = stubClient(state, captured);
  const conn = stubConnection({});
  const result = await advanceGraduationJob({
    db: pg.pool,
    connection: conn as any,
    collector,
    pool: poolAddr,
    send: false,
    client: client as any,
  });
  assert.equal(result.step, "withdraw");
  assert.equal(result.skipped, "dry-run");
  assert.deepEqual(captured.calls, []);
  const snap = readPoolSnapshot(state)!;
  const cfg = readConfigSnapshot({
    migrationQuoteThreshold: 1_500_000_000n,
    lockedVestingConfig: { totalLockedVestingAmount: 20_000_000_000_000n },
  })!;
  assert.equal(nextGraduationStep(snap, cfg, { partnerFee: null, compensationPaid: false, routed: false, marked: false, lpDone: false }), "withdraw");
});

test("pending send is left pending; expired by block height returns to ready; never a second send", async () => {
  const poolAddr = Keypair.generate().publicKey.toBase58();
  await insertCampaign(poolAddr);
  await pg.pool.query(
    `insert into public.dbc_graduation_jobs (pool, creator, step, status, signature, last_valid_block_height)
     values ($1,$2,'withdraw','sending','PendingSig11111111111111111111111111111111111111', 180)`,
    [poolAddr, creator.publicKey.toBase58()],
  );
  const conn = stubConnection({ height: 150 });
  const first = await resolvePendingGraduation({ db: pg.pool, connection: conn as any });
  assert.equal(first.waiting, 1);
  const still = await pg.pool.query(`select status from public.dbc_graduation_jobs where pool = $1`, [poolAddr]);
  assert.equal(still.rows[0].status, "sending");

  conn.getBlockHeight = async () => 181;
  const expired = await resolvePendingGraduation({ db: pg.pool, connection: conn as any });
  assert.equal(expired.resolved, 1);
  const after = await pg.pool.query(`select status, signature from public.dbc_graduation_jobs where pool = $1`, [poolAddr]);
  assert.equal(after.rows[0].status, "ready");
  assert.equal(after.rows[0].signature, null);
});

test("landed withdraw records partner_fee from quote vault outflow and advances to compensate", async () => {
  const poolAddr = Keypair.generate().publicKey.toBase58();
  await insertCampaign(poolAddr);
  const sig = "LandedWithdraw111111111111111111111111111111111111";
  await pg.pool.query(
    `insert into public.dbc_graduation_jobs (pool, creator, step, status, signature, last_valid_block_height)
     values ($1,$2,'withdraw','sending',$3, 400)`,
    [poolAddr, creator.publicKey.toBase58(), sig],
  );
  const tx = {
    slot: 9,
    transaction: { message: { accountKeys: [collector.publicKey, vault.publicKey] } },
    meta: {
      err: null,
      preTokenBalances: [{ accountIndex: 1, uiTokenAmount: { amount: "330000" } }],
      postTokenBalances: [{ accountIndex: 1, uiTokenAmount: { amount: "0" } }],
    },
  };
  const state = poolState({ isMigrated: 1, migrationProgress: 3, migrationFeeWithdrawStatus: PARTNER_WITHDRAW_BIT });
  const client = stubClient(state);
  const conn = stubConnection({ txs: new Map([[sig, tx]]) });
  const result = await resolvePendingGraduation({ db: pg.pool, connection: conn as any, client: client as any });
  assert.equal(result.resolved, 1);
  const row = await pg.pool.query(`select step, status, partner_fee::text as partner_fee from public.dbc_graduation_jobs where pool = $1`, [poolAddr]);
  assert.equal(row.rows[0].status, "ready");
  assert.equal(row.rows[0].step, "compensate");
  assert.equal(row.rows[0].partner_fee, "330000");
});

test("a sending job on one pool does not start a send on another", async () => {
  const a = Keypair.generate().publicKey.toBase58();
  const b = Keypair.generate().publicKey.toBase58();
  await insertCampaign(a);
  await insertCampaign(b);
  await pg.pool.query(
    `insert into public.dbc_graduation_jobs (pool, step, status, signature, last_valid_block_height)
     values ($1,'withdraw','sending','InFlight111111111111111111111111111111111111111', 500)`,
    [a],
  );
  const { runDbcGraduationOnce } = await import("../dbc/dbcGraduationKeeper.js");
  const conn = stubConnection({ height: 100 });
  const result = await runDbcGraduationOnce({
    db: pg.pool,
    connection: conn as any,
    collector,
    send: true,
    pool: b,
    client: stubClient(poolState({ isMigrated: 1, migrationProgress: 3 })) as any,
  });
  assert.equal(result.advanced[0].skipped, "sending-in-flight");
  assert.equal(conn.sent!.length, 0);
});
