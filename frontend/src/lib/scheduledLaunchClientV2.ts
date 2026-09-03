import { Contract, ethers, type JsonRpcSigner } from "ethers";
import { apiFetch } from "@/lib/apiBase";
import { normalizeCreatorArmCooldownEndsAt } from "@/lib/creatorArmCooldown";
import type { DraftActionAuth } from "@/lib/draftAuth";

const SCHEDULED_FACTORY_ABI = [
  "function live() view returns (bool)",
  "function globalPaused() view returns (bool)",
  "function createPaused() view returns (bool)",
  "function creatorRegistry() view returns (address)",
  "function FACTORY_GENERATION() view returns (uint32)",
  "function CAMPAIGN_GENERATION() view returns (uint32)",
  "function creatorLaunchEligibility(address creator) view returns (bool allowed,uint256 cooldownEndsAt,uint256 currentLiveCount,uint256 maxLiveBonding)",
  "function createScheduledCampaignAuthorized(((string name,string symbol,string logoURI,string xAccount,string website,string extraLink,uint256 graduationTarget) campaign,uint64 launchAt,bytes32 draftReferenceHash,bytes32 normalizedTickerHash,bytes32 metadataHash,uint64 reservationVersion,uint256 authorizationNonce) req,(uint8 tradeRouteProfile,uint8 finalizeRouteProfile,uint64 deadline,bytes signature) routeAuth) returns (address campaignAddr,address tokenAddr)",
  "event CampaignCreated(uint256 indexed id,address indexed campaign,address indexed token,address creator,string name,string symbol,string logoURI,string metadataURI)",
  "error NotLive()",
  "error Paused()",
  "error CreatePaused()",
  "error CreatorNotEligible()",
  "error RiskNotEligible()",
  "error RouteAuthorityZero()",
  "error RouteAuthorizationExpired()",
  "error InvalidRouteAuthorization()",
  "error RouteAuthorizationReplayed()",
  "error InvalidLaunchAt()",
  "error LaunchAtTooFar()",
  "error MissingDraftReference()",
  "error MissingTickerHash()",
  "error MissingMetadataHash()",
  "error InvalidReservationVersion()",
  "error InvalidAuthorizationNonce()",
  "error UnsupportedGraduationTarget()",
] as const;

const CREATOR_REGISTRY_ABI = [
  "function canLaunch(address) view returns (bool)",
  "function getCreatorProfile(address) view returns (uint8 tier,uint256 trustScore,uint256 liveBondingCount,uint256 lastLaunchTimestamp,bool restricted,bool manualReviewRequired)",
  "function getCreatorRules(address) view returns (uint256 maxLiveBonding,uint256 cooldownSeconds,uint256 creatorBuyLockSeconds,uint256 creatorBuyCapWei,uint256 maxClusterWallets)",
] as const;

const FACTORY_INTERFACE = new ethers.Interface(SCHEDULED_FACTORY_ABI);
const EXPECTED_CAMPAIGN_GENERATION = 2;
const ROBINHOOD_CHAIN_IDS = new Set([4663, 46630]);

function isSupportedFactoryGeneration(chainId: number, generation: number): boolean {
  if (ROBINHOOD_CHAIN_IDS.has(Number(chainId))) return generation === 4;
  // Existing BNB factories are generation 3. Generation 4 remains acceptable for
  // a future BNB factory built from the liquidity-kind-aware source.
  return generation === 3 || generation === 4;
}

function assertSupportedGeneration(chainId: number, factoryGeneration: number, campaignGeneration: number) {
  if (!isSupportedFactoryGeneration(chainId, factoryGeneration) || campaignGeneration !== EXPECTED_CAMPAIGN_GENERATION) {
    const factoryRule = ROBINHOOD_CHAIN_IDS.has(Number(chainId)) ? "4" : "3 or 4";
    throw new Error(
      `The configured factory is generation ${factoryGeneration}/${campaignGeneration}; ` +
        `chain ${chainId} requires factory generation ${factoryRule} and campaign generation ${EXPECTED_CAMPAIGN_GENERATION}.`,
    );
  }
}

