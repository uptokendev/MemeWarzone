import { getActiveChainId, getDefaultChainId, isAllowedChainId, type SupportedChainId } from "@/lib/chainConfig";

const BNB_TESTNET_CHAIN_ID: SupportedChainId = 97;
const BNB_MAINNET_CHAIN_ID: SupportedChainId = 56;
const ROBINHOOD_MAINNET_CHAIN_ID: SupportedChainId = 4663;
const ROBINHOOD_TESTNET_CHAIN_ID: SupportedChainId = 46630;
const SOLANA_CHAIN_ID: SupportedChainId = 101;
const LAST_FEATURED_CHAIN_KEY = "mwz:last_featured_chain_id";

function readEnv(name: string): string {
  const env = import.meta.env as Record<string, string | boolean | undefined>;
  return String(env[name] ?? "").trim();
}

function readEnvChainId(name: string): SupportedChainId | null {
  const raw = readEnv(name);
  const chainId = Number(raw);
  return Number.isFinite(chainId) && isAllowedChainId(chainId) ? (chainId as SupportedChainId) : null;
}

function readConfiguredChainId(envNames: string[]): SupportedChainId | null {
  for (const envName of envNames) {
    const configured = readEnvChainId(envName);
    if (configured) return configured;
  }
  return null;
}

function envTrue(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(readEnv(name).toLowerCase());
}

function envFalse(name: string): boolean {
  return ["0", "false", "no", "off"].includes(readEnv(name).toLowerCase());
}

function isLikelyDevOrStagingHost(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.includes("netlify") ||
    host.includes("vercel") ||
    host.includes("railway") ||
    host.includes("staging") ||
    host.includes("preview") ||
    host.includes("dev")
  );
}

function shouldDefaultDevFeedsToTestnet(): boolean {
  if (envFalse("VITE_ENABLE_TESTNET_FEATURED_FEED")) return false;
  if (envTrue("VITE_ENABLE_TESTNET_FEATURED_FEED")) return true;
  if (envTrue("VITE_DEVPOSTGRAD_MODE")) return true;
  if (envTrue("VITE_POSTGRAD_MODE")) return true;
  // Live campaign inventory is still primarily on BSC testnet (97) for postgrad.
  // Prefer 97 unless an explicit feed/default chain env forces mainnet.
  if (envTrue("VITE_PREFER_TESTNET_CAMPAIGN_FEED")) return true;
  if (isLikelyDevOrStagingHost()) return true;
  // Production memewar.zone / custom domains without env still have testnet coins.
  // Only skip this when VITE_CAMPAIGN_FEED_CHAIN_ID or VITE_DEFAULT_CHAIN_ID is set.
  if (!readConfiguredChainId(["VITE_CAMPAIGN_FEED_CHAIN_ID", "VITE_DEFAULT_CHAIN_ID", "VITE_TARGET_CHAIN_ID"])) {
    return true;
  }
  return false;
}

/**
 * Feed inventory for the explicitly selected product chain.
 * BNB may merge 56+97 for backward-compatible legacy inventory. Solana and
 * Robinhood stay isolated so selecting them can never show BNB campaigns.
 *
 * Keep the old export name until callers are migrated; its behavior is now
 * chain-aware rather than BNB-only.
 */
export function getBnbCampaignFeedChainIds(selectedChainId?: number | null): SupportedChainId[] {
  const selected = Number(selectedChainId);
  if (selected === SOLANA_CHAIN_ID) return [SOLANA_CHAIN_ID];
  if (selected === ROBINHOOD_MAINNET_CHAIN_ID && isAllowedChainId(ROBINHOOD_MAINNET_CHAIN_ID)) {
    return [ROBINHOOD_MAINNET_CHAIN_ID];
  }
  if (selected === ROBINHOOD_TESTNET_CHAIN_ID && isAllowedChainId(ROBINHOOD_TESTNET_CHAIN_ID)) {
    return [ROBINHOOD_TESTNET_CHAIN_ID];
  }
  // Prefer BNB testnet first (current legacy inventory), then BNB mainnet.
  const chains = [BNB_TESTNET_CHAIN_ID, BNB_MAINNET_CHAIN_ID].filter(isAllowedChainId);
  return chains.length ? chains : [BNB_MAINNET_CHAIN_ID];
}

