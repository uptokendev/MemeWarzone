/**
 * healRobinhoodGraduatedCms itself refuses factory_generation = 8 before any RPC.
 * Callers already skip those rows. A direct call must do the same.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { ethers } from "ethers";
import { gen8SchemaFiles } from "./gen8/gen8TestDb.js";

const PG16 = "/usr/lib/postgresql/16/bin";
const runnable = fs.existsSync(`${PG16}/initdb`);

test("gen-8 campaign is refused inside the RH heal before any RPC", { skip: runnable ? false : "Postgres 16 missing", timeout: 120_000 }, async () => {
  process.env.DBC_PG_BIN = PG16;
  process.env.PG_DISABLE_SSL = "1";
  process.env.RUNTIME_ENVIRONMENT = "local";
  process.env.LOCAL_DISABLE_ABLY = "1";
  const { startThrowawayPostgres } = await import("../../../scripts/dbc/throwaway-postgres.mjs");
  const pg = await startThrowawayPostgres({ port: 55465, extraFiles: gen8SchemaFiles() });
  process.env.DATABASE_URL = pg.url;
  const token = `0x${"31".repeat(20)}`;
  const other = `0x${"32".repeat(20)}`;
  const creator = `0x${"33".repeat(20)}`;
  try {
    await pg.pool.query(
      `insert into public.campaigns (chain_id, campaign_address, token_address, creator_address, name, symbol, created_block, created_at_chain, factory_generation)
       values (46630, $1, $1, $3, 'Eight', 'E', 1, now(), 8),
              (46630, $2, $2, $3, 'Six', 'S', 1, now(), 6)`,
      [token, other, creator],
    );
    const { healRobinhoodGraduatedCms } = await import("../robinhoodCmsHeal.js");
    const provider = new ethers.JsonRpcProvider("http://127.0.0.1:9", 46630, { staticNetwork: true });
    const refused = await healRobinhoodGraduatedCms(provider, 46630, ethers.getAddress(token), ethers.getAddress(token));
    assert.deepEqual(refused, { healed: false, reason: "gen8" });

    const continued = await healRobinhoodGraduatedCms(provider, 46630, other, other);
    assert.equal(continued.healed, false);
    assert.notEqual(continued.reason, "gen8");
    assert.match(String(continued.reason), /^rpc_read_failed:/);
    const { pool } = await import("../db.js");
    await pool.end();
  } finally {
    await pg.stop();
  }
});