async function parseApiJson(res: Response) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(json?.error || json?.message || `Request failed (${res.status})`));
  return json;
}

function extractCreated(receipt: any) {
  for (const log of receipt?.logs || []) {
    try {
      const parsed = FACTORY_INTERFACE.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "CampaignCreated") {
        return {
          campaignAddress: String(parsed.args?.campaign || ""),
          tokenAddress: String(parsed.args?.token || ""),
        };
      }
    } catch {}
  }
  return { campaignAddress: "", tokenAddress: "" };
}

function errorData(error: any): string {
  const candidates = [
    error?.data,
    error?.revert?.data,
    error?.info?.error?.data,
    error?.info?.error?.data?.data,
    error?.error?.data,
    error?.cause?.data,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.startsWith("0x")) return candidate;
    if (candidate && typeof candidate === "object") {
      for (const key of ["data", "result", "return"]) {
        const nested = candidate[key];
        if (typeof nested === "string" && nested.startsWith("0x")) return nested;
      }
    }
  }
  return "";
}

function errorName(error: any) {
  const direct = String(error?.revert?.name || error?.errorName || "").trim();
  if (direct) return direct;
  const data = errorData(error);
  if (!data) return "";
  try {
    return String(FACTORY_INTERFACE.parseError(data)?.name || "");
  } catch {
    return "";
  }
}

function friendlyFactoryError(error: any) {
  const name = errorName(error);
  const messages: Record<string, string> = {
    NotLive: "The corrected LaunchFactory is not live.",
    Paused: "Scheduled deployment is paused by the factory.",
    CreatePaused: "New campaign creation is currently paused.",
    CreatorNotEligible: "This creator wallet cannot deploy or arm another campaign yet. The selected trading-open time does not affect the cooldown.",
    RiskNotEligible: "The creator wallet is blocked by the on-chain risk rules.",
    RouteAuthorityZero: "The scheduled factory route authority is not configured.",
    RouteAuthorizationExpired: "The scheduled deployment authorization expired. Try again.",
    InvalidRouteAuthorization: "The scheduled route authorization does not match this factory generation. Refresh and try again.",
    RouteAuthorizationReplayed: "This scheduled deployment authorization was already used. Refresh and try again.",
    InvalidLaunchAt: "Choose a trading-open time at least five minutes in the future.",
    LaunchAtTooFar: "The selected trading-open time is more than 30 days away.",
    UnsupportedGraduationTarget: "The selected graduation tier is not allowed by this factory.",
  };
  return messages[name] || String(error?.shortMessage || error?.reason || error?.message || "Scheduled deployment failed.");
}

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  } catch {
    return "local time";
  }
}

function formatLocalTimestamp(seconds: number) {
  return `${new Date(seconds * 1000).toLocaleString()} (${browserTimeZone()})`;
}

export type ScheduledCreatorLaunchEligibility = {
  allowed: boolean;
  canArmNow: boolean;
  cooldownEndsAt: number;
  currentLiveCount: number;
  maxLiveBonding: number;
  cooldownSeconds: number;
  lastRecordedLaunchAt: number;
  restricted: boolean;
  manualReviewRequired: boolean;
  factoryGeneration: number;
  campaignGeneration: number;
};

