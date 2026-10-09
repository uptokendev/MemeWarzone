import { useEffect, useState } from "react";

import { fetchImportCreatorFees, formatCreatorAmount, hasAmount, type ImportCreatorFees } from "@/lib/importCreatorFees";

/**
 * Small orange pill under an unclaimed imported coin's name: what its creator has earned from the 1% swap
 * fee so far (half of it). Clicking it opens the existing claim flow. Claimed coins show nothing here; their
 * owner sees the earnings in Command Center, Claims (ImportCreatorFeesPanel).
 */
export function ImportCreatorEarnings({ chainId, tokenAddress, canClaim, onClaim }: { chainId: number; tokenAddress: string; canClaim: boolean; onClaim?: () => void }) {
  const [fees, setFees] = useState<ImportCreatorFees | null>(null);

  useEffect(() => {
    if (!canClaim) return;
    const controller = new AbortController();
    void fetchImportCreatorFees(chainId, tokenAddress, controller.signal).then(setFees).catch(() => setFees(null));
    return () => controller.abort();
  }, [chainId, tokenAddress, canClaim]);

  if (!canClaim || !fees?.available || fees.claimed || !hasAmount(fees.waitingRaw)) return null;
  const amount = formatCreatorAmount(fees.waitingRaw, fees.decimals ?? 9, fees.asset || "");
  return (
    <button
      type="button"
      onClick={onClaim}
      className="mt-1.5 inline-flex w-fit items-center gap-1.5 rounded-full border border-mw-accent bg-[#2A1609] px-2.5 py-0.5 text-xs font-semibold text-mw-accent-soft hover:bg-[#3A1E0C] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mw-accent"
      title={`Half of the 1% fee on every swap of this coin goes to its creator. Kept ${fees.windowDays ?? 90} days per trade.`}
      data-import-creator-earnings="pill"
    >
      Creator earned {amount} · Claim it
    </button>
  );
}
