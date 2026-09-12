import { useEffect, useMemo, useState } from "react";
import { Loader2, ShieldCheck, WalletCards } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { BNB_CHAIN_ID, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { claimProjectImport, requestProjectManualCheck, type ProjectImportItem } from "@/lib/projectImports";
import { resolveProjectEvmAuthority, resolveProjectXIdentity, startProjectXClaim, type ProjectEvmAuthority, type ProjectXIdentity } from "@/lib/projectImportXClaim";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { signWalletAction } from "@/lib/walletActionAuth";

const ROBINHOOD_CHAIN_ID = 4663;
function maskWallet(value?: string | null) { const v=String(value||""); return v.length>10?`${v.slice(0,6)}...${v.slice(-4)}`:v; }
function normalizeContactX(value: string) {
  const raw=String(value||"").trim();
  if(!raw)return "";
  const handle=raw.replace(/^@/,"");
  if(/^[A-Za-z0-9_]{1,15}$/.test(handle))return `https://x.com/${handle}`;
  try{
    const url=new URL(/^https?:\/\//i.test(raw)?raw:`https://${raw}`);
    const host=url.hostname.toLowerCase().replace(/^www\./,"");
    const username=String(url.pathname.split("/").filter(Boolean)[0]||"");
    if((host==="x.com"||host==="twitter.com")&&/^[A-Za-z0-9_]{1,15}$/.test(username))return `https://x.com/${username}`;
  }catch{}
  return "";
}

export default function ProjectXClaimDialog({ item, open, onOpenChange, onResolvedImage, onManualReviewRequested }: { item: ProjectImportItem; open: boolean; onOpenChange: (open: boolean) => void; onResolvedImage?: (imageUrl: string) => void; onManualReviewRequested?: (item: ProjectImportItem) => void }) {
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const isSolana = item.chainId === SOLANA_CHAIN_ID;
  const isEvm = item.chainId === BNB_CHAIN_ID || item.chainId === ROBINHOOD_CHAIN_ID;
  const eligible = (isSolana || isEvm) && item.ownershipStatus === "ownership_pending";
  const connectedWallet = isSolana ? solanaWallet.solanaAccount : wallet.account;
  const [identity, setIdentity] = useState<ProjectXIdentity | null>(null);
  const [authority, setAuthority] = useState<ProjectEvmAuthority | null>(null);
  const [creatorAuthority, setCreatorAuthority] = useState("");
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [manualX, setManualX] = useState("");

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
  useEffect(() => {
    const params=new URLSearchParams(window.location.search),result=params.get("claim"),claimError=params.get("claimError");
    if(result==="x_verified")toast.success("Project verified with the official X account.");
    if(result==="x_failed"){
      if(claimError==="PROJECT_IMPORT_X_ACCOUNT_MISMATCH"){
        toast.error("That X account does not match the project account attached to this token.");
        setError("The X account you authorized does not match the project X account. Use the correct account, verify the creator wallet, or request manual review below.");
      }else toast.error("X verification was not completed. Please try again.");
    }
  }, []);
  if (!eligible) return null;

  const signProjectAction = async (action: string) => {
    const walletAddress=String(connectedWallet||"").trim();
    if(!walletAddress) throw new Error(`Connect the ${isSolana?"Solana":"EVM"} wallet you want to use as the project controller first.`);
    return signWalletAction({
      action, walletAddress, chainId:item.chainId, walletType:isSolana?"solana":"evm",
      signMessage:isSolana?async(message)=>(await signSolanaMessage(message,walletAddress)).signature:undefined,
      signer:isSolana?undefined:wallet.signer,
    });
  };

  const verifyOwnerWallet = async () => {
    if (!canOwnerVerify) return;
    setStarting(true);
    try { const auth=await signProjectAction("project_import_claim"); await claimProjectImport({item,auth}); toast.success("Project verified with the contract owner wallet."); window.location.reload(); }
    catch(err:any){ toast.error(String(err?.message||"Owner-wallet verification failed.")); setStarting(false); }
  };

  const verifyPumpCreatorWallet = async () => {
    if (!isSolana) return;
    setStarting(true); setCreatorAuthority("");
    try { const auth=await signProjectAction("project_import_claim"); await claimProjectImport({item,auth}); toast.success("Project verified with the Pump.fun creator wallet."); window.location.reload(); }
    catch(err:any){
      const current=String(err?.currentAuthority||"");
      if(current)setCreatorAuthority(current);
      setError(String(err?.message||"Pump.fun creator-wallet verification failed."));
      toast.error(String(err?.message||"Pump.fun creator-wallet verification failed.")); setStarting(false);
    }
  };

  const connectOwnerWallet = async () => {
    try { await wallet.connect(); await refresh(); }
    catch(err:any){ toast.error(String(err?.message||"Could not connect the owner wallet.")); }
  };

  const verifyX = async () => {
    setStarting(true);
    try { const auth=await signProjectAction("project_import_claim"); const started=await startProjectXClaim(item,auth); window.location.assign(started.authorizeUrl); }
    catch(err:any){ toast.error(String(err?.message||"X verification could not start.")); setStarting(false); }
  };

  const requestManualReview = async () => {
    const contactX=normalizeContactX(manualX);
    if(!contactX){ toast.error("Enter a valid X handle or X profile URL so MemeWarzone can contact you."); return; }
    setStarting(true);
    try{
      const auth=await signProjectAction("project_import_manual_claim");
      const next=await requestProjectManualCheck({chainId:item.chainId,tokenAddress:item.tokenAddress,auth,note:`Contact X: ${contactX}`});
      toast.success("Manual ownership review requested. MemeWarzone can contact you through the X account you supplied.");
      onManualReviewRequested?.(next); onOpenChange(false);
    }catch(err:any){ toast.error(String(err?.message||"Manual review request failed.")); setStarting(false); }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md" data-project-x-claim-dialog="true">
      <DialogHeader><DialogTitle className="font-retro">CLAIM MEMECOIN</DialogTitle><DialogDescription>Are you the project owner? Verify ownership to manage this MemeWarzone project page.</DialogDescription></DialogHeader>
      {loading?<div className="flex items-center gap-2 py-5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin"/>Checking ownership options…</div>:<div className="space-y-4">
        {isEvm&&authority?.available?<div className="rounded-lg border border-white/10 bg-white/[0.03] p-4" data-project-owner-wallet-option="true">
          <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Contract owner wallet</div>
          <div className="mt-2 font-mono text-sm text-foreground">{maskWallet(authority.currentAuthority)}</div>
          {authority.matchesConnected?<><p className="mt-2 text-xs text-emerald-200">Your connected wallet matches the current contract owner.</p><Button type="button" className="mt-3 w-full" onClick={()=>void verifyOwnerWallet()} disabled={starting}>{starting?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:<WalletCards className="mr-2 h-4 w-4"/>}VERIFY OWNER WALLET</Button></>:<><p className="mt-2 text-xs text-muted-foreground">Connect this owner wallet to verify instantly, or use the official X account below.</p><Button type="button" variant="outline" className="mt-3 w-full" onClick={()=>void connectOwnerWallet()} disabled={starting}><WalletCards className="mr-2 h-4 w-4"/>CONNECT OWNER WALLET</Button></>}
        </div>:null}
        {isEvm&&authority&&!authority.available?<div className="rounded-lg border border-orange-400/20 bg-orange-500/[0.04] p-4 text-xs text-orange-100">No active owner()/getOwner() wallet is exposed by this contract. Use the official X account if available, or request manual review below.</div>:null}
        {isSolana?<div className="rounded-lg border border-white/10 bg-white/[0.03] p-4" data-pump-creator-wallet-option="true"><div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Pump.fun creator wallet</div><p className="mt-2 text-xs text-muted-foreground">If you control the original Pump.fun creator wallet, connect it and verify ownership directly.</p>{creatorAuthority?<p className="mt-2 text-xs text-amber-100">Recorded creator wallet: <span className="font-mono">{maskWallet(creatorAuthority)}</span></p>:null}<Button type="button" variant="outline" className="mt-3 w-full" onClick={()=>void verifyPumpCreatorWallet()} disabled={starting}>{starting?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:<WalletCards className="mr-2 h-4 w-4"/>}VERIFY CREATOR WALLET</Button></div>:null}
        {identity?<div className="rounded-lg border border-white/10 bg-white/[0.03] p-4" data-project-x-option="true"><div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Project X attached to token</div><div className="mt-2 flex items-center gap-2 font-bold text-foreground"><ShieldCheck className="h-4 w-4 text-accent"/>@{identity.username}</div><p className="mt-2 text-xs text-muted-foreground">Sign in to this exact X account to bind the project to your connected MemeWarzone wallet.</p><Button type="button" className="mt-3 w-full" onClick={()=>void verifyX()} disabled={starting}>{starting?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:null}VERIFY WITH X</Button></div>:<div className="rounded-lg border border-orange-400/20 bg-orange-500/[0.04] p-4 text-xs text-orange-100">No X account is attached to this token metadata. You can still verify the creator wallet or request manual review.</div>}
        {error?<p className="text-sm text-amber-100" role="alert">{error}</p>:null}
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4" data-project-manual-review-option="true"><div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Last resort — manual review</div><p className="mt-2 text-xs text-muted-foreground">If you cannot complete the automatic options, request an ownership review. You must give us an X account where the MemeWarzone team can contact you. This does not verify ownership automatically.</p>{manualOpen?<div className="mt-3 space-y-3"><Input value={manualX} onChange={(e)=>setManualX(e.target.value)} placeholder="@yourproject or https://x.com/yourproject" aria-label="Contact X account"/><Button type="button" className="w-full" onClick={()=>void requestManualReview()} disabled={starting}>{starting?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:null}SUBMIT MANUAL REVIEW</Button></div>:<Button type="button" variant="outline" className="mt-3 w-full" onClick={()=>setManualOpen(true)} disabled={starting}>REQUEST MANUAL REVIEW</Button>}</div>
        <p className="text-center text-xs text-muted-foreground">Not the owner? Close this window. The real owner can claim it later.</p>
      </div>}
    </DialogContent>
  </Dialog>;
}
