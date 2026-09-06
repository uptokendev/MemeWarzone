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
import { getGraduationQuoteAssetDetail } from "../lib/quoteAssetCatalog.js";

const GRADUATION_AUTH_DOMAIN = Buffer.from("MEMEWARZONE_SOLANA_GRADUATION_V1", "utf8");
const GRADUATION_AUTH_SCHEMA_VERSION = 3;
const ROUTE_PROFILE_UNLINKED = 1;
const METEORA_CP_AMM_PROGRAM_ID = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
const NATIVE_MINT = "So11111111111111111111111111111111111111112";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const DEFAULT_AUTH_TTL_SECONDS = 5 * 60;
const MAX_AUTH_TTL_SECONDS = 15 * 60;
const DEFAULT_SLIPPAGE_BPS = 50;
const ABSOLUTE_MAX_SLIPPAGE_BPS = 300;
const ABSOLUTE_MAX_IMPACT_BPS = 300;
const ABSOLUTE_MAX_DEVIATION_BPS = 150;
const BPS_DENOMINATOR = 10_000n;
const ONE_SOL_LAMPORTS = 1_000_000_000n;
const NANO_LAMPORT_SCALE = 1_000_000_000n;
const PRICE_CACHE_MS = 30_000;

const QUOTE_PROFILE = Object.freeze({
  NATIVE: 0,
  STABLECOIN: 1,
  PROVIDER_RWA: 2,
  MWZ_NATIVE: 3,
  COMMUNITY: 4,
});

let solPriceCache = { priceUsdMicros: 0n, at: 0 };
const quotePriceCache = new Map();

