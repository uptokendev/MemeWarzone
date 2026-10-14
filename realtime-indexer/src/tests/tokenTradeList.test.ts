/**
 * Chains with no gen-8 launcher run the curve_trades query once. A configured chain looks the pool up by the
 * stored lowercase token address, then unions that coin's gen-8 dex rows with a limit on each side.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import {
  CURVE_TRADE_LIST_SQL,
  GEN8_POOL_LOOKUP_SQL,
  GEN8_TRADE_LIST_SQL,
  queryTokenTrades,
  type TradeListDb,
} from "../tokenTradeList.js";

const launcher = `0x${"ab".repeat(20)}`;

function recordingDb(rows: unknown[] = []): { db: TradeListDb; calls: { sql: string; params: unknown[] | undefined }[] } {
  const calls: { sql: string; params: unknown[] | undefined }[] = [];
  return {
    calls,
    db: {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        return { rows, rowCount: rows.length };
      },
    },
  };
}

test("no gen-8 chain = one query", async () => {
  const env = { ...process.env };
  delete env.EVM_GEN8_LAUNCHER_101;
  delete env.EVM_GEN8_HOOK_101;
  delete env.EVM_GEN8_LAUNCHER_56;
  delete env.EVM_GEN8_HOOK_56;
  const mint = "SoLanaMintCaseSensitive111";
  for (const [chainId, campaign] of [[101, mint], [56, `0x${"12".repeat(20)}`]] as const) {
    const { db, calls } = recordingDb([{ tx_hash: "kept" }]);
    const result = await queryTokenTrades(db, chainId, campaign, 20, env);
    assert.equal(calls.length, 1, `chain ${chainId}`);
    assert.equal(calls[0].sql, CURVE_TRADE_LIST_SQL);
    assert.deepEqual(calls[0].params, [chainId, campaign, 20]);
    assert.equal(result.rows[0].tx_hash, "kept");
  }
});

test("a configured gen-8 chain looks up the stored lowercase token, then limits each half of the union", async () => {
  const env = {
    ...process.env,
    EVM_GEN8_LAUNCHER_46630: `${launcher}@1`,
    EVM_GEN8_HOOK_46630: `${launcher}@1`,
    EVM_GEN8_POOL_MANAGER_46630: launcher,
  };
  const checksum = ethers.getAddress(`0x${"11".repeat(20)}`);
  const { db, calls } = recordingDb([]);
  await queryTokenTrades(db, 46630, checksum, 20, env);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].sql, GEN8_POOL_LOOKUP_SQL);
  assert.equal(calls[0].sql.includes("lower("), false);
  assert.deepEqual(calls[0].params, [46630, checksum.toLowerCase()]);
  assert.equal(calls[1].sql, CURVE_TRADE_LIST_SQL);
  assert.deepEqual(calls[1].params, [46630, checksum, 20]);

  const pooled = recordingDb([{ one: 1 }]);
  await queryTokenTrades(pooled.db, 46630, checksum, 20, env);
  assert.equal(pooled.calls[1].sql, GEN8_TRADE_LIST_SQL);
  const halves = GEN8_TRADE_LIST_SQL.split("union all");
  assert.equal(halves.length, 2);
  assert.match(halves[0], /order by block_number desc, log_index desc\s+limit \$3/);
  assert.match(halves[1], /order by block_number desc, log_index desc\s+limit \$3/);
});
