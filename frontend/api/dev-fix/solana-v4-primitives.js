import crypto from "node:crypto";

export const CREATE_AUTH_DOMAIN = Buffer.from("MEMEWARZONE_SOLANA_CREATE_V7", "utf8");
// v6 takes the Metaplex name and symbol back out of this message: they moved to
// finalize_campaign_launch along with the metadata account itself, so create no
// longer receives them. The domain changes with the message shape, so a v5
// signature can never authorize a v6 create — an operator still running a v5
// backend fails closed rather than signing a message the program reads
// differently.
export const CREATE_AUTH_SCHEMA_VERSION = 7;
export const METAPLEX_MAX_NAME_BYTES = 32;
export const METAPLEX_MAX_SYMBOL_BYTES = 10;
export const METAPLEX_MAX_URI_BYTES = 200;
export const PROGRAM_DERIVED_ADDRESS_MARKER = Buffer.from("ProgramDerivedAddress", "utf8");
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SYSVAR_INSTRUCTIONS_ID = "Sysvar1nstructions1111111111111111111111111";

export const MPL_TOKEN_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

/**
 * The name and symbol written into the Metaplex account.
 *
 * Trimmed to Metaplex's own caps rather than rejected: a creator should not have
 * a launch fail because their name is 34 characters. The untrimmed values stay
 * in the database and in the metadata JSON.
 *
 * The uri is NOT here. The program derives it from the mint, so there is no
 * environment variable that can misconfigure it and no way for a client to
 * substitute one.
 */
export function buildMetaplexFields({ name, symbol }) {
  const clip = (value, maxBytes, fallback) => {
    let text = String(value ?? "").trim() || fallback;
    while (Buffer.byteLength(text, "utf8") > maxBytes) text = text.slice(0, -1);
    return text;
  };
  return {
    name: clip(name, METAPLEX_MAX_NAME_BYTES, "MemeWarzone Token"),
    symbol: clip(symbol, METAPLEX_MAX_SYMBOL_BYTES, "MWZ"),
  };
}


const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map(Array.from(BASE58_ALPHABET).map((char, index) => [char, index]));
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const FIELD_PRIME = (1n << 255n) - 19n;
const FIELD_D = mod(-121665n * modInverse(121666n));
const SQRT_MINUS_ONE = modPow(2n, (FIELD_PRIME - 1n) / 4n, FIELD_PRIME);

function mod(value, modulus = FIELD_PRIME) {
  const out = value % modulus;
  return out >= 0n ? out : out + modulus;
}

function modPow(base, exponent, modulus = FIELD_PRIME) {
  let result = 1n;
  let value = mod(base, modulus);
  let power = BigInt(exponent);
  while (power > 0n) {
    if (power & 1n) result = (result * value) % modulus;
    value = (value * value) % modulus;
    power >>= 1n;
  }
  return result;
}

function modInverse(value) {
  return modPow(mod(value), FIELD_PRIME - 2n, FIELD_PRIME);
}

function bytesToBigIntLittleEndian(value) {
  const bytes = Buffer.from(value);
  let result = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    result = (result << 8n) | BigInt(bytes[index]);
  }
  return result;
}

export function decodeBase58(value, label = "base58 value") {
  const input = String(value || "").trim();
  if (!input) throw new TypeError(`${label} is required`);

  let number = 0n;
  for (const char of input) {
    const digit = BASE58_INDEX.get(char);
    if (digit == null) throw new TypeError(`${label} is not valid base58`);
    number = number * 58n + BigInt(digit);
  }

  let hex = number.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const body = number === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  let leadingZeroes = 0;
  while (leadingZeroes < input.length && input[leadingZeroes] === "1") leadingZeroes += 1;
  return Buffer.concat([Buffer.alloc(leadingZeroes), body]);
}

export function encodeBase58(value) {
  const bytes = Buffer.from(value);
  if (!bytes.length) return "";

  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1;

  const hex = bytes.toString("hex");
  let number = hex ? BigInt(`0x${hex}`) : 0n;
  let encoded = "";
  while (number > 0n) {
    const remainder = Number(number % 58n);
    encoded = BASE58_ALPHABET[remainder] + encoded;
    number /= 58n;
  }

  return "1".repeat(leadingZeroes) + encoded;
}

