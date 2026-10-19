/**
 * Gen-8 token pages skip the campaign contract. Gen-6 and gen-7 pages still read it.
 *   node --test src/lib/gen8LegacyCampaignReads.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { id } from "ethers";
import { GEN8_SKIPPED_CAMPAIGN_READS, campaignReadsFor, shouldReadLegacyCampaign } from "./gen8LegacyCampaignReads.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

test("totalBuyVolumeWei is the reverting selector, and gen-8 skips every campaign read", () => {
  assert.equal(id("totalBuyVolumeWei()").slice(0, 10), "0x86f2ece0");
  assert.ok(GEN8_SKIPPED_CAMPAIGN_READS.includes("totalBuyVolumeWei()"));
  assert.deepEqual(campaignReadsFor({ generation: 8 }), []);
  assert.equal(shouldReadLegacyCampaign({ generation: 8 }), false);
  assert.equal(shouldReadLegacyCampaign({ factoryGeneration: "8" }), false);
});

test("gen-6 and gen-7 pages still make every campaign read", () => {
  for (const generation of [6, 7]) {
    assert.deepEqual(campaignReadsFor({ generation }), GEN8_SKIPPED_CAMPAIGN_READS);
  }
  assert.equal(shouldReadLegacyCampaign(null), true);
  assert.equal(shouldReadLegacyCampaign({}), true);
  assert.equal(shouldReadLegacyCampaign({ generation: 5 }), true);
  assert.deepEqual(campaignReadsFor({ generation: 7 }), campaignReadsFor({ generation: 6 }));
});

test("the token page gates those reads and the campaign client still performs them", () => {
  const page = fs.readFileSync(path.join(here, "../pages/TokenDetails.tsx"), "utf8");
  const client = fs.readFileSync(path.join(here, "launchpadClient.ts"), "utf8");
  assert.match(page, /shouldReadLegacyCampaign\(pageIdentity\)/);
  assert.match(page, /isGen8CoinPage\(campaign\)/);
  assert.match(page, /isGen8CoinPage\(match\)/);
  assert.match(page, /if \(isGen8CoinPage\(campaign\)\) return;/);
  assert.match(page, /isGen8CoinPage\(campaign\)\) \{\s*if \(!cancelled\) setQuoteLoading\(false\);/);
  assert.match(page, /fetchCampaignActivity\(campaign\.campaign\)/);
  assert.match(page, /fetchCampaignMetrics\(campaign\.campaign\)/);
  assert.match(page, /c\.quoteBuyExactBnb\(targetWei\)/);
  assert.match(page, /c\.quoteBuyExactTokens\(amountWei\)/);
  assert.match(page, /c\.quoteSellExactTokens\(amountWei\)/);
  assert.match(page, /c\.launched\(\)/);
  assert.match(page, /c\.getGraduationState\(\)/);
  assert.match(client, /campaign\.totalBuyVolumeWei\(\)/);
  assert.match(client, /campaign\.buyersCount\(\)/);
  assert.match(client, /campaign\.totalSellVolumeWei\(\)/);
  assert.equal(client.includes("isGen8CoinPage"), false);

  const indexer = fs.readFileSync(path.join(root, "realtime-indexer/src/marketIdentity.ts"), "utf8");
  const route = fs.readFileSync(path.join(root, "realtime-indexer/src/marketApi.ts"), "utf8");
  assert.match(indexer, /factory_generation/);
  assert.match(route, /factoryGeneration: identity\.factoryGeneration/);
});
