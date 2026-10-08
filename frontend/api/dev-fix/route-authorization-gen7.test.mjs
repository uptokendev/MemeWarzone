import assert from "node:assert/strict";
import test from "node:test";

import {
  EVM_GEN7_CAMPAIGN_GENERATION,
  EVM_GEN7_FACTORY_GENERATION,
  assertSupportedGenerations,
  buildBnbBasicQuoteAuthorizationDigest,
  buildScheduledCreateAuthorizationDigest,
  hashCampaignRequest,
  isSupportedBnbBasicGenerationPair,
  isSupportedGenerationPair,
  requestHashLayout,
  usesGen6RequestHash,
} from "./routeAuthorizationSigner.js";
import { gen7CurveFromConfig, quoteGen7FirstBuy } from "../../shared/evmGen7Curve.mjs";
import { Gen6CreateOptionError, quoteGen6CreatorFirstBuy } from "../lib/evmLaunchGen6.js";
// route-auth.js and draft-deploy-base.js import the DB module, which needs a URL (never connected here).
process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:1/test";
const { applyGenerationCreateFields, validateGraduationTargetForGeneration } = await import("./route-auth.js");
const { normalizeTargetForGeneration, readVerifiedGenerations, resolveScheduledGen6Fields, ScheduledGenerationMismatchError } =
  await import("./draft-deploy-base.js");

const FACTORY = "0x1111111111111111111111111111111111111111";
const CREATOR = "0x2222222222222222222222222222222222222222";
const QUOTE = "0x3333333333333333333333333333333333333333";
const ADAPTER = "0x4444444444444444444444444444444444444444";
const IMPL = "0x5555555555555555555555555555555555555555";
const WAD = 10n ** 18n;
const SUPPLY = 1_000_000_000n * WAD;
const usd = (n) => (BigInt(n) * WAD).toString();

const request = {
  name: "Gen Seven",
  symbol: "SEVEN",
  logoURI: "ipfs://seven",
  xAccount: "@seven",
  website: "https://seven.test",
  extraLink: "",
  graduationTarget: 50_000n * WAD,
  firstBuyTokens: 500_000_000n * WAD,
  firstBuyMaxCost: 123456789n,
  feeChoice: 2,
  feeCreatorPct: 0,
};

const curve7 = gen7CurveFromConfig({ totalSupply: SUPPLY, curveBps: 8500n, liquidityTokenBps: 1300n, marketCapNativeWei: 80n * WAD });
const context7 = { factoryGeneration: 7, totalSupply: SUPPLY, curveBps: 8500n, ...curve7, protocolFeeBps: 200n, marketCapNativeWei: 80n * WAD, graduationRaiseWei: 1n };
const context6 = { totalSupply: SUPPLY, curveBps: 8000n, basePrice: 1_000_000_000n, priceSlope: 1_000n, protocolFeeBps: 200n, nativeTargetWei: 40n * WAD };

test("7/6 is signed wherever 6/5 is (56, 97, 4663, 46630, 31337); other 7/x pairs and other chains are refused", () => {
  assert.equal(EVM_GEN7_FACTORY_GENERATION, 7);
  assert.equal(EVM_GEN7_CAMPAIGN_GENERATION, 6);
  for (const chainId of [56, 97, 4663, 46630, 31337]) {
    assert.equal(isSupportedGenerationPair(chainId, 6, 5), true, `${chainId} keeps 6/5`);
    assert.equal(isSupportedGenerationPair(chainId, 7, 6), true, `${chainId} 7/6`);
    assert.equal(isSupportedGenerationPair(chainId, 7, 5), false);
    assert.equal(isSupportedGenerationPair(chainId, 6, 6), false);
    assert.deepEqual(assertSupportedGenerations(chainId, 7, 6), { factoryGen: 7, campaignGen: 6 });
  }
  assert.equal(isSupportedGenerationPair(1, 7, 6), false);
  assert.equal(isSupportedGenerationPair(6281971, 7, 6), false, "DogeOS is not a route-authority chain yet");
});

