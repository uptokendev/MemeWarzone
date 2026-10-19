import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { solanaConfiguredRpcUrls } from "../solanaRpcConfig.js";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("an unset Solana RPC is an empty list", () => {
  assert.deepEqual(solanaConfiguredRpcUrls({} as NodeJS.ProcessEnv), []);
  assert.deepEqual(
    solanaConfiguredRpcUrls({ SOLANA_RPC_URL: "https://sol.example,not-a-url" } as NodeJS.ProcessEnv),
    ["https://sol.example"],
  );
});

test("indexer loops skip Solana mainnet when no Solana RPC is set", () => {
  const files = [
    "dbcIndexer.ts",
    "meteoraSwapIndexer.ts",
    "canonicalCandleMaterializer.ts",
    "solanaMarketStats.ts",
    "solanaLpFees.ts",
    "solanaIndexer.ts",
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(src, file), "utf8");
    assert.equal(source.includes("api.mainnet-beta.solana.com"), false, file);
  }
  assert.match(fs.readFileSync(path.join(src, "dbcIndexer.ts"), "utf8"), /\[dbcIndexer\] skipped: no Solana RPC configured/);
  assert.match(fs.readFileSync(path.join(src, "meteoraSwapIndexer.ts"), "utf8"), /\[meteora-indexer\] skipped: no Solana RPC configured/);
  assert.match(fs.readFileSync(path.join(src, "solanaIndexer.ts"), "utf8"), /\[solana-indexer\] skipped: no Solana RPC configured/);
  assert.match(fs.readFileSync(path.join(src, "solanaMarketStats.ts"), "utf8"), /\[solana-market-stats\] skipped: no Solana RPC configured/);
  assert.match(fs.readFileSync(path.join(src, "canonicalCandleMaterializer.ts"), "utf8"), /\[canonical-candles\] no RPC for chain; skipping/);
  assert.match(fs.readFileSync(path.join(src, "solanaLpFees.ts"), "utf8"), /Solana RPC is not configured/);
  const lpFees = fs.readFileSync(path.join(src, "lpFeesRoutes.ts"), "utf8");
  assert.match(lpFees, /if \(chainId === 97\) return parseRpcList\(ENV\.BSC_RPC_HTTP_97\)\[0\] \|\| "";/);
});
