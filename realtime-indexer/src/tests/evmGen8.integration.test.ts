/**
 * Gen-8 end to end on a LOCAL chain: anvil (chain 97, no fork) with the production gen-8 contracts from build/evm-gen8,
 * a throwaway Postgres 16 with the production migrations plus the gen-8 migration, and the real indexer path
 * (indexer.ts upsertCampaign / markEvmCampaignGraduated, Ably disabled by RUNTIME_ENVIRONMENT=local).
 * Covers: launch + first buy, the four swap types from linked / OG / unlinked wallets, the graduation crossing, swaps
 * after it, D14 tables, accruals and reward_events, a re-scan (idempotency), the holder census, a dry run and then a
 * real (local) MwzFeeSplitter.route with its Routed event, a second run (cumulative targets), and a hookless V4 side pool.
 * Skips when the artifacts, anvil or Postgres 16 are missing.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { ethers } from "ethers";
import { artifactsAvailable, deployArtifact, deployGen8Local, launchCoin, startAnvil, swap, WAD } from "./gen8/gen8LocalChain.js";
import { gen8SchemaFiles } from "./gen8/gen8TestDb.js";

const PG16 = "/usr/lib/postgresql/16/bin";
const runnable = artifactsAvailable() && fs.existsSync(`${PG16}/initdb`);

test("gen-8 indexer end to end on a local chain", { skip: runnable ? false : "gen-8 artifacts, anvil or Postgres 16 missing", timeout: 600_000 }, async () => {
  process.env.DBC_PG_BIN = PG16;
  process.env.RUNTIME_ENVIRONMENT = "local";
  process.env.PG_DISABLE_SSL = "1";
  const { startThrowawayPostgres } = await import("../../../scripts/dbc/throwaway-postgres.mjs");
  const pg = await startThrowawayPostgres({ port: 55462, extraFiles: gen8SchemaFiles() });
  const anvil = await startAnvil(8773, 97);
  try {
    process.env.DATABASE_URL = pg.url;
    process.env.BSC_RPC_HTTP_97 = anvil.url;
    const provider = new ethers.JsonRpcProvider(anvil.url, 97, { staticNetwork: true, cacheTimeout: -1 });
    const env = await deployGen8Local(provider, { display: true });
    const startBlock = await provider.getBlockNumber();
    const A = {
      launcher: (await env.launcher.getAddress()).toLowerCase(), hook: (await env.hook.getAddress()).toLowerCase(), pm: (await env.pm.getAddress()).toLowerCase(),
      splitter: (await env.splitter.getAddress()).toLowerCase(), vault: (await env.vault.getAddress()).toLowerCase(), lock: (await env.reserveLock.getAddress()).toLowerCase(),
      escrow: (await env.escrow.getAddress()).toLowerCase(),
    };
    const genv: NodeJS.ProcessEnv = {
      ...process.env,
      EVM_GEN8_LAUNCHER_97: `${A.launcher}@${startBlock}`, EVM_GEN8_HOOK_97: `${A.hook}@${startBlock}`, EVM_GEN8_POOL_MANAGER_97: A.pm,
      EVM_GEN8_SPLITTER_97: `${A.splitter}@${startBlock}`, EVM_GEN8_CHOICE_VAULT_97: A.vault, EVM_GEN8_RESERVE_LOCK_97: A.lock, EVM_GEN8_ESCROW_97: A.escrow,
      EVM_GEN8_CONFIRMATIONS: "0", EVM_GEN8_LOG_CHUNK: "5000", EVM_GEN8_SIDE_FACTORIES_97: "v2:0x000000000000000000000000000000000000beef",
      // F10: anvil's finalized block is 64 behind; this test runs both passes at the head (evmGen8Reorg.integration.test.ts
      // covers the display / money split and the rollback).
      EVM_GEN8_DISPLAY_HEAD_TAG_97: "latest", EVM_GEN8_MONEY_HEAD_TAG_97: "latest",
      // F9: the test router stands in for the app's UniversalRouter; F11: the operator is set before the start block.
      EVM_GEN8_LINK_ROUTERS_97: (await env.trader.getAddress()).toLowerCase(), EVM_GEN8_ROUTER_CLAIMERS_97: env.operator.address.toLowerCase(),
    };
    const db = pg.pool;
    // Recruiter links: `linked` -> standard recruiter, `og` -> OG recruiter; buyer and other stay unlinked.
    const r1 = await db.query(`insert into public.recruiters(wallet_address, code, is_og) values ($1, 'REC1', false) returning id`, [env.other.address.toLowerCase()]);
    const r2 = await db.query(`insert into public.recruiters(wallet_address, code, is_og) values ($1, 'OG1', true) returning id`, ["0x00000000000000000000000000000000000000a1"]);
    await db.query(`insert into public.wallet_recruiter_links(wallet_address, recruiter_id, linked_at) values ($1, $2, now() - interval '1 day')`, [env.linked.address, r1.rows[0].id]);
    await db.query(`insert into public.wallet_recruiter_links(wallet_address, recruiter_id, linked_at) values ($1, $2, now() - interval '1 day')`, [env.og.address.toLowerCase(), r2.rows[0].id]);

    const { evmGen8Config } = await import("../evm/evmGen8Config.js");
    const { defaultGen8Sinks, runGen8ChainOnce } = await import("../evm/evmGen8Pool.js");
    const { runGen8HolderCensusOnce } = await import("../evm/evmGen8Holders.js");
    const { runGen8RoutePass, ethersRouteChain } = await import("../evm/evmGen8FeeRouting.js");
    const { runGen8SidePoolWatcherOnce } = await import("../evm/evmGen8SidePools.js");
    const { splitterBands } = await import("../evm/evmGen8Fees.js");
    const cfg = evmGen8Config(97, genv).config!;
    assert.ok(cfg, "gen-8 config");
    const sinks = await defaultGen8Sinks(db);
    const ctx = { cfg, db, provider: provider as any, sinks, env: genv };
    const catchUp = async () => {
      for (let i = 0; i < 50; i += 1) if (!(await runGen8ChainOnce(ctx))) break;
    };

    // ---- launch, bonding trades of all four types, crossing, post-graduation trades
    const coin = await launchCoin(env, env.creator, { firstBuyValue: WAD / 1000n, name: "Indexer Eight", symbol: "IDX8" });
    await provider.send("evm_increaseTime", [120]);
    await swap(env, coin, env.linked, { buy: true, exactIn: true, amount: WAD / 500n }); // standard_linked
    await swap(env, coin, env.og, { buy: true, exactIn: false, amount: 2_000_000n * WAD, maxIn: WAD }); // og_linked, exact out
    await swap(env, coin, env.buyer, { buy: true, exactIn: true, amount: WAD / 400n }); // unlinked
    await swap(env, coin, env.buyer, { buy: false, exactIn: true, amount: 100_000n * WAD }); // sell exact in
    await swap(env, coin, env.linked, { buy: false, exactIn: false, amount: WAD / 10_000n }); // sell exact out
    await catchUp();
    const midCurve = await db.query(`select count(*)::int as n from public.curve_trades where chain_id = 97`);
    assert.equal(midCurve.rows[0].n, 6, "first buy + five bonding swaps");
    const crossing = await swap(env, coin, env.buyer, { buy: true, exactIn: true, amount: WAD / 10n });
    await swap(env, coin, env.og, { buy: true, exactIn: true, amount: WAD / 500n });
    await swap(env, coin, env.buyer, { buy: false, exactIn: true, amount: 100_000n * WAD });
    await catchUp();

    const token = coin.token.toLowerCase();
    const camp = (await db.query(`select * from public.campaigns where chain_id = 97 and campaign_address = $1`, [token])).rows[0];
    assert.equal(camp.factory_generation, 8);
    assert.equal(camp.campaign_generation, 8);
    assert.equal(camp.name, "Indexer Eight");
    assert.equal(Number(camp.graduated_block), crossing.blockNumber, "graduated at the crossing block");
    assert.ok(camp.graduated_at_chain);
    assert.equal(camp.meta.gen8.poolId, coin.id);

    const curve = (await db.query(`select * from public.curve_trades where chain_id = 97 order by block_number, log_index`)).rows;
    const dex = (await db.query(`select * from public.dex_trades where chain_id = 97 order by block_number, log_index`)).rows;
    assert.equal(curve.length, 7, "bonding rows up to and including the crossing swap");
    assert.equal(dex.length, 2, "rows after the crossing");
    assert.equal(curve[curve.length - 1].tx_hash, crossing.hash.toLowerCase(), "the crossing swap is a curve trade (D14)");
    assert.ok(curve.every((t) => Number(t.block_number) <= Number(camp.graduated_block)));
    assert.ok(curve.every((t) => t.venue === "gen8"));
    assert.ok(dex.every((t) => t.execution_source === "gen8_v4" && t.pair_address === A.hook && t.status === "confirmed"));
    assert.equal(curve[0].creator_buy_kind, "first_buy");
    assert.equal(curve[0].league_excluded, true, "creator first buy never counts for leagues");
    assert.equal(curve[0].wallet, env.creator.address.toLowerCase());
    assert.equal(curve[1].wallet, env.linked.address.toLowerCase(), "wallet = tx.from, not the router");
    assert.ok(curve.slice(1).every((t) => t.league_excluded === false));
    // Every curve row carries the HookFee: fee_raw > 0, gross = bnb_amount = curveAmount.
    assert.ok(curve.every((t) => BigInt(t.fee_raw) > 0n && t.gross_raw === t.bnb_amount_raw));

    const acc = (await db.query(`select * from public.evm_gen8_fee_accruals where chain_id = 97 order by block_number, log_index`)).rows;
    assert.equal(acc.length, 10, "9 HookFee + 1 Graduated");
    const byTrader = (w: string) => acc.filter((a) => a.trader === w.toLowerCase() && a.phase === "bonding" && a.kind === "trade");
    assert.ok(byTrader(env.linked.address).every((a) => a.profile === "standard_linked" && BigInt(a.recruiter) > 0n));
    assert.ok(byTrader(env.og.address).every((a) => a.profile === "og_linked"));
    assert.ok(byTrader(env.buyer.address).every((a) => a.profile === "standard_unlinked" && BigInt(a.airdrop) > 0n));
    const grad = acc.find((a) => a.kind === "graduation");
    assert.ok(grad && BigInt(grad.fee) > 0n);
    assert.ok(acc.filter((a) => a.phase === "post").every((a) => BigInt(a.protocol) === BigInt(a.router_amount) && a.recruiter === "0"));
    for (const a of acc) {
      const sum = BigInt(a.league_weekly) + BigInt(a.league_monthly) + BigInt(a.recruiter) + BigInt(a.squad) + BigInt(a.airdrop) + BigInt(a.protocol) + BigInt(a.creator_share);
      assert.equal(sum, BigInt(a.fee), "slices conserve the fee");
    }
    const re = (await db.query(`select * from public.reward_events where chain_id = 97 and matched_activity_source = 'gen8_hook'`)).rows;
    assert.equal(re.length, 8, "7 bonding HookFee + 1 Graduated");
    assert.equal(re.filter((r) => r.route_kind === "finalize").length, 1);

    const cms = (await db.query(`select * from public.campaign_market_state where chain_id = 97 and campaign_address = $1`, [token])).rows[0];
    assert.equal(cms.market_stage, "DEX_ACTIVE");
    assert.equal(cms.dex_router_address, A.hook);
    assert.equal(Number(cms.graduation_block), crossing.blockNumber);
    const ms = (await db.query(`select * from public.market_stats where chain_id = 97 and campaign_address = $1`, [token])).rows[0];
    assert.equal(ms.market_stage, "DEX_ACTIVE");
    assert.ok(Number(ms.market_cap_bnb) > 0 && Number(ms.liquidity_bnb) > 0);
    const ts = (await db.query(`select * from public.token_stats where chain_id = 97 and campaign_address = $1`, [token])).rows[0];
    assert.ok(Number(ts.last_price_bnb) > 0 && Number(ts.sold_tokens) > 0);
    const candles = (await db.query(`select sum(trades_count)::int as n, sum(bonding_trade_count)::int as b, sum(dex_trade_count)::int as d from public.token_candles where chain_id = 97 and campaign_address = $1 and timeframe = '1m'`, [token])).rows[0];
    assert.deepEqual([candles.n, candles.b, candles.d], [9, 7, 2]);
    const notif = (await db.query(`select count(*)::int as n from public.notification_outbox`)).rows[0].n;
    assert.ok(notif >= 2, "campaign created + graduated notifications");

    // ---- idempotency: rescan everything from the start block
    const snapshot = async () => (await db.query(`select (select count(*) from public.curve_trades) a, (select count(*) from public.dex_trades) b, (select count(*) from public.evm_gen8_fee_accruals) c, (select count(*) from public.reward_events) d, (select sum(trades_count) from public.token_candles) e, (select count(*) from public.activity_events) f`)).rows[0];
    const before = await snapshot();
    const reset = await db.query(`update public.indexer_state set last_indexed_block = $1 where chain_id = 97 and cursor = $2`, [startBlock, `gen8:${A.hook}`]);
    assert.equal(reset.rowCount, 1, "the gen-8 cursor is gen8:<hook>");
    await catchUp();
    assert.deepEqual(await snapshot(), before, "a re-scan writes nothing new");

    // ---- holders
    const census = await runGen8HolderCensusOnce({ db: db as any, cfg, provider: provider as any, env: genv });
    assert.ok(census.applied > 0);
    const holders = (await db.query(`select holder_count from public.evm_gen8_pools where chain_id = 97 and pool_id = $1`, [coin.id])).rows[0].holder_count;
    let expected = 0;
    for (const w of [env.creator, env.linked, env.og, env.buyer]) {
      const bal: bigint = await (coin.coin as any).balanceOf(w.address);
      const row = (await db.query(`select balance_raw from public.token_holder_balances where chain_id = 97 and token_address = $1 and wallet = $2`, [token, w.address.toLowerCase()])).rows[0];
      assert.equal(BigInt(row?.balance_raw ?? 0), bal, "census balance equals balanceOf");
      if (bal > 0n) expected += 1;
    }
    assert.equal(holders, expected, "PoolManager, hook, reserve lock and 0xdEaD are not holders");

    // ---- fee routing, claim-first (MwzFeeSplitter V13: route(runId, expectedPaid, ...), no auto-claim)
    const { aggregateRunAmounts, emptyProfileSums, addToSums } = await import("../evm/evmGen8Fees.js");
    const routeChain = ethersRouteChain(cfg, provider, env.operator.connect(provider) as any);
    const send = { db, cfg, chain: routeChain, send: true, operatorAddress: env.operator.address, minWei: 0n, alert: (a: any) => sinks.raiseAlert(a) };
    const sumsOfRun = async (runId: number) => {
      const rows = (await db.query(`select kind, phase, profile, fee from public.evm_gen8_fee_accruals where run_id = $1`, [runId])).rows;
      const sums = emptyProfileSums();
      for (const r of rows) addToSums(sums, { kind: r.kind, phase: r.phase, profile: r.profile, fee: BigInt(r.fee) });
      return sums;
    };
    const dry0 = await runGen8RoutePass({ db, cfg, chain: routeChain, send: false, minWei: 0n });
    assert.equal(dry0.status, "skipped", "dry run never claims");
    assert.equal((dry0 as any).reason, "dry-run-would-claim");
    const claim1 = await runGen8RoutePass(send);
    assert.equal(claim1.status, "claimed", JSON.stringify(claim1));
    await catchUp();
    // A trade AFTER the claim: its fee stays in the hook and must go to the next run, in full.
    const late = await swap(env, coin, env.linked, { buy: true, exactIn: true, amount: WAD / 300n });
    await catchUp();
    const dry = await runGen8RoutePass({ db, cfg, chain: routeChain, send: false, minWei: 0n });
    assert.equal(dry.status, "planned", JSON.stringify(dry));
    assert.equal(BigInt(await (env.splitter as any).runs()), 0n, "dry run sends nothing");
    const contractBands = await (env.splitter as any).bands(BigInt((dry as any).bondingFees), BigInt((dry as any).gradFees));
    const local = splitterBands(BigInt((dry as any).bondingFees), BigInt((dry as any).gradFees));
    assert.equal(BigInt(contractBands[2]), local.rsaMin);
    assert.equal(BigInt(contractBands[3]), local.rsaMax);
    const sent = await runGen8RoutePass(send);
    assert.equal(sent.status, "sent", JSON.stringify(sent));
    assert.equal(BigInt(await (env.splitter as any).runs()), 1n);
    await catchUp();
    const run1 = (await db.query(`select * from public.evm_gen8_route_runs where run_id = 1`)).rows[0];
    assert.equal(run1.status, "confirmed");
    assert.equal(run1.recruiter, (sent as any).recruiter);
    assert.equal(run1.accrual_root, (sent as any).root);
    const lateRow = (await db.query(`select run_id from public.evm_gen8_fee_accruals where tx_hash = $1`, [late.hash.toLowerCase()])).rows[0];
    assert.equal(lateRow.run_id, null, "the fee after the claim is not in run 1");
    const bandsRun1 = splitterBands(BigInt(run1.bonding_fees), BigInt(run1.grad_fees));
    const exp1 = aggregateRunAmounts(await sumsOfRun(1), bandsRun1);
    assert.deepEqual([run1.recruiter, run1.squad, run1.airdrop], [exp1.recruiter, exp1.squad, exp1.airdrop].map(String), "run 1 = aggregate rule over exactly its rows");
    assert.equal(BigInt(await provider.getBalance(await env.recruiter.getAddress())), BigInt(run1.recruiter), "recruiter vault got the run's recruiter amount");
    assert.equal(BigInt(await provider.getBalance(await env.weekly.getAddress())), BigInt(run1.weekly_league));

    // ---- run 2: claim, then a third party trades and claims before our route -> PaidMismatch -> re-plan
    const claim2 = await runGen8RoutePass(send);
    assert.equal(claim2.status, "claimed", JSON.stringify(claim2));
    await catchUp();
    const racing = {
      ...routeChain,
      sendRoute: async (a: any) => {
        await swap(env, coin, env.og, { buy: true, exactIn: true, amount: WAD / 800n });
        // F4: claimRouter is restricted to the router, its operator or the hook owner; a stranger's claim reverts.
        await assert.rejects((env.hook.connect(env.other) as any).claimRouter(), /NotRouterCaller|0x544df468|revert/, "a third party cannot claim");
        await (await (env.hook.connect(env.safe) as any).claimRouter()).wait(); // the owner (Safe) claims: a claim our worker did not plan
        return routeChain.sendRoute(a);
      },
    };
    const mismatch = await runGen8RoutePass({ ...send, chain: racing });
    assert.equal(mismatch.status, "skipped");
    assert.equal((mismatch as any).reason, "paid-mismatch-replan", JSON.stringify(mismatch));
    assert.equal(BigInt(await (env.splitter as any).runs()), 1n);
    await catchUp();
    const sent2 = await runGen8RoutePass(send);
    assert.equal(sent2.status, "sent", JSON.stringify(sent2));
    await catchUp();
    const run2 = (await db.query(`select * from public.evm_gen8_route_runs where run_id = 2`)).rows[0];
    assert.equal(run2.status, "confirmed");
    assert.equal((await db.query(`select run_id from public.evm_gen8_fee_accruals where tx_hash = $1`, [late.hash.toLowerCase()])).rows[0].run_id, "2", "the late fee is routed in run 2");
    const exp2 = aggregateRunAmounts(await sumsOfRun(2), splitterBands(BigInt(run2.bonding_fees), BigInt(run2.grad_fees)));
    assert.deepEqual([run2.recruiter, run2.squad, run2.airdrop], [exp2.recruiter, exp2.squad, exp2.airdrop].map(String), "run 2 pays the late fee's shares in full");
    assert.equal((await db.query(`select count(*)::int as n from public.evm_gen8_fee_accruals where run_id is null`)).rows[0].n, 0);
    const routeUntilSent = async () => {
      for (let i = 0; i < 4; i += 1) {
        const r = await runGen8RoutePass(send);
        await catchUp();
        if (r.status === "sent") return r;
      }
      throw new Error("no run sent");
    };

    // ---- second coin, run 3
    const coin2 = await launchCoin(env, env.other, { name: "Second", symbol: "TWO" });
    await provider.send("evm_increaseTime", [120]);
    for (let i = 0; i < 5; i += 1) await swap(env, coin2, i % 2 ? env.linked : env.buyer, { buy: true, exactIn: true, amount: WAD / 700n + BigInt(i) * 12_345n });
    await catchUp();
    // Founder decision 2026-10-11: `other` owns recruiter row REC1 but has no link of its own -> UNLINKED, no fee share.
    await swap(env, coin2, env.other, { buy: true, exactIn: true, amount: WAD / 900n });
    await catchUp();
    const ownerRows = (await db.query(`select profile, recruiter, squad, airdrop from public.evm_gen8_fee_accruals where trader = $1 and kind = 'trade' and phase = 'bonding'`, [env.other.address.toLowerCase()])).rows;
    assert.ok(ownerRows.length >= 1);
    assert.ok(ownerRows.every((r) => r.profile === "standard_unlinked" && r.recruiter === "0" && r.squad === "0" && BigInt(r.airdrop) > 0n), "a recruiter's own wallet without a link is unlinked");
    await routeUntilSent();
    assert.equal((await db.query(`select status from public.evm_gen8_route_runs where run_id = 3`)).rows[0].status, "confirmed");

    // ---- F3 parked router: a router change parks the splitter's bucket (RouterParked); the worker pays it
    //      (payParkedRouter -> RouterClaimed) and routes it as a normal run
    await swap(env, coin2, env.buyer, { buy: true, exactIn: true, amount: WAD / 650n });
    await (await (env.hook.connect(env.safe) as any).proposeTreasuryRouter(await env.protocol.getAddress())).wait();
    await provider.send("evm_increaseTime", [48 * 3600 + 10]);
    await (await (env.hook.connect(env.safe) as any).executeTreasuryRouter()).wait();
    await catchUp();
    assert.ok(BigInt((await (env.hook as any).routerParked(A.splitter))[0]) > 0n, "the bucket is parked for the splitter");
    const parkedDry = await runGen8RoutePass({ db, cfg, chain: routeChain, send: false, minWei: 0n });
    assert.equal((parkedDry as any).reason, "dry-run-would-pay-parked", JSON.stringify(parkedDry));
    const parkedRun = await runGen8RoutePass(send);
    assert.equal(parkedRun.status, "paid-parked", JSON.stringify(parkedRun));
    assert.equal(BigInt((await (env.hook as any).routerParked(A.splitter))[0]), 0n, "paid");
    await catchUp();
    const flushRun = await runGen8RoutePass(send);
    assert.equal(flushRun.status, "sent", JSON.stringify(flushRun));
    await catchUp();
    assert.equal((await db.query(`select status from public.evm_gen8_route_runs where run_id = 4`)).rows[0].status, "confirmed");
    assert.equal((await db.query(`select count(*)::int as n from public.evm_gen8_fee_accruals where run_id is null`)).rows[0].n, 0, "the flushed bucket is fully routed");
    const neverFire = (await db.query(`select metadata->>'kind' as kind from public.reward_alerts where metadata->>'kind' in ('gen8_accrual_mismatch','gen8_run_rows_mismatch','gen8_run_without_claim','gen8_routed_differs_from_plan')`)).rows;
    assert.deepEqual(neverFire, [], "the should-never-fire alerts did not fire (every Routed equals its plan)");
    assert.ok((await db.query(`select 1 from public.reward_alerts where metadata->>'kind' = 'gen8_router_not_splitter'`)).rows.length === 1, "router change alerted");
    // F11: the control events and the third party's claimRouter() in run 2 are alerted; our own claims and the A4 flush are not.
    const kinds = async () => (await db.query(`select metadata->>'kind' as kind from public.reward_alerts`)).rows.map((r) => r.kind);
    const k1 = await kinds();
    assert.equal(k1.filter((k) => k === "gen8_foreign_router_claim").length, 1, `one claim not sent by the operator (the Safe's, run 2): ${k1.join(",")}`);
    assert.ok(k1.includes("gen8_router_proposed") && k1.includes("gen8_router_changed"), "RouterProposed and RouterChanged alerted");
    assert.ok(k1.includes("gen8_router_parked"), "RouterParked alerted");
    await (await (env.splitter.connect(env.safe) as any).setOperator(env.operator.address)).wait();
    await (await (env.hook.connect(env.safe) as any).transferOwnership(env.other.address)).wait();
    await catchUp();
    const k2 = await kinds();
    assert.ok(k2.includes("gen8_splitter_operator_updated"), "splitter OperatorUpdated alerted");
    assert.ok(k2.includes("gen8_ownership_transfer_started"), "hook OwnershipTransferStarted alerted");

    // ---- F9: a linked wallet's trade through a router that is not on the allow list carries no link
    const trader2 = await deployArtifact(env.deployer, "V4DirectTrader", [await env.pm.getAddress()]);
    const viaOther = await (await (trader2.connect(env.linked) as any).swap(coin2.key, true, -(WAD / 900n), 0n, "0x", { value: WAD / 900n, gasLimit: 5_000_000n })).wait();
    await catchUp();
    const otherRouterRow = (await db.query(`select profile, recruiter, squad, airdrop, swap_sender from public.evm_gen8_fee_accruals where tx_hash = $1`, [viaOther.hash.toLowerCase()])).rows[0];
    assert.equal(otherRouterRow.swap_sender, (await trader2.getAddress()).toLowerCase());
    assert.equal(otherRouterRow.profile, "standard_unlinked", "not an allowed router: unlinked");
    assert.ok(otherRouterRow.recruiter === "0" && BigInt(otherRouterRow.airdrop) > 0n);

    // ---- B scheduled open: a coin launched with openAt in the future refuses every swap before it (the creator's
    //      first buy inside launch() excepted); the 60 s launch fee decay runs from openAt
    const nowTs = Number((await provider.getBlock("latest"))!.timestamp);
    // The router change above moved the chain 48 h; the mock oracle feed must be fresh again for a launch.
    await (await (env.feed.connect(env.deployer) as any).set(600n * 10n ** 8n, nowTs)).wait();
    const openAt = BigInt(nowTs + 600);
    const coin3 = await launchCoin(env, env.creator, { firstBuyValue: WAD / 2000n, name: "Scheduled", symbol: "SCHD", openAt });
    await catchUp();
    const pool3 = (await db.query(`select open_at, launch_time from public.evm_gen8_pools where chain_id = 97 and pool_id = $1`, [coin3.id])).rows[0];
    assert.equal(Math.floor(new Date(pool3.open_at).getTime() / 1000), Number(openAt), "open_at stored from PoolLaunched");
    assert.ok(new Date(pool3.open_at) > new Date(pool3.launch_time));
    const camp3 = (await db.query(`select meta from public.campaigns where chain_id = 97 and campaign_address = $1`, [coin3.token.toLowerCase()])).rows[0];
    assert.equal(Math.floor(new Date(camp3.meta.gen8.openAt).getTime() / 1000), Number(openAt), "campaigns.meta.gen8.openAt");
    assert.equal((await db.query(`select count(*)::int as n from public.curve_trades where chain_id = 97 and campaign_address = $1`, [coin3.token.toLowerCase()])).rows[0].n, 1, "the creator first buy inside launch()");
    await assert.rejects(swap(env, coin3, env.buyer, { buy: true, exactIn: true, amount: WAD / 500n }), /TradingNotOpen|0xe09f0331|revert/, "no swap before openAt");
    await provider.send("evm_increaseTime", [600]);
    await provider.send("anvil_mine", ["0x1"]);
    const atOpen = await swap(env, coin3, env.buyer, { buy: true, exactIn: true, amount: WAD / 500n });
    await provider.send("evm_increaseTime", [120]);
    await provider.send("anvil_mine", ["0x1"]);
    const afterDecay = await swap(env, coin3, env.buyer, { buy: true, exactIn: true, amount: WAD / 500n });
    await catchUp();
    const feeAtOpen = (await db.query(`select fee_bps from public.evm_gen8_fee_accruals where tx_hash = $1`, [atOpen.hash.toLowerCase()])).rows[0];
    const feeAfter = (await db.query(`select fee_bps from public.evm_gen8_fee_accruals where tx_hash = $1`, [afterDecay.hash.toLowerCase()])).rows[0];
    assert.ok(Number(feeAtOpen.fee_bps) > Number(feeAfter.fee_bps), `the launch fee decays from openAt: ${feeAtOpen.fee_bps} > ${feeAfter.fee_bps}`);
    assert.equal(Number(feeAfter.fee_bps), 200, "2% after the 60 s decay");

    // ---- F1 per-trade D14: a forced latch followed by a sell back into range A. The Graduated event latches the coin
    //      (campaigns.graduated_*), but later swaps that START inside A pay the bonding rate, land in curve_trades, book
    //      bonding accruals, and the platform status is bonding again until the price is past graduation once more.
    const coin4 = await launchCoin(env, env.other, { name: "Latch", symbol: "LTCH" });
    await provider.send("evm_increaseTime", [120]);
    const cross4 = await swap(env, coin4, env.og, { buy: true, exactIn: true, amount: WAD / 4n }); // past the graduation price: latch
    await catchUp();
    const tok4 = coin4.token.toLowerCase();
    const latched = (await db.query(`select graduated_block, last_phase from public.evm_gen8_pools where chain_id = 97 and pool_id = $1`, [coin4.id])).rows[0];
    assert.equal(Number(latched.graduated_block), cross4.blockNumber, "latched at the crossing");
    assert.equal(latched.last_phase, "post", "the price is past graduation after the crossing");
    assert.equal((await db.query(`select phase from public.evm_gen8_fee_accruals where tx_hash = $1`, [cross4.hash.toLowerCase()])).rows[0].phase, "bonding", "the crossing swap started inside A: bonding accrual");
    const post4 = await swap(env, coin4, env.buyer, { buy: true, exactIn: true, amount: WAD / 2000n }); // starts past graduation: post
    await catchUp();
    assert.equal((await db.query(`select last_phase from public.evm_gen8_pools where pool_id = $1`, [coin4.id])).rows[0].last_phase, "post");
    assert.equal((await db.query(`select market_stage from public.campaigns where chain_id = 97 and campaign_address = $1`, [tok4])).rows[0].market_stage, "DEX_ACTIVE");
    assert.equal((await db.query(`select count(*)::int as n from public.dex_trades where chain_id = 97 and tx_hash = $1`, [post4.hash.toLowerCase()])).rows[0].n, 1, "a post-phase swap is a dex trade");
    const ogCoins: bigint = await (coin4.coin as any).balanceOf(env.og.address);
    // F2: after the latch A holds 98% of its liquidity, so selling ALL the coins bought from it would end above the start
    // price and reverts PriceAboveStart (the app caps sells at what A can absorb); 90% ends well inside A.
    await assert.rejects(swap(env, coin4, env.og, { buy: false, exactIn: true, amount: ogCoins }), /revert|PriceAboveStart/, "an oversize sell reverts");
    const back = await swap(env, coin4, env.og, { buy: false, exactIn: true, amount: (ogCoins * 9n) / 10n }); // starts post, ends inside A
    const inA = await swap(env, coin4, env.buyer, { buy: true, exactIn: true, amount: WAD / 2000n }); // starts inside A again: bonding
    await catchUp();
    assert.equal((await db.query(`select count(*)::int as n from public.dex_trades where chain_id = 97 and tx_hash = $1`, [back.hash.toLowerCase()])).rows[0].n, 1, "the sell back started post phase");
    const inARow = (await db.query(`select block_number, league_excluded from public.curve_trades where chain_id = 97 and tx_hash = $1`, [inA.hash.toLowerCase()])).rows[0];
    assert.ok(inARow, "a swap back inside A is a curve trade again");
    assert.ok(Number(inARow.block_number) > cross4.blockNumber, "after the latch block: the Leagues must not cut at graduated_block");
    assert.equal(inARow.league_excluded, false);
    const inAAcc = (await db.query(`select phase, fee_bps, league_weekly from public.evm_gen8_fee_accruals where tx_hash = $1`, [inA.hash.toLowerCase()])).rows[0];
    assert.equal(inAAcc.phase, "bonding", "the accrual phase follows the rate charged, not the latch");
    assert.equal(Number(inAAcc.fee_bps), 200);
    assert.ok(BigInt(inAAcc.league_weekly) > 0n, "bonding split: League share");
    const backPool = (await db.query(`select graduated_block, last_phase from public.evm_gen8_pools where pool_id = $1`, [coin4.id])).rows[0];
    assert.equal(Number(backPool.graduated_block), cross4.blockNumber, "the latch stays");
    assert.equal(backPool.last_phase, "bonding");
    assert.equal((await db.query(`select market_stage from public.campaigns where chain_id = 97 and campaign_address = $1`, [tok4])).rows[0].market_stage, "BONDING", "platform status back to bonding");
    assert.equal((await db.query(`select market_stage from public.campaign_market_state where chain_id = 97 and campaign_address = $1`, [tok4])).rows[0].market_stage, "BONDING");
    assert.ok(Number((await db.query(`select graduated_block from public.campaigns where chain_id = 97 and campaign_address = $1`, [tok4])).rows[0].graduated_block) === cross4.blockNumber, "campaigns.graduated_block keeps the latch block");
    assert.equal((await db.query(`select count(*)::int as n from public.evm_campaign_events where chain_id = 97 and campaign_address = $1 and event_name = 'Graduated'`, [tok4])).rows[0].n, 1, "no second Graduated event");
    await swap(env, coin4, env.og, { buy: true, exactIn: true, amount: WAD / 4n }); // past graduation again: no new latch, status graduated again
    await catchUp();
    assert.equal((await db.query(`select market_stage from public.campaigns where chain_id = 97 and campaign_address = $1`, [tok4])).rows[0].market_stage, "DEX_ACTIVE");
    assert.equal((await db.query(`select count(*)::int as n from public.evm_campaign_events where chain_id = 97 and campaign_address = $1 and event_name = 'Graduated'`, [tok4])).rows[0].n, 1);

    // ---- side pool: a hookless V4 pool of our coin
    const pmSigner = env.pm.connect(env.buyer) as any;
    await (await pmSigner.initialize([ethers.ZeroAddress, coin.token, 3000, 60, ethers.ZeroAddress], 79228162514264337593543950336n)).wait();
    const side = await runGen8SidePoolWatcherOnce({ db, cfg, provider: provider as any, env: genv, alert: (a) => sinks.raiseAlert(a) });
    assert.ok(side && side.created === 1, JSON.stringify(side));
    const sideRow = (await db.query(`select * from public.evm_gen8_side_pools`)).rows[0];
    assert.equal(sideRow.venue, "v4");
    assert.equal(sideRow.token_address, token);
    const alerts = (await db.query(`select reward_type, metadata->>'kind' as kind from public.reward_alerts`)).rows;
    assert.ok(alerts.some((a) => a.kind === "gen8_side_pool_created"));
    assert.equal((await db.query(`select count(*)::int as n from public.dex_trades where execution_source <> 'gen8_v4'`)).rows[0].n, 0, "side pools are never written as trades");
    provider.destroy();
  } finally {
    await anvil.stop();
    await pg.stop();
    // indexer.ts starts its league feed timer at import; end the test process once the test is done.
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
  }
});
