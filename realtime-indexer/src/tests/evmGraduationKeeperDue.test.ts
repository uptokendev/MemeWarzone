import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

import {
  GEN5_CAMPAIGN_IFACE_FULL,
  createEthersKeeperReader,
  curvePriceToSqrtX96,
  decideKeeperStep,
  isLikelyDue,
  listDueCampaigns,
  listTradingDueCandidates,
  oraclePriceWad,
  partialRepairLimits,
  runEvmGraduationKeeperPass,
  stockRepairStopPriceWad,
  type CampaignChainState,
  type KeeperCall,
  type KeeperReader,
  type KeeperSender,
  type SimResult,
} from "../evm/evmGraduationKeeper.js";
import { keeperConfig } from "../evm/evmGraduationKeeperConfig.js";

const C = "0x00000000000000000000000000000000000000c1";
const C2 = "0x00000000000000000000000000000000000000c2";
const CFG = { maxGas: 10_000_000n, minFlushWei: 1n, maxRepairHalvings: 6 };
const E18 = 10n ** 18n;

function state(over: Partial<CampaignChainState> = {}): CampaignChainState {
  return { launched: false, graduationPending: false, pendingSince: 0n, quoteToken: null, nativeFallback: false, pendingProtocolFee: 0n, ...over };
}

function reader(opts: { state: CampaignChainState; sims: (call: KeeperCall) => SimResult; seen?: KeeperCall[]; due?: Record<string, { curveSupply: bigint; nativeTarget: bigint | null }> }): KeeperReader {
  return {
    async readCampaign() {
      return opts.state;
    },
    async simulate(_c, call) {
      opts.seen?.push(call);
      return opts.sims(call);
    },
    async blockTimestamp() {
      return 10n ** 9n;
    },
    async repairContext() {
      return null;
    },
    async dueInputs(c) {
      return opts.due?.[c] ?? null;
    },
  };
}

const ok = (gas: bigint, memeSold?: bigint): SimResult => ({ ok: true, gas, memeSold });
const fail = (error: string): SimResult => ({ ok: false, error });

// ------------------------------------------------------------------------------------------ due filter

test("isLikelyDue: sold out needs no oracle; otherwise net raise within the slack of the native target", () => {
  assert.equal(isLikelyDue({ netRaisedWei: 1n, soldRaw: 800n, curveSupply: 800n, nativeTarget: null, slackBps: 200 }), true);
  assert.equal(isLikelyDue({ netRaisedWei: 50n * E18, soldRaw: 1n, curveSupply: 800n, nativeTarget: 50n * E18, slackBps: 0 }), true);
  assert.equal(isLikelyDue({ netRaisedWei: 49n * E18, soldRaw: 1n, curveSupply: 800n, nativeTarget: 50n * E18, slackBps: 200 }), true); // 98%
  assert.equal(isLikelyDue({ netRaisedWei: 48n * E18, soldRaw: 1n, curveSupply: 800n, nativeTarget: 50n * E18, slackBps: 200 }), false); // 96%
  assert.equal(isLikelyDue({ netRaisedWei: 60n * E18, soldRaw: 1n, curveSupply: 800n, nativeTarget: null, slackBps: 200 }), false); // oracle down
  assert.equal(isLikelyDue({ netRaisedWei: 0n, soldRaw: 0n, curveSupply: 800n, nativeTarget: 1n, slackBps: 200 }), false);
});

test("due candidate, not Pending: graduate() simulates -> send; GraduationNotDue / TradingNotOpen -> idle, never blocked", async () => {
  const d = await decideKeeperStep(reader({ state: state(), sims: () => ok(3_000_000n) }), C, CFG, { dueCandidate: true });
  assert.equal(d.kind, "send");
  assert.equal(d.kind === "send" && d.call.fn, "graduate");
  assert.equal(d.reason, "due, not pending");
  for (const error of ["GraduationNotDue", "TradingNotOpen"]) {
    const idle = await decideKeeperStep(reader({ state: state(), sims: () => fail(error) }), C, CFG, { dueCandidate: true });
    assert.deepEqual(idle, { kind: "idle", reason: `not due (${error})` });
  }
  // Not a due candidate: no simulation at all (unchanged behaviour for listed Pending rows that moved on).
  const seen: KeeperCall[] = [];
  const plain = await decideKeeperStep(reader({ state: state(), sims: () => ok(1n), seen }), C, CFG);
  assert.equal(plain.kind, "idle");
  assert.equal(seen.length, 0);
});

