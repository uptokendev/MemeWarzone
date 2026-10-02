import { useQuery } from "@tanstack/react-query";
import { fetchUserProfile } from "@/lib/profileApi";
import { resolveImageUri } from "@/lib/media";

/**
 * The wallet's profile picture, for the composer avatar (founder, 2026-10-03). Profiles are saved per
 * chain: Solana wallets read chain 101, EVM wallets try BNB then Robinhood. Null when none is set.
 */
export function useWalletAvatar(wallet?: string | null) {
  const w = String(wallet || "").trim();
  return useQuery({
    queryKey: ["wallet-avatar", w],
    enabled: Boolean(w),
    staleTime: 5 * 60_000,
    retry: 0,
    queryFn: async () => {
      const chains = w.startsWith("0x") ? [56, 4663] : [101];
      for (const chainId of chains) {
        const p = await fetchUserProfile(chainId, w).catch(() => null);
        if (p?.avatarUrl) return resolveImageUri(p.avatarUrl) || p.avatarUrl;
      }
      return null;
    },
  }).data ?? null;
}
