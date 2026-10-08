import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.ABLY_API_KEY ||= "test:key";
process.env.SOLANA_RPC_HTTP ||= "http://127.0.0.1:8899";

const fees = await import("../importCreatorFees.js");
const { pickAccruals, protocolDue, creatorPayoutInstructions, protocolSweepInstructions, wsolAccount, importFeeSettings, runImportCreatorFeePass, isValidWallet } = fees;

const OWNER = Keypair.generate().publicKey.toBase58();
const MINT = "2wT8AcQFEzXMEjb6qbs1GDg3mJ3DKBw6eBWp7GqsBAGS";
const NOW = new Date("2026-11-01T12:00:00Z");

test("accruals are paid whole, oldest first, up to the limit", () => {
  const waiting = [{ feeId: "1", creatorRaw: 40n }, { feeId: "2", creatorRaw: 30n }, { feeId: "3", creatorRaw: 50n }];
  assert.deepEqual(pickAccruals(waiting, 100n), { picked: waiting.slice(0, 2), amount: 70n });
  assert.deepEqual(pickAccruals(waiting, 1000n).amount, 120n);
  assert.deepEqual(pickAccruals(waiting, 10n), { picked: [], amount: 0n }, "never splits an accrual");
});

test("protocol due = our halves + expired creator halves - what was swept, never negative", () => {
  assert.equal(protocolDue({ protocolHalves: 100n, expiredCreator: 20n, swept: 50n }), 70n);
  assert.equal(protocolDue({ protocolHalves: 10n, expiredCreator: 0n, swept: 50n }), 0n);
});

test("payout unwraps through a temporary account back to the collector, then pays the owner exactly", () => {
  const collector = Keypair.generate().publicKey;
  const temp = Keypair.generate().publicKey;
  const ixs = creatorPayoutInstructions({ collector, temp, to: new PublicKey(OWNER), amount: 1234n, rentLamports: 2039280 });
  assert.equal(ixs.length, 5);
  const last = ixs[4];
  assert.ok(last.programId.equals(SystemProgram.programId));
  assert.ok(last.keys[0].pubkey.equals(collector));
  assert.ok(last.keys[1].pubkey.equals(new PublicKey(OWNER)));
  assert.equal(last.data.readBigUInt64LE(4), 1234n);
  // closeAccount destination is the collector (rent comes back), never the owner.
  assert.ok(ixs[3].keys[1].pubkey.equals(collector));
  const sweep = protocolSweepInstructions({ collector, protocolOwner: new PublicKey("2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB"), amount: 5n });
  assert.equal(sweep[0].keys[2].pubkey.toBase58(), "9Cex7YLoBHu5fszVsxzHxrxkzJjQbeE6EBDyYnYuMKds", "our half lands in the old import fee account");
});

test("owner must be a wallet on the curve, not a program account", () => {
  assert.equal(isValidWallet(OWNER), true);
  assert.equal(isValidWallet(wsolAccount(OWNER).toBase58()), false);
  assert.equal(isValidWallet("nope"), false);
});

type Call = { sql: string; params: unknown[] };

function fakeDb(state: { sending?: any[]; payable?: any[]; paidToday?: string; due?: { halves: string; expired: string; swept: string }; markCount?: number }) {
  const calls: Call[] = [];
  const db = {
    calls,
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      const s = sql.replace(/\s+/g, " ").trim();
      if (s.startsWith("select id, signature")) return { rows: state.sending || [] };
      if (s.startsWith("update public.import_creator_fees set status = 'expired'")) return { rows: [], rowCount: 0 };
      if (s.includes("as paid from public.import_fee_transfers")) return { rows: [{ paid: state.paidToday || "0" }] };
      if (s.startsWith("with owners as")) return { rows: state.payable || [] };
      if (s.includes("as halves")) return { rows: [state.due || { halves: "0", expired: "0", swept: "0" }] };
      if (s.startsWith("insert into public.import_fee_transfers")) return { rows: [{ id: 7 }], rowCount: 1 };
      if (s.startsWith("update public.import_creator_fees set status = 'paying'")) return { rows: [], rowCount: state.markCount ?? (params[1] as unknown[]).length };
      return { rows: [], rowCount: 1 };
    },
  };
  return db;
}

