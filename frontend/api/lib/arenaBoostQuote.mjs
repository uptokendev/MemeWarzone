import crypto from "node:crypto";
import { Wallet } from "ethers";

export const BOOST_USD_MICROS = 1_000_000n;
export const EVM_NATIVE_DECIMALS = 18;
export const DEFAULT_QUOTE_TTL_SECONDS = 300;
export const DEFAULT_PRICE_MAX_AGE_SECONDS = 300;

function positiveBigInt(value, label) {
  try {
    const parsed = BigInt(String(value));
    if (parsed <= 0n) throw new Error(`${label} must be positive`);
    return parsed;
  } catch (error) {
    if (error instanceof Error && /must be positive/.test(error.message)) throw error;
    throw new Error(`${label} must be a positive integer`);
  }
}

export function ceilDiv(numerator, denominator) {
  const n = positiveBigInt(numerator, "numerator");
  const d = positiveBigInt(denominator, "denominator");
  return (n + d - 1n) / d;
}

export function unitPriceNativeRawFromUsdMicros({ usdMicros = BOOST_USD_MICROS, nativeUsdMicros, nativeDecimals = EVM_NATIVE_DECIMALS }) {
  const usd = positiveBigInt(usdMicros, "usdMicros");
  const nativeUsd = positiveBigInt(nativeUsdMicros, "nativeUsdMicros");
  const decimals = Number(nativeDecimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("nativeDecimals is invalid");
  const scale = 10n ** BigInt(decimals);
  return ceilDiv(usd * scale, nativeUsd);
}

export function readBoostPricingConfig(chainId, env = process.env, nowSeconds = Math.floor(Date.now() / 1000)) {
  const chain = Number(chainId);
  if (!Number.isInteger(chain) || chain <= 0) throw new Error("chainId is invalid");
  const nativeUsdRaw = env[`ARENA_BOOST_NATIVE_USD_MICROS_${chain}`] || env.ARENA_BOOST_NATIVE_USD_MICROS;
  const pricingVersionRaw = env[`ARENA_BOOST_PRICING_VERSION_${chain}`] || env.ARENA_BOOST_PRICING_VERSION;
  const priceUpdatedAtRaw =
    env[`ARENA_BOOST_NATIVE_USD_UPDATED_AT_${chain}`] || env.ARENA_BOOST_NATIVE_USD_UPDATED_AT;
  const maxAgeRaw = env[`ARENA_BOOST_PRICE_MAX_AGE_SECONDS_${chain}`] || env.ARENA_BOOST_PRICE_MAX_AGE_SECONDS || DEFAULT_PRICE_MAX_AGE_SECONDS;
  const treasuryAddress = String(
    env[`ARENA_WAR_POOL_TREASURY_V2_ADDRESS_${chain}`] || env[`ARENA_WAR_POOL_TREASURY_ADDRESS_${chain}`] || "",
  ).trim();
  const signerKey = String(env.ARENA_BOOST_QUOTE_SIGNER_PRIVATE_KEY || "").trim();
  if (!nativeUsdRaw || !pricingVersionRaw || !priceUpdatedAtRaw || !treasuryAddress || !signerKey) {
    throw new Error("Battle Boost pricing/signing is not configured for this chain");
  }
  const nativeUsdMicros = positiveBigInt(nativeUsdRaw, "nativeUsdMicros");
  const pricingVersion = positiveBigInt(pricingVersionRaw, "pricingVersion");
  const priceUpdatedAt = positiveBigInt(priceUpdatedAtRaw, "priceUpdatedAt");
  const maxAgeSeconds = positiveBigInt(maxAgeRaw, "maxAgeSeconds");
  const now = BigInt(nowSeconds);
  if (priceUpdatedAt > now || now - priceUpdatedAt > maxAgeSeconds) {
    throw new Error("Battle Boost native/USD price is stale");
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(treasuryAddress)) throw new Error("Arena War Pool V2 address is invalid");
  const signer = new Wallet(signerKey);
  const configuredSigner = String(env[`ARENA_BOOST_QUOTE_SIGNER_ADDRESS_${chain}`] || env.ARENA_BOOST_QUOTE_SIGNER_ADDRESS || "").trim();
  if (configuredSigner && signer.address.toLowerCase() !== configuredSigner.toLowerCase()) {
    throw new Error("Battle Boost quote signer key/address mismatch");
  }
  return { chainId: chain, nativeUsdMicros, pricingVersion, priceUpdatedAt, maxAgeSeconds, treasuryAddress, signer };
}

export function buildBoostQuote({
  chainId,
  treasuryAddress,
  poolId,
  matchId,
  roundNumber,
  booster,
  sideToken,
  boostUnits,
  nativeUsdMicros,
  pricingVersion,
  oracleTimestamp,
  nonce,
  deadline,
}) {
  const units = positiveBigInt(boostUnits, "boostUnits");
  const unitPriceNativeRaw = unitPriceNativeRawFromUsdMicros({ nativeUsdMicros });
  const grossNativeRaw = unitPriceNativeRaw * units;
  return {
    domain: {
      name: "ArenaWarPoolTreasury",
      version: "2",
      chainId: Number(chainId),
      verifyingContract: treasuryAddress,
    },
    types: {
      BoostQuote: [
        { name: "poolId", type: "bytes32" },
        { name: "matchId", type: "bytes32" },
        { name: "roundNumber", type: "uint256" },
        { name: "booster", type: "address" },
        { name: "sideToken", type: "address" },
        { name: "boostUnits", type: "uint256" },
        { name: "unitPriceNativeRaw", type: "uint256" },
        { name: "grossNativeRaw", type: "uint256" },
        { name: "pricingVersion", type: "uint256" },
        { name: "oracleTimestamp", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    value: {
      poolId,
      matchId,
      roundNumber: BigInt(roundNumber),
      booster,
      sideToken,
      boostUnits: units,
      unitPriceNativeRaw,
      grossNativeRaw,
      pricingVersion: positiveBigInt(pricingVersion, "pricingVersion"),
      oracleTimestamp: BigInt(oracleTimestamp),
      nonce: BigInt(nonce),
      deadline: BigInt(deadline),
    },
    nativeUsdMicros: positiveBigInt(nativeUsdMicros, "nativeUsdMicros"),
  };
}

export async function signBoostQuote(config, quoteInput) {
  const quote = buildBoostQuote({
    chainId: config.chainId,
    treasuryAddress: config.treasuryAddress,
    nativeUsdMicros: config.nativeUsdMicros,
    pricingVersion: config.pricingVersion,
    oracleTimestamp: config.priceUpdatedAt,
    ...quoteInput,
  });
  const signature = await config.signer.signTypedData(quote.domain, quote.types, quote.value);
  return { ...quote, signature, signer: config.signer.address };
}

export function randomBoostNonce() {
  return BigInt(`0x${crypto.randomBytes(16).toString("hex")}`);
}

export function serializeSignedBoostQuote(signed) {
  return {
    domain: signed.domain,
    value: Object.fromEntries(Object.entries(signed.value).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value])),
    signature: signed.signature,
    signer: signed.signer,
    nativeUsdMicros: signed.nativeUsdMicros.toString(),
  };
}
