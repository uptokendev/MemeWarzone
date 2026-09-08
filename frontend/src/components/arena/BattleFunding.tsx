import { useEffect, useState } from "react";
import { ArenaStakeButton } from "@/components/arena/ArenaStakeButton";
import { ArenaWarPoolClaimButton } from "@/components/arena/ArenaWarPoolClaimButton";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { fetchArenaStakeStatus } from "@/features/postgrad/apiClient";
import { presentBattleFundingStatus } from "@/lib/arena/battleWallMorePresentation.mjs";

export function BattleFunding({
  battleId,
  chainId,
  battleState,
  showFunding,
  showClaim,
  claimBlockedReason,
}: {
  battleId: string;
  chainId?: number;
  battleState?: string;
  showFunding?: boolean;
  showClaim?: boolean;
  claimBlockedReason?: string | null;
}) {
  const wallet = useWallet();
  const { solanaAccount } = useSolanaWallet();
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!showFunding || !battleId) {
      setStatus(null);
      return;
    }
    const controller = new AbortController();
    void fetchArenaStakeStatus(battleId, solanaAccount || wallet.account || "", controller.signal)
      .then((json) => setStatus(json || null))
      .catch(() => setStatus(null));
    return () => controller.abort();
  }, [battleId, showFunding, solanaAccount, wallet.account]);

  const funding = showFunding ? presentBattleFundingStatus(status) : null;
  if (!showFunding && !showClaim && !claimBlockedReason) return null;

  return (
    <section data-battle-funding="true" className="space-y-3">
      <div className="text-[10px] uppercase tracking-[0.24em] text-white/45">Owner actions</div>
      {funding ? (
        <div className="text-xs uppercase tracking-[0.16em] text-white/70" data-battle-funding-status={funding.deployed}>
          {funding.label}
        </div>
      ) : null}
      {showFunding ? (
        <ArenaStakeButton battleId={battleId} chainId={chainId} battleState={battleState} />
      ) : null}
      {showClaim ? <ArenaWarPoolClaimButton battleId={battleId} chainId={chainId} /> : null}
      {claimBlockedReason ? (
        <div data-battle-claim-generation-pending="true" className="text-xs text-white/55">
          {claimBlockedReason}
        </div>
      ) : null}
    </section>
  );
}
