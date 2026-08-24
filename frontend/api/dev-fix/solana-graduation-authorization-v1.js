import crypto from "node:crypto";

import { badMethod, isSolanaChain, json, readJson } from "../../server/http.js";
import {
  TOKEN_PROGRAM_ID,
  SYSVAR_INSTRUCTIONS_ID,
  SYSTEM_PROGRAM_ID,
  createEd25519Signer,
  decodeCampaignAccount,
  decodeGlobalConfig,
  findProgramAddressSync,
  publicKeyBytes,
  publicKeyString,
  sha256,
  u16,
  u64,
  u8,
  i64,
} from "./solana-v4-primitives.js";
import { getSolanaChainUnixTime } from "./solana-chain-unix-time.js";

const GRADUATION_AUTH_DOMAIN = Buffer.from("MEMEWARZONE_SOLANA_GRADUATION_V1", "utf8");
const GRADUATION_AUTH_SCHEMA_VERSION = 2;
const ROUTE_PROFILE_UNLINKED = 1;
const METEORA_CP_AMM_PROGRAM_ID = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
const NATIVE_MINT = "So11111111111111111111111111111111111111112";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const DEFAULT_AUTH_TTL_SECONDS = 5 * 60;
const MAX_AUTH_TTL_SECONDS = 15 * 60;
const PRICE_CACHE_MS = 30_000;

let priceCache = { priceUsdMicros: 0n, at: 0 };