test("due candidate whose graduate() fails for another reason: repairPool (which enters Pending) is tried; never the E12 fallback", async () => {
  const seen: KeeperCall[] = [];
  const sims = (call: KeeperCall) => (call.fn === "graduate" ? fail("AdapterResultInvalid") : call.fn === "repairPool" ? ok(2_000_000n, 5n) : ok(1n));
  const d = await decideKeeperStep(reader({ state: state({ quoteToken: "0x00000000000000000000000000000000000000d3" }), sims, seen }), C, CFG, { dueCandidate: true });
  assert.equal(d.kind === "send" && d.call.fn, "repairPool");

  const seen2: KeeperCall[] = [];
  const blocked = await decideKeeperStep(
    reader({ state: state({ quoteToken: "0x00000000000000000000000000000000000000d3" }), sims: () => fail("OracleStale"), seen: seen2 }),
    C,
    CFG,
    { dueCandidate: true },
  );
  assert.equal(blocked.kind, "blocked");
  assert.ok(!seen2.some((c) => c.fn === "useNativeFallback"), "pendingSince is 0 before Pending; the fallback is only for Pending coins");
});

function dueDb(rows: Array<{ campaign_address: string; net_raised_raw: string; sold_raw: string }>) {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  return {
    seen,
    async query(sql: string, params: unknown[] = []) {
      seen.push({ sql, params });
      if (/join public\.curve_trades t/.test(sql)) return { rows };
      return { rows: [] };
    },
  };
}

test("indexed candidates: gen-5 campaigns still trading, net raise from gross (fallback bnb_amount_raw), largest first", async () => {
  const db = dueDb([{ campaign_address: C.toUpperCase().replace("0X", "0x"), net_raised_raw: "49000000000000000000.000", sold_raw: "12" }]);
  const out = await listTradingDueCandidates(db, 56, 7);
  assert.deepEqual(out, [{ campaign: C, netRaisedWei: 49n * E18, soldRaw: 12n }]);
  const q = db.seen[0];
  assert.deepEqual(q.params, [56, 7]);
  assert.match(q.sql, /coalesce\(c\.campaign_generation, 0\) >= 5/);
  assert.match(q.sql, /coalesce\(s\.graduation_stage, 'trading'\) = 'trading'/);
  assert.match(q.sql, /coalesce\(t\.gross_raw, t\.bnb_amount_raw::numeric\)/);
  assert.match(q.sql, /c\.graduated_block is null/);
});

test("listDueCampaigns keeps only candidates the cheap filter passes; no dueInputs reader -> nothing", async () => {
  const db = dueDb([
    { campaign_address: C, net_raised_raw: String(49n * E18), sold_raw: "1" },
    { campaign_address: C2, net_raised_raw: String(10n * E18), sold_raw: "1" },
  ]);
  const r = reader({
    state: state(),
    sims: () => ok(1n),
    due: { [C]: { curveSupply: 800n, nativeTarget: 50n * E18 }, [C2]: { curveSupply: 800n, nativeTarget: 50n * E18 } },
  });
  assert.deepEqual(await listDueCampaigns({ db, chainId: 56, reader: r, cfg: { ...CFG, dueSlackBps: 200 } }), [C]);
  const bare = { ...r, dueInputs: undefined };
  assert.deepEqual(await listDueCampaigns({ db, chainId: 56, reader: bare, cfg: CFG }), []);
  assert.deepEqual(await listDueCampaigns({ db, chainId: 56, reader: r, cfg: { ...CFG, maxDueCandidates: 0 } }), []);
});

