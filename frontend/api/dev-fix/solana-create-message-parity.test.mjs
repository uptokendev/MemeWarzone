/**
 * The create authorization message has three independent implementations:
 *
 *   1. build_create_authorization_message   programs/memewarzone_solana/src/authorized_create.rs
 *   2. buildCreateAuthorizationPayload      frontend/api/dev-fix/solana-v4-primitives.js  (signs)
 *   3. buildCreateAuthorizationPayload      tests/solana/authorization-v4.cjs             (gate)
 *
 * They drifted. The test harness sat at v5 while the program shipped v6, so the
 * local validator gate could not run at all and v6 reached mainnet with three
 * defects a validator would have caught. If (1) and (2) disagree the program
 * rejects every launch with InvalidCreateAuthorization; if (3) disagrees the
 * gate silently stops being a gate.
 *
 * (1) is proved against (2) by the validator gate, where a mismatch fails
 * signature verification on chain. This pins (2) against (3) in ordinary CI,
 * where no validator is available.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  CREATE_AUTH_SCHEMA_VERSION as API_SCHEMA,
  createAuthorizationDigest as apiDigest,
} from "./solana-v4-primitives.js";

const require = createRequire(import.meta.url);
const gate = require("../../../tests/solana/authorization-v4.cjs");

const key = (byte) => Buffer.alloc(32, byte);
const fixture = {
  programId: key(1),
  generationConfigKey: key(2),
  generation: {
    generationId: key(3),
    programId: key(4),
    configPda: key(5),
    startSlot: 12345n,
    clusterKind: 2,
    allowedGraduationTierMask: 0xff,
    economicsVersion: 3,
    curveKind: 1,
    tokenTotalSupply: 1_000_000_000n,
    tokenDecimals: 6,
    curveSupplyBps: 8000,
    liquidityTokenBps: 1500,
    basePriceLamports: 1000n,
    priceSlopeLamports: 7n,
    buyFeeBps: 100,
    sellFeeBps: 100,
    finalizeFeeBps: 200,
    creatorPostFinalizeBps: 500,
    liquidityPostFinalizeBps: 9500,
    dexAdapter: 1,
    tradeRouteProfile: key(6),
    finalizeRouteProfile: key(7),
    treasuryProfile: key(8),
    dexProfile: key(9),
    oracleProfile: key(10),
    manifestHash: key(11),
    routeAuthorizationRequired: true,
    authorizedTradingRequired: true,
  },
  creator: key(12),
  riskClusterId: key(13),
  creatorBuyLockSeconds: 3600,
  creatorBuyCapBps: 1000,
  campaign: key(14),
  mint: key(15),
  tokenVault: key(16),
  solVault: key(17),
  tokenProgram: key(18),
  args: {
    campaignId: key(19),
    metadataHash: key(20),
    name: "Kaiju88",
    symbol: "K88",
    launchAt: 0n,
    graduationTargetUsdMicros: 30_000_000_000n,
    deadline: 1_800_000_000n,
  },
};

test("the API signer and the validator gate build the identical create message", () => {
  assert.equal(API_SCHEMA, gate.CREATE_AUTH_SCHEMA_VERSION, "schema versions have drifted");
  assert.deepEqual(
    Buffer.from(apiDigest(fixture)),
    Buffer.from(gate.createAuthorizationDigest(fixture)),
    "the message the API signs is not the message the gate verifies",
  );
});

test("both implementations bind the fields that decide what a token is called", () => {
  const baseline = Buffer.from(apiDigest(fixture));
  for (const [field, value] of [
    ["name", "Renamed"],
    ["symbol", "EVIL"],
    ["campaignId", key(99)],
    ["metadataHash", key(99)],
    ["deadline", 1_900_000_000n],
  ]) {
    const mutated = { ...fixture, args: { ...fixture.args, [field]: value } };
    assert.notDeepEqual(baseline, Buffer.from(apiDigest(mutated)), `${field} must be bound`);
    assert.deepEqual(
      Buffer.from(apiDigest(mutated)),
      Buffer.from(gate.createAuthorizationDigest(mutated)),
      `${field} diverges between the two implementations`,
    );
  }
});
