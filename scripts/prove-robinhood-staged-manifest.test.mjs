import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPECTED_CAMPAIGN_GENERATION,
  EXPECTED_FACTORY_GENERATION,
  proveRobinhoodStagedManifest,
} from "./prove-robinhood-staged-manifest.mjs";

function validManifest(overrides = {}) {
  const v3Factory = "0x0000000000000000000000000000000000000010";
  const swapRouter = "0x0000000000000000000000000000000000000011";
  const wrappedNative = "0x0000000000000000000000000000000000000012";
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
      v3MultiHopSwapAdapter: "0x0000000000000000000000000000000000000003",
      mockV3Factory: v3Factory,
      mockSwapRouter02: swapRouter,
      mockWeth9: wrappedNative,
    },
    auxiliaryFeatures: {
      v3NativeSwapAdapter: { nativeAsset: "ETH" },
      v3MultiHopSwapAdapter: {
        enabled: true,
        v3Factory,
        swapRouter,
        wrappedNative,
        nativeAsset: "ETH",
        routeKind: "STOCK_TWO_HOP",
        routeConfigured: false,
        testnetOnly: true,
      },
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

test("staged manifest proof requires the RH-S9 adapter on the same V3 stack and no preconfigured route", () => {
  const base = validManifest();
  assert.throws(
    () => proveRobinhoodStagedManifest(validManifest({
      contracts: { ...base.contracts, v3MultiHopSwapAdapter: "" },
    })),
    /multi-hop swap adapter missing/,
  );
  assert.throws(
    () => proveRobinhoodStagedManifest(validManifest({
      auxiliaryFeatures: {
        ...base.auxiliaryFeatures,
        v3MultiHopSwapAdapter: { ...base.auxiliaryFeatures.v3MultiHopSwapAdapter, routeConfigured: true },
      },
    })),
    /must not preconfigure/,
  );
  assert.throws(
    () => proveRobinhoodStagedManifest(validManifest({
      auxiliaryFeatures: {
        ...base.auxiliaryFeatures,
        v3MultiHopSwapAdapter: {
          ...base.auxiliaryFeatures.v3MultiHopSwapAdapter,
          swapRouter: "0x0000000000000000000000000000000000000099",
        },
      },
    })),
    /router metadata mismatch/,
  );
});
