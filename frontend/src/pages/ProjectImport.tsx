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
  const [chain,setChain]=useState<ImportChain>(detectedChain || "bnb"); const [chainChosenByUser,setChainChosenByUser]=useState(false); const [tokenAddress,setTokenAddress]=useState(""); const [item,setItem]=useState<ProjectImportItem|null>(null); const [evidence,setEvidence]=useState<ProjectResolveResult|null>(null); const [lookupComplete,setLookupComplete]=useState(false); const [working,setWorking]=useState(false);
  const [imageFile,setImageFile]=useState<File|null>(null); const [imagePreview,setImagePreview]=useState("");
  const chainId=chain==="bnb"?BNB_CHAIN_ID:SOLANA_CHAIN_ID; const connectedWallet=chain==="bnb"?wallet.account:solanaWallet.solanaAccount; const connected=Boolean(connectedWallet);
  const validAddress=useMemo(()=>{const value=tokenAddress.trim();return chain==="bnb"?/^0x[a-fA-F0-9]{40}$/.test(value):isSolanaAddress(value);},[chain,tokenAddress]);
  const ownerVerified=item?.ownershipStatus==="ownership_verified"; const conflictingVerified=ownerVerified&&Boolean(item?.projectOwnerWallet)&&!sameWallet(item?.projectOwnerWallet,connectedWallet,chain==="solana");
  const wrongAuthorityWallet=evidence?.automaticOwnershipAvailable===true&&Boolean(evidence.currentAuthority)&&!evidence.signedWalletMatchesAuthority;
  const ownershipUnavailable=lookupComplete&&evidence?.automaticOwnershipAvailable===false;
  const canProceedToImage=Boolean(evidence?.signedWalletMatchesAuthority)&&(!item||(ownerVerified&&!conflictingVerified));
  const expectedAuthorityShort=wrongAuthorityWallet?shortenWallet(evidence?.currentAuthority):""; const connectedWalletShort=shortenWallet(connectedWallet);
  const reset=()=>{setItem(null);setEvidence(null);setLookupComplete(false);setImageFile(null);setImagePreview("");};
  useEffect(()=>{if(chainChosenByUser)return;if(!detectedChain||detectedChain===chain)return;setChain(detectedChain);reset();},[detectedChain,chainChosenByUser,chain]);
  const connect=async()=>{try{if(chain==="solana")await solanaWallet.connectSolana();else await wallet.connect();}catch(error:any){toast.error(String(error?.message||"Wallet connection failed."));}};
  const signAction=async(action:string, projectId:string|null, body:unknown=null, imageDigest:string|null=null)=>{if(!connectedWallet)throw new Error("Connect a wallet first.");const token=tokenAddress.trim();const extraLines=await projectImportIntentLines({action,chainId,token,projectId,body,imageDigest});if(chain==="solana")return signWalletAction({action,walletAddress:connectedWallet,chainId,walletType:"solana",extraLines,signMessage:async(message)=>(await signSolanaMessage(message,connectedWallet)).signature});return signWalletAction({action,walletAddress:connectedWallet,chainId,extraLines,signer:wallet.signer});};
  const chooseImage=(file:File|null)=>{if(!canProceedToImage){toast.error("Verify token ownership before uploading an image.");return;}if(!file){setImageFile(null);setImagePreview("");return;}if(file.size>MAX_IMAGE_BYTES){toast.error("Image is too large. Maximum size is 5 MB.");return;}if(!ALLOWED_IMAGE_TYPES.has(file.type.toLowerCase())){toast.error("Use PNG, JPEG or WEBP.");return;}setImageFile(file);setImagePreview(URL.createObjectURL(file));};
  const attachRegistrationImage=async(project:ProjectImportItem,file:File)=>{const digest=await projectImportImageDigest(file);const auth=await signAction("project_import_registration_image",project.id,null,digest);return uploadProjectRegistrationImage({item:project,file,auth});};
  const resolve=async()=>{if(!validAddress||!connected||working)return;setWorking(true);setImageFile(null);setImagePreview("");try{const token=tokenAddress.trim();const existing=await lookupProjectImport(token,chainId);const auth=await signAction("project_import_resolve",null);const resolved=await resolveProjectImport({tokenAddress:token,chainId,auth});setItem(existing);setEvidence(resolved);setLookupComplete(true);if(resolved.automaticOwnershipAvailable&&!resolved.signedWalletMatchesAuthority){toast.error("This wallet is not the owner of this token.");}else if(!resolved.automaticOwnershipAvailable){toast.error("Token ownership cannot be verified. Import is blocked.");}}catch(error:any){toast.error(String(error?.message||"Project resolution failed."));setItem(null);setEvidence(null);setLookupComplete(true);}finally{setWorking(false);}};
  const register=async()=>{if(!connected||!validAddress||working)return;if(!evidence?.signedWalletMatchesAuthority){toast.error("Token ownership must be verified before importing.");return;}if(!imageFile){toast.error("Add a project image (PNG, JPEG or WEBP) before registering.");return;}setWorking(true);const id=toast.loading("Registering project...");try{const body={operation:"create"};const auth=await signAction("project_import_create",null,body);const result=await createProjectImport({tokenAddress:tokenAddress.trim(),chainId,auth});let project=result.project;if(!project.imageUrl){try{project=await attachRegistrationImage(project,imageFile);}catch(error:any){setItem(project);setLookupComplete(true);onProjectChange?.(project);throw new Error(String(error?.message||"Project registered, but a valid PNG, JPEG or WEBP image is still required."));}}setItem(project);setLookupComplete(true);onProjectChange?.(project);toast.success("Project registered. Ownership verified.");}catch(error:any){toast.error(String(error?.message||"Could not register project."));}finally{toast.dismiss(id);setWorking(false);}};
  const claim=async()=>{if(!item||!evidence?.signedWalletMatchesAuthority||working)return;setWorking(true);const id=toast.loading("Verifying current ownership...");try{const body={operation:"claim"};const auth=await signAction("project_import_claim",item.id,body);const next=await claimProjectImport({item,auth});setItem(next);onProjectChange?.(next);toast.success("Project ownership verified. You can now upload the project image.");}catch(error:any){toast.error(String(error?.message||"Could not verify ownership."));}finally{toast.dismiss(id);setWorking(false);}};
  const body = <>
    {embedded ? null : <section className="mwz-hud-frame p-5"><div className="text-[11px] uppercase tracking-[0.2em] text-accent">Existing project onboarding</div><h1 className="mt-2 font-retro text-2xl text-foreground">IMPORT YOUR MEMECOIN</h1><p className="mt-3 max-w-2xl text-sm text-muted-foreground">Enter the existing token contract address. MemeWarzone validates the token and verifies that the connected wallet is its current owner before registration can continue.</p></section>}
    <section className={embedded ? "space-y-5" : "mwz-hud-frame space-y-5 p-5"}>
      <div><div className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">1. Choose chain</div><div className="mt-3 flex gap-2"><Button type="button" variant={chain==="bnb"?"default":"outline"} onClick={()=>{setChainChosenByUser(true);setChain("bnb");reset();}}>BNB</Button><Button type="button" variant={chain==="solana"?"default":"outline"} onClick={()=>{setChainChosenByUser(true);setChain("solana");reset();}}>Solana</Button></div></div>
      <div><div className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">2. Wallet</div><div className="mt-3 flex flex-wrap items-center gap-3"><Button type="button" variant="outline" onClick={()=>void connect()} disabled={chain==="bnb"?wallet.connecting:solanaWallet.connectingSolana}>{connected?"WALLET CONNECTED":chain==="bnb"?"CONNECT BNB WALLET":"CONNECT SOLANA WALLET"}</Button>{connectedWallet?<span className="max-w-full truncate text-xs text-muted-foreground">{connectedWallet}</span>:null}</div></div>
      <div><label htmlFor="project-import-token" className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">3. Contract Address</label><div className="mt-3 flex flex-col gap-2 sm:flex-row"><Input id="project-import-token" value={tokenAddress} onChange={(e)=>{setTokenAddress(e.target.value);reset();}} placeholder="Contract Address"/><Button type="button" variant="outline" disabled={!validAddress||!connected||working} onClick={()=>void resolve()}>{working?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:<Search className="mr-2 h-4 w-4"/>}IMPORT</Button></div>{!connected?<p className="mt-2 text-xs text-amber-200">Connect a wallet before importing.</p>:null}</div>
      {canProceedToImage?<div data-project-import-image-required="true"><label htmlFor="project-import-image" className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">4. Project image</label><p className="mt-2 text-xs text-muted-foreground">Ownership verified. Add the project image to finish registration. PNG, JPEG or WEBP.</p><div className="mt-3 flex items-center gap-3"><input id="project-import-image" type="file" accept="image/png,image/jpeg,image/webp" onChange={(e)=>chooseImage(e.target.files?.[0]||null)}/><span className="text-xs text-muted-foreground">{imageFile?imageFile.name:"No image selected"}</span></div>{imagePreview?<img src={imagePreview} alt="Selected project" className="mt-3 h-16 w-16 rounded-md object-cover"/>:null}</div>:null}
    </section>
    {lookupComplete?<section className={embedded ? "border-t border-white/10 pt-5" : "mwz-hud-frame p-5"} data-import-ownership-result="true">
      {wrongAuthorityWallet?<div className="rounded-md border border-red-300/40 bg-red-400/10 p-4" data-import-wrong-wallet-warning="true"><h2 className="font-retro text-sm text-red-100">NOT TOKEN OWNER</h2><p className="mt-2 text-sm text-red-50">This token is controlled by wallet {expectedAuthorityShort}. Connect the owner wallet to continue.</p>{connectedWalletShort?<p className="mt-2 text-xs text-red-100/80">Connected: {connectedWalletShort}</p>:null}<p className="mt-3 text-xs font-semibold uppercase tracking-[0.12em] text-red-100">Import blocked</p></div>:null}
      {ownershipUnavailable?<div className="rounded-md border border-amber-300/40 bg-amber-400/10 p-4" data-import-ownership-unavailable="true"><h2 className="font-retro text-sm text-amber-100">OWNERSHIP CANNOT BE VERIFIED</h2><p className="mt-2 text-sm text-amber-50">MemeWarzone cannot prove that this connected wallet owns the token. Import is blocked.</p></div>:null}
      {!wrongAuthorityWallet&&!ownershipUnavailable&&item?<><div className="flex items-start gap-3">{ownerVerified&&!conflictingVerified?<ShieldCheck className="mt-0.5 h-5 w-5 text-emerald-300"/>:<ShieldQuestion className="mt-0.5 h-5 w-5 text-amber-200"/>}<div><h2 className="font-retro text-sm text-foreground">{ownerVerified&&!conflictingVerified?"OWNER VERIFIED":"PROJECT ALREADY REGISTERED"}</h2><p className="mt-2 text-sm text-muted-foreground">{ownerVerified&&!conflictingVerified?"The connected wallet is verified as the current token owner.":"The token already has a project registration. Verify current ownership before continuing."}</p></div></div><div className="mt-5 flex flex-wrap gap-2">{!ownerVerified&&evidence?.signedWalletMatchesAuthority?<Button type="button" variant="outline" onClick={()=>void claim()} disabled={working}>VERIFY CURRENT OWNERSHIP</Button>:null}{ownerVerified&&!conflictingVerified&&item.imageUrl?<Button type="button" onClick={()=>navigate(projectUrl(item))}><CheckCircle2 className="mr-2 h-4 w-4"/>OPEN PROJECT PAGE</Button>:null}{ownerVerified&&!conflictingVerified&&!item.imageUrl&&imageFile?<Button type="button" variant="outline" disabled={working} onClick={()=>void register()}>ATTACH REQUIRED IMAGE</Button>:null}</div></>:null}
      {!wrongAuthorityWallet&&!ownershipUnavailable&&!item&&evidence?.signedWalletMatchesAuthority?<><h2 className="font-retro text-sm text-emerald-200">OWNER VERIFIED</h2><p className="mt-2 text-sm text-muted-foreground">Token checks passed and the connected wallet matches the current token authority. Upload the project image to continue.</p><Button type="button" className="mt-4" disabled={!imageFile||working} onClick={()=>void register()}>REGISTER MEMECOIN</Button></>:null}
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
