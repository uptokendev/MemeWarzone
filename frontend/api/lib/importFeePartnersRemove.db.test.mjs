// Partner removal and the `removable` flag against a throwaway Postgres: the real migrations for the partner, audit,
// fee, transfer and fingerprint tables, one test per kind of history, the success path with its audit row, and the
// 503 when the audit CHECK is still the old one.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

process.env.DBC_THROWAY_PG_PORT ||= "55498";
const { startThrowawayPostgres } = await import("../../../scripts/dbc/throwaway-postgres.mjs");
const pg = await startThrowawayPostgres();
const db = pg.pool;
test.after(async () => {
  await pg.stop();
});

const migration = (name) => fs.readFileSync(fileURLToPath(new URL(`../../../db/migrations/${name}`, import.meta.url)), "utf8");
const { listPartners, removePartner } = await import("./importFeePartnersAdmin.js");
const actor = { id: "u1", email: "ops@memewar.zone" };
const W = "0x" + "44".repeat(20);

for (const name of [
  "20261006_000002_finance_import_swap_fees.sql",
  "20261008_000020_import_creator_fees.sql",
  "20261009_000010_import_fee_partners.sql",
  "20261010_000010_import_fee_partner_audit.sql",
]) {
  await db.query(migration(name));
}
await db.query(migration("20261023_000010_import_fee_partner_audit_delete.sql"));

async function addPartner(id, chainId = 56) {
  await db.query(
    `insert into public.import_fee_partners (id, chain_id, name, payout_wallet, creator_bps, partner_bps, active) values ($1, $2, $3, $4, 5000, 2500, true)`,
    [id, chainId, `Name ${id}`, W],
  );
}
const exists = async (id, chainId = 56) => (await db.query(`select 1 from public.import_fee_partners where id = $1 and chain_id = $2`, [id, chainId])).rowCount === 1;
const removableOf = async (id, chainId = 56) => (await listPartners(db)).find((p) => p.id === id && p.chainId === chainId)?.removable;

test("removable is true only without history; a clean partner is removed and audited with action delete", async () => {
  await addPartner("clean-one");
  assert.equal(await removableOf("clean-one"), true);
  const removed = await removePartner(db, { id: "clean-one", chainId: 56 }, actor);
  assert.equal(removed.id, "clean-one");
  assert.equal(await exists("clean-one"), false);
  const { rows } = await db.query(`select action, actor_email, before, after from public.import_fee_partner_audit where partner_id = 'clean-one' and chain_id = 56`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, "delete");
  assert.equal(rows[0].actor_email, "ops@memewar.zone");
  assert.equal(rows[0].before.id, "clean-one");
  assert.equal(rows[0].after, null);
});

test("unknown partner is a 404", async () => {
  await assert.rejects(removePartner(db, { id: "nobody-here", chainId: 56 }, actor), (e) => e.status === 404 && e.code === "PARTNER_NOT_FOUND");
});

async function swapFeeRow(id, chainId) {
  const cols = (await db.query(`select column_name, is_nullable, column_default, data_type from information_schema.columns where table_schema = 'public' and table_name = 'finance_import_swap_fees'`)).rows;
  return cols;
}

