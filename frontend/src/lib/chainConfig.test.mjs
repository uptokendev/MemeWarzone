import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "chainConfig.ts"), "utf8");

function exportedFn(name) {
  return source.split(`export function ${name}`)[1]?.split("export function")[0] || "";
}

test("getNativeSymbol labels Robinhood as ETH", () => {
  const fn = exportedFn("getNativeSymbol");
  assert.match(fn, /isRobinhoodChainId\(chainId\)\) return "ETH"/);
  assert.match(fn, /isSolanaChainId\(chainId\)\) return "SOL"/);
  assert.match(fn, /return "BNB"/);
});

test("getArenaWarPoolTreasuryAddress prefers V2 per-chain env and never leaks BNB unsuffixed onto Robinhood", () => {
  const fn = exportedFn("getArenaWarPoolTreasuryAddress");
  assert.match(fn, /isSolanaChainId\(chainId\)\) return ""/);
  const v2 = fn.indexOf("VITE_ARENA_WAR_POOL_TREASURY_V2_ADDRESS_${chainId}");
  const perChain = fn.indexOf("VITE_ARENA_WAR_POOL_TREASURY_ADDRESS_${chainId}");
  const bnbGuard = fn.indexOf("BNB_CHAIN_ID || chainId === BNB_TESTNET_CHAIN_ID");
  const unsuffixed = fn.indexOf("VITE_ARENA_WAR_POOL_TREASURY_ADDRESS as string");
  assert.ok(v2 >= 0, "missing V2 per-chain treasury env");
  assert.ok(perChain > v2, "V1 per-chain treasury must follow V2");
  assert.ok(bnbGuard > perChain, "unsuffixed BNB fallback must follow per-chain lookups");
  assert.ok(unsuffixed > bnbGuard, "unsuffixed treasury env is BNB-only");
  assert.doesNotMatch(fn, /4663|46630/);
});