export function publicKeyBytes(value, label = "public key") {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || Array.isArray(value)) {
    const bytes = Buffer.from(value);
    if (bytes.length !== 32) throw new RangeError(`${label} must contain exactly 32 bytes`);
    return bytes;
  }

  const bytes = decodeBase58(value, label);
  if (bytes.length !== 32) throw new RangeError(`${label} must decode to exactly 32 bytes`);
  return bytes;
}

export function publicKeyString(value, label = "public key") {
  return encodeBase58(publicKeyBytes(value, label));
}

export function bytes32(value, label = "bytes32") {
  let output;
  if (typeof value === "string") {
    const raw = value.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
      throw new TypeError(`${label} must be a 32-byte hexadecimal string`);
    }
    output = Buffer.from(raw, "hex");
  } else {
    output = Buffer.from(value || []);
  }
  if (output.length !== 32) throw new RangeError(`${label} must contain exactly 32 bytes`);
  return output;
}

export function nonZeroBytes32(value, label = "bytes32") {
  const output = bytes32(value, label);
  if (output.equals(Buffer.alloc(32))) throw new RangeError(`${label} must not be zero`);
  return output;
}

export function integerToBytes32(value, label = "integer") {
  const number = toBigInt(value, label);
  if (number < 0n || number >= (1n << 256n)) throw new RangeError(`${label} does not fit in 32 bytes`);
  const output = Buffer.alloc(32);
  let remaining = number;
  for (let index = 31; index >= 0; index -= 1) {
    output[index] = Number(remaining & 255n);
    remaining >>= 8n;
  }
  return output;
}

export function sha256(...values) {
  const hash = crypto.createHash("sha256");
  for (const value of values) hash.update(Buffer.isBuffer(value) ? value : Buffer.from(value));
  return hash.digest();
}

export function sha256Hex(...values) {
  return sha256(...values).toString("hex");
}

export function accountDiscriminator(accountName) {
  return sha256(Buffer.from(`account:${accountName}`, "utf8")).subarray(0, 8);
}

export function isEd25519Point(value) {
  const compressed = Buffer.from(value);
  if (compressed.length !== 32) return false;

  const encoded = bytesToBigIntLittleEndian(compressed);
  const sign = Number((encoded >> 255n) & 1n);
  const y = encoded & ((1n << 255n) - 1n);
  if (y >= FIELD_PRIME) return false;

  const ySquared = mod(y * y);
  const numerator = mod(ySquared - 1n);
  const denominator = mod(FIELD_D * ySquared + 1n);
  if (denominator === 0n) return false;

  const xSquared = mod(numerator * modInverse(denominator));
  let x = modPow(xSquared, (FIELD_PRIME + 3n) / 8n, FIELD_PRIME);
  if (mod(x * x - xSquared) !== 0n) x = mod(x * SQRT_MINUS_ONE);
  if (mod(x * x - xSquared) !== 0n) return false;
  if (x === 0n && sign === 1) return false;
  return true;
}

function normalizeSeed(value, label) {
  const seed = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value || []);
  if (seed.length > 32) throw new RangeError(`${label} exceeds Solana's 32-byte seed limit`);
  return seed;
}

export function createProgramAddressSync(seedValues, programId) {
  if (!Array.isArray(seedValues) || seedValues.length > 16) {
    throw new RangeError("Solana PDA derivation accepts at most 16 seeds");
  }
  const seeds = seedValues.map((seed, index) => normalizeSeed(seed, `seed ${index}`));
  const digest = sha256(
    ...seeds,
    publicKeyBytes(programId, "programId"),
    PROGRAM_DERIVED_ADDRESS_MARKER,
  );
  if (isEd25519Point(digest)) throw new Error("Derived address is on the Ed25519 curve");
  return digest;
}

export function findProgramAddressSync(seedValues, programId) {
  for (let bump = 255; bump >= 0; bump -= 1) {
    try {
      const addressBytes = createProgramAddressSync([...seedValues, Buffer.from([bump])], programId);
      return {
        publicKey: encodeBase58(addressBytes),
        publicKeyBytes: addressBytes,
        bump,
      };
    } catch (error) {
      if (error?.message !== "Derived address is on the Ed25519 curve") throw error;
    }
  }
  throw new Error("Unable to find a viable Solana program-derived address");
}

