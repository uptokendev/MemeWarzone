import { ethers } from "ethers";
import { pool } from "../../server/db.js";
import { getQuery, json, readJson } from "../../server/http.js";
import { getRpcUrls, getServerReadProvider } from "../lib/getServerReadProvider.js";
import {
  creatorClusterFundingDetectorConfigured,
  detectDirectCreatorFunding,
} from "./creator-cluster-detector.js";
import * as legacySecurity from "./security.js";

export * from "./security.js";
export { creatorClusterFundingDetectorConfigured };

const CAMPAIGN_PROTECTION_ABI = [
  "function token() view returns (address)",
  "function creator() view returns (address)",
  "function creatorBuyLockUntil() view returns (uint256)",
  "function creatorBuyCapWei() view returns (uint256)",
  "function creatorBoughtWei() view returns (uint256)",
  "function riskRegistry() view returns (address)",
  "function launchAt() view returns (uint64)",
];

const RISK_REGISTRY_ABI = [
  "function getWalletRisk(address wallet) view returns (uint8 riskLevel,bool restricted,bytes32 clusterId)",
];

const ZERO_CLUSTER = `0x${"0".repeat(64)}`;
const BUY_EXACT_TOKENS_ACTION = 0;
const BUY_EXACT_BNB_ACTION = 1;
const RESERVATION_GRACE_SECONDS = 2 * 60;

function getRpcUrl(chainId) {
  return getRpcUrls(chainId)[0] || "";
}

function normalizeAddress(value) {
  const raw = String(value || "").trim();
  if (!ethers.isAddress(raw)) return "";
  const normalized = ethers.getAddress(raw);
  return normalized === ethers.ZeroAddress ? "" : normalized;
}

function normalizeClusterId(value) {
  const raw = String(value || "").trim().toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(raw) && raw !== ZERO_CLUSTER ? raw : null;
}

function formatTierLabel(tier) {
  if (String(tier || "").toLowerCase() === "trusted") return { tier: "Trusted", tierNumber: 2 };
  if (String(tier || "").toLowerCase() === "proven") return { tier: "Proven", tierNumber: 3 };
  return { tier: "New", tierNumber: 1 };
}

function nestedRevertData(error) {
  const candidates = [
    error?.data,
    error?.error?.data,
    error?.info?.error?.data,
    error?.cause?.data,
    error?.revert?.data,
  ];
  return candidates.find((value) =>
    typeof value === "string" && /^0x[0-9a-f]+$/i.test(value) && value !== "0x"
  ) || null;
}

function isLegacyProtectionInterfaceUnavailable(error) {
  if (nestedRevertData(error)) return false;
  const text = String(error?.shortMessage || error?.reason || error?.message || error || "").toLowerCase();
  return (
    text.includes("function selector was not recognized") ||
    text.includes("no matching fragment") ||
    text.includes("no data present") ||
    (error?.code === "BAD_DATA" && text.includes("could not decode result data"))
  );
}

async function verifyCampaignIdentity({ provider, campaignAddress, expectedTokenAddress = "" }) {
  const campaign = new ethers.Contract(campaignAddress, CAMPAIGN_PROTECTION_ABI, provider);
  const [tokenRaw, creatorRaw] = await Promise.all([campaign.token(), campaign.creator()]);
  const tokenAddress = normalizeAddress(tokenRaw);
  const creatorAddress = normalizeAddress(creatorRaw);
  if (!tokenAddress || !creatorAddress) {
    throw new Error("Resolved campaign returned invalid token or creator data.");
  }
  const expectedToken = normalizeAddress(expectedTokenAddress);
  if (expectedToken && tokenAddress.toLowerCase() !== expectedToken.toLowerCase()) {
    throw new Error("Resolved campaign token does not match the submitted token address.");
  }
  return { campaignAddress: normalizeAddress(campaignAddress), tokenAddress, creatorAddress };
}

