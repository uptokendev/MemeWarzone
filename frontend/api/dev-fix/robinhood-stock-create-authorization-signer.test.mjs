import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

import {
  ROBINHOOD_STOCK_CREATE_AUTH_TYPES,
  buildRobinhoodStockCreateAuthorizationDigest,
} from "./robinhoodStockCreateAuthorizationSigner.js";
import { hashCampaignRequest } from "./routeAuthorizationSigner.js";

const FACTORY = "0x1111111111111111111111111111111111111111";
const CREATOR = "0x2222222222222222222222222222222222222222";
const STOCK = "0x3333333333333333333333333333333333333333";
const ADAPTER = "0x4444444444444444444444444444444444444444";
const IMPLEMENTATION = "0x5555555555555555555555555555555555555555";

const request = {
  name: "Stock War",
  symbol: "WAR",
  logoURI: "ipfs://war",
  xAccount: "",
  website: "",
  extraLink: "",
  graduationTarget: 30_000n * 10n ** 18n,
};

function input(overrides = {}) {
  return {
    chainId: 46630,
    factoryAddress: FACTORY,
    creator: CREATOR,
    request,
    stockToken: STOCK,
    stockGraduationAdapter: ADAPTER,
    stockCampaignImplementation: IMPLEMENTATION,
    tradeRouteProfileId: 1,
    finalizeRouteProfileId: 1,
    deadline: 2_000_000_000,
    ...overrides,
  };
}

test("matches LaunchFactory MWZ_CREATE_STOCK_ROUTE_AUTH digest shape", () => {
  const value = input();
  const digest = buildRobinhoodStockCreateAuthorizationDigest(value);
  const expected = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ROBINHOOD_STOCK_CREATE_AUTH_TYPES,
      [
        "MWZ_CREATE_STOCK_ROUTE_AUTH",
        46630,
        FACTORY,
        CREATOR,
        hashCampaignRequest(request),
        STOCK,
        ADAPTER,
        IMPLEMENTATION,
        1,
        1,
        2_000_000_000,
      ],
    ),
  );
  assert.equal(digest, expected);
});

test("binds the creator choice to Stock Token, adapter and Stock campaign implementation", () => {
  const original = buildRobinhoodStockCreateAuthorizationDigest(input());
  assert.notEqual(
    buildRobinhoodStockCreateAuthorizationDigest(input({ stockToken: "0x6666666666666666666666666666666666666666" })),
    original,
  );
  assert.notEqual(
    buildRobinhoodStockCreateAuthorizationDigest(input({ stockGraduationAdapter: "0x7777777777777777777777777777777777777777" })),
    original,
  );
  assert.notEqual(
    buildRobinhoodStockCreateAuthorizationDigest(input({ stockCampaignImplementation: "0x8888888888888888888888888888888888888888" })),
    original,
  );
});

test("rejects non-Robinhood chain authorization", () => {
  assert.throws(
    () => buildRobinhoodStockCreateAuthorizationDigest(input({ chainId: 56 })),
    /restricted to Robinhood/,
  );
});
