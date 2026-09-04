import { ethers } from "ethers";
import { badMethod, getQuery, isAddress, json, readJson } from "../../server/http.js";
import { getRpcUrls, getServerReadProvider } from "../lib/getServerReadProvider.js";
import { logRouteAuthorization } from "./route-auth-log.js";
import {
  evaluateCreatePreflight,
  evaluateTradePreflight,
  reserveCreatorClusterBuyAuthorization,
} from "./security-current-time.js";
import {
  getRouteDecision,
  ROUTE_PROFILE_NAMES,
  ROUTE_PROFILE_STANDARD_LINKED,
  ROUTE_PROFILE_STANDARD_UNLINKED,
  ROUTE_PROFILE_OG_LINKED,
} from "./route-decision.js";
import {
  expectedCampaignGeneration,
  generationRule,
  isSupportedFactoryGeneration,
  signCreateAuthorization,
  signTradeAuthorization,
} from "./routeAuthorizationSigner.js";
import { prepareRobinhoodStockCreateAuthorization } from "./robinhoodStockCreatePolicy.js";
import { defaultEvmChainId } from "../lib/defaultEvmChain.js";
import { isCreatorArmCooldownActive, normalizeCreatorArmCooldownEndsAt } from "../lib/creatorArmCooldown.js";

const VALID_PROFILES = new Set([
  ROUTE_PROFILE_STANDARD_LINKED,
  ROUTE_PROFILE_STANDARD_UNLINKED,
  ROUTE_PROFILE_OG_LINKED,
]);

const FACTORY_ROUTE_AUTHORITY_ABI = ["function routeAuthority() view returns (address)"];
const FACTORY_CREATION_PREFLIGHT_ABI = [
  "function routeAuthority() view returns (address)",
  "function live() view returns (bool)",
  "function globalPaused() view returns (bool)",
  "function createPaused() view returns (bool)",
  "function creatorRegistry() view returns (address)",
  "function FACTORY_GENERATION() view returns (uint32)",
  "function CAMPAIGN_GENERATION() view returns (uint32)",
  "function creatorLaunchEligibility(address creator) view returns (bool allowed,uint256 cooldownEndsAt,uint256 currentLiveCount,uint256 maxLiveBonding)",
];
const CREATOR_REGISTRY_PREFLIGHT_ABI = [
  "function getCreatorProfile(address) view returns (uint8 tier,uint256 trustScore,uint256 liveBondingCount,uint256 lastLaunchTimestamp,bool restricted,bool manualReviewRequired)",
  "function getCreatorRules(address) view returns (uint256 maxLiveBonding,uint256 cooldownSeconds,uint256 creatorBuyLockSeconds,uint256 creatorBuyCapWei,uint256 maxClusterWallets)",
];

function methodAllowed(req, res, allowed) {
  if (allowed.includes(req.method)) return true;
  badMethod(res);
  return false;
}

function normalizeAddress(value) {
  const raw = String(value || "").trim();
  return isAddress(raw) ? ethers.getAddress(raw) : "";
}

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

function parseUint8(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`${label} must be a uint8 value`);
  return n;
}

