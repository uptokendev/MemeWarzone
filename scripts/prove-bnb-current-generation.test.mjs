import assert from "node:assert/strict";
import test from "node:test";
import {
  LIVE_CAMPAIGN_GENERATION,
  LIVE_FACTORY_GENERATION,
  SOURCE_CAMPAIGN_GENERATION,
  SOURCE_FACTORY_GENERATION,
  SOURCE_HEAD_NOT_LIVE_BNB,
  assertSourceHeadIsNotLiveBnb,
  loadBnbCurrentCensus,
  parseBnbCurrentCensus,
  proveBnbBroadcastScriptsRefuseSourceHead,
  proveBnbSignerStaysOnCampaignGeneration2,
  proveRobinhoodFreezeUntouched,
} from "./bnbCurrentGeneration.mjs";

test("committed BNB 56/97 census pins live factory 3 / campaign 2 / Topaz V2 / treasury V2", () => {
  const mainnet = loadBnbCurrentCensus(56);
  const testnet = loadBnbCurrentCensus(97);
  assert.equal(mainnet.factoryGeneration, LIVE_FACTORY_GENERATION);
  assert.equal(mainnet.campaignGeneration, LIVE_CAMPAIGN_GENERATION);
  assert.equal(mainnet.liquidityKind, 1);
  assert.equal(mainnet.treasuryGeneration, "v2");
  assert.equal(mainnet.creationEnabled, true);
  assert.equal(mainnet.createPaused, false);
  assert.equal(mainnet.supportFactories[0].creationEnabled, false);
  assert.equal(testnet.factoryGeneration, LIVE_FACTORY_GENERATION);
  assert.equal(testnet.campaignGeneration, LIVE_CAMPAIGN_GENERATION);
  assert.equal(testnet.liquidityKind, 1);
  assert.equal(testnet.uniswapV3Rejected, true);
  assert.equal(testnet.contracts.permanentV3PositionLocker, undefined);
});

test("source-head 4/3 is certified as not current live BNB", () => {
  const proof = assertSourceHeadIsNotLiveBnb();
  assert.equal(proof.sourceFactoryGeneration, SOURCE_FACTORY_GENERATION);
  assert.equal(proof.sourceCampaignGeneration, SOURCE_CAMPAIGN_GENERATION);
  assert.equal(proof.liveFactoryGeneration, LIVE_FACTORY_GENERATION);
  assert.equal(proof.liveCampaignGeneration, LIVE_CAMPAIGN_GENERATION);
  assert.equal(proof.sourceIsNotLiveBnb, true);
  assert.equal(proof.assertion, SOURCE_HEAD_NOT_LIVE_BNB);
});

test("malformed census and source-as-live claims fail closed", () => {
  const live = loadBnbCurrentCensus(56);
  assert.throws(() => parseBnbCurrentCensus({}, 56), /schemaVersion/);
  assert.throws(() => parseBnbCurrentCensus(live, 97), /97/);
  assert.throws(
    () => parseBnbCurrentCensus({ ...live, factoryGeneration: 4, campaignGeneration: 3 }, 56),
    /factory 3 \/ campaign 2/,
  );
  assert.throws(
    () => parseBnbCurrentCensus({ ...live, liquidityKind: 2, liquidityKindName: "uniswap-v3-nft" }, 56),
    /liquidityKind/,
  );
  assert.throws(
    () => parseBnbCurrentCensus({ ...live, sourceHead: { ...live.sourceHead, isCurrentLiveBnb: true } }, 56),
    /isCurrentLiveBnb/,
  );
  assert.throws(
    () => parseBnbCurrentCensus({
      ...live,
      contracts: { ...live.contracts, treasuryRouterV3: live.contracts.treasuryRouterV2 },
    }, 56),
    /TreasuryRouterV3/,
  );
});

test("BNB API signing stays on campaign generation 2 while Robinhood 46630 stays 4/3", () => {
  const signer = proveBnbSignerStaysOnCampaignGeneration2();
  assert.equal(signer.bnbCampaignGeneration, 2);
  assert.equal(signer.robinhoodCampaignGeneration, 3);
  assert.equal(signer.rejectedBnbCampaignGeneration3, true);
  const freeze = proveRobinhoodFreezeUntouched();
  assert.equal(freeze.factoryGeneration, 4);
  assert.equal(freeze.campaignGeneration, 3);
});

test("BNB factory broadcast scripts refuse current source-head 4/3", () => {
  const guarded = proveBnbBroadcastScriptsRefuseSourceHead();
  assert.ok(guarded.guarded.includes("scripts/deploy-clean-slate-factory.ts"));
  assert.ok(guarded.guarded.includes("scripts/deploy-bnb-factory-replacement-phase-a.ts"));
});