export async function resolveCanonicalTradeCampaignAddress({ chainId, campaignAddress }) {
  const numericChainId = Number(chainId);
  const submittedAddress = normalizeAddress(campaignAddress);
  if (!submittedAddress || ![56, 97].includes(numericChainId)) {
    throw new Error("Invalid campaign or token address for trade authorization.");
  }

  if (!getRpcUrls(numericChainId).length) throw new Error("RPC URL is not configured for campaign resolution.");
  const provider = await getServerReadProvider(numericChainId);

  try {
    const direct = await verifyCampaignIdentity({ provider, campaignAddress: submittedAddress });
    return { ...direct, submittedAddress, source: "campaign_contract" };
  } catch {
    // Token-based routes and stale callers intentionally fall through to DB resolution.
  }

  const result = await pool.query(
    `with candidates as (
       select 0 as priority, campaign_address, token_address
         from public.campaigns
        where chain_id = $1
          and (lower(campaign_address) = lower($2) or lower(token_address) = lower($2))
       union all
       select 1 as priority, campaign_address, token_address
         from public.campaign_drafts
        where chain_id = $1
          and archived_at is null
          and campaign_address is not null
          and (lower(campaign_address) = lower($2) or lower(token_address) = lower($2))
     )
     select campaign_address, token_address
       from candidates
      order by priority asc
      limit 1`,
    [numericChainId, submittedAddress],
  );

  const row = result.rows[0] || null;
  const canonicalCampaign = normalizeAddress(row?.campaign_address);
  const expectedToken = normalizeAddress(row?.token_address);
  if (!canonicalCampaign) {
    throw new Error("No canonical LaunchCampaign mapping exists for the submitted token address.");
  }

  const verified = await verifyCampaignIdentity({
    provider,
    campaignAddress: canonicalCampaign,
    expectedTokenAddress: expectedToken || (submittedAddress.toLowerCase() === canonicalCampaign.toLowerCase() ? "" : submittedAddress),
  });
  return { ...verified, submittedAddress, source: "database_mapping" };
}

export function isCreatorBuyAction(action) {
  const normalized = Number(action);
  return normalized === BUY_EXACT_TOKENS_ACTION || normalized === BUY_EXACT_BNB_ACTION;
}

export function requestedCreatorBuyWei({ action, amount, limit }) {
  if (Number(action) === BUY_EXACT_TOKENS_ACTION) return BigInt(limit ?? 0);
  if (Number(action) === BUY_EXACT_BNB_ACTION) return BigInt(amount ?? 0);
  return 0n;
}

async function readOnchainCreatorProtection({ chainId, campaignAddress, walletAddress }) {
  if (!getRpcUrls(chainId).length) throw new Error("RPC URL is not configured for creator-cluster protection.");

  const provider = await getServerReadProvider(chainId);
  const campaign = new ethers.Contract(campaignAddress, CAMPAIGN_PROTECTION_ABI, provider);
  const [creatorRaw, lockUntilRaw, capWeiRaw, boughtWeiRaw, riskRegistryRaw, launchAtRaw] = await Promise.all([
    campaign.creator(),
    campaign.creatorBuyLockUntil(),
    campaign.creatorBuyCapWei(),
    campaign.creatorBoughtWei(),
    campaign.riskRegistry(),
    campaign.launchAt(),
  ]);

  const creator = normalizeAddress(creatorRaw);
  if (!creator) throw new Error("Campaign returned an invalid creator address.");
  const riskRegistry = normalizeAddress(riskRegistryRaw);
  let buyerClusterId = null;
  let creatorClusterId = null;

  const directCreator = normalizeAddress(walletAddress).toLowerCase() === creator.toLowerCase();
  if (riskRegistry && !directCreator) {
    const registry = new ethers.Contract(riskRegistry, RISK_REGISTRY_ABI, provider);
    const [buyerRisk, creatorRisk] = await Promise.all([
      registry.getWalletRisk(walletAddress),
      registry.getWalletRisk(creator),
    ]);
    buyerClusterId = normalizeClusterId(buyerRisk.clusterId ?? buyerRisk[2]);
    creatorClusterId = normalizeClusterId(creatorRisk.clusterId ?? creatorRisk[2]);
  }

  return {
    creator,
    creatorBuyLockUntil: Number(lockUntilRaw),
    creatorBuyCapWei: BigInt(capWeiRaw).toString(),
    creatorBoughtWei: BigInt(boughtWeiRaw).toString(),
    launchAt: Number(launchAtRaw),
    riskRegistry: riskRegistry || null,
    buyerClusterId,
    creatorClusterId,
  };
}

