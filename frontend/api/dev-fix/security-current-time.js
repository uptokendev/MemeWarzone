import { ethers } from "ethers";
import { pool } from "../../server/db.js";
import { getQuery, json, readJson } from "../../server/http.js";
import { getRpcUrls, getServerReadProvider } from "../lib/getServerReadProvider.js";
import { CREATE_CANARY_CODE, CREATE_CANARY_MESSAGE, createCanaryRefusalBody, isCreateAllowedForWallet } from "../lib/createCanary.js";
import { creatorClusterFundingDetectorConfigured } from "./creator-cluster-detector.js";
import * as legacySecurity from "./security.js";

export * from "./security.js";
export { creatorClusterFundingDetectorConfigured };

const CAMPAIGN_PROTECTION_ABI = [
  "function token() view returns (address)",
  "function creator() view returns (address)",
  "function creatorBuyLockUntil() view returns (uint256)",
  "function creatorBuyCapWei() view returns (uint256)",
  "function creatorBoughtWei() view returns (uint256)",
  "function launchAt() view returns (uint64)",
];
// Generation 5 campaigns (docs/evm-launch C4) have no creator buy lock: a creator buy is escrowed
// (20% at 30 days, then 20% every 7 days). currentTradeFeeBps (C2) exists only on generation 5.
const GEN5_CAMPAIGN_PROBE_ABI = ["function currentTradeFeeBps() view returns (uint256)"];

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

/**
 * The creator buy lock, or on a generation 5 campaign the escrow that replaced it (lock 0, the cap
 * stays). Anything else that lacks creatorBuyLockUntil rethrows the original error, so the older
 * legacy-interface handling below is unchanged.
 */
export async function readCreatorBuyLock(campaign, campaignAddress, provider) {
  try {
    return { lockUntil: await campaign.creatorBuyLockUntil(), escrow: false };
  } catch (error) {
    // An unknown selector on the generation 5 implementation reverts with no data.
    const emptyRevert = error?.code === "CALL_EXCEPTION" && (!error?.data || error.data === "0x");
    if (!emptyRevert && !isLegacyProtectionInterfaceUnavailable(error)) throw error;
    try {
      await new ethers.Contract(campaignAddress, GEN5_CAMPAIGN_PROBE_ABI, provider).currentTradeFeeBps();
    } catch {
      throw error;
    }
    return { lockUntil: 0n, escrow: true };
  }
}

