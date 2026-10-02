/** Major War League prize pool (read-only endpoint added in the UI redesign). */
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/apiBase";

export type MwlPrizePool = {
  chainId: number;
  month: string;
  quarter: string;
  available: boolean;
  /** true: the contract splits 60/40 monthly/quarterly (BNB, Robinhood). false: one vault pays both (Solana). */
  split: boolean | null;
  monthlyNative: number | null;
  quarterlyNative: number | null;
  combinedNative: number | null;
};

export function useMwlPrizePool(chainId: number | null | undefined, month: string | null) {
  return useQuery({
    queryKey: ["mwl-prize-pool", chainId, month],
    enabled: Boolean(chainId),
    queryFn: async () => {
      const qs = new URLSearchParams({ chainId: String(chainId) });
      if (month) qs.set("month", month);
      const res = await apiFetch(`/api/arena/mwl-prize-pool?${qs}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(String(data?.error || `Request failed (${res.status})`)), { status: res.status });
      return data as MwlPrizePool;
    },
    refetchInterval: 60_000,
    retry: (count, error: any) => error?.status !== 404 && count < 1,
    retryOnMount: false,
  });
}

export const MWL_NATIVE_SYMBOL: Record<number, string> = { 56: "BNB", 97: "BNB", 4663: "ETH", 46630: "ETH", 101: "SOL" };

export function formatPotNative(value: number | null | undefined, chainId: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  const symbol = MWL_NATIVE_SYMBOL[Number(chainId)] || "";
  const digits = value === 0 ? 0 : value < 0.01 ? 6 : value < 1 ? 4 : 3;
  return `${value.toLocaleString("en-US", { maximumFractionDigits: digits })} ${symbol}`.trim();
}
