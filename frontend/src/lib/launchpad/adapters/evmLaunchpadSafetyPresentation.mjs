const BNB_CHAIN_IDS = new Set([56, 97]);
const ROBINHOOD_CHAIN_IDS = new Set([4663, 46630]);

export function getEvmLaunchpadPresentation(chainId) {
  if (chainId === 56) {
    return {
      chainLabel: "BNB Smart Chain",
      nativeSymbol: "BNB",
      walletLabel: "BNB-compatible wallet",
      routeReadyTitle: "BNB launch route ready",
      routeReadyAction: "BNB Live Route",
      routeReadyDescription:
        "BNB launch services are ready. Your campaign can launch and graduate through the supported MemeWarzone route.",
      unavailableTitle: "BNB launches are temporarily unavailable",
      unavailableDescription:
        "Launching is temporarily unavailable on this network. Your draft is safe. Please try again later.",
      graduationLabel: "Topaz graduation",
      graduationReadyDetail: "Graduated tokens move into the supported Topaz liquidity pool.",
      graduationUnavailableDetail: "The graduation route is temporarily unavailable. Please try again later.",
      isBnb: true,
      isRobinhood: false,
    };
  }

  if (chainId === 97) {
    return {
      chainLabel: "BNB Testnet",
      nativeSymbol: "BNB",
      walletLabel: "BNB-compatible wallet",
      routeReadyTitle: "BNB launch route ready",
      routeReadyAction: "BNB Live Route",
      routeReadyDescription:
        "BNB launch services are ready. Your campaign can launch and graduate through the supported MemeWarzone route.",
      unavailableTitle: "BNB launches are temporarily unavailable",
      unavailableDescription:
        "Launching is temporarily unavailable on this network. Your draft is safe. Please try again later.",
      graduationLabel: "Topaz graduation",
      graduationReadyDetail: "Graduated tokens move into the supported Topaz liquidity pool.",
      graduationUnavailableDetail: "The graduation route is temporarily unavailable. Please try again later.",
      isBnb: true,
      isRobinhood: false,
    };
  }

  if (chainId === 4663 || chainId === 46630) {
    const chainLabel = chainId === 4663 ? "Robinhood Chain" : "Robinhood Chain Testnet";
    return {
      chainLabel,
      nativeSymbol: "ETH",
      walletLabel: "EVM wallet",
      routeReadyTitle: "Robinhood launch route ready",
      routeReadyAction: "Robinhood Live Route",
      routeReadyDescription:
        "Robinhood launch services are configured for this environment. Your campaign can use the configured MemeWarzone launch route.",
      unavailableTitle: "Robinhood launch services unavailable",
      unavailableDescription: "Robinhood launch services are not configured for this environment.",
      graduationLabel: "Robinhood graduation",
      graduationReadyDetail: "Robinhood graduation services are configured for this environment.",
      graduationUnavailableDetail: "Robinhood graduation services are not configured for this environment.",
      isBnb: false,
      isRobinhood: true,
    };
  }

  throw new Error(`Unsupported EVM launchpad chain ${chainId}`);
}

function contractChecks(readiness, presentation) {
  const groups = [
    {
      id: "coreContracts",
      label: "Launch availability",
      keys: ["launchFactory", "launchCampaignImplementation", "graduationOracle", "permanentLpLocker"],
    },
    {
      id: "securityContracts",
      label: "Creator eligibility",
      keys: ["creatorRegistry", "riskRegistry"],
    },
    {
      id: "treasuryContracts",
      label: "MemeWarzone services",
      keys: [
        "treasuryRouter",
        "treasuryVault",
        "recruiterRewardsVault",
        "communityRewardsVault",
        "protocolRevenueVault",
        "voteTreasury",
      ],
    },
  ];

  if (presentation.isBnb) {
    groups.push({
      id: "topazContracts",
      label: "Graduation route",
      keys: ["topazRouter", "topazFactory", "topazWbnb"],
    });
  }

  return groups.map((group) => {
    const items = readiness.items.filter((item) => group.keys.includes(item.key));
    const missing = items.filter((item) => item.required && !item.ready);
    const configured = items.filter((item) => item.ready).length;
    return {
      id: group.id,
      label: group.label,
      state: missing.length ? "blocked" : "ready",
      detail: missing.length
        ? presentation.isRobinhood
          ? "One or more Robinhood launch requirements are not configured for this environment."
          : "One or more launch requirements are temporarily unavailable."
        : `${configured}/${items.length} launch requirements ready for chain ${readiness.chainId}.`,
    };
  });
}

