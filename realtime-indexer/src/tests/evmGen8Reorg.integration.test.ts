/**
 * F10 (audit C-M5), hybrid mode (founder 2026-10-12): on a LOCAL chain (anvil_reorg) a trade at the head shows up in
 * the display tables, disappears again when the chain drops it, and never reaches the money tables; the trade that
 * replaces it reaches the money tables only once it is final.
 * anvil answers `finalized` with latest - 64 and `safe` with latest - 32. Chain 97 defaults: display `finalized`,
 * money `finalized`; here the display tag is set to `latest` (as on Robinhood) and the money tag stays `finalized`.
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

test("gen-8 hybrid ingestion: a reorganised trade leaves the display tables and never reaches the money tables", { skip: runnable ? false : "gen-8 artifacts, anvil or Postgres 16 missing", timeout: 600_000 }, async () => {
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
      EVM_GEN8_DISPLAY_HEAD_TAG_97: "latest", EVM_GEN8_CONFIRMATIONS: "0",
      // no EVM_GEN8_MONEY_HEAD_TAG: chain 97 defaults to `finalized`
    };
    const db = pg.pool;
    const rec = await db.query(`insert into public.recruiters(wallet_address, code, is_og) values ($1, 'REORG', false) returning id`, [env.other.address.toLowerCase()]);
    await db.query(`insert into public.wallet_recruiter_links(wallet_address, recruiter_id, linked_at) values ($1, $2, now() - interval '1 day')`, [env.linked.address.toLowerCase(), rec.rows[0].id]);

    const { evmGen8Config, gen8DisplayHeadTag, gen8MoneyHeadTag } = await import("../evm/evmGen8Config.js");
    const { defaultGen8Sinks, runGen8ChainOnce, gen8Cursor, gen8MoneyCursor } = await import("../evm/evmGen8Pool.js");
    const cfg = evmGen8Config(97, genv).config!;
    assert.equal(gen8DisplayHeadTag(97, genv), "latest");
    assert.equal(gen8MoneyHeadTag(97, genv), "finalized");
    const sinks = await defaultGen8Sinks(db);
    const ctx = { cfg, db, provider: provider as any, sinks, env: genv };
    const passes: any[] = [];
    const catchUp = async () => {
      for (let i = 0; i < 50; i += 1) {
        const r = await runGen8ChainOnce(ctx);
        if (!r) break;
        passes.push(r);
      }
    };
    const mine = (n: number) => provider.send("anvil_mine", [ethers.toQuantity(n)]);
    const cursor = async (name: string) => Number((await db.query(`select last_indexed_block from public.indexer_state where chain_id = 97 and cursor = $1`, [name])).rows[0]?.last_indexed_block ?? 0);
    const count = async (sql: string, params: unknown[] = []) => Number((await db.query(sql, params)).rows[0].n);
    const curveRows = () => db.query(`select tx_hash, wallet from public.curve_trades where chain_id = 97 order by block_number, log_index`);
    const accrualRows = () => db.query(`select tx_hash, trader, profile, recruiter from public.evm_gen8_fee_accruals where chain_id = 97 and kind = 'trade' order by block_number, log_index`);

    // ---- launch (creator first buy included), then let it become final
    const coin = await launchCoin(env, env.creator, { firstBuyValue: WAD / 1000n, name: "Reorg", symbol: "RORG" });
    await provider.send("evm_increaseTime", [120]);
    await catchUp();
    assert.equal(await count(`select count(*)::int as n from public.evm_gen8_pools where chain_id = 97`), 1, "display: the launch is visible at the head");
    assert.equal(await count(`select count(*)::int as n from public.curve_trades where chain_id = 97`), 1, "display: the first buy is visible at the head");
    assert.equal(await count(`select count(*)::int as n from public.evm_gen8_fee_accruals where chain_id = 97`), 0, "money: nothing before the block is final");
    await mine(70);
    await catchUp();
    assert.equal(await count(`select count(*)::int as n from public.evm_gen8_fee_accruals where chain_id = 97`), 1, "money: the first buy once final");
    assert.ok((await cursor(gen8MoneyCursor(cfg))) <= Number((await provider.getBlock("finalized"))!.number) + 1, "the money cursor never passes the finalized block");
    assert.ok((await cursor(gen8Cursor(cfg))) > (await cursor(gen8MoneyCursor(cfg))), "the display cursor runs ahead of the money cursor");

    // ---- a linked wallet buys at the head: display row yes, money row no
    const phantom = await swap(env, coin, env.linked, { buy: true, exactIn: true, amount: WAD / 50n });
    await catchUp();
    let curve = (await curveRows()).rows;
    assert.deepEqual(curve.map((r) => r.tx_hash).slice(1), [phantom.hash.toLowerCase()], "display: the buy is in curve_trades at the head");
    assert.equal(await count(`select count(*)::int as n from public.token_candles where chain_id = 97 and campaign_address = $1 and timeframe = '1m'`, [coin.token.toLowerCase()]) >= 1, true);
    const candlesBefore = await count(`select coalesce(sum(trades_count), 0)::int as n from public.token_candles where chain_id = 97 and campaign_address = $1 and timeframe = '1m'`, [coin.token.toLowerCase()]);
    assert.equal(candlesBefore, 2, "display: first buy + the phantom buy in the 1m candles");
    assert.equal((await accrualRows()).rows.length, 1, "money: the buy at the head has no accrual row");
    const statsPhantom = (await db.query(`select last_price_bnb from public.token_stats where chain_id = 97 and campaign_address = $1`, [coin.token.toLowerCase()])).rows[0];

    // ---- the chain drops it: another wallet's buy replaces it on the new branch
    const depth = (await provider.getBlockNumber()) - phantom.blockNumber + 1;
    await provider.send("anvil_reorg", [depth, []]);
    assert.equal(await provider.getTransactionReceipt(phantom.hash), null, "the phantom buy is gone from the canonical chain");
    const real = await swap(env, coin, env.buyer, { buy: true, exactIn: true, amount: WAD / 70n });
    await catchUp();
    const withReorg = passes.find((p) => p.reorg);
    assert.ok(withReorg, "the display pass detected the reorg at its tip");
    assert.equal(withReorg.reorg.deep, false, "the common ancestor was found among the stored blocks");
    curve = (await curveRows()).rows;
    assert.deepEqual(curve.map((r) => r.tx_hash).slice(1), [real.hash.toLowerCase()], "display: the phantom buy is gone, the replacement is in");
    assert.equal(curve[1]!.wallet, env.buyer.address.toLowerCase());
    assert.equal(await count(`select count(*)::int as n from public.evm_gen8_swaps where chain_id = 97 and tx_hash = $1`, [phantom.hash.toLowerCase()]), 0);
    assert.equal(await count(`select count(*)::int as n from public.activity_events where chain_id = 97 and tx_hash = $1`, [phantom.hash.toLowerCase()]), 0, "the phantom activity row is gone");
    const candlesAfter = await count(`select coalesce(sum(trades_count), 0)::int as n from public.token_candles where chain_id = 97 and campaign_address = $1 and timeframe = '1m'`, [coin.token.toLowerCase()]);
    assert.equal(candlesAfter, 2, "candles rebuilt: first buy + the replacement, the phantom's count is gone");
    const statsReal = (await db.query(`select last_price_bnb from public.token_stats where chain_id = 97 and campaign_address = $1`, [coin.token.toLowerCase()])).rows[0];
    assert.notEqual(String(statsReal.last_price_bnb), String(statsPhantom.last_price_bnb), "token_stats restated from the surviving trade");
    const alerts = (await db.query(`select metadata->>'kind' as kind from public.reward_alerts`)).rows.map((r) => r.kind);
    assert.ok(alerts.includes("gen8_reorg"), `reorg alerted: ${alerts.join(",")}`);
    assert.ok(!alerts.includes("gen8_reorg_past_money_tag"));
    assert.equal((await accrualRows()).rows.length, 1, "money: still only the first buy (the replacement is not final yet)");

    // ---- the replacement becomes final: money row for it, never for the phantom
    await mine(70);
    await catchUp();
    const acc = (await accrualRows()).rows;
    assert.deepEqual(acc.map((a) => a.tx_hash).slice(1), [real.hash.toLowerCase()], "money: exactly the surviving trade");
    assert.ok(acc.every((a) => a.recruiter === "0"), "no phantom recruiter credit (the linked wallet's buy never existed)");
    const re = (await db.query(`select tx_hash, wallet_address from public.reward_events where chain_id = 97`)).rows;
    assert.ok(re.length >= 1, "the canonical trade has its reward_events row");
    assert.ok(re.every((r) => r.tx_hash !== phantom.hash.toLowerCase() && r.wallet_address !== env.linked.address.toLowerCase()), "no reward_events row for the phantom trade");
    // a re-scan of the display cursor writes nothing new
    const snap = async () => (await db.query(`select (select count(*) from public.curve_trades) a, (select count(*) from public.evm_gen8_swaps) b, (select sum(trades_count) from public.token_candles) c, (select count(*) from public.evm_gen8_fee_accruals) d`)).rows[0];
    const before = await snap();
    await db.query(`update public.indexer_state set last_indexed_block = $1 where chain_id = 97 and cursor = $2`, [startBlock, gen8Cursor(cfg)]);
    await catchUp();
    assert.deepEqual(await snap(), before);
    provider.destroy();
  } finally {
    await anvil.stop();
    await pg.stop();
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
  }
});
