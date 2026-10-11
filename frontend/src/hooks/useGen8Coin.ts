import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiBase";
import { gen8AppConfig, isGen8Coin } from "@/lib/evmGen8Client.mjs";

/** The API's coin-page state of a generation 8 coin (GET /api/evm/campaign-state, frontend/api/lib/evmGen8CampaignState.js). */
export type Gen8CoinState = {
  campaignAddress: string;
  token: string;
  creator: string;
  blockTimestamp: number;
  generation: { factoryGeneration: number; kind: string; factoryAddress?: string };
  tradeFee: {
    currentBps: number;
    bondingBps: number;
    postGraduationBps: number;
    antiSniperStartBps: number;
    antiSniperWindowSeconds: number;
    launchAt: number;
    antiSniperEndsAt: number;
    antiSniperActive: boolean;
  };
  graduation: { state: string; phase: "bonding" | "graduated"; progressBps: number | null; progressPct: number | null; sold: string | null; curveSupply: string | null };
  market: { sqrtPriceX96: string | null; priceNativeWeiPerCoin: string | null; priceNative: number | null; marketCapNativeWei: string | null };
  creatorClaims: {
    hookCreator: string;
    hookCreatorOwedWei: string | null;
    hookPendingCreator: string | null;
    feeChoice: { id: number | null; name: string; creatorPct: number | null; vault: string | null };
    vault: { address: string; creatorClaimableWei: string | null; holderPendingWei: string | null; buybackPendingWei: string | null; pendingCreator: string | null; error: string | null } | null;
    reserve: { address: string; amount: string; releasable: boolean; beneficiary: string | null } | null;
    escrow: { address: string; totalTokens: string | null; claimedTokens: string | null; claimableTokens: string | null } | null;
  };
  gen8: { poolId: string; poolKey: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }; hook: string; poolManager: string; lens: string | null; launcher: string; displayPair: string | null; tradePath: string; phase: "bonding" | "graduated" };
  viewer: { wallet: string; isCreator: boolean; canClaimHookCreatorFees: boolean; canClaimVaultFees: boolean; canAcceptCreator: boolean; canClaimEscrow: boolean } | null;
};

/**
 * Generation 8 coin state for the coin page, or null for every other coin. Only asked where the app has a gen-8 hook
 * configured for the chain (VITE_EVM_GEN8_HOOK_<id>), so other chains and generations make no extra request.
 * Refreshes every 15 s and on demand.
 */
export function useGen8Coin(chainId: number | null, address: string | null | undefined, account: string | null | undefined) {
  const [state, setState] = useState<Gen8CoinState | null>(null);
  const [tick, setTick] = useState(0);
  const enabled = Boolean(chainId && address && /^0x[0-9a-fA-F]{40}$/.test(String(address)) && gen8AppConfig(Number(chainId)));
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setState(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const qs = new URLSearchParams({ chainId: String(chainId), campaign: String(address) });
        if (account && /^0x[0-9a-fA-F]{40}$/.test(account)) qs.set("wallet", account);
        const res = await apiFetch(`/api/evm/campaign-state?${qs.toString()}`, { cache: "no-store" });
        const json = await res.json().catch(() => null);
        if (cancelled) return;
        setState(res.ok && json && isGen8Coin(json) && json.gen8 ? (json as Gen8CoinState) : null);
      } catch {
        if (!cancelled) setState((prev) => prev);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, chainId, address, account, tick]);

  return { state, refresh };
}

/** Seconds since epoch, ticking every second while `active`. */
export function useNowSeconds(active: boolean) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}
