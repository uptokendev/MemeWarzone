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
import { isSolanaAddress } from "@/lib/address";
import {
  claimProjectImport,
  commandCenterImportPath,
  createProjectImport,
  projectImportImageDigest,
  projectImportIntentLines,
  requestProjectManualCheck,
  resolveProjectImportWithProject,
  uploadProjectRegistrationImage,
  type ProjectImportItem,
  type ProjectResolveResult,
} from "@/lib/projectImports";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { signWalletAction } from "@/lib/walletActionAuth";

type ImportChain = "bnb" | "solana";
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
  const chainId=chain==="bnb"?BNB_CHAIN_ID:SOLANA_CHAIN_ID; const connectedWallet=chain==="bnb"?wallet.account:solanaWallet.solanaAccount; const connected=Boolean(connectedWallet);
  const [resolvedFor,setResolvedFor]=useState("");
  const [feedback,setFeedback]=useState<{title:string;message:string;retry:boolean}|null>(null);
  const contextKey=JSON.stringify([chainId,tokenAddress.trim(),connectedWallet]);
  const contextRef=useRef(contextKey);contextRef.current=contextKey;
  const current=()=>contextRef.current===contextKey;
  const lookupComplete=lookupCompleted&&resolvedFor===contextKey;
  const showError=(error:any)=>{if(!current())return;setFeedback(projectImportFeedback(error));if(error?.currentAuthority){setEvidence(null);setLookupComplete(false);}};
  const validAddress=useMemo(()=>{const value=tokenAddress.trim();return chain==="bnb"?/^0x[a-fA-F0-9]{40}$/.test(value):isSolanaAddress(value);},[chain,tokenAddress]);
  const ownerVerified=item?.ownershipStatus==="ownership_verified"; const conflictingVerified=ownerVerified&&Boolean(item?.projectOwnerWallet)&&!sameWallet(item?.projectOwnerWallet,connectedWallet,chain==="solana");
  const wrongAuthorityWallet=lookupComplete&&evidence?.automaticOwnershipAvailable===true&&Boolean(evidence.currentAuthority)&&!sameWallet(evidence.currentAuthority,connectedWallet,chain==="solana");
  const approvedOwner=Boolean(lookupComplete&&connected&&ownerVerified&&!conflictingVerified&&!wrongAuthorityWallet);
  const suspended=item?.ownershipStatus==="ownership_suspended";
  const ownershipUnavailable=!approvedOwner&&lookupComplete&&evidence?.automaticOwnershipAvailable===false;
  const securityStatus=evidence?.security?.status||null;
  const securityPass=securityStatus==="pass";
  const securityBlocked=securityStatus==="blocked";
  const securityReview=securityStatus==="review";
  const manualReviewPending=item?.ownershipStatus==="ownership_manual_review";
  const manualReviewMine=Boolean(lookupComplete&&!wrongAuthorityWallet&&!suspended&&manualReviewPending&&sameWallet(item?.manualClaimWallet,connectedWallet,chain==="solana"));
  const manualReviewReason=ownershipUnavailable||securityBlocked||securityReview;
  const canRequestManual=lookupComplete&&Boolean(evidence)&&!wrongAuthorityWallet&&!conflictingVerified&&!suspended&&!approvedOwner&&!manualReviewPending&&manualReviewReason;
  const canProceedToImage=approvedOwner||Boolean(evidence?.signedWalletMatchesAuthority&&securityPass&&(!item||approvedOwner));
  const canSelectImage=lookupComplete&&connected&&!wrongAuthorityWallet&&!conflictingVerified&&!suspended&&(canProceedToImage||canRequestManual||manualReviewMine);
  const expectedAuthorityShort=wrongAuthorityWallet?shortenWallet(evidence?.currentAuthority):""; const connectedWalletShort=shortenWallet(connectedWallet);
  const reset=()=>{setItem(null);setEvidence(null);setLookupComplete(false);setResolvedFor("");setImageFile(null);setImagePreview("");setFeedback(null);};
  useEffect(()=>{reset();},[chainId,connectedWallet]);
  useEffect(()=>()=>{if(imagePreview)URL.revokeObjectURL(imagePreview);},[imagePreview]);
  useEffect(()=>{if(chainChosenByUser)return;if(!detectedChain||detectedChain===chain)return;setChain(detectedChain);reset();},[detectedChain,chainChosenByUser,chain]);
  const connect=async()=>{try{if(chain==="solana")await solanaWallet.connectSolana();else await wallet.connect();}catch(error:any){showError(error);}};
  const signAction=async(action:string, projectId:string|null, body:unknown=null, imageDigest:string|null=null)=>{if(!connectedWallet||!current())throw new Error("Wallet changed. Connect the correct wallet and press IMPORT again.");const token=tokenAddress.trim();const extraLines=await projectImportIntentLines({action,chainId,token,projectId,body,imageDigest});if(chain==="solana")return signWalletAction({action,walletAddress:connectedWallet,chainId,walletType:"solana",extraLines,signMessage:async(message)=>(await signSolanaMessage(message,connectedWallet)).signature});return signWalletAction({action,walletAddress:connectedWallet,chainId,extraLines,signer:wallet.signer});};
  const chooseImage=(file:File|null)=>{if(!canSelectImage){toast.error(wrongAuthorityWallet?"Connect the token owner wallet before continuing.":"Complete the token checks before uploading an image.");return;}if(!file){setImageFile(null);setImagePreview("");return;}if(file.size>MAX_IMAGE_BYTES){showError(new Error("Image is too large. Maximum size is 5 MB."));return;}if(!ALLOWED_IMAGE_TYPES.has(file.type.toLowerCase())){showError(new Error("Use PNG, JPEG or WEBP."));return;}setImageFile(file);setImagePreview(URL.createObjectURL(file));};
  const attachRegistrationImage=async(project:ProjectImportItem,file:File)=>{try{const digest=await projectImportImageDigest(file);const auth=await signAction("project_import_registration_image",project.id,null,digest);return await uploadProjectRegistrationImage({item:project,file,auth});}catch(error:any){throw Object.assign(error instanceof Error?error:new Error(String(error?.message||error)),{importStage:"image"});}};
  const resolve=async()=>{
    if(!validAddress||!connected||working)return;reset();setWorking(true);
    try{const auth=await signAction("project_import_resolve",null);if(!current())return;
      const result=await resolveProjectImportWithProject({tokenAddress:tokenAddress.trim(),chainId,auth});if(!current())return;
      setItem(result.project);setEvidence(result.resolved);setResolvedFor(contextKey);setLookupComplete(true);
    }catch(error){showError(error);}finally{setWorking(false);}
  };
  const remember=(project:ProjectImportItem)=>{if(!current())return;setItem(project);setResolvedFor(contextKey);setLookupComplete(true);onProjectChange?.(project);};
  const register=async()=>{
    if(!lookupComplete||!connected||working||wrongAuthorityWallet||conflictingVerified||suspended||!evidence?.signedWalletMatchesAuthority||!securityPass||!imageFile)return;
    setWorking(true);setFeedback(null);
    try{const auth=await signAction("project_import_create",null,{operation:"create"});if(!current())return;
      const result=await createProjectImport({tokenAddress:tokenAddress.trim(),chainId,auth});if(!current())return;remember(result.project);
      if(!result.project.imageUrl)remember(await attachRegistrationImage(result.project,imageFile));
    }catch(error){showError(error);}finally{setWorking(false);}
  };
  const claim=async()=>{
    if(!lookupComplete||!item||wrongAuthorityWallet||conflictingVerified||suspended||!evidence?.signedWalletMatchesAuthority||!securityPass||working)return;
    setWorking(true);setFeedback(null);
    try{const auth=await signAction("project_import_claim",item.id,{operation:"claim"});if(!current())return;remember(await claimProjectImport({item,auth}));}
    catch(error){showError(error);}finally{setWorking(false);}
  };
  const uploadPendingImage=async(project:ProjectImportItem)=>{if(project.imageUrl)return project;if(!current())throw new Error("Wallet or Contract Address changed. Press IMPORT again.");if(!imageFile)throw new Error("Add the project image before requesting manual review.");return attachRegistrationImage(project,imageFile);};
  const manual=async()=>{
    if(!canRequestManual||working)return;if(!imageFile&&!item?.imageUrl){showError(new Error("Add the project image before requesting manual review."));return;}
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
  const securityRisks=[...(evidence?.security?.criticalRisks||[]),...(evidence?.security?.reviewRisks||[])];
  const body = <>
    {embedded ? null : <section className="mwz-hud-frame p-5"><div className="text-[11px] uppercase tracking-[0.2em] text-accent">Existing project onboarding</div><h1 className="mt-2 font-retro text-2xl text-foreground">IMPORT YOUR MEMECOIN</h1><p className="mt-3 max-w-2xl text-sm text-muted-foreground">Enter the existing token contract address. MemeWarzone validates the token, checks scam-risk signals and verifies that the connected wallet is its current owner before registration can continue.</p></section>}
    <section className={embedded ? "space-y-5" : "mwz-hud-frame space-y-5 p-5"}>
      <div><div className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">1. Choose chain</div><div className="mt-3 flex gap-2"><Button type="button" disabled={working} variant={chain==="bnb"?"default":"outline"} onClick={()=>{setChainChosenByUser(true);setChain("bnb");reset();}}>BNB</Button><Button type="button" disabled={working} variant={chain==="solana"?"default":"outline"} onClick={()=>{setChainChosenByUser(true);setChain("solana");reset();}}>Solana</Button></div></div>
      <div><div className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">2. Wallet</div><div className="mt-3 flex flex-wrap items-center gap-3"><Button type="button" variant="outline" onClick={()=>void connect()} disabled={chain==="bnb"?wallet.connecting:solanaWallet.connectingSolana}>{connected?"WALLET CONNECTED":chain==="bnb"?"CONNECT BNB WALLET":"CONNECT SOLANA WALLET"}</Button>{connectedWallet?<span className="max-w-full truncate text-xs text-muted-foreground">{connectedWallet}</span>:null}</div></div>
      <div><label htmlFor="project-import-token" className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">3. Contract Address</label><div className="mt-3 flex flex-col gap-2 sm:flex-row"><Input id="project-import-token" disabled={working} value={tokenAddress} onChange={(e)=>{setTokenAddress(e.target.value);reset();}} placeholder="Contract Address"/><Button type="button" variant="outline" disabled={!validAddress||!connected||working} onClick={()=>void resolve()}>{working?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:<Search className="mr-2 h-4 w-4"/>}IMPORT</Button></div>{!connected?<p className="mt-2 text-xs text-amber-200">Connect a wallet before importing.</p>:null}{tokenAddress.trim()&&!validAddress?<p role="alert" className="mt-2 text-sm text-red-200">This Contract Address is not valid for the selected chain. Check the address or choose the correct chain.</p>:null}</div>
      {canSelectImage?<div data-project-import-image-required="true"><label htmlFor="project-import-image" className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">4. Project image</label><p className="mt-2 text-xs text-muted-foreground">{canRequestManual||manualReviewMine?"Add the image that should appear when the manual review is approved. The project remains hidden while review is pending.":"Ownership and security checks passed. Add the project image to finish registration."} PNG, JPEG or WEBP.</p><div className="mt-3 flex items-center gap-3"><input id="project-import-image" disabled={working} type="file" accept="image/png,image/jpeg,image/webp" onChange={(e)=>chooseImage(e.target.files?.[0]||null)}/><span className="text-xs text-muted-foreground">{imageFile?imageFile.name:item?.imageUrl?"Image already attached":"No image selected"}</span></div>{imagePreview?<img src={imagePreview} alt="Selected project" className="mt-3 h-16 w-16 rounded-md object-cover"/>:null}</div>:null}
    </section>
    {feedback?<section role="alert" data-import-error="true" className="rounded-md border border-red-300/40 bg-red-400/10 p-4"><h2 className="font-retro text-sm text-red-100">{feedback.title}</h2><p className="mt-2 text-sm text-red-50">{feedback.message}</p>{feedback.retry?<Button type="button" variant="outline" className="mt-3" disabled={working||!validAddress||!connected} onClick={()=>void resolve()}>RETRY CHECK</Button>:null}</section>:null}
    {lookupComplete?<section className={embedded ? "border-t border-white/10 pt-5" : "mwz-hud-frame p-5"} data-import-ownership-result="true">
      {wrongAuthorityWallet?<div className="rounded-md border border-red-300/40 bg-red-400/10 p-4" data-import-wrong-wallet-warning="true"><h2 className="font-retro text-sm text-red-100">NOT TOKEN OWNER</h2><p className="mt-2 text-sm text-red-50">This token is controlled by wallet <strong>{expectedAuthorityShort}</strong>. Connect that wallet to continue.</p>{connectedWalletShort?<p className="mt-2 text-xs text-red-100/80">Connected: {connectedWalletShort}</p>:null}<p className="mt-3 text-xs font-semibold uppercase tracking-[0.12em] text-red-100">Import blocked</p></div>:null}
      {ownershipUnavailable?<div className="mt-4 rounded-md border border-amber-300/40 bg-amber-400/10 p-4" data-import-ownership-unavailable="true"><h2 className="font-retro text-sm text-amber-100">OWNERSHIP CANNOT BE VERIFIED</h2><p className="mt-2 text-sm text-amber-50">MemeWarzone cannot automatically prove that this connected wallet owns the token. Add the project image and request a manual check.</p></div>:null}
      {!wrongAuthorityWallet&&(securityBlocked||securityReview)&&!approvedOwner?<div className="mt-4 rounded-md border border-amber-300/40 bg-amber-400/10 p-4" data-import-security-review="true"><h2 className="font-retro text-sm text-amber-100">TOKEN SECURITY REVIEW REQUIRED</h2><p className="mt-2 text-sm text-amber-50">Automatic import is locked because the token security scan found risk signals or could not confidently clear the token. Add the project image and request manual review.</p>{securityRisks.length?<ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-amber-100/90">{securityRisks.slice(0,6).map((risk)=><li key={risk.code}>{risk.label}</li>)}</ul>:null}</div>:null}
      {manualReviewPending?<div className="mt-4 rounded-md border border-sky-300/40 bg-sky-400/10 p-4" data-import-manual-review-pending="true"><h2 className="font-retro text-sm text-sky-100">MANUAL CHECK REQUESTED</h2><p className="mt-2 text-sm text-sky-50">Your request is in the web-dashboard review queue. The project stays hidden until an admin approves it.{item?.imageUrl?" The project image is attached.":" An image is still required before approval."}</p>{manualReviewMine&&!item?.imageUrl&&imageFile?<Button type="button" className="mt-4" variant="outline" disabled={working} onClick={()=>void attachManualImage()}>{manualReviewMine?"ATTACH IMAGE TO REVIEW":"ATTACH REQUIRED IMAGE"}</Button>:null}</div>:null}
      {canRequestManual?<div className="mt-4"><Button type="button" variant="outline" disabled={working||!imageFile} onClick={()=>void manual()}>REQUEST MANUAL CHECK</Button><p className="mt-2 text-xs text-muted-foreground">Manual review is available when automatic ownership cannot be proven or token-security checks require review. A known different owner wallet cannot use this fallback.</p></div>:null}
      {approvedOwner?<><div className="mt-4 flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 text-emerald-300"/><div><h2 className="font-retro text-sm text-foreground">OWNER VERIFIED</h2><p className="mt-2 text-sm text-muted-foreground">This connected wallet is the approved project owner.</p></div></div><div className="mt-5 flex flex-wrap gap-2">{item?.imageUrl?<Button type="button" onClick={()=>navigate(projectUrl(item))}><CheckCircle2 className="mr-2 h-4 w-4"/>OPEN PROJECT PAGE</Button>:null}{!item?.imageUrl?<Button type="button" variant="outline" disabled={working||!imageFile} onClick={()=>void attachManualImage()}>ATTACH REQUIRED IMAGE</Button>:null}</div></>:null}
      {!approvedOwner&&!wrongAuthorityWallet&&!ownershipUnavailable&&securityPass&&item?<><div className="mt-4 flex items-start gap-3"><ShieldQuestion className="mt-0.5 h-5 w-5 text-amber-200"/><div><h2 className="font-retro text-sm text-foreground">PROJECT ALREADY REGISTERED</h2><p className="mt-2 text-sm text-muted-foreground">The token already has a project registration. Verify current ownership before continuing.</p></div></div><div className="mt-5 flex flex-wrap gap-2">{evidence?.signedWalletMatchesAuthority?<Button type="button" variant="outline" onClick={()=>void claim()} disabled={working}>VERIFY CURRENT OWNERSHIP</Button>:null}</div></>:null}
      {!approvedOwner&&!wrongAuthorityWallet&&!ownershipUnavailable&&securityPass&&!item&&evidence?.signedWalletMatchesAuthority?<><h2 className="mt-4 font-retro text-sm text-emerald-200">OWNER + SECURITY VERIFIED</h2><p className="mt-2 text-sm text-muted-foreground">Token checks passed, the connected wallet matches the current token authority, and the automatic scam-risk scan passed. Upload the project image to continue.</p><Button type="button" className="mt-4" disabled={!imageFile||working} onClick={()=>void register()}>REGISTER MEMECOIN</Button></>:null}
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
