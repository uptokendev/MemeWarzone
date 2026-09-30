import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

process.env.DATABASE_URL ||= "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
process.env.ABLY_API_KEY ||= "test.test";
process.env.ENABLE_GRADUATION_HANDOFF_RECONCILER = "0";

const { GEN5_CAMPAIGN_IFACE, GEN5_TOPICS } = await import("../evm/evmGen5CampaignLogs.js");
const {
  GEN5_ADAPTER_VIEW_ABI,
  GEN5_GRADUATED_TOPIC,
  classifyGen5TopazPool,
  expectedGen5PoolQuote,
  gen5GraduatedSnapshot,
  splitReserves,
  storedGraduatedFromRow,
} = await import("../evm/evmGen5Handoff.js");
const { GEN5_NON_TRADE_TOPICS, planGen5Backfill } = await import("../evm/evmGen5Backfill.js");
const { GEN5_CAMPAIGN_ABI } = await import("../evm/evmGen5Abi.js");
const { TOPAZ_FACTORY_ABI, TOPAZ_POOL_ABI, LAUNCH_CAMPAIGN_ABI } = await import("../abis.js");
const { pool } = await import("../db.js");
const { reconcileGen5GraduationHandoff } = await import("../marketContinuity.js");

const C = "0x00000000000000000000000000000000000000c1";
const T = "0x00000000000000000000000000000000000000a1"; // MEME
const W = "0x00000000000000000000000000000000000000b2"; // WBNB
const Q = "0x00000000000000000000000000000000000000d3"; // bound quote (e.g. USDT)
const P = "0x00000000000000000000000000000000000000e4"; // pool
const P2 = "0x00000000000000000000000000000000000000e5"; // the MEME/WBNB pool (fallback case)
const A = "0x00000000000000000000000000000000000000f5"; // graduation adapter
const TF = "0x0000000000000000000000000000000000000106"; // Topaz pool factory
const R = "0x0000000000000000000000000000000000000107"; // Topaz router
const LF = "0x0000000000000000000000000000000000000108"; // launch factory
const CREATOR = "0x0000000000000000000000000000000000000c0e";
const ALICE = "0x0000000000000000000000000000000000000a11";
const TX = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

function graduatedArgs(pool = P) {
  return [pool, 100n, 2n, 19n, 79n, 5_000n, 7n, 11n, 12n, false] as const;
}

function graduatedLog(pool = P, block = 50, index = 3) {
  const enc = GEN5_CAMPAIGN_IFACE.encodeEventLog("Graduated", [...graduatedArgs(pool)]);
  return { topics: enc.topics, data: enc.data, transactionHash: TX(block), index, blockNumber: block };
}

const STATE = {
  dexPair: P,
  finalCurvePrice: 11n,
  initialDexPrice: 12n,
  graduatedLiquidityTokens: 5_000n,
  graduatedLiquidityBnb: 78n,
  graduatedLiquidityLp: 999n,
  burnedUnsoldTokens: 7n,
  burnedUnusedLpTokens: 0n,
  postBurnTotalSupply: 123_456n,
  graduationBalance: 100n,
  graduationOvershoot: 1n,
};

// ------------------------------------------------------------------------------------------ pure helpers

test("Graduated snapshot: pool, shares and burn from the event; LP, pool native and supply from getGraduationState", () => {
  const parsed = GEN5_CAMPAIGN_IFACE.parseLog(graduatedLog())!;
  const bare = gen5GraduatedSnapshot(parsed.args);
  assert.equal(bare.pair, P);
  assert.equal(bare.graduationBalanceRaw, "100");
  assert.equal(bare.protocolFeeRaw, "2");
  assert.equal(bare.creatorPayoutRaw, "19");
  assert.equal(bare.liquidityBnbRaw, "79"); // event poolNative when the state is unknown
  assert.equal(bare.liquidityTokenRaw, "5000");
  assert.equal(bare.burnedUnsoldTokenRaw, "7");
  assert.equal(bare.finalCurvePriceRaw, "11");
  assert.equal(bare.initialDexPriceRaw, "12");
  assert.equal(bare.liquidityLpRaw, "0");

  const full = gen5GraduatedSnapshot(parsed.args, STATE, CREATOR);
  assert.equal(full.liquidityBnbRaw, "78"); // native that stayed in the pool (poolNative - refund)
  assert.equal(full.liquidityLpRaw, "999");
  assert.equal(full.postBurnTotalSupplyRaw, "123456");
  assert.equal(full.graduationOvershootRaw, "1");
  assert.equal(full.caller, CREATOR);

  // Stored JSON (evm_campaign_events.args) gives the same figures.
  const stored = gen5GraduatedSnapshot({ pool: P, raise: "100", protocolShare: "2", creatorShare: "19", poolNative: "79", memeUsed: "5000", memeBurned: "7", curvePrice: "11", startPrice: "12", repaired: false });
  assert.deepEqual(stored, bare);
});

