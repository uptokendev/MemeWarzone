#!/usr/bin/env node
/**
 * Build config/bnb/mainnet-quote-routes.json from facts: every chain-56 asset in
 * the approved manifest x Chainlink's BSC feed directory x the Topaz factory's
 * canonical volatile WBNB pool, kept only where the pool values >= the floor.
 *
 * BnbQuoteGraduationAdapter.configureQuoteRoute accepts nothing else: the
 * acquisition pool must be getPool(WBNB, token, false) and not stable. On
 * 2026-09-24 no candidate met the floor (USDT ~$1.2k, BTCB ~$1.5k, ETH ~$185,
 * the rest have no pool), so the file lists them under "belowFloor" for the
 * dashboard and "routes" is empty. Re-run when Topaz liquidity changes; then
 * scripts/configure-bnb-quote-routes.ts binds what qualifies.
 *
 *   node scripts/scan-bnb-quote-routes.mjs [--floor 50000]
 */
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ethers } = require("ethers");

const floor = Number((process.argv.indexOf("--floor") >= 0 ? process.argv[process.argv.indexOf("--floor") + 1] : "") || 50000);
const rpc = process.env.BSC_RPC_HTTP_56 || "https://bsc-dataseed.binance.org";
const TOPAZ_FACTORY = "0x65E6cD0eF5D3467030103cf3d433034E570b5784";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const BNB_USD_FEED = "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE";
const manifest = JSON.parse(fs.readFileSync(new URL("../frontend/api/data/approved-quote-catalog.v1.json", import.meta.url), "utf8"));
const feeds = await (await fetch("https://reference-data-directory.vercel.app/feeds-bsc-mainnet.json", { signal: AbortSignal.timeout(20000) })).json();
const feedBySym = {};
for (const f of feeds) { const m = String(f.name || "").match(/^([A-Za-z0-9.]+)\s*\/\s*USD$/); if (m && f.proxyAddress) feedBySym[m[1].toUpperCase()] = f.proxyAddress; }
const p = new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: true });
const factory = new ethers.Contract(TOPAZ_FACTORY, ["function getPool(address,address,bool) view returns (address)"], p);
const wbnb = new ethers.Contract(WBNB, ["function balanceOf(address) view returns (uint256)"], p);
const bnbUsd = Number((await new ethers.Contract(BNB_USD_FEED, ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"], p).latestRoundData())[1]) / 1e8;
const routes = [], belowFloor = [], noFeed = [];
for (const a of manifest.assets.filter((x) => String(x.chainId) === "56" && /^0x[0-9a-fA-F]{40}$/.test(String(x.address)) && x.address.toLowerCase() !== WBNB.toLowerCase())) {
  // Chainlink names BTCB's feed "BTC / USD" and the xStocks' feeds by the bare ticker.
  const ALIASES = { BTCB: "BTC" };
  const sym = String(a.symbol).toUpperCase();
  const feed = feedBySym[ALIASES[sym] || sym] || feedBySym[sym.replace(/X$/, "")] || null;
  const pool = await factory.getPool(WBNB, a.address, false);
  const usd = pool === ethers.ZeroAddress ? 0 : Math.round(Number(ethers.formatEther(await wbnb.balanceOf(pool))) * bnbUsd * 2);
  const row = { symbol: a.symbol, quoteToken: a.address, oracleFeed: feed, acquisitionPool: pool === ethers.ZeroAddress ? null : pool, poolUsdObserved: usd };
  if (!feed) noFeed.push(row); else if (usd >= floor && row.acquisitionPool) routes.push(row); else belowFloor.push(row);
}
const out = { chainId: 56, generatedAt: new Date().toISOString(), floorUsd: floor, bnbUsdAtScan: bnbUsd, source: { assets: "frontend/api/data/approved-quote-catalog.v1.json (chain 56)", feeds: "https://reference-data-directory.vercel.app/feeds-bsc-mainnet.json", pools: `Topaz factory ${TOPAZ_FACTORY} getPool(WBNB, token, false)` },
  policy: { minimumRouteLiquidityUsd: String(floor), maxSwapSlippageBps: 300, maxOracleDeviationBps: 500, maxPriceImpactBps: 500, maxGraduationPriceDeviationBps: 500 }, routes, belowFloor, noFeed };
fs.mkdirSync(new URL("../config/bnb/", import.meta.url), { recursive: true });
fs.writeFileSync(new URL("../config/bnb/mainnet-quote-routes.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(`BNB/USD ${bnbUsd.toFixed(0)}  floor $${floor}: ${routes.length} bindable, ${belowFloor.length} below floor / no pool, ${noFeed.length} without a Chainlink feed`);
for (const r of routes) console.log(`  BIND  ${r.symbol.padEnd(7)} pool ${r.acquisitionPool} ~$${r.poolUsdObserved.toLocaleString()}`);
for (const r of belowFloor) console.log(`  wait  ${r.symbol.padEnd(7)} ${r.acquisitionPool ? `~$${r.poolUsdObserved.toLocaleString()}` : "no Topaz WBNB pool"}`);
for (const r of noFeed) console.log(`  nofeed ${r.symbol}`);
