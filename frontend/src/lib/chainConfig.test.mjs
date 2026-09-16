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

test("Robinhood 46630 vote treasury helpers use the suffixed per-chain VITE env names", () => {
  assert.match(source, /ROBINHOOD_TESTNET_CHAIN_ID[^\n]*= 46630/);

  const arena = exportedFn("getArenaVoteTreasuryAddress");
  const vote = exportedFn("getVoteTreasuryAddress");

  assert.match(
    arena,
    /VITE_ARENA_VOTE_TREASURY_ADDRESS_\$\{chainId\}/,
    "getArenaVoteTreasuryAddress(46630) must resolve VITE_ARENA_VOTE_TREASURY_ADDRESS_46630 through its per-chain lookup",
  );
  assert.match(
    vote,
    /VITE_VOTE_TREASURY_ADDRESS_\$\{chainId\}/,
    "getVoteTreasuryAddress(46630) must resolve VITE_VOTE_TREASURY_ADDRESS_46630 through its per-chain lookup",
  );
});

test("unsuffixed Arena and standard vote treasury fallbacks are only behind the BNB 56/97 guard", () => {
  const cases = [
    ["getArenaVoteTreasuryAddress", "VITE_ARENA_VOTE_TREASURY_ADDRESS_${chainId}", "VITE_ARENA_VOTE_TREASURY_ADDRESS as string"],
    ["getVoteTreasuryAddress", "VITE_VOTE_TREASURY_ADDRESS_${chainId}", "VITE_VOTE_TREASURY_ADDRESS as string"],
  ];

  for (const [name, perChainEnv, unsuffixedEnv] of cases) {
    const fn = exportedFn(name);
    const perChain = fn.indexOf(perChainEnv);
    const bnbGuard = fn.indexOf("chainId === BNB_CHAIN_ID || chainId === BNB_TESTNET_CHAIN_ID");
    const unsuffixed = fn.indexOf(unsuffixedEnv);

    assert.ok(perChain >= 0, `${name} is missing its per-chain vote treasury lookup`);
    assert.ok(bnbGuard > perChain, `${name} must check the per-chain treasury before the BNB fallback`);
    assert.ok(unsuffixed > bnbGuard, `${name} unsuffixed treasury must be inside the BNB 56/97 fallback`);
  }
});

test("Robinhood 4663/46630 cannot receive unsuffixed BNB vote treasury values", () => {
  assert.match(source, /ROBINHOOD_CHAIN_ID[^\n]*= 4663/);
  assert.match(source, /ROBINHOOD_TESTNET_CHAIN_ID[^\n]*= 46630/);

  const arena = exportedFn("getArenaVoteTreasuryAddress");
  const vote = exportedFn("getVoteTreasuryAddress");

  assert.match(
    arena,
    /if \(chainId === BNB_CHAIN_ID \|\| chainId === BNB_TESTNET_CHAIN_ID\) \{[\s\S]*?VITE_ARENA_VOTE_TREASURY_ADDRESS as string/,
  );
  assert.match(
    vote,
    /if \(chainId === BNB_CHAIN_ID \|\| chainId === BNB_TESTNET_CHAIN_ID\) \{[\s\S]*?VITE_VOTE_TREASURY_ADDRESS as string/,
  );

  assert.doesNotMatch(arena, /(?:4663|46630)[\s\S]*?VITE_ARENA_VOTE_TREASURY_ADDRESS as string/);
  assert.doesNotMatch(vote, /(?:4663|46630)[\s\S]*?VITE_VOTE_TREASURY_ADDRESS as string/);
});
