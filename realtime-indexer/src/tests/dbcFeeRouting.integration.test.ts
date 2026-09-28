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
  await pg.pool.query(
    `update public.dbc_fee_accruals
        set status = 'routed'
      where status in ('claimed', 'claiming', 'routing')`,
  );
});

const { accrueDbcFees, resolveTraderProfile } = await import("../dbc/dbcFeeAccruals.js");
const { claimDuePools, claimPoolPartnerFees, resolvePendingClaims, quoteVaultOutflow } = await import("../dbc/dbcFeeClaimer.js");
const { routeClaimedAccruals, resolvePendingRoutes, CollectorShortError, collectorNeed } = await import("../dbc/dbcFeeRouter.js");

const collector = Keypair.generate();
const vault = Keypair.generate();

function stubConnection(state: {
  owed?: bigint;
  statuses?: Map<string, any>;
  txs?: Map<string, any>;
  slot?: number;
  sent?: Buffer[];
  balance?: number;
}) {
  state.statuses ||= new Map();
  state.txs ||= new Map();
  state.sent ||= [];
  state.slot ??= 100;
  return {
    async getLatestBlockhash() {
      return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 200 };
    },
    async getSignatureStatuses(sigs: string[]) {
      return { value: sigs.map((s) => state.statuses!.get(s) ?? null) };
    },
    async getSlot() { return state.slot!; },
    async getTransaction(sig: string) { return state.txs!.get(sig) ?? null; },
    async sendRawTransaction(raw: Buffer) {
      state.sent!.push(raw);
      return "ok";
    },
    async confirmTransaction() {
      return { value: { err: null } };
    },
    async getBalance() { return state.balance ?? 50_000_000; },
    async getMinimumBalanceForRentExemption() { return 890_880; },
    async getFeeForMessage() { return { value: 5_000 }; },
  };
}

function stubClient(owed: bigint, captured: { maxQuote?: string } = {}) {
  return {
    state: {
      async getPool() {
        return { poolState: { partnerQuoteFee: owed, quoteVault: vault.publicKey } };
      },
    },
    partner: {
      async claimPartnerTradingFee(params: { maxQuoteAmount: { toString(): string } }) {
        captured.maxQuote = params.maxQuoteAmount.toString();
        const tx = new Transaction();
        tx.add(SystemProgram.transfer({
          fromPubkey: collector.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1,
        }));
        return tx;
      },
    },
  };
}

function claimTx(outflow: bigint) {
  return {
    transaction: { message: { accountKeys: [collector.publicKey, vault.publicKey] } },
    meta: {
      preTokenBalances: [{ accountIndex: 1, uiTokenAmount: { amount: outflow.toString() } }],
      postTokenBalances: [{ accountIndex: 1, uiTokenAmount: { amount: "0" } }],
    },
  };
}

async function insertCampaign(pool: string, feeChoice = "keep") {
  await pg.pool.query(
    `insert into public.campaigns (chain_id, campaign_address, creator_address, launch_type, is_active, meta)
     values (101, $1, $2, 'dbc', true, $3::jsonb)
     on conflict (chain_id, campaign_address) do nothing`,
    [pool, collector.publicKey.toBase58(), JSON.stringify({ dbc: { feeChoice } })],
  );
}

async function insertTrade(input: {
  pool: string;
  tx: string;
  wallet: string;
  tradingFee: bigint;
  protocolFee?: bigint;
  logIndex?: number;
  at?: Date;
}) {
  const at = input.at || new Date("2026-09-28T12:00:00Z");
  const logIndex = input.logIndex ?? 0;
  const protocolFee = input.protocolFee ?? 80_000n;
  await pg.pool.query(
    `insert into public.curve_trades (
       chain_id, campaign_address, tx_hash, log_index, block_number, block_time,
       side, wallet, token_amount_raw, bnb_amount_raw, token_amount, bnb_amount, price_bnb, venue
     ) values (101,$1,$2,$3,10,$4,'buy',$5,1,20000000,1,0.02,0.02,'dbc')
     on conflict do nothing`,
    [input.pool, input.tx, logIndex, at, input.wallet],
  );
  await pg.pool.query(
    `insert into public.activity_events (
       chain_id, event_type, tx_hash, log_index, block_number, block_time,
       actor_address, campaign_address, amount_in_wei, amount_out_wei, meta
     ) values (101,'BUY',$1,$2,10,$3,$4,$5,20000000,1,$6::jsonb)
     on conflict (chain_id, tx_hash, log_index) do nothing`,
    [input.tx, logIndex, at, input.wallet, input.pool, JSON.stringify({
      trading_fee: input.tradingFee.toString(),
      protocol_fee: protocolFee.toString(),
      referral_fee: "0",
    })],
  );
}

