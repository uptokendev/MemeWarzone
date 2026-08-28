import { ethers } from "ethers";
import LaunchFactoryArtifact from "@/abi/LaunchFactory.json";
import LaunchCampaignArtifact from "@/abi/LaunchCampaign.json";
import LaunchTokenArtifact from "@/abi/LaunchToken.json";
import GraduationOracleArtifact from "@/abi/GraduationOracle.json";
import CreatorRegistryArtifact from "@/abi/CreatorRegistry.json";
import RiskRegistryArtifact from "@/abi/RiskRegistry.json";
import TreasuryRouterArtifact from "@/abi/TreasuryRouter.json";
import RecruiterRewardsVaultArtifact from "@/abi/RecruiterRewardsVault.json";
import ProtocolRevenueVaultArtifact from "@/abi/ProtocolRevenueVault.json";
import CommunityRewardsVaultArtifact from "@/abi/CommunityRewardsVault.json";
import TreasuryVaultV2Artifact from "@/abi/TreasuryVaultV2.json";
import UPVoteTreasuryArtifact from "@/abi/UPVoteTreasury.json";
import PermanentLpLockerArtifact from "@/abi/PermanentLpLocker.json";
import type { SupportedChainId } from "@/lib/chainConfig";
import { BNB_CHAIN_ID, BNB_TESTNET_CHAIN_ID, isEvmChainId } from "@/lib/chainConfig";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
export const OBSOLETE_BSC_TESTNET_FACTORY = "0xe0FbBa4533513110Cec7e78aa3e48EC45301B5E6";
export const OBSOLETE_BSC_TESTNET_PERMANENT_LP_LOCKER = "0x3Fd82ACA84E43CEDEb6B8b577fd15A1Ce9eC4161";

type Artifact = { abi?: ethers.InterfaceAbi; contractName?: string } | ethers.InterfaceAbi;

function toAbi(artifact: Artifact): ethers.InterfaceAbi {
  return ((artifact as { abi?: ethers.InterfaceAbi })?.abi ?? artifact) as ethers.InterfaceAbi;
}

function env(name: string): string {
  const viteEnv = import.meta.env as Record<string, unknown>;
  return String(viteEnv[name] ?? "").trim();
}

function normalizeAddress(value: string): string {
  if (!ADDRESS_RE.test(value)) return "";

  try {
    return ethers.getAddress(value);
  } catch {
    // A syntactically valid EVM address may arrive with stale or incorrect
    // mixed-case checksum casing in local/runtime configuration. Treat casing
    // as non-authoritative and normalize the raw address instead of crashing
    // the entire frontend during contract-readiness evaluation.
    try {
      return ethers.getAddress(value.toLowerCase());
    } catch {
      return "";
    }
  }
}

function isBnbChain(chainId: SupportedChainId) {
  return chainId === BNB_CHAIN_ID || chainId === BNB_TESTNET_CHAIN_ID;
}

function readAddress(chainId: SupportedChainId, perChainName: string, fallbackName?: string) {
  if (!isEvmChainId(chainId)) return "";
  const perChain = env(`${perChainName}_${chainId}`);
  // Legacy unsuffixed variables belong to BNB only. Never allow them to leak
  // into Robinhood or any future EVM chain.
  const fallback = fallbackName && isBnbChain(chainId) ? env(fallbackName) : "";
  return normalizeAddress(perChain || fallback);
}

function readCreationFactory(chainId: SupportedChainId) {
  const configured = readAddress(chainId, "VITE_FACTORY_ADDRESS", "VITE_FACTORY_ADDRESS");
  if (
    Number(chainId) === 97 &&
    configured &&
    configured.toLowerCase() === OBSOLETE_BSC_TESTNET_FACTORY.toLowerCase()
  ) {
    return "";
  }
  return configured;
}

export type BnbContractKey =
  | "launchFactory"
  | "launchCampaignImplementation"
  | "treasuryRouter"
  | "treasuryVault"
  | "recruiterRewardsVault"
  | "communityRewardsVault"
  | "protocolRevenueVault"
  | "creatorRegistry"
  | "riskRegistry"
  | "graduationOracle"
  | "permanentLpLocker"
  | "voteTreasury"
  | "topazRouter"
  | "topazFactory"
  | "topazWbnb";

export type BnbContractAddresses = Record<BnbContractKey, string>;

export type BnbContractReadinessItem = {
  key: BnbContractKey;
  label: string;
  required: boolean;
  address: string;
  ready: boolean;
};

export type BnbContractReadiness = {
  chainId: SupportedChainId;
  ready: boolean;
  items: BnbContractReadinessItem[];
  missingRequired: BnbContractReadinessItem[];
};

