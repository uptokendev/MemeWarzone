import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ethers } from "ethers";

import { classifyScan, importScannerChainFamily, MIN_POOL_NATIVE, probeV2Pool, probeV3Pool, probeV4Pool, simulationFindings } from "./arenaImportScan.js";
import { IMPORT_SWAP_PROBE_ABI } from "./importSwapProbe/importSwapProbeArtifact.js";
import { decodeRoundTrip, revertReason } from "./importSwapProbe/simulateRoundTrip.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "0xe7dec18b0b29c8e02fb90a5dce413b3bc66e8251";
const ADDRS = {
  factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  quoter: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  router: "0xCaf681a66D020601342297493863E78C959E5cb2",
  fees: [100, 500, 3000, 10000],
  minDepth: 0n,
};
const POOL_1PCT = "0xD1c3AFDFec3b9933fb1826B667A12923911F4463";
const POOL_03PCT = "0x00000000000000000000000000000000000000Aa";
const ZERO = "0x0000000000000000000000000000000000000000";

/** Fake contracts: pools by fee tier, WETH depth per pool, and a quoter that answers per direction. */
function fakes({ pools = {}, depth = {}, buyOut = 10n ** 20n, sellOut = 10n ** 14n, getPoolThrows = false } = {}) {
  const quotes = [];
  const contract = (address) => {
    if (address === ADDRS.factory) {
      return {
        getPool: async (_a, _b, fee) => {
          if (getPoolThrows) throw new Error("rpc down");
          return pools[fee] || ZERO;
        },
      };
    }
    if (address === ADDRS.weth) return { balanceOf: async (pool) => depth[pool] ?? 0n };
    if (address === ADDRS.quoter) {
      return {
        quoteExactInputSingle: {
          staticCall: async (params) => {
            quotes.push(params);
            const out = params.tokenIn === ADDRS.weth ? buyOut : sellOut;
            if (out instanceof Error) throw Object.assign(out, { code: out.code || "CALL_EXCEPTION" });
            return [out, 0n, 0, 0n];
          },
        },
      };
    }
    throw new Error(`unexpected contract ${address}`);
  };
  const simulations = [];
  const simulate = async (_provider, args) => {
    simulations.push(args);
    return { ran: true, buyOk: true, sellOk: true, buyTaxBps: 0, sellTaxBps: 0, roundTripLossBps: 200 };
  };
  return { deps: { contract, simulate }, quotes, simulations };
}

test("Robinhood mainnet and testnet are scanned as EVM chains", () => {
  assert.equal(importScannerChainFamily(4663), "evm");
  assert.equal(importScannerChainFamily(46630), "evm");
});

test("picks the deepest WETH pool across fee tiers and quotes on its fee", async () => {
  const { deps, quotes, simulations } = fakes({ pools: { 3000: POOL_03PCT, 10000: POOL_1PCT }, depth: { [POOL_03PCT]: 5n, [POOL_1PCT]: 9n * 10n ** 18n } });
  const result = await probeV3Pool(null, TOKEN, ADDRS, deps);
  // The round trip is simulated on the chosen pool and fee, selling through the public router.
  assert.equal(simulations.length, 1);
  assert.deepEqual([simulations[0].kind, simulations[0].pool, simulations[0].router, simulations[0].v3Fee], [3, POOL_1PCT, ADDRS.router, 10000]);
  assert.equal(result.simulation.sellOk, true);
  assert.equal(result.pair, POOL_1PCT);
  assert.equal(result.fee, 10000);
  assert.equal(result.buyQuoteOk, true);
  assert.equal(result.sellQuoteOk, true);
  assert.deepEqual(quotes.map((q) => q.fee), [10000, 10000]);
  // The sell quote sells back exactly what the buy quote returned.
  assert.equal(quotes[1].tokenIn, TOKEN);
  assert.equal(quotes[1].amountIn, 10n ** 20n);
});

test("a pool that quotes a buy but not a sell is the honeypot signal", async () => {
  const { deps } = fakes({ pools: { 10000: POOL_1PCT }, depth: { [POOL_1PCT]: 1n }, sellOut: new Error("revert") });
  const result = await probeV3Pool(null, TOKEN, ADDRS, deps);
  assert.equal(result.buyQuoteOk, true);
  assert.equal(result.sellQuoteOk, false);
});