test("7/6 signs the same 11-field request hash as 6/5 (identical CampaignRequest and _hashCampaignRequest)", () => {
  assert.equal(usesGen6RequestHash(7), true);
  assert.equal(requestHashLayout(request, 7), "gen6");
  assert.equal(hashCampaignRequest(request, { factoryGeneration: 7 }), hashCampaignRequest(request, { factoryGeneration: 6 }));
  const scheduled = (factoryGeneration, campaignGeneration) =>
    buildScheduledCreateAuthorizationDigest({
      chainId: 56, factoryAddress: FACTORY, creator: CREATOR, request, launchAt: 1_900_000_000,
      draftReferenceHash: `0x${"aa".repeat(32)}`, normalizedTickerHash: `0x${"bb".repeat(32)}`, metadataHash: `0x${"cc".repeat(32)}`,
      reservationVersion: 1, authorizationNonce: 7, factoryGeneration, campaignGeneration,
      tradeRouteProfileId: 1, finalizeRouteProfileId: 1, deadline: 2_000_000_000,
    });
  // the scheduled digest also signs the generation pair, so 7/6 and 6/5 digests differ
  assert.notEqual(scheduled(7, 6), scheduled(6, 5));
  assert.match(scheduled(7, 6), /^0x[0-9a-f]{64}$/);
});

test("BNB BASIC quote: 7/6 joins 5/4 and 6/5; the generation is signed", () => {
  assert.equal(isSupportedBnbBasicGenerationPair(7, 6), true);
  assert.equal(isSupportedBnbBasicGenerationPair(5, 4), true);
  assert.equal(isSupportedBnbBasicGenerationPair(6, 5), true);
  assert.equal(isSupportedBnbBasicGenerationPair(7, 5), false);
  const input = {
    chainId: 56, factoryAddress: FACTORY, creator: CREATOR, request, quoteToken: QUOTE, quoteCatalogBindingHash: `0x${"11".repeat(32)}`,
    adapter: ADAPTER, campaignImplementation: IMPL, tradeRouteProfileId: 0, finalizeRouteProfileId: 0, deadline: 2_000_000_000,
  };
  const d7 = buildBnbBasicQuoteAuthorizationDigest({ ...input, factoryGeneration: 7, campaignGeneration: 6 });
  const d6 = buildBnbBasicQuoteAuthorizationDigest({ ...input, factoryGeneration: 6, campaignGeneration: 5 });
  assert.notEqual(d7, d6);
});

test("graduation targets per generation: gen-7 $30K / $50K (+ $150 on testnets); gen-6 unchanged and refuses $150", () => {
  for (const chainId of [56, 4663, 97, 46630]) {
    assert.doesNotThrow(() => validateGraduationTargetForGeneration(chainId, usd(30_000), 7));
    assert.doesNotThrow(() => validateGraduationTargetForGeneration(chainId, usd(50_000), 7));
    assert.doesNotThrow(() => validateGraduationTargetForGeneration(chainId, "0", 7));
    assert.throws(() => validateGraduationTargetForGeneration(chainId, usd(15_000), 7), /\$30,000 or \$50,000 market cap/);
    assert.throws(() => validateGraduationTargetForGeneration(chainId, usd(6), 7), /market cap/);
    // gen-6 keeps its own tiers (the first check in the handler) and never takes the gen-7 tier
    for (const t of ["0", usd(15_000), usd(30_000), usd(50_000), usd(6)]) {
      assert.doesNotThrow(() => validateGraduationTargetForGeneration(chainId, t, 6));
    }
    assert.throws(() => validateGraduationTargetForGeneration(chainId, usd(150), 6), /Unsupported graduation target/);
  }
  assert.doesNotThrow(() => validateGraduationTargetForGeneration(97, usd(150), 7));
  assert.doesNotThrow(() => validateGraduationTargetForGeneration(46630, usd(150), 7));
  assert.throws(() => validateGraduationTargetForGeneration(56, usd(150), 7));
  assert.throws(() => validateGraduationTargetForGeneration(4663, usd(150), 7));
});

