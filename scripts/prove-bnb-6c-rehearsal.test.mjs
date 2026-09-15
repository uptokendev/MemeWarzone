import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { reconcileCompletionReadAfterWrite } = require("./lib/bnb97CompletionReadReconciler.cjs");
const { acceptedHarvestSplit, validateHarvestAssetRecord } = require("./lib/bnb97HarvestAccounting.cjs");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

test("6C deploy permits only explicitly guarded chain 97 and never unlocks 56", () => {
  const deploy = read("scripts/deploy-bnb-testnet-stage.ts");
  const verify = read("scripts/verify-bnb-testnet-stage.ts");
  const lifecycle = read("scripts/test-bnb-6c-testnet-lifecycle.ts");
  const guard = read("scripts/lib/bnbLiveGenerationGuard.ts");
  assert.match(deploy, /allowBnb6cTestnetSourceHeadBroadcast/);
  assert.doesNotMatch(deploy, /Refusing chain-97 broadcast until the rehearsal SHA is audited/);
  assert.match(guard, /BNB_6C_ALLOW_SOURCE_HEAD_BROADCAST=true/);
  assert.match(guard, /6C forbids every factory\/treasury broadcast on chain 56/);
  assert.match(verify, /BNB_6C_ALLOW_SOURCE_HEAD_BROADCAST=true/);
  assert.match(lifecycle, /BNB 6C testnet acceptance requires chain 97/);
  assert.match(lifecycle, /acceptance refuses the live 3\/2 factory/);
  assert.match(read("scripts/deploy-clean-slate-factory.ts"), /refuseBnbFactoryBroadcastIfSourceHeadIsNotLive/);
});

test("6C signer is factory-scoped and production 97 stays campaign 2", () => {
  const helper = read("scripts/lib/bnb6cAcceptanceSigner.ts");
  const signer = read("frontend/api/dev-fix/routeAuthorizationSigner.js");
  assert.match(helper, /BNB_6C_ACCEPTANCE_SIGNER=true/);
  assert.match(helper, /LIVE_97_FACTORY/);
  assert.match(helper, /EXPECTED_CAMPAIGN_GENERATION = 3/);
  assert.match(signer, /if \(id === ROBINHOOD_TESTNET_CHAIN_ID \|\| id === LOCAL_HARDHAT_CHAIN_ID\) return 3;/);
  assert.doesNotMatch(signer, /chainId === 97n[^\n]*return 3/);
});

test("6C stack is controlled 30 bps Topaz V2, not TopazRouterAdapter or Uniswap V3", () => {
  const deploy = read("scripts/deploy-bnb-testnet-stage.ts");
  assert.match(deploy, /MockTopazFactory/);
  assert.match(deploy, /MockTopazRouter/);
  assert.match(deploy, /wrappedWithTopazRouterAdapter: false/);
  assert.match(deploy, /realTopazCompatibility: false/);
  assert.doesNotMatch(deploy, /getContractFactory\("TopazRouterAdapter"\)/);
  assert.doesNotMatch(deploy, /PermanentV3PositionLocker/);
});

test("6A live census and 6B math remain the source of truth", () => {
  const census = JSON.parse(read("deployments/bnb/testnet.current.json"));
  assert.equal(census.creationFactory, "0x77Af7634837643d4f93d1086b492571268b30B5F");
  assert.equal(census.factoryGeneration, 3);
  assert.equal(census.campaignGeneration, 2);
  assert.equal(census.uniswapV3Rejected, true);
});

