import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createPartner, normalizePayoutWallet, parsePartnerCreate, parsePartnerUpdate, updatePartner } from "./importFeePartnersAdmin.js";

const SOL = Keypair.generate().publicKey.toBase58();
const PDA = PublicKey.findProgramAddressSync([Buffer.from("x")], new PublicKey("11111111111111111111111111111111"))[0].toBase58();
const actor = { id: "u1", email: "ops@memewar.zone" };

test("create: defaults to creator 50% / partner 25%, id lowercased, fingerprints (no fee account)", () => {
  const p = parsePartnerCreate({ id: "CrypticPump", chainId: 101, name: "CrypticPump", payoutWallet: SOL });
  assert.deepEqual(p, { id: "crypticpump", chainId: 101, name: "CrypticPump", payoutWallet: SOL, creatorBps: 5000, partnerBps: 2500, active: true });
});

test("create refuses bad ids, chains, wallets and splits over 100%", () => {
  assert.throws(() => parsePartnerCreate({ id: "a", chainId: 101, name: "x", payoutWallet: SOL }), /Partner id/);
  assert.throws(() => parsePartnerCreate({ id: "ok-id", chainId: 1, name: "x", payoutWallet: SOL }), /Chain/);
  assert.throws(() => parsePartnerCreate({ id: "ok-id", chainId: 101, name: "x", payoutWallet: PDA }), /Solana wallet/, "off-curve (program-owned) address");
  assert.throws(() => parsePartnerCreate({ id: "ok-id", chainId: 56, name: "x", payoutWallet: SOL }), /0x address/);
  assert.throws(() => parsePartnerCreate({ id: "ok-id", chainId: 56, name: "x", payoutWallet: "0x" + "0".repeat(40) }), /0x address/);
  assert.throws(() => parsePartnerCreate({ id: "ok-id", chainId: 101, name: "x", payoutWallet: SOL, creatorBps: 8000, partnerBps: 2500 }), /100%/);
  assert.throws(() => parsePartnerCreate({ id: "ok-id", chainId: 101, name: "x", payoutWallet: SOL, creatorBps: 50.5 }), /basis points/);
  assert.equal(normalizePayoutWallet(56, "0xAbCdEf0000000000000000000000000000000001"), "0xabcdef0000000000000000000000000000000001");
});

test("update: only given fields, split checked against the current row, nothing to change refused", () => {
  const current = { chain_id: 101, creator_bps: 5000, partner_bps: 2500 };
  assert.deepEqual(parsePartnerUpdate({ active: false }, current), { active: false });
  assert.throws(() => parsePartnerUpdate({ partnerBps: 6000 }, current), /100%/);
  assert.throws(() => parsePartnerUpdate({}, current), /Nothing to change/);
  assert.throws(() => parsePartnerUpdate({ active: "no" }, current), /true or false/);
});

function fakeDb(existing = null) {
  const calls = [];
  const db = {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      const s = calls.at(-1).sql;
      if (s.startsWith("insert into public.import_fee_partners")) return { rows: existing ? [] : [{ id: params[0], chain_id: params[1], name: params[2], fee_account: null, payout_wallet: params[3], creator_bps: params[4], partner_bps: params[5], active: params[6] }] };
      if (s.startsWith("select id, chain_id")) return { rows: existing ? [existing] : [] };
      if (s.startsWith("update public.import_fee_partners")) return { rows: [{ ...existing, active: params[2], updated_at: new Date() }] };
      return { rows: [], rowCount: 1 };
    },
  };
  return db;
}

test("create and update write the audit row inside the same transaction", async () => {
  const db = fakeDb();
  await createPartner(db, { id: "crypticpump", chainId: 101, name: "CrypticPump", payoutWallet: SOL }, actor);
  const sql = db.calls.map((c) => c.sql);
  assert.equal(sql[0], "begin");
  assert.ok(sql.findIndex((x) => x.startsWith("insert into public.import_fee_partner_audit")) < sql.indexOf("commit"));
  const auditCall = db.calls.find((c) => c.sql.startsWith("insert into public.import_fee_partner_audit"));
  assert.equal(auditCall.params[1], "ops@memewar.zone");
  assert.equal(auditCall.params[2], "create");

  const row = { id: "crypticpump", chain_id: 101, name: "CrypticPump", fee_account: null, payout_wallet: SOL, creator_bps: 5000, partner_bps: 2500, active: true };
  const db2 = fakeDb(row);
  const updated = await updatePartner(db2, { id: "crypticpump", chainId: "101", body: { active: false } }, actor);
  assert.equal(updated.active, false);
  const upd = db2.calls.find((c) => c.sql.startsWith("update public.import_fee_partners"));
  assert.match(upd.sql, /set active = \$3, updated_at = now\(\) where id = \$1 and chain_id = \$2/);
  const audit2 = db2.calls.find((c) => c.sql.startsWith("insert into public.import_fee_partner_audit"));
  assert.equal(JSON.parse(audit2.params[5]).active, true);
  assert.equal(JSON.parse(audit2.params[6]).active, false);
});

test("a duplicate partner is a 409, an unknown one a 404", async () => {
  await assert.rejects(createPartner(fakeDb({}), { id: "crypticpump", chainId: 101, name: "C", payoutWallet: SOL }, actor), (e) => e.status === 409);
  await assert.rejects(updatePartner(fakeDb(null), { id: "nobody", chainId: 101, body: { active: false } }, actor), (e) => e.status === 404);
});
