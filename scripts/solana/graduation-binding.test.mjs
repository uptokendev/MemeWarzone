import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { PublicKey } from "@solana/web3.js";

const require_ = createRequire(import.meta.url);
const b = require_("./graduation-binding.cjs");

const key = (seed) => PublicKey.findProgramAddressSync([Buffer.from(seed)], b.METEORA_CP_AMM)[0];

test("native quote binding matches what validate_quote_binding demands", () => {
  const q = b.nativeQuoteBinding(150_000_000n);
  assert.equal(q.quoteMint.toBase58(), "So11111111111111111111111111111111111111112");
  assert.notDeepEqual([...q.quoteConfigId], new Array(32).fill(0), "config id must be non-zero");
  assert.ok(q.quotePolicyVersion > 0, "policy version must be above zero");
  assert.equal(q.quoteProfile, 0);
  assert.equal(q.quoteProviderClass, 0);
  assert.equal(q.acquisitionProgram.toBase58(), PublicKey.default.toBase58());
  assert.equal(q.quoteRecoveryAccount.toBase58(), PublicKey.default.toBase58());
  assert.equal(q.quoteDecimals, 9, "native path requires exactly nine decimals");
  assert.equal(q.quoteReferenceUsdMicros, 150_000_000n, "reference must equal the oracle price");
  assert.equal(q.maxSlippageBps, 0);
  assert.equal(q.maxImpactBps, 0);
  assert.equal(q.maxDeviationBps, 0);
});

test("the digest changes when any signed field changes", () => {
  const base = {
    programId: key("prog"), campaign: key("camp"), mint: key("mint"),
    authority: key("auth"), generationConfig: key("gen"),
    graduationTargetUsdMicros: 6_000_000n, nativeTargetLamports: 40_000_000n,
    oraclePriceUsdMicros: 150_000_000n, pool: key("pool"), position: key("pos"),
    nftMint: key("nft"), deadline: 1_800_000_000, nonce: b.hash32("nonce"),
    finalizeRouteProfile: 0, quote: b.nativeQuoteBinding(150_000_000n),
  };
  const digest = b.graduationDigest(base);
  assert.equal(digest.length, 32);
  assert.deepEqual(digest, b.graduationDigest(base), "must be deterministic");

  // generation_config is the field v2 did not bind at all.
  assert.notDeepEqual(digest, b.graduationDigest({ ...base, generationConfig: key("other-gen") }),
    "generation_config must be covered");
  for (const field of ["campaign", "mint", "authority", "pool", "position", "nftMint"]) {
    assert.notDeepEqual(digest, b.graduationDigest({ ...base, [field]: key(`other-${field}`) }),
      `${field} must be covered`);
  }
  for (const [field, value] of [["nativeTargetLamports", 1n], ["oraclePriceUsdMicros", 1n], ["deadline", 1]]) {
    assert.notDeepEqual(digest, b.graduationDigest({ ...base, [field]: value }),
      `${field} must be covered`);
  }
  // Quote binding must be covered too, or a client could swap the quote asset.
  assert.notDeepEqual(
    digest,
    b.graduationDigest({ ...base, quote: { ...base.quote, quoteDecimals: 6 } }),
    "quote binding must be covered",
  );
});

test("native target lamports rounds up, matching the program", () => {
  // (target * 1e9 + price - 1) / price
  assert.equal(b.nativeTargetLamports(6_000_000n, 150_000_000n), 40_000_000n);
  assert.equal(b.nativeTargetLamports(1n, 3n), 333_333_334n, "must round up, never down");
  assert.throws(() => b.nativeTargetLamports(0n, 150_000_000n), /positive/);
  assert.throws(() => b.nativeTargetLamports(6_000_000n, 0n), /positive/);
});

test("graduation quote conserves the raised SOL", () => {
  const campaign = {
    tokenDecimals: 6, basePriceLamports: 1n, priceSlopeLamports: 1n,
    soldTokens: 14_000_000_000_000n, netRaisedLamports: 92_352_939n,
    finalizeFeeBps: 200, liquidityPostFinalizeBps: 8_000,
    liquidityTokenSupply: 840_000_000_000_000n,
  };
  const q = b.graduationQuote(campaign);
  assert.equal(
    q.finalizeFeeLamports + q.maxLiquidityLamports + q.creatorPayoutLamports,
    campaign.netRaisedLamports,
    "fee + LP + creator payout must equal everything raised",
  );
  assert.ok(q.maxLiquidityTokens <= campaign.liquidityTokenSupply, "LP tokens cannot exceed the reserve");
});
