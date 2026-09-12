import { useEffect, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import type { ProjectImportItem } from "@/lib/projectImports";
import { resolveProjectXIdentity, startProjectXClaim, type ProjectXIdentity } from "@/lib/projectImportXClaim";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { signWalletAction } from "@/lib/walletActionAuth";

export default function ProjectXClaimDialog({ item }: { item: ProjectImportItem }) {
  const solanaWallet = useSolanaWallet();
  const eligible = item.chainId === SOLANA_CHAIN_ID && item.ownershipStatus === "ownership_pending";
  const [open, setOpen] = useState(eligible);
  const [identity, setIdentity] = useState<ProjectXIdentity | null>(null);
  const [loading, setLoading] = useState(eligible);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!eligible) return;
    let cancelled = false;
    setOpen(true);
    setLoading(true);
    setError("");
    void resolveProjectXIdentity(item)
      .then((next) => { if (!cancelled) setIdentity(next); })
      .catch((err: any) => {
        if (cancelled) return;
        const code = String(err?.code || "");
        setError(code === "PROJECT_IMPORT_X_NOT_FOUND"
          ? "No official X account is attached to this Pump.fun token yet."
          : String(err?.message || "Official X account could not be resolved."));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [eligible, item.id, item.tokenAddress]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("claim");
    if (result === "x_verified") toast.success("Project verified with the official X account.");
    if (result === "x_failed") toast.error("X verification was not completed. Please try again.");
  }, []);

  if (!eligible) return null;

  const verify = async () => {
    const walletAddress = String(solanaWallet.solanaAccount || "").trim();
    if (!walletAddress) {
      toast.error("Connect the Solana wallet you want to use as the project controller first.");
      return;
    }
    setStarting(true);
    try {
      // Reuse the same shared nonce-backed wallet action + signSolanaMessage flow
      // already used by working MemeWarzone features. OAuth proves X control;
      // this signature binds that proof to the connected MWZ wallet.
      const auth = await signWalletAction({
        action: "project_import_claim",
        walletAddress,
        chainId: item.chainId,
        walletType: "solana",
        signMessage: async (message) => (await signSolanaMessage(message, walletAddress)).signature,
      });
      const started = await startProjectXClaim(item, auth);
      window.location.assign(started.authorizeUrl);
    } catch (err: any) {
      toast.error(String(err?.message || "X verification could not start."));
      setStarting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md" data-project-x-claim-dialog="true">
        <DialogHeader>
          <DialogTitle className="font-retro">CLAIM THIS MEMECOIN</DialogTitle>
          <DialogDescription>
            Verify the official X account attached to this Pump.fun project. This gives your connected MemeWarzone wallet control of the project page.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin"/>Finding the official Pump.fun X account…</div>
        ) : identity ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
              <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Official X account</div>
              <div className="mt-2 flex items-center gap-2 font-bold text-foreground"><ShieldCheck className="h-4 w-4 text-accent"/>@{identity.username}</div>
              <p className="mt-2 text-xs text-muted-foreground">Resolved from the Pump.fun token metadata. You cannot substitute another X account.</p>
            </div>
            <Button type="button" className="w-full" onClick={() => void verify()} disabled={starting} data-project-x-verify="true">
              {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin"/> : null}
              VERIFY WITH X
            </Button>
            <p className="text-center text-xs text-muted-foreground">You can close this window and claim the project later.</p>
          </div>
        ) : (
          <div className="space-y-3 py-2">
            <p className="text-sm text-amber-100">{error || "No official X account could be found for this Pump.fun project."}</p>
            <p className="text-xs text-muted-foreground">The token remains imported and public. X verification can be added later without affecting the import.</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