class SolanaGraduationAuthorizationError extends Error {
  constructor(message, { code = "SOLANA_GRADUATION_AUTHORIZATION_ERROR", httpStatus = 409, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SolanaGraduationAuthorizationError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function methodAllowed(req, res, allowed) {
  if (allowed.includes(req.method)) return true;
  badMethod(res);
  return false;
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new SolanaGraduationAuthorizationError(`${name} is not configured.`, {
      code: "SOLANA_GRADUATION_CONFIGURATION_INCOMPLETE",
      httpStatus: 503,
    });
  }
  return value;
}

function parsePositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(maximum, Math.trunc(n));
}

function samePublicKey(left, right) {
  try {
    return publicKeyBytes(left).equals(publicKeyBytes(right));
  } catch {
    return false;
  }
}

async function rpcCall(rpcUrl, method, params = []) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
    return payload?.result;
  } catch (error) {
    throw new SolanaGraduationAuthorizationError(`Solana RPC ${method} failed.`, {
      code: "SOLANA_GRADUATION_RPC_UNAVAILABLE",
      httpStatus: 503,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function getChainUnixTime(rpcUrl) {
  try {
    return await getSolanaChainUnixTime(rpcUrl);
  } catch (error) {
    throw new SolanaGraduationAuthorizationError(error instanceof Error ? error.message : String(error), {
      code: "SOLANA_GRADUATION_CHAIN_TIME_UNAVAILABLE",
      httpStatus: 503,
      cause: error,
    });
  }
}

async function getAccountData(rpcUrl, address, expectedOwner, label) {
  const result = await rpcCall(rpcUrl, "getAccountInfo", [
    address,
    { commitment: "confirmed", encoding: "base64" },
  ]);
  const value = result?.value;
  if (!value?.data?.[0]) {
    throw new SolanaGraduationAuthorizationError(`${label} account is missing.`, {
      code: "SOLANA_GRADUATION_ACCOUNT_MISSING",
      httpStatus: 409,
    });
  }
  if (expectedOwner && !samePublicKey(value.owner, expectedOwner)) {
    throw new SolanaGraduationAuthorizationError(`${label} owner mismatch.`, {
      code: "SOLANA_GRADUATION_ACCOUNT_OWNER_MISMATCH",
      httpStatus: 409,
    });
  }
  return Buffer.from(value.data[0], "base64");
}

function decodeCampaignGraduationFields(data) {
  const core = decodeCampaignAccount(data);
  const buf = Buffer.from(data);
  // Layout is fixed by authorized_create::Campaign. Offsets include Anchor's 8-byte discriminator.
  if (buf.length < 714) {
    throw new SolanaGraduationAuthorizationError(`Campaign account is too short (${buf.length}).`, {
      code: "SOLANA_GRADUATION_CAMPAIGN_DECODE_FAILED",
      httpStatus: 409,
    });
  }
  return {
    ...core,
    graduationTargetUsdMicros: buf.readBigUInt64LE(408),
    economicsVersion: buf.readUInt16LE(417),
    curveTokenSupply: buf.readBigUInt64LE(428),
    liquidityTokenSupply: buf.readBigUInt64LE(436),
    reserveTokenSupply: buf.readBigUInt64LE(444),
    tokenDecimals: buf.readUInt8(452),
    finalizeFeeBps: buf.readUInt16LE(477),
    creatorPostFinalizeBps: buf.readUInt16LE(479),
    liquidityPostFinalizeBps: buf.readUInt16LE(481),
    dexAdapter: buf.readUInt8(483),
    soldTokens: buf.readBigUInt64LE(662),
    netRaisedLamports: buf.readBigUInt64LE(670),
    graduated: buf.readUInt8(713) === 1,
    curveClosed: buf.length >= 719 ? buf.readUInt8(714) === 1 : false,
    paused: buf.length >= 720 ? buf.readUInt8(715) === 1 : false,
  };
}

function orderedPublicKeyBuffers(a, b) {
  const left = publicKeyBytes(a);
  const right = publicKeyBytes(b);
  return Buffer.compare(left, right) > 0 ? [left, right] : [right, left];
}

function deriveMeteoraPool(mint) {
  const [first, second] = orderedPublicKeyBuffers(mint, NATIVE_MINT);
  return findProgramAddressSync([Buffer.from("cpool"), first, second], METEORA_CP_AMM_PROGRAM_ID).publicKey;
}

function deriveMeteoraPosition(positionNftMint) {
  return findProgramAddressSync(
    [Buffer.from("position"), publicKeyBytes(positionNftMint)],
    METEORA_CP_AMM_PROGRAM_ID,
  ).publicKey;
}

function deriveMeteoraVault(mint, pool) {
  return findProgramAddressSync(
    [Buffer.from("token_vault"), publicKeyBytes(mint), publicKeyBytes(pool)],
    METEORA_CP_AMM_PROGRAM_ID,
  ).publicKey;
}

function deriveAta(owner, mint) {
  return findProgramAddressSync(
    [publicKeyBytes(owner), publicKeyBytes(TOKEN_PROGRAM_ID), publicKeyBytes(mint)],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  ).publicKey;
}

async function fetchSolUsdMicros() {
  const override = String(process.env.SOLANA_GRADUATION_SOL_USD_MICROS || "").trim();
  if (override) {
    const value = BigInt(override);
    if (value <= 0n) throw new Error("SOLANA_GRADUATION_SOL_USD_MICROS must be > 0");
    return value;
  }
  if (priceCache.priceUsdMicros > 0n && Date.now() - priceCache.at < PRICE_CACHE_MS) {
    return priceCache.priceUsdMicros;
  }
  const sources = [
    async (signal) => {
      const response = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
        { headers: { accept: "application/json" }, signal },
      );
      if (!response.ok) throw new Error(`CoinGecko HTTP ${response.status}`);
      const body = await response.json();
      return Number(body?.solana?.usd);
    },
    async (signal) => {
      const response = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT", {
        headers: { accept: "application/json" },
        signal,
      });
      if (!response.ok) throw new Error(`Binance HTTP ${response.status}`);
      const body = await response.json();
      return Number(body?.price);
    },
  ];
  let lastError = null;
  for (const source of sources) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const price = await source(controller.signal);
      if (!Number.isFinite(price) || price <= 0) throw new Error("Invalid SOL/USD response");
      const micros = BigInt(Math.round(price * 1_000_000));
      if (micros <= 0n) throw new Error("Invalid SOL/USD micro price");
      priceCache = { priceUsdMicros: micros, at: Date.now() };
      return micros;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new SolanaGraduationAuthorizationError("SOL/USD graduation oracle is unavailable.", {
    code: "SOLANA_GRADUATION_ORACLE_UNAVAILABLE",
    httpStatus: 503,
    cause: lastError,
  });
}

function ceilDiv(numerator, denominator) {
  if (denominator <= 0n) throw new RangeError("denominator must be > 0");
  return (numerator + denominator - 1n) / denominator;
}

function buildGraduationDigest({
  programId,
  campaign,
  mint,
  authority,
  graduationTargetUsdMicros,
  nativeTargetLamports,
  oraclePriceUsdMicros,
  meteoraPool,
  meteoraPosition,
  positionNftMint,
  deadline,
  nonce,
  finalizeRouteProfile,
}) {
  return sha256(
    GRADUATION_AUTH_DOMAIN,
    u16(GRADUATION_AUTH_SCHEMA_VERSION, "schemaVersion"),
    publicKeyBytes(programId, "programId"),
    publicKeyBytes(campaign, "campaign"),
    publicKeyBytes(mint, "mint"),
    publicKeyBytes(authority, "authority"),
    u64(graduationTargetUsdMicros, "graduationTargetUsdMicros"),
    u64(nativeTargetLamports, "nativeTargetLamports"),
    u64(oraclePriceUsdMicros, "oraclePriceUsdMicros"),
    publicKeyBytes(meteoraPool, "meteoraPool"),
    publicKeyBytes(meteoraPosition, "meteoraPosition"),
    publicKeyBytes(positionNftMint, "positionNftMint"),
    i64(deadline, "deadline"),
    Buffer.from(nonce),
    u8(finalizeRouteProfile, "finalizeRouteProfile"),
  );
}

