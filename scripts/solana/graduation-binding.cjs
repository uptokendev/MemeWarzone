"use strict";
/**
 * Shared graduation maths and the v4 authorization binding.
 *
 * Extracted from tests/solana/v4-lifecycle-acceptance.cjs so the operator and
 * the acceptance suite compute the same numbers from the same source. They used
 * to be one copy in a test, which is how the program reached schema 4 while
 * everything that called it still signed schema 2.
 */
const crypto = require("node:crypto");
const { PublicKey } = require("@solana/web3.js");

const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const METEORA_CP_AMM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const GRADUATION_AUTH_DOMAIN = Buffer.from("MEMEWARZONE_SOLANA_GRADUATION_V1", "utf8");
const GRADUATION_AUTH_SCHEMA_VERSION = 4;
const QUOTE_PROFILE_NATIVE = 0;
const QUOTE_PROVIDER_NATIVE = 0;

const u16le = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(Number(v)); return b; };
const u64le = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const i64le = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
const hash32 = (label) => crypto.createHash("sha256").update(label, "utf8").digest();
const bpsAmount = (amount, bps) => (BigInt(amount) * BigInt(bps)) / 10_000n;

/** Lamports of SOL that satisfy a USD graduation target at a given oracle price. */
function nativeTargetLamports(targetUsdMicros, oraclePriceUsdMicros) {
  const target = BigInt(targetUsdMicros);
  const price = BigInt(oraclePriceUsdMicros);
  if (target <= 0n || price <= 0n) throw new Error("graduation target and oracle price must be positive");
  return (target * 1_000_000_000n + price - 1n) / price;
}

/** How the curve's SOL and tokens split between LP, creator payout and fee. */
function graduationQuote(campaign) {
  const scale = 10n ** BigInt(campaign.tokenDecimals);
  const nano = 1_000_000_000n;
  const spot =
    BigInt(campaign.basePriceLamports) * nano
    + (BigInt(campaign.priceSlopeLamports) * BigInt(campaign.soldTokens)) / scale;
  const finalizeFee = bpsAmount(campaign.netRaisedLamports, campaign.finalizeFeeBps);
  const remaining = BigInt(campaign.netRaisedLamports) - finalizeFee;
  const targetLiquidity = bpsAmount(remaining, campaign.liquidityPostFinalizeBps);
  const desiredTokens = (targetLiquidity * scale * nano) / spot;
  const maxTokens = desiredTokens < BigInt(campaign.liquidityTokenSupply)
    ? desiredTokens
    : BigInt(campaign.liquidityTokenSupply);
  const lpSol = desiredTokens <= BigInt(campaign.liquidityTokenSupply)
    ? targetLiquidity
    : (maxTokens * spot) / (scale * nano);
  return {
    spotNano: spot,
    finalizeFeeLamports: finalizeFee,
    maxLiquidityLamports: lpSol,
    maxLiquidityTokens: maxTokens,
    creatorPayoutLamports: remaining - lpSol,
  };
}

function orderedPubkeys(a, b) {
  return Buffer.compare(a.toBuffer(), b.toBuffer()) > 0 ? [a, b] : [b, a];
}

function deriveMeteoraPool(launchMint) {
  const [first, second] = orderedPubkeys(launchMint, NATIVE_MINT);
  return PublicKey.findProgramAddressSync(
    // "cpool", not "pool": the DAMM v2 custom-pool seed.
    [Buffer.from("cpool"), first.toBuffer(), second.toBuffer()],
    METEORA_CP_AMM,
  )[0];
}

function deriveMeteoraPosition(positionNftMint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), positionNftMint.toBuffer()],
    METEORA_CP_AMM,
  )[0];
}

/**
 * Native-SOL quote binding.
 *
 * validate_quote_binding in graduation.rs requires exactly this shape when the
 * quote mint is native: any deviation is rejected as
 * InvalidGraduationAuthorization with no indication of which field was wrong.
 */
