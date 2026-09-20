/**
 * "Finish launch" for a Solana campaign whose second transaction never landed.
 *
 * A launch takes two transactions: create_campaign mints the supply, and
 * finalize_campaign_launch writes the Metaplex metadata, revokes the mint
 * authority and creates the fee accounts. Until the second lands the token has
 * no name in any wallet and cannot trade, because every trade path requires the
 * fee escrow.
 *
 * The launch flow sends it, but it does not always get there — a closed tab, a
 * dismissed prompt. Before this existed, a token in that state could only be
 * repaired by an operator running a script, which meant the creator was stuck
 * and had no way to see why. Now they can finish it themselves, from their own
 * wallet, for the cost of the rent.
 *
 * Deliberately not a keeper. A funded hot wallet sweeping unfinished launches
 * solves the same problem, but it is a wallet that can run dry at 3am and a key
 * that can leak. The creator already has both the wallet and the motivation.
 *
 * Renders nothing unless the campaign really is unfinished: the check is the
 * mint authority on chain via /api/solana/finalize-authorize, not a cached flag.
 */
import { useEffect, useState } from "react";
import { Loader2, Wrench } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/apiBase";
import {
  finalizeSolanaLaunch,
  type SolanaFinalizeLaunchAuthorization,
} from "@/lib/solanaFinalizeLaunchSubmit";

type Probe = {
  ok?: boolean;
  alreadyFinalized?: boolean;
  mintAddress?: string;
  authorization?: SolanaFinalizeLaunchAuthorization | null;
  error?: string;
};

export function FinishLaunchAction({
  campaignAddress,
  chainId,
  onFinished,
}: {
  campaignAddress?: string | null;
  chainId?: number | string | null;
  onFinished?: () => void;
}) {
  const [needsFinish, setNeedsFinish] = useState(false);
  const [pendingName, setPendingName] = useState("");
  const [programId, setProgramId] = useState("");
  const [busy, setBusy] = useState(false);

  const campaign = String(campaignAddress || "").trim();
  const isSolana = Number(chainId) === 101 || Number(chainId) === 102;

  useEffect(() => {
    let cancelled = false;
    if (!isSolana || !campaign) {
      setNeedsFinish(false);
      return;
    }

    void (async () => {
      try {
        const response = (await apiFetch("/api/solana/finalize-authorize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ campaignAddress: campaign }),
        })) as Probe;
        if (cancelled) return;

        // A campaign that is finished, or one the server cannot name, is not
        // something a creator can act on here. Stay silent rather than offering
        // a button that cannot work.
        if (!response?.ok || response.alreadyFinalized || !response.authorization) {
          setNeedsFinish(false);
          return;
        }
        setNeedsFinish(true);
        setPendingName(response.authorization.args?.name || "");
        setProgramId(
          String(import.meta.env.VITE_SOLANA_LAUNCHPAD_PROGRAM_ID || "").trim() ||
            "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt",
        );
      } catch {
        if (!cancelled) setNeedsFinish(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [campaign, isSolana]);

  if (!needsFinish) return null;

  const finish = async () => {
    setBusy(true);
    try {
      const result = await finalizeSolanaLaunch({ campaignAddress: campaign, programId });
      if (result) {
        toast.success("Launch finished. Your token is named and trading is open.", { duration: 10_000 });
      } else {
        toast.success("This launch was already finished.");
      }
      setNeedsFinish(false);
      onFinished?.();
    } catch (error: any) {
      toast.error(String(error?.message || "Could not finish this launch."), { duration: 12_000 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-orange-400/40 bg-orange-500/10 p-3">
      <div className="flex items-start gap-2">
        <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-orange-300" />
        <div className="min-w-0 flex-1">
          <p className="font-retro text-sm text-orange-200">This launch was never finished</p>
          <p className="mt-1 font-sans text-xs text-muted-foreground">
            The second transaction did not go through, so the token has no name in wallets and
            cannot trade yet. Finishing it costs about 0.003 SOL in rent.
            {pendingName ? (
              <>
                {" "}
                It will be named <span className="text-foreground">{pendingName}</span>.
              </>
            ) : null}
          </p>
          <Button
            type="button"
            size="sm"
            className="mt-2 font-retro"
            disabled={busy}
            onClick={() => void finish()}
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {busy ? "FINISHING…" : "FINISH LAUNCH"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default FinishLaunchAction;
