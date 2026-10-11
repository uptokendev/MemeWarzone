/**
 * Gen-8 decoders and the Swap / HookFee join, on logs recorded from a real local run of the production contracts
 * (src/tests/fixtures/gen8-logs.json, recorded by src/tests/gen8/recordGen8Fixtures.ts), plus synthetic transactions
 * for the cases one router swap cannot produce (several swaps of one pool in one transaction, orphans).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import fx from "./fixtures/gen8-logs.json" with { type: "json" };
import { GEN8_TOPICS, gen8PoolId, V4_POOL_MANAGER_IFACE, GEN8_HOOK_IFACE } from "../evm/evmGen8Abi.js";
import { decodeGen8Log, gen8TradeTable, groupByTx, joinSwapsWithFees, traderNative, type Gen8Event } from "../evm/evmGen8Decode.js";
import { configuredGen8Chains, evmGen8Config } from "../evm/evmGen8Config.js";
import { gen8PoolHoldings, gen8Progress, marketCapWei, nativePerCoinWei, sqrtAtTick, Q96, WAD } from "../evm/evmGen8Math.js";
import { transferDeltas, TRANSFER_TOPIC, gen8HolderExclusions, DEAD } from "../evm/evmGen8Holders.js";
import { findSidePools, sideSwapCoinVolume, sideFactories, SIDE_TOPICS } from "../evm/evmGen8SidePools.js";

const A = { launcher: fx.addresses.launcher, hook: fx.addresses.hook, poolManager: fx.addresses.poolManager, splitter: fx.addresses.splitter, choiceVault: fx.addresses.choiceVault };
const POOL = fx.poolId;
const step = (label: string) => fx.steps.find((s) => s.label === label)!;
const decodeStep = (label: string) => step(label).logs.map((l) => decodeGen8Log(l as any, A)).filter((e): e is Gen8Event => e !== null);

test("topic0 of every event equals GEN8_INTERNAL_AUDIT.md 10.1", () => {
  assert.equal(GEN8_TOPICS.Launched, "0x088cfcd47a3402b49e48e3f02ab27f94e17c8faf2fd7174441c6a1b2f22e8202");
  assert.equal(GEN8_TOPICS.LaunchMetadata, "0xb1da1fbea51ed6d80051f5210a2219d6337b68bf121164963927cd17d0a248a4");
  assert.equal(GEN8_TOPICS.PoolLaunched, "0x882a00429193dca8fdb004116ad7dab1dccf4e77ab2999afc6e0909732bd7f01");
  assert.equal(GEN8_TOPICS.HookFee, "0xb77d9c06aa8d782c4be19bbd7a54af4d03bb0eaf618c887f8d1eb5f7b0213ad2");
  assert.equal(GEN8_TOPICS.Graduated, "0x9408aa53590d2acf7d72e624d65745b71ea5a308a6cc5f2c7cbee7163b3dc332");
  assert.equal(GEN8_TOPICS.CreatorClaimed, "0xc1d27057937a5216efd7c1ee2b680a2a34893e3f35e3a33f70c4bf0935312664");
  assert.equal(GEN8_TOPICS.CreatorProposed, "0x1cf5caa2b6a5e78ae6ef887c184ec7769be961dc26752723f916f81b41c60b0a");
  assert.equal(GEN8_TOPICS.CreatorTransferred, "0x144ce8a4ec60039eca39fc887805725944bd0789eadedc386cdaf0cc731e48c2");
  assert.equal(GEN8_TOPICS.RouterClaimed, "0x2a665e6945441ed891d04bf4224d831464c1973f64bc3826a762686cc02bb1d2");
  assert.equal(GEN8_TOPICS.RouterFlushFailed, "0xab328c600f1136ae1f2cc5a41598d1474d4dd6ca3f64b5e2df7a1a215856f8ed");
  assert.equal(GEN8_TOPICS.RouterProposed, "0xef16fd666847c0c0678edfd1d0ffd1bfa37b9d6be4af7ce29e8b0e01dcb94d59");
  assert.equal(GEN8_TOPICS.RouterChanged, "0xc736654a613824c69968e0ec25ac1a428ccd49e15c28e97b5dfd2c6059757e2a");
  assert.equal(GEN8_TOPICS.RouterProposalCancelled, "0x2da9e1f0074f0b00eb9265a391bbfbe3620e2dd942a4c34944ab3c8c0d18f4f4");
  assert.equal(GEN8_TOPICS.DisplayUpdateFailed, "0xd025c44224b2edf45f377e00f22d95292dda4ecbb55f69cc49701ad6fd5951c3");
  assert.equal(GEN8_TOPICS.Routed, "0x57881eb45e99d6dfb862adfc2e825ffc08734a496e850ef6106dd14bb24b2ef3");
  assert.ok(GEN8_TOPICS.CreatePauseUpdated.startsWith("0x28c36262") && GEN8_TOPICS.CreatePauseUpdated.endsWith("2c2e07"));
  assert.ok(GEN8_TOPICS.CreateSignerUpdated.startsWith("0xc5a5f992") && GEN8_TOPICS.CreateSignerUpdated.endsWith("0e541e"));
});

test("pool id = keccak(native, token, dynamic fee, 10, hook), as emitted", () => {
  assert.equal(gen8PoolId(fx.token, A.hook), POOL);
});

test("launch transaction: PoolLaunched, the first buy (HookFee before Swap), then Launched and LaunchMetadata", () => {
  const ev = decodeStep("launch_with_first_buy");
  assert.deepEqual(ev.map((e) => e.kind), ["PoolLaunched", "HookFee", "Swap", "Launched", "LaunchMetadata"]);
  const pl = ev[0] as Extract<Gen8Event, { kind: "PoolLaunched" }>;
  assert.equal(pl.token, fx.token);
  assert.deepEqual(pl.fees, { bondingBps: 200, postBps: 100, creatorPostBps: 50, sniperStartBps: 9000, creatorBondingBps: 560 });
  const l = ev[3] as Extract<Gen8Event, { kind: "Launched" }>;
  assert.equal(l.creator, fx.addresses.creator);
  assert.equal(l.poolId, POOL);
  const m = ev[4] as Extract<Gen8Event, { kind: "LaunchMetadata" }>;
  assert.equal(m.name, "Gen Eight");
  const j = joinSwapsWithFees(ev, new Set([POOL]));
  assert.equal(j.joined.length, 1);
  assert.equal(j.joined[0]!.type, "buy_exact_in");
  assert.equal(j.joined[0]!.fee.swapSender, A.launcher, "the first buy's swap sender is the launcher");
  assert.equal(j.joined[0]!.fee.fee * 10_000n / j.joined[0]!.fee.curveAmount, 200n, "first buy pays the bonding rate");
});

for (const [label, type, order] of [
  ["buy_exact_in", "buy_exact_in", "fee_first"],
  ["buy_exact_out", "buy_exact_out", "swap_first"],
  ["sell_exact_in", "sell_exact_in", "swap_first"],
  ["sell_exact_out", "sell_exact_out", "fee_first"],
] as const) {
  test(`join: ${label} (${order === "fee_first" ? "HookFee before Swap" : "HookFee after Swap"})`, () => {
    const ev = decodeStep(label);
    const j = joinSwapsWithFees(ev, new Set([POOL]));
    assert.equal(j.orphanFees.length + j.orphanSwaps.length, 0);
    assert.equal(j.joined.length, 1);
    const t = j.joined[0]!;
    assert.equal(t.type, type);
    assert.equal(t.order, order);
    assert.deepEqual(t.anomalies, []);
    assert.equal(t.swapNativeRaw, t.fee.curveAmount, "|Swap.amount0| is the curve amount");
    assert.equal(t.side, type.startsWith("buy") ? "buy" : "sell");
    assert.equal(t.fee.graduated, false);
    assert.equal(gen8TradeTable(t), "curve_trades");
    assert.equal(t.fee.swapSender, fx.addresses.trader, "swap sender is the router contract");
    assert.equal(step(label).from, fx.addresses.buyer, "tx.from is the trader (attribution)");
    // rate 2% after the 60 s window: fee = floor(curve * 200 / 10000) (+0..2 wei for exact-input buys)
    const fee = (t.fee.curveAmount * 200n) / 10_000n;
    assert.ok(t.fee.fee - fee >= 0n && t.fee.fee - fee <= 2n, `${t.fee.fee} vs ${fee}`);
    if (t.side === "buy") assert.equal(traderNative(t), t.fee.curveAmount + t.fee.fee);
    else assert.equal(traderNative(t), t.fee.curveAmount - t.fee.fee);
  });
}

test("D14: the crossing swap is bonding (curve_trades), Graduated follows it, later swaps are dex_trades", () => {
  const ev = decodeStep("crossing_buy");
  const j = joinSwapsWithFees(ev, new Set([POOL]));
  assert.equal(j.joined.length, 1);
  const crossing = j.joined[0]!;
  assert.equal(crossing.fee.graduated, false);
  assert.equal(gen8TradeTable(crossing), "curve_trades");
  const g = ev.find((e) => e.kind === "Graduated") as Extract<Gen8Event, { kind: "Graduated" }>;
  assert.ok(g && g.logIndex > Math.max(crossing.swap.logIndex, crossing.fee.logIndex), "Graduated after the crossing swap's logs");
  assert.ok(g.gradFeeNative > 0n);
  // 2% of A's native raise, within rounding (design 3.3)
  assert.ok(g.gradFeeNative * 10_000n / g.nativeInA === 199n || g.gradFeeNative * 10_000n / g.nativeInA === 200n);
  for (const label of ["post_buy_exact_in", "post_sell_exact_in"]) {
    const t = joinSwapsWithFees(decodeStep(label), new Set([POOL])).joined[0]!;
    assert.equal(t.fee.graduated, true);
    assert.equal(gen8TradeTable(t), "dex_trades");
    assert.equal(t.fee.feeBps, 100, "post-graduation rate 1%");
    assert.equal(t.fee.creatorShare, (t.fee.curveAmount * 50n) / 10_000n, "creator 0.5% of volume");
  }
});

// ---- synthetic transactions (encode real-shaped logs)
const pmI = V4_POOL_MANAGER_IFACE;
const hookI = GEN8_HOOK_IFACE;
function swapLog(pool: string, i: number, amount0: bigint, amount1: bigint, tx = "0xaa") {
  const e = pmI.encodeEventLog("Swap", [pool, fx.addresses.trader, amount0, amount1, Q96, 10n ** 18n, 0, 0]);
  return { address: A.poolManager, topics: e.topics, data: e.data, blockNumber: 10, transactionHash: tx, index: i };
}
function feeLog(pool: string, i: number, buy: boolean, curve: bigint, tx = "0xaa", graduated = false) {
  const e = hookI.encodeEventLog("HookFee", [pool, fx.addresses.trader, ethers.ZeroAddress, buy, graduated, curve, curve / 50n, 200, (curve / 50n) * 560n / 10_000n]);
  return { address: A.hook, topics: e.topics, data: e.data, blockNumber: 10, transactionHash: tx, index: i };
}
const dec = (logs: any[]) => logs.map((l) => decodeGen8Log(l, A)!).filter(Boolean);

test("join: several swaps of one pool in one transaction, every order, and another pool in between", () => {
  const other = ethers.id("other-pool");
  const logs = [
    swapLog(POOL, 1, -100n, 5n), feeLog(POOL, 3, true, 100n), // exact-out buy: S then (mint) H
    feeLog(POOL, 4, true, 200n), swapLog(POOL, 5, -200n, 9n), // exact-in buy: H then S
    swapLog(other, 6, -7n, 1n), feeLog(other, 8, true, 7n), // a pool that is not ours (ignored)
    feeLog(POOL, 9, false, 300n), swapLog(POOL, 10, 300n, -11n), // exact-out sell: H then S
    swapLog(POOL, 11, 400n, -13n), feeLog(POOL, 13, false, 400n), // exact-in sell: S then H
  ];
  const j = joinSwapsWithFees(dec(logs), new Set([POOL]));
  assert.deepEqual(j.joined.map((x) => x.type), ["buy_exact_out", "buy_exact_in", "sell_exact_out", "sell_exact_in"]);
  assert.deepEqual(j.joined.map((x) => x.coinRaw), [5n, 9n, 11n, 13n]);
  assert.ok(j.joined.every((x) => x.anomalies.length === 0));
  assert.equal(j.orphanFees.length + j.orphanSwaps.length, 0);
});

test("join: orphans are reported, never paired across transactions", () => {
  const logs = [swapLog(POOL, 1, -100n, 5n, "0x01"), feeLog(POOL, 0, true, 100n, "0x02")];
  const j = joinSwapsWithFees(dec(logs), new Set([POOL]));
  assert.equal(j.joined.length, 0);
  assert.equal(j.orphanSwaps.length, 1);
  assert.equal(j.orphanFees.length, 1);
  assert.equal(groupByTx(dec(logs)).size, 2);
});

test("join: a direction or amount mismatch is flagged as an anomaly", () => {
  const j = joinSwapsWithFees(dec([feeLog(POOL, 1, false, 100n), swapLog(POOL, 2, -101n, 5n)]), new Set([POOL]));
  assert.deepEqual(j.joined[0]!.anomalies.sort(), ["curve_amount_mismatch", "direction_mismatch"]);
});

test("price, market cap and progress from sqrtPriceX96 (exact integer maths)", () => {
  const pl = decodeStep("launch_with_first_buy")[0] as Extract<Gen8Event, { kind: "PoolLaunched" }>;
  const sqrtStart = sqrtAtTick(pl.tickStart);
  assert.equal(gen8Progress({ liqA: pl.liqA, tickStart: pl.tickStart, tickGrad: pl.tickGrad, sqrtPriceX96: sqrtStart }).bps, 0);
  const atGrad = gen8Progress({ liqA: pl.liqA, tickStart: pl.tickStart, tickGrad: pl.tickGrad, sqrtPriceX96: sqrtAtTick(pl.tickGrad) });
  assert.equal(atGrad.complete, true);
  // A holds 850M coins (minus seed dust): capacity within 1 coin of 850M
  assert.ok(850_000_000n * WAD - atGrad.capacityRaw < WAD, String(atGrad.capacityRaw));
  // price = 2^192 / sqrtP^2 per coin; at tick 0 price is 1 native per coin
  assert.equal(nativePerCoinWei(Q96), WAD);
  assert.equal(marketCapWei(Q96), 1_000_000_000n * WAD);
  // after the crossing the pool price is at or below sqrtGrad
  const swap = decodeStep("crossing_buy").find((e) => e.kind === "Swap") as Extract<Gen8Event, { kind: "Swap" }>;
  assert.ok(swap.sqrtPriceX96 <= sqrtAtTick(pl.tickGrad));
  const held = gen8PoolHoldings({ liqA: pl.liqA, liqB: pl.liqB, tickStart: pl.tickStart, tickGrad: pl.tickGrad, sqrtPriceX96: swap.sqrtPriceX96, graduated: true });
  assert.ok(held.native > 0n && held.coins > 0n && held.liquidityNativeWei > held.native);
});

test("inert without env: no chain, no config; partial or invalid env disables the chain", () => {
  assert.deepEqual(configuredGen8Chains({}), []);
  assert.equal(evmGen8Config(56, {}).reason, "unset");
  assert.equal(evmGen8Config(56, { EVM_GEN8_LAUNCHER_56: `${A.launcher}@1` }).config, null);
  assert.equal(evmGen8Config(97, { EVM_GEN8_LAUNCHER_97: `${A.launcher}@1`, EVM_GEN8_HOOK_97: `${A.hook}@1` }).config, null, "testnets need EVM_GEN8_POOL_MANAGER_97");
  assert.equal(evmGen8Config(56, { EVM_GEN8_LAUNCHER_56: "nope", EVM_GEN8_HOOK_56: `${A.hook}@1` }).config, null);
  const ok = evmGen8Config(56, { EVM_GEN8_LAUNCHER_56: `${A.launcher}@100`, EVM_GEN8_HOOK_56: `${A.hook}@90` }).config!;
  assert.equal(ok.poolManager, "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df", "canonical PoolManager on 56");
  assert.equal(ok.startBlock, 90);
  assert.equal(ok.splitter, null);
});

test("inert without env: starting the gen-8 loops with no env touches no RPC and no database", async () => {
  process.env.DATABASE_URL ||= "postgres://unused@127.0.0.1:1/unused";
  process.env.RUNTIME_ENVIRONMENT ||= "local";
  process.env.PG_DISABLE_SSL ||= "1";
  const { startEvmGen8Indexer } = await import("../evm/evmGen8Pool.js");
  let calls = 0;
  const db = { query: async () => { calls += 1; return { rows: [] }; } };
  startEvmGen8Indexer({ db, providerFor: () => { calls += 1; return null; }, env: {} });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 0);
});

test("holders: Transfer deltas net per wallet; mints from 0x0 are not a holder; exclusions", () => {
  const T = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
  const tok = "0x00000000000000000000000000000000000000c0";
  const a = "0x00000000000000000000000000000000000000a1";
  const b = "0x00000000000000000000000000000000000000b2";
  const mk = (f: string, t: string, v: bigint) => ({ address: tok, ...T.encodeEventLog("Transfer", [f, t, v]) });
  const d = transferDeltas([mk(ethers.ZeroAddress, a, 100n), mk(a, b, 30n), mk(b, a, 5n)]);
  assert.equal(d.get(tok)!.get(a), 75n);
  assert.equal(d.get(tok)!.get(b), 25n);
  assert.equal(d.get(tok)!.has(ethers.ZeroAddress), false);
  assert.equal(TRANSFER_TOPIC, ethers.id("Transfer(address,address,uint256)"));
  const cfg = evmGen8Config(56, { EVM_GEN8_LAUNCHER_56: `${A.launcher}@1`, EVM_GEN8_HOOK_56: `${A.hook}@1`, EVM_GEN8_RESERVE_LOCK_56: a, EVM_GEN8_ESCROW_56: b }).config!;
  const ex = gen8HolderExclusions(cfg).map((x) => x.wallet);
  for (const w of [cfg.poolManager, A.hook, DEAD, A.launcher, a, b]) assert.ok(ex.includes(w), w);
});

test("side pools: V2 / V3 / Solidly / V4 creation logs of our coin are found, ours and other coins are not", () => {
  const coin = "0x00000000000000000000000000000000000000c0";
  const weth = "0x00000000000000000000000000000000000000ff";
  const f2 = "0x00000000000000000000000000000000000000f2";
  const f3 = "0x00000000000000000000000000000000000000f3";
  const fs = "0x00000000000000000000000000000000000000f5";
  const I = new ethers.Interface([
    "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)",
    "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
  ]);
  const S = new ethers.Interface(["event PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256)"]);
  const L = (address: string, e: { topics: string[]; data: string }) => ({ address, topics: e.topics, data: e.data, blockNumber: 5, transactionHash: "0x05" });
  const logs = [
    L(f2, I.encodeEventLog("PairCreated", [coin, weth, "0x00000000000000000000000000000000000000d2", 1])),
    L(f3, I.encodeEventLog("PoolCreated", [coin, weth, 3000, 60, "0x00000000000000000000000000000000000000d3"])),
    L(fs, S.encodeEventLog("PoolCreated", [coin, weth, false, "0x00000000000000000000000000000000000000d5", 1])),
    L(f2, I.encodeEventLog("PairCreated", [weth, "0x00000000000000000000000000000000000000ee", "0x00000000000000000000000000000000000000d9", 2])),
    L(A.poolManager, pmI.encodeEventLog("Initialize", [ethers.id("side"), ethers.ZeroAddress, coin, 3000, 60, ethers.ZeroAddress, Q96, 0])),
    L(A.poolManager, pmI.encodeEventLog("Initialize", [POOL, ethers.ZeroAddress, coin, 0x800000, 10, A.hook, Q96, 0])),
  ];
  const found = findSidePools(logs, { tokens: new Set([coin]), factories: [{ venue: "v2", address: f2 }, { venue: "v3", address: f3 }, { venue: "solidly", address: fs }], poolManager: A.poolManager, hook: A.hook });
  assert.deepEqual(found.map((p) => p.venue), ["v2", "v3", "solidly", "v4"]);
  assert.equal(found[1]!.fee, 3000);
  assert.equal(found[3]!.hooks, ethers.ZeroAddress);
  // swap volume in coins
  const V2 = new ethers.Interface(["event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"]);
  const v2 = V2.encodeEventLog("Swap", [coin, 0, 7, 40, 0, coin]);
  assert.equal(sideSwapCoinVolume({ address: "0x", topics: v2.topics, data: v2.data, blockNumber: 1, transactionHash: "0x" }, { venue: "v2", coinIsToken0: true }), 40n);
  const V3 = new ethers.Interface(["event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"]);
  const v3 = V3.encodeEventLog("Swap", [coin, coin, -55, 3, Q96, 1, 0]);
  assert.equal(String(v3.topics[0]), SIDE_TOPICS.v3Swap);
  assert.equal(sideSwapCoinVolume({ address: "0x", topics: v3.topics, data: v3.data, blockNumber: 1, transactionHash: "0x" }, { venue: "v3", coinIsToken0: true }), 55n);
  assert.ok(sideFactories(56, {}).length >= 4);
  assert.deepEqual(sideFactories(4663, { EVM_GEN8_SIDE_FACTORIES_4663: `v2:${f2},bad:0x1` }), [{ venue: "v2", address: f2 }]);
});