export function buildEvmLaunchpadSafetyStatus(params) {
  const presentation = getEvmLaunchpadPresentation(params.chainId);
  const readiness = params.contractReadiness;
  const contractsReady = readiness.ready;
  const walletChainMatches = !params.hasAccount || params.walletChainId === params.chainId;
  const protocolReady = Boolean(params.factoryAddress) && contractsReady && walletChainMatches;
  const wrongWalletNetwork = params.hasAccount && !walletChainMatches;
  const missingTopaz =
    presentation.isBnb && readiness.missingRequired.some((item) => item.key.startsWith("topaz"));
  const graduationKeys = new Set(["graduationOracle", "permanentLpLocker"]);
  const missingRobinhoodGraduation =
    presentation.isRobinhood &&
    readiness.missingRequired.some((item) => graduationKeys.has(item.key));
  const graduationBlocked = presentation.isBnb ? missingTopaz : missingRobinhoodGraduation || !contractsReady;

  return {
    adapterId: "bnb",
    chainId: params.chainId,
    chainLabel: presentation.chainLabel,
    protocolStatus: protocolReady ? "ready" : "unavailable",
    protocolLabel: protocolReady ? "Live" : wrongWalletNetwork ? "Switch Network" : "Temporarily unavailable",
    title: protocolReady
      ? presentation.routeReadyTitle
      : wrongWalletNetwork
        ? "Switch wallet network"
        : presentation.unavailableTitle,
    primaryActionLabel: protocolReady
      ? presentation.routeReadyAction
      : wrongWalletNetwork
        ? "Switch Network"
        : "Temporarily unavailable",
    description: wrongWalletNetwork
      ? `Your wallet is connected to chain ${params.walletChainId}. Switch to ${presentation.chainLabel} (chain ${params.chainId}) to continue.`
      : protocolReady
        ? presentation.routeReadyDescription
        : presentation.unavailableDescription,
    checks: [
      {
        id: "network",
        label: "Wallet network",
        state: wrongWalletNetwork ? "blocked" : params.hasAccount ? "ready" : "pending",
        detail: wrongWalletNetwork
          ? `Your wallet is connected to chain ${params.walletChainId}. Switch to ${presentation.chainLabel} (chain ${params.chainId}) to continue.`
          : params.hasAccount
            ? `Wallet connected to ${presentation.chainLabel} (chain ${params.chainId}). Gas is paid in ${presentation.nativeSymbol}.`
            : `Connect an ${presentation.walletLabel} on ${presentation.chainLabel} (chain ${params.chainId}). Gas is paid in ${presentation.nativeSymbol}.`,
      },
      {
        id: "routeAuth",
        label: "Transaction protection",
        state: "ready",
        detail: "Launch and trading transactions are protected before they are submitted.",
      },
      {
        id: "signer",
        label: "Wallet connection",
        state: params.hasSigner && params.hasAccount ? "ready" : "pending",
        detail:
          params.hasSigner && params.hasAccount
            ? "Wallet ready."
            : `Connect an ${presentation.walletLabel} to continue.`,
      },
      ...contractChecks(readiness, presentation),
    ],
    milestones: [
      {
        id: "drafts",
        label: "Prepare drafts",
        state: "ready",
        detail: "Creators can sign, save, and promote launch drafts before deploy.",
      },
      {
        id: "contracts",
        label: "Launch availability",
        state: contractsReady ? "ready" : "blocked",
        detail: contractsReady
          ? "Launch services are configured and ready."
          : presentation.unavailableDescription,
      },
      {
        id: "trading",
        label: "Trading",
        state: protocolReady ? "ready" : "blocked",
        detail: protocolReady
          ? "Buy and sell transactions are protected by MemeWarzone safety checks."
          : presentation.isRobinhood
            ? "Robinhood trading services are not configured for this environment."
            : "Trading is temporarily unavailable on this network. Please try again later.",
      },
      {
        id: "graduation",
        label: presentation.graduationLabel,
        state: graduationBlocked ? "blocked" : "ready",
        detail: graduationBlocked
          ? presentation.graduationUnavailableDetail
          : presentation.graduationReadyDetail,
      },
    ],
  };
}

export function isBnbEvmLaunchpadChain(chainId) {
  return BNB_CHAIN_IDS.has(chainId);
}

export function isRobinhoodEvmLaunchpadChain(chainId) {
  return ROBINHOOD_CHAIN_IDS.has(chainId);
}