test("a pass lists Pending campaigns and due candidates; a due candidate is graduated (dry run: decided, nothing signed)", async () => {
  const db = {
    async query(sql: string) {
      if (/join public\.curve_trades t/.test(sql)) return { rows: [{ campaign_address: C2, net_raised_raw: String(51n * E18), sold_raw: "1" }] };
      if (/from public\.campaigns c\s+left join public\.evm_campaign_gen5_state/.test(sql)) return { rows: [{ campaign_address: C }] };
      return { rows: [] };
    },
  };
  const states: Record<string, CampaignChainState> = { [C]: state({ graduationPending: true, pendingSince: 5n }), [C2]: state() };
  const r: KeeperReader = {
    ...reader({ state: state(), sims: () => ok(2_000_000n), due: { [C2]: { curveSupply: 800n, nativeTarget: 50n * E18 } } }),
    async readCampaign(c) {
      return states[c];
    },
  };
  const sender: KeeperSender = {
    address: "0x00000000000000000000000000000000000000Ee",
    async getNonce() {
      return 0;
    },
    async getReceipt() {
      return null;
    },
    async sign() {
      throw new Error("dry run must not sign");
    },
    async broadcast() {
      throw new Error("dry run must not broadcast");
    },
  };
  const res = await runEvmGraduationKeeperPass({ db, chainId: 56, reader: r, sender, cfg: CFG, send: false });
  assert.deepEqual(res.steps.map((s) => [s.campaign, s.decision.kind, s.decision.reason]), [
    [C, "send", "pending"],
    [C2, "send", "due, not pending"],
  ]);
});

test("keeper config: due slack and candidate cap from env, clamped", () => {
  assert.equal(keeperConfig(56, {} as any).dueSlackBps, 200);
  assert.equal(keeperConfig(56, {} as any).maxDueCandidates, 25);
  assert.equal(keeperConfig(56, { EVM_GRADUATION_KEEPER_DUE_SLACK_BPS: "50", EVM_GRADUATION_KEEPER_MAX_DUE_CANDIDATES: "0" } as any).dueSlackBps, 50);
  assert.equal(keeperConfig(56, { EVM_GRADUATION_KEEPER_MAX_DUE_CANDIDATES: "0" } as any).maxDueCandidates, 0);
  assert.equal(keeperConfig(56, { EVM_GRADUATION_KEEPER_DUE_SLACK_BPS: "99999" } as any).dueSlackBps, 10_000);
});

// ------------------------------------------------------------------------------------------ stock partial repair

test("Chainlink answers to WAD like the adapter", () => {
  assert.equal(oraclePriceWad(3_000n * 10n ** 8n, 8), 3_000n * E18);
  assert.equal(oraclePriceWad(5n * 10n ** 20n, 20), 5n * E18);
  assert.equal(oraclePriceWad(0n, 8), null);
  assert.equal(oraclePriceWad(-1n, 8), null);
});

test("stock repair stop = P * ETHUSD / STOCKUSD in stock raw per MEME, raised by the margin (mulDiv floors)", () => {
  // P = 1e-6 ETH per MEME, ETH $3000, stock $500 (18 decimals): 6e-6 stock per MEME, +5%.
  const stop = stockRepairStopPriceWad({ curvePriceWad: 10n ** 12n, nativeUsdWad: 3_000n * E18, stockUsdWad: 500n * E18, stockUnit: E18, marginBps: 500n });
  assert.equal(stop, (6n * 10n ** 12n * 10_500n) / 10_000n);
  // 6-decimal stock: raw units scale with the stock's unit.
  const stop6 = stockRepairStopPriceWad({ curvePriceWad: 10n ** 12n, nativeUsdWad: 3_000n * E18, stockUsdWad: 500n * E18, stockUnit: 10n ** 6n, marginBps: 0n });
  assert.equal(stop6, 6n);
  assert.equal(stockRepairStopPriceWad({ curvePriceWad: 1n, nativeUsdWad: 1n, stockUsdWad: 0n, stockUnit: E18, marginBps: 0n }), 0n);
});

test("stock partial limits lie strictly between the pool price and the adapter's stop, both orders", () => {
  const stop = stockRepairStopPriceWad({ curvePriceWad: 10n ** 12n, nativeUsdWad: 3_000n * E18, stockUsdWad: 500n * E18, stockUnit: E18, marginBps: 500n });
  for (const memeIs0 of [true, false]) {
    const target = curvePriceToSqrtX96(stop, memeIs0);
    // A griefed pool: MEME priced 4x the stop (seeded bids above the curve).
    const current = curvePriceToSqrtX96(stop * 4n, memeIs0);
    const limits = partialRepairLimits({ currentSqrtX96: current, targetSqrtX96: target }, 6);
    assert.equal(limits.length, 6);
    for (const l of limits) {
      const inside = current > target ? l > target && l < current : l < target && l > current;
      assert.ok(inside, `limit ${l} outside (${target}, ${current})`);
    }
  }
});

