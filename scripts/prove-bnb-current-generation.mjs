#!/usr/bin/env node
import {
  SOURCE_HEAD_NOT_LIVE_BNB,
  assertSourceHeadIsNotLiveBnb,
  loadBnbCurrentCensus,
  parseBnbCurrentCensus,
  proveBnbCurrentGeneration,
} from "./bnbCurrentGeneration.mjs";

export function proveBnbCurrentGenerationOffline() {
  const result = proveBnbCurrentGeneration();
  const sourceHead = assertSourceHeadIsNotLiveBnb();
  if (!sourceHead.sourceIsNotLiveBnb) throw new Error("source-head 4/3 must fail as not current live BNB");
  if (sourceHead.assertion !== SOURCE_HEAD_NOT_LIVE_BNB) {
    throw new Error("source-head certification assertion drifted");
  }

  let malformedRejected = false;
  try {
    parseBnbCurrentCensus({ schemaVersion: 1, kind: "wrong" }, 56);
  } catch {
    malformedRejected = true;
  }
  if (!malformedRejected) throw new Error("malformed BNB census must fail closed");

  const live = loadBnbCurrentCensus(56);
  let sourceAsLiveRejected = false;
  try {
    parseBnbCurrentCensus({
      ...live,
      factoryGeneration: 4,
      campaignGeneration: 3,
      sourceHead: { ...live.sourceHead, isCurrentLiveBnb: true },
    }, 56);
  } catch {
    sourceAsLiveRejected = true;
  }
  if (!sourceAsLiveRejected) throw new Error("census must reject treating source-head 4/3 as live BNB");

  return { ...result, malformedRejected: true, sourceAsLiveRejected: true };
}

const result = proveBnbCurrentGenerationOffline();
console.log("BNB 6A current-generation census offline proof passed");
console.log(JSON.stringify({
  assertion: result.sourceHead.assertion,
  mainnetFactory: result.mainnet.creationFactory,
  testnetFactory: result.testnet.creationFactory,
  liveGeneration: `${result.mainnet.factoryGeneration}/${result.mainnet.campaignGeneration}`,
  sourceHeadGeneration: `${result.sourceHead.sourceFactoryGeneration}/${result.sourceHead.sourceCampaignGeneration}`,
  sourceIsNotLiveBnb: result.sourceHead.sourceIsNotLiveBnb,
  bnbSignerCampaignGeneration: result.signer.bnbCampaignGeneration,
  robinhoodFactory: result.robinhood.factory,
}, null, 2));
