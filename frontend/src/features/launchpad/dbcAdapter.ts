import type { LaunchpadAdapter, LaunchpadAdapterStatus, LaunchpadTradePreflight, TradeSide } from "./adapters";
import { isSolanaAddress } from "@/lib/address";

/**
 * Trading safety for a DBC coin. None of the launchpad's switches apply here: there is no route
 * authorization, and a launchpad pause does not stop a Meteora pool (the coin keeps trading on
 * Jupiter either way). What our site checks is the wallet; the Meteora program checks the rest.
 */
export function createDbcLaunchpadAdapter(): LaunchpadAdapter {
  return {
    chain: "solana",
    async getStatus(): Promise<LaunchpadAdapterStatus> {
      return {
        chain: "solana",
        protocolLive: true,
        label: "Meteora curve",
        message: "Trades go straight to the coin's Meteora pool.",
        routeAuthorizationReady: true,
        warnings: [],
      };
    },
    async preflightTrade({ side, walletAddress, campaignAddress }): Promise<LaunchpadTradePreflight> {
      const sideLabel: TradeSide = side === "sell" ? "sell" : "buy";
      const campaign = String(campaignAddress || "").trim();
      const wallet = String(walletAddress || "").trim();
      const base = { chain: "solana" as const, side: sideLabel, warnings: [], schemaReady: true, campaign: { campaignAddress: campaign } };
      if (!wallet) return { ...base, allowed: false, reasons: ["Connect a Solana wallet to trade."] };
      if (!isSolanaAddress(wallet)) return { ...base, allowed: false, reasons: ["Connect a Solana wallet to trade this coin."] };
      return { ...base, allowed: true, reasons: [], walletRisk: { walletAddress: wallet, restricted: false } };
    },
  } as LaunchpadAdapter;
}