test("scheduled arm targets: gen-7 tiers only for a gen-7 factory; gen-6 behaves exactly as before", () => {
  const prev = process.env.ENABLE_TEST_GRADUATION_THRESHOLD;
  try {
    delete process.env.ENABLE_TEST_GRADUATION_THRESHOLD;
    for (const chainId of [56, 4663]) {
      assert.equal(normalizeTargetForGeneration(chainId, usd(30_000), 7), usd(30_000));
      assert.equal(normalizeTargetForGeneration(chainId, usd(50_000), 7), usd(50_000));
      assert.throws(() => normalizeTargetForGeneration(chainId, usd(15_000), 7), /market cap/);
      assert.throws(() => normalizeTargetForGeneration(chainId, usd(150), 7), /market cap/);
      assert.throws(() => normalizeTargetForGeneration(chainId, "0", 7), /market cap/);
      // gen-6: the 15K / 30K / 50K tiers as before; 0 and $150 refused as before
      for (const t of [usd(15_000), usd(30_000), usd(50_000)]) assert.equal(normalizeTargetForGeneration(chainId, t, 6), t);
      assert.throws(() => normalizeTargetForGeneration(chainId, "0", 6), /Unsupported graduation target/);
      assert.throws(() => normalizeTargetForGeneration(chainId, usd(150), 6), /Unsupported graduation target/);
    }
    assert.equal(normalizeTargetForGeneration(97, usd(150), 7), usd(150));
    assert.equal(normalizeTargetForGeneration(46630, usd(150), 7), usd(150));
    assert.equal(normalizeTargetForGeneration(31337, usd(150), 7), usd(150));
    assert.throws(() => normalizeTargetForGeneration(97, usd(6), 7), /market cap/);
    assert.equal(normalizeTargetForGeneration(97, usd(6), 6), usd(6), "gen-6 $6 test tier unchanged");
    process.env.ENABLE_TEST_GRADUATION_THRESHOLD = "false";
    assert.throws(() => normalizeTargetForGeneration(97, usd(150), 7), /market cap/, "the test tier follows the same switch");
  } finally {
    if (prev === undefined) delete process.env.ENABLE_TEST_GRADUATION_THRESHOLD;
    else process.env.ENABLE_TEST_GRADUATION_THRESHOLD = prev;
  }
});

test("route-auth applyGenerationCreateFields: gen-7 merges a 70% first buy priced on the CP curve", async () => {
  const campaignRequest = { ...request, graduationTarget: request.graduationTarget.toString() };
  for (const key of ["firstBuyTokens", "firstBuyMaxCost", "feeChoice", "feeCreatorPct"]) delete campaignRequest[key];
  const tokens = (SUPPLY * 7000n) / 10_000n;
  const { total } = quoteGen7FirstBuy({ tokens, ...curve7, protocolFeeBps: 200n });
  const out = await applyGenerationCreateFields({
    body: { campaignRequest: { feeChoice: "holders", firstBuyTokens: tokens.toString(), firstBuyMaxCost: total.toString() } },
    campaignRequest,
    factoryGeneration: 7,
    readContext: async () => context7,
  });
  assert.equal(out.campaignRequest.firstBuyTokens, tokens.toString());
  assert.equal(out.campaignRequest.firstBuyMaxCost, total.toString());
  assert.equal(out.campaignRequest.feeChoice, 2);
  assert.equal(out.gen6.firstBuy.quotedCost, total.toString());
  assert.equal(out.gen6.firstBuy.curve.kind, "cp");
  await assert.rejects(
    applyGenerationCreateFields({
      body: { feeChoice: 1, firstBuyTokens: (tokens + 1n).toString(), firstBuyMaxCost: (total * 2n).toString() },
      campaignRequest,
      factoryGeneration: 7,
      readContext: async () => context7,
    }),
    (error) => error instanceof Gen6CreateOptionError && error.code === "GEN6_FIRST_BUY_TOO_LARGE" && /70%/.test(error.message),
  );
});

