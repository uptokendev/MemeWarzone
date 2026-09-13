import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./launchpad.js", import.meta.url), "utf8");

test("launchpad KPI inventory always includes the three production product chains", () => {
  assert.match(source, /CORE_MAINNET_CHAIN_IDS = \[56, 101, 4663\]/);
  assert.match(source, /\[4663, \{ label: "Robinhood", unit: "ETH" \}\]/);
  assert.match(source, /TESTNET_CHAIN_IDS = new Set\(\[97, 102, 46630\]\)/);
});

test("launchpad KPI inventory includes imported-token ownership metrics", () => {
  for (const token of [
    "public.arena_token_imports",
    "imports_total",
    "imports_in_range",
    "verified_imports",
    "unverified_imports",
    "verified_imports_in_range",
  ]) assert.match(source, new RegExp(token));
});

test("admin launchpad totals expose campaign and import inventory", () => {
  for (const token of [
    "campaignsTotal",
    "importsTotal",
    "importsInRange",
    "verifiedImports",
    "unverifiedImports",
    "verifiedImportsInRange",
  ]) assert.match(source, new RegExp(token));
});
