import { useEffect, useMemo, useState } from "react";
import Create from "@/pages/Create";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { apiFetch } from "@/lib/apiBase";
import { getActiveChainId, getChainLabel, ROBINHOOD_CHAIN_ID, SOLANA_CHAIN_ID } from "@/lib/chainConfig";

type LaunchChainReadiness = {
  chainId: number;
  supportEnabled: boolean;
  creationEnabled: boolean;
  runtimeReady: boolean;
  creationReady: boolean;
  reason?: string;
  readyForCoreFlow?: boolean;
};

export function CreateChainReadinessGate() {
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const chainId = useMemo(() => {
    const solanaSelected = Boolean(
      solanaWallet.isSolanaConnected && solanaWallet.solanaAccount &&
      (getActiveChainId(wallet.chainId) === SOLANA_CHAIN_ID || !wallet.isConnected)
    );
    return solanaSelected ? SOLANA_CHAIN_ID : getActiveChainId(wallet.chainId);
  }, [solanaWallet.isSolanaConnected, solanaWallet.solanaAccount, wallet.chainId, wallet.isConnected]);

  const [state, setState] = useState<{ loading: boolean; readiness: LaunchChainReadiness | null }>({ loading: true, readiness: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, readiness: null });
    apiFetch(`/api/routing/status?chainId=${encodeURIComponent(String(chainId))}`, { method: "GET", cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (cancelled) return;
        setState({
          loading: false,
          readiness: {
            chainId,
            supportEnabled: body?.supportEnabled === true,
            creationEnabled: body?.creationEnabled === true,
            runtimeReady: body?.runtimeReady === true,
            creationReady: body?.creationReady === true && body?.readyForCoreFlow === true,
            readyForCoreFlow: body?.readyForCoreFlow === true,
            reason: String(body?.readinessReason || body?.reason || "unavailable"),
          },
        });
      })
      .catch(() => { if (!cancelled) setState({ loading: false, readiness: null }); });
    return () => { cancelled = true; };
  }, [chainId]);

  if (state.loading) {
    return <div className="mx-auto max-w-3xl p-6 text-sm text-muted-foreground" data-testid="creation-readiness-loading">Checking launch readiness…</div>;
  }

  if (!state.readiness?.creationReady) {
    const robinhood = chainId === ROBINHOOD_CHAIN_ID;
    return (
      <div className="mx-auto max-w-3xl p-6" data-testid="creation-readiness-blocked">
        <div className="rounded-xl border border-orange-400/30 bg-orange-500/5 p-5">
          <h1 className="font-retro text-xl text-foreground">{robinhood ? "Robinhood launching soon" : `${getChainLabel(chainId)} creation unavailable`}</h1>
          <p className="mt-2 text-sm text-muted-foreground">New creator deployment is disabled until the chain runtime is fully deployed and enabled. Wallet, read-only and historical support remain available.</p>
        </div>
      </div>
    );
  }

  return <Create />;
}
