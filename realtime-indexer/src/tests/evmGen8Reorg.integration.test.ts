/**
 * F10 (audit C-M5): a reorg on a LOCAL chain (anvil_reorg) never reaches the gen-8 tables. anvil answers `finalized`
 * with latest - 64 and `safe` with latest - 32, so the default head tag of chain 97 (finalized) keeps the indexer 64
 * blocks behind. A linked wallet's buy is mined, seen at the head, then reorganised away and replaced by another
 * wallet's buy; after the replacement is final, only the replacement is in curve_trades, the accruals and
 * reward_events (no phantom League row, no phantom recruiter credit).
 * Skips when the gen-8 artifacts, anvil or Postgres 16 are missing (same requirements as evmGen8.integration.test.ts).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { ethers } from "ethers";
import { artifactsAvailable, deployGen8Local, launchCoin, startAnvil, swap, WAD } from "./gen8/gen8LocalChain.js";
import { gen8SchemaFiles } from "./gen8/gen8TestDb.js";

const PG16 = "/usr/lib/postgresql/16/bin";
const runnable = artifactsAvailable() && fs.existsSync(`${PG16}/initdb`);

test("gen-8 indexer ingests only finalized blocks: a reorganised trade leaves no trace", { skip: runnable ? false : "gen-8 artifacts, anvil or Postgres 16 missing", timeout: 600_000 }, async () => {
  process.env.DBC_PG_BIN = PG16;
  process.env.RUNTIME_ENVIRONMENT = "local";
  process.env.PG_DISABLE_SSL = "1";
  const { startThrowawayPostgres } = await import("../../../scripts/dbc/throwaway-postgres.mjs");
  const pg = await startThrowawayPostgres({ port: 55463, extraFiles: gen8SchemaFiles() });
  const anvil = await startAnvil(8774, 97);
  try {
    process.env.DATABASE_URL = pg.url;
    process.env.BSC_RPC_HTTP_97 = anvil.url;
    const provider = new ethers.JsonRpcProvider(anvil.url, 97, { staticNetwork: true, cacheTimeout: -1 });
    const env = await deployGen8Local(provider, { display: false });
    const startBlock = await provider.getBlockNumber();
    const A = { launcher: (await env.launcher.getAddress()).toLowerCase(), hook: (await env.hook.getAddress()).toLowerCase(), pm: (await env.pm.getAddress()).toLowerCase() };
    const genv: NodeJS.ProcessEnv = {
      ...process.env,
      EVM_GEN8_LAUNCHER_97: `${A.launcher}@${startBlock}`, EVM_GEN8_HOOK_97: `${A.hook}@${startBlock}`, EVM_GEN8_POOL_MANAGER_97: A.pm,
      EVM_GEN8_LOG_CHUNK: "5000", EVM_GEN8_LINK_ROUTERS_97: (await env.trader.getAddress()).toLowerCase(),
      // no EVM_GEN8_HEAD_TAG: chain 97 defaults to `finalized`
    };
    const db = pg.pool;
    const rec = await db.query(`insert into public.recruiters(wallet_address, code, is_og) values ($1, 'REORG', false) returning id`, [env.other.address.toLowerCase()]);
    await db.query(`insert into public.wallet_recruiter_links(wallet_address, recruiter_id, linked_at) values ($1, $2, now() - interval '1 day')`, [env.linked.address.toLowerCase(), rec.rows[0].id]);

    const { evmGen8Config, gen8HeadTag } = await import("../evm/evmGen8Config.js");
    const { defaultGen8Sinks, runGen8ChainOnce, gen8Cursor } = await import("../evm/evmGen8Pool.js");
    const { GEN8_TOPICS } = await import("../evm/evmGen8Abi.js");
    const cfg = evmGen8Config(97, genv).config!;
    assert.equal(gen8HeadTag(97, genv), "finalized");
    const sinks = await defaultGen8Sinks(db);
    const ctx = { cfg, db, provider: provider as any, sinks, env: genv };
    const catchUp = async () => {
      for (let i = 0; i < 50; i += 1) if (!(await runGen8ChainOnce(ctx))) break;
    };
    const mine = (n: number) => provider.send("anvil_mine", [ethers.toQuantity(n)]);
    const cursorBlock = async () => Number((await db.query(`select last_indexed_block from public.indexer_state where chain_id = 97 and cursor = $1`, [gen8Cursor(cfg)])).rows[0]?.last_indexed_block ?? 0);

    // Launch, then let it become final: the pool is known to the indexer.
    const coin = await launchCoin(env, env.creator, { name: "Reorg", symbol: "RORG" });
    await provider.send("evm_increaseTime", [120]);
    await mine(70);
    await catchUp();
    assert.equal((await db.query(`select count(*)::int as n from public.evm_gen8_pools where chain_id = 97`)).rows[0].n, 1, "launch indexed once final");

    // A linked wallet buys. The block is at the head, not final: the indexer does not read it.
    const phantom = await swap(env, coin, env.linked, { buy: true, exactIn: true, amount: WAD / 50n });
    const atHead = await provider.getLogs({ address: A.pm, topics: [GEN8_TOPICS.Swap, coin.id], fromBlock: phantom.blockNumber, toBlock: phantom.blockNumber });
    assert.equal(atHead.length, 1, "the swap is on the chain at the head");
    await catchUp();
    const finalizedNow = Number((await provider.getBlock("finalized"))!.number);
    assert.ok((await cursorBlock()) <= finalizedNow + 1, "the cursor never passes the finalized block");
    assert.equal((await db.query(`select count(*)::int as n from public.curve_trades where chain_id = 97`)).rows[0].n, 0, "a non-final trade is not ingested");

    // Reorg: the blocks from the phantom buy on are replaced; another wallet buys on the new branch.
    const depth = (await provider.getBlockNumber()) - phantom.blockNumber + 1;
    await provider.send("anvil_reorg", [depth, []]);
    assert.equal(await provider.getTransactionReceipt(phantom.hash), null, "the phantom buy is gone from the canonical chain");
    const real = await swap(env, coin, env.buyer, { buy: true, exactIn: true, amount: WAD / 70n });
    await mine(70);
    await catchUp();

    const curve = (await db.query(`select tx_hash, wallet from public.curve_trades where chain_id = 97`)).rows;
    assert.deepEqual(curve.map((r) => r.tx_hash), [real.hash.toLowerCase()], "only the canonical trade is in curve_trades");
    assert.equal(curve[0].wallet, env.buyer.address.toLowerCase());
    const acc = (await db.query(`select tx_hash, profile, recruiter from public.evm_gen8_fee_accruals where chain_id = 97`)).rows;
    assert.ok(acc.every((a) => a.tx_hash !== phantom.hash.toLowerCase()), "no accrual for the phantom trade");
    assert.ok(acc.every((a) => a.recruiter === "0"), "no phantom recruiter credit");
    const re = (await db.query(`select tx_hash, wallet_address from public.reward_events where chain_id = 97`)).rows;
    assert.ok(re.length >= 1, "the canonical trade has its reward_events row");
    assert.ok(re.every((r) => r.tx_hash !== phantom.hash.toLowerCase() && r.wallet_address !== env.linked.address.toLowerCase()), "no reward_events row for the phantom trade");
    provider.destroy();
  } finally {
    await anvil.stop();
    await pg.stop();
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
  }
});
