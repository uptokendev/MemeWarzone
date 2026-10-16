import { apiFetch } from "@/lib/apiBase";
import type { LaunchpadAdapter, LaunchpadAdapterStatus, LaunchpadTradePreflight, TradeSide } from "@/features/launchpad/adapters";
import { normalizeEvmAddress } from "@/features/launchpad/adapters";
import { DOGEOS_DEX_LABEL, DOGEOS_TESTNET_CHAIN_ID } from "@/lib/dogeosPresentation.mjs";
import { gen8AppConfig, isGen8BarkAppConfig } from "@/lib/evmGen8Client.mjs";
import { GEN8_VENUE_BARKSWAP, gen8VenueFor } from "../../../shared/evmGen8.mjs";

/**
 * DogeOS (6281971) launches on gen-8 only, on the Barkswap venue (barkswap spec section 4; GEN8_CHAIN_VENUE in
 * shared/evmGen8.mjs). Its gen-7 / Robinhood V3 family paths are removed (B8), so a DogeOS coin never takes the
 * Robinhood or BNB launchpad adapter: either would check it on another chain (the Robinhood one defaults to 46630).
 *
 * The Bark client (barkswap plan t22): a coin trades in its own Barkswap pool through the gen-8 trade panel
 * (evmGen8Client.mjs Barkswap branch). There is no trade authorization (D3 signs creates only), so the adapter has no
 * route to wait for; its status is the app's gen-8 Barkswap config, and its preflight is the API's chain-free safety
 * check (campaign pauses, wallet and cluster risk) posted with 6281971. Without the Bark config it fails closed: no API
 * call and no trade.
 */
export function isDogeosBarkswapChainId(chainId?: number | string | null): boolean {
  return gen8VenueFor(chainId) === GEN8_VENUE_BARKSWAP;
}

/** Shown when the app has no gen-8 Barkswap config for 6281971 (and by the Robinhood panel, which refuses DogeOS). */
export const DOGEOS_TRADE_UNAVAILABLE = `DogeOS trading on ${DOGEOS_DEX_LABEL} is not available yet.`;
export const DOGEOS_TRADE_READY = `DogeOS coins trade in their own ${DOGEOS_DEX_LABEL} pool. The pool's plugin charges the fee on chain; trades need no MemeWarzone authorization.`;

/** True when the app can launch and trade on Barkswap: launcher + plugin, and Barkswap's router and quoter. */
export function isDogeosBarkswapReady(): boolean {
  const cfg = gen8AppConfig(DOGEOS_TESTNET_CHAIN_ID);
  return Boolean(isGen8BarkAppConfig(cfg) && cfg?.router && cfg?.quoter);
}

function refusal(side: TradeSide, reason: string): LaunchpadTradePreflight {
  return { allowed: false, chain: "dogeos", side, reasons: [reason], warnings: [] };
}

async function postPreflight(side: TradeSide, body: Record<string, unknown>): Promise<any> {
  try {
    const response = await apiFetch(side === "buy" ? "/api/launchpad/preflight-buy" : "/api/launchpad/preflight-sell", {
      method: "POST",
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    return payload && typeof payload === "object" ? payload : { preflight: null };
  } catch {
    return { preflight: null };
  }
}

export function createDogeosBarkswapLaunchpadAdapter(): LaunchpadAdapter {
  return {
    chain: "dogeos",

    async getStatus(): Promise<LaunchpadAdapterStatus> {
      const ready = isDogeosBarkswapReady();
      return {
        chain: "dogeos",
        protocolLive: ready,
        label: `DogeOS launchpad (${DOGEOS_DEX_LABEL})`,
        message: ready ? DOGEOS_TRADE_READY : DOGEOS_TRADE_UNAVAILABLE,
        // No trade authorization exists on gen-8, so there is nothing to wait for once the venue is configured.
        routeAuthorizationReady: ready,
        warnings: [],
      };
    },

    async preflightTrade({ side, walletAddress, campaignAddress }): Promise<LaunchpadTradePreflight> {
      if (!isDogeosBarkswapReady()) return refusal(side, DOGEOS_TRADE_UNAVAILABLE);
      const campaign = normalizeEvmAddress(campaignAddress);
      if (!campaign) return refusal(side, "Token campaign address is missing or invalid.");
      const wallet = normalizeEvmAddress(walletAddress);
      if (!wallet) {
        return {
          allowed: true,
          chain: "dogeos",
          side,
          reasons: [],
          warnings: ["Connect a DogeOS wallet to run wallet-specific creator and cluster protection checks."],
        };
      }
      // Always 6281971: a DogeOS coin is never checked as another chain's.
      const payload = await postPreflight(side, { walletAddress: wallet, campaignAddress: campaign, chainId: DOGEOS_TESTNET_CHAIN_ID });
      const preflight = payload?.preflight && typeof payload.preflight === "object" ? payload.preflight : payload;
      return {
        allowed: Boolean(preflight?.allowed),
        chain: "dogeos",
        side,
        reasons: Array.isArray(preflight?.reasons) ? preflight.reasons.map(String) : [],
        warnings: Array.isArray(preflight?.warnings) ? preflight.warnings.map(String) : [],
        schemaReady: preflight?.schemaReady,
        campaign: preflight?.campaign || null,
        walletRisk: preflight?.walletRisk || null,
        cluster: preflight?.cluster || null,
        lookupErrors: Array.isArray(preflight?.lookupErrors) ? preflight.lookupErrors.map(String) : [],
      };
    },
  };
}
