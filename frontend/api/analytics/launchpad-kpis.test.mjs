import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./launchpad.js", import.meta.url), "utf8");

test("launchpad KPI inventory includes imported-token ownership metrics", () => {
  for (const token of [
    "public.arena_token_imports",
    "imports_total",
    "imports_in_range",
    "verified_imports",
    "unverified_imports",
    "verified_imports_in_range",
    "left join imports i using \\(chain_id\\)",
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
  ]) {
    assert.match(source, new RegExp(`${token}: n\\(row\\.`), `${token} mapped in chainRows`);
    assert.match(source, new RegExp(`acc\\.${token} \\+= row\\.${token};`), `${token} summed in totals`);
    assert.match(source, new RegExp(`\\n    ${token}: 0,`), `${token} initialised in totals`);
  }
});

test("launchpad KPI chain exclusion is unchanged", () => {
  assert.match(source, /CURRENTLY_EXCLUDED_CHAIN_IDS = new Set\(\[97, 102\]\)/);
});