test("expected pool quote: bound quote for a quote coin; WBNB for a native coin and after the E12 fallback", () => {
  assert.equal(expectedGen5PoolQuote({ quoteToken: Q, nativeFallback: false, wrappedNative: W }), Q);
  assert.equal(expectedGen5PoolQuote({ quoteToken: ethers.ZeroAddress, nativeFallback: false, wrappedNative: W }), W);
  assert.equal(expectedGen5PoolQuote({ quoteToken: null, nativeFallback: false, wrappedNative: W }), W);
  assert.equal(expectedGen5PoolQuote({ quoteToken: Q, nativeFallback: true, wrappedNative: W }), W);
});

test("Topaz classification: MEME/QUOTE and MEME/WBNB pools verify against their expected quote only", () => {
  const base = { pairPresent: true, pairMatchesFactory: true, token: T, stable: false, reservesPresent: true, feeVerified: true };
  assert.equal(classifyGen5TopazPool({ ...base, expectedQuote: Q, token0: T, token1: Q }).marketStage, "TOPAZ_ACTIVE");
  assert.equal(classifyGen5TopazPool({ ...base, expectedQuote: W, token0: W, token1: T }).marketStage, "TOPAZ_ACTIVE");
  const wrong = classifyGen5TopazPool({ ...base, expectedQuote: W, token0: T, token1: Q });
  assert.equal(wrong.marketStage, "TOPAZ_DEGRADED");
  assert.match(wrong.reason || "", /token\/quote pool mismatch/);
  assert.match(classifyGen5TopazPool({ ...base, expectedQuote: Q, token0: T, token1: Q, stable: true }).reason || "", /not volatile/);
  assert.equal(classifyGen5TopazPool({ ...base, pairPresent: false, expectedQuote: Q, token0: T, token1: Q }).marketStage, "TOPAZ_PENDING");
});

test("reserves split by token side whatever the pool order", () => {
  assert.deepEqual(splitReserves({ token: T, token0: T, reserve0: 5n, reserve1: 9n }), { reserveTokenRaw: "5", reserveQuoteRaw: "9" });
  assert.deepEqual(splitReserves({ token: T, token0: Q, reserve0: 5n, reserve1: 9n }), { reserveTokenRaw: "9", reserveQuoteRaw: "5" });
});

test("stored Graduated rows: accepted with a pool and a real anchor, refused otherwise", () => {
  const ok = storedGraduatedFromRow({ tx_hash: TX(9).toUpperCase().replace("0X", "0x"), block_number: "50", block_time: "2026-09-30T00:00:00Z", args: { pool: P } });
  assert.equal(ok?.blockNumber, 50);
  assert.equal(ok?.txHash, TX(9));
  assert.equal(storedGraduatedFromRow({ tx_hash: TX(9), block_number: 50, args: JSON.stringify({ pool: P }) })?.args.pool, P);
  assert.equal(storedGraduatedFromRow({ tx_hash: TX(9), block_number: 50, args: { pool: ethers.ZeroAddress } }), null);
  assert.equal(storedGraduatedFromRow({ tx_hash: "0x12", block_number: 50, args: { pool: P } }), null);
  assert.equal(storedGraduatedFromRow(undefined), null);
});

test("the Graduated topic differs from the old CampaignFinalized (a gen-5 coin never matches the old search)", () => {
  const old = new ethers.Interface(LAUNCH_CAMPAIGN_ABI).getEvent("CampaignFinalized")!.topicHash;
  assert.notEqual(GEN5_GRADUATED_TOPIC, old);
  assert.equal(GEN5_GRADUATED_TOPIC, GEN5_TOPICS.graduated);
});

// ------------------------------------------------------------------------------------------ backfill plan

