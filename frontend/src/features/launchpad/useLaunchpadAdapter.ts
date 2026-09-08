import { useMemo } from "react";

import type { LaunchpadAdapter, LaunchpadChain } from "@/features/launchpad/adapters";
import { createBnbLaunchpadAdapter } from "@/features/launchpad/bnbAdapter";
import { createRobinhoodLaunchpadAdapter } from "@/features/launchpad/robinhoodAdapter";
import { createSolanaLaunchpadAdapter } from "@/features/launchpad/solanaAdapter";

function resolveLaunchpadChain(input?: { chain?: LaunchpadChain | string | null; chainId?: number | string | null }): LaunchpadChain {
  const explicit = String(input?.chain || "").trim().toLowerCase();
  if (explicit === "sol" || explicit === "solana") return "solana";
  if (explicit === "robinhood" || explicit === "rh") return "robinhood";
  if (explicit === "bnb" || explicit === "bsc") return "bnb";

  const chainId = Number(input?.chainId ?? 0);
  if (chainId === 101 || chainId === 102) return "solana";
  if (chainId === 4663 || chainId === 46630) return "robinhood";
  return "bnb";
}

export function getLaunchpadAdapter(input?: { chain?: LaunchpadChain | string | null; chainId?: number | string | null }): LaunchpadAdapter {
  const chain = resolveLaunchpadChain(input);
  if (chain === "solana") return createSolanaLaunchpadAdapter();
  if (chain === "robinhood") return createRobinhoodLaunchpadAdapter();
  return createBnbLaunchpadAdapter();
}

export function useLaunchpadAdapter(input?: { chain?: LaunchpadChain | string | null; chainId?: number | string | null }) {
  const chain = resolveLaunchpadChain(input);
  return useMemo(() => getLaunchpadAdapter({ chain }), [chain]);
}