function nativeQuoteBinding(oraclePriceUsdMicros) {
  return {
    quoteMint: NATIVE_MINT,
    quoteConfigId: hash32("quote-config:native-sol"),
    quotePolicyVersion: 1,
    quoteProfile: QUOTE_PROFILE_NATIVE,
    quoteProviderClass: QUOTE_PROVIDER_NATIVE,
    acquisitionProgram: PublicKey.default,
    quoteReferenceUsdMicros: BigInt(oraclePriceUsdMicros),
    quoteDecimals: 9,
    expectedQuoteAmount: 0n,
    minQuoteAmount: 0n,
    maxSlippageBps: 0,
    maxImpactBps: 0,
    maxDeviationBps: 0,
    quoteRecoveryAccount: PublicKey.default,
  };
}

/**
 * The 32-byte digest the route signer signs.
 *
 * Build this and the instruction args from one input object. Every field is
 * signature-covered, so building them separately makes them disagree silently.
 */
function graduationDigest(input) {
  const q = input.quote;
  return crypto.createHash("sha256").update(Buffer.concat([
    GRADUATION_AUTH_DOMAIN,
    u16le(GRADUATION_AUTH_SCHEMA_VERSION),
    input.programId.toBuffer(),
    input.campaign.toBuffer(),
    input.mint.toBuffer(),
    input.authority.toBuffer(),
    input.generationConfig.toBuffer(),
    u64le(input.graduationTargetUsdMicros),
    u64le(input.nativeTargetLamports),
    u64le(input.oraclePriceUsdMicros),
    input.pool.toBuffer(),
    input.position.toBuffer(),
    input.nftMint.toBuffer(),
    i64le(input.deadline),
    input.nonce,
    Buffer.from([input.finalizeRouteProfile]),
    q.quoteMint.toBuffer(),
    q.quoteConfigId,
    u16le(q.quotePolicyVersion),
    Buffer.from([q.quoteProfile]),
    Buffer.from([q.quoteProviderClass]),
    q.acquisitionProgram.toBuffer(),
    u64le(q.quoteReferenceUsdMicros),
    Buffer.from([q.quoteDecimals]),
    u64le(q.expectedQuoteAmount),
    u64le(q.minQuoteAmount),
    u16le(q.maxSlippageBps),
    u16le(q.maxImpactBps),
    u16le(q.maxDeviationBps),
    q.quoteRecoveryAccount.toBuffer(),
  ])).digest();
}

/** Anchor args for the same binding the digest covers. */
function beginGraduationArgs(input, BN) {
  const q = input.quote;
  return {
    nativeTargetLamports: new BN(input.nativeTargetLamports.toString()),
    oraclePriceUsdMicros: new BN(input.oraclePriceUsdMicros.toString()),
    deadline: new BN(input.deadline),
    nonce: Array.from(input.nonce),
    positionNftMint: input.nftMint,
    finalizeRouteProfile: input.finalizeRouteProfile,
    quoteMint: q.quoteMint,
    quoteConfigId: Array.from(q.quoteConfigId),
    quotePolicyVersion: q.quotePolicyVersion,
    quoteProfile: q.quoteProfile,
    quoteProviderClass: q.quoteProviderClass,
    acquisitionProgram: q.acquisitionProgram,
    quoteReferenceUsdMicros: new BN(q.quoteReferenceUsdMicros.toString()),
    quoteDecimals: q.quoteDecimals,
    expectedQuoteAmount: new BN(q.expectedQuoteAmount.toString()),
    minQuoteAmount: new BN(q.minQuoteAmount.toString()),
    maxSlippageBps: q.maxSlippageBps,
    maxImpactBps: q.maxImpactBps,
    maxDeviationBps: q.maxDeviationBps,
    quoteRecoveryAccount: q.quoteRecoveryAccount,
  };
}

module.exports = {
  NATIVE_MINT,
  METEORA_CP_AMM,
  GRADUATION_AUTH_DOMAIN,
  GRADUATION_AUTH_SCHEMA_VERSION,
  beginGraduationArgs,
  deriveMeteoraPool,
  deriveMeteoraPosition,
  graduationDigest,
  graduationQuote,
  hash32,
  nativeQuoteBinding,
  nativeTargetLamports,
};