test("history repair plan: trades annotated like the campaign scan (first buy, anti-sniper, escrow), events kept", () => {
  const info = { campaign: C, factory: LF, factoryGeneration: 6, campaignGeneration: 5, gen5: true, creator: CREATOR, launchAt: 1_000n, baseFeeBps: 200n };
  const log = (name: string, args: unknown[], block: number, index: number, tx = TX(block)) => {
    const enc = GEN5_CAMPAIGN_IFACE.encodeEventLog(name, args);
    return { topics: enc.topics, data: enc.data, transactionHash: tx, index, blockNumber: block };
  };
  // First buy at create: costNoFee 1000, flat 2% fee 20.
  const fb = log("CreatorFirstBuy", [CREATOR, 10n, 1_000n, 20n], 10, 0);
  const fbTrade = log("TokensPurchased", [CREATOR, 10n, 1_020n], 10, 1);
  // Alice at launchAt + 1: 5000 - 80 = 4920 bps; costNoFee 10000 -> fee 4920.
  const aliceBuy = log("TokensPurchased", [ALICE, 5n, 14_920n], 11, 0);
  // Creator buys again after the window: escrow, 2%.
  const escrowBuy = log("TokensPurchased", [CREATOR, 3n, 5_100n], 12, 0);
  const sell = log("TokensSold", [ALICE, 2n, 9_825n], 13, 0); // gross 10025, fee 200 (unique inverse)
  const grad = graduatedLog(P, 14, 0);
  const times: Record<number, number> = { 10: 900, 11: 1_001, 12: 1_100, 13: 1_200, 14: 1_300 };
  const plan = planGen5Backfill(info, [sell, grad, fbTrade, fb, aliceBuy, escrowBuy, aliceBuy], (n) => times[n]);

  assert.equal(plan.trades.length, 4); // duplicate aliceBuy dropped
  const [first, alice, escrow, s] = plan.trades;
  assert.equal(first.annotation.creatorBuyKind, "first_buy");
  assert.equal(first.annotation.feeRaw, 20n);
  assert.equal(first.annotation.leagueExcluded, true);
  assert.equal(alice.annotation.feeBps, 4920);
  assert.equal(alice.annotation.feeRaw, 4_920n);
  assert.equal(alice.annotation.grossRaw, 10_000n);
  assert.equal(alice.annotation.leagueExcluded, false);
  assert.equal(escrow.annotation.creatorBuyKind, "escrow");
  assert.equal(escrow.annotation.feeRaw, 100n);
  assert.equal(escrow.annotation.leagueExcluded, true);
  assert.equal(s.side, "sell");
  assert.equal(s.annotation.grossRaw, 10_025n);
  assert.equal(s.annotation.feeRaw, 200n);
  assert.deepEqual(plan.events.map((e) => GEN5_CAMPAIGN_IFACE.parseLog(e as any)!.name), ["CreatorFirstBuy", "Graduated"]);
});

test("repair's extra filter covers every non-trade gen-5 event and no trade topic", () => {
  assert.ok(!GEN5_NON_TRADE_TOPICS.includes(GEN5_TOPICS.buy));
  assert.ok(!GEN5_NON_TRADE_TOPICS.includes(GEN5_TOPICS.sell));
  assert.ok(GEN5_NON_TRADE_TOPICS.includes(GEN5_TOPICS.graduated));
  assert.ok(GEN5_NON_TRADE_TOPICS.includes(GEN5_TOPICS.firstBuy));
  let events = 0;
  GEN5_CAMPAIGN_IFACE.forEachEvent(() => {
    events += 1;
  });
  assert.equal(GEN5_NON_TRADE_TOPICS.length, events - 2);
});

// ------------------------------------------------------------------------------------------ handoff (chain + db mocked)

type Handler = () => string;

