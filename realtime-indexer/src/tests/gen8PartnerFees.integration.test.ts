/**
 * Gen-8 widget partner ledger and payout against REAL SQL: a throwaway local Postgres 16 with the gen-8 indexer schema,
 * the import fee migrations and 20261022_000010_gen8_partner_fees.sql (applied twice: idempotent). No chain: the RPC is
 * a fake transaction reader and the vault is a fake that enforces RecruiterRewardsVault.payout()'s checks.
 * Covers: attribution (only post-graduation widget swaps with a recorded fingerprint of an ACTIVE partner; bonding never;
 * a failed RPC read stops the run and is retried, never recorded as "no partner"; re-runs insert nothing), the API's
 * read-only report computing the same numbers, and the payout pass reading the real ledger (gen8_raw, room, sweep).
 * Skips when Postgres 16 is missing.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { gen8SchemaFiles } from "./gen8/gen8TestDb.js";
import { evmFingerprint, gen8PartnerShareRaw, runGen8PartnerAttributionOnce } from "../evm/gen8PartnerFees.js";
import { importFeeEvmSettings, runImportCreatorFeeEvmPass, type ImportFeeChain } from "../importCreatorFeesEvm.js";

const PG16 = "/usr/lib/postgresql/16/bin";
const runnable = fs.existsSync(`${PG16}/initdb`);

const CHAIN = 4663;
const HOOK = "0x00000000000000000000000000000000000000b8";
const POOL = "0x" + "11".repeat(32);
const COIN = "0x00000000000000000000000000000000000000c8";
const ROUTER = "0x00000000000000000000000000000000000000aa";
const WIDGET = "0x000000000000000000000000000000006d777a77";
const VAULT = "0x41076e191509d4e307a8f8b40d432b9aaa36f953";
const OPERATOR = "0x00000000000000000000000000000000000000Ee";
const PARTNER_WALLET = "0x4434567890123456789012345678901234567890";
const OLD_WALLET = "0x5534567890123456789012345678901234567890";
const milli = (n: number) => BigInt(n) * 10n ** 15n;
const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");

test("gen-8 partner ledger + payout on real SQL", { skip: runnable ? false : "Postgres 16 missing", timeout: 300_000 }, async (t) => {
  process.env.DBC_PG_BIN = PG16;
  process.env.PG_DISABLE_SSL = "1";
  const { startThrowawayPostgres } = await import("../../../scripts/dbc/throwaway-postgres.mjs");
  const pg = await startThrowawayPostgres({
    port: 55471,
    extraFiles: [
      ...gen8SchemaFiles(),
      "db/migrations/20261006_000002_finance_import_swap_fees.sql",
      "db/migrations/20261008_000020_import_creator_fees.sql",
      "db/migrations/20261009_000010_import_fee_partners.sql",
      "db/migrations/20261009_000020_graduated_creator_fees.sql",
      "db/migrations/20261022_000010_gen8_partner_fees.sql",
      "db/migrations/20261022_000010_gen8_partner_fees.sql",
      "database/prod_apply_gen8_partner_fees.sql", // the founder's paste: valid and idempotent on top of the migration
    ],
  });
  t.after(() => pg.stop());
  const db = pg.pool;
  await db.query(`create table if not exists public.arena_token_imports (chain_id integer, token_address text, project_owner_wallet text, ownership_status text, ownership_verified_at timestamptz)`);

  let nextLog = 1;
  const accrual = async (tx: string, phase: "bonding" | "post", referrer: string | null, curve: bigint, protocol: bigint, chainId = CHAIN, ageSec = 600) => {
    await db.query(
      `insert into public.evm_gen8_fee_accruals (chain_id, hook_address, pool_id, token_address, tx_hash, log_index, block_number, block_time, kind, phase, referrer,
         curve_amount, fee, creator_share, router_amount, protocol, created_at)
       values ($1, $2, $3, $4, $5, $6, 900, now(), 'trade', $7, $8, $9, $10, 0, $10, $11, now() - make_interval(secs => $12::int))`,
      [chainId, HOOK, POOL, COIN, tx, nextLog++, phase, referrer, curve.toString(), (curve / 100n).toString(), protocol.toString(), ageSec],
    );
  };
  const txs: Record<string, { to: string; data: string; value: bigint }> = {};
  const build = (tx: string, data: string, partner: string | null) => {
    txs[tx] = { to: ROUTER, data, value: 0n };
    return partner ? db.query(`insert into public.import_swap_fingerprints (fingerprint, chain_id, partner_id) values ($1, $2, $3)`, [evmFingerprint(ROUTER, data, 0n), CHAIN, partner]) : null;
  };
  await db.query(
    `insert into public.import_fee_partners (id, chain_id, name, payout_wallet, active) values ('crypticpump', $1, 'CrypticPump', $2, true), ('oldie', $1, 'Old', $3, false)`,
    [CHAIN, PARTNER_WALLET, OLD_WALLET],
  );

  const A = hash(0xa1), B = hash(0xb2), C = hash(0xc3), D = hash(0xd4), E = hash(0xe5), F = hash(0xf6), G = hash(0x77), H = hash(0x88);
  await build(A, "0x01", "crypticpump");
  await accrual(A, "post", WIDGET, milli(2000), milli(10)); // partner swap after graduation: 0.25% = 5e15
  await build(B, "0x02", null);
  await accrual(B, "post", WIDGET, milli(1000), milli(5)); // widget tag, no recorded build (forged tag or no partner)
  await build(C, "0x03", "crypticpump");
  await accrual(C, "bonding", WIDGET, milli(1000), milli(5)); // bonding: never a partner share
  await build(D, "0x04", "crypticpump");
  await accrual(D, "post", null, milli(1000), milli(5)); // not the widget tag: never looked up
  await build(E, "0x05", "oldie");
  await accrual(E, "post", WIDGET, milli(1000), milli(5)); // partner switched off: earns nothing on this swap
  await build(F, "0x06", "crypticpump");
  await accrual(F, "post", WIDGET, milli(1000), 7n); // capped at the protocol slice
  await build(G, "0x07", "crypticpump");
  await accrual(G, "post", WIDGET, milli(4000), milli(20)); // its RPC read fails once
  await build(H, "0x08", "crypticpump");
  await accrual(H, "post", WIDGET, milli(400), milli(2), 56); // another chain: never read for 4663

  const lookedUp: string[] = [];
  let failG = true;
  const provider = {
    async getTransaction(h: string) {
      lookedUp.push(h);
      if (h === G && failG) throw new Error("rpc timeout");
      return txs[h] ? { to: txs[h].to, data: txs[h].data, value: txs[h].value } : null;
    },
  };
  const ledger = async () => (await db.query(`select tx_hash, partner_id, partner_raw::text as raw from public.gen8_partner_fees order by accrual_id`)).rows.map((r: any) => [r.tx_hash, r.partner_id, BigInt(r.raw)]);

  await t.test("attribution: only active-partner widget swaps after graduation; a failed read stops the run and is retried", async () => {
    const first = await runGen8PartnerAttributionOnce({ db, chainId: CHAIN, hook: HOOK, provider, settleSeconds: 0 });
    assert.deepEqual(lookedUp, [A, B, E, F, G], "bonding, untagged and other-chain rows cost no RPC call");
    assert.equal(first.retry?.txHash, G);
    assert.equal(first.inserted, 2);
    assert.deepEqual(await ledger(), [[A, "crypticpump", 5n * 10n ** 15n], [F, "crypticpump", 7n]]);
    const cursorG = Number((await db.query(`select id from public.evm_gen8_fee_accruals where tx_hash = $1`, [G])).rows[0].id);
    assert.equal(first.cursorAfter, cursorG - 1, "the cursor stays before the failed transaction");
    failG = false;
    const second = await runGen8PartnerAttributionOnce({ db, chainId: CHAIN, hook: HOOK, provider, settleSeconds: 0 });
    assert.equal(second.retry, null);
    assert.equal(second.inserted, 1);
    assert.equal(second.cursorAfter, cursorG);
    const third = await runGen8PartnerAttributionOnce({ db, chainId: CHAIN, hook: HOOK, provider, settleSeconds: 0 });
    assert.equal(third.scanned, 0);
    assert.equal(third.inserted, 0);
    // A re-scan from scratch (cursor lost) inserts nothing new: ON CONFLICT DO NOTHING on (chain, tx, log).
    await db.query(`delete from public.gen8_partner_fee_cursors`);
    const rescan = await runGen8PartnerAttributionOnce({ db, chainId: CHAIN, hook: HOOK, provider, settleSeconds: 0 });
    assert.equal(rescan.attributed, 3);
    assert.equal(rescan.inserted, 0, "idempotent");
    assert.deepEqual(await ledger(), [[A, "crypticpump", 5n * 10n ** 15n], [F, "crypticpump", 7n], [G, "crypticpump", 10n ** 16n]]);
    assert.ok(!(await ledger()).some(([tx]) => tx === C), "a bonding-phase accrual never earns a partner share");
    // Settle window: a fresh accrual is not read yet.
    const I = hash(0x99);
    await build(I, "0x09", "crypticpump");
    await accrual(I, "post", WIDGET, milli(100), milli(1), CHAIN, 0);
    assert.equal((await runGen8PartnerAttributionOnce({ db, chainId: CHAIN, hook: HOOK, provider, settleSeconds: 120 })).scanned, 0);
    await db.query(`delete from public.evm_gen8_fee_accruals where tx_hash = $1`, [I]);
  });

  await t.test("no active partner on the chain: nothing is read", async () => {
    const before = lookedUp.length;
    const out = await runGen8PartnerAttributionOnce({ db, chainId: 56, hook: HOOK, provider, settleSeconds: 0 });
    assert.match(String(out.skipped), /no active partner/);
    assert.equal(lookedUp.length, before);
  });

  await t.test("the API's read-only report gives the same share for the same swaps", async () => {
    const { gen8PartnerAttribution } = await import("../../../frontend/api/lib/financeGen8.js");
    const report = await gen8PartnerAttribution({ db, chainId: CHAIN, hook: HOOK, provider });
    const ledgerTotal = (await ledger()).reduce((n, [, , raw]) => n + (raw as bigint), 0n);
    // The report does not check the active flag; without the inactive partner's swap the totals are equal.
    const inactiveShare = gen8PartnerShareRaw({ curveAmount: milli(1000), protocol: milli(5) });
    assert.equal(BigInt(report.attributedWei), ledgerTotal + inactiveShare);
    assert.equal(report.byPartner.crypticpump.partnerWei, ledgerTotal.toString());
  });

  await t.test("payout pass on the real ledger: gen8_raw recorded, room from the vault's free share, sweep reserves the rest", async () => {
    // One import fee row on the vault: fee 10 milli, creator half 5 milli (an unclaimed import, owed), ours 5 milli.
    const fee = await db.query(
      `insert into public.finance_import_swap_fees (chain_id, tx_hash, log_index, occurred_at, fee_raw, fee_asset, fee_receiver, source, creator_raw)
       values ($1, $2, 0, now(), $3, 'ETH', $4, 'evm_vault_deposit', $5) returning id`,
      [CHAIN, hash(0x1001), milli(10).toString(), VAULT, milli(5).toString()],
    );
    await db.query(
      `insert into public.import_creator_fees (fee_id, chain_id, token_address, creator_raw, occurred_at, expires_at) values ($1, $2, $3, $4, now(), now() + interval '90 days')`,
      [fee.rows[0].id, CHAIN, COIN, milli(5).toString()],
    );
    const earned = (await ledger()).reduce((n, [, , raw]) => n + (raw as bigint), 0n); // 15e15 + 7
    const vault = { balance: milli(10), paid: [] as Array<{ to: string; amount: bigint }> };
    let latest = 3;
    const mempool: Array<{ hash: string; to: string; amount: bigint; nonce: number }> = [];
    const mined = new Map<string, number>();
    const chain: ImportFeeChain = {
      async readVault() { return { balance: vault.balance, operator: OPERATOR, maxPayoutPerTx: milli(100), dailyPayoutCap: milli(1000), dailySpent: 0n, lastDay: BigInt(Math.floor(Date.now() / 86_400_000)), paused: false, chainTime: Math.floor(Date.now() / 1000) }; },
      async isPlainWallet() { return true; },
      async nonce(_a, tag) { return tag === "latest" ? latest : latest + mempool.length; },
      async signPayout({ to, amount, nonce }) { const h = hash(0x5000 + nonce); mempool.push({ hash: h, to, amount, nonce }); return { hash: h, raw: h, nonce }; },
      async broadcast() {},
      async receipt(h) { return mined.has(h) ? { status: mined.get(h)!, blockNumber: 1 } : null; },
      async known(h) { return mined.has(h) || mempool.some((m) => m.hash === h); },
      async payoutLogs() { return []; },
      async txSender() { return null; },
    };
    const mine = () => {
      for (const m of mempool.splice(0)) {
        const ok = m.amount <= vault.balance;
        if (ok) { vault.balance -= m.amount; vault.paid.push({ to: m.to.toLowerCase(), amount: m.amount }); }
        mined.set(m.hash, ok ? 1 : 0);
        latest += 1;
      }
    };
    const settings = { ...importFeeEvmSettings(CHAIN, { IMPORT_FEE_VAULT_4663: VAULT, GEN8_PARTNER_PAYOUT_SEND: "true" })!, minPartnerPayoutWei: 1n, minSweepWei: 1n, holdDays: 7 };
    const run = () => runImportCreatorFeeEvmPass({ db, chain, operator: OPERATOR, send: true, settings });

    // Room = min(10 - 5 creator, 5 ours) = 5 milli < 15 milli earned: 5 milli paid, the rest waits. Creator money stays.
    const first = await run();
    assert.equal(first.gen8?.roomWei, milli(5).toString());
    assert.deepEqual(first.partnerPayouts.map((p) => [p.partner, p.amount, p.gen8Amount]), [["crypticpump", milli(5).toString(), milli(5).toString()]]);
    const row = (await db.query(`select kind, partner_id, amount_raw::text as amount, gen8_raw::text as gen8 from public.import_fee_transfers`)).rows[0];
    assert.deepEqual(row, { kind: "partner", partner_id: "crypticpump", amount: milli(5).toString(), gen8: milli(5).toString() });
    mine();
    const second = await run();
    assert.equal(second.resolved?.landed, 1);
    assert.equal(second.partnerPayouts.length, 0);
    assert.equal(second.gen8?.roomWei, "0");
    assert.equal(second.gen8?.outstandingWei, (earned - milli(5)).toString());
    assert.equal(second.sweep, null, "nothing of ours left: the outstanding gen-8 due is reserved");
    assert.equal(vault.balance, milli(5), "the creator's half is untouched");

    // The Safe tops the vault up with the rest; recorded and verified, it is paid.
    const topUp = hash(0x7777);
    vault.balance += earned - milli(5);
    await db.query(`insert into public.gen8_partner_topups (chain_id, vault, tx_hash, amount_raw) values ($1, $2, $3, $4)`, [CHAIN, VAULT, topUp, (earned - milli(5)).toString()]);
    chain.vaultAdmin = async () => "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
    chain.vaultDeposits = async (h) => (h === topUp ? { status: 1, deposits: [{ from: "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7", amount: earned - milli(5) }] } : null);
    const third = await run();
    assert.equal((await db.query(`select status from public.gen8_partner_topups`)).rows[0].status, "verified");
    assert.deepEqual(third.partnerPayouts.map((p) => [p.amount, p.gen8Amount]), [[(earned - milli(5)).toString(), (earned - milli(5)).toString()]]);
    mine();
    const fourth = await run();
    assert.equal(fourth.partnerPayouts.length, 0);
    assert.equal(fourth.sweep, null);
    assert.equal(vault.paid.reduce((n, p) => n + p.amount, 0n), earned, "the partner got exactly what the ledger says");
    assert.equal(vault.balance, milli(5), "the creator's half is still there");
    // Report: earned / paid / due from the ledger.
    const { buildGen8Finance } = await import("../../../frontend/api/lib/financeGen8.js");
    const report = await buildGen8Finance({ db, chainId: CHAIN, env: { EVM_GEN8_LAUNCHER_4663: `${ROUTER}@1`, EVM_GEN8_HOOK_4663: `${HOOK}@1` } });
    assert.equal(report.partner.ledger?.available, true);
    assert.equal(report.partner.attributedWei, earned.toString());
    assert.equal(report.partner.byPartner.crypticpump.paidWei, earned.toString());
    assert.equal(report.partner.byPartner.crypticpump.dueWei, "0");
  });
});