function parseUint(value, label) {
  if (value === undefined || value === null || value === "") throw new Error(`${label} is required`);
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${label} must be a uint-compatible value`);
  }
}

function getRouteAuthorityPrivateKey() {
  return (
    String(process.env.ROUTE_AUTHORITY_PRIVATE_KEY || "").trim() ||
    String(process.env.MWZ_ROUTE_AUTHORITY_PRIVATE_KEY || "").trim() ||
    String(process.env.ROUTE_AUTH_PRIVATE_KEY || "").trim()
  );
}

function getSigner() {
  const privateKey = getRouteAuthorityPrivateKey();
  if (!privateKey) return null;
  try {
    return new ethers.Wallet(privateKey);
  } catch {
    return null;
  }
}

function readRouteProfileEnv(key, fallback) {
  const n = Number(process.env[key]);
  if (!Number.isFinite(n)) return fallback;
  const profile = Math.trunc(n);
  return VALID_PROFILES.has(profile) ? profile : fallback;
}

function getDefaultRouteProfiles() {
  return {
    tradeRouteProfileId: readRouteProfileEnv("DEFAULT_TRADE_ROUTE_PROFILE_ID", ROUTE_PROFILE_STANDARD_UNLINKED),
    finalizeRouteProfileId: readRouteProfileEnv("DEFAULT_FINALIZE_ROUTE_PROFILE_ID", ROUTE_PROFILE_STANDARD_UNLINKED),
  };
}

function getAuthDeadline() {
  const ttlSeconds = parsePositiveInt(process.env.ROUTE_AUTH_TTL_SECONDS, 10 * 60);
  return Math.floor(Date.now() / 1000) + ttlSeconds;
}

function validUntilFromDeadline(deadline) {
  return new Date(deadline * 1000).toISOString();
}

function getRpcUrl(chainId) {
  return getRpcUrls(chainId)[0] || "";
}

function getFactoryAddressFromEnv(chainId) {
  return normalizeAddress(
    process.env[`VITE_FACTORY_ADDRESS_${chainId}`] ||
      process.env[`FACTORY_ADDRESS_${chainId}`] ||
      process.env.VITE_FACTORY_ADDRESS ||
      process.env.FACTORY_ADDRESS ||
      "",
  );
}

const WAD = 10n ** 18n;
const STANDARD_GRADUATION_TARGETS = new Set([
  (15_000n * WAD).toString(),
  (30_000n * WAD).toString(),
  (50_000n * WAD).toString(),
]);
const TEST_GRADUATION_TARGET = (6n * WAD).toString();

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function normalizeUintString(value, fallback = "0") {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  try {
    const parsed = BigInt(raw);
    if (parsed < 0n) throw new Error("negative");
    return parsed.toString();
  } catch {
    throw new Error("graduationTarget must be a uint-compatible value");
  }
}

function validateGraduationTarget(chainId, graduationTarget) {
  if (graduationTarget === "0") return;
  if (STANDARD_GRADUATION_TARGETS.has(graduationTarget)) return;
  const testThresholdEnabled = isTruthy(
    process.env.VITE_ENABLE_TEST_GRADUATION_THRESHOLD || process.env.ENABLE_TEST_GRADUATION_THRESHOLD || "false",
  );
  const cid = Number(chainId);
  if (
    testThresholdEnabled &&
    (cid === 97 || cid === 46630 || cid === 101 || cid === 102) &&
    graduationTarget === TEST_GRADUATION_TARGET
  ) {
    return;
  }
  throw new Error("Unsupported graduation target");
}

function normalizeCampaignRequest(body) {
  const source = body.campaignRequest || body.request || body;
  const request = {
    name: String(source.name || ""),
    symbol: String(source.symbol || ""),
    logoURI: String(source.logoURI || source.logoUri || ""),
    xAccount: String(source.xAccount || ""),
    website: String(source.website || ""),
    extraLink: String(source.extraLink || ""),
    graduationTarget: normalizeUintString(source.graduationTarget ?? source.graduationTargetWei ?? 0),
  };
  if (!request.name.trim()) throw new Error("Campaign request name is required");
  if (!request.symbol.trim()) throw new Error("Campaign request symbol is required");
  if (!request.logoURI.trim()) throw new Error("Campaign request logoURI is required");
  return request;
}

function routeSignerUnavailable(res) {
  return json(res, 503, {
    error: "Route authorization signer is not configured.",
    code: "ROUTE_AUTHORIZER_NOT_CONFIGURED",
    requiredEnv: ["ROUTE_AUTHORITY_PRIVATE_KEY", "or MWZ_ROUTE_AUTHORITY_PRIVATE_KEY", "or ROUTE_AUTH_PRIVATE_KEY"],
  });
}

async function readOnchainRouteAuthority({ chainId, factoryAddress }) {
  if (!getRpcUrls(chainId).length || !factoryAddress) {
    return { routeAuthority: null, error: "Missing RPC URL or factory address" };
  }

  try {
    const provider = await getServerReadProvider(chainId);
    const factory = new ethers.Contract(factoryAddress, FACTORY_ROUTE_AUTHORITY_ABI, provider);
    const routeAuthority = await factory.routeAuthority();
    return { routeAuthority: ethers.getAddress(routeAuthority), error: null };
  } catch (error) {
    return { routeAuthority: null, error: String(error?.shortMessage || error?.message || error) };
  }
}

async function readOnchainCreationPreflight({ chainId, factoryAddress, walletAddress }) {
  if (!getRpcUrls(chainId).length) {
    return { ok: false, status: 503, code: "CREATE_RPC_NOT_CONFIGURED", error: "RPC URL is missing for this chain." };
  }

  try {
    const provider = await getServerReadProvider(chainId);
    const code = await provider.getCode(factoryAddress);
    if (!code || code === "0x") {
      return { ok: false, status: 409, code: "CREATE_FACTORY_CODE_MISSING", error: "The configured creation factory has no contract code." };
    }

    const factory = new ethers.Contract(factoryAddress, FACTORY_CREATION_PREFLIGHT_ABI, provider);
    const [
      live,
      globalPaused,
      createPaused,
      factoryGenerationRaw,
      campaignGenerationRaw,
      eligibility,
      routeAuthority,
    ] = await Promise.all([
      factory.live(),
      factory.globalPaused(),
      factory.createPaused(),
      factory.FACTORY_GENERATION(),
      factory.CAMPAIGN_GENERATION(),
      factory.creatorLaunchEligibility(walletAddress),
      factory.routeAuthority(),
    ]);

    const factoryGeneration = Number(factoryGenerationRaw);
    const campaignGeneration = Number(campaignGenerationRaw);
    if (!isSupportedFactoryGeneration(chainId, factoryGeneration) || campaignGeneration !== expectedCampaignGeneration(chainId)) {
      return {
        ok: false,
        status: 409,
        code: "CREATE_FACTORY_GENERATION_MISMATCH",
        error: `Creation on chain ${chainId} requires factory/campaign generation ${generationRule(chainId)}; configured factory reports ${factoryGeneration}/${campaignGeneration}.`,
        onChain: { factoryGeneration, campaignGeneration },
      };
    }
    if (!live || globalPaused || createPaused) {
      return {
        ok: false,
        status: 503,
        code: "CREATE_FACTORY_NOT_READY",
        error: !live ? "The configured creation factory is not live." : globalPaused ? "The creation factory is globally paused." : "New campaign creation is paused.",
        onChain: { factoryGeneration, campaignGeneration },
      };
    }

    const allowed = eligibility[0] === true || eligibility.allowed === true;
    let lastRecordedLaunchAt = 0;
    let cooldownSeconds = 0;
    try {
      const registryAddress = await factory.creatorRegistry();
      if (registryAddress && registryAddress !== ethers.ZeroAddress) {
        const registry = new ethers.Contract(registryAddress, CREATOR_REGISTRY_PREFLIGHT_ABI, provider);
        const [profile, rules] = await Promise.all([
          registry.getCreatorProfile(walletAddress),
          registry.getCreatorRules(walletAddress),
        ]);
        lastRecordedLaunchAt = Number(profile.lastLaunchTimestamp ?? profile[3] ?? 0);
        cooldownSeconds = Number(rules.cooldownSeconds ?? rules[1] ?? 0);
      }
    } catch {
      lastRecordedLaunchAt = 0;
    }
    const cooldownEndsAt = normalizeCreatorArmCooldownEndsAt({
      allowed,
      lastRecordedLaunchAt,
      cooldownSeconds,
      cooldownEndsAt: Number(eligibility.cooldownEndsAt ?? eligibility[1] ?? 0),
    });
    const onChainLiveCampaignCount = Number(eligibility.currentLiveCount ?? eligibility[2] ?? 0);
    const onChainLiveCampaignLimit = Number(eligibility.maxLiveBonding ?? eligibility[3] ?? 0);
    if (!allowed) {
      return {
        ok: false,
        status: 403,
        code: "CREATE_ONCHAIN_ELIGIBILITY_BLOCKED",
        error: onChainLiveCampaignCount >= onChainLiveCampaignLimit
          ? `Live campaign limit reached (${onChainLiveCampaignCount}/${onChainLiveCampaignLimit}). Graduate an existing live campaign before another deploy. Tier 1 max is 3 concurrent live campaigns.`
          : isCreatorArmCooldownActive({ allowed, lastRecordedLaunchAt, cooldownEndsAt })
            ? `Creator arm cooldown active until ${new Date(cooldownEndsAt * 1000).toISOString()}. Immediate and timed arms both require 24h between on-chain deploys. A later trading-open time does not bypass this.`
            : "This creator wallet cannot deploy or arm another campaign right now.",
        onChain: { allowed, cooldownEndsAt, lastRecordedLaunchAt, onChainLiveCampaignCount, onChainLiveCampaignLimit, factoryGeneration, campaignGeneration },
      };
    }

    return {
      ok: true,
      onChain: {
        allowed,
        canArmNow: true,
        cooldownEndsAt,
        lastRecordedLaunchAt,
        onChainLiveCampaignCount,
        onChainLiveCampaignLimit,
        factoryGeneration,
        campaignGeneration,
        routeAuthority: ethers.getAddress(routeAuthority),
      },
    };
  } catch (error) {
    return {
      ok: false,
      status: 503,
      code: "CREATE_ONCHAIN_PREFLIGHT_FAILED",
      error: `Current on-chain creation eligibility could not be verified: ${String(error?.shortMessage || error?.message || error)}`,
    };
  }
}

function buildReadinessWarnings({ signer, factoryAddress, rpcUrlConfigured, onchain, matchesOnchain }) {
  const warnings = [];
  if (!signer) warnings.push("Route-authority private key is not configured or is invalid.");
  if (!factoryAddress) warnings.push("Factory address is missing for this chain.");
  if (!rpcUrlConfigured) warnings.push("RPC URL is missing for this chain, so on-chain routeAuthority cannot be verified.");
  if (onchain.error) warnings.push(`On-chain routeAuthority check failed: ${onchain.error}`);
  if (signer && onchain.routeAuthority && !matchesOnchain) {
    warnings.push("Configured signer address does not match LaunchFactory.routeAuthority().");
  }
  return warnings;
}

function readinessStatus({ signer, factoryAddress, rpcUrlConfigured, onchain, matchesOnchain }) {
  if (!signer) return "missing_signer";
  if (!factoryAddress) return "missing_factory";
  if (!rpcUrlConfigured) return "missing_rpc";
  if (!onchain.routeAuthority) return "onchain_check_failed";
  if (!matchesOnchain) return "authority_mismatch";
  return "ready";
}

export async function routingStatus(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;

  const q = getQuery(req);
  const chainId = parsePositiveInt(q.chainId || process.env.VITE_DEFAULT_CHAIN_ID || process.env.VITE_TARGET_CHAIN_ID, defaultEvmChainId());
  const signer = getSigner();
  const routeAuthority = signer?.address || null;
  const factoryAddress = normalizeAddress(q.factoryAddress) || getFactoryAddressFromEnv(chainId);
  const defaults = getDefaultRouteProfiles();
  const rpcUrlConfigured = Boolean(getRpcUrl(chainId));
  const onchain = await readOnchainRouteAuthority({ chainId, factoryAddress });
  const matchesOnchain = Boolean(routeAuthority && onchain.routeAuthority && routeAuthority.toLowerCase() === onchain.routeAuthority.toLowerCase());

  const readyForCoreFlow = Boolean(signer && factoryAddress && rpcUrlConfigured && onchain.routeAuthority && matchesOnchain);
  const warnings = buildReadinessWarnings({ signer, factoryAddress, rpcUrlConfigured, onchain, matchesOnchain });

  const walletAddress = normalizeAddress(q.walletAddress);
  const routeDecision = walletAddress ? await getRouteDecision(walletAddress) : null;
  const createPreflight = walletAddress ? await evaluateCreatePreflight({ walletAddress }) : null;
  const onChainCreationPreflight = walletAddress && factoryAddress
    ? await readOnchainCreationPreflight({ chainId, factoryAddress, walletAddress })
    : null;

  return json(res, 200, {
    ok: readyForCoreFlow,
    readyForCoreFlow,
    status: readinessStatus({ signer, factoryAddress, rpcUrlConfigured, onchain, matchesOnchain }),
    warnings,
    signerConfigured: Boolean(signer),
    routeAuthority,
    chainId,
    factoryAddress: factoryAddress || null,
    rpcConfigured: rpcUrlConfigured,
    onchainRouteAuthority: onchain.routeAuthority,
    matchesOnchain,
    onchainError: onchain.error,
    profiles: {
      defaultTradeRouteProfileId: defaults.tradeRouteProfileId,
      defaultFinalizeRouteProfileId: defaults.finalizeRouteProfileId,
      routeProfileNames: ROUTE_PROFILE_NAMES,
    },
    routeDecision: routeDecision?.decision || null,
    createPreflight,
    onChainCreationPreflight,
    ttlSeconds: parsePositiveInt(process.env.ROUTE_AUTH_TTL_SECONDS, 10 * 60),
    closeout: {
      requiresSignerConfigured: true,
      requiresOnchainMatch: true,
      requiresCreateAndTradeAuthorization200: true,
      requiresSecurityPreflightAllowed: true,
      requiresCurrentOnChainCreatorEligibility: true,
    },
  });
}

export async function routingCreateAuthorization(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;

  const body = await readJson(req);
  const signer = getSigner();
  if (!signer) return routeSignerUnavailable(res);

  const walletAddress = normalizeAddress(body.walletAddress);
  const factoryAddress = normalizeAddress(body.factoryAddress);
  const chainId = parsePositiveInt(body.chainId, 0);
  const requestedStockToken = String(body.stockToken || body.graduationQuoteAsset || "").trim();
  const stockToken = requestedStockToken ? normalizeAddress(requestedStockToken) : "";

  if (!walletAddress) return json(res, 400, { error: "Invalid or missing walletAddress" });
  if (!factoryAddress) return json(res, 400, { error: "Invalid or missing factoryAddress" });
  if (!chainId) return json(res, 400, { error: "Invalid or missing chainId" });
  if (requestedStockToken && !stockToken) return json(res, 400, { error: "Invalid stockToken" });

  let campaignRequest;
  try {
    campaignRequest = normalizeCampaignRequest(body);
    validateGraduationTarget(chainId, campaignRequest.graduationTarget);
  } catch (error) {
    return json(res, 400, { error: error.message });
  }

  const onChainPreflight = await readOnchainCreationPreflight({ chainId, factoryAddress, walletAddress });
  if (!onChainPreflight.ok) {
    return json(res, onChainPreflight.status || 503, {
      error: onChainPreflight.error,
      code: onChainPreflight.code,
      onChainPreflight: onChainPreflight.onChain || null,
    });
  }
  if (onChainPreflight.onChain.routeAuthority.toLowerCase() !== signer.address.toLowerCase()) {
    return json(res, 503, {
      error: "Configured route signer does not match the active factory route authority.",
      code: "ROUTE_AUTHORITY_MISMATCH",
    });
  }

  const createPreflight = await evaluateCreatePreflight({ walletAddress });
  if (!createPreflight.allowed) {
    return json(res, 403, {
      error: createPreflight.reasons?.[0] || "Creator is not eligible to launch.",
      code: "CREATE_PREFLIGHT_BLOCKED",
      preflight: createPreflight,
    });
  }

  const { tradeRouteProfileId, finalizeRouteProfileId, decision } = await getRouteDecision(walletAddress);
  const deadline = getAuthDeadline();
  const validUntil = validUntilFromDeadline(deadline);
  let signature;
  let graduationMarket = {
    kind: "NATIVE",
    quoteAsset: null,
    marketPolicyVersion: "robinhood_market_v1",
  };

  if (stockToken) {
    try {
      const stockAuthorization = await prepareRobinhoodStockCreateAuthorization({
        signer,
        chainId,
        factoryAddress,
        creator: walletAddress,
        request: campaignRequest,
        stockToken,
        tradeRouteProfileId,
        finalizeRouteProfileId,
        deadline,
      });
      signature = stockAuthorization.signature;
      graduationMarket = {
        kind: "STOCK_TOKEN",
        quoteAsset: stockAuthorization.stockToken,
        marketPolicyVersion: stockAuthorization.marketPolicyVersion,
        stockGraduationAdapter: stockAuthorization.stockGraduationAdapter,
        stockCampaignImplementation: stockAuthorization.stockCampaignImplementation,
        asset: stockAuthorization.asset,
      };
    } catch (error) {
      return json(res, 409, {
        error: String(error?.message || error || "Stock Battlefield authorization failed"),
        code: "STOCK_CREATE_POLICY_BLOCKED",
      });
    }
  } else {
    signature = await signCreateAuthorization({
      signer,
      chainId,
      factoryAddress,
      creator: walletAddress,
      request: campaignRequest,
      tradeRouteProfileId,
      finalizeRouteProfileId,
      deadline,
    });
  }

  const combinedPreflight = { ...createPreflight, ...onChainPreflight.onChain };
  await logRouteAuthorization({
    chainId,
    walletAddress,
    routeKind: stockToken ? "create_stock" : "create",
    routeProfileId: tradeRouteProfileId,
    finalizeRouteProfileId,
    factoryAddress,
    decision,
    routeAuthority: signer.address,
    authorizationDeadline: deadline,
    validUntil,
    metadata: {
      endpoint: "/api/routing/create-authorization",
      campaignRequest,
      graduationMarket,
      preflight: combinedPreflight,
    },
  });

  return json(res, 200, {
    authorization: { tradeRouteProfileId, finalizeRouteProfileId, validUntil, signature },
    graduationMarket,
    routeAuthority: signer.address,
    decision,
    preflight: combinedPreflight,
  });
}

export async function routingTradeAuthorization(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;

  const body = await readJson(req);
  const signer = getSigner();
  if (!signer) return routeSignerUnavailable(res);

  const walletAddress = normalizeAddress(body.walletAddress);
  const campaignAddress = normalizeAddress(body.campaignAddress);
  const chainId = parsePositiveInt(body.chainId, 0);

  if (!walletAddress) return json(res, 400, { error: "Invalid or missing walletAddress" });
  if (!campaignAddress) return json(res, 400, { error: "Invalid or missing campaignAddress" });
  if (!chainId) return json(res, 400, { error: "Invalid or missing chainId" });

  let action;
  let amount;
  let limit;
  try {
    action = parseUint8(body.action, "action");
    amount = parseUint(body.amount, "amount");
    limit = parseUint(body.limit, "limit");
  } catch (error) {
    return json(res, 400, { error: error.message });
  }

  const tradePreflight = await evaluateTradePreflight({ walletAddress, campaignAddress, chainId, action });
  if (!tradePreflight.allowed) {
    return json(res, 403, {
      error: tradePreflight.reasons?.[0] || "Wallet is not eligible to trade.",
      code: tradePreflight.code || "TRADE_PREFLIGHT_BLOCKED",
      preflight: tradePreflight,
    });
  }

  const canonicalCampaignAddress = normalizeAddress(tradePreflight.canonicalCampaignAddress) || campaignAddress;
  const { routeProfileId, decision } = await getRouteDecision(walletAddress);
  const deadline = getAuthDeadline();
  const validUntil = validUntilFromDeadline(deadline);
  const capReservation = await reserveCreatorClusterBuyAuthorization({
    preflight: tradePreflight,
    chainId,
    campaignAddress: canonicalCampaignAddress,
    walletAddress,
    action,
    amount,
    limit,
    authorizationDeadline: deadline,
  });

  if (!capReservation.allowed) {
    const blockedPreflight = {
      ...tradePreflight,
      allowed: false,
      code: capReservation.code,
      reasons: [capReservation.error, ...(tradePreflight.reasons || [])],
      creatorProtection: capReservation.creatorProtection,
    };
    return json(res, capReservation.status || 403, {
      error: capReservation.error,
      code: capReservation.code,
      preflight: blockedPreflight,
    });
  }

  const authorizedPreflight = capReservation.reservation
    ? {
        ...tradePreflight,
        creatorProtection: {
          ...(tradePreflight.creatorProtection || {}),
          reservation: capReservation.reservation,
        },
      }
    : tradePreflight;

  const signature = await signTradeAuthorization({
    signer,
    chainId,
    campaignAddress: canonicalCampaignAddress,
    actor: walletAddress,
    routeProfileId,
    action,
    amount,
    limit,
    deadline,
  });

  await logRouteAuthorization({
    chainId,
    walletAddress,
    routeKind: "trade",
    routeProfileId,
    campaignAddress: canonicalCampaignAddress,
    decision,
    routeAuthority: signer.address,
    authorizationDeadline: deadline,
    validUntil,
    metadata: { endpoint: "/api/routing/trade-authorization", action, amount: amount.toString(), limit: limit.toString(), preflight: authorizedPreflight },
  });

  return json(res, 200, {
    authorization: { routeProfileId, validUntil, signature },
    routeAuthority: signer.address,
    canonicalCampaignAddress,
    decision,
    preflight: authorizedPreflight,
  });
}