test("no pool, a failed lookup and missing addresses are reported, never treated as safe", async () => {
  const none = await probeV3Pool(null, TOKEN, ADDRS, fakes().deps);
  assert.equal(none.pair, null);
  assert.equal(none.skipped, undefined);
  const failed = await probeV3Pool(null, TOKEN, ADDRS, fakes({ getPoolThrows: true }).deps);
  assert.equal(failed.skipped, "getPool_failed");
  const missing = await probeV3Pool(null, TOKEN, { factory: "", quoter: "", weth: "", fees: [] });
  assert.equal(missing.skipped, "env_missing");
  for (const warning of [
    "no_uniswap_pool", "uniswap_getPool_failed", "uniswap_env_missing", "uniswap_buy_quote_failed",
    "no_pancake_pool", "pancake_getPool_failed", "pancakeswap_buy_quote_failed",
  ]) {
    assert.equal(classifyScan({ reasons: [], warnings: [warning] }).status, "needs_review", warning);
  }
});

test("PancakeSwap V2: pair lookup, round-trip quotes, honeypot signal", async () => {
  const V2 = { factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73", router: "0x10ED43C718714eb63d5aA57B78B54704E256024E", weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" };
  const PAIR = "0x00000000000000000000000000000000000000Bb";
  const paths = [];
  const contract = (sellFails) => (address) => address === V2.factory
    ? { getPair: async () => PAIR }
    : address === V2.weth
      ? { balanceOf: async () => 10n ** 18n }
      : { getAmountsOut: async (amountIn, p) => { paths.push([amountIn, p]); if (sellFails && p[0] === TOKEN) throw Object.assign(new Error("revert"), { code: "CALL_EXCEPTION" }); return [amountIn, 5n * 10n ** 18n]; } };
  const simulate = async () => ({ ran: true, buyOk: true, sellOk: true });
  const ok = await probeV2Pool(null, TOKEN, V2, { contract: contract(false), simulate });
  assert.deepEqual([ok.pair, ok.buyQuoteOk, ok.sellQuoteOk], [PAIR, true, true]);
  assert.deepEqual(paths[1], [5n * 10n ** 18n, [TOKEN, V2.weth]]);
  const honeypot = await probeV2Pool(null, TOKEN, V2, { contract: contract(true), simulate });
  assert.deepEqual([honeypot.buyQuoteOk, honeypot.sellQuoteOk], [true, false]);
  const none = await probeV2Pool(null, TOKEN, V2, { contract: () => ({ getPair: async () => ZERO }) });
  assert.equal(none.pair, null);
});

test("scanEvm: Robinhood uses Uniswap; BNB keeps Topaz first and falls through to PancakeSwap on mainnet only", () => {
  const source = fs.readFileSync(path.resolve(here, "./arenaImportScan.js"), "utf8");
  assert.match(source, /isRobinhoodChain\(chainId\) \? await probeRobinhood\(provider, chainId, token\) : await probeBnb\(provider, chainId, token\)/);
  assert.match(source, /const topaz = await probeTopaz\(provider, chainId, token\);\n  if \(topaz\.pair \|\| Number\(chainId\) !== 56\) return topaz;/);
  assert.match(source, /pool\.buyQuoteOk === true && pool\.sellQuoteOk === false && !soldInSimulation\) reasons\.push\("honeypot_sell_failed"\)/);
});

test("the hourly rescan picks up Robinhood imports declined before the scanner supported the chain", () => {
  const source = fs.readFileSync(path.resolve(here, "../../scripts/backfill-import-admission.mjs"), "utf8");
  assert.match(source, /status = 'declined' and reviewed_at is null and scan_json -> 'reasons' \? 'unsupported_chain'/);
  assert.match(source, /chain_id = any\(\$2::int\[\]\)/);
});