test("native pending cert replaces raw-value crossing with quoted no-fee principal and preserves pending-first invariants", () => {
  const prepare = read("scripts/prepare-bnb97-native-pending-graduation-cert.mjs");
  assert.match(prepare, /source\.replace\(rawCrossingMath, principalAwareCrossing\)/);
  assert.match(prepare, /raisedBeforeCrossing >= restoredTarget/);
  assert.match(prepare, /remainingCurveSupply = curveSupply - soldBeforeCrossing/);
  assert.match(prepare, /quoteBuyExactTokens\(remainingCurveSupply\)/);
  assert.match(prepare, /maxCostNoFee = maxQuotedTotalCost - maxQuotedFee/);
  assert.match(prepare, /raisedBeforeCrossing \+ midCostNoFee >= restoredTarget/);
  assert.match(prepare, /authoritativeCostNoFee = healthyTotalCost - healthyFeeWei/);
  assert.match(prepare, /raisedAfterCrossing < restoredTarget/);
  assert.match(prepare, /parseEvent\(campaign, pendingReceipt, "CampaignFinalized"\)/);
  assert.match(prepare, /!pendingAfterCrossing \|\| launchedAfterCrossing/);
  assert.match(prepare, /topazFactory\.getPool\(info\.token, await wbnb\.getAddress\(\), false\)\) !== ethers\.ZeroAddress/);
});