async function insertHistory(kind, id) {
  if (kind === "swaps") {
    const required = (await swapFeeRow()).filter((c) => c.is_nullable === "NO" && c.column_default === null);
    const values = { chain_id: 56, partner_id: id, fee_asset: "BNB", source: "evm_vault_deposit" };
    const cols = required.map((c) => c.column_name);
    for (const c of ["chain_id", "partner_id", "fee_asset", "source"]) if (!cols.includes(c)) cols.push(c);
    const vals = cols.map((c) => {
      if (c in values) return values[c];
      const t = required.find((r) => r.column_name === c).data_type;
      if (t === "timestamp with time zone") return new Date();
      if (t === "numeric" || t === "integer" || t === "bigint") return 1;
      if (t === "boolean") return false;
      return `v-${c}`.slice(0, 20);
    });
    await db.query(`insert into public.finance_import_swap_fees (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
  } else if (kind === "transfers") {
    await db.query("alter table public.import_fee_transfers disable trigger all");
    const required = (await db.query(`select column_name, is_nullable, column_default, data_type from information_schema.columns where table_schema = 'public' and table_name = 'import_fee_transfers'`)).rows.filter((c) => c.is_nullable === "NO" && c.column_default === null);
    const values = { chain_id: 56, partner_id: id, kind: "partner", status: "landed" };
    const cols = required.map((c) => c.column_name);
    for (const c of ["chain_id", "partner_id", "kind"]) if (!cols.includes(c)) cols.push(c);
    const vals = cols.map((c) => {
      if (c in values) return values[c];
      const t = required.find((r) => r.column_name === c).data_type;
      if (t === "timestamp with time zone") return new Date();
      if (t === "numeric" || t === "integer" || t === "bigint") return 1;
      return `0x${"ab".repeat(20)}`;
    });
    await db.query(`insert into public.import_fee_transfers (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
  } else if (kind === "fingerprints") {
    await db.query(`insert into public.import_swap_fingerprints (fingerprint, chain_id, partner_id) values ($1, 56, $2)`, [`fp-${id}-0123456789abcdef`, id]);
  } else if (kind === "gen8") {
    await db.query(`insert into public.gen8_partner_fees (chain_id, partner_id) values (56, $1)`, [id]);
  }
}

for (const [kind, word] of [["swaps", /1 swap/], ["transfers", /1 payout/], ["fingerprints", /1 widget swap record/]]) {
  test(`history in ${kind} blocks removal with 409 PARTNER_HAS_HISTORY and keeps the row`, async () => {
    const id = `hist-${kind}`;
    await addPartner(id);
    await insertHistory(kind, id);
    assert.equal(await removableOf(id), false);
    await assert.rejects(removePartner(db, { id, chainId: 56 }, actor), (e) => e.status === 409 && e.code === "PARTNER_HAS_HISTORY" && word.test(e.message));
    assert.equal(await exists(id), true);
    assert.equal((await db.query(`select 1 from public.import_fee_partner_audit where partner_id = $1`, [id])).rowCount, 0);
  });
}

test("history on another chain does not block", async () => {
  await addPartner("two-chains", 56);
  await addPartner("two-chains", 4663);
  await insertHistory("fingerprints", "two-chains");
  assert.equal(await removableOf("two-chains", 56), false);
  assert.equal(await removableOf("two-chains", 4663), true);
  await removePartner(db, { id: "two-chains", chainId: 4663 }, actor);
  assert.equal(await exists("two-chains", 4663), false);
  assert.equal(await exists("two-chains", 56), true);
});

test("gen8_partner_fees: missing table counts as no rows; present table with a row blocks", async () => {
  await addPartner("gen8-case");
  assert.equal(await removableOf("gen8-case"), true, "no gen8 table");
  await db.query(`create table public.gen8_partner_fees (id bigserial primary key, chain_id integer not null, partner_id text not null, partner_raw numeric default 1)`);
  await db.query(`alter table public.import_fee_transfers add column if not exists gen8_raw numeric(78,0) not null default 0`);
  assert.equal(await removableOf("gen8-case"), true);
  await db.query(`insert into public.gen8_partner_fees (chain_id, partner_id) values (56, 'gen8-case')`);
  assert.equal(await removableOf("gen8-case"), false);
  await assert.rejects(removePartner(db, { id: "gen8-case", chainId: 56 }, actor), (e) => e.status === 409 && /gen-8 fee/.test(e.message));
});

test("old audit CHECK: 503 with the SQL file name, and the partner is NOT deleted", async () => {
  await addPartner("old-check");
  await db.query(`delete from public.import_fee_partner_audit where action = 'delete'`);
  await db.query(`alter table public.import_fee_partner_audit drop constraint if exists import_fee_partner_audit_action_check`);
  await db.query(`alter table public.import_fee_partner_audit add constraint import_fee_partner_audit_action_check check (action in ('create', 'update'))`);
  await assert.rejects(removePartner(db, { id: "old-check", chainId: 56 }, actor), (e) => e.status === 503 && /prod_apply_import_fee_partner_audit_delete\.sql/.test(e.message));
  assert.equal(await exists("old-check"), true);
});

test("the delete migration widens the CHECK, twice in a row, and then the removal works", async () => {
  const sql = migration("20261023_000010_import_fee_partner_audit_delete.sql");
  await db.query(sql);
  await db.query(sql);
  const defs = (await db.query(`select pg_get_constraintdef(oid) as d from pg_constraint where conrelid = 'public.import_fee_partner_audit'::regclass and contype = 'c'`)).rows;
  assert.equal(defs.length, 1);
  assert.match(defs[0].d, /delete/);
  await removePartner(db, { id: "old-check", chainId: 56 }, actor);
  assert.equal(await exists("old-check"), false);
});
