import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCEPTED_5B_SHA,
  assertRobinhoodTestnetMutationForbidden,
  loadRobinhoodTestnetFreeze,
  parseRobinhoodTestnetFreeze,
  proveProductionRobinhoodDisabled,
} from "./robinhoodTestnetFreeze.mjs";

function validFreeze(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "robinhood-testnet-acceptance-freeze",
    accepted5BSha: ACCEPTED_5B_SHA,
    chainId: 46630,
    factory: "0xF170a2C97953754c2C1105E2AcC522Bc8e764D75",
    routeAuthority: "0x2501cdC18Cf3f4EfA8d08F18ab27e4862212Bde0",
    admin: "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714",
    factoryGeneration: 4,
    campaignGeneration: 3,
    factoryStartBlock: 110723466,
    expectedLive: true,
    expectedCreatePaused: true,
    productionCompatible: false,
    productionCreationEnabled: false,
    ...overrides,
  };
}

test("committed freeze is valid and pins 5B SHA plus 46630 4/3", () => {
  const freeze = loadRobinhoodTestnetFreeze();
  assert.ok(freeze);
  assert.equal(freeze.accepted5BSha, ACCEPTED_5B_SHA);
  assert.equal(freeze.chainId, 46630);
  assert.equal(freeze.factoryGeneration, 4);
  assert.equal(freeze.campaignGeneration, 3);
  assert.notEqual(freeze.routeAuthority.toLowerCase(), freeze.admin.toLowerCase());
  assert.equal(freeze.expectedLive, true);
  assert.equal(freeze.expectedCreatePaused, true);
});

test("malformed freeze fails closed instead of counting as absent", () => {
  assert.throws(() => parseRobinhoodTestnetFreeze({}), /schemaVersion/);
  assert.throws(() => parseRobinhoodTestnetFreeze(validFreeze({ chainId: 56 })), /46630/);
  assert.throws(() => parseRobinhoodTestnetFreeze(validFreeze({ campaignGeneration: 2 })), /campaign 3/);
  assert.throws(
    () => parseRobinhoodTestnetFreeze(validFreeze({ routeAuthority: "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714" })),
    /differ from admin/,
  );
  assert.throws(() => parseRobinhoodTestnetFreeze(validFreeze({ expectedLive: false })), /expectedLive/);
  assert.throws(() => parseRobinhoodTestnetFreeze(validFreeze({ expectedCreatePaused: false })), /expectedCreatePaused/);
  assert.throws(() => parseRobinhoodTestnetFreeze(validFreeze({ productionCompatible: true })), /productionCompatible/);
});

test("mutation guard rejects 46630 and leaves 31337 usable", () => {
  assert.throws(() => assertRobinhoodTestnetMutationForbidden(46630), /forbids 46630/);
  assert.doesNotThrow(() => assertRobinhoodTestnetMutationForbidden(31337));
});

test("production Robinhood stays disabled in examples and source defaults", () => {
  const flags = proveProductionRobinhoodDisabled();
  assert.equal(flags.productionCreationEnabled, false);
  assert.equal(flags.directRobinhoodDeployEnabled, false);
  assert.deepEqual(flags.activeEvmChainIds, [56, 97]);
  assert.deepEqual(flags.activeEvmIndexerChainIds, [56, 97]);
  assert.equal(flags.robinhoodV3PoolIndexerDefault, 0);
});