function normalizeCurrentTimeCopy(preflight) {
  const cooldownEndsAt = preflight?.creator?.cooldownEndsAt || null;
  const reasons = Array.isArray(preflight?.reasons)
    ? preflight.reasons.map((reason) => {
        const text = String(reason || "");
        if (!text.startsWith("Creator launch cooldown remains active")) return text;
        const suffix = cooldownEndsAt ? ` You may deploy or arm another campaign after ${cooldownEndsAt}.` : "";
        return `This creator wallet cannot arm another campaign yet.${suffix} The selected trading-open time does not affect this cooldown.`;
      })
    : [];

  const onChainLiveCampaignCount = Number(preflight?.creator?.liveBondingCount || 0);
  const onChainLiveCampaignLimit = Number(preflight?.rules?.maxLiveBonding || 0);

  return {
    ...preflight,
    reasons,
    evaluationAt: new Date().toISOString(),
    cooldownEndsAt,
    canArmNow: reasons.length === 0 && Boolean(preflight?.allowed),
    onChainLiveCampaignCount,
    onChainLiveCampaignLimit,
    offChainReservationCount: null,
    offChainReservationLimit: null,
  };
}

export async function evaluateCreatePreflight({ walletAddress }) {
  const preflight = await legacySecurity.evaluateCreatePreflight({ walletAddress });
  return normalizeCurrentTimeCopy(preflight);
}

