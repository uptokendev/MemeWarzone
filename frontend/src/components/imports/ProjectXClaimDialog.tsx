import { useEffect, useMemo, useState } from "react";
import { Loader2, ShieldCheck, WalletCards } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { BNB_CHAIN_ID, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { checkPumpOwnershipChallenge, claimProjectImport, requestProjectManualCheck, startEvmTransferChallenge, startPumpOwnershipChallenge, type EvmTransferChallenge, type ProjectImportItem, type PumpOwnershipChallenge } from "@/lib/projectImports";
import { parseCreationTxInput, resolveProjectEvmAuthority, resolveProjectXIdentity, startProjectXClaim, type ProjectEvmAuthority, type ProjectXIdentity } from "@/lib/projectImportXClaim";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { signWalletAction } from "@/lib/walletActionAuth";

const ROBINHOOD_CHAIN_ID = 4663;
function maskWallet(value?: string | null) { const v=String(value||""); return v.length>10?`${v.slice(0,6)}...${v.slice(-4)}`:v; }
function formatWei(wei: string) { const v=BigInt(wei||"0"); const whole=v/10n**18n, frac=(v%10n**18n).toString().padStart(18,"0").replace(/0+$/,""); return frac?`${whole}.${frac}`:`${whole}`; }
function explorerAddressUrl(chainId: number, address: string) { return chainId === ROBINHOOD_CHAIN_ID ? `https://robinhoodchain.blockscout.com/address/${address}` : `https://bscscan.com/address/${address}`; }
function sameWallet(a?: string | null, b?: string | null, solana?: boolean) { const x=String(a||"").trim(),y=String(b||"").trim(); return Boolean(x&&y)&&(solana?x===y:x.toLowerCase()===y.toLowerCase()); }

export default function ProjectXClaimDialog({ item, open, onOpenChange, onResolvedImage, onManualReviewRequested }: { item: ProjectImportItem; open: boolean; onOpenChange: (open: boolean) => void; onResolvedImage?: (imageUrl: string) => void; onManualReviewRequested?: (item: ProjectImportItem) => void }) {
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const isSolana = item.chainId === SOLANA_CHAIN_ID;
  const isEvm = item.chainId === BNB_CHAIN_ID || item.chainId === ROBINHOOD_CHAIN_ID;
  const evmChainLabel = item.chainId === ROBINHOOD_CHAIN_ID ? "Robinhood" : "BNB";
  const walletChainLabel = isSolana ? "Solana" : evmChainLabel;
  const ownershipWalletLabel = isSolana ? "Solana project authority wallet" : `${evmChainLabel} project owner wallet`;
  const manualReviewPending = item.ownershipStatus === "ownership_manual_review";
  // A pending manual review keeps every automatic option open: a wallet or X match still verifies at once.
  const eligible = (isSolana || isEvm) && (item.ownershipStatus === "ownership_pending" || manualReviewPending);
  const connectedWallet = isSolana ? solanaWallet.solanaAccount : wallet.account;
  const ownManualReview = manualReviewPending && sameWallet(item.manualClaimWallet, connectedWallet, isSolana);
  const [identity, setIdentity] = useState<ProjectXIdentity | null>(null);
  const [authority, setAuthority] = useState<ProjectEvmAuthority | null>(null);
  const [creatorAuthority, setCreatorAuthority] = useState("");
  const [challenge, setChallenge] = useState<PumpOwnershipChallenge | null>(null);
  // BNB/Robinhood: a pasted creation tx (checked on chain) and the authority -> claimant transfer check.
  const [creationTxInput, setCreationTxInput] = useState("");
  const [creationTx, setCreationTx] = useState("");
  const [evmChallenge, setEvmChallenge] = useState<EvmTransferChallenge | null>(null);
  const [evmTransferTx, setEvmTransferTx] = useState("");
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const returnParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const xAccountMismatch = returnParams.get("claimError") === "PROJECT_IMPORT_X_ACCOUNT_MISMATCH";
  // Display only: the API reads the proven X account from its own record when the review is requested.
  const provenXHandle = useMemo(() => {
    const result = returnParams.get("claim"), handle = String(returnParams.get("xHandle") || "");
    return (result === "x_contact" || xAccountMismatch) && /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : "";
  }, [returnParams, xAccountMismatch]);

  // BNB/Robinhood: owner()/getOwner() vs the wallet that created the token (deployer()/creator() or a verified launchpad record).
  const evmCreatorSource = ["evm_deployer", "evm_creator", "evm_fourmeme_creator", "evm_launchpad_creator", "evm_contract_deployer", "evm_creation_tx", "evm_safe_deployer"].includes(String(authority?.authoritySource || ""));
  const canOwnerVerify = useMemo(() => Boolean(isEvm && authority?.available && authority.matchesConnected && connectedWallet), [isEvm, authority, connectedWallet]);

  const refresh = async () => {
    if (!eligible) return;
    setLoading(true); setError("");
    const tasks: Promise<void>[] = [];
    if (isEvm) tasks.push(resolveProjectEvmAuthority(item, connectedWallet, creationTx || null).then(setAuthority).catch((err:any)=>setError(String(err?.message||"Current owner wallet could not be resolved."))));
    tasks.push(resolveProjectXIdentity(item).then((resolved)=>{ setIdentity(resolved); if(resolved.imageUrl) onResolvedImage?.(resolved.imageUrl); }).catch((err:any)=>{
      const code=String(err?.code||"");
      if(code!=="PROJECT_IMPORT_X_NOT_FOUND" && code!=="PROJECT_IMPORT_X_NOT_PUMP") setError((prev)=>prev||String(err?.message||"Official X account could not be resolved."));
      setIdentity(null);
    }));
    await Promise.allSettled(tasks); setLoading(false);
  };

  useEffect(() => { if (open && eligible) void refresh(); }, [open, eligible, item.id, item.tokenAddress, item.chainId, connectedWallet]);
  useEffect(() => { setChallenge(null); setCreatorAuthority(""); setEvmChallenge(null); setEvmTransferTx(""); }, [connectedWallet, item.id]);
  useEffect(() => { if ((!challenge || challenge.status !== "pending") && !evmChallenge) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [challenge, evmChallenge]);
  useEffect(() => {
    const result=returnParams.get("claim"),claimError=returnParams.get("claimError");
    if(result==="x_verified")toast.success("Project verified with the official X account.");
    if(result==="x_contact")toast.success("X account confirmed. You can now send the manual review request.");
    if(result==="x_failed"){
      if(claimError==="PROJECT_IMPORT_X_ACCOUNT_MISMATCH"){
        toast.error("That X account does not match the project account attached to this token.");
      }else toast.error("X verification was not completed. Please try again.");
    }
  }, []);
  if (!eligible) return null;

  const signProjectAction = async (action: string) => {
    const walletAddress=String(connectedWallet||"").trim();
    if(!walletAddress) throw new Error(`Connect the ${walletChainLabel} wallet you want to use as the project controller first.`);
    return signWalletAction({
      action, walletAddress, chainId:item.chainId, walletType:isSolana?"solana":"evm",
      signMessage:isSolana?async(message)=>(await signSolanaMessage(message,walletAddress)).signature:undefined,
      signer:isSolana?undefined:wallet.signer,
    });
  };

  const verifyOwnerWallet = async () => {
    if (!canOwnerVerify) return;
    setStarting(true);
    try { const auth=await signProjectAction("project_import_claim"); await claimProjectImport({item,auth,creationTx:creationTx||null}); toast.success(`Project verified with the ${evmChainLabel} project owner wallet.`); window.location.reload(); }
    catch(err:any){ toast.error(String(err?.message||`${evmChainLabel} owner-wallet verification failed.`)); setStarting(false); }
  };

  const verifyPumpCreatorWallet = async () => {
    if (!isSolana) return;
    setStarting(true); setCreatorAuthority(""); setChallenge(null);
    try { const auth=await signProjectAction("project_import_claim"); await claimProjectImport({item,auth}); toast.success("Project verified with the Solana project authority wallet."); window.location.reload(); }
    catch(err:any){
      const current=String(err?.currentAuthority||"");
      if(current)setCreatorAuthority(current);
      setError(String(err?.message||"Solana project-authority verification failed."));
      toast.error(String(err?.message||"Solana project-authority verification failed.")); setStarting(false);
    }
  };

  // The creator wallet sends an exact one-time SOL amount to the connected wallet; the API checks
  // the transfer on-chain and then the normal claim passes for the connected wallet.
  const startCreatorTransfer = async () => {
    setStarting(true); setError("");
    try { const auth=await signProjectAction("project_import_pump_challenge_start"); const next=await startPumpOwnershipChallenge({chainId:item.chainId,tokenAddress:item.tokenAddress,auth}); setChallenge(next); setNow(Date.now()); }
    catch(err:any){ toast.error(String(err?.message||"Creator-wallet verification could not start.")); }
    finally { setStarting(false); }
  };

  const checkCreatorTransfer = async () => {
    if (!challenge) return;
    setStarting(true); setError("");
    try {
      const checkAuth=await signProjectAction("project_import_pump_challenge_check");
      const result=await checkPumpOwnershipChallenge({chainId:item.chainId,tokenAddress:item.tokenAddress,challengeId:challenge.id,auth:checkAuth});
      setChallenge(result.challenge);
      const claimAuth=await signProjectAction("project_import_claim"); await claimProjectImport({item,auth:claimAuth});
      toast.success("Project verified with the creator wallet transfer."); window.location.reload();
    }catch(err:any){ toast.error(String(err?.message||"The transfer was not found yet. Check the amount and try again.")); setStarting(false); }
  };

  const checkCreationTx = async () => {
    const hash = parseCreationTxInput(creationTxInput);
    if (!hash) { toast.error("Paste the transaction hash (0x… 66 characters) or the explorer link of that transaction."); return; }
    setStarting(true); setError("");
    try {
      const next = await resolveProjectEvmAuthority(item, connectedWallet, hash);
      setAuthority(next);
      if (next.available) { setCreationTx(hash); toast.success(next.matchesConnected ? "Creation confirmed: your connected wallet created this token." : "Creation confirmed. The creator wallet is shown above."); }
      else toast.error("That transaction did not create this token on a launchpad we can check. Use X or manual review below.");
    } catch (err:any) { toast.error(String(err?.message || "The transaction could not be checked.")); }
    finally { setStarting(false); }
  };

  const startEvmTransfer = async () => {
    setStarting(true); setError("");
    try { const auth=await signProjectAction("project_import_pump_challenge_start"); const next=await startEvmTransferChallenge({item,auth,creationTx:creationTx||null}); setEvmChallenge(next); setEvmTransferTx(""); setNow(Date.now()); }
    catch(err:any){ toast.error(String(err?.message||"The transfer check could not start.")); }
    finally { setStarting(false); }
  };

  const claimWithEvmTransfer = async () => {
    if (!evmChallenge) return;
    const txHash = parseCreationTxInput(evmTransferTx);
    if (!txHash) { toast.error("Paste the transaction hash of the transfer, or its explorer link."); return; }
    setStarting(true);
    try {
      const auth=await signProjectAction("project_import_claim");
      await claimProjectImport({item,auth,creationTx:creationTx||null,transferProof:{challenge:evmChallenge.challenge,txHash}});
      toast.success("Project verified with the transfer from the project wallet."); window.location.reload();
    }catch(err:any){ toast.error(String(err?.message||"The transfer could not be verified yet.")); setStarting(false); }
  };

  const connectOwnerWallet = async () => {
    try { await wallet.connect(); await refresh(); }
    catch(err:any){ toast.error(String(err?.message||`Could not connect the ${evmChainLabel} owner wallet.`)); }
  };

  const verifyX = async () => {
    setStarting(true);
    try { const auth=await signProjectAction("project_import_claim"); const started=await startProjectXClaim(item,auth); window.location.assign(started.authorizeUrl); }
    catch(err:any){ toast.error(String(err?.message||"X verification could not start.")); setStarting(false); }
  };

  const requestManualReview = async () => {
    setStarting(true);
    try{
      const auth=await signProjectAction("project_import_manual_claim");
      const next=await requestProjectManualCheck({chainId:item.chainId,tokenAddress:item.tokenAddress,auth});
      toast.success("Manual ownership review requested. MemeWarzone can contact you through the X account you signed in with.");
      onManualReviewRequested?.(next); onOpenChange(false);
    }catch(err:any){ toast.error(String(err?.message||"Manual review request failed.")); setStarting(false); }
  };

  const secondsLeft = challenge ? Math.max(0, Math.ceil((Date.parse(challenge.expiresAt) - now) / 1000)) : 0;
  const evmSecondsLeft = evmChallenge ? Math.max(0, Math.ceil((evmChallenge.expiresAt - now) / 1000)) : 0;
  const evmCountdown = `${Math.floor(evmSecondsLeft / 60)}:${String(evmSecondsLeft % 60).padStart(2, "0")}`;
  const nativeSymbol = item.chainId === ROBINHOOD_CHAIN_ID ? "ETH" : "BNB";
  const explorerName = item.chainId === ROBINHOOD_CHAIN_ID ? "the Robinhood explorer" : "BscScan";
  const countdown = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`;
  const primaryButton = "mw-focus mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-[10px] border border-mw-accent bg-mw-accent text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] hover:text-[#140A02]";
  const secondaryButton = "mw-focus mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-[10px] border border-mw-edge bg-mw-raised text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text";

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[85vh] overflow-y-auto rounded-[18px] border border-mw-edge bg-mw-surface p-5 font-mw-body text-mw-text sm:max-w-md" data-project-x-claim-dialog="true">
      <DialogHeader><DialogTitle className="font-mw-cond text-2xl font-bold tracking-[0.02em] text-mw-text">CLAIM MEMECOIN</DialogTitle><DialogDescription className="text-[15px] text-mw-muted">Are you the project owner? Verify ownership to manage this MemeWarzone project page.</DialogDescription></DialogHeader>
      {loading?<div className="flex items-center gap-2 py-5 text-sm text-mw-muted"><Loader2 className="h-4 w-4 animate-spin"/>Checking ownership options…</div>:<div className="space-y-4">
        {manualReviewPending?<p className="rounded-[14px] border border-mw-border bg-mw-input p-3 text-[13px] text-mw-muted" data-project-manual-review-pending="true">{ownManualReview?"Your manual review request is with our team.":"A manual review request for this project is with our team."} A wallet or X verification below still verifies the project right away.</p>:null}
        {xAccountMismatch?<p className="rounded-[14px] border border-[#5A1F2B] bg-[#2A0F16] p-3 text-sm font-bold text-[#FB7185]" role="alert" data-project-x-mismatch-alert="true">THAT WAS NOT THE CORRECT X ACCOUNT. Sign in with the project X account attached to this token, verify the {ownershipWalletLabel}, or request manual review below.</p>:null}
        {isEvm&&authority?.available?<div className="rounded-[14px] border border-mw-border bg-mw-input p-4" data-project-owner-wallet-option="true">
          <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">{evmCreatorSource?`${evmChainLabel} token creator wallet`:`${evmChainLabel} project owner wallet`}</div>
          <div className="mt-2 font-mw-mono text-sm text-mw-text">{maskWallet(authority.currentAuthority)}</div>
          {authority.matchesConnected?<><p className="mt-2 text-[13px] text-[#6EE7A0]">{evmCreatorSource?<>Your connected {evmChainLabel} wallet created this token.</>:<>Your connected {evmChainLabel} wallet matches the current contract owner.</>}</p><Button type="button" className={primaryButton} onClick={()=>void verifyOwnerWallet()} disabled={starting}>{starting?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:<WalletCards className="mr-2 h-4 w-4"/>}VERIFY {evmChainLabel.toUpperCase()} OWNER WALLET</Button></>:<><p className="mt-2 text-[13px] text-mw-muted">{evmCreatorSource?<>Connect the {evmChainLabel} wallet that created this token to verify instantly, or use the official X account below.</>:<>Connect this {evmChainLabel} project owner wallet to verify instantly, or use the official X account below.</>}</p><Button type="button" variant="ghost" className={secondaryButton} onClick={()=>void connectOwnerWallet()} disabled={starting}><WalletCards className="mr-2 h-4 w-4"/>CONNECT {evmChainLabel.toUpperCase()} OWNER WALLET</Button></>}
          {!authority.matchesConnected&&connectedWallet?<div className="mt-3 rounded-[10px] border border-mw-border p-3" data-evm-transfer-option="true">
            <p className="text-[13px] text-mw-text">{authority.safe?"This token's wallet is a Safe. Send a small one-time amount from the Safe to your connected wallet (a normal transfer in the Safe app, with the Safe's usual signatures) and paste the transaction here.":`Can't connect that wallet here? Send a small one-time ${nativeSymbol} amount from it to your connected wallet and paste the transaction here. We check it on chain.`}</p>
            {!evmChallenge?<Button type="button" variant="ghost" className={secondaryButton} onClick={()=>void startEvmTransfer()} disabled={starting}>START TRANSFER CHECK</Button>
            :<><p className="mt-2 text-[13px]">Send exactly <strong>{formatWei(evmChallenge.amountWei)} {nativeSymbol}</strong> within <strong>{evmCountdown}</strong>.</p><p className="mt-2 break-all font-mw-mono text-xs"><span className="text-mw-muted">From:</span> {evmChallenge.authority}</p><p className="mt-1 break-all font-mw-mono text-xs"><span className="text-mw-muted">To:</span> {evmChallenge.claimant}</p><p className="mt-2 text-xs text-mw-muted">The {nativeSymbol} stays with you; MemeWarzone never receives it. After sending, copy the transaction hash from your wallet (or its {explorerName} link).</p><Input value={evmTransferTx} onChange={(e)=>setEvmTransferTx(e.target.value)} placeholder="0x… transaction hash or explorer link" aria-label="Transfer transaction" className="mt-2 min-h-11 rounded-[10px] border-[#2E353D] bg-mw-input text-[15px] text-mw-text placeholder:text-[#5C6670]"/><Button type="button" className={primaryButton} onClick={()=>void claimWithEvmTransfer()} disabled={starting||evmSecondsLeft<=0&&!evmTransferTx}>{starting?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:null}CHECK TRANSFER AND CLAIM</Button><Button type="button" variant="ghost" className={secondaryButton} onClick={()=>void startEvmTransfer()} disabled={starting}>NEW AMOUNT</Button></>}
          </div>:null}
        </div>:null}
        {isEvm&&authority&&!authority.available?<div className="rounded-[14px] border border-[#5A3416] bg-[#1A130D] p-4 text-[13px] text-mw-accent-soft" data-evm-creation-tx-option="true"><p>This {evmChainLabel} token contract does not expose an active owner()/getOwner() wallet, and the wallet that created it could not be confirmed on-chain yet. Use the official X account if available, or request manual review below.</p>
          <p className="mt-3 text-mw-text">Faster: show us the transaction that created the token.</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-mw-muted"><li><a href={explorerAddressUrl(item.chainId,item.tokenAddress)} target="_blank" rel="noreferrer noopener" className="text-mw-accent underline">Open this token on {explorerName}</a>.</li><li>{item.chainId===ROBINHOOD_CHAIN_ID?<>Find <strong>Creator</strong> and click the transaction next to it.</>:<>Under <strong>More Info</strong>, find <strong>Creator</strong> and click the transaction after "at txn".</>}</li><li>Copy the page link (or the transaction hash) and paste it here.</li></ol>
          <Input value={creationTxInput} onChange={(e)=>setCreationTxInput(e.target.value)} placeholder="Explorer link or 0x… transaction hash" aria-label="Token creation transaction" className="mt-3 min-h-11 rounded-[10px] border-[#2E353D] bg-mw-input text-[15px] text-mw-text placeholder:text-[#5C6670]"/>
          <Button type="button" variant="ghost" className={secondaryButton} onClick={()=>void checkCreationTx()} disabled={starting}>{starting?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:null}CHECK CREATION</Button></div>:null}
        {isSolana?<div className="rounded-[14px] border border-mw-border bg-mw-input p-4" data-pump-creator-wallet-option="true"><div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Solana project authority wallet</div><p className="mt-2 text-[13px] text-mw-muted">Connect the wallet that created this token (the Pump.fun creator wallet, or the wallet that created the mint) and verify ownership directly.</p>{creatorAuthority?<p className="mt-2 text-[13px] text-mw-accent-soft">Recorded project authority: <span className="font-mw-mono">{maskWallet(creatorAuthority)}</span></p>:null}<Button type="button" variant="ghost" className={secondaryButton} onClick={()=>void verifyPumpCreatorWallet()} disabled={starting}>{starting?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:<WalletCards className="mr-2 h-4 w-4"/>}VERIFY PROJECT AUTHORITY</Button>
          {creatorAuthority&&connectedWallet&&!sameWallet(creatorAuthority,connectedWallet,true)?<div className="mt-3 rounded-[10px] border border-mw-border p-3" data-creator-transfer-option="true">
            <p className="text-[13px] text-mw-text">Can't connect that wallet here? Pump.fun and other launchpads often create the token with a separate wallet. Send a small one-time SOL amount from it to your connected wallet and we verify the link on-chain.</p>
            {!challenge?<Button type="button" variant="ghost" className={secondaryButton} onClick={()=>void startCreatorTransfer()} disabled={starting}>START TRANSFER CHECK</Button>
            :challenge.status==="verified"?<p className="mt-2 text-[13px] font-semibold text-[#6EE7A0]">CREATOR WALLET VERIFIED</p>
            :<><p className="mt-2 text-[13px]">Send exactly <strong>{challenge.solAmount} SOL</strong> within <strong>{countdown}</strong>.</p><p className="mt-2 break-all font-mw-mono text-xs"><span className="text-mw-muted">From:</span> {challenge.creatorWallet}</p><p className="mt-1 break-all font-mw-mono text-xs"><span className="text-mw-muted">To:</span> {challenge.claimantWallet}</p><p className="mt-2 text-xs text-mw-muted">Only this exact amount, sent after this check started and before it expires, counts. The SOL stays with you; MemeWarzone never receives it.</p><Button type="button" className={primaryButton} onClick={()=>void checkCreatorTransfer()} disabled={starting||secondsLeft<=0}>{starting?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:null}I SENT IT, CHECK NOW</Button><Button type="button" variant="ghost" className={secondaryButton} onClick={()=>void startCreatorTransfer()} disabled={starting}>NEW AMOUNT</Button></>}
          </div>:null}
        </div>:null}
        {identity?<div className="rounded-[14px] border border-mw-border bg-mw-input p-4" data-project-x-option="true"><div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Project X attached to token</div><div className="mt-2 flex items-center gap-2 font-bold text-mw-text"><ShieldCheck className="h-4 w-4 text-mw-accent"/>@{identity.username}</div><p className="mt-2 text-[13px] text-mw-muted">Sign in to this exact X account to bind the project to your connected MemeWarzone wallet.</p><Button type="button" className={primaryButton} onClick={()=>void verifyX()} disabled={starting}>{starting?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:null}VERIFY WITH X</Button></div>:<div className="rounded-[14px] border border-[#5A3416] bg-[#1A130D] p-4 text-[13px] text-mw-accent-soft">No X account is attached to this token's metadata or DexScreener profile. You can still verify the {ownershipWalletLabel} or request manual review.</div>}
        {error?<p className="text-sm text-mw-accent-soft" role="alert">{error}</p>:null}
        <div className="rounded-[14px] border border-mw-border bg-mw-input p-4" data-project-manual-review-option="true"><div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Last resort: manual review</div><p className="mt-2 text-[13px] text-mw-muted">If you cannot complete the automatic options, request an ownership review. First sign in with an X account you control so the MemeWarzone team can contact you there. If it is the project account attached to this token, the claim is verified right away. This does not verify ownership automatically.</p>
          {provenXHandle?<><p className="mt-3 text-[13px] text-[#6EE7A0]" data-project-proven-x="true">Signed in with X as @{provenXHandle}.</p><Button type="button" className={primaryButton} onClick={()=>void requestManualReview()} disabled={starting}>{starting?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:null}REQUEST MANUAL REVIEW</Button></>
          :<Button type="button" variant="ghost" className={secondaryButton} onClick={()=>void verifyX()} disabled={starting}>{starting?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:null}SIGN IN WITH X TO REQUEST MANUAL REVIEW</Button>}
        </div>
        <p className="text-center text-[13px] text-mw-muted">Not the owner? Close this window. The real owner can claim it later.</p>
      </div>}
    </DialogContent>
  </Dialog>;
}