test("scheduled arm: gen-7 drafts get the CP-curve cost plus slack; gen-6 drafts are unchanged", async () => {
  const tokens = 200_000_000n * WAD;
  const saved = new Map([["d1", { fee_choice: 1, fee_creator_pct: 0, first_buy_tokens: tokens.toString() }]]);
  const args = { body: {}, pool: {}, draftId: "d1", chainId: 56, factoryAddress: FACTORY, graduationTarget: usd(50_000) };
  const out7 = await resolveScheduledGen6Fields({ ...args, factoryGeneration: 7 }, { loadOptions: async () => saved, readContext: async () => context7 });
  const { total } = quoteGen7FirstBuy({ tokens, ...curve7, protocolFeeBps: 200n });
  assert.equal(out7.requestFields.firstBuyMaxCost, (total + (total * 500n) / 10_000n).toString());

  const small = new Map([["d1", { fee_choice: 1, fee_creator_pct: 0, first_buy_tokens: (3_000_000n * WAD).toString() }]]);
  const out6 = await resolveScheduledGen6Fields({ ...args, factoryGeneration: 6 }, { loadOptions: async () => small, readContext: async () => context6 });
  const { cost } = quoteGen6CreatorFirstBuy({ tokens: 3_000_000n * WAD, ...context6 });
  assert.equal(out6.requestFields.firstBuyMaxCost, (cost + (cost * 500n) / 10_000n).toString());
  assert.equal(out6.firstBuy.curve, undefined, "gen-6 quote shape unchanged");
});

test("scheduled arm: the generation pair is read from the factory on the draft's chain, not from the request", async () => {
  const calls = [];
  const reader = (pair) => async (args) => {
    calls.push(args);
    return pair;
  };
  // On-chain 7/6, preflight agrees.
  assert.deepEqual(
    await readVerifiedGenerations(97, { onChainPreflight: { factoryGeneration: 7, campaignGeneration: 6 } }, { factoryAddress: FACTORY, readGenerations: reader({ factoryGeneration: 7, campaignGeneration: 6 }) }),
    { factoryGeneration: 7, campaignGeneration: 6 },
  );
  assert.deepEqual(calls[0], { chainId: 97, factoryAddress: FACTORY });
  // No preflight in the body: the on-chain pair is used.
  assert.deepEqual(
    await readVerifiedGenerations(56, {}, { factoryAddress: FACTORY, readGenerations: reader({ factoryGeneration: 6, campaignGeneration: 5 }) }),
    { factoryGeneration: 6, campaignGeneration: 5 },
  );
  // The request claims gen-6, the factory is gen-7: refused as a mismatch.
  await assert.rejects(
    readVerifiedGenerations(97, { onChainPreflight: { factoryGeneration: 6, campaignGeneration: 5 } }, { factoryAddress: FACTORY, readGenerations: reader({ factoryGeneration: 7, campaignGeneration: 6 }) }),
    (error) => error instanceof ScheduledGenerationMismatchError && /says 6\/5/.test(error.message) && /reports 7\/6/.test(error.message),
  );
  // An unsupported on-chain pair keeps the existing message (not a mismatch error).
  await assert.rejects(
    readVerifiedGenerations(56, { onChainPreflight: { factoryGeneration: 5, campaignGeneration: 4 } }, { factoryAddress: FACTORY, readGenerations: reader({ factoryGeneration: 5, campaignGeneration: 4 }) }),
    (error) => !(error instanceof ScheduledGenerationMismatchError) && /^Verified on-chain factory generation is required before scheduled authorization; chain 56 requires .*got 5\/4\.$/.test(error.message),
  );
  // An unreadable factory is refused, even when the request carries a supported pair.
  await assert.rejects(
    readVerifiedGenerations(97, { onChainPreflight: { factoryGeneration: 7, campaignGeneration: 6 } }, {
      factoryAddress: FACTORY,
      readGenerations: async () => {
        throw new Error("call revert");
      },
    }),
    (error) => !(error instanceof ScheduledGenerationMismatchError) && /got 0\/0\.$/.test(error.message),
  );
});