export async function evaluateTradePreflight({ walletAddress, campaignAddress, chainId = 97, action = BUY_EXACT_TOKENS_ACTION }) {
  const wallet = normalizeAddress(walletAddress);
  const submittedCampaign = normalizeAddress(campaignAddress);
  const numericChainId = Number(chainId);

  if (!wallet || !submittedCampaign || ![56, 97].includes(numericChainId)) {
    return legacySecurity.evaluateTradePreflight({ walletAddress, campaignAddress, chainId });
  }

  let resolution;
  try {
    resolution = await resolveCanonicalTradeCampaignAddress({
      chainId: numericChainId,
      campaignAddress: submittedCampaign,
    });
  } catch (error) {
    const base = await legacySecurity.evaluateTradePreflight({
      walletAddress,
      campaignAddress: submittedCampaign,
      chainId: numericChainId,
    });
    return {
      ...base,
      allowed: false,
      code: "TRADE_CAMPAIGN_RESOLUTION_UNAVAILABLE",
      reasons: ["The canonical LaunchCampaign contract could not be verified. Trading authorization was not issued."],
      canonicalCampaignAddress: null,
      submittedCampaignAddress: submittedCampaign,
      campaignResolutionError: String(error?.shortMessage || error?.message || error),
    };
  }

  const campaign = resolution.campaignAddress;
  const legacyBase = await legacySecurity.evaluateTradePreflight({
    walletAddress,
    campaignAddress: campaign,
    chainId: numericChainId,
  });
  const base = {
    ...legacyBase,
    canonicalCampaignAddress: campaign,
    submittedCampaignAddress: submittedCampaign,
    campaignResolutionSource: resolution.source,
  };

  if (!isCreatorBuyAction(action)) return base;

  try {
    const onChain = await readOnchainCreatorProtection({ chainId, campaignAddress: campaign, walletAddress: wallet });
    const directCreator = wallet.toLowerCase() === onChain.creator.toLowerCase();
    let creatorProfile = null;
    try {
      creatorProfile = await legacySecurity.evaluateCreatePreflight({ walletAddress: onChain.creator });
    } catch (error) {
      if (!directCreator) throw error;
      console.warn("[security-current-time] creator profile lookup unavailable; enforcing direct creator lock from chain", error);
    }
    const { tier, tierNumber } = formatTierLabel(creatorProfile?.tier || creatorProfile?.creator?.tier);
    let dbBuyerClusterId = String(base?.walletRisk?.clusterId || base?.cluster?.id || "").trim() || null;
    let dbCreatorClusterId = String(creatorProfile?.creator?.clusterId || creatorProfile?.cluster?.id || "").trim() || null;
    const onChainClusterMatch = Boolean(
      onChain.buyerClusterId &&
      onChain.creatorClusterId &&
      onChain.buyerClusterId === onChain.creatorClusterId,
    );
    let databaseClusterMatch = Boolean(
      dbBuyerClusterId &&
      dbCreatorClusterId &&
      dbBuyerClusterId === dbCreatorClusterId,
    );
    let fundingDetection = null;

    if (!directCreator && !onChainClusterMatch && !databaseClusterMatch) {
      // Soft-fail funding indexer: never block unrelated buyers when the worker/DB is lagging.
      // Still hard-block when funding evidence proves a creator link (even if persist fails — handled below).
      try {
        fundingDetection = await detectDirectCreatorFunding({
          chainId: Number(chainId),
          creatorAddress: onChain.creator,
          walletAddress: wallet,
          launchAt: onChain.launchAt,
        });
      } catch (fundingError) {
        fundingDetection = {
          linked: false,
          available: false,
          funding: null,
          clusterId: null,
          error: String(fundingError?.shortMessage || fundingError?.message || fundingError),
          provider: "rpc_indexer",
        };
      }
      if (fundingDetection?.linked && fundingDetection?.clusterId) {
        dbBuyerClusterId = fundingDetection.clusterId;
        dbCreatorClusterId = fundingDetection.clusterId;
        databaseClusterMatch = true;
      }
    }

    const directFundingMatch = Boolean(fundingDetection?.linked);
    const creatorLinked = directCreator || onChainClusterMatch || databaseClusterMatch || directFundingMatch;
    const lockActive = onChain.creatorBuyLockUntil > Math.floor(Date.now() / 1000);
    const unlockAt = onChain.creatorBuyLockUntil > 0
      ? new Date(onChain.creatorBuyLockUntil * 1000).toISOString()
      : null;
    const relationship = directCreator
      ? "creator"
      : directFundingMatch
        ? "direct_creator_funding"
        : creatorLinked
          ? "confirmed_cluster"
          : null;
    const detectorWarning = !creatorLinked && fundingDetection && !fundingDetection.available
      ? `Direct creator-funding detection is unavailable: ${fundingDetection.error || "unknown explorer error"}`
      : null;

    const protection = {
      code: creatorLinked && lockActive ? (directCreator ? "CREATOR_BUY_LOCKED" : "CREATOR_CLUSTER_BUY_LOCKED") : null,
      creatorWallet: onChain.creator,
      creatorLinked,
      relationship,
      tier,
      tierNumber,
      unlockAt,
      creatorBuyLockUntil: onChain.creatorBuyLockUntil,
      creatorBuyCapWei: onChain.creatorBuyCapWei,
      creatorBoughtWei: onChain.creatorBoughtWei,
      launchAt: onChain.launchAt,
      buyerClusterId: onChain.buyerClusterId || dbBuyerClusterId,
      creatorClusterId: onChain.creatorClusterId || dbCreatorClusterId,
      buyerDatabaseClusterId: dbBuyerClusterId,
      creatorDatabaseClusterId: dbCreatorClusterId,
      directFunding: fundingDetection?.funding || null,
      detectorAvailable: fundingDetection ? Boolean(fundingDetection.available) : creatorClusterFundingDetectorConfigured(),
      source: onChainClusterMatch
        ? "onchain"
        : databaseClusterMatch
          ? directFundingMatch ? "direct_funding" : "database"
          : directFundingMatch
            ? "direct_funding"
            : directCreator
              ? "creator_address"
              : "none",
    };

    if (directFundingMatch && !fundingDetection.available && !lockActive) {
      return {
        ...base,
        allowed: false,
        code: "CREATOR_CLUSTER_CHECK_UNAVAILABLE",
        reasons: ["A direct creator-funding relationship was detected but could not be persisted safely. Trading authorization was not issued."],
        creatorProtection: {
          ...protection,
          code: "CREATOR_CLUSTER_CHECK_UNAVAILABLE",
          error: fundingDetection.error || "Cluster persistence failed.",
        },
      };
    }

    if (!creatorLinked || !lockActive) {
      return {
        ...base,
        warnings: detectorWarning
          ? [...(Array.isArray(base?.warnings) ? base.warnings : []), detectorWarning]
          : base?.warnings || [],
        creatorProtection: protection,
      };
    }

    const reason = directCreator
      ? `Tier ${tierNumber} creators cannot buy their own campaign until ${unlockAt}.`
      : relationship === "direct_creator_funding"
        ? `This wallet received BNB directly from the Tier ${tierNumber} campaign creator and cannot buy this campaign until ${unlockAt}.`
        : `This wallet is linked to the Tier ${tierNumber} campaign creator and cannot buy this campaign until ${unlockAt}.`;

    return {
      ...base,
      allowed: false,
      code: protection.code,
      reasons: [reason, ...(Array.isArray(base?.reasons) ? base.reasons : [])],
      creatorProtection: protection,
    };
  } catch (error) {
    if (isLegacyProtectionInterfaceUnavailable(error)) {
      return {
        ...base,
        warnings: [
          ...(Array.isArray(base?.warnings) ? base.warnings : []),
          "Legacy campaign generation does not expose creator-cluster protection fields.",
        ],
        creatorProtection: {
          code: null,
          creatorLinked: false,
          legacyCampaign: true,
          source: "legacy_campaign",
        },
      };
    }

    console.error("[security-current-time] creator cluster protection check failed", error);
    return {
      ...base,
      allowed: false,
      code: "CREATOR_CLUSTER_CHECK_UNAVAILABLE",
      reasons: ["Creator-cluster protection could not be verified. Trading authorization was not issued."],
      creatorProtection: {
        code: "CREATOR_CLUSTER_CHECK_UNAVAILABLE",
        error: String(error?.shortMessage || error?.message || error),
      },
    };
  }
}

