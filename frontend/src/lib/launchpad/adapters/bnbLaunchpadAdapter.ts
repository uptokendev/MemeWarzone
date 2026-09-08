import type { BnbContractReadiness } from "@/lib/bnbContracts";
import { getBnbContractReadiness } from "@/lib/bnbContracts";
import type { SupportedChainId } from "@/lib/chainConfig";
import type { LaunchpadSafetyStatus } from "./types";
import { buildEvmLaunchpadSafetyStatus } from "./evmLaunchpadSafetyPresentation.mjs";

export const BNB_LAUNCHPAD_ADAPTER_ID = "bnb" as const;

export function getEvmLaunchpadSafetyStatus(params: {
  chainId: SupportedChainId;
  factoryAddress: string;
  hasSigner: boolean;
  hasAccount: boolean;
  walletChainId?: number;
  contractReadiness?: BnbContractReadiness;
}): LaunchpadSafetyStatus {
  const readiness = params.contractReadiness ?? getBnbContractReadiness(params.chainId);
  return buildEvmLaunchpadSafetyStatus({
    ...params,
    contractReadiness: readiness,
  }) as LaunchpadSafetyStatus;
}

// Backward-compatible export while Create/launchpadClient still use the legacy name.
// Presentation is now chain-aware for every supported EVM chain.
export const getBnbLaunchpadSafetyStatus = getEvmLaunchpadSafetyStatus;
