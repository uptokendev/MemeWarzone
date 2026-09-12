import { useEffect, useMemo, useState } from "react";
import { Loader2, ShieldCheck, WalletCards } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { BNB_CHAIN_ID, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { claimProjectImport, type ProjectImportItem } from "@/lib/projectImports";
import { resolveProjectEvmAuthority, resolveProjectXIdentity, startProjectXClaim, type ProjectEvmAuthority, type ProjectXIdentity } from "@/lib/projectImportXClaim";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { signWalletAction } from "@/lib/walletActionAuth";

const ROBINHOOD_CHAIN_ID = 4663;
function maskWallet(value?: string | null) { const v=String(value||""); return v.length>10?`${v.slice(0,6)}...${v.slice(-4)}`:v; }

export default function ProjectXClaimDialog({ item, open, onOpenChange, onResolvedImage }: { item: ProjectImportItem; open: boolean; onOpenChange: (open: boolean) => void; onResolvedImage?: (imageUrl: string) => void }) {
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const isSolana = item.chainId === SOLANA_CHAIN_ID;
  const isEvm = item.chainId === BNB_CHAIN_ID || item.chainId === ROBINHOOD_CHAIN_ID;
  const eligible = (isSolana || isEvm) && item.ownershipStatus === "ownership_pending";
  const connectedWallet = isSolana ? solanaWallet.solanaAccount : wallet.account;
  const [identity, setIdentity] = useState<ProjectXIdentity | null>(null);
  const [authority, setAuthority] = useState<ProjectEvmAuthority | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  const canOwnerVerify = useMemo(() => Boolean(isEvm && authority?.available && authority.matchesConnected && connectedWallet), [isEvm, authority, connectedWallet]);

  const refresh = async () => {
    if (!eligible) return;
    setLoading(true); setError("");
    const tasks: Promise<void>[] = [];
    if (isEvm) tasks.push(resolveProjectEvmAuthority(item, connectedWallet).then(setAuthority).catch((err:any)=>setError(String(err?.message||"Current owner wallet could not be resolved."))));
    tasks.push(resolveProjectXIdentity(item).then((resolved)=>{ setIdentity(resolved); if(resolved.imageUrl) onResolvedImage?.(resolved.imageUrl); }).catch((err:any)=>{
      const code=String(err?.code||"");
      if(code!=="PROJECT_IMPORT_X_NOT_FOUND") setError((prev)=>prev||String(err?.message||"Official X account could not be resolved."));
      setIdentity(null);
    }));
    await Promise.allSettled(tasks); setLoading(false);
  };

  useEffect(() => { if (open && eligible) void refresh(); }, [open, eligible, item.id, item.tokenAddress, item.chainId, connectedWallet]);
  useEffect(() => { const params=new URLSearchParams(window.location.search);const result=params.get("claim");if(result==="x_verified")toast.success("Project verified with the official X account.");if(result==="x_failed")toast.error("X verification was not completed. Please try again."); }, []);
  if (!eligible) return null;

  const signClaim = async () => {
    const walletAddress=String(connectedWallet||"").trim();
    if(!walletAddress) throw new Error(`Connect the ${isSolana?"Solana":"EVM"} wallet you want to use as the project controller first.`);
    return signWalletAction({
      action:"project_import_claim", walletAddress, chainId:item.chainId, walletType:isSolana?"solana":"evm",
      signMessage:isSolana?async(message)=>(await signSolanaMessage(message,walletAddress)).signature:undefined,
      signer:isSolana?undefined:wallet.signer,
    });
  };

  const verifyOwnerWallet = async () => {
    if (!canOwnerVerify) return;
    setStarting(true);
    try { const auth=await signClaim(); await claimProjectImport({item,auth}); toast.success("Project verified with the contract owner wallet."); window.location.reload(); }
    catch(err:any){ toast.error(String(err?.message||"Owner-wallet verification failed.")); setStarting(false); }
  };

  const connectOwnerWallet = async () => {
    try { await wallet.connect(); await refresh(); }
    catch(err:any){ toast.error(String(err?.message||"Could not connect the owner wallet.")); }
  };

  const verifyX = async () => {
    setStarting(true);
    try { const auth=await signClaim(); const started=await startProjectXClaim(item,auth); window.location.assign(started.authorizeUrl); }
    catch(err:any){ toast.error(String(err?.message||"X verification could not start.")); setStarting(false); }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md" data-project-x-claim-dialog="true">
      <DialogHeader><DialogTitle className="font-retro">CLAIM MEMECOIN</DialogTitle><DialogDescription>Are you the project owner? Verify ownership to manage this MemeWarzone project page.</DialogDescription></DialogHeader>
      {loading?<div className="flex items-center gap-2 py-5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin"/>Checking ownership options…</div>:<div className="space-y-4">
        {isEvm&&authority?.available?<div className="rounded-lg border border-white/10 bg-white/[0.03] p-4" data-project-owner-wallet-option="true">
          <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Contract owner wallet</div>
          <div className="mt-2 font-mono text-sm text-foreground">{maskWallet(authority.currentAuthority)}</div>
          {authority.matchesConnected?<><p className="mt-2 text-xs text-emerald-200">Your connected wallet matches the current contract owner.</p><Button type="button" className="mt-3 w-full" onClick={()=>void verifyOwnerWallet()} disabled={starting}>{starting?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:<WalletCards className="mr-2 h-4 w-4"/>}VERIFY OWNER WALLET</Button></>:<><p className="mt-2 text-xs text-muted-foreground">Connect this owner wallet to verify instantly, or use the official X account below.</p><Button type="button" variant="outline" className="mt-3 w-full" onClick={()=>void connectOwnerWallet()} disabled={starting}><WalletCards className="mr-2 h-4 w-4"/>CONNECT OWNER WALLET</Button></>}
        </div>:null}
        {isEvm&&authority&&!authority.available?<div className="rounded-lg border border-orange-400/20 bg-orange-500/[0.04] p-4 text-xs text-orange-100">No active owner()/getOwner() wallet is exposed by this contract. Verify with the official X account instead.</div>:null}
        {identity?<div className="rounded-lg border border-white/10 bg-white/[0.03] p-4" data-project-x-option="true"><div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Official project X</div><div className="mt-2 flex items-center gap-2 font-bold text-foreground"><ShieldCheck className="h-4 w-4 text-accent"/>@{identity.username}</div><p className="mt-2 text-xs text-muted-foreground">Sign in to this exact X account to bind the project to your connected MemeWarzone wallet.</p><Button type="button" className="mt-3 w-full" onClick={()=>void verifyX()} disabled={starting}>{starting?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:null}VERIFY WITH X</Button></div>:null}
        {!identity&&!authority?.available?<div className="space-y-2"><p className="text-sm text-amber-100">{error||"No automatic ownership route is available for this project yet."}</p><p className="text-xs text-muted-foreground">The token stays imported and public. No ownership is granted without proof.</p></div>:null}
        <p className="text-center text-xs text-muted-foreground">Not the owner? Close this window. The real owner can claim it later.</p>
      </div>}
    </DialogContent>
  </Dialog>;
}