async function readOnchainCreatorProtection({ chainId, campaignAddress }) {
  if (!getRpcUrls(chainId).length) throw new Error("RPC URL is not configured for the creator buy lock.");

  const provider = await getServerReadProvider(chainId);
  const campaign = new ethers.Contract(campaignAddress, CAMPAIGN_PROTECTION_ABI, provider);
  // BNB no longer applies wallet-cluster or direct-funding links. Only the creator
  // wallet itself is locked, and only for that wallet's own buy cap.
  const [creatorRaw, lockRead, capWeiRaw, boughtWeiRaw, launchAtRaw] = await Promise.all([
    campaign.creator(),
    readCreatorBuyLock(campaign, campaignAddress, provider),
    campaign.creatorBuyCapWei(),
    campaign.creatorBoughtWei(),
    campaign.launchAt(),
  ]);
  const lockUntilRaw = lockRead.lockUntil;

  const creator = normalizeAddress(creatorRaw);
  if (!creator) throw new Error("Campaign returned an invalid creator address.");

  return {
    creator,
    creatorBuyEscrow: lockRead.escrow,
    creatorBuyLockUntil: Number(lockUntilRaw),
    creatorBuyCapWei: BigInt(capWeiRaw).toString(),
    creatorBoughtWei: BigInt(boughtWeiRaw).toString(),
    launchAt: Number(launchAtRaw),
    riskRegistry: null,
    buyerClusterId: null,
    creatorClusterId: null,
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

export async function evaluateCreatePreflight({ walletAddress, chainId = null }) {
  const preflight = await legacySecurity.evaluateCreatePreflight({ walletAddress, chainId });
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
    const onChain = await readOnchainCreatorProtection({ chainId, campaignAddress: campaign });
    const directCreator = wallet.toLowerCase() === onChain.creator.toLowerCase();
    let creatorProfile = null;
    try {
      creatorProfile = await legacySecurity.evaluateCreatePreflight({ walletAddress: onChain.creator });
    } catch (error) {
      if (!directCreator) throw error;
      console.warn("[security-current-time] creator profile lookup unavailable; enforcing direct creator lock from chain", error);
    }
    const { tier, tierNumber } = formatTierLabel(creatorProfile?.tier || creatorProfile?.creator?.tier);
    const lockActive = onChain.creatorBuyLockUntil > Math.floor(Date.now() / 1000);
    const unlockAt = onChain.creatorBuyLockUntil > 0
      ? new Date(onChain.creatorBuyLockUntil * 1000).toISOString()
      : null;
    const protection = {
      code: directCreator && lockActive ? "CREATOR_BUY_LOCKED" : null,
      creatorWallet: onChain.creator,
      creatorLinked: directCreator,
      relationship: directCreator ? "creator" : null,
      tier,
      tierNumber,
      unlockAt,
      creatorBuyLockUntil: onChain.creatorBuyLockUntil,
      // Generation 5: the creator's own buys land in the campaign's escrow, not the wallet (C4).
      creatorBuyEscrow: Boolean(onChain.creatorBuyEscrow),
      creatorBuyCapWei: onChain.creatorBuyCapWei,
      creatorBoughtWei: onChain.creatorBoughtWei,
      launchAt: onChain.launchAt,
      buyerClusterId: null,
      creatorClusterId: null,
      buyerDatabaseClusterId: null,
      creatorDatabaseClusterId: null,
      directFunding: null,
      detectorAvailable: false,
      source: directCreator ? "creator_address" : "none",
    };

    if (!directCreator || !lockActive) {
      return { ...base, creatorProtection: protection };
    }

    return {
      ...base,
      allowed: false,
      code: protection.code,
      reasons: [
        `Tier ${tierNumber} creators cannot buy their own campaign until ${unlockAt}.`,
        ...(Array.isArray(base?.reasons) ? base.reasons : []),
      ],
      creatorProtection: protection,
    };
  } catch (error) {
    if (isLegacyProtectionInterfaceUnavailable(error)) {
      return {
        ...base,
        warnings: [
          ...(Array.isArray(base?.warnings) ? base.warnings : []),
          "Legacy campaign generation does not expose the creator buy lock.",
        ],
        creatorProtection: {
          code: null,
          creatorLinked: false,
          legacyCampaign: true,
          source: "legacy_campaign",
        },
      };
    }

    console.error("[security-current-time] creator buy lock check failed", error);
    return {
      ...base,
      allowed: false,
      code: "CREATOR_CLUSTER_CHECK_UNAVAILABLE",
      reasons: ["The creator buy lock could not be verified. Trading authorization was not issued."],
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
      error: "Creator buy cap protection received invalid campaign or wallet data.",
      creatorProtection: {
        ...protection,
        code: "CREATOR_CLUSTER_CAP_CHECK_UNAVAILABLE",
      },
    };
  }

  // The reservation row still uses cluster_key. It is only this creator wallet.
  const clusterKey = `creator:${creatorWallet.toLowerCase()}`;
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

    const reservationResult = await client.query(
      `select coalesce(sum(amount_wei), 0)::text as total_wei
         from public.creator_cluster_buy_reservations
        where chain_id = $1
          and lower(campaign_address) = lower($2)
          and cluster_key = $3
          and expires_at > now()`,
      [Number(chainId), campaign, clusterKey],
    );

    const confirmedWei = BigInt(protection.creatorBoughtWei || 0);
    const reservedWei = BigInt(reservationResult.rows[0]?.total_wei || 0);
    const nextTotalWei = confirmedWei + reservedWei + requestedWei;
    const remainingBeforeWei = capWei > confirmedWei + reservedWei ? capWei - confirmedWei - reservedWei : 0n;

    if (nextTotalWei > capWei) {
      await client.query("rollback");
      return {
        allowed: false,
        status: 403,
        code: "CREATOR_CLUSTER_BUY_CAP_EXCEEDED",
        error: "This buy would exceed the creator wallet's purchase allowance.",
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
    console.error("[security-current-time] creator buy cap reservation failed", error);
    return {
      allowed: false,
      status: 503,
      code: "CREATOR_CLUSTER_CAP_CHECK_UNAVAILABLE",
      error: "The creator buy cap could not be verified. Trading authorization was not issued.",
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
  if (!isCreateAllowedForWallet(walletAddress)) {
    return json(res, 403, {
      ...createCanaryRefusalBody(),
      preflight: { allowed: false, reasons: [CREATE_CANARY_MESSAGE], code: CREATE_CANARY_CODE },
    });
  }
  const preflight = await evaluateCreatePreflight({ walletAddress, chainId: body.chainId ?? null });
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
  const preflight = await evaluateCreatePreflight({ walletAddress, chainId: query.chainId ?? null });
  return json(res, preflight.allowed ? 200 : 403, { preflight });
}
