import { apiFetch } from "@/lib/apiBase";
import {
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
} from "@/lib/chainConfig";
import type {
  LaunchpadAdapter,
  LaunchpadAdapterStatus,
  LaunchpadTradePreflight,
  TradeSide,
} from "@/features/launchpad/adapters";
import { normalizeEvmAddress } from "@/features/launchpad/adapters";

async function readJson<T>(path: string, fallback: T, init?: RequestInit): Promise<T> {
  try {
    const response = await apiFetch(path, {
      cache: "no-store",
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.headers || {}),
      },
    });
    const payload = await response.json().catch(() => null);
    if (payload && typeof payload === "object") return payload as T;
    return fallback;
  } catch {
    return fallback;
  }
}

async function postJson<T>(path: string, body: Record<string, unknown>, fallback: T): Promise<T> {
  return readJson<T>(path, fallback, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function normalizePreflight(payload: any, side: TradeSide): LaunchpadTradePreflight {
  const preflight = payload?.preflight && typeof payload.preflight === "object" ? payload.preflight : payload;
  return {
    allowed: Boolean(preflight?.allowed),
    chain: "robinhood",
    side,
    reasons: Array.isArray(preflight?.reasons) ? preflight.reasons.map(String) : [],
    warnings: Array.isArray(preflight?.warnings) ? preflight.warnings.map(String) : [],
    schemaReady: preflight?.schemaReady,
    campaign: preflight?.campaign || null,
    walletRisk: preflight?.walletRisk || null,
    cluster: preflight?.cluster || null,
    lookupErrors: Array.isArray(preflight?.lookupErrors) ? preflight.lookupErrors.map(String) : [],
  };
}

function resolveRobinhoodChainId(value?: number | string | null): number {
  const chainId = Number(value);
  if (chainId === ROBINHOOD_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID) return chainId;
  // Fail closed to the currently staged product chain; never borrow 56/97.
  return ROBINHOOD_TESTNET_CHAIN_ID;
}

export function createRobinhoodLaunchpadAdapter(): LaunchpadAdapter {
  return {
    chain: "robinhood",

    async getStatus(): Promise<LaunchpadAdapterStatus> {
      const [security, routing] = await Promise.all([
        readJson<any>("/api/security/status", {}),
        readJson<any>("/api/routing/status", {}),
      ]);

      const paused = security?.paused || {};
      const warnings: string[] = [];
      if (paused.global) warnings.push("Robinhood launchpad is currently paused by security controls.");
      if (paused.create) warnings.push("New Robinhood campaign creation is paused.");
      if (paused.buys) warnings.push("One or more Robinhood campaign buy paths are paused.");
      if (paused.sells) warnings.push("One or more Robinhood campaign sell paths are paused.");
      if (security?.schemaReady === false) warnings.push("Security checks are running in limited mode.");

      const routeReady = Boolean(
        routing?.ready ??
        routing?.enabled ??
        routing?.routeAuthority ??
        routing?.routeAuthorityAddress,
      );

      return {
        chain: "robinhood",
        protocolLive: true,
        label: "Robinhood launchpad",
        message: "Campaign safety checks are active. Wallet-specific checks use the selected Robinhood chain.",
        routeAuthorizationReady: routeReady,
        warnings,
      };
    },

    async preflightTrade({ side, walletAddress, campaignAddress, chainId }): Promise<LaunchpadTradePreflight> {
      const wallet = normalizeEvmAddress(walletAddress);
      const campaign = normalizeEvmAddress(campaignAddress);
      const tradeChainId = resolveRobinhoodChainId(chainId);

      if (!campaign) {
        return {
          allowed: false,
          chain: "robinhood",
          side,
          reasons: ["Token campaign address is missing or invalid."],
          warnings: [],
        };
      }

      if (!wallet) {
        return {
          allowed: true,
          chain: "robinhood",
          side,
          reasons: [],
          warnings: ["Connect a Robinhood wallet to run wallet-specific creator and cluster protection checks."],
        };
      }

      const endpoint = side === "buy" ? "/api/launchpad/preflight-buy" : "/api/launchpad/preflight-sell";
      const payload = await postJson<any>(
        endpoint,
        { walletAddress: wallet, campaignAddress: campaign, chainId: tradeChainId },
        { preflight: null },
      );
      return normalizePreflight(payload, side);
    },
  };
}