export async function readScheduledCreatorLaunchEligibility(input: {
  signer: JsonRpcSigner;
  chainId: number;
  factoryAddress: string;
}): Promise<ScheduledCreatorLaunchEligibility> {
  const provider = input.signer.provider;
  if (!provider) throw new Error("Wallet provider is unavailable.");
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== Number(input.chainId)) {
    throw new Error("Wallet network changed. Switch back to the draft chain and try again.");
  }
  const code = await provider.getCode(input.factoryAddress);
  if (!code || code === "0x") throw new Error("The configured scheduled factory has no contract code.");

  const factory = new Contract(input.factoryAddress, SCHEDULED_FACTORY_ABI, provider) as any;
  try {
    const creator = await input.signer.getAddress();
    const [result, registryAddressRaw, factoryGenerationRaw, campaignGenerationRaw] = await Promise.all([
      factory.creatorLaunchEligibility(creator),
      factory.creatorRegistry(),
      factory.FACTORY_GENERATION(),
      factory.CAMPAIGN_GENERATION(),
    ]);

    const factoryGeneration = Number(factoryGenerationRaw ?? 0);
    const campaignGeneration = Number(campaignGenerationRaw ?? 0);
    assertSupportedGeneration(input.chainId, factoryGeneration, campaignGeneration);

    let cooldownSeconds = 0;
    let lastRecordedLaunchAt = 0;
    let restricted = false;
    let manualReviewRequired = false;
    const registryAddress = String(registryAddressRaw || "");
    if (ethers.isAddress(registryAddress) && registryAddress !== ethers.ZeroAddress) {
      const registry = new Contract(registryAddress, CREATOR_REGISTRY_ABI, provider) as any;
      const [profile, rules] = await Promise.all([
        registry.getCreatorProfile(creator),
        registry.getCreatorRules(creator),
      ]);
      lastRecordedLaunchAt = Number(profile[3] ?? profile.lastLaunchTimestamp ?? 0);
      restricted = Boolean(profile[4] ?? profile.restricted);
      manualReviewRequired = Boolean(profile[5] ?? profile.manualReviewRequired);
      cooldownSeconds = Number(rules[1] ?? rules.cooldownSeconds ?? 0);
    }

    const allowed = result[0] === true || result.allowed === true;
    const cooldownEndsAt = normalizeCreatorArmCooldownEndsAt({
      allowed,
      lastRecordedLaunchAt,
      cooldownSeconds,
      cooldownEndsAt: Number(result.cooldownEndsAt ?? result[1] ?? 0),
    });
    return {
      allowed,
      canArmNow: allowed,
      cooldownEndsAt,
      currentLiveCount: Number(result.currentLiveCount ?? result[2] ?? 0),
      maxLiveBonding: Number(result.maxLiveBonding ?? result[3] ?? 0),
      cooldownSeconds,
      lastRecordedLaunchAt,
      restricted,
      manualReviewRequired,
      factoryGeneration,
      campaignGeneration,
    };
  } catch (error: any) {
    const text = String(error?.shortMessage || error?.message || error || "");
    if (text.toLowerCase().includes("could not decode") || text.toLowerCase().includes("no data present")) {
      throw new Error("The configured creation factory still uses the obsolete scheduled-slot model. New deployments are blocked until the corrected factory is active.");
    }
    throw error;
  }
}

async function assertScheduledFactoryReady(input: {
  signer: JsonRpcSigner;
  chainId: number;
  factoryAddress: string;
  launchAt: number;
}) {
  const provider = input.signer.provider;
  if (!provider) throw new Error("Wallet provider is unavailable.");
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== Number(input.chainId)) {
    throw new Error("Wallet network changed. Switch back to the draft chain and try again.");
  }
  const code = await provider.getCode(input.factoryAddress);
  if (!code || code === "0x") throw new Error("The configured scheduled factory has no contract code.");

  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(input.launchAt) || input.launchAt < now + 5 * 60) {
    throw new Error("Choose a trading-open time at least five minutes in the future.");
  }
  if (input.launchAt > now + 30 * 24 * 60 * 60) {
    throw new Error("The selected trading-open time is more than 30 days away.");
  }

  const factory = new Contract(input.factoryAddress, SCHEDULED_FACTORY_ABI, input.signer) as any;
  const [live, globalPaused, createPaused] = await Promise.all([
    factory.live(),
    factory.globalPaused(),
    factory.createPaused(),
  ]);
  if (!live) throw new Error("The corrected LaunchFactory is not live.");
  if (globalPaused) throw new Error("Scheduled deployment is paused by the factory.");
  if (createPaused) throw new Error("New campaign creation is currently paused.");

  const eligibility = await readScheduledCreatorLaunchEligibility({
    signer: input.signer,
    chainId: input.chainId,
    factoryAddress: input.factoryAddress,
  });
  if (!eligibility.allowed) {
    if (eligibility.restricted) throw new Error("This creator wallet is restricted by the on-chain CreatorRegistry.");
    if (eligibility.manualReviewRequired) throw new Error("This creator wallet requires manual review before another launch.");
    if (eligibility.currentLiveCount >= eligibility.maxLiveBonding) {
      throw new Error(
        `Live campaign limit reached (${eligibility.currentLiveCount}/${eligibility.maxLiveBonding}). ` +
          "Graduate an existing live campaign before arming another. Tier 1 max is 3 concurrent live campaigns (including timed arms not yet trading).",
      );
    }
    if (eligibility.lastRecordedLaunchAt > 0 && eligibility.cooldownEndsAt > now) {
      throw new Error(
        `Creator arm cooldown active until ${formatLocalTimestamp(eligibility.cooldownEndsAt)}. ` +
          "Immediate and timed arms both require 24 hours between on-chain deploys. " +
          "A later trading-open time does not bypass this. You can prepare multiple drafts now; arm them one per day.",
      );
    }
    throw new Error("This creator wallet cannot deploy or arm another campaign right now.");
  }

  return { factory, eligibility };
}

