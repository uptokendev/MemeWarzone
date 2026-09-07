import { ethers } from "ethers";

import { getServerReadProvider } from "../lib/getServerReadProvider.js";
import { getGraduationQuoteAssetDetail } from "../lib/quoteAssetCatalog.js";
import { buildBnbBasicQuoteCatalogBinding } from "../lib/bnbBasicQuoteCatalogBinding.js";
import {
  BNB_BASIC_FACTORY_GENERATION,
  BNB_BASIC_CAMPAIGN_GENERATION,
  signBnbBasicQuoteAuthorization,
} from "./routeAuthorizationSigner.js";

export const BNB_MAINNET_CHAIN_ID = 56;

const BNB_BASIC_FACTORY_ABI = [
  "function routeAuthority() view returns (address)",
  "function live() view returns (bool)",
  "function globalPaused() view returns (bool)",
  "function createPaused() view returns (bool)",
  "function creatorLaunchEligibility(address creator) view returns (bool allowed,uint256 cooldownEndsAt,uint256 currentLiveCount,uint256 maxLiveBonding)",
  "function bnbQuoteGraduationAdapter() view returns (address)",
  "function bnbQuoteCampaignImplementation() view returns (address)",
  "function BASIC_FACTORY_GENERATION() view returns (uint32)",
  "function BASIC_QUOTE_CAMPAIGN_GENERATION() view returns (uint32)",
];

function requiredCatalogId(value) {
  const id = String(value || "").trim();
  if (!id) throw new Error("graduationQuoteAssetId is required for BNB BASIC quote creation");
  return id;
}

function assertBnbBasicCatalogAuthority(item) {
  if (!item) throw new Error("Approved quote catalog deployment was not found");
  if (String(item.chainId) !== String(BNB_MAINNET_CHAIN_ID)) {
    throw new Error("Approved quote deployment is not on BNB Chain mainnet");
  }
  if (item.newGraduationEligible !== true) {
    throw new Error("Approved quote deployment is not currently eligible for new graduation");
  }
  if (String(item.identityStatus || "").toLowerCase() !== "verified") {
    throw new Error("Approved quote deployment identity is not verified");
  }
  if (String(item.securityStatus || "").toLowerCase() !== "verified") {
    throw new Error("Approved quote deployment security is not verified");
  }
  if (String(item.marketHealthStatus || "").toLowerCase() !== "healthy") {
    throw new Error("Approved quote deployment market health is not healthy");
  }
  if (!item.policy?.active || !item.policy?.basicApproved || !item.policy?.newGraduationEnabled) {
    throw new Error("Approved quote deployment policy is not active for new graduation");
  }
  return item;
}

async function readBnbBasicFactory({ chainId, factoryAddress }) {
  const provider = await getServerReadProvider(chainId);
  const code = await provider.getCode(factoryAddress);
  if (!code || code === "0x") throw new Error("BNB BASIC factory contract code is missing");
  return new ethers.Contract(factoryAddress, BNB_BASIC_FACTORY_ABI, provider);
}

async function readBnbBasicFactoryBinding({ chainId, factoryAddress }) {
  const factory = await readBnbBasicFactory({ chainId, factoryAddress });
  const [adapterRaw, implementationRaw, factoryGenerationRaw, campaignGenerationRaw] = await Promise.all([
    factory.bnbQuoteGraduationAdapter(),
    factory.bnbQuoteCampaignImplementation(),
    factory.BASIC_FACTORY_GENERATION(),
    factory.BASIC_QUOTE_CAMPAIGN_GENERATION(),
  ]);

  const adapter = ethers.getAddress(adapterRaw);
  const campaignImplementation = ethers.getAddress(implementationRaw);
  const factoryGeneration = Number(factoryGenerationRaw);
  const campaignGeneration = Number(campaignGenerationRaw);

  if (adapter === ethers.ZeroAddress || campaignImplementation === ethers.ZeroAddress) {
    throw new Error("BNB BASIC quote factory is not fully wired");
  }
  if (factoryGeneration !== BNB_BASIC_FACTORY_GENERATION || campaignGeneration !== BNB_BASIC_CAMPAIGN_GENERATION) {
    throw new Error(
      `BNB BASIC quote generation mismatch: expected ${BNB_BASIC_FACTORY_GENERATION}/${BNB_BASIC_CAMPAIGN_GENERATION}, got ${factoryGeneration}/${campaignGeneration}`,
    );
  }
  return { adapter, campaignImplementation, factoryGeneration, campaignGeneration };
}