export async function reserveCreatorClusterBuyAuthorization({
  preflight,
  chainId,
  campaignAddress,
  walletAddress,
  action,
  amount,
  limit,
  authorizationDeadline,
}) {
  if (!isCreatorBuyAction(action) || !preflight?.creatorProtection?.creatorLinked) {
    return { allowed: true, reservation: null };
  }

  const protection = preflight.creatorProtection;
  const requestedWei = requestedCreatorBuyWei({ action, amount, limit });
  const capWei = BigInt(protection.creatorBuyCapWei || 0);
  if (requestedWei <= 0n || capWei <= 0n) return { allowed: true, reservation: null };

  const creatorWallet = normalizeAddress(protection.creatorWallet);
  const buyerWallet = normalizeAddress(walletAddress);
  const campaign = normalizeAddress(campaignAddress);
  if (!creatorWallet || !buyerWallet || !campaign) {
    return {
      allowed: false,
      status: 503,
      code: "CREATOR_CLUSTER_CAP_CHECK_UNAVAILABLE",
      error: "Creator-cluster cap protection received invalid campaign or wallet data.",
      creatorProtection: {
        ...protection,
        code: "CREATOR_CLUSTER_CAP_CHECK_UNAVAILABLE",
      },
    };
  }

  const databaseClusterId = String(
    protection.creatorDatabaseClusterId ||
      protection.creatorClusterId ||
      "",
  ).trim();
  const clusterKey = databaseClusterId || `creator:${creatorWallet.toLowerCase()}`;
  let client = null;

  try {
    client = await pool.connect();
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [`${Number(chainId)}:${campaign.toLowerCase()}:${clusterKey}`]);
    await client.query(
      `delete from public.creator_cluster_buy_reservations
        where chain_id = $1
          and lower(campaign_address) = lower($2)
          and cluster_key = $3
          and expires_at <= now()`,
      [Number(chainId), campaign, clusterKey],
    );

    const linkedConfirmedResult = await client.query(
      `select coalesce(sum(
                case when ct.bnb_amount_raw ~ '^[0-9]+$' then ct.bnb_amount_raw::numeric else 0 end
              ), 0)::text as total_wei
         from public.curve_trades ct
         left join public.wallet_risk_profiles wrp
           on lower(wrp.wallet_address) = lower(ct.wallet)
         left join public.cluster_members cm
           on lower(cm.wallet_address) = lower(ct.wallet)
          and cm.cluster_id = $4
        where ct.chain_id = $1
          and lower(ct.campaign_address) = lower($2)
          and lower(ct.side) = 'buy'
          and lower(ct.wallet) <> lower($3)
          and $4 <> ''
          and (wrp.cluster_id = $4 or cm.cluster_id = $4)`,
      [Number(chainId), campaign, creatorWallet, databaseClusterId],
    );

    const reservationResult = await client.query(
      `select coalesce(sum(amount_wei), 0)::text as total_wei
         from public.creator_cluster_buy_reservations
        where chain_id = $1
          and lower(campaign_address) = lower($2)
          and cluster_key = $3
          and expires_at > now()`,
      [Number(chainId), campaign, clusterKey],
    );

    const onchainCreatorWei = BigInt(protection.creatorBoughtWei || 0);
    const linkedConfirmedWei = BigInt(linkedConfirmedResult.rows[0]?.total_wei || 0);
    const confirmedWei = onchainCreatorWei + linkedConfirmedWei;
    const reservedWei = BigInt(reservationResult.rows[0]?.total_wei || 0);
    const nextTotalWei = confirmedWei + reservedWei + requestedWei;
    const remainingBeforeWei = capWei > confirmedWei + reservedWei ? capWei - confirmedWei - reservedWei : 0n;

    if (nextTotalWei > capWei) {
      await client.query("rollback");
      return {
        allowed: false,
        status: 403,
        code: "CREATOR_CLUSTER_BUY_CAP_EXCEEDED",
        error: "This buy would exceed the creator cluster's combined purchase allowance.",
        creatorProtection: {
          ...protection,
          code: "CREATOR_CLUSTER_BUY_CAP_EXCEEDED",
          requestedWei: requestedWei.toString(),
          confirmedWei: confirmedWei.toString(),
          reservedWei: reservedWei.toString(),
          remainingWei: remainingBeforeWei.toString(),
        },
      };
    }

    const expiresAtSeconds = Number(authorizationDeadline) + RESERVATION_GRACE_SECONDS;
    const inserted = await client.query(
      `insert into public.creator_cluster_buy_reservations (
         chain_id,
         campaign_address,
         creator_wallet,
         cluster_key,
         buyer_wallet,
         route_action,
         amount_wei,
         authorization_deadline,
         expires_at
       ) values ($1, $2, $3, $4, $5, $6, $7::numeric, $8, to_timestamp($9))
       returning id::text`,
      [
        Number(chainId),
        campaign,
        creatorWallet,
        clusterKey,
        buyerWallet,
        Number(action),
        requestedWei.toString(),
        Number(authorizationDeadline),
        expiresAtSeconds,
      ],
    );

    await client.query("commit");
    return {
      allowed: true,
      reservation: {
        id: inserted.rows[0]?.id || null,
        clusterKey,
        requestedWei: requestedWei.toString(),
        confirmedWei: confirmedWei.toString(),
        reservedWei: reservedWei.toString(),
        remainingWei: (capWei - nextTotalWei).toString(),
        expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
      },
    };
  } catch (error) {
    if (client) {
      try {
        await client.query("rollback");
      } catch {
        // ignore rollback failures
      }
    }
    console.error("[security-current-time] creator cluster cap reservation failed", error);
    return {
      allowed: false,
      status: 503,
      code: "CREATOR_CLUSTER_CAP_CHECK_UNAVAILABLE",
      error: "Creator-cluster cap protection could not be verified. Trading authorization was not issued.",
      creatorProtection: {
        ...protection,
        code: "CREATOR_CLUSTER_CAP_CHECK_UNAVAILABLE",
        error: String(error?.message || error),
      },
    };
  } finally {
    client?.release();
  }
}

export async function launchpadPreflightCreate(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  const body = await readJson(req);
  const walletAddress = body.walletAddress || body.creatorWallet || body.creator;
  const preflight = await evaluateCreatePreflight({ walletAddress });
  return json(res, preflight.allowed ? 200 : 403, { preflight });
}

export async function launchpadPreflightBuy(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  const body = await readJson(req);
  const preflight = await evaluateTradePreflight({
    walletAddress: body.walletAddress,
    campaignAddress: body.campaignAddress,
    chainId: body.chainId || 97,
    action: BUY_EXACT_TOKENS_ACTION,
  });
  if (preflight.campaign?.buyPaused) {
    preflight.allowed = false;
    preflight.reasons = [...(preflight.reasons || []), "Campaign buys are paused."];
  }
  return json(res, preflight.allowed ? 200 : 403, { preflight });
}

export async function securityCreatorLaunchEligibility(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
  const query = getQuery(req);
  const walletAddress = req.params?.wallet || query.walletAddress;
  const preflight = await evaluateCreatePreflight({ walletAddress });
  return json(res, preflight.allowed ? 200 : 403, { preflight });
}
