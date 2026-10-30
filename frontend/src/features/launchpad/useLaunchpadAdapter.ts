import { useMemo } from "react";

import type { LaunchpadAdapter, LaunchpadChain } from "@/features/launchpad/adapters";
import { createBnbLaunchpadAdapter } from "@/features/launchpad/bnbAdapter";
import { createDogeosBarkswapLaunchpadAdapter, isDogeosBarkswapChainId } from "@/features/launchpad/dogeosBarkswapAdapter";
import { createRobinhoodLaunchpadAdapter } from "@/features/launchpad/robinhoodAdapter";
import { createSolanaLaunchpadAdapter } from "@/features/launchpad/solanaAdapter";

function resolveLaunchpadChain(input?: { chain?: LaunchpadChain | string | null; chainId?: number | string | null }): LaunchpadChain {
  const chainId = Number(input?.chainId ?? 0);
  if (chainId === 102) {
    throw new Error("Legacy Solana chain 102 cannot select a current launchpad adapter.");
  }
  // DogeOS is gen-8 only, on the Barkswap venue (GEN8_CHAIN_VENUE): its own adapter, never the Robinhood (46630
  // default) or BNB one, whatever chain family the caller names.
  if (isDogeosBarkswapChainId(chainId)) return "dogeos";

  const explicit = String(input?.chain || "").trim().toLowerCase();
  if (explicit === "sol" || explicit === "solana") return "solana";
  if (explicit === "robinhood" || explicit === "rh") return "robinhood";
  if (explicit === "bnb" || explicit === "bsc") return "bnb";
  if (explicit === "dogeos") return "dogeos";

  if (chainId === 101) return "solana";
  if (chainId === 4663 || chainId === 46630) return "robinhood";
  return "bnb";
}

export function getLaunchpadAdapter(input?: { chain?: LaunchpadChain | string | null; chainId?: number | string | null }): LaunchpadAdapter {
  const chain = resolveLaunchpadChain(input);
  if (chain === "solana") return createSolanaLaunchpadAdapter();
  if (chain === "robinhood") return createRobinhoodLaunchpadAdapter();
  if (chain === "dogeos") return createDogeosBarkswapLaunchpadAdapter();
  return createBnbLaunchpadAdapter();
}

export function useLaunchpadAdapter(input?: { chain?: LaunchpadChain | string | null; chainId?: number | string | null }) {
  const chain = resolveLaunchpadChain(input);
  return useMemo(() => getLaunchpadAdapter({ chain }), [chain]);
}