function fakeConnection(opts: { balance?: bigint; status?: any } = {}) {
  const sent: Buffer[] = [];
  return {
    sent,
    async getTokenAccountBalance() { return { value: { amount: String(opts.balance ?? 10_000_000_000n) } }; },
    async getMinimumBalanceForRentExemption() { return 2039280; },
    async getLatestBlockhash() { return { blockhash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", lastValidBlockHeight: 100 }; },
    async sendRawTransaction(raw: Buffer) { sent.push(raw); return "sig"; },
    async getSignatureStatuses() { return { value: [opts.status ?? null] }; },
    async getBlockHeight() { return 50; },
  } as any;
}

const settings = { ...importFeeSettings({}), minPayoutLamports: 100n, maxPayoutLamports: 1_000n, dailyPayoutCapLamports: 1_500n, minSweepLamports: 10n };
const payable = (rows: Array<[string, string]>) => rows.map(([feeId, raw]) => ({ token_address: MINT, project_owner_wallet: OWNER, fee_id: feeId, creator_raw: raw }));

test("dry run: lists the payout, writes nothing, sends nothing", async () => {
  const db = fakeDb({ payable: payable([["1", "300"], ["2", "400"]]) });
  const connection = fakeConnection();
  const out = await runImportCreatorFeePass({ db, connection, collector: Keypair.generate(), send: false, settings, now: NOW });
  assert.deepEqual(out.payouts, [{ token: MINT, owner: OWNER, amount: "700", signature: null }]);
  assert.equal(connection.sent.length, 0);
  assert.ok(db.calls.every((c) => !/^\s*(insert|update)/i.test(c.sql)));
});

test("send: stores 'sending' and marks the accruals before the transaction goes out; chunk capped per payout", async () => {
  const db = fakeDb({ payable: payable([["1", "600"], ["2", "600"]]) });
  const connection = fakeConnection();
  const out = await runImportCreatorFeePass({ db, connection, collector: Keypair.generate(), send: true, settings, now: NOW });
  assert.equal(out.payouts.length, 1);
  assert.equal(out.payouts[0].amount, "600", "1200 > per-payout cap 1000: oldest accrual only");
  assert.equal(connection.sent.length, 1);
  const order = db.calls.map((c) => c.sql.replace(/\s+/g, " ").trim());
  const insertAt = order.findIndex((s) => s.startsWith("insert into public.import_fee_transfers"));
  const markAt = order.findIndex((s) => s.startsWith("update public.import_creator_fees set status = 'paying'"));
  assert.ok(insertAt >= 0 && markAt > insertAt);
  assert.equal(out.sweep, null, "no protocol sweep in a pass that paid a creator");
});

test("daily cap: what does not fit today waits for tomorrow", async () => {
  const db = fakeDb({ payable: payable([["1", "600"]]), paidToday: "1450" });
  const out = await runImportCreatorFeePass({ db, connection: fakeConnection(), collector: Keypair.generate(), send: true, settings, now: NOW });
  assert.equal(out.payouts.length, 0);
  assert.ok(out.skipped.some((s) => /daily payout cap/.test(s)));
});

test("below the minimum nothing is paid; an accrual that changed under us is never sent", async () => {
  const small = await runImportCreatorFeePass({ db: fakeDb({ payable: payable([["1", "50"]]) }), connection: fakeConnection(), collector: Keypair.generate(), send: true, settings, now: NOW });
  assert.equal(small.payouts.length, 0);
  const connection = fakeConnection();
  const raced = await runImportCreatorFeePass({ db: fakeDb({ payable: payable([["1", "300"]]), markCount: 0 }), connection, collector: Keypair.generate(), send: true, settings, now: NOW });
  assert.equal(raced.payouts.length, 0);
  assert.equal(connection.sent.length, 0);
});

test("a movement that may still land blocks every new one", async () => {
  const db = fakeDb({ sending: [{ id: 1, signature: "sig", last_valid_block_height: 100 }], payable: payable([["1", "300"]]) });
  const connection = fakeConnection({ status: null }); // unseen, block height 50 < 100: pending
  const out = await runImportCreatorFeePass({ db, connection, collector: Keypair.generate(), send: true, settings, now: NOW });
  assert.deepEqual(out.resolved, { landed: 0, reset: 0, pending: 1 });
  assert.equal(connection.sent.length, 0);
});

test("protocol sweep: our due part when no creator was paid, capped by the balance", async () => {
  const db = fakeDb({ due: { halves: "500", expired: "100", swept: "200" } });
  const connection = fakeConnection({ balance: 300n });
  const out = await runImportCreatorFeePass({ db, connection, collector: Keypair.generate(), send: true, settings, now: NOW });
  assert.equal(out.sweep?.amount, "300");
  assert.equal(connection.sent.length, 1);
});