test("ethers reader: a MEME/STOCK pool gets a repair context from the adapter's feeds (was: none)", async () => {
  const meme = "0x00000000000000000000000000000000000000a1";
  const stock = "0x00000000000000000000000000000000000000d3";
  const adapter = "0x00000000000000000000000000000000000000f5";
  const v3f = "0x0000000000000000000000000000000000000106";
  const weth = "0x0000000000000000000000000000000000000107";
  const poolAddr = "0x00000000000000000000000000000000000000e4";
  const ethFeed = "0x0000000000000000000000000000000000000fe1";
  const stockFeed = "0x0000000000000000000000000000000000000fe2";
  const P = 10n ** 12n;
  const iface = (sigs: string[]) => new ethers.Interface(sigs);
  const adapterI = iface([
    "function v3Factory() view returns (address)",
    "function WETH() view returns (address)",
    "function POOL_FEE() view returns (uint24)",
    "function nativeUsdOracle() view returns (address)",
    "function REPAIR_STEP_MARGIN_BPS() view returns (uint256)",
    "function stockRoutes(address) view returns (address oracleFeed, address acquisitionPool, uint24 acquisitionFeeTier, uint256 minimumRouteLiquidityUsdWad, uint16 maxSwapSlippageBps, uint16 maxOracleDeviationBps, uint16 maxPriceImpactBps, bool enabled)",
  ]);
  const factoryI = iface(["function getPool(address,address,uint24) view returns (address)"]);
  const poolI = iface(["function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)", "function token0() view returns (address)"]);
  const feedI = iface(["function latestRoundData() view returns (uint80,int256 answer,uint256,uint256,uint80)", "function decimals() view returns (uint8)"]);
  const stop = stockRepairStopPriceWad({ curvePriceWad: P, nativeUsdWad: 3_000n * E18, stockUsdWad: 500n * E18, stockUnit: E18, marginBps: 500n });
  const current = curvePriceToSqrtX96(stop * 4n, true);
  const table = new Map<string, string>();
  const on = (to: string, i: ethers.Interface, fn: string, values: unknown[]) => table.set(`${to}:${i.getFunction(fn)!.selector}`, i.encodeFunctionResult(fn, values));
  const campaignI = GEN5_CAMPAIGN_IFACE_FULL;
  on(C, campaignI, "token", [meme]);
  on(C, campaignI, "graduationQuoteToken", [stock]);
  on(C, campaignI, "nativeFallback", [false]);
  on(C, campaignI, "graduationAdapter", [adapter]);
  on(C, campaignI, "getGraduationState", [ethers.ZeroAddress, P, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]);
  on(adapter, adapterI, "v3Factory", [v3f]);
  on(adapter, adapterI, "WETH", [weth]);
  on(adapter, adapterI, "POOL_FEE", [3000]);
  on(adapter, adapterI, "nativeUsdOracle", [ethFeed]);
  on(adapter, adapterI, "REPAIR_STEP_MARGIN_BPS", [500n]);
  on(adapter, adapterI, "stockRoutes", [stockFeed, ethers.ZeroAddress, 3000, 0n, 100, 0, 0, true]);
  on(v3f, factoryI, "getPool", [poolAddr]);
  on(poolAddr, poolI, "slot0", [current, 0, 0, 0, 0, 0, true]);
  on(poolAddr, poolI, "token0", [meme]);
  on(ethFeed, feedI, "latestRoundData", [1n, 3_000n * 10n ** 8n, 0n, 1n, 1n]);
  on(ethFeed, feedI, "decimals", [8]);
  on(stockFeed, feedI, "latestRoundData", [1n, 500n * 10n ** 8n, 0n, 1n, 1n]);
  on(stockFeed, feedI, "decimals", [8]);
  on(stock, iface(["function decimals() view returns (uint8)"]), "decimals", [18]);
  const provider = {
    async call(tx: any) {
      const hit = table.get(`${String(tx.to).toLowerCase()}:${String(tx.data).slice(0, 10)}`);
      if (!hit) throw Object.assign(new Error("execution reverted"), { data: "0x" });
      return hit;
    },
  } as unknown as ethers.Provider;
  const r = createEthersKeeperReader(provider, 4663, "0x00000000000000000000000000000000000000Ee", {} as any);
  const ctx = await r.repairContext(C);
  assert.deepEqual(ctx, { currentSqrtX96: current, targetSqrtX96: curvePriceToSqrtX96(stop, true) });
});