class SolanaGraduationAuthorizationError extends Error {
  constructor(message, { code = "SOLANA_GRADUATION_AUTHORIZATION_ERROR", httpStatus = 409, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SolanaGraduationAuthorizationError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function failUnsafe(message, cause = null) {
  throw new SolanaGraduationAuthorizationError(message, {
    code: "GRADUATION_PENDING_QUOTE_UNSAFE",
    httpStatus: 409,
    cause,
  });
}

function methodAllowed(req, res, allowed) {
  if (allowed.includes(req.method)) return true;
  badMethod(res);
  return false;
}

function isTruthy(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
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

function configHash(configId) {
  return crypto.createHash("sha256").update(String(configId), "utf8").digest();
}

const PROVIDER_CLASS = Object.freeze({
  NATIVE: 0,
  BASIC: 1,
  PROVIDER_RWA: 2,
  MWZ_NATIVE: 3,
  COMMUNITY: 4,
});

function profileForAssetClass(assetClass) {
  const value = QUOTE_PROFILE[String(assetClass || "").trim().toUpperCase()];
  if (!Number.isInteger(value)) throw new SolanaGraduationAuthorizationError(`Unsupported quote asset class ${assetClass}.`, { code: "SOLANA_GRADUATION_QUOTE_NOT_APPROVED", httpStatus: 409 });
  return value;
}

function providerClassCode(providerClass) {
  const value = PROVIDER_CLASS[String(providerClass || "").trim().toUpperCase()];
  if (!Number.isInteger(value)) throw new SolanaGraduationAuthorizationError(`Unsupported quote provider class ${providerClass}.`, { code: "SOLANA_GRADUATION_QUOTE_NOT_APPROVED", httpStatus: 409 });
  return value;
}

function catalogBindingHash(item) {
  const policy = item.policy || {};
  const provider = item.provider || {};
  const fields = [item.id, item.assetId, provider.id, provider.key, provider.providerClass, item.chainId, item.identityKind, item.contractAddressOrMint, item.stateVersion, policy.id, policy.policyKey, policy.version];
  return crypto.createHash("sha256").update(fields.map((v) => String(v ?? "")).join("\u0000"), "utf8").digest();
}

async function resolveCatalogQuoteConfig({ chainId, quoteConfigId }) {
  let detail;
  try {
    detail = await getGraduationQuoteAssetDetail(quoteConfigId);
  } catch (error) {
    throw new SolanaGraduationAuthorizationError("Quote Asset Catalog is unavailable.", { code: "SOLANA_GRADUATION_QUOTE_CATALOG_UNAVAILABLE", httpStatus: 503, cause: error });
  }
  const item = detail?.item;
  if (!item || String(item.id) !== String(quoteConfigId)) throw new SolanaGraduationAuthorizationError("Requested quote configuration is not present in the authoritative catalog.", { code: "SOLANA_GRADUATION_QUOTE_NOT_APPROVED", httpStatus: 409 });
  if (String(item.chainId) !== String(chainId) || item.newGraduationEligible !== true) throw new SolanaGraduationAuthorizationError("Requested quote configuration is not approved for new graduation.", { code: "SOLANA_GRADUATION_QUOTE_NOT_APPROVED", httpStatus: 409 });
  if (item.policy?.authority !== "generic" || item.policy?.active !== true || item.policy?.basicApproved !== true) throw new SolanaGraduationAuthorizationError("Requested quote policy is not an active BASIC generic policy.", { code: "SOLANA_GRADUATION_QUOTE_NOT_APPROVED", httpStatus: 409 });
  const profile = profileForAssetClass(item.assetClass);
  if (isTruthy(process.env.SOLANA_GRADUATION_BASIC_RELEASE_ONLY, true) && ![QUOTE_PROFILE.NATIVE, QUOTE_PROFILE.STABLECOIN].includes(profile)) throw new SolanaGraduationAuthorizationError("BASIC release permits only native SOL and one approved canonical stablecoin.", { code: "SOLANA_GRADUATION_QUOTE_NOT_APPROVED", httpStatus: 409 });
  const rootRoute = item.policy?.config?.solanaGraduation || {};
  const route = rootRoute.chains?.[String(chainId)] || rootRoute;
  const quoteMint = publicKeyString(route.quoteMint || (item.identityKind === "SOLANA_MINT" ? item.contractAddressOrMint : NATIVE_MINT), "authoritative quote mint");
  if (profile === QUOTE_PROFILE.NATIVE) {
    if (item.identityKind !== "NATIVE" || !samePublicKey(quoteMint, NATIVE_MINT)) throw new SolanaGraduationAuthorizationError("Native catalog identity must resolve exactly to WSOL for graduation.", { code: "SOLANA_GRADUATION_QUOTE_NOT_APPROVED", httpStatus: 409 });
  } else if (item.identityKind !== "SOLANA_MINT" || !samePublicKey(item.contractAddressOrMint, quoteMint)) {
    throw new SolanaGraduationAuthorizationError("Catalog deployment mint does not match its configured graduation quote mint.", { code: "SOLANA_GRADUATION_QUOTE_NOT_APPROVED", httpStatus: 409 });
  }
  const maxSlippageBps = Number(route.maxSlippageBps ?? DEFAULT_SLIPPAGE_BPS);
  const maxImpactBps = Number(route.maxImpactBps ?? 100);
  const maxDeviationBps = Number(route.maxDeviationBps ?? 100);
  if (maxSlippageBps < 0 || maxSlippageBps > ABSOLUTE_MAX_SLIPPAGE_BPS) failUnsafe("Catalog slippage policy exceeds the absolute Solana limit.");
  if (maxImpactBps < 0 || maxImpactBps > ABSOLUTE_MAX_IMPACT_BPS) failUnsafe("Catalog impact policy exceeds the absolute Solana limit.");
  if (maxDeviationBps < 0 || maxDeviationBps > ABSOLUTE_MAX_DEVIATION_BPS) failUnsafe("Catalog deviation policy exceeds the absolute Solana limit.");
  return {
    id: String(item.id), bindingHash: catalogBindingHash(item), assetId: item.assetId,
    providerId: item.provider?.id, providerKey: item.provider?.key, providerClassName: item.provider?.providerClass,
    policyId: item.policy?.id, policyKey: item.policy?.policyKey, stateVersion: Number(item.stateVersion || 0),
    mint: quoteMint, policyVersion: parsePositiveInteger(item.policy?.version, 1, 65_535), profile,
    providerClass: profile === QUOTE_PROFILE.NATIVE ? PROVIDER_CLASS.NATIVE : providerClassCode(item.provider?.providerClass), decimals: Number(route.decimals ?? (profile === QUOTE_PROFILE.NATIVE ? 9 : 0)),
    acquisitionProgram: publicKeyString(route.acquisitionProgram || SYSTEM_PROGRAM_ID, "acquisitionProgram"), recoveryAccount: SYSTEM_PROGRAM_ID,
    maxSlippageBps, maxImpactBps, maxDeviationBps,
    quoteUsdMicros: route.referenceUsdMicros == null ? null : BigInt(route.referenceUsdMicros),
    binanceSymbol: String(route.binanceSymbol || "").trim(), coinGeckoId: String(route.coinGeckoId || "").trim(),
    jupiterApiBase: String(route.jupiterApiBase || process.env.SOLANA_GRADUATION_JUPITER_API_BASE || "https://lite-api.jup.ag/swap/v1").replace(new RegExp("/+$"), ""),
  };
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

async function getAccountData(rpcUrl, address, expectedOwner, label) {
  const result = await rpcCall(rpcUrl, "getAccountInfo", [address, { commitment: "confirmed", encoding: "base64" }]);
  const value = result?.value;
  if (!value?.data?.[0]) throw new SolanaGraduationAuthorizationError(`${label} account is missing.`, { code: "SOLANA_GRADUATION_ACCOUNT_MISSING" });
  if (expectedOwner && !samePublicKey(value.owner, expectedOwner)) throw new SolanaGraduationAuthorizationError(`${label} owner mismatch.`, { code: "SOLANA_GRADUATION_ACCOUNT_OWNER_MISMATCH" });
  return Buffer.from(value.data[0], "base64");
}

function decodeCampaignGraduationFields(data) {
  const core = decodeCampaignAccount(data);
  const buf = Buffer.from(data);
  if (buf.length < 714) throw new SolanaGraduationAuthorizationError(`Campaign account is too short (${buf.length}).`, { code: "SOLANA_GRADUATION_CAMPAIGN_DECODE_FAILED" });
  return {
    ...core,
    graduationTargetUsdMicros: buf.readBigUInt64LE(408),
    economicsVersion: buf.readUInt16LE(417),
    curveTokenSupply: buf.readBigUInt64LE(428),
    liquidityTokenSupply: buf.readBigUInt64LE(436),
    reserveTokenSupply: buf.readBigUInt64LE(444),
    tokenDecimals: buf.readUInt8(452),
    basePriceLamports: buf.readBigUInt64LE(457),
    priceSlopeLamports: buf.readBigUInt64LE(465),
    finalizeFeeBps: buf.readUInt16LE(477),
    liquidityPostFinalizeBps: buf.readUInt16LE(481),
    dexAdapter: buf.readUInt8(483),
    soldTokens: buf.readBigUInt64LE(662),
    netRaisedLamports: buf.readBigUInt64LE(670),
    graduated: buf.readUInt8(713) === 1,
    paused: buf.length >= 716 ? buf.readUInt8(715) === 1 : false,
  };
}

function tokenScale(decimals) { return 10n ** BigInt(decimals); }
function bpsAmount(amount, bps) { return (amount * BigInt(bps)) / BPS_DENOMINATOR; }

function graduationLiquidityQuote(campaign) {
  const scale = tokenScale(campaign.tokenDecimals);
  const spotNano = campaign.basePriceLamports * NANO_LAMPORT_SCALE + (campaign.priceSlopeLamports * campaign.soldTokens) / scale;
  if (spotNano <= 0n) failUnsafe("Final curve spot price is invalid.");
  const finalizeFeeLamports = bpsAmount(campaign.netRaisedLamports, campaign.finalizeFeeBps);
  const remaining = campaign.netRaisedLamports - finalizeFeeLamports;
  const targetLiquidityLamports = bpsAmount(remaining, campaign.liquidityPostFinalizeBps);
  const desiredTokens = (targetLiquidityLamports * scale * NANO_LAMPORT_SCALE) / spotNano;
  const maxLiquidityTokens = desiredTokens < campaign.liquidityTokenSupply ? desiredTokens : campaign.liquidityTokenSupply;
  if (maxLiquidityTokens <= 0n) failUnsafe("Graduation token liquidity is zero.");
  const maxLiquidityLamports = desiredTokens <= campaign.liquidityTokenSupply
    ? targetLiquidityLamports
    : (maxLiquidityTokens * spotNano) / (scale * NANO_LAMPORT_SCALE);
  if (maxLiquidityLamports <= 0n) failUnsafe("Graduation native liquidity is zero.");
  return { spotNano, finalizeFeeLamports, maxLiquidityTokens, maxLiquidityLamports, creatorPayoutLamports: remaining - maxLiquidityLamports };
}

function orderedPublicKeyBuffers(a, b) {
  const left = publicKeyBytes(a);
  const right = publicKeyBytes(b);
  return Buffer.compare(left, right) > 0 ? [left, right] : [right, left];
}
function deriveMeteoraPool(mint, quoteMint) {
  const [first, second] = orderedPublicKeyBuffers(mint, quoteMint);
  return findProgramAddressSync([Buffer.from("cpool"), first, second], METEORA_CP_AMM_PROGRAM_ID).publicKey;
}
function deriveMeteoraPosition(positionNftMint) { return findProgramAddressSync([Buffer.from("position"), publicKeyBytes(positionNftMint)], METEORA_CP_AMM_PROGRAM_ID).publicKey; }
function deriveMeteoraVault(mint, pool) { return findProgramAddressSync([Buffer.from("token_vault"), publicKeyBytes(mint), publicKeyBytes(pool)], METEORA_CP_AMM_PROGRAM_ID).publicKey; }
function deriveAta(owner, mint) { return findProgramAddressSync([publicKeyBytes(owner), publicKeyBytes(TOKEN_PROGRAM_ID), publicKeyBytes(mint)], ASSOCIATED_TOKEN_PROGRAM_ID).publicKey; }

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSolUsdMicros() {
  const override = String(process.env.SOLANA_GRADUATION_SOL_USD_MICROS || "").trim();
  if (override) return BigInt(override);
  if (solPriceCache.priceUsdMicros > 0n && Date.now() - solPriceCache.at < PRICE_CACHE_MS) return solPriceCache.priceUsdMicros;
  const body = await fetchJson("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { headers: { accept: "application/json" } });
  const price = Number(body?.solana?.usd);
  if (!Number.isFinite(price) || price <= 0) throw new Error("Invalid SOL/USD reference");
  const value = BigInt(Math.round(price * 1_000_000));
  solPriceCache = { priceUsdMicros: value, at: Date.now() };
  return value;
}

async function fetchQuoteUsdMicros(config) {
  if (config.profile === QUOTE_PROFILE.NATIVE) return fetchSolUsdMicros();
  const cached = quotePriceCache.get(config.id);
  if (cached?.value > 0n && Date.now() - cached.at < PRICE_CACHE_MS) return cached.value;
  let price = null;
  if (config.binanceSymbol) {
    const body = await fetchJson(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(config.binanceSymbol)}`);
    price = Number(body?.price);
  } else if (config.coinGeckoId) {
    const body = await fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(config.coinGeckoId)}&vs_currencies=usd`);
    price = Number(body?.[config.coinGeckoId]?.usd);
  } else if (config.quoteUsdMicros != null) {
    return config.quoteUsdMicros;
  } else {
    failUnsafe(`Quote ${config.id} has no authoritative USD reference source.`);
  }
  if (!Number.isFinite(price) || price <= 0) failUnsafe(`Quote ${config.id} USD reference is unavailable.`);
  const value = BigInt(Math.round(price * 1_000_000));
  quotePriceCache.set(config.id, { value, at: Date.now() });
  return value;
}

function deviationBps(actual, reference) {
  const diff = actual > reference ? actual - reference : reference - actual;
  return Number((diff * BPS_DENOMINATOR) / reference);
}

async function fetchAcquisitionQuote(config, amountLamports) {
  const slippageBps = config.maxSlippageBps || DEFAULT_SLIPPAGE_BPS;
  const params = new URLSearchParams({
    inputMint: NATIVE_MINT,
    outputMint: config.mint,
    amount: amountLamports.toString(),
    slippageBps: String(slippageBps),
    swapMode: "ExactIn",
    restrictIntermediateTokens: "true",
  });
  let quote;
  try {
    quote = await fetchJson(`${config.jupiterApiBase}/quote?${params.toString()}`, { headers: { accept: "application/json" } });
  } catch (error) {
    failUnsafe(`Graduation-sized acquisition quote for ${config.id} is unavailable.`, error);
  }
  const outAmount = BigInt(quote?.outAmount || 0);
  const minOut = BigInt(quote?.otherAmountThreshold || 0);
  const impactBps = Math.round(Number(quote?.priceImpactPct || 0) * 10_000);
  if (outAmount <= 0n || minOut <= 0n || minOut > outAmount) failUnsafe("Acquisition route returned invalid output bounds.");
  if (impactBps > config.maxImpactBps) failUnsafe(`Acquisition price impact ${impactBps} bps exceeds ${config.maxImpactBps} bps.`);
  return { quote, outAmount, minOut, impactBps, slippageBps };
}

function ceilDiv(numerator, denominator) { return (numerator + denominator - 1n) / denominator; }

function buildGraduationDigest(fields) {
  return sha256(
    GRADUATION_AUTH_DOMAIN,
    u16(GRADUATION_AUTH_SCHEMA_VERSION, "schemaVersion"),
    publicKeyBytes(fields.programId), publicKeyBytes(fields.campaign), publicKeyBytes(fields.mint), publicKeyBytes(fields.authority),
    u64(fields.graduationTargetUsdMicros), u64(fields.nativeTargetLamports), u64(fields.oraclePriceUsdMicros),
    publicKeyBytes(fields.meteoraPool), publicKeyBytes(fields.meteoraPosition), publicKeyBytes(fields.positionNftMint),
    i64(fields.deadline), Buffer.from(fields.nonce), u8(fields.finalizeRouteProfile),
    publicKeyBytes(fields.quoteMint), Buffer.from(fields.quoteConfigHash), u16(fields.quotePolicyVersion),
    u8(fields.quoteProfile), u8(fields.quoteProviderClass), publicKeyBytes(fields.acquisitionProgram),
    u64(fields.quoteReferenceUsdMicros), u8(fields.quoteDecimals), u64(fields.expectedQuoteAmount), u64(fields.minQuoteAmount),
    u16(fields.maxSlippageBps), u16(fields.maxImpactBps), u16(fields.maxDeviationBps), publicKeyBytes(fields.quoteRecoveryAccount),
  );
}

export async function solanaGraduationAuthorizationV2(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  try {
    if (!isTruthy(process.env.SOLANA_GRADUATION_AUTH_ENABLED)) throw new SolanaGraduationAuthorizationError("Solana graduation authorization is disabled.", { code: "SOLANA_GRADUATION_AUTH_DISABLED", httpStatus: 503 });
    const body = await readJson(req);
    const chainId = Number(body.chainId || 101);
    if (!isSolanaChain(chainId)) throw new SolanaGraduationAuthorizationError("chainId must be Solana (101).", { code: "NOT_A_SOLANA_CHAIN", httpStatus: 400 });
    if (body.quoteMint) throw new SolanaGraduationAuthorizationError("quoteMint is not accepted from clients; select an approved quoteConfigId.", { code: "SOLANA_GRADUATION_ARBITRARY_QUOTE_REJECTED", httpStatus: 400 });

    const requestedConfigId = String(body.quoteConfigId || process.env.SOLANA_GRADUATION_NATIVE_QUOTE_CONFIG_ID || "").trim();
    if (!requestedConfigId) throw new SolanaGraduationAuthorizationError("quoteConfigId is required and must be an authoritative Quote Asset Catalog deployment id.", { code: "SOLANA_GRADUATION_QUOTE_NOT_APPROVED", httpStatus: 400 });
    const quoteConfig = await resolveCatalogQuoteConfig({ chainId, quoteConfigId: requestedConfigId });

    const campaignAddress = publicKeyString(body.campaignAddress, "campaignAddress");
    const authorityAddress = publicKeyString(body.authorityAddress, "authorityAddress");
    const positionNftMint = publicKeyString(body.positionNftMint, "positionNftMint");
    const rpcUrl = requiredEnv("SOLANA_RPC_URL");
    const programId = publicKeyString(requiredEnv("SOLANA_LAUNCHPAD_PROGRAM_ID"), "SOLANA_LAUNCHPAD_PROGRAM_ID");
    const signer = createEd25519Signer(requiredEnv("SOLANA_ROUTE_SIGNER_SECRET_KEY"));
    const routeSigner = publicKeyString(requiredEnv("SOLANA_ROUTE_SIGNER_PUBLIC_KEY"), "SOLANA_ROUTE_SIGNER_PUBLIC_KEY");
    if (!samePublicKey(signer.publicKeyBase58, routeSigner)) throw new SolanaGraduationAuthorizationError("Route signer secret/public key mismatch.", { code: "SOLANA_ROUTE_SIGNER_CONFIGURATION_MISMATCH", httpStatus: 503 });

    const globalConfig = findProgramAddressSync([Buffer.from("global")], programId).publicKey;
    const [globalData, campaignData] = await Promise.all([
      getAccountData(rpcUrl, globalConfig, programId, "GlobalConfig"),
      getAccountData(rpcUrl, campaignAddress, programId, "Campaign"),
    ]);
    const global = decodeGlobalConfig(globalData);
    const campaign = decodeCampaignGraduationFields(campaignData);
    if (!samePublicKey(authorityAddress, global.treasuryOperator)) throw new SolanaGraduationAuthorizationError("Graduation authority must equal GlobalConfig.treasuryOperator.", { code: "SOLANA_GRADUATION_AUTHORITY_MISMATCH", httpStatus: 403 });
    if (campaign.graduated || campaign.paused) throw new SolanaGraduationAuthorizationError("Campaign is already graduated or paused.", { code: "SOLANA_GRADUATION_CAMPAIGN_NOT_EXECUTABLE" });
    if (campaign.economicsVersion < 3 || campaign.dexAdapter !== 1) throw new SolanaGraduationAuthorizationError("Campaign is not an Economics V3 / Meteora-only campaign.", { code: "SOLANA_GRADUATION_CAMPAIGN_UNSUPPORTED" });
    if (samePublicKey(campaign.mint, quoteConfig.mint)) throw new SolanaGraduationAuthorizationError("Campaign mint cannot be its own quote asset.", { code: "SOLANA_GRADUATION_QUOTE_NOT_APPROVED" });

    if (quoteConfig.profile !== QUOTE_PROFILE.NATIVE) {
    quoteConfig.recoveryAccount = deriveAta(authorityAddress, quoteConfig.mint);
    const mintData = await getAccountData(rpcUrl, quoteConfig.mint, TOKEN_PROGRAM_ID, "Quote mint");
    if (mintData.length < 45) failUnsafe("Quote mint account is too short.");
    const chainDecimals = mintData.readUInt8(44);
    if (quoteConfig.decimals && quoteConfig.decimals !== chainDecimals) failUnsafe("Catalog quote decimals do not match the mint account.");
    quoteConfig.decimals = chainDecimals;
  }
  const [oraclePriceUsdMicros, quoteReferenceUsdMicros] = await Promise.all([fetchSolUsdMicros(), fetchQuoteUsdMicros(quoteConfig)]);
    const nativeTargetLamports = ceilDiv(campaign.graduationTargetUsdMicros * ONE_SOL_LAMPORTS, oraclePriceUsdMicros);
    if (!(campaign.soldTokens >= campaign.curveTokenSupply || campaign.netRaisedLamports >= nativeTargetLamports)) throw new SolanaGraduationAuthorizationError("Campaign has not reached the native graduation target yet.", { code: "SOLANA_GRADUATION_THRESHOLD_NOT_MET" });
    const liquidity = graduationLiquidityQuote(campaign);

    let acquisition = null;
    let expectedQuoteAmount = 0n;
    let minQuoteAmount = 0n;
    let maxSlippageBps = 0;
    let maxImpactBps = 0;
    let maxDeviationBps = 0;
    if (quoteConfig.profile !== QUOTE_PROFILE.NATIVE) {
      acquisition = await fetchAcquisitionQuote(quoteConfig, liquidity.maxLiquidityLamports);
      expectedQuoteAmount = acquisition.outAmount;
      minQuoteAmount = acquisition.minOut;
      maxSlippageBps = acquisition.slippageBps;
      maxImpactBps = quoteConfig.maxImpactBps;
      maxDeviationBps = quoteConfig.maxDeviationBps;
      if (quoteConfig.quoteUsdMicros != null && deviationBps(quoteReferenceUsdMicros, quoteConfig.quoteUsdMicros) > maxDeviationBps) failUnsafe("Quote reference price has moved outside the approved deviation envelope.");
    }

    const meteoraPool = deriveMeteoraPool(campaign.mint, quoteConfig.mint);
    const meteoraPosition = deriveMeteoraPosition(positionNftMint);
    const chainNow = await getSolanaChainUnixTime(rpcUrl);
    const ttlSeconds = parsePositiveInteger(process.env.SOLANA_GRADUATION_AUTH_TTL_SECONDS, DEFAULT_AUTH_TTL_SECONDS, MAX_AUTH_TTL_SECONDS);
    const deadline = BigInt(chainNow + ttlSeconds);
    const nonce = crypto.randomBytes(32);
    const finalizeRouteProfile = ROUTE_PROFILE_UNLINKED;
    const quoteConfigHash = quoteConfig.bindingHash || configHash(quoteConfig.id);
    const digest = buildGraduationDigest({
      programId, campaign: campaignAddress, mint: campaign.mint, authority: authorityAddress,
      graduationTargetUsdMicros: campaign.graduationTargetUsdMicros, nativeTargetLamports, oraclePriceUsdMicros,
      meteoraPool, meteoraPosition, positionNftMint, deadline, nonce, finalizeRouteProfile,
      quoteMint: quoteConfig.mint, quoteConfigHash, quotePolicyVersion: quoteConfig.policyVersion,
      quoteProfile: quoteConfig.profile, quoteProviderClass: quoteConfig.providerClass,
      acquisitionProgram: quoteConfig.acquisitionProgram, quoteReferenceUsdMicros, quoteDecimals: quoteConfig.decimals,
      expectedQuoteAmount, minQuoteAmount, maxSlippageBps, maxImpactBps, maxDeviationBps,
      quoteRecoveryAccount: quoteConfig.recoveryAccount,
    });
    const signature = signer.sign(digest);

    return json(res, 200, {
      schemaVersion: GRADUATION_AUTH_SCHEMA_VERSION,
      chainId,
      programId,
      chainNow,
      campaign: { address: campaignAddress, mint: campaign.mint, creator: campaign.creator, generationConfig: campaign.generationConfig, graduationTargetUsdMicros: campaign.graduationTargetUsdMicros.toString(), soldTokens: campaign.soldTokens.toString(), curveTokenSupply: campaign.curveTokenSupply.toString(), netRaisedLamports: campaign.netRaisedLamports.toString() },
      oracle: { solUsdMicros: oraclePriceUsdMicros.toString(), nativeTargetLamports: nativeTargetLamports.toString(), quoteUsdMicros: quoteReferenceUsdMicros.toString() },
      graduationLiquidity: { maxLiquidityLamports: liquidity.maxLiquidityLamports.toString(), maxLiquidityTokens: liquidity.maxLiquidityTokens.toString(), finalizeFeeLamports: liquidity.finalizeFeeLamports.toString(), creatorPayoutLamports: liquidity.creatorPayoutLamports.toString(), finalSpotNanoLamports: liquidity.spotNano.toString() },
      quote: { configId: quoteConfig.id, assetId: quoteConfig.assetId, providerId: quoteConfig.providerId, providerKey: quoteConfig.providerKey, providerClassName: quoteConfig.providerClassName, policyId: quoteConfig.policyId, policyKey: quoteConfig.policyKey, stateVersion: quoteConfig.stateVersion, configHashHex: quoteConfigHash.toString("hex"), mint: quoteConfig.mint, policyVersion: quoteConfig.policyVersion, profile: quoteConfig.profile, providerClass: quoteConfig.providerClass, decimals: quoteConfig.decimals, acquisitionProgram: quoteConfig.acquisitionProgram, recoveryAccount: quoteConfig.recoveryAccount, expectedQuoteAmount: expectedQuoteAmount.toString(), minQuoteAmount: minQuoteAmount.toString(), maxSlippageBps, maxImpactBps, maxDeviationBps, acquisitionQuote: acquisition?.quote || null },
      createArgs: { nativeTargetLamports: nativeTargetLamports.toString(), oraclePriceUsdMicros: oraclePriceUsdMicros.toString(), deadline: deadline.toString(), nonce: Array.from(nonce), positionNftMint, finalizeRouteProfile, quoteMint: quoteConfig.mint, quoteConfigId: Array.from(quoteConfigHash), quotePolicyVersion: quoteConfig.policyVersion, quoteProfile: quoteConfig.profile, quoteProviderClass: quoteConfig.providerClass, acquisitionProgram: quoteConfig.acquisitionProgram, quoteReferenceUsdMicros: quoteReferenceUsdMicros.toString(), quoteDecimals: quoteConfig.decimals, expectedQuoteAmount: expectedQuoteAmount.toString(), minQuoteAmount: minQuoteAmount.toString(), maxSlippageBps, maxImpactBps, maxDeviationBps, quoteRecoveryAccount: quoteConfig.recoveryAccount },
      accounts: { authority: authorityAddress, globalConfig, generationConfig: campaign.generationConfig, campaign: campaignAddress, mint: campaign.mint, tokenVault: campaign.tokenVault, solVault: campaign.solVault, authorityTokenAccount: deriveAta(authorityAddress, campaign.mint), authorityQuoteAccount: quoteConfig.profile === QUOTE_PROFILE.NATIVE ? null : deriveAta(authorityAddress, quoteConfig.mint), quoteRecoveryAccount: quoteConfig.recoveryAccount, creator: campaign.creator, creatorTokenAccount: deriveAta(campaign.creator, campaign.mint), creatorProfile: findProgramAddressSync([Buffer.from("creator"), publicKeyBytes(campaign.creator)], programId).publicKey, graduationState: findProgramAddressSync([Buffer.from("graduation"), publicKeyBytes(campaignAddress)], programId).publicKey, meteoraProgram: METEORA_CP_AMM_PROGRAM_ID, meteoraPool, meteoraPosition, meteoraTokenVault: deriveMeteoraVault(campaign.mint, meteoraPool), meteoraNativeVault: deriveMeteoraVault(quoteConfig.mint, meteoraPool), positionNftMint, instructions: SYSVAR_INSTRUCTIONS_ID, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SYSTEM_PROGRAM_ID },
      authorization: { digestHex: digest.toString("hex"), digestBase64: digest.toString("base64"), signatureBase64: signature.toString("base64"), routeSigner: signer.publicKeyBase58, deadline: deadline.toString(), validUntil: new Date(Number(deadline) * 1000).toISOString(), ed25519InstructionMustImmediatelyPrecedeBeginGraduation: true },
      transactionPolicy: quoteConfig.profile === QUOTE_PROFILE.NATIVE
        ? "One transaction only: Ed25519 verify -> begin_graduation -> Meteora MEME/WSOL create+permanent-lock -> confirm_graduation."
        : "One transaction only: Ed25519 verify -> begin_graduation -> approved exact-in WSOL/QUOTE acquisition -> Meteora MEME/QUOTE create+permanent-lock -> confirm_graduation; simulate the complete V0 transaction before submission.",
    });
  } catch (error) {
    if (error instanceof SolanaGraduationAuthorizationError) return json(res, error.httpStatus || 409, { error: error.message, code: error.code });
    console.error("[solana-graduation-v2] authorization failed", error);
    return json(res, 500, { error: "Solana graduation authorization failed.", code: "SOLANA_GRADUATION_AUTHORIZATION_INTERNAL_ERROR" });
  }
}

export const solanaGraduationAuthorizationV1 = solanaGraduationAuthorizationV2;
