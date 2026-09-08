import { useEffect, useMemo, useState } from "react";
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
  lookupProjectImport,
  projectImportImageDigest,
  projectImportIntentLines,
  requestProjectClaim,
  resolveProjectImport,
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

export function ProjectImportPanel({
  embedded = false,
  onProjectChange,
}: {
  embedded?: boolean;
  onProjectChange?: (item: ProjectImportItem) => void;
}) {
  const navigate = useNavigate(); const wallet = useWallet(); const solanaWallet = useSolanaWallet(); const feedWallet = useActiveFeedWallet();
  const detectedChain = detectImportChain(feedWallet.solanaAccount, feedWallet.evmAccount, feedWallet.isSolana);
  const [chain,setChain]=useState<ImportChain>(detectedChain || "bnb"); const [chainChosenByUser,setChainChosenByUser]=useState(false); const [tokenAddress,setTokenAddress]=useState(""); const [item,setItem]=useState<ProjectImportItem|null>(null); const [evidence,setEvidence]=useState<ProjectResolveResult|null>(null); const [lookupComplete,setLookupComplete]=useState(false); const [working,setWorking]=useState(false);
  const [imageFile,setImageFile]=useState<File|null>(null); const [imagePreview,setImagePreview]=useState("");
  const chainId=chain==="bnb"?BNB_CHAIN_ID:SOLANA_CHAIN_ID; const connectedWallet=chain==="bnb"?wallet.account:solanaWallet.solanaAccount; const connected=Boolean(connectedWallet);
  const validAddress=useMemo(()=>{const value=tokenAddress.trim();return chain==="bnb"?/^0x[a-fA-F0-9]{40}$/.test(value):isSolanaAddress(value);},[chain,tokenAddress]);
  const ownerVerified=item?.ownershipStatus==="ownership_verified"; const conflictingVerified=ownerVerified&&Boolean(item?.projectOwnerWallet)&&!sameWallet(item?.projectOwnerWallet,connectedWallet,chain==="solana");
  const reset=()=>{setItem(null);setEvidence(null);setLookupComplete(false);};
  useEffect(()=>{if(chainChosenByUser)return;if(!detectedChain||detectedChain===chain)return;setChain(detectedChain);reset();},[detectedChain,chainChosenByUser,chain]);
  const connect=async()=>{try{if(chain==="solana")await solanaWallet.connectSolana();else await wallet.connect();}catch(error:any){toast.error(String(error?.message||"Wallet connection failed."));}};
  const signAction=async(action:string, projectId:string|null, body:unknown=null, imageDigest:string|null=null)=>{if(!connectedWallet)throw new Error("Connect a wallet first.");const token=tokenAddress.trim();const extraLines=await projectImportIntentLines({action,chainId,token,projectId,body,imageDigest});if(chain==="solana")return signWalletAction({action,walletAddress:connectedWallet,chainId,walletType:"solana",extraLines,signMessage:async(message)=>(await signSolanaMessage(message,connectedWallet)).signature});return signWalletAction({action,walletAddress:connectedWallet,chainId,extraLines,signer:wallet.signer});};
  const chooseImage=(file:File|null)=>{if(!file){setImageFile(null);setImagePreview("");return;}if(file.size>MAX_IMAGE_BYTES){toast.error("Image is too large. Maximum size is 5 MB.");return;}if(!ALLOWED_IMAGE_TYPES.has(file.type.toLowerCase())){toast.error("Use PNG, JPEG or WEBP.");return;}setImageFile(file);setImagePreview(URL.createObjectURL(file));};
  const attachRegistrationImage=async(project:ProjectImportItem,file:File)=>{const digest=await projectImportImageDigest(file);const auth=await signAction("project_import_registration_image",project.id,null,digest);return uploadProjectRegistrationImage({item:project,file,auth});};
  const resolve=async()=>{if(!validAddress||!connected||working)return;setWorking(true);try{const token=tokenAddress.trim();const existing=await lookupProjectImport(token,chainId);const auth=await signAction("project_import_resolve",null);const resolved=await resolveProjectImport({tokenAddress:token,chainId,auth});setItem(existing);setEvidence(resolved);setLookupComplete(true);}catch(error:any){toast.error(String(error?.message||"Project resolution failed."));setItem(null);setEvidence(null);setLookupComplete(true);}finally{setWorking(false);}};
  const register=async()=>{if(!connected||!validAddress||working)return;if(!imageFile){toast.error("Add a project image (PNG, JPEG or WEBP) before registering.");return;}setWorking(true);const id=toast.loading("Registering project...");try{const body={operation:"create"};const auth=await signAction("project_import_create",null,body);const result=await createProjectImport({tokenAddress:tokenAddress.trim(),chainId,auth});let project=result.project;if(!project.imageUrl){try{project=await attachRegistrationImage(project,imageFile);}catch(error:any){setItem(project);setLookupComplete(true);onProjectChange?.(project);throw new Error(String(error?.message||"Project registered, but a valid PNG, JPEG or WEBP image is still required."));}}setItem(project);setLookupComplete(true);onProjectChange?.(project);toast.success(project.ownershipStatus==="ownership_verified"?"Project registered. Ownership verified.":"Project registered.");}catch(error:any){toast.error(String(error?.message||"Could not register project."));}finally{toast.dismiss(id);setWorking(false);}};
  const claim=async()=>{if(!item||!evidence?.signedWalletMatchesAuthority||working)return;setWorking(true);const id=toast.loading("Verifying current ownership...");try{const body={operation:"claim"};const auth=await signAction("project_import_claim",item.id,body);const next=await claimProjectImport({item,auth});setItem(next);onProjectChange?.(next);toast.success("Project ownership verified.");}catch(error:any){toast.error(String(error?.message||"Could not verify ownership."));}finally{toast.dismiss(id);setWorking(false);}};
  const manual=async()=>{if(!item||evidence?.automaticOwnershipAvailable!==false||conflictingVerified||working)return;setWorking(true);const id=toast.loading("Requesting project claim...");try{const note=null;const auth=await signAction("project_import_manual_claim",item.id,{note});const next=await requestProjectClaim({item,auth});setItem(next);onProjectChange?.(next);toast.success("Project claim requested for manual review.");}catch(error:any){toast.error(String(error?.message||"Could not request project claim."));}finally{toast.dismiss(id);setWorking(false);}};
  const body = <>
    {embedded ? null : <section className="mwz-hud-frame p-5"><div className="text-[11px] uppercase tracking-[0.2em] text-accent">Existing project onboarding</div><h1 className="mt-2 font-retro text-2xl text-foreground">IMPORT YOUR MEMECOIN</h1><p className="mt-3 max-w-2xl text-sm text-muted-foreground">Register an existing BNB or Solana memecoin. MemeWarzone resolves token identity server-side and checks current ownership authority where the chain exposes it.</p></section>}
    <section className={embedded ? "space-y-5" : "mwz-hud-frame space-y-5 p-5"}>
      <div><div className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">1. Choose chain</div><div className="mt-3 flex gap-2"><Button type="button" variant={chain==="bnb"?"default":"outline"} onClick={()=>{setChainChosenByUser(true);setChain("bnb");reset();}}>BNB</Button><Button type="button" variant={chain==="solana"?"default":"outline"} onClick={()=>{setChainChosenByUser(true);setChain("solana");reset();}}>Solana</Button></div></div>
      <div><div className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">2. Connect wallet</div><div className="mt-3 flex flex-wrap items-center gap-3"><Button type="button" variant="outline" onClick={()=>void connect()} disabled={chain==="bnb"?wallet.connecting:solanaWallet.connectingSolana}>{connected?"WALLET CONNECTED":chain==="bnb"?"CONNECT BNB WALLET":"CONNECT SOLANA WALLET"}</Button>{connectedWallet?<span className="max-w-full truncate text-xs text-muted-foreground">{connectedWallet}</span>:null}</div></div>
      <div><label htmlFor="project-import-token" className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">3. Contract / mint</label><div className="mt-3 flex flex-col gap-2 sm:flex-row"><Input id="project-import-token" value={tokenAddress} onChange={(e)=>{setTokenAddress(e.target.value);reset();}} placeholder={chain==="bnb"?"0x...":"Solana mint address"}/><Button type="button" variant="outline" disabled={!validAddress||!connected||working} onClick={()=>void resolve()}>{working?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:<Search className="mr-2 h-4 w-4"/>}IMPORT</Button></div>{!connected?<p className="mt-2 text-xs text-amber-200">Connect a wallet to resolve ownership evidence.</p>:null}</div>
      <div data-project-import-image-required="true"><label htmlFor="project-import-image" className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">4. Project image</label><p className="mt-2 text-xs text-muted-foreground">Required to finish registration. PNG, JPEG or WEBP. This does not make you the verified project owner.</p><div className="mt-3 flex items-center gap-3"><input id="project-import-image" type="file" accept="image/png,image/jpeg,image/webp" onChange={(e)=>chooseImage(e.target.files?.[0]||null)}/><span className="text-xs text-muted-foreground">{imageFile?imageFile.name:"No image selected"}</span></div>{imagePreview?<img src={imagePreview} alt="Selected project" className="mt-3 h-16 w-16 rounded-md object-cover"/>:null}</div>
    </section>
    {lookupComplete?<section className={embedded ? "border-t border-white/10 pt-5" : "mwz-hud-frame p-5"} data-import-ownership-result="true">{item?<><div className="flex items-start gap-3">{ownerVerified?<ShieldCheck className="mt-0.5 h-5 w-5 text-emerald-300"/>:<ShieldQuestion className="mt-0.5 h-5 w-5 text-amber-200"/>}<div><h2 className="font-retro text-sm text-foreground">{ownerVerified?"OWNER VERIFIED":item.ownershipStatus==="ownership_manual_review"?"OWNERSHIP REVIEW REQUESTED":evidence?.automaticOwnershipAvailable===false?"AUTOMATIC OWNERSHIP VERIFICATION UNAVAILABLE":"PROJECT REGISTERED"}</h2><p className="mt-2 text-sm text-muted-foreground">{ownerVerified?"Project page control is bound to the verified project owner.":item.ownershipStatus==="ownership_manual_review"?"Your signed ownership claim is waiting for operator review. This does not grant edit rights or Arena access.":evidence?.automaticOwnershipAvailable===false?"Current chain authority cannot be verified automatically. Any properly signed claimant may request manual project ownership review.":"Current authority exists, but this connected wallet is not verified as that authority."}</p></div></div><div className="mt-5 flex flex-wrap gap-2">{!ownerVerified&&evidence?.signedWalletMatchesAuthority?<Button type="button" variant="outline" onClick={()=>void claim()} disabled={working}>CLAIM CURRENT OWNERSHIP</Button>:null}{!ownerVerified&&item.ownershipStatus!=="ownership_manual_review"&&evidence?.automaticOwnershipAvailable===false&&!conflictingVerified?<Button type="button" variant="outline" onClick={()=>void manual()} disabled={working}>REQUEST PROJECT CLAIM</Button>:null}{item.imageUrl?<Button type="button" onClick={()=>navigate(projectUrl(item))}><CheckCircle2 className="mr-2 h-4 w-4"/>OPEN PROJECT PAGE</Button>:imageFile?<Button type="button" variant="outline" disabled={working} onClick={()=>void register()}>ATTACH REQUIRED IMAGE</Button>:<p className="text-xs text-amber-200">A project image is required before this import is complete.</p>}</div></>:<><h2 className="font-retro text-sm text-foreground">PROJECT NOT REGISTERED</h2>{evidence?<p className="mt-2 text-sm text-muted-foreground">Resolved {evidence.symbol?`$${evidence.symbol}`:"token identity"}. Register it to create the imported project page.</p>:null}<Button type="button" className="mt-4" disabled={!connected||!validAddress||working||!evidence||!imageFile} onClick={()=>void register()}>REGISTER &amp; VERIFY MEMECOIN</Button></>}</section>:null}
  </>;
  if (embedded) return <div className="space-y-5" data-project-import-panel="true">{body}</div>;
  return <ContentContainer className="space-y-6 px-1 pb-12 pt-2" data-project-import-page="true">{body}</ContentContainer>;
}

export default function ProjectImport() {
  const feedWallet = useActiveFeedWallet();
  return <Navigate to={commandCenterImportPath(feedWallet.address)} replace />;
}

function sameWallet(a:string|null|undefined,b:string|null|undefined,solana:boolean){const left=String(a||"").trim(),right=String(b||"").trim();if(!left||!right)return false;return solana?left===right:left.toLowerCase()===right.toLowerCase();}
