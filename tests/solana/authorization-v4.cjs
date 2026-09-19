"use strict";

const crypto = require("node:crypto");
const { PublicKey } = require("@solana/web3.js");

const CREATE_AUTH_DOMAIN = Buffer.from("MEMEWARZONE_SOLANA_CREATE_V5", "utf8");
// v5 binds the Metaplex name and symbol into the create authorization. Must stay
// byte-identical to programs/memewarzone_solana/src/authorized_create.rs and to
// frontend/api/dev-fix/solana-v4-primitives.js.
const CREATE_AUTH_SCHEMA_VERSION = 5;
const METAPLEX_MAX_NAME_BYTES = 32;
const METAPLEX_MAX_SYMBOL_BYTES = 10;

function borshString(value, maxBytes, label) {
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  if (bytes.length === 0) throw new TypeError(`${label} must not be empty`);
  if (bytes.length > maxBytes) {
    throw new TypeError(`${label} is ${bytes.length} bytes, over the ${maxBytes}-byte Metaplex limit`);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

function toBigInt(value, name) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`${name} must be a safe integer, bigint, string, or BN-like value`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") return BigInt(value);
  if (value && typeof value.toString === "function") {
    return BigInt(value.toString());
  }
  throw new TypeError(`${name} is not integer-like`);
}

function unsigned(value, bits, name) {
  const n = toBigInt(value, name);
  const maximum = (1n << BigInt(bits)) - 1n;
  if (n < 0n || n > maximum) {
    throw new RangeError(`${name} does not fit in u${bits}`);
  }

  const buffer = Buffer.alloc(bits / 8);
  if (bits === 8) buffer.writeUInt8(Number(n), 0);
  else if (bits === 16) buffer.writeUInt16LE(Number(n), 0);
  else if (bits === 32) buffer.writeUInt32LE(Number(n), 0);
  else if (bits === 64) buffer.writeBigUInt64LE(n, 0);
  else throw new RangeError(`Unsupported unsigned width: ${bits}`);
  return buffer;
}

function i64(value, name) {
  const n = toBigInt(value, name);
  const minimum = -(1n << 63n);
  const maximum = (1n << 63n) - 1n;
  if (n < minimum || n > maximum) {
    throw new RangeError(`${name} does not fit in i64`);
  }
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64LE(n, 0);
  return buffer;
}

function u8(value, name) {
  return unsigned(value, 8, name);
}

function u16(value, name) {
  return unsigned(value, 16, name);
}

function u32(value, name) {
  return unsigned(value, 32, name);
}

function u64(value, name) {
  return unsigned(value, 64, name);
}

function booleanByte(value, name) {
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean`);
  }
  return Buffer.from([value ? 1 : 0]);
}

function bytes32(value, name) {
  const buffer = Buffer.from(value);
  if (buffer.length !== 32) {
    throw new RangeError(`${name} must contain exactly 32 bytes; received ${buffer.length}`);
  }
  return buffer;
}

function pubkey(value, name) {
  try {
    return Buffer.from(new PublicKey(value).toBytes());
  } catch (error) {
    throw new TypeError(`${name} is not a valid Solana public key: ${error.message}`);
  }
}

function buildCreateAuthorizationPayload(input) {
  const {
    programId,
    generationConfigKey,
    generation,
    creator,
    riskClusterId,
    creatorBuyLockSeconds,
    creatorBuyCapBps,
    campaign,
    mint,
    tokenVault,
    solVault,
    tokenProgram,
    args,
  } = input;

  if (!generation || !args) {
    throw new TypeError("generation and args are required");
  }

  return Buffer.concat([
    CREATE_AUTH_DOMAIN,
    u16(CREATE_AUTH_SCHEMA_VERSION, "schemaVersion"),
    pubkey(programId, "programId"),
    bytes32(args.clusterHash, "args.clusterHash"),

    bytes32(generation.generationId, "generation.generationId"),
    pubkey(generationConfigKey, "generationConfigKey"),
    pubkey(generation.programId, "generation.programId"),
    pubkey(generation.configPda, "generation.configPda"),
    u64(generation.startSlot, "generation.startSlot"),
    u8(generation.clusterKind, "generation.clusterKind"),
    u8(
      generation.allowedGraduationTierMask,
      "generation.allowedGraduationTierMask",
    ),
    u16(generation.economicsVersion, "generation.economicsVersion"),
    u8(generation.curveKind, "generation.curveKind"),
    u64(generation.tokenTotalSupply, "generation.tokenTotalSupply"),
    u8(generation.tokenDecimals, "generation.tokenDecimals"),
    u16(generation.curveSupplyBps, "generation.curveSupplyBps"),
    u16(generation.liquidityTokenBps, "generation.liquidityTokenBps"),
    u64(generation.basePriceLamports, "generation.basePriceLamports"),
    u64(generation.priceSlopeLamports, "generation.priceSlopeLamports"),
    u16(generation.buyFeeBps, "generation.buyFeeBps"),
    u16(generation.sellFeeBps, "generation.sellFeeBps"),
    u16(generation.finalizeFeeBps, "generation.finalizeFeeBps"),
    u16(
      generation.creatorPostFinalizeBps,
      "generation.creatorPostFinalizeBps",
    ),
    u16(
      generation.liquidityPostFinalizeBps,
      "generation.liquidityPostFinalizeBps",
    ),
    u8(generation.dexAdapter, "generation.dexAdapter"),
    bytes32(generation.tradeRouteProfile, "generation.tradeRouteProfile"),
    bytes32(
      generation.finalizeRouteProfile,
      "generation.finalizeRouteProfile",
    ),
    bytes32(generation.treasuryProfile, "generation.treasuryProfile"),
    bytes32(generation.dexProfile, "generation.dexProfile"),
    bytes32(generation.oracleProfile, "generation.oracleProfile"),
    bytes32(generation.manifestHash, "generation.manifestHash"),
    booleanByte(
      generation.routeAuthorizationRequired,
      "generation.routeAuthorizationRequired",
    ),
    booleanByte(
      generation.authorizedTradingRequired,
      "generation.authorizedTradingRequired",
    ),

    pubkey(creator, "creator"),
    bytes32(riskClusterId, "riskClusterId"),
    u32(creatorBuyLockSeconds, "creatorBuyLockSeconds"),
    u16(creatorBuyCapBps, "creatorBuyCapBps"),
    bytes32(args.campaignId, "args.campaignId"),
    pubkey(campaign, "campaign"),
    pubkey(mint, "mint"),
    pubkey(tokenVault, "tokenVault"),
    pubkey(solVault, "solVault"),
    pubkey(tokenProgram, "tokenProgram"),
    bytes32(args.metadataHash, "args.metadataHash"),
    borshString(args.name, METAPLEX_MAX_NAME_BYTES, "args.name"),
    borshString(args.symbol, METAPLEX_MAX_SYMBOL_BYTES, "args.symbol"),
    bytes32(args.tickerHash, "args.tickerHash"),
    bytes32(args.reservationIdHash, "args.reservationIdHash"),
    u64(args.reservationVersion, "args.reservationVersion"),
    i64(args.launchAt, "args.launchAt"),
    u64(
      args.graduationTargetUsdMicros,
      "args.graduationTargetUsdMicros",
    ),
    bytes32(args.nonce, "args.nonce"),
    i64(args.deadline, "args.deadline"),
  ]);
}

function createAuthorizationDigest(input) {
  return crypto
    .createHash("sha256")
    .update(buildCreateAuthorizationPayload(input))
    .digest();
}

module.exports = {
  CREATE_AUTH_DOMAIN,
  CREATE_AUTH_SCHEMA_VERSION,
  borshString,
  buildCreateAuthorizationPayload,
  createAuthorizationDigest,
};