test("completion harness anchors receipt-block state and does not replace canonical checks with sleeps", () => {
  const prepare = read("scripts/prepare-bnb97-completion-read-reconciliation.mjs");
  assert.match(prepare, /completeReceipt\.blockNumber/);
  assert.match(prepare, /completeReceipt\.blockHash/);
  assert.match(prepare, /CampaignFinalized: finalizedEvidence/);
  assert.match(prepare, /campaign\.launched\(\{ blockTag \}\)/);
  assert.match(prepare, /campaign\.graduationPending\(\{ blockTag \}\)/);
  assert.match(prepare, /campaign\.getGraduationState\(\{ blockTag \}\)/);
  assert.match(prepare, /factory\.campaignGraduationRecorded\(info\.campaign, \{ blockTag \}\)/);
  assert.match(prepare, /maxConfirmations: 3/);
  assert.doesNotMatch(prepare, /setTimeout|sleep\(/);
});

test("stale latest completion read reconciles only after canonical receipt-block state is finalized", async () => {
  const finalized = {
    launched: true,
    graduationPending: false,
    dexPair: "0x1111111111111111111111111111111111111111",
    pool: "0x1111111111111111111111111111111111111111",
    factoryGraduationRecorded: true,
    lockerRegistered: true,
  };
  const stale = {
    launched: false,
    graduationPending: true,
    dexPair: "0x0000000000000000000000000000000000000000",
    pool: "0x0000000000000000000000000000000000000000",
    factoryGraduationRecorded: false,
    lockerRegistered: false,
  };
  const latest = [stale, finalized];
  const waited = [];
  const result = await reconcileCompletionReadAfterWrite({
    receiptBlockNumber: 100,
    receiptBlockHash: "0xabc",
    finalizedEvent: { name: "CampaignFinalized" },
    readAtBlock: async () => finalized,
    readLatest: async () => latest.shift() ?? finalized,
    getBlockHash: async () => "0xabc",
    waitForConfirmations: async (confirmations) => waited.push(confirmations),
    maxConfirmations: 3,
  });
  assert.equal(result.endpointLagObserved, true);
  assert.equal(result.confirmationsObserved, 2);
  assert.deepEqual(waited, [2]);
  assert.equal(result.latestState.launched, true);
  assert.equal(result.latestState.graduationPending, false);
});

test("completion reconciliation fails closed when canonical receipt-block state contradicts the event", async () => {
  await assert.rejects(
    reconcileCompletionReadAfterWrite({
      receiptBlockNumber: 100,
      receiptBlockHash: "0xabc",
      finalizedEvent: { name: "CampaignFinalized" },
      readAtBlock: async () => ({
        launched: false,
        graduationPending: true,
        dexPair: "0x0000000000000000000000000000000000000000",
        pool: "0x0000000000000000000000000000000000000000",
        factoryGraduationRecorded: false,
        lockerRegistered: false,
      }),
      readLatest: async () => ({}),
      getBlockHash: async () => "0xabc",
      waitForConfirmations: async () => {},
    }),
    /canonical receipt-block state contradicts CampaignFinalized/,
  );
});

test("completion reconciliation fails closed if the receipt block ceases to be canonical", async () => {
  const finalized = {
    launched: true,
    graduationPending: false,
    dexPair: "0x1111111111111111111111111111111111111111",
    pool: "0x1111111111111111111111111111111111111111",
    factoryGraduationRecorded: true,
    lockerRegistered: true,
  };
  let hashRead = 0;
  await assert.rejects(
    reconcileCompletionReadAfterWrite({
      receiptBlockNumber: 100,
      receiptBlockHash: "0xabc",
      finalizedEvent: { name: "CampaignFinalized" },
      readAtBlock: async () => finalized,
      readLatest: async () => ({ ...finalized, launched: false }),
      getBlockHash: async () => (++hashRead === 1 ? "0xabc" : "0xdef"),
      waitForConfirmations: async () => {},
      maxConfirmations: 2,
    }),
    /completion receipt block changed during confirmation reconciliation/,
  );
});

test("harvest certification anchors claimables and recipient balances to explicit canonical blocks", () => {
  const prepare = read("scripts/prepare-bnb97-harvest-accounting.mjs");
  const runner = read("scripts/run-bnb97-native-pending-graduation-cert.ts");
  assert.match(runner, /prepare-bnb97-harvest-accounting\.mjs/);
  assert.match(prepare, /harvestPreBlock = postSellReceipt\?\.blockNumber/);
  assert.match(prepare, /claimable0\(lockerAddr, \{ blockTag: harvestPreBlock \}\)/);
  assert.match(prepare, /claimable1\(lockerAddr, \{ blockTag: harvestPreBlock \}\)/);
  assert.match(prepare, /harvestReceipt\.blockNumber/);
  assert.match(prepare, /harvestReceipt\.blockHash/);
  assert.match(prepare, /FeesHarvested/);
  assert.match(prepare, /creatorTokenAfter = await token\.balanceOf\(creator\.address, \{ blockTag: harvestBlock \}\)/);
  assert.match(prepare, /protocolTokenAfter = await token\.balanceOf\(manifest\.contracts\.protocolRevenueVault, \{ blockTag: harvestBlock \}\)/);
  assert.match(prepare, /assets: harvestAssetEvidence/);
  assert.match(prepare, /all integer remainder routes to protocol; no dust tolerance/);
  assert.doesNotMatch(prepare, /dustTolerance|toleranceWei|Math\.abs/);
});

test("accepted locker integer split sends the complete remainder to protocol", () => {
  const split = acceptedHarvestSplit(7n);
  assert.equal(split.creatorPaid, 5n);
  assert.equal(split.protocolRouted, 2n);
  assert.equal(split.creatorPaid + split.protocolRouted, 7n);

  const record = validateHarvestAssetRecord({
    token: "TOKEN",
    collected: 7n,
    creatorPaid: 5n,
    protocolRouted: 2n,
    creatorBefore: 10n,
    creatorAfter: 15n,
    protocolBefore: 20n,
    protocolAfter: 22n,
  });
  assert.equal(record.creatorDelta, 5n);
  assert.equal(record.protocolDelta, 2n);
});

test("harvest accounting rejects floor-floor dust and any non-conserving event", () => {
  assert.throws(
    () => validateHarvestAssetRecord({
      token: "TOKEN",
      collected: 7n,
      creatorPaid: 5n,
      protocolRouted: 1n,
      creatorBefore: 10n,
      creatorAfter: 15n,
      protocolBefore: 20n,
      protocolAfter: 21n,
    }),
    /does not conserve collected amount/,
  );

  assert.throws(
    () => validateHarvestAssetRecord({
      token: "TOKEN",
      collected: 7n,
      creatorPaid: 5n,
      protocolRouted: 2n,
      creatorBefore: 10n,
      creatorAfter: 15n,
      protocolBefore: 20n,
      protocolAfter: 21n,
    }),
    /protocol balance delta does not match/,
  );
});