function chain(opts: { quote: string; fallback: boolean; poolTokens: [string, string]; factoryPool: Record<string, string>; adapterRouter?: boolean }) {
  const campaignIface = new ethers.Interface(GEN5_CAMPAIGN_ABI as unknown as string[]);
  const adapterIface = new ethers.Interface(GEN5_ADAPTER_VIEW_ABI as unknown as string[]);
  const factoryIface = new ethers.Interface(TOPAZ_FACTORY_ABI);
  const poolIface = new ethers.Interface(TOPAZ_POOL_ABI);
  const table = new Map<string, (data: string) => string>();
  const on = (to: string, iface: ethers.Interface, fn: string, handler: (data: string) => unknown[]) => {
    const f = iface.getFunction(fn)!;
    table.set(`${to.toLowerCase()}:${f.selector}`, (data) => iface.encodeFunctionResult(f, handler(data) as any[]));
  };
  on(C, campaignIface, "token", () => [T]);
  on(C, campaignIface, "graduationAdapter", () => [A]);
  on(C, campaignIface, "factory", () => [LF]);
  on(C, campaignIface, "graduationQuoteToken", () => [opts.quote]);
  on(C, campaignIface, "nativeFallback", () => [opts.fallback]);
  on(C, campaignIface, "getGraduationState", () => [
    STATE.dexPair, STATE.finalCurvePrice, STATE.initialDexPrice, STATE.graduatedLiquidityTokens, STATE.graduatedLiquidityBnb,
    STATE.graduatedLiquidityLp, STATE.burnedUnsoldTokens, STATE.burnedUnusedLpTokens, STATE.postBurnTotalSupply,
    STATE.graduationBalance, STATE.graduationOvershoot,
  ]);
  on(A, adapterIface, "topazFactory", () => [TF]);
  on(A, adapterIface, "WBNB", () => [W]);
  if (opts.adapterRouter) on(A, adapterIface, "topazRouter", () => [R]);
  const getPool = factoryIface.getFunction("getPool")!;
  table.set(`${TF}:${getPool.selector}`, (data) => {
    const [a, b] = factoryIface.decodeFunctionData(getPool, data);
    const key = [String(a).toLowerCase(), String(b).toLowerCase()].sort().join(":");
    return factoryIface.encodeFunctionResult(getPool, [opts.factoryPool[key] ?? ethers.ZeroAddress]);
  });
  const getFee = factoryIface.getFunction("getFee(address,bool)")!;
  table.set(`${TF}:${getFee.selector}`, () => factoryIface.encodeFunctionResult(getFee, [30n]));
  on(P, poolIface, "token0", () => [opts.poolTokens[0]]);
  on(P, poolIface, "token1", () => [opts.poolTokens[1]]);
  on(P, poolIface, "stable", () => [false]);
  on(P, poolIface, "getReserves", () => [4_000n, 70n, 1n]);
  const calls: string[] = [];
  const provider = {
    async call(tx: any) {
      const key = `${String(tx.to).toLowerCase()}:${String(tx.data).slice(0, 10)}`;
      calls.push(key);
      const h = table.get(key);
      if (!h) {
        const err: any = new Error("execution reverted");
        err.code = "CALL_EXCEPTION";
        err.data = "0x";
        throw err;
      }
      return h(String(tx.data));
    },
    async getCode(address: string) {
      return address.toLowerCase() === P ? "0x6000" : "0x";
    },
  } as unknown as ethers.Provider;
  return { provider, calls };
}

function recordingDb() {
  const queries: Array<{ sql: string; params: any[] }> = [];
  const q = async (sql: string, params: any[] = []) => {
    queries.push({ sql, params });
    return { rows: [], rowCount: 0 };
  };
  (pool as any).query = q;
  (pool as any).connect = async () => ({ query: q, release() {} });
  return queries;
}

const pairKey = (a: string, b: string) => [a, b].sort().join(":");
const BLOCK_TIME = new Date("2026-09-30T00:00:00Z");