export const bnbContractAbis = {
  launchFactory: toAbi(LaunchFactoryArtifact),
  launchCampaign: toAbi(LaunchCampaignArtifact),
  launchToken: toAbi(LaunchTokenArtifact),
  graduationOracle: toAbi(GraduationOracleArtifact),
  creatorRegistry: toAbi(CreatorRegistryArtifact),
  riskRegistry: toAbi(RiskRegistryArtifact),
  treasuryRouter: toAbi(TreasuryRouterArtifact),
  recruiterRewardsVault: toAbi(RecruiterRewardsVaultArtifact),
  protocolRevenueVault: toAbi(ProtocolRevenueVaultArtifact),
  communityRewardsVault: toAbi(CommunityRewardsVaultArtifact),
  treasuryVault: toAbi(TreasuryVaultV2Artifact),
  voteTreasury: toAbi(UPVoteTreasuryArtifact),
  permanentLpLocker: toAbi(PermanentLpLockerArtifact),
} as const;

const contractLabels: Record<BnbContractKey, string> = {
  launchFactory: "LaunchFactory",
  launchCampaignImplementation: "LaunchCampaign implementation",
  treasuryRouter: "TreasuryRouter",
  treasuryVault: "TreasuryVaultV2",
  recruiterRewardsVault: "RecruiterRewardsVault",
  communityRewardsVault: "CommunityRewardsVault",
  protocolRevenueVault: "ProtocolRevenueVault",
  creatorRegistry: "CreatorRegistry",
  riskRegistry: "RiskRegistry",
  graduationOracle: "GraduationOracle",
  permanentLpLocker: "Permanent liquidity locker",
  voteTreasury: "UPVoteTreasury",
  topazRouter: "Topaz router",
  topazFactory: "Topaz pool factory",
  topazWbnb: "Topaz WBNB",
};

const commonRequiredContracts = new Set<BnbContractKey>([
  "launchFactory",
  "launchCampaignImplementation",
  "treasuryRouter",
  "treasuryVault",
  "recruiterRewardsVault",
  "communityRewardsVault",
  "protocolRevenueVault",
  "creatorRegistry",
  "riskRegistry",
  "graduationOracle",
  "permanentLpLocker",
  "voteTreasury",
]);

const bnbOnlyRequiredContracts = new Set<BnbContractKey>([
  "topazRouter",
  "topazFactory",
  "topazWbnb",
]);

export function getBnbContractAddresses(chainId: SupportedChainId): BnbContractAddresses {
  return {
    launchFactory: readCreationFactory(chainId),
    launchCampaignImplementation: readAddress(chainId, "VITE_CAMPAIGN_IMPLEMENTATION_ADDRESS"),
    treasuryRouter: readAddress(chainId, "VITE_TREASURY_ROUTER_ADDRESS"),
    treasuryVault: readAddress(chainId, "VITE_TREASURY_VAULT_ADDRESS", "VITE_TREASURY_VAULT_ADDRESS"),
    recruiterRewardsVault: readAddress(chainId, "VITE_RECRUITER_REWARDS_VAULT_ADDRESS"),
    communityRewardsVault: readAddress(chainId, "VITE_COMMUNITY_REWARDS_VAULT_ADDRESS"),
    protocolRevenueVault: readAddress(chainId, "VITE_PROTOCOL_REVENUE_VAULT_ADDRESS"),
    creatorRegistry: readAddress(chainId, "VITE_CREATOR_REGISTRY_ADDRESS"),
    riskRegistry: readAddress(chainId, "VITE_RISK_REGISTRY_ADDRESS"),
    graduationOracle: readAddress(chainId, "VITE_GRADUATION_ORACLE_ADDRESS"),
    permanentLpLocker: readAddress(chainId, "VITE_PERMANENT_LP_LOCKER_ADDRESS"),
    voteTreasury: readAddress(chainId, "VITE_VOTE_TREASURY_ADDRESS", "VITE_VOTE_TREASURY_ADDRESS"),
    topazRouter: isBnbChain(chainId) ? readAddress(chainId, "VITE_TOPAZ_ROUTER_ADDRESS") : "",
    topazFactory: isBnbChain(chainId) ? readAddress(chainId, "VITE_TOPAZ_FACTORY_ADDRESS") : "",
    topazWbnb: isBnbChain(chainId) ? readAddress(chainId, "VITE_TOPAZ_WBNB_ADDRESS") : "",
  };
}

export function getBnbContractReadiness(chainId: SupportedChainId): BnbContractReadiness {
  const addresses = getBnbContractAddresses(chainId);
  const items = (Object.keys(addresses) as BnbContractKey[]).map((key) => {
    const required = commonRequiredContracts.has(key) || (isBnbChain(chainId) && bnbOnlyRequiredContracts.has(key));
    const address = addresses[key];
    return {
      key,
      label: contractLabels[key],
      required,
      address,
      ready: Boolean(address),
    };
  });
  const missingRequired = items.filter((item) => item.required && !item.ready);
  return {
    chainId,
    ready: missingRequired.length === 0,
    items,
    missingRequired,
  };
}

export function summarizeMissingBnbContracts(readiness: BnbContractReadiness): string {
  if (readiness.ready) return `All required EVM launchpad contracts are configured for chain ${readiness.chainId}.`;
  const names = readiness.missingRequired.map((item) => item.label).join(", ");
  return `Missing ${readiness.missingRequired.length} required contract${readiness.missingRequired.length === 1 ? "" : "s"}: ${names}.`;
}
