import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./deploy-bnb-mainnet-v3-cutover.ts", import.meta.url), "utf8");

test("BNB V3 cutover requires explicit chain-56 confirmation and dedicated production inputs", () => {
  assert.match(source, /CONFIRM_BNB_V3_CLEAN_CUTOVER/);
  assert.match(source, /I_UNDERSTAND_BNB_V3_CLEAN_CUTOVER/);
  assert.match(source, /network\.name !== "bscMainnet"/);
  assert.match(source, /net\.chainId !== CHAIN_ID/);
  for (const name of [
    "BNB_V3_WEEKLY_LEAGUE_VAULT",
    "BNB_V3_MONTHLY_LEAGUE_TREASURY",
    "BNB_V3_RECRUITER_REWARDS_VAULT",
    "BNB_V3_PROTOCOL_REVENUE_VAULT",
    "BNB_V3_CREATOR_REGISTRY",
    "BNB_V3_RISK_REGISTRY",
  ]) {
    assert.ok(source.includes(name), `missing required production input ${name}`);
  }
});

test("BNB V3 cutover refuses unknown current-factory campaigns", () => {
  assert.match(source, /assertNoProductionCampaignLiability/);
  assert.match(source, /BNB_CUTOVER_DISPOSABLE_CAMPAIGNS/);
  assert.match(source, /Production campaign liability is not zero/);
  assert.match(source, /CampaignCreated/);
  assert.match(source, /campaignsCount/);
});

test("BNB V3 cutover deploys canonical 4\/3 V3 fee stack and 30 bps locker", () => {
  assert.match(source, /getContractFactory\("TreasuryRouterV3"/);
  assert.match(source, /getContractFactory\("CommunityRewardsVault"/);
  assert.match(source, /getContractFactory\("CreatorRewardsVault"/);
  assert.match(source, /getContractFactory\("LaunchCampaign"/);
  assert.match(source, /getContractFactory\("LaunchFactory"/);
  assert.match(source, /EXPECTED_FACTORY_GENERATION = 4n/);
  assert.match(source, /EXPECTED_CAMPAIGN_GENERATION = 3n/);
  assert.match(source, /REQUIRED_POOL_FEE_BPS = 30n/);
  assert.match(source, /CREATOR_FEE_BPS.*8000n/);
  assert.match(source, /PROTOCOL_FEE_BPS.*2000n/);
});

test("Treasury V3 is born under Safe custody and factory stays dark through deployment", () => {
  assert.match(source, /Treasury\.deploy\(safe, weeklyLeagueVault, monthlyLeagueTreasury/);
  assert.match(source, /TreasuryRouterV3\.admin/);
  assert.match(source, /launchFactory\.setCreatePaused\(true\)/);
  assert.match(source, /launchFactory\.lockSecurityDefaults\(\)/);
  assert.match(source, /factory\.live.*false/);
  assert.match(source, /launchFactory\.transferOwnership\(safe\)/);
  assert.doesNotMatch(source, /launchFactory\.enableLive\(\)/);
  assert.doesNotMatch(source, /launchFactory\.setCreatePaused\(false\)/);
});

test("activation is split into Safe-controlled wire, activate, and final unpause batches", () => {
  assert.match(source, /01-wire\.safe-batch\.json/);
  assert.match(source, /02-activate-and-retire-old-create\.safe-batch\.json/);
  assert.match(source, /03-unpause-create\.safe-batch\.json/);
  assert.match(source, /encodeFunctionData\("enableLive"/);
  assert.match(source, /currentFactoryAddress[\s\S]*encodeFunctionData\("setCreatePaused", \[true\]\)/);
  assert.match(source, /LAST: enable CREATE on gen-4\/3/);
});

test("V3 fee-vector checks cover creator, recruiter, airdrop, and finalize behavior", () => {
  assert.match(source, /previewTrade\(10_000n, 0\)/);
  assert.match(source, /previewTrade\(10_000n, 2\)/);
  assert.match(source, /previewTrade\(10_000n, 1\)/);
  assert.match(source, /previewFinalize\(10_000n, 1\)/);
  assert.match(source, /standard\.creator.*500n/);
  assert.match(source, /og\.recruiter.*1500n/);
  assert.match(source, /unlinked\.airdrop.*1500n/);
  assert.match(source, /finalize\.creator.*0n/);
});