test("simulated round trip: blocked sell and high tax go to review, never to a hard decline", () => {
  const clean = { ran: true, buyOk: true, sellOk: true, buyTaxBps: 0, sellTaxBps: 0, roundTripLossBps: 198 };
  assert.deepEqual(simulationFindings(clean), { reasons: [], warnings: [] });
  assert.deepEqual(simulationFindings(null), { reasons: [], warnings: [] });
  assert.deepEqual(simulationFindings({ ...clean, sellOk: false }).reasons, ["sell_simulation_failed"]);
  assert.deepEqual(simulationFindings({ ...clean, buyTaxBps: 1001 }).reasons, ["swap_tax_high"]);
  assert.deepEqual(simulationFindings({ ...clean, sellTaxBps: 1001 }).reasons, ["swap_tax_high"]);
  // A tax the token swaps back into the pool hides from the transfer measure; the value lost does not.
  assert.deepEqual(simulationFindings({ ...clean, roundTripLossBps: 2501 }).reasons, ["swap_tax_high"]);
  assert.deepEqual(simulationFindings({ ...clean, buyTaxBps: 299, roundTripLossBps: 771 }).reasons, []);
  assert.deepEqual(simulationFindings({ ...clean, buyOk: false, sellOk: false }).warnings, ["buy_simulation_failed"]);
  // Could not run (RPC without state overrides): recorded, changes nothing.
  assert.deepEqual(simulationFindings({ ran: false, error: "x" }), { reasons: [], warnings: ["swap_simulation_unavailable"] });
  for (const code of ["sell_simulation_failed", "swap_tax_high"]) {
    assert.equal(classifyScan({ reasons: [code], warnings: [] }).status, "needs_review", code);
  }
  assert.equal(classifyScan({ reasons: [], warnings: ["buy_simulation_failed"] }).status, "needs_review");
  assert.equal(classifyScan({ reasons: [], warnings: ["swap_simulation_unavailable"] }).status, "passed");
});

test("probe result decodes into taxes, loss and a readable revert", () => {
  const iface = new ethers.Interface(IMPORT_SWAP_PROBE_ABI);
  const failing = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["TransferHelper: TRANSFER_FROM_FAILED"]);
  const sellError = `0x08c379a0${failing.slice(2)}`;
  const raw = iface.encodeFunctionResult("probe", [[true, 1000n, 900n, false, 0n, 0n, sellError]]);
  const blocked = decodeRoundTrip(raw, 10n ** 15n);
  assert.deepEqual([blocked.buyOk, blocked.sellOk, blocked.buyTaxBps, blocked.sellError], [true, false, 1000, "TransferHelper: TRANSFER_FROM_FAILED"]);
  const fine = decodeRoundTrip(iface.encodeFunctionResult("probe", [[true, 1000n, 1000n, true, 950n, 98n * 10n ** 13n, "0x"]]), 10n ** 15n);
  assert.deepEqual([fine.buyTaxBps, fine.sellTaxBps, fine.roundTripLossBps, fine.sellError], [0, 500, 200, null]);
  assert.equal(revertReason("0x"), "reverted without a reason");
});

