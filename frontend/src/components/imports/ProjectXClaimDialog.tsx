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

export default function ProjectXClaimDialog({ item, open, onOpenChange }: { item: ProjectImportItem; open: boolean; onOpenChange: (open: boolean) => void }) {
  const solanaWallet = useSolanaWallet();
  const eligible = item.chainId === SOLANA_CHAIN_ID && item.ownershipStatus === "ownership_pending";
  const [identity, setIdentity] = useState<ProjectXIdentity | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!eligible || !open) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    void resolveProjectXIdentity(item)
      .then((next) => { if (!cancelled) setIdentity(next); })
      .catch((err: any) => {
        if (cancelled) return;
        setIdentity(null);
        const code = String(err?.code || "");
        setError(code === "PROJECT_IMPORT_X_NOT_FOUND"
          ? "No official X account is attached to this Pump.fun token yet."
          : String(err?.message || "Official X account could not be resolved."));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [eligible, item.id, item.tokenAddress, open]);

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-project-x-claim-dialog="true">
        <DialogHeader>
          <DialogTitle className="font-retro">CLAIM MEMECOIN</DialogTitle>
          <DialogDescription>
            Are you the project owner? Claim this memecoin to verify the project and manage its MemeWarzone page.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin"/>Checking the project's official X account…</div>
        ) : identity ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
              <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Project X</div>
              <div className="mt-2 flex items-center gap-2 font-bold text-foreground"><ShieldCheck className="h-4 w-4 text-accent"/>@{identity.username}</div>
              <p className="mt-2 text-xs text-muted-foreground">We'll ask you to sign in to this X account, then bind the verified project to your connected MemeWarzone wallet.</p>
            </div>
            <Button type="button" className="w-full" onClick={() => void verify()} disabled={starting} data-project-x-verify="true">
              {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin"/> : null}
              CLAIM MEMECOIN
            </Button>
            <p className="text-center text-xs text-muted-foreground">Not the owner? Close this window. The token stays public and the real owner can claim it later.</p>
          </div>
        ) : (
          <div className="space-y-3 py-2">
            <p className="text-sm text-amber-100">{error || "No official X account could be found for this Pump.fun project."}</p>
            <p className="text-xs text-muted-foreground">The token remains imported and public. The project can be claimed later when an official verification route is available.</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
