import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { classifyScan, importScannerChainFamily, probeV2Pool, probeV3Pool } from "./arenaImportScan.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "0xe7dec18b0b29c8e02fb90a5dce413b3bc66e8251";
const ADDRS = {
  factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  quoter: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  fees: [100, 500, 3000, 10000],
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
            if (out instanceof Error) throw out;
            return [out, 0n, 0, 0n];
          },
        },
      };
    }
    throw new Error(`unexpected contract ${address}`);
  };
  return { deps: { contract }, quotes };
}

test("Robinhood mainnet and testnet are scanned as EVM chains", () => {
  assert.equal(importScannerChainFamily(4663), "evm");
  assert.equal(importScannerChainFamily(46630), "evm");
});

test("picks the deepest WETH pool across fee tiers and quotes on its fee", async () => {
  const { deps, quotes } = fakes({ pools: { 3000: POOL_03PCT, 10000: POOL_1PCT }, depth: { [POOL_03PCT]: 5n, [POOL_1PCT]: 9n * 10n ** 18n } });
  const result = await probeV3Pool(null, TOKEN, ADDRS, deps);
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
    : { getAmountsOut: async (amountIn, p) => { paths.push([amountIn, p]); if (sellFails && p[0] === TOKEN) throw new Error("revert"); return [amountIn, 5n * 10n ** 18n]; } };
  const ok = await probeV2Pool(null, TOKEN, V2, { contract: contract(false) });
  assert.deepEqual([ok.pair, ok.buyQuoteOk, ok.sellQuoteOk], [PAIR, true, true]);
  assert.deepEqual(paths[1], [5n * 10n ** 18n, [TOKEN, V2.weth]]);
  const honeypot = await probeV2Pool(null, TOKEN, V2, { contract: contract(true) });
  assert.deepEqual([honeypot.buyQuoteOk, honeypot.sellQuoteOk], [true, false]);
  const none = await probeV2Pool(null, TOKEN, V2, { contract: () => ({ getPair: async () => ZERO }) });
  assert.equal(none.pair, null);
});

test("scanEvm: Robinhood uses Uniswap; BNB keeps Topaz first and falls through to PancakeSwap on mainnet only", () => {
  const source = fs.readFileSync(path.resolve(here, "./arenaImportScan.js"), "utf8");
  assert.match(source, /isRobinhoodChain\(chainId\) \? await probeRobinhood\(provider, chainId, token\) : await probeBnb\(provider, chainId, token\)/);
  assert.match(source, /const topaz = await probeTopaz\(provider, chainId, token\);\n  if \(topaz\.pair \|\| Number\(chainId\) !== 56\) return topaz;/);
  assert.match(source, /if \(pool\.buyQuoteOk && !pool\.sellQuoteOk\) reasons\.push\("honeypot_sell_failed"\)/);
});

test("the hourly rescan picks up Robinhood imports declined before the scanner supported the chain", () => {
  const source = fs.readFileSync(path.resolve(here, "../../scripts/backfill-import-admission.mjs"), "utf8");
  assert.match(source, /status = 'declined' and reviewed_at is null and scan_json -> 'reasons' \? 'unsupported_chain'/);
  assert.match(source, /chain_id = any\(\$2::int\[\]\)/);
});
