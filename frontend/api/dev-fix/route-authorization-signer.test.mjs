import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

import {
  buildCreateAuthorizationDigest,
  buildScheduledCreateAuthorizationDigest,
  hashCampaignRequest,
} from "./routeAuthorizationSigner.js";

const OBSOLETE_FACTORY = "0xe0FbBa4533513110Cec7e78aa3e48EC45301B5E6";
const CORRECTED_FACTORY = "0x1111111111111111111111111111111111111111";
const ROBINHOOD_FACTORY = "0x3333333333333333333333333333333333333333";
const CREATOR = "0x2222222222222222222222222222222222222222";

const campaign = {
  name: "Corrected",
  symbol: "FIX",
  logoURI: "ipfs://fixed",
  xAccount: "",
  website: "",
  extraLink: "",
  graduationTarget: 6n * 10n ** 18n,
};

function scheduledInput(overrides = {}) {
  return {
    chainId: 97,
    factoryAddress: CORRECTED_FACTORY,
    creator: CREATOR,
    request: { campaign },
    launchAt: 1_900_000_000,
    draftReferenceHash: ethers.id("draft"),
    normalizedTickerHash: ethers.id("FIX"),
    metadataHash: ethers.id("metadata"),
    reservationVersion: 1,
    authorizationNonce: 7,
    factoryGeneration: 3,
    campaignGeneration: 2,
    tradeRouteProfileId: 1,
    finalizeRouteProfileId: 1,
    deadline: 2_000_000_000,
    ...overrides,
  };
}

test("refuses immediate creation authorization for the obsolete BSC Testnet factory", () => {
  assert.throws(
    () => buildCreateAuthorizationDigest({
      chainId: 97,
      factoryAddress: OBSOLETE_FACTORY,
      creator: CREATOR,
      request: campaign,
      tradeRouteProfileId: 1,
      finalizeRouteProfileId: 1,
      deadline: 2_000_000_000,
    }),
    /support-only and cannot receive new creation authorizations/,
  );
});

test("refuses scheduled creation authorization for the obsolete BSC Testnet factory", () => {
  assert.throws(
    () => buildScheduledCreateAuthorizationDigest({
      ...scheduledInput(),
      factoryAddress: OBSOLETE_FACTORY,
    }),
    /support-only and cannot receive new creation authorizations/,
  );
});

test("requires factory and campaign generations to be supplied explicitly", () => {
  const input = scheduledInput();
  delete input.factoryGeneration;
  delete input.campaignGeneration;
  assert.throws(
    () => buildScheduledCreateAuthorizationDigest(input),
    /factoryGeneration must be supplied as a positive integer/,
  );
});

test("preserves BNB generation 3/2 scheduled authorization digest", () => {
  const input = scheduledInput();
  const digest = buildScheduledCreateAuthorizationDigest(input);
  const expected = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "string",
        "uint256",
        "address",
        "address",
        "bytes32",
        "uint64",
        "bytes32",
        "bytes32",
        "bytes32",
        "uint64",
        "uint256",
        "uint32",
        "uint32",
        "uint8",
        "uint8",
        "uint64",
      ],
      [
        "MWZ_CREATE_SCHEDULED_V2_AUTH",
        97,
        CORRECTED_FACTORY,
        CREATOR,
        hashCampaignRequest(campaign),
        input.launchAt,
        input.draftReferenceHash,
        input.normalizedTickerHash,
        input.metadataHash,
        input.reservationVersion,
        input.authorizationNonce,
        3,
        2,
        input.tradeRouteProfileId,
        input.finalizeRouteProfileId,
        input.deadline,
      ],
    ),
  );
  assert.equal(digest, expected);
});

test("accepts BNB factory generation 4 without changing campaign generation", () => {
  const digest = buildScheduledCreateAuthorizationDigest(scheduledInput({ factoryGeneration: 4 }));
  assert.match(digest, /^0x[0-9a-f]{64}$/i);
});

test("Robinhood refuses generation 3 and requires factory generation 4", () => {
  assert.throws(
    () => buildScheduledCreateAuthorizationDigest(scheduledInput({
      chainId: 46630,
      factoryAddress: ROBINHOOD_FACTORY,
      factoryGeneration: 3,
    })),
    /Robinhood scheduled authorization requires factory generation 4/,
  );

  const digest = buildScheduledCreateAuthorizationDigest(scheduledInput({
    chainId: 46630,
    factoryAddress: ROBINHOOD_FACTORY,
    factoryGeneration: 4,
  }));
  assert.match(digest, /^0x[0-9a-f]{64}$/i);
});

test("rejects campaign generations other than generation 2", () => {
  assert.throws(
    () => buildScheduledCreateAuthorizationDigest(scheduledInput({ campaignGeneration: 3 })),
    /Unsupported campaign generation 3/,
  );
});
