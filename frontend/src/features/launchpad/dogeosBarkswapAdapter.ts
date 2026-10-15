import type { LaunchpadAdapter, LaunchpadAdapterStatus, LaunchpadTradePreflight } from "@/features/launchpad/adapters";
import { DOGEOS_DEX_LABEL } from "@/lib/dogeosPresentation.mjs";
import { GEN8_VENUE_BARKSWAP, gen8VenueFor } from "../../../shared/evmGen8.mjs";

/**
 * DogeOS (6281971) launches on gen-8 only, on the Barkswap venue (barkswap spec section 4; GEN8_CHAIN_VENUE in
 * shared/evmGen8.mjs). Its gen-7 / Robinhood V3 family paths are removed (B8), so a DogeOS coin never takes the
 * Robinhood or BNB launchpad adapter: either would check it on another chain (the Robinhood one defaults to 46630).
 *
 * Until the Bark client is wired (plan t22) this adapter fails closed: it keeps the chain's identity for the safety
 * panels, makes no API call and allows no trade.
 */
export function isDogeosBarkswapChainId(chainId?: number | string | null): boolean {
  return gen8VenueFor(chainId) === GEN8_VENUE_BARKSWAP;
}

export const DOGEOS_TRADE_UNAVAILABLE = `DogeOS trading on ${DOGEOS_DEX_LABEL} is not available yet.`;

export function createDogeosBarkswapLaunchpadAdapter(): LaunchpadAdapter {
  return {
    chain: "dogeos",

    async getStatus(): Promise<LaunchpadAdapterStatus> {
      return {
        chain: "dogeos",
        protocolLive: false,
        label: `DogeOS launchpad (${DOGEOS_DEX_LABEL})`,
        message: DOGEOS_TRADE_UNAVAILABLE,
        routeAuthorizationReady: false,
        warnings: [],
      };
    },

    async preflightTrade({ side }): Promise<LaunchpadTradePreflight> {
      return {
        allowed: false,
        chain: "dogeos",
        side,
        reasons: [DOGEOS_TRADE_UNAVAILABLE],
        warnings: [],
      };
    },
  };
}
