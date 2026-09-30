import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

import {
  REQUEST_HASH_TYPES,
  REQUEST_HASH_TYPES_GEN6,
  buildBnbBasicQuoteAuthorizationDigest,
  buildCreateAuthorizationDigest,
  buildScheduledCreateAuthorizationDigest,
  hashCampaignRequest,
  isSupportedBnbBasicGenerationPair,
  requestHashLayout,
} from "./routeAuthorizationSigner.js";
import { buildRobinhoodStockCreateAuthorizationDigest } from "./robinhoodStockCreateAuthorizationSigner.js";
import { buildBnbBasicQuoteCatalogBinding } from "../lib/bnbBasicQuoteCatalogBinding.js";
// route-auth.js and draft-deploy-base.js import the DB module, which needs a URL (never connected here).
process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:1/test";
const { applyGenerationCreateFields } = await import("./route-auth.js");
const { resolveScheduledGen6Fields } = await import("./draft-deploy-base.js");
import { Gen6CreateOptionError, quoteGen6CreatorFirstBuy } from "../lib/evmLaunchGen6.js";

const FACTORY = "0x1111111111111111111111111111111111111111";
const CREATOR = "0x2222222222222222222222222222222222222222";
const QUOTE = "0x3333333333333333333333333333333333333333";
const ADAPTER = "0x4444444444444444444444444444444444444444";
const IMPL = "0x5555555555555555555555555555555555555555";
const WAD = 10n ** 18n;

const base = {
  name: "Gen Six",
  symbol: "SIX",
  logoURI: "ipfs://six",
  xAccount: "@six",
  website: "https://six.test",
  extraLink: "",
  graduationTarget: 30_000n * WAD,
};
const gen6Request = { ...base, firstBuyTokens: 5_000_000n * WAD, firstBuyMaxCost: 123456789n, feeChoice: 3, feeCreatorPct: 40 };

const t = (v) => ethers.keccak256(ethers.toUtf8Bytes(v));
const coder = ethers.AbiCoder.defaultAbiCoder();

function manualGen6Hash(r) {
  return ethers.keccak256(
    coder.encode(REQUEST_HASH_TYPES_GEN6, [
      t(r.name), t(r.symbol), t(r.logoURI), t(r.xAccount), t(r.website), t(r.extraLink),
      r.graduationTarget, r.firstBuyTokens, r.firstBuyMaxCost, r.feeChoice, r.feeCreatorPct,
    ]),
  );
}

test("generation 6 hashes LaunchFactory._hashCampaignRequest's 11 fields; older generations keep 7", () => {
  assert.equal(REQUEST_HASH_TYPES_GEN6.length, 11);
  assert.equal(hashCampaignRequest(gen6Request, { factoryGeneration: 6 }), manualGen6Hash(gen6Request));
  const legacy = ethers.keccak256(
    coder.encode(REQUEST_HASH_TYPES, [t(base.name), t(base.symbol), t(base.logoURI), t(base.xAccount), t(base.website), t(base.extraLink), base.graduationTarget]),
  );
  assert.equal(hashCampaignRequest(base), legacy, "no generation, no fee choice: legacy (every existing caller)");
  assert.equal(hashCampaignRequest(base, { factoryGeneration: 4 }), legacy);
  assert.equal(hashCampaignRequest({ ...base, feeChoice: 1 }), hashCampaignRequest({ ...base, feeChoice: 1 }, { factoryGeneration: 6 }), "shape picks gen6 when feeChoice is present");
  // every signed field moves the hash
  for (const [field, value] of [["firstBuyTokens", 1n], ["firstBuyMaxCost", 1n], ["feeChoice", 4], ["feeCreatorPct", 41]]) {
    assert.notEqual(hashCampaignRequest({ ...gen6Request, [field]: value }, { factoryGeneration: 6 }), manualGen6Hash(gen6Request), field);
  }
});

test("a legacy factory refuses non-zero generation-6 fields instead of dropping them from the signature", () => {
  assert.throws(() => hashCampaignRequest(gen6Request, { factoryGeneration: 4 }), /does not accept first-buy or fee-choice/);
  assert.throws(() => hashCampaignRequest({ ...base, firstBuyTokens: 1n }), /must also carry feeChoice/);
  assert.equal(requestHashLayout(base, 3), "legacy");
  assert.equal(requestHashLayout(base, 6), "gen6");
});