function rememberFeaturedChain(chainId: SupportedChainId): SupportedChainId {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(LAST_FEATURED_CHAIN_KEY, String(chainId));
    } catch {
      // ignore storage failures
    }
  }
  return chainId;
}

function resolveFeedChainId(envNames: string[], walletChainId?: number | null, options?: { devTestnetFallback?: boolean }): SupportedChainId {
  const configured = readConfiguredChainId(envNames);
  if (configured) return configured;
  const active = getActiveChainId(walletChainId);
  // Do not let BNB's historical staging fallback override an explicit Robinhood/Solana selection.
  if (active === SOLANA_CHAIN_ID || active === ROBINHOOD_MAINNET_CHAIN_ID || active === ROBINHOOD_TESTNET_CHAIN_ID) return active;
  if (options?.devTestnetFallback && shouldDefaultDevFeedsToTestnet() && isAllowedChainId(BNB_TESTNET_CHAIN_ID)) return BNB_TESTNET_CHAIN_ID;
  return active;
}

export function getCampaignFeedChainId(walletChainId?: number | null): SupportedChainId {
  return resolveFeedChainId(["VITE_CAMPAIGN_FEED_CHAIN_ID", "VITE_LOCALDEV_CAMPAIGN_CHAIN_ID"], walletChainId, { devTestnetFallback: true });
}

export function getDraftDiscoveryChainId(walletChainId?: number | null): SupportedChainId {
  return resolveFeedChainId(["VITE_DRAFT_FEED_CHAIN_ID", "VITE_DRAFT_DISCOVERY_CHAIN_ID"], walletChainId, { devTestnetFallback: true });
}

export function getWarRoomFeedChainId(walletChainId?: number | null): SupportedChainId {
  return resolveFeedChainId(["VITE_WAR_ROOM_CHAIN_ID", "VITE_CAMPAIGN_FEED_CHAIN_ID", "VITE_LOCALDEV_CAMPAIGN_CHAIN_ID"], walletChainId, { devTestnetFallback: true });
}

export function getTickerFeedChainId(walletChainId?: number | null): SupportedChainId {
  return resolveFeedChainId(["VITE_TICKER_FEED_CHAIN_ID", "VITE_CAMPAIGN_FEED_CHAIN_ID", "VITE_LOCALDEV_CAMPAIGN_CHAIN_ID"], walletChainId, { devTestnetFallback: true });
}

export function getFeaturedFeedChainId(walletChainId?: number | null): SupportedChainId {
  const configured = readConfiguredChainId(["VITE_FEATURED_FEED_CHAIN_ID", "VITE_CAMPAIGN_FEED_CHAIN_ID", "VITE_LOCALDEV_CAMPAIGN_CHAIN_ID"]);
  if (configured) return rememberFeaturedChain(configured);
  const active = getActiveChainId(walletChainId);
  if (active === SOLANA_CHAIN_ID || active === ROBINHOOD_MAINNET_CHAIN_ID || active === ROBINHOOD_TESTNET_CHAIN_ID) {
    return rememberFeaturedChain(active);
  }
  if (shouldDefaultDevFeedsToTestnet() && isAllowedChainId(BNB_TESTNET_CHAIN_ID)) return rememberFeaturedChain(BNB_TESTNET_CHAIN_ID);
  return rememberFeaturedChain(active);
}

export function getCreateDeployChainId(walletChainId?: number | null): SupportedChainId {
  return getActiveChainId(walletChainId) || getDefaultChainId();
}