test("gen-5 BNB handoff: a quote coin's MEME/QUOTE Topaz pool verifies ACTIVE and lands in dex_pools", async () => {
  const queries = recordingDb();
  const { provider, calls } = chain({ quote: Q, fallback: false, poolTokens: [T, Q], factoryPool: { [pairKey(T, Q)]: P }, adapterRouter: true });
  const parsed = GEN5_CAMPAIGN_IFACE.parseLog(graduatedLog())!;
  const result: any = await reconcileGen5GraduationHandoff({ provider, chainId: 56, campaignAddress: C, txHash: TX(50), blockNumber: 50, blockTime: BLOCK_TIME, args: parsed.args });
  assert.equal(result.marketStage, "TOPAZ_ACTIVE", result.reason);
  assert.equal(result.quoteTokenAddress, Q);
  assert.equal(result.pairAddress, P);
  assert.equal(result.routerAddress, R);
  assert.equal(result.reserveTokenRaw, "4000");
  assert.equal(result.reserveNativeRaw, "70");
  // No old-generation read: gen 5 has no router().
  const routerSel = new ethers.Interface(LAUNCH_CAMPAIGN_ABI).getFunction("router")!.selector;
  assert.ok(!calls.some((k) => k === `${C}:${routerSel}`));

  const cms = queries.find((x) => /insert into public\.campaign_market_state/.test(x.sql))!;
  assert.equal(cms.params[5], "TOPAZ_ACTIVE");
  assert.equal(cms.params[6], TX(50));
  assert.equal(cms.params[9], P);
  assert.equal(cms.params[11], TF);
  assert.equal(cms.params[12], W);
  assert.equal(cms.params[19], "999"); // LP from getGraduationState
  assert.equal(cms.params[17], "5000");
  assert.equal(cms.params[18], "78");
  const dex = queries.find((x) => /insert into public\.dex_pools/.test(x.sql))!;
  assert.deepEqual(dex.params.slice(0, 9), [56, P, C, T, W, R, TF, T, Q]);
  assert.equal(dex.params[9], 30);
  assert.deepEqual(dex.params.slice(11), ["4000", "70"]);
  const camp = queries.find((x) => /update public\.campaigns/.test(x.sql))!;
  assert.equal(camp.params[2], "TOPAZ_ACTIVE");
  assert.ok(queries.some((x) => x.sql.trim() === "commit"));
});

test("gen-5 BNB handoff: a native coin's MEME/WBNB pool verifies; router from EVM_TOPAZ_ROUTER_<id> when the adapter has none", async () => {
  process.env.EVM_TOPAZ_ROUTER_56 = R;
  try {
    recordingDb();
    const { provider } = chain({ quote: ethers.ZeroAddress, fallback: false, poolTokens: [W, T], factoryPool: { [pairKey(T, W)]: P } });
    const parsed = GEN5_CAMPAIGN_IFACE.parseLog(graduatedLog())!;
    const result: any = await reconcileGen5GraduationHandoff({ provider, chainId: 56, campaignAddress: C, txHash: TX(50), blockNumber: 50, blockTime: BLOCK_TIME, args: parsed.args });
    assert.equal(result.marketStage, "TOPAZ_ACTIVE", result.reason);
    assert.equal(result.quoteTokenAddress, W);
    assert.equal(result.routerAddress, R);
    assert.equal(result.reserveTokenRaw, "70");
    assert.equal(result.reserveNativeRaw, "4000");
  } finally {
    delete process.env.EVM_TOPAZ_ROUTER_56;
  }
});

test("gen-5 BNB handoff: after the E12 fallback a MEME/QUOTE pool is not the market (degraded, no dex_pools row)", async () => {
  const queries = recordingDb();
  const { provider } = chain({ quote: Q, fallback: true, poolTokens: [T, Q], factoryPool: { [pairKey(T, Q)]: P, [pairKey(T, W)]: P2 } });
  const parsed = GEN5_CAMPAIGN_IFACE.parseLog(graduatedLog())!;
  const result: any = await reconcileGen5GraduationHandoff({ provider, chainId: 56, campaignAddress: C, txHash: TX(50), blockNumber: 50, blockTime: BLOCK_TIME, args: parsed.args });
  assert.equal(result.marketStage, "TOPAZ_DEGRADED");
  assert.match(result.reason, /factory pool mismatch/);
  assert.match(result.reason, /token\/quote pool mismatch/);
  assert.ok(!queries.some((x) => /insert into public\.dex_pools/.test(x.sql)));
});

test("gen-5 BNB handoff: an unreadable adapter is recorded as degraded with the reason, pool kept from the event", async () => {
  const queries = recordingDb();
  const { provider } = chain({ quote: Q, fallback: false, poolTokens: [T, Q], factoryPool: {} });
  (provider as any).call = async () => {
    throw new Error("rpc down");
  };
  const parsed = GEN5_CAMPAIGN_IFACE.parseLog(graduatedLog())!;
  const result: any = await reconcileGen5GraduationHandoff({ provider, chainId: 56, campaignAddress: C, txHash: TX(50), blockNumber: 50, blockTime: BLOCK_TIME, args: parsed.args });
  assert.equal(result.marketStage, "TOPAZ_DEGRADED");
  assert.match(result.reason, /token could not be resolved/);
  assert.equal(result.pairAddress, P);
  const failure = queries.find((x) => /'TOPAZ_DEGRADED'/.test(x.sql) && /insert into public\.campaign_market_state/.test(x.sql))!;
  assert.equal(failure.params[5], P);
});