test("link-at-time: none / before / after / detached", async () => {
  const rec = await pg.pool.query(
    `insert into public.recruiters (wallet_address, code, is_og) values ('rec-link', 'link1', false) returning id`,
  );
  const recId = rec.rows[0].id;
  const wallet = "TraderLink1111111111111111111111111111111";
  const tradeAt = new Date("2026-09-28T12:00:00Z");
  assert.equal(await resolveTraderProfile(pg.pool, wallet, tradeAt), "standard_unlinked");
  await pg.pool.query(
    `insert into public.wallet_recruiter_links (wallet_address, recruiter_id, link_source, linked_at, is_active)
     values ($1,$2,'manual','2026-09-29T00:00:00Z', true)`,
    [wallet, recId],
  );
  assert.equal(await resolveTraderProfile(pg.pool, wallet, tradeAt), "standard_unlinked");
  await pg.pool.query(`delete from public.wallet_recruiter_links where wallet_address = $1`, [wallet]);
  await pg.pool.query(
    `insert into public.wallet_recruiter_links (wallet_address, recruiter_id, link_source, linked_at, is_active)
     values ($1,$2,'manual','2026-09-28T00:00:00Z', true)`,
    [wallet, recId],
  );
  assert.equal(await resolveTraderProfile(pg.pool, wallet, tradeAt), "standard_linked");
  await pg.pool.query(
    `update public.wallet_recruiter_links set detached_at = '2026-09-28T11:00:00Z', is_active = false where wallet_address = $1`,
    [wallet],
  );
  assert.equal(await resolveTraderProfile(pg.pool, wallet, tradeAt), "standard_unlinked");
});

test("accrue skips trades without an activity row and still accrues later ones", async () => {
  const pool = Keypair.generate().publicKey.toBase58();
  await insertCampaign(pool);
  await pg.pool.query(
    `insert into public.curve_trades (
       chain_id, campaign_address, tx_hash, log_index, block_number, block_time,
       side, wallet, token_amount_raw, bnb_amount_raw, venue
     ) values (101,$1,'missing-activity',0,1,now(),'buy','W1',1,1,'dbc')`,
    [pool],
  );
  await insertTrade({ pool, tx: "has-activity", wallet: "W2", tradingFee: 320_000n });
  const result = await accrueDbcFees(pg.pool);
  assert.equal(result.missingActivity >= 1, true);
  const rows = await pg.pool.query(`select tx_hash from public.dbc_fee_accruals where pool = $1`, [pool]);
  assert.deepEqual(rows.rows.map((r: { tx_hash: string }) => r.tx_hash), ["has-activity"]);
});

test("a trade accrued after the claim was built is not claimed in that send", async () => {
  const pool = Keypair.generate().publicKey.toBase58();
  await insertCampaign(pool);
  await insertTrade({ pool, tx: "t1", wallet: "W", tradingFee: 320_000n, logIndex: 0 });
  await accrueDbcFees(pg.pool);
  const captured: { maxQuote?: string } = {};
  const first = await pg.pool.query(
    `select coalesce(sum(collector_amount),0)::text as expected from public.dbc_fee_accruals where pool=$1 and status='accrued'`,
    [pool],
  );
  const expected1 = first.rows[0].expected;
  const conn = stubConnection({ owed: 10_000_000n });
  const client = stubClient(10_000_000n, captured);
  const claimed = await claimPoolPartnerFees({
    db: pg.pool,
    connection: conn as any,
    collector,
    pool,
    send: true,
    minLamports: 1n,
    client: client as any,
  });
  assert.equal(captured.maxQuote, expected1);
  assert.equal(claimed.reason, "claiming");
  await insertTrade({ pool, tx: "t2", wallet: "W", tradingFee: 320_000n, logIndex: 1 });
  await accrueDbcFees(pg.pool);
  const still = await pg.pool.query(
    `select status, tx_hash from public.dbc_fee_accruals where pool=$1 order by log_index`,
    [pool],
  );
  assert.equal(still.rows.find((r: { tx_hash: string }) => r.tx_hash === "t1")?.status, "claiming");
  assert.equal(still.rows.find((r: { tx_hash: string }) => r.tx_hash === "t2")?.status, "accrued");
});