export async function deployScheduledDraftCampaignV2(input: {
  signer: JsonRpcSigner;
  auth: DraftActionAuth;
  chainId: number;
  factoryAddress: string;
  draftId: string;
  launchAt: number;
  graduationTargetWei: bigint;
}) {
  const { factory, eligibility } = await assertScheduledFactoryReady(input);
  const response = await apiFetch(`/api/drafts/${encodeURIComponent(input.draftId)}/deploy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operation: "authorize_scheduled",
      auth: input.auth,
      chainId: input.chainId,
      factoryAddress: input.factoryAddress,
      launchAt: input.launchAt,
      graduationTargetWei: input.graduationTargetWei.toString(),
    }),
  });
  const json = await parseApiJson(response);
  const scheduledRequest = json.scheduledRequest;
  const authorization = json.authorization;
  if (!scheduledRequest || !authorization) throw new Error("Scheduled launch authorization response is incomplete.");
  if (Number(authorization.factoryGeneration || 0) !== eligibility.factoryGeneration) {
    throw new Error(
      `The server returned factory generation ${Number(authorization.factoryGeneration || 0)}, ` +
        `but the configured factory reports ${eligibility.factoryGeneration}.`,
    );
  }
  if (Number(authorization.campaignGeneration || 0) !== eligibility.campaignGeneration) {
    throw new Error(
      `The server returned campaign generation ${Number(authorization.campaignGeneration || 0)}, ` +
        `but the configured factory reports ${eligibility.campaignGeneration}.`,
    );
  }

  const request = {
    campaign: {
      ...scheduledRequest.campaign,
      graduationTarget: BigInt(scheduledRequest.campaign.graduationTarget),
    },
    launchAt: Number(scheduledRequest.launchAt),
    draftReferenceHash: scheduledRequest.draftReferenceHash,
    normalizedTickerHash: scheduledRequest.normalizedTickerHash,
    metadataHash: scheduledRequest.metadataHash,
    reservationVersion: Number(scheduledRequest.reservationVersion),
    authorizationNonce: BigInt(scheduledRequest.authorizationNonce),
  };
  const routeAuth = {
    tradeRouteProfile: Number(authorization.tradeRouteProfileId),
    finalizeRouteProfile: Number(authorization.finalizeRouteProfileId),
    deadline: Math.floor(new Date(authorization.validUntil).getTime() / 1000),
    signature: authorization.signature,
  };

  try {
    await factory.createScheduledCampaignAuthorized.staticCall(request, routeAuth);
    const tx = await factory.createScheduledCampaignAuthorized(request, routeAuth);
    const receipt = await tx.wait();
    return { receipt, txHash: String(receipt?.hash || tx.hash || ""), ...extractCreated(receipt) };
  } catch (error: any) {
    throw new Error(friendlyFactoryError(error));
  }
}
