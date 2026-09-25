import { useEffect, useState } from "react";

import { fetchArenaStakeStatus } from "@/features/postgrad/apiClient";
import { fetchBattleBoostState } from "@/lib/arena/battleBoostClient";

// Competition V2 (arena_competition_v2): 75% of entries and 90% of Boosts go to the prize pool; the
// Boost share is already split server-side (summary.total.poolNativeRaw).
const ENTRY_PRIZE_BPS = 7_500n;

export type BattlePrizePool = { raw: bigint; decimals: number; symbol: string };

function toBig(value: unknown): bigint {
  try {
    return BigInt(String(value ?? "0").split(".")[0] || "0");
  } catch {
    return 0n;
  }
}

export function formatPrizePool(pool: BattlePrizePool): string {
  const scale = 10 ** pool.decimals;
  const value = Number(pool.raw) / scale;
  const digits = value >= 100 ? 2 : value >= 1 ? 3 : 4;
  return `${value.toFixed(digits).replace(/\.?0+$/, "")} ${pool.symbol}`;
}

/** Live prize pool for a funded battle: paid entries × 75% + the pool share of confirmed Boosts. */
export function useBattlePrizePool(battleId: string, chainId: number, enabled: boolean): BattlePrizePool | null {
  const [pool, setPool] = useState<BattlePrizePool | null>(null);
  useEffect(() => {
    if (!enabled || !battleId) {
      setPool(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const [stake, boosts] = await Promise.all([
          fetchArenaStakeStatus(battleId).catch(() => null) as Promise<Record<string, unknown> | null>,
          fetchBattleBoostState(battleId).catch(() => null),
        ]);
        if (cancelled || !stake || stake.ok === false) return;
        const paid = (stake.paidA === true ? 1n : 0n) + (stake.paidB === true ? 1n : 0n);
        const entryRaw = toBig(stake.stakeWei) * paid;
        const boostPoolRaw = toBig((boosts as { summary?: { total?: { poolNativeRaw?: string } } } | null)?.summary?.total?.poolNativeRaw);
        const decimals = Number(chainId) === 101 || Number(chainId) === 102 ? 9 : 18;
        setPool({ raw: (entryRaw * ENTRY_PRIZE_BPS) / 10_000n + boostPoolRaw, decimals, symbol: String(stake.nativeSymbol || "") });
      } catch {
        // keep the last value
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [battleId, chainId, enabled]);
  return pool;
}