test("create, scheduled and stock digests embed the generation-6 request hash when told the generation", () => {
  const requestHash = manualGen6Hash(gen6Request);
  const common = { chainId: 56, factoryAddress: FACTORY, creator: CREATOR, request: gen6Request, tradeRouteProfileId: 0, finalizeRouteProfileId: 0, deadline: 2_000_000_000 };
  assert.equal(
    buildCreateAuthorizationDigest({ ...common, factoryGeneration: 6 }),
    buildCreateAuthorizationDigest({ ...common, factoryGeneration: 6, requestHash }),
  );
  assert.throws(() => buildCreateAuthorizationDigest({ ...common, factoryGeneration: 4 }), /does not accept/);

  const scheduled = {
    ...common,
    request: { campaign: gen6Request },
    launchAt: 1_900_000_000,
    draftReferenceHash: ethers.id("draft"),
    normalizedTickerHash: ethers.id("SIX"),
    metadataHash: ethers.id("meta"),
    reservationVersion: 1,
    authorizationNonce: 9,
    factoryGeneration: 6,
    campaignGeneration: 5,
  };
  const expected = ethers.keccak256(
    coder.encode(
      ["string", "uint256", "address", "address", "bytes32", "uint64", "bytes32", "bytes32", "bytes32", "uint64", "uint256", "uint32", "uint32", "uint8", "uint8", "uint64"],
      ["MWZ_CREATE_SCHEDULED_V2_AUTH", 56, FACTORY, CREATOR, requestHash, 1_900_000_000, scheduled.draftReferenceHash, scheduled.normalizedTickerHash, scheduled.metadataHash, 1, 9, 6, 5, 0, 0, 2_000_000_000],
    ),
  );
  assert.equal(buildScheduledCreateAuthorizationDigest(scheduled), expected);
  assert.throws(() => buildScheduledCreateAuthorizationDigest({ ...scheduled, campaignGeneration: 4 }), /requires/);

  const stock = buildRobinhoodStockCreateAuthorizationDigest({
    ...common,
    chainId: 4663,
    factoryGeneration: 6,
    stockToken: QUOTE,
    stockGraduationAdapter: ADAPTER,
    stockCampaignImplementation: IMPL,
  });
  const stockLegacyShape = buildRobinhoodStockCreateAuthorizationDigest({
    ...common,
    chainId: 4663,
    requestHash,
    stockToken: QUOTE,
    stockGraduationAdapter: ADAPTER,
    stockCampaignImplementation: IMPL,
  });
  assert.equal(stock, stockLegacyShape);
});

test("BNB BASIC quote: 5/4 (live) and 6/5 (new) only; the generation is signed and bound", () => {
  assert.equal(isSupportedBnbBasicGenerationPair(5, 4), true);
  assert.equal(isSupportedBnbBasicGenerationPair(6, 5), true);
  assert.equal(isSupportedBnbBasicGenerationPair(6, 4), false);
  const quoteInput = {
    chainId: 56, factoryAddress: FACTORY, creator: CREATOR, quoteToken: QUOTE, quoteCatalogBindingHash: ethers.id("binding"),
    adapter: ADAPTER, campaignImplementation: IMPL, tradeRouteProfileId: 0, finalizeRouteProfileId: 0, deadline: 2_000_000_000,
  };
  const live = buildBnbBasicQuoteAuthorizationDigest({ ...quoteInput, request: base });
  const liveExplicit = buildBnbBasicQuoteAuthorizationDigest({ ...quoteInput, request: base, factoryGeneration: 5, campaignGeneration: 4 });
  assert.equal(live, liveExplicit, "defaults keep today's 5/4 digest");
  const next = buildBnbBasicQuoteAuthorizationDigest({ ...quoteInput, request: gen6Request, factoryGeneration: 6, campaignGeneration: 5 });
  assert.notEqual(next, live);
  assert.throws(() => buildBnbBasicQuoteAuthorizationDigest({ ...quoteInput, request: base, factoryGeneration: 6, campaignGeneration: 4 }), /Unsupported BNB BASIC/);

  const item = {
    id: "dep-1", contractAddressOrMint: QUOTE, provider: { id: "p", key: "pk" }, policy: { policyKey: "k", version: 2 }, stateVersion: 3,
  };
  const b54 = buildBnbBasicQuoteCatalogBinding(item);
  const b65 = buildBnbBasicQuoteCatalogBinding(item, { factoryGeneration: 6, campaignGeneration: 5 });
  assert.equal(b54.factoryGeneration, 5);
  assert.equal(b65.factoryGeneration, 6);
  assert.notEqual(b54.bindingHash, b65.bindingHash);
});