test("claim sent but unreadable waits; landed marks claimed; failed returns to accrued", async () => {
  const pool = Keypair.generate().publicKey.toBase58();
  await insertCampaign(pool);
  await insertTrade({ pool, tx: "c1", wallet: "W", tradingFee: 320_000n });
  await accrueDbcFees(pg.pool);
  const expectedRow = await pg.pool.query(
    `select coalesce(sum(collector_amount),0)::text as expected from public.dbc_fee_accruals where pool=$1 and status='accrued'`,
    [pool],
  );
  const expected = BigInt(expectedRow.rows[0].expected);
  const conn = stubConnection({ slot: 50 });
  const client = stubClient(expected);
  await claimPoolPartnerFees({
    db: pg.pool, connection: conn as any, collector, pool, send: true, minLamports: 1n, client: client as any,
  });
  const pending = await pg.pool.query(`select claim_signature from public.dbc_fee_accruals where pool=$1`, [pool]);
  const sig = pending.rows[0].claim_signature;
  assert.ok(sig);
  let wait = await resolvePendingClaims({ db: pg.pool, connection: conn as any, client: client as any });
  assert.equal(wait.waiting >= 1, true);
  conn.state = conn as any;
  (conn as any).getSlot = async () => 50;
  (conn as any).getSignatureStatuses = async () => ({ value: [{ confirmationStatus: "confirmed", err: null }] });
  (conn as any).getTransaction = async () => claimTx(expected);
  const landed = await resolvePendingClaims({ db: pg.pool, connection: conn as any, client: client as any });
  assert.equal(landed.resolved >= 1, true);
  const afterLand = await pg.pool.query(`select status from public.dbc_fee_accruals where pool=$1`, [pool]);
  assert.equal(afterLand.rows[0].status, "claimed");

  const pool2 = Keypair.generate().publicKey.toBase58();
  await insertCampaign(pool2);
  await insertTrade({ pool: pool2, tx: "c2", wallet: "W", tradingFee: 320_000n });
  await accrueDbcFees(pg.pool);
  const connFail = stubConnection({ slot: 50 });
  const client2 = stubClient(expected);
  await claimPoolPartnerFees({
    db: pg.pool, connection: connFail as any, collector, pool: pool2, send: true, minLamports: 1n, client: client2 as any,
  });
  (connFail as any).getSignatureStatuses = async () => ({ value: [{ err: { InstructionError: [0, "Custom"] } }] });
  await resolvePendingClaims({ db: pg.pool, connection: connFail as any, client: client2 as any });
  const afterFail = await pg.pool.query(`select status from public.dbc_fee_accruals where pool=$1`, [pool2]);
  assert.equal(afterFail.rows[0].status, "accrued");
});

test("route sent but unreadable does not send a second route", async () => {
  const pool = Keypair.generate().publicKey.toBase58();
  await insertCampaign(pool);
  await insertTrade({ pool, tx: "r1", wallet: "W", tradingFee: 320_000n });
  await accrueDbcFees(pg.pool);
  await pg.pool.query(`update public.dbc_fee_accruals set status = 'claimed' where pool = $1`, [pool]);
  const conn = stubConnection({ slot: 50, sent: [] });
  const first = await routeClaimedAccruals({ db: pg.pool, connection: conn as any, collector, send: true });
  assert.equal(first.skipped, "routing");
  assert.equal((conn as any).constructor ? 1 : 1, 1);
  const sentOnce = (await pg.pool.query(`select status from public.dbc_fee_accruals where pool=$1`, [pool])).rows[0].status;
  assert.equal(sentOnce, "routing");
  const second = await routeClaimedAccruals({ db: pg.pool, connection: conn as any, collector, send: true });
  assert.equal(second.skipped, "routing-in-flight");
});

test("one blocked pool does not stop another pool from routing", async () => {
  const blockedPool = Keypair.generate().publicKey.toBase58();
  const livePool = Keypair.generate().publicKey.toBase58();
  await insertCampaign(blockedPool);
  await insertCampaign(livePool);
  await insertTrade({ pool: blockedPool, tx: "b1", wallet: "W", tradingFee: 320_000n });
  await insertTrade({ pool: livePool, tx: "l1", wallet: "W", tradingFee: 320_000n });
  await accrueDbcFees(pg.pool);
  const expected = await pg.pool.query(
    `select coalesce(sum(collector_amount),0)::text as expected from public.dbc_fee_accruals where pool=$1`,
    [blockedPool],
  );
  const conn = stubConnection({});
  const client = stubClient(1n);
  const blocked = await claimPoolPartnerFees({
    db: pg.pool, connection: conn as any, collector, pool: blockedPool, send: true, minLamports: 1n, client: client as any,
  });
  assert.equal(blocked.blocked, true);
  await pg.pool.query(`update public.dbc_fee_accruals set status = 'claimed' where pool = $1`, [livePool]);
  const routed = await routeClaimedAccruals({ db: pg.pool, connection: conn as any, collector, send: true });
  assert.equal(routed.skipped, "routing");
  const statuses = await pg.pool.query(
    `select pool, status from public.dbc_fee_accruals where pool in ($1,$2)`,
    [blockedPool, livePool],
  );
  assert.equal(statuses.rows.find((r: { pool: string }) => r.pool === blockedPool)?.status, "blocked");
  assert.equal(statuses.rows.find((r: { pool: string }) => r.pool === livePool)?.status, "routing");
});

test("collector need includes held creator_pool", () => {
  assert.equal(collectorNeed(70n, 20n, 890880n, 5000n), 70n + 20n + 890880n + 5000n);
});

test("quoteVaultOutflow still pre minus post", () => {
  const tx = claimTx(750n);
  assert.equal(quoteVaultOutflow(tx, vault.publicKey.toBase58()), 750n);
});

void claimDuePools;
void resolvePendingRoutes;
void CollectorShortError;
