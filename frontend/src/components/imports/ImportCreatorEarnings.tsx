import { useEffect, useState } from "react";

import { cp } from "@/components/token/coinPageStyles";
import { Button } from "@/components/ui/button";
import { fetchImportCreatorFees, formatCreatorAmount, hasAmount, type ImportCreatorFees } from "@/lib/importCreatorFees";

const shortWallet = (wallet: string) => (wallet.length > 12 ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : wallet);
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * Creator earnings from the import swap fee (half of 1%). Unclaimed coin: what the creator has
 * earned so far, with the existing claim button. Claimed coin: waiting / paid and when payouts start.
 * Renders nothing while there is nothing earned.
 */
export function ImportCreatorEarnings({ chainId, tokenAddress, canClaim, onClaim }: { chainId: number; tokenAddress: string; canClaim: boolean; onClaim?: () => void }) {
  const [fees, setFees] = useState<ImportCreatorFees | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchImportCreatorFees(chainId, tokenAddress, controller.signal).then(setFees).catch(() => setFees(null));
    return () => controller.abort();
  }, [chainId, tokenAddress]);

  if (!fees?.available) return null;
  const decimals = fees.decimals ?? 9;
  const asset = fees.asset || "";
  const pending = (BigInt(fees.waitingRaw || "0") + BigInt(fees.payingRaw || "0")).toString();

  if (!fees.claimed) {
    if (!canClaim || !hasAmount(fees.waitingRaw)) return null;
    return (
      <section className={`${cp.card} border-[#5A3416] bg-mw-accent-fill p-4 md:p-5`} data-import-creator-earnings="unclaimed">
        <h2 className={`${cp.title} m-0`}>The creator of this coin has earned {formatCreatorAmount(fees.waitingRaw, decimals, asset)}</h2>
        <p className="mt-2 text-sm text-mw-muted">
          Every swap of this coin on MemeWarzone pays 1%. Half goes to the coin&apos;s creator. Claim the coin to collect it: payouts start {fees.holdDays ?? 7} days after the claim is verified and go to the wallet that claimed. Each trade&apos;s share is kept for {fees.windowDays ?? 90} days.
        </p>
        {onClaim ? (
          <Button type="button" className={`${cp.btn} mt-3 border-mw-accent bg-mw-accent text-[#140A02] hover:bg-[#FF8F3D] hover:text-[#140A02]`} onClick={onClaim} data-import-creator-claim="true">CLAIM MEMECOIN</Button>
        ) : null}
      </section>
    );
  }

  if (!hasAmount(pending) && !hasAmount(fees.paidRaw)) return null;
  return (
    <section className={`${cp.card} p-4`} data-import-creator-earnings="claimed">
      <h2 className={`${cp.title} m-0`}>Creator earnings</h2>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-mw-muted">Waiting</dt>
        <dd className="m-0 text-right font-mw-mono">{formatCreatorAmount(pending, decimals, asset)}</dd>
        <dt className="text-mw-muted">Paid</dt>
        <dd className="m-0 text-right font-mw-mono">{formatCreatorAmount(fees.paidRaw, decimals, asset)}</dd>
      </dl>
      <p className="mb-0 mt-2 text-xs text-mw-muted">
        Half of the 1% swap fee, paid automatically to {fees.ownerWallet ? shortWallet(fees.ownerWallet) : "the verified owner"}
        {fees.payoutsOpen || !fees.payoutsFrom ? "." : ` from ${day(fees.payoutsFrom)}.`}
      </p>
    </section>
  );
}
