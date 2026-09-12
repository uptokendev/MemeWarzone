import { PumpImportHelp } from "@/components/imports/PumpImportHelp";
import { useEffect, useMemo, useRef, useState } from "react";
import { projectImportFeedback } from "@/lib/projectImportFeedback.mjs";
import { Navigate, useNavigate } from "react-router-dom";
import { CheckCircle2, Loader2, Search, ShieldCheck, ShieldQuestion } from "lucide-react";
import { toast } from "sonner";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import { BNB_CHAIN_ID, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { projectImportRobinhoodEnabled } from "@/features/projectImports/config";
import { isSolanaAddress } from "@/lib/address";
import {
  claimProjectImport,
  commandCenterImportPath,
  createProjectImport,
  projectImportImageDigest,
  projectImportIntentLines,
  requestProjectManualCheck,
  startPumpOwnershipChallenge,
  checkPumpOwnershipChallenge,
  resolveProjectImportWithProject,
  uploadProjectRegistrationImage,
  type ProjectImportItem,
  type ProjectResolveResult,
  type PumpOwnershipChallenge,
} from "@/lib/projectImports";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { signWalletAction } from "@/lib/walletActionAuth";

type ImportChain = "bnb" | "solana" | "robinhood";
const ROBINHOOD_CHAIN_ID = 4663;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
function projectUrl(item: ProjectImportItem) { return `/token/${encodeURIComponent(item.tokenAddress)}?chainId=${item.chainId}`; }
function detectImportChain(solanaAccount?: string | null, evmAccount?: string | null, preferSolana = false): ImportChain | null {
  const solana = Boolean(String(solanaAccount || "").trim());
  const evm = Boolean(String(evmAccount || "").trim());
  if (!solana && !evm) return null;
  if (solana && (!evm || preferSolana)) return "solana";
  return "bnb";
}
function shortenWallet(value?: string | null) {
  const address = String(value || "").trim();
  if (address.length <= 8) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

export function ProjectImportPanel({
  embedded = false,
  onProjectChange,
}: {
  embedded?: boolean;
  onProjectChange?: (item: ProjectImportItem) => void;
}) {
  const navigate = useNavigate(); const wallet = useWallet(); const solanaWallet = useSolanaWallet(); const feedWallet = useActiveFeedWallet();
  const detectedChain = detectImportChain(feedWallet.solanaAccount, feedWallet.evmAccount, feedWallet.isSolana);
  const [chain,setChain]=useState<ImportChain>(detectedChain || "bnb"); const [chainChosenByUser,setChainChosenByUser]=useState(false); const [tokenAddress,setTokenAddress]=useState(""); const [item,setItem]=useState<ProjectImportItem|null>(null); const [evidence,setEvidence]=useState<ProjectResolveResult|null>(null); const [lookupCompleted,setLookupComplete]=useState(false); const [working,setWorking]=useState(false);
  const [imageFile,setImageFile]=useState<File|null>(null); const [imagePreview,setImagePreview]=useState("");
  const [pumpChallenge,setPumpChallenge]=useState<PumpOwnershipChallenge|null>(null); const [pumpNow,setPumpNow]=useState(Date.now());
  const chainId=chain==="solana"?SOLANA_CHAIN_ID:chain==="robinhood"?ROBINHOOD_CHAIN_ID:BNB_CHAIN_ID; const connectedWallet=chain==="solana"?solanaWallet.solanaAccount:wallet.account; const connected=Boolean(connectedWallet);
  const [resolvedFor,setResolvedFor]=useState("");
  const [feedback,setFeedback]=useState<{title:string;message:string;retry:boolean}|null>(null);
  const contextKey=JSON.stringify([chainId,tokenAddress.trim(),connectedWallet]);
  const contextRef=useRef(contextKey);contextRef.current=contextKey;
  const current=()=>contextRef.current===contextKey;
  const lookupComplete=lookupCompleted&&resolvedFor===contextKey;
  const showError=(error:any)=>{if(!current())return;setFeedback(projectImportFeedback(error));if(error?.currentAuthority){setEvidence(null);setLookupComplete(false);}};
  const validAddress=useMemo(()=>{const value=tokenAddress.trim();return chain==="solana"?isSolanaAddress(value):/^0x[a-fA-F0-9]{40}$/.test(value);},[chain,tokenAddress]);
  const assessment = evidence?.assessment;
  const stillBonding = lookupComplete && evidence?.market?.verified === true && evidence?.market?.phase === "bonding";
  const marketReview = lookupComplete && assessment?.decision === "technical_review";
  const autoCleared = assessment?.automaticImportAllowed === true;
  const ownerVerified=item?.ownershipStatus==="ownership_verified"; const conflictingVerified=ownerVerified&&Boolean(item?.projectOwnerWallet)&&!sameWallet(item?.projectOwnerWallet,connectedWallet,chain==="solana");
  const pumpFunToken=evidence?.authoritySource==="pump_bonding_curve_creator"||evidence?.market?.platform==="pumpfun"||/pump$/i.test(String(evidence?.tokenAddress||tokenAddress||""));
  const reviewablePumpMismatch=lookupComplete&&pumpFunToken&&evidence?.automaticOwnershipAvailable===true&&Boolean(evidence.currentAuthority)&&!sameWallet(evidence.currentAuthority,connectedWallet,chain==="solana")&&evidence?.signedWalletMatchesAuthority!==true&&assessment?.manualRequestAllowed===true;
  const wrongAuthorityWallet=lookupComplete&&evidence?.automaticOwnershipAvailable===true&&Boolean(evidence.currentAuthority)&&!sameWallet(evidence.currentAuthority,connectedWallet,chain==="solana")&&!reviewablePumpMismatch;
  const approvedOwner=Boolean(lookupComplete&&connected&&ownerVerified&&!conflictingVerified&&!wrongAuthorityWallet);
  const suspended=item?.ownershipStatus==="ownership_suspended";
  const ownershipUnavailable=!approvedOwner&&lookupComplete&&evidence?.automaticOwnershipAvailable===false;
  const securityStatus=evidence?.security?.status||null;
  const securityBlocked=securityStatus==="blocked";
  const securityReview=securityStatus==="review";
  const manualReviewPending=item?.ownershipStatus==="ownership_manual_review";
  const manualReviewMine=Boolean(lookupComplete&&!wrongAuthorityWallet&&!suspended&&manualReviewPending&&sameWallet(item?.manualClaimWallet,connectedWallet,chain==="solana"));
  const manualReviewReason=ownershipUnavailable||securityBlocked||securityReview||marketReview||assessment?.decision==="manual_review";
  const canRequestManual=lookupComplete&&Boolean(evidence)&&!wrongAuthorityWallet&&!conflictingVerified&&!suspended&&!approvedOwner&&!manualReviewPending&&manualReviewReason&&!stillBonding&&!autoCleared&&assessment?.manualRequestAllowed===true;
  const canProceedToImage=approvedOwner||Boolean(autoCleared&&evidence?.signedWalletMatchesAuthority&&(!item||approvedOwner));
  const canSelectImage=lookupComplete&&(!stillBonding||approvedOwner)&&connected&&!wrongAuthorityWallet&&!conflictingVerified&&!suspended&&(canProceedToImage||canRequestManual||manualReviewMine);
  const expectedAuthorityShort=(wrongAuthorityWallet||reviewablePumpMismatch)?shortenWallet(evidence?.currentAuthority):""; const connectedWalletShort=shortenWallet(connectedWallet);
  const reset=()=>{setItem(null);setEvidence(null);setLookupComplete(false);setResolvedFor("");setImageFile(null);setImagePreview("");setFeedback(null);setPumpChallenge(null);};
  useEffect(()=>{reset();},[chainId,connectedWallet]);
  useEffect(()=>{if(!pumpChallenge||pumpChallenge.status!=="pending")return;const timer=setInterval(()=>setPumpNow(Date.now()),1000);return()=>clearInterval(timer);},[pumpChallenge]);
  useEffect(()=>()=>{if(imagePreview)URL.revokeObjectURL(imagePreview);},[imagePreview]);
  useEffect(()=>{if(chainChosenByUser)return;if(!detectedChain||detectedChain===chain)return;setChain(detectedChain);reset();},[detectedChain,chainChosenByUser,chain]);
  const connect=async()=>{try{if(chain==="solana")await solanaWallet.connectSolana();else await wallet.connect();}catch(error:any){showError(error);}};
  const signAction=async(action:string, projectId:string|null, body:unknown=null, imageDigest:string|null=null)=>{if(!connectedWallet||!current())throw new Error("Wallet changed. Connect the correct wallet and press IMPORT again.");const token=tokenAddress.trim();const extraLines=await projectImportIntentLines({action,chainId,token,projectId,body,imageDigest});if(chain==="solana")return signWalletAction({action,walletAddress:connectedWallet,chainId,walletType:"solana",extraLines,signMessage:async(message)=>(await signSolanaMessage(message,connectedWallet)).signature});return signWalletAction({action,walletAddress:connectedWallet,chainId,extraLines,signer:wallet.signer});};
  const chooseImage=(file:File|null)=>{if(!canSelectImage){toast.error(wrongAuthorityWallet?"Connect the token owner wallet before continuing.":"Complete the token checks before uploading an image.");return;}if(!file){setImageFile(null);setImagePreview("");return;}if(file.size>MAX_IMAGE_BYTES){showError(new Error("Image is too large. Maximum size is 5 MB."));return;}if(!ALLOWED_IMAGE_TYPES.has(file.type.toLowerCase())){showError(new Error("Use PNG, JPEG or WEBP."));return;}setImageFile(file);setImagePreview(URL.createObjectURL(file));};
  const attachRegistrationImage=async(project:ProjectImportItem,file:File)=>{try{const digest=await projectImportImageDigest(file);const auth=await signAction("project_import_registration_image",project.id,null,digest);return await uploadProjectRegistrationImage({item:project,file,auth});}catch(error:any){throw Object.assign(error instanceof Error?error:new Error(String(error)),{importStage:"image"});}};
  const resolve=async()=>{
    if(!validAddress||!connected||working)return;reset();setWorking(true);
    try{const auth=await signAction("project_import_resolve",null);if(!current())return;
      const result=await resolveProjectImportWithProject({tokenAddress:tokenAddress.trim(),chainId,auth});if(!current())return;
      setItem(result.project);setEvidence(result.resolved);setResolvedFor(contextKey);setLookupComplete(true);
    }catch(error){showError(error);}finally{setWorking(false);}
  };
  const remember=(project:ProjectImportItem)=>{if(!current())return;setItem(project);setResolvedFor(contextKey);setLookupComplete(true);onProjectChange?.(project);};
  const register=async()=>{
    if(!lookupComplete||!connected||working||wrongAuthorityWallet||conflictingVerified||suspended||!evidence?.signedWalletMatchesAuthority||!autoCleared||stillBonding||!imageFile)return;
    setWorking(true);setFeedback(null);
    try{const auth=await signAction("project_import_create",null,{operation:"create"});if(!current())return;
      const result=await createProjectImport({tokenAddress:tokenAddress.trim(),chainId,auth});if(!current())return;remember(result.project);
      if(!result.project.imageUrl)remember(await attachRegistrationImage(result.project,imageFile));
    }catch(error){showError(error);}finally{setWorking(false);}
  };
  const claim=async()=>{
    if(!lookupComplete||!item||wrongAuthorityWallet||conflictingVerified||suspended||!evidence?.signedWalletMatchesAuthority||!autoCleared||stillBonding||working)return;
    setWorking(true);setFeedback(null);
    try{const auth=await signAction("project_import_claim",item.id,{operation:"claim"});if(!current())return;remember(await claimProjectImport({item,auth}));}
    catch(error){showError(error);}finally{setWorking(false);}
  };
  const uploadPendingImage=async(project:ProjectImportItem)=>{if(project.imageUrl)return project;if(!current())throw new Error("Wallet or Contract Address changed. Press IMPORT again.");if(!imageFile)throw new Error("Add the project image before requesting manual review.");return attachRegistrationImage(project,imageFile);};
  const manual=async()=>{
    if((!canRequestManual&&!manualReviewMine)||stillBonding||wrongAuthorityWallet||working)return;if(!imageFile&&!item?.imageUrl){showError(new Error("Add the project image before requesting manual review."));return;}
    setWorking(true);setFeedback(null);
    try{const note=null;const auth=await signAction("project_import_manual_claim",item?.id||null,{note});if(!current())return;
      let next=await requestProjectManualCheck({chainId,tokenAddress:tokenAddress.trim(),auth,note:undefined});if(!current())return;
      // Retain the saved claim BEFORE image upload so a failure is retryable.
      remember(next);next=await uploadPendingImage(next);remember(next);
    }catch(error){showError(error);}finally{setWorking(false);}
  };
  const attachManualImage=async()=>{
    if(!lookupComplete||!item||wrongAuthorityWallet||!canSelectImage||(!manualReviewMine&&!approvedOwner)||item.imageUrl||!imageFile||working)return;
    setWorking(true);setFeedback(null);
    try{remember(await uploadPendingImage(item));}catch(error){showError(error);}finally{setWorking(false);}
  };

  const startPumpChallenge=async()=>{
    if(!reviewablePumpMismatch||!connectedWallet||working)return;setWorking(true);setFeedback(null);
    try{const auth=await signAction("project_import_pump_challenge_start",null);if(!current())return;const challenge=await startPumpOwnershipChallenge({chainId,tokenAddress:tokenAddress.trim(),auth});if(!current())return;setPumpChallenge(challenge);setPumpNow(Date.now());}
    catch(error){showError(error);}finally{setWorking(false);}
  };
  const checkPumpChallenge=async()=>{
    if(!pumpChallenge||!connectedWallet||working)return;setWorking(true);setFeedback(null);
    try{const intentBody={challengeId:pumpChallenge.id};const auth=await signAction("project_import_pump_challenge_check",null,intentBody);if(!current())return;const result=await checkPumpOwnershipChallenge({chainId,tokenAddress:tokenAddress.trim(),challengeId:pumpChallenge.id,auth});if(!current())return;setPumpChallenge(result.challenge);setItem(result.project);setEvidence(result.resolved);setResolvedFor(contextKey);setLookupComplete(true);toast.success("Pump.fun creator wallet verified.");}
    catch(error){showError(error);}finally{setWorking(false);}
  };
  const pumpSecondsLeft=pumpChallenge?Math.max(0,Math.ceil((Date.parse(pumpChallenge.expiresAt)-pumpNow)/1000)):0;
  const pumpCountdown=`${Math.floor(pumpSecondsLeft/60)}:${String(pumpSecondsLeft%60).padStart(2,"0")}`;
  // Focus the import UI as soon as a Pump.fun creator-wallet mismatch is presented.
  // Previously this only hid the setup fields after START VERIFICATION, which left
  // the challenge below the Contract Address field on smaller screens.
  const pumpChallengeActive=Boolean(reviewablePumpMismatch);

  const securityRisks=[...(evidence?.security?.criticalRisks||[]),...(evidence?.security?.reviewRisks||[])];
  const body = <>
    {embedded ? null : <section className="mwz-hud-frame p-5"><div className="text-[11px] uppercase tracking-[0.2em] text-accent">Existing project onboarding</div><h1 className="mt-2 font-retro text-2xl text-foreground">IMPORT YOUR MEMECOIN</h1><p className="mt-3 max-w-2xl text-sm text-muted-foreground">Enter the Contract Address and press IMPORT. We check the token, its market, safety and whether your wallet can manage it. If something cannot be confirmed automatically, you can ask our team to check it.</p></section>}
    {!pumpChallengeActive?<section className={embedded ? "space-y-5" : "mwz-hud-frame space-y-5 p-5"}>
      <div><div className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">1. Choose chain</div><div className="mt-3 flex gap-2"><Button type="button" disabled={working} variant={chain==="bnb"?"default":"outline"} onClick={()=>{setChainChosenByUser(true);setChain("bnb");reset();}}>BNB</Button><Button type="button" disabled={working} variant={chain==="solana"?"default":"outline"} onClick={()=>{setChainChosenByUser(true);setChain("solana");reset();}}>Solana</Button>{projectImportRobinhoodEnabled?<Button type="button" disabled={working} variant={chain==="robinhood"?"default":"outline"} onClick={()=>{setChainChosenByUser(true);setChain("robinhood");reset();}}>Robinhood</Button>:null}</div></div>
      <div><div className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">2. Wallet</div><div className="mt-3 flex flex-wrap items-center gap-3"><Button type="button" variant="outline" onClick={()=>void connect()} disabled={chain==="solana"?solanaWallet.connectingSolana:wallet.connecting}>{connected?"WALLET CONNECTED":chain==="solana"?"CONNECT SOLANA WALLET":chain==="robinhood"?"CONNECT ROBINHOOD WALLET":"CONNECT BNB WALLET"}</Button>{connectedWallet?<span className="max-w-full truncate text-xs text-muted-foreground">{connectedWallet}</span>:null}</div></div>
      <div><label htmlFor="project-import-token" className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">3. Contract Address</label><div className="mt-3 flex flex-col gap-2 sm:flex-row"><Input id="project-import-token" disabled={working} value={tokenAddress} onChange={(e)=>{setTokenAddress(e.target.value);reset();}} placeholder="Contract Address"/><Button type="button" variant="outline" disabled={!validAddress||!connected||working} onClick={()=>void resolve()}>{working?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:<Search className="mr-2 h-4 w-4"/>}IMPORT</Button></div>{!connected?<p className="mt-2 text-xs text-amber-200">Connect a wallet before importing.</p>:null}{tokenAddress.trim()&&!validAddress?<p role="alert" className="mt-2 text-sm text-red-200">This Contract Address is not valid for the selected chain. Check the address or choose the correct chain.</p>:null}{chain==="solana"?<div className="mt-3"><PumpImportHelp expectedCreator={evidence?.currentAuthority} onConnect={()=>void connect()} disabled={working}/></div>:null}</div>
      {canSelectImage?<div data-project-import-image-required="true"><label htmlFor="project-import-image" className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">4. Project image</label><p className="mt-2 text-xs text-muted-foreground">{canRequestManual||manualReviewMine?"Add the image you want to use on MemeWarzone. If we need to review the token, it stays hidden until we approve it.":"This wallet matches the token creator. Add the project image to finish registration."} PNG, JPEG or WEBP.</p><div className="mt-3 flex items-center gap-3"><input id="project-import-image" disabled={working} type="file" accept="image/png,image/jpeg,image/webp" onChange={(e)=>chooseImage(e.target.files?.[0]||null)}/><span className="text-xs text-muted-foreground">{imageFile?imageFile.name:item?.imageUrl?"Image already attached":"No image selected"}</span></div>{imagePreview?<img src={imagePreview} alt="Selected project" className="mt-3 h-16 w-16 rounded-md object-cover"/>:null}</div>:null}
    </section>:null}
    {lookupComplete&&!assessment&&!approvedOwner?<p role="alert" className="rounded border p-4 text-sm">The import check service has not returned the required review information. Please retry after the service update; nothing has been approved.</p>:null}
    {stillBonding?<section role="alert" data-import-bonding="true" className="rounded border border-amber-400/40 p-4"><h2 className="font-retro text-sm">{evidence?.market?.platform === "fourmeme" ? "STILL BONDING ON FOUR.MEME" : evidence?.market?.platform === "pumpfun" ? "STILL BONDING ON PUMP.FUN" : "STILL BONDING ON ANOTHER PLATFORM"}</h2><p className="mt-2 text-sm">This token is still in its bonding phase, so it cannot be imported yet. Try again after it graduates.</p>{approvedOwner?<p className="mt-2 text-sm">Your existing project page is retained. This does not grant Battle or trading access.</p>:null}<Button className="mt-3" variant="outline" disabled={working} onClick={()=>void resolve()}>CHECK AGAIN</Button></section>:null}

    {reviewablePumpMismatch?<section role="status" data-pump-wallet-verification="true" className="rounded border border-sky-300/40 bg-sky-400/10 p-4"><h2 className="font-retro text-sm text-sky-100">VERIFY YOUR PUMP.FUN WALLET</h2><p className="mt-2 text-sm text-sky-50">Pump.fun created this token with <strong>{expectedAuthorityShort}</strong>, but you connected <strong>{connectedWalletShort}</strong>. This is common with Pump.fun.</p>{!pumpChallenge?<><p className="mt-2 text-sm text-sky-50">You do not need to import the Pump.fun wallet. Send a tiny one-time SOL amount from the Pump.fun creator wallet to your connected wallet and we can verify the link automatically.</p><Button type="button" className="mt-3" disabled={working} onClick={()=>void startPumpChallenge()}>START VERIFICATION</Button></>:pumpChallenge.status==="verified"?<p className="mt-3 text-sm font-semibold text-emerald-200">PUMP.FUN WALLET VERIFIED</p>:<div className="mt-3 rounded border border-sky-200/30 p-3"><p className="text-sm">Send exactly <strong>{pumpChallenge.solAmount} SOL</strong> within <strong>{pumpCountdown}</strong>.</p><p className="mt-2 break-all text-xs"><strong>From:</strong> {pumpChallenge.creatorWallet}</p><p className="mt-1 break-all text-xs"><strong>To:</strong> {pumpChallenge.claimantWallet}</p><p className="mt-2 text-xs text-sky-100/80">Only this exact transfer, after this challenge was created and before it expires, will count. MemeWarzone never receives the SOL.</p><div className="mt-3 flex flex-wrap gap-2"><Button type="button" disabled={working||pumpSecondsLeft<=0} onClick={()=>void checkPumpChallenge()}>I SENT IT - CHECK NOW</Button><Button type="button" variant="outline" disabled={working} onClick={()=>void startPumpChallenge()}>NEW CHALLENGE</Button></div></div>}<details className="mt-3 text-xs"><summary className="cursor-pointer">Can't send from that wallet?</summary><p className="mt-2">Use the Pump.fun wallet guide above to connect the creator wallet, or request manual verification and prove the project through an established official account.</p></details></section>:null}

    {canRequestManual?<section role="status" data-import-manual-summary="true" className="rounded border border-amber-300/40 bg-amber-400/10 p-4"><h2 className="font-retro text-sm text-amber-100">MANUAL CHECK NEEDED</h2><p className="mt-2 text-sm text-amber-50">We couldn't verify everything automatically. This does not mean there is something wrong with your token.</p><p className="mt-2 text-sm text-amber-50">Add your project image and send it to our team. We'll check the ownership, market status and safety flags.</p>{reviewablePumpMismatch?<p className="mt-2 text-sm text-amber-50"><strong>Pump.fun wallet:</strong> We found creator wallet {expectedAuthorityShort}, but you are connected with {connectedWalletShort}. Pump.fun often uses a separate creator wallet. Use the quick wallet verification above, or request review if you cannot send from that wallet.</p>:null}</section>:null}
    {assessment?.checks?.length&&!stillBonding?<details className="rounded border p-3" data-import-checks="true"><summary>Why do we need to check it?</summary><div className="mt-3 space-y-2">{assessment.checks.map(check=><div key={check.key} className="flex items-center justify-between gap-3 text-sm"><span>{check.title}</span><strong>{check.status==="pass"?"OK":check.status==="blocked"?"Needs proof":"Needs a check"}</strong></div>)}</div><p className="mt-3 text-xs text-muted-foreground">Our team sees the full technical details. You only need to follow the action shown above.</p></details>:null}
    {feedback?<section role="alert" data-import-error="true" className="rounded-md border border-red-300/40 bg-red-400/10 p-4"><h2 className="font-retro text-sm text-red-100">{feedback.title}</h2><p className="mt-2 text-sm text-red-50">{feedback.message}</p>{feedback.retry?<Button type="button" variant="outline" className="mt-3" disabled={working||!validAddress||!connected} onClick={()=>void resolve()}>RETRY CHECK</Button>:null}</section>:null}
    {lookupComplete?<section className={embedded ? "border-t border-white/10 pt-5" : "mwz-hud-frame p-5"} data-import-ownership-result="true">
      {wrongAuthorityWallet?<div className="rounded-md border border-red-300/40 bg-red-400/10 p-4" data-import-wrong-wallet-warning="true"><h2 className="font-retro text-sm text-red-100">NOT TOKEN OWNER</h2><p className="mt-2 text-sm text-red-50">This token is controlled by wallet <strong>{expectedAuthorityShort}</strong>. Connect that wallet to continue.</p>{connectedWalletShort?<p className="mt-2 text-xs text-red-100/80">Connected: {connectedWalletShort}</p>:null}<p className="mt-3 text-xs font-semibold uppercase tracking-[0.12em] text-red-100">Import blocked</p></div>:null}
      {ownershipUnavailable&&!stillBonding&&!canRequestManual&&!manualReviewPending?<div className="mt-4 rounded-md border border-amber-300/40 bg-amber-400/10 p-4" data-import-ownership-unavailable="true"><h2 className="font-retro text-sm text-amber-100">OWNERSHIP CANNOT BE VERIFIED</h2><p className="mt-2 text-sm text-amber-50">{evidence?.projectAuthorityEvidence?.authorityType==="fee_sharing"?"Pump.fun uses an automated fee-sharing account for this token. We found the account structure, but fee entitlement is not project ownership. Add the project image and request review; do not try to import the program account into a wallet.":"We could not establish project-management authority automatically. Add the image and request a manual check."}</p></div>:null}
      {!stillBonding&&!wrongAuthorityWallet&&!autoCleared&&(securityBlocked||securityReview)&&!approvedOwner&&!canRequestManual&&!manualReviewPending?<div className="mt-4 rounded-md border border-amber-300/40 bg-amber-400/10 p-4" data-import-security-review="true"><h2 className="font-retro text-sm text-amber-100">TOKEN SECURITY REVIEW REQUIRED</h2><p className="mt-2 text-sm text-amber-50">Automatic import is locked because the token security scan found risk signals or could not confidently clear the token. Add the project image and request manual review.</p>{securityRisks.length?<ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-amber-100/90">{securityRisks.slice(0,6).map((risk)=><li key={risk.code}>{risk.label}</li>)}</ul>:null}</div>:null}
      {manualReviewPending?<div className="mt-4 rounded-md border border-sky-300/40 bg-sky-400/10 p-4" data-import-manual-review-pending="true"><h2 className="font-retro text-sm text-sky-100">MANUAL CHECK REQUESTED</h2><p className="mt-2 text-sm text-sky-50">Your request is with our team. The project stays hidden until we approve it.{item?.imageUrl?" The project image is attached.":" An image is still required before approval."}</p>{manualReviewMine&&reviewablePumpMismatch?<div className="mt-3 rounded border border-sky-200/30 p-3 text-sm"><strong>Easy project proof</strong><p className="mt-1">Post this one-time claim code from the project's official X, Telegram announcement channel or website:</p><code className="mt-2 block select-all break-all">MWZ-{item?.id?.slice(0,8).toUpperCase()}</code><p className="mt-2 text-xs">Then send the public post/link to our reviewer. Never send us a private key or recovery phrase.</p></div>:null}{manualReviewMine&&!stillBonding?<Button type="button" className="mt-3" variant="outline" disabled={working||(!item?.imageUrl&&!imageFile)} onClick={()=>void manual()}>REFRESH SIGNED CLAIM</Button>:null}{manualReviewMine&&!item?.imageUrl&&imageFile?<Button type="button" className="mt-4" variant="outline" disabled={working} onClick={()=>void attachManualImage()}>{manualReviewMine?"ATTACH IMAGE TO REVIEW":"ATTACH REQUIRED IMAGE"}</Button>:null}</div>:null}
      {canRequestManual?<div className="mt-4"><Button type="button" variant="outline" disabled={working||!imageFile} onClick={()=>void manual()}>REQUEST MANUAL CHECK</Button><p className="mt-2 text-xs text-muted-foreground">Add an image, then send the token to our team. For Pump.fun, try the quick creator-wallet transfer first. If that is not possible, we can verify the project manually through an established official account. Other known wallet mismatches stay blocked.</p></div>:null}
      {approvedOwner?<><div className="mt-4 flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 text-emerald-300"/><div><h2 className="font-retro text-sm text-foreground">OWNER VERIFIED</h2><p className="mt-2 text-sm text-muted-foreground">This connected wallet is the approved project owner.</p></div></div><div className="mt-5 flex flex-wrap gap-2">{item?.imageUrl?<Button type="button" onClick={()=>navigate(projectUrl(item))}><CheckCircle2 className="mr-2 h-4 w-4"/>OPEN PROJECT PAGE</Button>:null}{!item?.imageUrl?<Button type="button" variant="outline" disabled={working||!imageFile} onClick={()=>void attachManualImage()}>ATTACH REQUIRED IMAGE</Button>:null}</div></>:null}
      {!approvedOwner&&!stillBonding&&autoCleared&&!wrongAuthorityWallet&&!ownershipUnavailable&&item?<><div className="mt-4 flex items-start gap-3"><ShieldQuestion className="mt-0.5 h-5 w-5 text-amber-200"/><div><h2 className="font-retro text-sm text-foreground">PROJECT ALREADY REGISTERED</h2><p className="mt-2 text-sm text-muted-foreground">The token already has a project registration. Verify current ownership before continuing.</p></div></div><div className="mt-5 flex flex-wrap gap-2">{evidence?.signedWalletMatchesAuthority?<Button type="button" variant="outline" onClick={()=>void claim()} disabled={working}>VERIFY CURRENT OWNERSHIP</Button>:null}</div></>:null}
      {!approvedOwner&&!stillBonding&&autoCleared&&!wrongAuthorityWallet&&!ownershipUnavailable&&!item&&evidence?.signedWalletMatchesAuthority?<><h2 className="mt-4 font-retro text-sm text-emerald-200">OWNER VERIFIED</h2><p className="mt-2 text-sm text-muted-foreground">This connected wallet matches the token creator. Add the project image to finish.</p><Button type="button" className="mt-4" disabled={!imageFile||working} onClick={()=>void register()}>REGISTER MEMECOIN</Button></>:null}
    </section>:null}
  </>;
  if (embedded) return <div className="space-y-5" data-project-import-panel="true">{body}</div>;
  return <ContentContainer className="space-y-6 px-1 pb-12 pt-2" data-project-import-page="true">{body}</ContentContainer>;
}

export default function ProjectImport() {
  const feedWallet = useActiveFeedWallet();
  return <Navigate to={commandCenterImportPath(feedWallet.address)} replace />;
}

function sameWallet(a:string|null|undefined,b:string|null|undefined,solana:boolean){const left=String(a||"").trim(),right=String(b||"").trim();if(!left||!right)return false;return solana?left===right:left.toLowerCase()===right.toLowerCase();}