export async function solanaGraduationAuthorizationV1(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  try {
    if (!isTruthy(process.env.SOLANA_GRADUATION_AUTH_ENABLED)) {
      throw new SolanaGraduationAuthorizationError(
        "Solana graduation authorization is disabled. Enable it only after the graduation binary is verified and graduation is intentionally unpaused.",
        { code: "SOLANA_GRADUATION_AUTH_DISABLED", httpStatus: 503 },
      );
    }
    const body = await readJson(req);
    const chainId = Number(body.chainId || 101);
    if (!isSolanaChain(chainId)) {
      throw new SolanaGraduationAuthorizationError("chainId must be Solana (101).", {
        code: "NOT_A_SOLANA_CHAIN",
        httpStatus: 400,
      });
    }

    const campaignAddress = publicKeyString(body.campaignAddress, "campaignAddress");
    const authorityAddress = publicKeyString(body.authorityAddress, "authorityAddress");
    const positionNftMint = publicKeyString(body.positionNftMint, "positionNftMint");
    const rpcUrl = requiredEnv("SOLANA_RPC_URL");
    const programId = publicKeyString(requiredEnv("SOLANA_LAUNCHPAD_PROGRAM_ID"), "SOLANA_LAUNCHPAD_PROGRAM_ID");
    const routeSecret = requiredEnv("SOLANA_ROUTE_SIGNER_SECRET_KEY");
    const routeSigner = publicKeyString(requiredEnv("SOLANA_ROUTE_SIGNER_PUBLIC_KEY"), "SOLANA_ROUTE_SIGNER_PUBLIC_KEY");
    const signer = createEd25519Signer(routeSecret);
    if (!samePublicKey(signer.publicKeyBase58, routeSigner)) {
      throw new SolanaGraduationAuthorizationError("Route signer secret/public key mismatch.", {
        code: "SOLANA_ROUTE_SIGNER_CONFIGURATION_MISMATCH",
        httpStatus: 503,
      });
    }

    const globalConfig = findProgramAddressSync([Buffer.from("global")], programId).publicKey;
    const [globalData, campaignData] = await Promise.all([
      getAccountData(rpcUrl, globalConfig, programId, "GlobalConfig"),
      getAccountData(rpcUrl, campaignAddress, programId, "Campaign"),
    ]);
    const global = decodeGlobalConfig(globalData);
    const campaign = decodeCampaignGraduationFields(campaignData);
    if (!samePublicKey(authorityAddress, global.treasuryOperator)) {
      throw new SolanaGraduationAuthorizationError("Graduation authority must equal GlobalConfig.treasuryOperator.", {
        code: "SOLANA_GRADUATION_AUTHORITY_MISMATCH",
        httpStatus: 403,
      });
    }
    if (campaign.graduated) {
      throw new SolanaGraduationAuthorizationError("Campaign is already graduated.", {
        code: "SOLANA_ALREADY_GRADUATED",
        httpStatus: 409,
      });
    }
    if (campaign.paused) {
      throw new SolanaGraduationAuthorizationError("Campaign is paused.", {
        code: "SOLANA_CAMPAIGN_PAUSED",
        httpStatus: 409,
      });
    }
    if (campaign.economicsVersion < 3 || campaign.dexAdapter !== 1) {
      throw new SolanaGraduationAuthorizationError("Campaign is not an Economics V3 / Meteora-only campaign.", {
        code: "SOLANA_GRADUATION_CAMPAIGN_UNSUPPORTED",
        httpStatus: 409,
      });
    }

    const oraclePriceUsdMicros = await fetchSolUsdMicros();
    const nativeTargetLamports = ceilDiv(
      campaign.graduationTargetUsdMicros * 1_000_000_000n,
      oraclePriceUsdMicros,
    );
    const soldOut = campaign.soldTokens >= campaign.curveTokenSupply;
    const thresholdReached = soldOut || campaign.netRaisedLamports >= nativeTargetLamports;
    if (!thresholdReached) {
      throw new SolanaGraduationAuthorizationError("Campaign has not reached the signed native graduation target yet.", {
        code: "SOLANA_GRADUATION_THRESHOLD_NOT_MET",
        httpStatus: 409,
      });
    }

    const meteoraPool = deriveMeteoraPool(campaign.mint);
    const meteoraPosition = deriveMeteoraPosition(positionNftMint);
    const chainNow = await getChainUnixTime(rpcUrl);
    const ttlSeconds = parsePositiveInteger(
      process.env.SOLANA_GRADUATION_AUTH_TTL_SECONDS,
      DEFAULT_AUTH_TTL_SECONDS,
      MAX_AUTH_TTL_SECONDS,
    );
    const deadline = BigInt(chainNow + ttlSeconds);
    const nonce = crypto.randomBytes(32);
    const finalizeRouteProfile = ROUTE_PROFILE_UNLINKED;
    const digest = buildGraduationDigest({
      programId,
      campaign: campaignAddress,
      mint: campaign.mint,
      authority: authorityAddress,
      graduationTargetUsdMicros: campaign.graduationTargetUsdMicros,
      nativeTargetLamports,
      oraclePriceUsdMicros,
      meteoraPool,
      meteoraPosition,
      positionNftMint,
      deadline,
      nonce,
      finalizeRouteProfile,
    });
    const signature = signer.sign(digest);

    return json(res, 200, {
      schemaVersion: GRADUATION_AUTH_SCHEMA_VERSION,
      chainId,
      programId,
      chainNow,
      campaign: {
        address: campaignAddress,
        mint: campaign.mint,
        creator: campaign.creator,
        generationConfig: campaign.generationConfig,
        graduationTargetUsdMicros: campaign.graduationTargetUsdMicros.toString(),
        soldTokens: campaign.soldTokens.toString(),
        curveTokenSupply: campaign.curveTokenSupply.toString(),
        netRaisedLamports: campaign.netRaisedLamports.toString(),
      },
      oracle: {
        source: process.env.SOLANA_GRADUATION_SOL_USD_MICROS ? "configured_usd_micros" : "coingecko",
        solUsdMicros: oraclePriceUsdMicros.toString(),
        nativeTargetLamports: nativeTargetLamports.toString(),
      },
      createArgs: {
        nativeTargetLamports: nativeTargetLamports.toString(),
        oraclePriceUsdMicros: oraclePriceUsdMicros.toString(),
        deadline: deadline.toString(),
        nonce: Array.from(nonce),
        positionNftMint,
        finalizeRouteProfile,
      },
      accounts: {
        authority: authorityAddress,
        globalConfig,
        generationConfig: campaign.generationConfig,
        campaign: campaignAddress,
        mint: campaign.mint,
        tokenVault: campaign.tokenVault,
        solVault: campaign.solVault,
        authorityTokenAccount: deriveAta(authorityAddress, campaign.mint),
        creator: campaign.creator,
        creatorTokenAccount: deriveAta(campaign.creator, campaign.mint),
        creatorProfile: findProgramAddressSync(
          [Buffer.from("creator"), publicKeyBytes(campaign.creator)],
          programId,
        ).publicKey,
        graduationState: findProgramAddressSync(
          [Buffer.from("graduation"), publicKeyBytes(campaignAddress)],
          programId,
        ).publicKey,
        meteoraProgram: METEORA_CP_AMM_PROGRAM_ID,
        meteoraPool,
        meteoraPosition,
        meteoraTokenVault: deriveMeteoraVault(campaign.mint, meteoraPool),
        meteoraNativeVault: deriveMeteoraVault(NATIVE_MINT, meteoraPool),
        positionNftMint,
        instructions: SYSVAR_INSTRUCTIONS_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
        leagueVault: findProgramAddressSync([Buffer.from("league_vault")], "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX").publicKey,
        airdropVault: findProgramAddressSync([Buffer.from("airdrop_vault")], "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX").publicKey,
        monthlyLeagueVault: findProgramAddressSync([Buffer.from("monthly_league_vault")], "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX").publicKey,
        recruiterVault: findProgramAddressSync([Buffer.from("recruiter_vault")], "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX").publicKey,
        squadVault: findProgramAddressSync([Buffer.from("squad_vault")], "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX").publicKey,
        protocolVault: findProgramAddressSync([Buffer.from("protocol_vault")], "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX").publicKey,
      },
      authorization: {
        digestHex: digest.toString("hex"),
        digestBase64: digest.toString("base64"),
        signatureBase64: signature.toString("base64"),
        routeSigner: signer.publicKeyBase58,
        deadline: deadline.toString(),
        validUntil: new Date(Number(deadline) * 1000).toISOString(),
        ed25519InstructionMustImmediatelyPrecedeBeginGraduation: true,
      },
      transactionPolicy:
        "One transaction only: Ed25519 verify -> begin_graduation -> Meteora createCustomPool(isLockLiquidity=true) -> confirm_graduation.",
    });
  } catch (error) {
    if (error instanceof SolanaGraduationAuthorizationError) {
      return json(res, error.httpStatus || 409, { error: error.message, code: error.code });
    }
    console.error("[solana-graduation-v1] authorization failed", error);
    return json(res, 500, {
      error: "Solana graduation authorization failed.",
      code: "SOLANA_GRADUATION_AUTHORIZATION_INTERNAL_ERROR",
    });
  }
}
