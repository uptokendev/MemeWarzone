import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const url = String(process.env.DATABASE_URL || process.env.PG_TEST_URL || "").trim();
const skip = !url;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("lease SQL migration is present", () => {
  const sql = fs.readFileSync(path.join(root, "db/migrations/20260821_000003_solana_worker_leases.sql"), "utf8");
  assert.match(sql, /solana_worker_leases/);
  assert.match(sql, /lease_expires_at/);
  assert.match(sql, /owner_id/);
  assert.match(sql, /graduation_requested/);
  assert.match(sql, /solana_trade_authorizations/);
});

test("sponsorship admin RLS migration revokes browser writes", () => {
  const sql = fs.readFileSync(path.join(root, "db/migrations/20260821_000005_sponsorship_admin_rls.sql"), "utf8");
  assert.match(sql, /sponsorship_applications/);
  assert.match(sql, /sponsored_placements/);
  assert.match(sql, /sponsorship_settings/);
  assert.match(sql, /REVOKE INSERT, UPDATE, DELETE/);
});

async function withClient(fn) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

test("two workers cannot steal a live lease; expired lease is takeable", { skip }, async () => {
  await withClient(async (client) => {
    await client.query("begin");
    try {
      await client.query(`
        create temporary table solana_worker_leases (
          worker_name text primary key,
          owner_id text not null,
          lease_expires_at timestamptz not null,
          heartbeat_at timestamptz not null
        ) on commit drop
      `);
      const acquire = async (owner) => {
        const r = await client.query(
          `insert into solana_worker_leases (worker_name, owner_id, lease_expires_at, heartbeat_at)
           values ('solana-fee-escrow-worker', $1, now() + interval '60 seconds', now())
           on conflict (worker_name) do update set
             owner_id = excluded.owner_id,
             lease_expires_at = excluded.lease_expires_at,
             heartbeat_at = now()
           where solana_worker_leases.lease_expires_at < now()
              or solana_worker_leases.owner_id = excluded.owner_id
           returning owner_id`,
          [owner],
        );
        return r.rows[0]?.owner_id || null;
      };
      assert.equal(await acquire("A"), "A");
      assert.equal(await acquire("B"), null);
      assert.equal(await acquire("A"), "A");
      await client.query(`update solana_worker_leases set lease_expires_at = now() - interval '1 second'`);
      assert.equal(await acquire("B"), "B");
      assert.equal(await acquire("A"), null);
    } finally {
      await client.query("rollback");
    }
  });
});
