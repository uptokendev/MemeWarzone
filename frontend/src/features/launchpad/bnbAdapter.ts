import { apiFetch } from "@/lib/apiBase";
import { getDefaultChainId } from "@/lib/chainConfig";
import type { LaunchpadAdapter, LaunchpadAdapterStatus, LaunchpadTradePreflight, TradeSide } from "@/features/launchpad/adapters";
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

function normalizePreflight(payload: any, side: TradeSide, options?: { campaignOnly?: boolean }): LaunchpadTradePreflight {
  const preflight = payload?.preflight && typeof payload.preflight === "object" ? payload.preflight : payload;
  const warnings = Array.isArray(preflight?.warnings) ? preflight.warnings.map(String) : [];
  if (options?.campaignOnly) warnings.push("Connect a BNB wallet to add wallet-specific risk checks.");
  return {
    allowed: Boolean(preflight?.allowed),
    chain: "bnb",
    side,
    reasons: Array.isArray(preflight?.reasons) ? preflight.reasons.map(String) : [],
    warnings,
    schemaReady: preflight?.schemaReady,
    campaign: preflight?.campaign || null,
    walletRisk: options?.campaignOnly ? null : preflight?.walletRisk || null,
    cluster: options?.campaignOnly ? null : preflight?.cluster || null,
    lookupErrors: Array.isArray(preflight?.lookupErrors) ? preflight.lookupErrors.map(String) : [],
  };
}

export function createBnbLaunchpadAdapter(): LaunchpadAdapter {
  return {
    chain: "bnb",

    async getStatus(): Promise<LaunchpadAdapterStatus> {
      const [security, routing] = await Promise.all([
        readJson<any>("/api/security/status", {}),
        readJson<any>("/api/routing/status", {}),
      ]);

      const paused = security?.paused || {};
      const warnings: string[] = [];
      if (paused.global) warnings.push("BNB launchpad is currently paused by security controls.");
      if (paused.create) warnings.push("New BNB campaign creation is paused.");
      if (paused.buys) warnings.push("One or more BNB campaign buy paths are paused.");
      if (paused.sells) warnings.push("One or more BNB campaign sell paths are paused.");
      if (security?.bnbContractSync === "pending") warnings.push("Security updates are syncing to contracts.");
      if (security?.schemaReady === false) warnings.push("Security checks are running in limited mode.");

      const routeReady = Boolean(
        routing?.ready ??
        routing?.enabled ??
        routing?.routeAuthority ??
        routing?.routeAuthorityAddress
      );

      return {
        chain: "bnb",
        protocolLive: true,
        label: "BNB launchpad",
        message: "Campaign safety checks are active. Wallet-specific checks are added after a BNB wallet is connected.",
        routeAuthorizationReady: routeReady,
        warnings,
      };
    },

    async preflightTrade({ side, walletAddress, campaignAddress, chainId }): Promise<LaunchpadTradePreflight> {
      const wallet = normalizeEvmAddress(walletAddress);
      const campaign = normalizeEvmAddress(campaignAddress);
      const resolvedChainId = Number(chainId);
      const tradeChainId = resolvedChainId === 97 || resolvedChainId === 56 ? resolvedChainId : getDefaultChainId();
      if (!campaign) {
        return {
          allowed: false,
          chain: "bnb",
          side,
          reasons: ["Token campaign address is missing or invalid."],
          warnings: [],
        };
      }

      // Passive TokenDetails safety UI must not hit preflight with a dummy wallet.
      // That path was spamming creator-protection dialogs for every visitor.
      if (!wallet) {
        return {
          allowed: true,
          chain: "bnb",
          side,
          reasons: [],
          warnings: ["Connect a BNB wallet to run the creator buy lock check."],
        };
      }

      const endpoint = side === "buy" ? "/api/launchpad/preflight-buy" : "/api/launchpad/preflight-sell";
      const payload = await postJson<any>(
        endpoint,
        { walletAddress: wallet, campaignAddress: campaign, chainId: tradeChainId },
        { preflight: null },
      );
      return normalizePreflight(payload, side, { campaignOnly: false });
    },
  };
}