export async function readBnbBasicCreationPreflight({ chainId, factoryAddress, walletAddress }) {
  if (Number(chainId) !== BNB_MAINNET_CHAIN_ID) {
    return { ok: false, status: 409, code: "BNB_BASIC_CHAIN_MISMATCH", error: "BNB BASIC approved quote creation is only valid on BNB Chain mainnet" };
  }
  try {
    const factory = await readBnbBasicFactory({ chainId, factoryAddress });
    const [live, globalPaused, createPaused, eligibility, routeAuthority, factoryGenerationRaw, campaignGenerationRaw] = await Promise.all([
      factory.live(),
      factory.globalPaused(),
      factory.createPaused(),
      factory.creatorLaunchEligibility(walletAddress),
      factory.routeAuthority(),
      factory.BASIC_FACTORY_GENERATION(),
      factory.BASIC_QUOTE_CAMPAIGN_GENERATION(),
    ]);
    const factoryGeneration = Number(factoryGenerationRaw);
    const campaignGeneration = Number(campaignGenerationRaw);
    if (factoryGeneration !== BNB_BASIC_FACTORY_GENERATION || campaignGeneration !== BNB_BASIC_CAMPAIGN_GENERATION) {
      return {
        ok: false,
        status: 409,
        code: "BNB_BASIC_FACTORY_GENERATION_MISMATCH",
        error: `BNB BASIC creation requires factory/campaign generation ${BNB_BASIC_FACTORY_GENERATION}/${BNB_BASIC_CAMPAIGN_GENERATION}; configured factory reports ${factoryGeneration}/${campaignGeneration}.`,
      };
    }
    if (!live || globalPaused || createPaused) {
      return {
        ok: false,
        status: 503,
        code: "BNB_BASIC_FACTORY_NOT_READY",
        error: !live ? "The BNB BASIC creation factory is not live." : globalPaused ? "The BNB BASIC creation factory is globally paused." : "BNB BASIC campaign creation is paused.",
      };
    }
    const allowed = eligibility[0] === true || eligibility.allowed === true;
    const cooldownEndsAt = Number(eligibility.cooldownEndsAt ?? eligibility[1] ?? 0);
    const onChainLiveCampaignCount = Number(eligibility.currentLiveCount ?? eligibility[2] ?? 0);
    const onChainLiveCampaignLimit = Number(eligibility.maxLiveBonding ?? eligibility[3] ?? 0);
    if (!allowed) {
      return {
        ok: false,
        status: 403,
        code: "BNB_BASIC_CREATOR_NOT_ELIGIBLE",
        error: onChainLiveCampaignCount >= onChainLiveCampaignLimit
          ? `Live campaign limit reached (${onChainLiveCampaignCount}/${onChainLiveCampaignLimit}).`
          : cooldownEndsAt > Math.floor(Date.now() / 1000)
            ? `Creator arm cooldown active until ${new Date(cooldownEndsAt * 1000).toISOString()}.`
            : "This creator wallet cannot deploy another BNB BASIC campaign right now.",
      };
    }
    return {
      ok: true,
      onChain: {
        allowed,
        canArmNow: true,
        cooldownEndsAt,
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
      code: "BNB_BASIC_ONCHAIN_PREFLIGHT_FAILED",
      error: `BNB BASIC on-chain creation eligibility could not be verified: ${String(error?.shortMessage || error?.message || error)}`,
    };
  }
}

/** Resolve/sign one BNB BASIC quote creation from server-side catalog authority. */
export async function prepareBnbBasicQuoteCreateAuthorization({
  signer,
  chainId,
  factoryAddress,
  creator,
  request,
  graduationQuoteAssetId,
  tradeRouteProfileId,
  finalizeRouteProfileId,
  deadline,
}) {
  if (Number(chainId) !== BNB_MAINNET_CHAIN_ID) {
    throw new Error("BNB BASIC approved quote creation is only valid on BNB Chain mainnet");
  }
  const catalogId = requiredCatalogId(graduationQuoteAssetId);
  const detail = await getGraduationQuoteAssetDetail(catalogId);
  const item = assertBnbBasicCatalogAuthority(detail?.item);
  const binding = buildBnbBasicQuoteCatalogBinding(item);
  const factoryBinding = await readBnbBasicFactoryBinding({ chainId, factoryAddress });

  const signature = await signBnbBasicQuoteAuthorization({
    signer,
    chainId,
    factoryAddress,
    creator,
    request,
    quoteToken: binding.quoteToken,
    quoteCatalogBindingHash: binding.bindingHash,
    adapter: factoryBinding.adapter,
    campaignImplementation: factoryBinding.campaignImplementation,
    tradeRouteProfileId,
    finalizeRouteProfileId,
    deadline,
  });

  return {
    signature,
    quoteToken: binding.quoteToken,
    quoteCatalogBindingHash: binding.bindingHash,
    graduationQuoteAssetId: binding.deploymentId,
    providerId: binding.providerId,
    providerKey: binding.providerKey,
    policyKey: binding.policyKey,
    policyVersion: binding.policyVersion.toString(),
    deploymentStateVersion: binding.deploymentStateVersion.toString(),
    bnbQuoteGraduationAdapter: factoryBinding.adapter,
    bnbQuoteCampaignImplementation: factoryBinding.campaignImplementation,
    factoryGeneration: factoryBinding.factoryGeneration,
    campaignGeneration: factoryBinding.campaignGeneration,
    asset: item,
  };
}