test("the committed probe bytecode is compiled from the committed source", () => {
  const out = spawnSync(process.execPath, [path.resolve(here, "../../scripts/build-import-swap-probe.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr || out.stdout);
});

test("an RPC error on a quote is unknown, never a honeypot; a simulated sell beats a reverted sell quote", async () => {
  const timeout = Object.assign(new Error("timeout"), { code: "TIMEOUT" });
  const flaky = await probeV3Pool(null, TOKEN, ADDRS, fakes({ pools: { 10000: POOL_1PCT }, depth: { [POOL_1PCT]: 1n }, sellOut: timeout }).deps);
  assert.equal(flaky.buyQuoteOk, true);
  assert.equal(flaky.sellQuoteOk, null);
  const source = fs.readFileSync(path.resolve(here, "./arenaImportScan.js"), "utf8");
  assert.match(source, /pool\.buyQuoteOk === true && pool\.sellQuoteOk === false && !soldInSimulation\) reasons\.push\("honeypot_sell_failed"\)/);
  assert.match(source, /pool\.sellQuoteOk === null && !soldInSimulation\) warnings\.push\("sell_quote_unavailable"\)/);
  assert.equal(classifyScan({ reasons: [], warnings: ["sell_quote_unavailable"] }).status, "needs_review");
});

test("a leftover pool below the depth floor is not the coin's market", async () => {
  const { deps } = fakes({ pools: { 3000: POOL_03PCT }, depth: { [POOL_03PCT]: MIN_POOL_NATIVE - 1n } });
  const dust = await probeV3Pool(null, TOKEN, { ...ADDRS, minDepth: undefined }, deps);
  assert.equal(dust.pair, null);
});

const V4_ADDRS = {
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  router: "0x8876789976decbfcbbbe364623c63652db8c0904",
};
const PFE = "0x7066A64c24e4206CD62E83bf198c1E7EB361F51e";
const COIN = "0x1a95c10E4839033686225eaad3ac348F0d8eDC4F";
// PFEAGLE's real pool on Robinhood: the key hashes to the pool id DexScreener lists.
const PFEAGLE_KEY = [COIN, PFE, 0, 200, "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044"];
const PFEAGLE_POOL_ID = "0xcdc900b2ea9f6640f0cc454213c364643ab1c2a2f029d268169b75b94f1a9a70";

function v4Fakes({ key = PFEAGLE_KEY, sellFails = false } = {}) {
  const quotes = [];
  const sims = [];
  const contract = (address) => {
    if (address === V4_ADDRS.positionManager) return { poolKeys: async () => key };
    if (address === V4_ADDRS.quoter) {
      return {
        quoteExactInputSingle: {
          staticCall: async ([, zeroForOne, amount]) => {
            quotes.push({ zeroForOne, amount });
            if (sellFails && zeroForOne === true) throw Object.assign(new Error("revert"), { code: "CALL_EXCEPTION" });
            return [5n * 10n ** 18n, 0n];
          },
        },
      };
    }
    if (address === PFE) return { decimals: async () => 18n };
    throw new Error(`unexpected ${address}`);
  };
  const simulateV4 = async (_provider, args) => {
    sims.push(args);
    return { ran: true, buyOk: true, sellOk: !sellFails, buyTaxBps: 0, sellTaxBps: 0, roundTripLossBps: 590 };
  };
  const findPools = async () => [{ poolId: PFEAGLE_POOL_ID, liquidityUsd: 44434, quoteUsd: 150 }];
  return { deps: { addresses: V4_ADDRS, contract, simulateV4, findPools }, quotes, sims };
}

test("V4: the pool key is proven against the pool id, the quote token is sized to about $3, sold through the router", async () => {
  const { deps, quotes, sims } = v4Fakes();
  const r = await probeV4Pool(null, 4663, COIN, deps);
  assert.equal(r.pair, PFEAGLE_POOL_ID);
  assert.equal(r.quoteToken, PFE);
  assert.deepEqual([r.buyQuoteOk, r.sellQuoteOk], [true, true]);
  // $3 of PFE at $150 = 0.02 PFE; the coin is currency0, so buying is currency1 -> currency0 (zeroForOne false).
  assert.equal(quotes[0].zeroForOne, false);
  assert.equal(quotes[0].amount, 2n * 10n ** 16n);
  assert.equal(sims.length, 1);
  assert.equal(sims[0].coinIs0, true);
  assert.equal(sims[0].router, V4_ADDRS.router);
});

test("V4: a key that does not hash to the listed pool id is not trusted", async () => {
  const { deps } = v4Fakes({ key: [COIN, PFE, 3000, 60, "0x0000000000000000000000000000000000000000"] });
  const r = await probeV4Pool(null, 4663, COIN, deps);
  assert.equal(r.pair, null);
  assert.equal(r.skipped, "v4_pool_key_unknown");
});

test("V4: a reverted sell quote is the honeypot signal, unless the simulated router sell went through", async () => {
  const { deps } = v4Fakes({ sellFails: true });
  const r = await probeV4Pool(null, 4663, COIN, deps);
  assert.deepEqual([r.buyQuoteOk, r.sellQuoteOk, r.simulation.sellOk], [true, false, false]);
});