export function toBigInt(value, label = "integer") {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer`);
    return BigInt(value);
  }
  if (typeof value === "string" && value.trim()) return BigInt(value.trim());
  if (value && typeof value.toString === "function") return BigInt(value.toString());
  throw new TypeError(`${label} is not integer-like`);
}

function unsigned(value, bits, label) {
  const number = toBigInt(value, label);
  const maximum = (1n << BigInt(bits)) - 1n;
  if (number < 0n || number > maximum) throw new RangeError(`${label} does not fit in u${bits}`);

  const output = Buffer.alloc(bits / 8);
  if (bits === 8) output.writeUInt8(Number(number), 0);
  else if (bits === 16) output.writeUInt16LE(Number(number), 0);
  else if (bits === 32) output.writeUInt32LE(Number(number), 0);
  else if (bits === 64) output.writeBigUInt64LE(number, 0);
  else throw new RangeError(`Unsupported unsigned integer width: ${bits}`);
  return output;
}

export function u8(value, label = "u8") {
  return unsigned(value, 8, label);
}

export function u16(value, label = "u16") {
  return unsigned(value, 16, label);
}

/**
 * Borsh string for the signed message: u32 little-endian BYTE length, then UTF-8.
 *
 * Must match programs/memewarzone_solana/src/authorized_create.rs exactly. A
 * mismatch here does not fail loudly; it produces a signature the program
 * rejects with no indication of which field diverged.
 */

export function borshString(value, maxBytes, label) {
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  if (bytes.length === 0) throw new TypeError(`${label} must not be empty`);
  if (bytes.length > maxBytes) {
    throw new TypeError(`${label} is ${bytes.length} bytes, over the ${maxBytes}-byte Metaplex limit`);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

export function u32(value, label = "u32") {
  return unsigned(value, 32, label);
}

export function u64(value, label = "u64") {
  return unsigned(value, 64, label);
}

export function i64(value, label = "i64") {
  const number = toBigInt(value, label);
  const minimum = -(1n << 63n);
  const maximum = (1n << 63n) - 1n;
  if (number < minimum || number > maximum) throw new RangeError(`${label} does not fit in i64`);
  const output = Buffer.alloc(8);
  output.writeBigInt64LE(number, 0);
  return output;
}

export function booleanByte(value, label = "boolean") {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return Buffer.from([value ? 1 : 0]);
}

export function buildCreateAuthorizationPayload(input) {
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
  } = input || {};

  if (!generation || !args) throw new TypeError("generation and args are required");

  return Buffer.concat([
    CREATE_AUTH_DOMAIN,
    u16(CREATE_AUTH_SCHEMA_VERSION, "schemaVersion"),
    publicKeyBytes(programId, "programId"),

    bytes32(generation.generationId, "generation.generationId"),
    publicKeyBytes(generationConfigKey, "generationConfigKey"),
    publicKeyBytes(generation.programId, "generation.programId"),
    publicKeyBytes(generation.configPda, "generation.configPda"),
    u64(generation.startSlot, "generation.startSlot"),
    u8(generation.clusterKind, "generation.clusterKind"),
    u8(generation.allowedGraduationTierMask, "generation.allowedGraduationTierMask"),
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
    u16(generation.creatorPostFinalizeBps, "generation.creatorPostFinalizeBps"),
    u16(generation.liquidityPostFinalizeBps, "generation.liquidityPostFinalizeBps"),
    u8(generation.dexAdapter, "generation.dexAdapter"),
    bytes32(generation.tradeRouteProfile, "generation.tradeRouteProfile"),
    bytes32(generation.finalizeRouteProfile, "generation.finalizeRouteProfile"),
    bytes32(generation.treasuryProfile, "generation.treasuryProfile"),
    bytes32(generation.dexProfile, "generation.dexProfile"),
    bytes32(generation.oracleProfile, "generation.oracleProfile"),
    bytes32(generation.manifestHash, "generation.manifestHash"),
    booleanByte(generation.routeAuthorizationRequired, "generation.routeAuthorizationRequired"),
    booleanByte(generation.authorizedTradingRequired, "generation.authorizedTradingRequired"),

    publicKeyBytes(creator, "creator"),
    bytes32(riskClusterId, "riskClusterId"),
    u32(creatorBuyLockSeconds, "creatorBuyLockSeconds"),
    u16(creatorBuyCapBps, "creatorBuyCapBps"),
    bytes32(args.campaignId, "args.campaignId"),
    publicKeyBytes(campaign, "campaign"),
    publicKeyBytes(mint, "mint"),
    publicKeyBytes(tokenVault, "tokenVault"),
    publicKeyBytes(solVault, "solVault"),
    publicKeyBytes(tokenProgram, "tokenProgram"),
    bytes32(args.metadataHash, "args.metadataHash"),
    // v7 put the Metaplex name and symbol back, because create_campaign writes
    // the metadata again. They are length-prefixed so ("ab","c") and ("a","bc")
    // cannot produce the same message. Only the 32-byte digest travels in the
    // transaction, so binding them here is free on the wire -- and it is what
    // stops anyone but the route signer choosing what a token is called.
    //
    // clusterHash, tickerHash, reservationIdHash, reservationVersion and nonce
    // were dropped: each was 32 bytes of a transaction with none to spare, and
    // none of them was ever read back. The program derives tickerHash from the
    // symbol and clusterHash from its own schema domain.
    borshString(args.name, METAPLEX_MAX_NAME_BYTES, "args.name"),
    borshString(args.symbol, METAPLEX_MAX_SYMBOL_BYTES, "args.symbol"),
    i64(args.launchAt, "args.launchAt"),
    u64(args.graduationTargetUsdMicros, "args.graduationTargetUsdMicros"),
    i64(args.deadline, "args.deadline"),
  ]);
}

export function createAuthorizationDigest(input) {
  return sha256(buildCreateAuthorizationPayload(input));
}

function parseSecretBytes(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) throw new TypeError("Solana route signer secret is missing");

  const candidates = [];
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) candidates.push(Buffer.from(parsed));
    } catch {
      throw new TypeError("Solana route signer JSON secret is invalid");
    }
  }
  if (/^\d+(?:\s*,\s*\d+)+$/.test(raw)) {
    candidates.push(Buffer.from(raw.split(",").map((item) => Number(item.trim()))));
  }
  const hex = raw.replace(/^0x/i, "");
  if (/^[0-9a-fA-F]+$/.test(hex) && (hex.length === 64 || hex.length === 128)) {
    candidates.push(Buffer.from(hex, "hex"));
  }
  if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(raw)) {
    try {
      candidates.push(decodeBase58(raw, "Solana route signer secret"));
    } catch {
      // Try the remaining encodings below.
    }
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    try {
      candidates.push(Buffer.from(raw, "base64"));
    } catch {
      // Ignore invalid base64.
    }
  }

  const secret = candidates.find((candidate) => candidate.length === 32 || candidate.length === 64);
  if (!secret) throw new RangeError("Solana route signer secret must contain 32 seed bytes or a 64-byte keypair");
  return secret;
}

export function createEd25519Signer(rawSecret) {
  const secret = parseSecretBytes(rawSecret);
  const seed = secret.subarray(0, 32);
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicDer = Buffer.from(crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }));
  const publicKey = publicDer.subarray(publicDer.length - 32);

  if (secret.length === 64 && !secret.subarray(32).equals(publicKey)) {
    throw new Error("Solana route signer 64-byte keypair does not match its seed");
  }

  return {
    publicKey,
    publicKeyBase58: encodeBase58(publicKey),
    sign(message) {
      const payload = Buffer.from(message);
      const signature = crypto.sign(null, payload, privateKey);
      if (signature.length !== 64) throw new Error("Ed25519 signer returned an invalid signature length");
      return signature;
    },
    verify(message, signature) {
      return crypto.verify(null, Buffer.from(message), crypto.createPublicKey(privateKey), Buffer.from(signature));
    },
  };
}

class AccountReader {
  constructor(data, accountName) {
    this.buffer = Buffer.from(data);
    this.accountName = accountName;
    this.offset = 0;
    const expected = accountDiscriminator(accountName);
    const actual = this.bytes(8, "discriminator");
    if (!actual.equals(expected)) throw new Error(`${accountName} account discriminator mismatch`);
  }

  ensure(length, label) {
    if (this.offset + length > this.buffer.length) {
      throw new RangeError(`${this.accountName}.${label} exceeds account data length`);
    }
  }

  bytes(length, label) {
    this.ensure(length, label);
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return Buffer.from(value);
  }

  publicKey(label) {
    return encodeBase58(this.bytes(32, label));
  }

  bytes32(label) {
    return this.bytes(32, label);
  }

  u8(label) {
    return this.bytes(1, label)[0];
  }

  boolean(label) {
    const value = this.u8(label);
    if (value !== 0 && value !== 1) throw new Error(`${this.accountName}.${label} is not a canonical boolean`);
    return value === 1;
  }

  u16(label) {
    const value = this.bytes(2, label);
    return value.readUInt16LE(0);
  }

  u32(label) {
    const value = this.bytes(4, label);
    return value.readUInt32LE(0);
  }

  u64(label) {
    const value = this.bytes(8, label);
    return value.readBigUInt64LE(0);
  }

  i64(label) {
    const value = this.bytes(8, label);
    return value.readBigInt64LE(0);
  }
}

export function decodeGlobalConfig(data) {
  const reader = new AccountReader(data, "GlobalConfig");
  return {
    admin: reader.publicKey("admin"),
    pauser: reader.publicKey("pauser"),
    tierAdmin: reader.publicKey("tierAdmin"),
    riskAdmin: reader.publicKey("riskAdmin"),
    routeSigner: reader.publicKey("routeSigner"),
    rewardOperator: reader.publicKey("rewardOperator"),
    treasuryOperator: reader.publicKey("treasuryOperator"),
    generationOperator: reader.publicKey("generationOperator"),
    activeGenerationId: reader.bytes32("activeGenerationId"),
    generationCount: reader.u64("generationCount"),
    paused: reader.boolean("paused"),
    createPaused: reader.boolean("createPaused"),
    buyPaused: reader.boolean("buyPaused"),
    sellPaused: reader.boolean("sellPaused"),
    graduationPaused: reader.boolean("graduationPaused"),
    claimsPaused: reader.boolean("claimsPaused"),
    routeAuthorizationRequired: reader.boolean("routeAuthorizationRequired"),
    authorizedTradingRequired: reader.boolean("authorizedTradingRequired"),
    securityDefaultsLocked: reader.boolean("securityDefaultsLocked"),
    bump: reader.u8("bump"),
  };
}

export function decodeGenerationConfig(data) {
  const reader = new AccountReader(data, "GenerationConfig");
  return {
    generationId: reader.bytes32("generationId"),
    programId: reader.publicKey("programId"),
    configPda: reader.publicKey("configPda"),
    startSlot: reader.u64("startSlot"),
    clusterKind: reader.u8("clusterKind"),
    allowedGraduationTierMask: reader.u8("allowedGraduationTierMask"),
    economicsVersion: reader.u16("economicsVersion"),
    curveKind: reader.u8("curveKind"),
    tokenTotalSupply: reader.u64("tokenTotalSupply"),
    tokenDecimals: reader.u8("tokenDecimals"),
    curveSupplyBps: reader.u16("curveSupplyBps"),
    liquidityTokenBps: reader.u16("liquidityTokenBps"),
    basePriceLamports: reader.u64("basePriceLamports"),
    priceSlopeLamports: reader.u64("priceSlopeLamports"),
    buyFeeBps: reader.u16("buyFeeBps"),
    sellFeeBps: reader.u16("sellFeeBps"),
    finalizeFeeBps: reader.u16("finalizeFeeBps"),
    creatorPostFinalizeBps: reader.u16("creatorPostFinalizeBps"),
    liquidityPostFinalizeBps: reader.u16("liquidityPostFinalizeBps"),
    dexAdapter: reader.u8("dexAdapter"),
    tradeRouteProfile: reader.bytes32("tradeRouteProfile"),
    finalizeRouteProfile: reader.bytes32("finalizeRouteProfile"),
    treasuryProfile: reader.bytes32("treasuryProfile"),
    dexProfile: reader.bytes32("dexProfile"),
    oracleProfile: reader.bytes32("oracleProfile"),
    activeCreation: reader.boolean("activeCreation"),
    supportEnabled: reader.boolean("supportEnabled"),
    manifestHash: reader.bytes32("manifestHash"),
    routeAuthorizationRequired: reader.boolean("routeAuthorizationRequired"),
    authorizedTradingRequired: reader.boolean("authorizedTradingRequired"),
    bump: reader.u8("bump"),
  };
}

export function decodeCreatorProfile(data) {
  const reader = new AccountReader(data, "CreatorProfile");
  return {
    wallet: reader.publicKey("wallet"),
    tier: reader.u8("tier"),
    trustScore: reader.u16("trustScore"),
    liveBondingCount: reader.u16("liveBondingCount"),
    lastLaunchTimestamp: reader.i64("lastLaunchTimestamp"),
    totalLaunches: reader.u64("totalLaunches"),
    successfulGraduations: reader.u64("successfulGraduations"),
    restricted: reader.boolean("restricted"),
    manualReviewRequired: reader.boolean("manualReviewRequired"),
    creatorBuyCapBps: reader.u16("creatorBuyCapBps"),
    maxLiveBondingCount: reader.u16("maxLiveBondingCount"),
    cooldownSeconds: reader.u32("cooldownSeconds"),
    creatorBuyLockSeconds: reader.u32("creatorBuyLockSeconds"),
    bump: reader.u8("bump"),
  };
}

export function decodeRiskProfile(data) {
  const reader = new AccountReader(data, "RiskProfile");
  return {
    wallet: reader.publicKey("wallet"),
    riskLevel: reader.u8("riskLevel"),
    restricted: reader.boolean("restricted"),
    clusterId: reader.bytes32("clusterId"),
    manualReviewRequired: reader.boolean("manualReviewRequired"),
    bump: reader.u8("bump"),
  };
}

export function decodeClusterProfile(data) {
  const reader = new AccountReader(data, "ClusterProfile");
  return {
    clusterId: reader.bytes32("clusterId"),
    size: reader.u32("size"),
    riskLevel: reader.u8("riskLevel"),
    restricted: reader.boolean("restricted"),
    bump: reader.u8("bump"),
  };
}

/**
 * Decode the V4 Campaign account fields needed for trade vault resolution.
 * Layout matches programs/memewarzone_solana Campaign (after 8-byte Anchor discriminator):
 *   campaign_id[32], generation_id[32], generation_config, generation_manifest_hash,
 *   creator, mint, token_vault, sol_vault, ...
 *
 * Falls back to raw offset read if the discriminator does not match (older IDL / rename).
 */
export function decodeCampaignAccount(data) {
  const buf = Buffer.from(data);
  const minLen = 8 + 32 * 8; // disc + campaign_id..sol_vault
  if (buf.length < minLen) {
    throw new RangeError(`Campaign account data too short (${buf.length} < ${minLen})`);
  }

  const readCore = (offset) => {
    const campaignId = Buffer.from(buf.subarray(offset, offset + 32));
    offset += 32;
    const generationId = Buffer.from(buf.subarray(offset, offset + 32));
    offset += 32;
    const generationConfig = encodeBase58(buf.subarray(offset, offset + 32));
    offset += 32;
    const generationManifestHash = Buffer.from(buf.subarray(offset, offset + 32));
    offset += 32;
    const creator = encodeBase58(buf.subarray(offset, offset + 32));
    offset += 32;
    const mint = encodeBase58(buf.subarray(offset, offset + 32));
    offset += 32;
    const tokenVault = encodeBase58(buf.subarray(offset, offset + 32));
    offset += 32;
    const solVault = encodeBase58(buf.subarray(offset, offset + 32));
    return {
      campaignId,
      campaignIdHex: campaignId.toString("hex"),
      generationId,
      generationConfig,
      generationManifestHash,
      creator,
      mint,
      tokenVault,
      solVault,
    };
  };

  try {
    const expected = accountDiscriminator("Campaign");
    if (buf.subarray(0, 8).equals(expected)) {
      return readCore(8);
    }
  } catch {
    // fall through
  }

  // Lenient path: assume standard Anchor 8-byte discriminator prefix.
  return readCore(8);
}

/** Curve / graduation fields. Offsets include the 8-byte Anchor discriminator. */
export function decodeCampaignCurveFields(data) {
  const buf = Buffer.from(data);
  if (buf.length < 714) {
    throw new RangeError(`Campaign account data too short for curve fields (${buf.length} < 714)`);
  }
  return {
    graduationTargetUsdMicros: buf.readBigUInt64LE(408),
    economicsVersion: buf.readUInt16LE(417),
    curveTokenSupply: buf.readBigUInt64LE(428),
    soldTokens: buf.readBigUInt64LE(662),
    netRaisedLamports: buf.readBigUInt64LE(670),
    graduated: buf.readUInt8(713) === 1,
    curveClosed: buf.length >= 719 ? buf.readUInt8(714) === 1 : false,
    paused: buf.length >= 720 ? buf.readUInt8(715) === 1 : false,
  };
}

export function nativeTargetLamportsFromUsd(graduationTargetUsdMicros, oraclePriceUsdMicros) {
  const target = BigInt(graduationTargetUsdMicros);
  const price = BigInt(oraclePriceUsdMicros);
  if (price <= 0n) throw new RangeError("oraclePriceUsdMicros must be > 0");
  return (target * 1_000_000_000n + price - 1n) / price;
}
