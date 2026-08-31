import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPECTED_CAMPAIGN_GENERATION,
  EXPECTED_FACTORY_GENERATION,
  proveRobinhoodStagedManifest,
} from "./prove-robinhood-staged-manifest.mjs";

function validManifest(overrides = {}) {
  return {
    targetChainId: 46630,
    chainId: 31337,
    environment: "local-rehearsal",
    factoryGeneration: 4,
    campaignGeneration: 3,
    liquidityKind: 2,
    creationEnabled: false,
    supportEnabled: false,
    factoryLive: false,
    securityDefaultsLocked: true,
    activationPrerequisites: ["only then call LaunchFactory.enableLive() for testnet acceptance"],
    stagingOnly: {
      controlledV3Dex: true,
      mockNativeUsdPriceFeed: true,
      productionCompatible: false,
      correctedFeeModel: true,
    },
    contracts: {
      upVoteTreasury: "0x0000000000000000000000000000000000000001",
      v3NativeSwapAdapter: "0x0000000000000000000000000000000000000002",
    },
    auxiliaryFeatures: {
      v3NativeSwapAdapter: { nativeAsset: "ETH" },
    },
    ...overrides,
  };
}

test("staged manifest proof requires factory 4 / campaign 3 and stays disabled", () => {
  assert.equal(EXPECTED_FACTORY_GENERATION, 4);
  assert.equal(EXPECTED_CAMPAIGN_GENERATION, 3);
  assert.equal(proveRobinhoodStagedManifest(validManifest()), true);
  assert.throws(() => proveRobinhoodStagedManifest(validManifest({ campaignGeneration: 2 })), /campaign 3/);
  assert.throws(() => proveRobinhoodStagedManifest(validManifest({ creationEnabled: true })), /unexpectedly enabled/);
  assert.throws(() => proveRobinhoodStagedManifest(validManifest({ factoryLive: true })), /unexpectedly enabled/);
  assert.throws(
    () => proveRobinhoodStagedManifest(validManifest({ stagingOnly: { productionCompatible: true, controlledV3Dex: true } })),
    /staging-only marker missing/,
  );
  assert.throws(() => proveRobinhoodStagedManifest(validManifest({ targetChainId: 56 })), /wrong targetChainId/);
  assert.throws(() => proveRobinhoodStagedManifest(validManifest({ environment: "production" })), /production environment/);
  assert.throws(
    () => proveRobinhoodStagedManifest(validManifest({ securityDefaultsLocked: false })),
    /security defaults locked/,
  );
  assert.throws(
    () => proveRobinhoodStagedManifest(validManifest({ activationPrerequisites: [] })),
    /not be silently activatable/,
  );
});