const curve = { totalSupply: 1_000_000_000n * WAD, curveBps: 8000n, basePrice: 1_000_000_000n, priceSlope: 1_000n, protocolFeeBps: 200n, nativeTargetWei: 40n * WAD };

test("route-auth applyGenerationCreateFields: legacy refuses, generation 6 merges the validated fields", async () => {
  const campaignRequest = { ...base, graduationTarget: base.graduationTarget.toString() };
  const legacy = await applyGenerationCreateFields({ body: { name: "x" }, campaignRequest, factoryGeneration: 4, readContext: async () => curve });
  assert.equal(legacy.gen6, null);
  assert.deepEqual(legacy.campaignRequest, campaignRequest);
  await assert.rejects(
    applyGenerationCreateFields({ body: { feeChoice: 1 }, campaignRequest, factoryGeneration: 4, readContext: async () => curve }),
    (error) => error instanceof Gen6CreateOptionError && error.code === "GEN6_FIELDS_ON_LEGACY_FACTORY",
  );
  await assert.rejects(
    applyGenerationCreateFields({ body: {}, campaignRequest, factoryGeneration: 6, readContext: async () => curve }),
    (error) => error.code === "GEN6_FEE_CHOICE_REQUIRED",
  );
  const tokens = 1_000_000n * WAD;
  const { cost } = quoteGen6CreatorFirstBuy({ tokens, ...curve });
  const out = await applyGenerationCreateFields({
    body: { campaignRequest: { feeChoice: "split", feeCreatorPct: 25, firstBuyTokens: tokens.toString(), firstBuyMaxCost: cost.toString() } },
    campaignRequest,
    factoryGeneration: 6,
    readContext: async () => curve,
  });
  assert.equal(out.campaignRequest.feeChoice, 3);
  assert.equal(out.campaignRequest.feeCreatorPct, 25);
  assert.equal(out.campaignRequest.firstBuyTokens, tokens.toString());
  assert.equal(out.gen6.firstBuy.quotedCost, cost.toString());
  // the signed request hashes under the gen6 layout
  assert.match(hashCampaignRequest(out.campaignRequest, { factoryGeneration: 6 }), /^0x[0-9a-f]{64}$/);
});

test("scheduled arm: arm-request fields win, else the options saved on the draft (max cost priced at arm time)", async () => {
  const saved = new Map([["d1", { fee_choice: 4, fee_creator_pct: 0, first_buy_tokens: (3_000_000n * WAD).toString() }]]);
  const deps = { loadOptions: async () => saved, readContext: async () => curve };
  const fromDraft = await resolveScheduledGen6Fields(
    { body: {}, pool: {}, draftId: "d1", chainId: 56, factoryAddress: FACTORY, factoryGeneration: 6, graduationTarget: "0" },
    deps,
  );
  assert.equal(fromDraft.requestFields.feeChoice, 4);
  const { cost } = quoteGen6CreatorFirstBuy({ tokens: 3_000_000n * WAD, ...curve });
  assert.equal(fromDraft.requestFields.firstBuyMaxCost, (cost + (cost * 500n) / 10_000n).toString());

  const fromBody = await resolveScheduledGen6Fields(
    { body: { feeChoice: "keep" }, pool: {}, draftId: "d1", chainId: 56, factoryAddress: FACTORY, factoryGeneration: 6, graduationTarget: "0" },
    deps,
  );
  assert.equal(fromBody.requestFields.feeChoice, 1);
  assert.equal(fromBody.requestFields.firstBuyTokens, "0");

  await assert.rejects(
    resolveScheduledGen6Fields({ body: {}, pool: {}, draftId: "none", chainId: 56, factoryAddress: FACTORY, factoryGeneration: 6, graduationTarget: "0" }, deps),
    (error) => error.code === "GEN6_FEE_CHOICE_REQUIRED",
  );
  assert.equal(
    await resolveScheduledGen6Fields({ body: {}, pool: {}, draftId: "d1", chainId: 56, factoryAddress: FACTORY, factoryGeneration: 4, graduationTarget: "0" }, deps),
    null,
    "the live 4/3 factory arms exactly as before",
  );
});
