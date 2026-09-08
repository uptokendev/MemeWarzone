import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "..");

function read(relative) {
  return fs.readFileSync(path.join(apiRoot, relative), "utf8");
}

test("stock create policy uses exact DB-backed graduation registry authority", () => {
  const policy = read("dev-fix/robinhoodStockCreatePolicy.js");
  assert.match(policy, /getRobinhoodStockGraduationAsset/);
  assert.match(policy, /chainId:\s*cid/);
  assert.match(policy, /contractAddress:\s*stockToken/);
  assert.doesNotMatch(policy, /ROBINHOOD_STOCK_TOKEN_REGISTRY_/);
  assert.doesNotMatch(policy, /parseRobinhoodStockGraduationRegistry/);
  assert.doesNotMatch(policy, /resolveRobinhoodStockGraduationAsset/);
});

test("stock create policy preserves live onchain route and deployed-code checks", () => {
  const policy = read("dev-fix/robinhoodStockCreatePolicy.js");
  assert.match(policy, /requireCode\(provider, asset\.contractAddress, "Stock Token"\)/);
  assert.match(policy, /requireCode\(provider, stockGraduationAdapter, "Stock graduation adapter"\)/);
  assert.match(policy, /requireCode\(provider, stockCampaignImplementation, "Stock campaign implementation"\)/);
  assert.match(policy, /stockRoutes\(asset\.contractAddress\)/);
  assert.match(policy, /Selected Stock Token graduation route is disabled onchain/);
});

test("draft Stock Token persistence uses the DB helper and has no ENV or ticker authority fallback", () => {
  const drafts = read("dev-fix/drafts.js");
  assert.match(drafts, /getRobinhoodStockGraduationAsset/);
  assert.match(drafts, /chainId,/);
  assert.match(drafts, /contractAddress:\s*requested/);
  assert.match(drafts, /requireFresh:\s*true/);
  assert.doesNotMatch(drafts, /ROBINHOOD_STOCK_TOKEN_REGISTRY_/);
  assert.doesNotMatch(drafts, /resolveRobinhoodStockGraduationAsset/);
  assert.doesNotMatch(drafts, /parseRobinhoodStockGraduationRegistry/);
});

test("DB registry lookup authority is exact chainId plus contractAddress", () => {
  const registry = read("lib/robinhoodStockGraduationRegistry.js");
  assert.match(registry, /where chain_id = \$1 and lower\(contract_address\) = lower\(\$2\) limit 1/i);
  assert.doesNotMatch(registry, /where[^;]*symbol\s*=\s*\$\d[^;]*limit 1/i);
});
