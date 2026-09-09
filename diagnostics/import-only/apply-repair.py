from pathlib import Path
import re

# One-off, exact-anchor edit script. It does not touch runtime, CORS, database
# configuration, contracts, trading, Arena, or the integration branch.
changed = []
def edit(path, fn):
    p = Path(path)
    before = p.read_text()
    after = fn(before)
    if after == before:
        raise RuntimeError('No edit for ' + path)
    p.write_text(after)
    changed.append(path)
def replace(s, old, new):
    if s.count(old) != 1:
        raise RuntimeError('Expected exactly one anchor: ' + old[:140])
    return s.replace(old, new, 1)
def add(path, text):
    p = Path(path)
    if p.exists():
        raise RuntimeError('Unexpected existing file: ' + path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text.lstrip('\n'))
    changed.append(path)

def adapters(s):
    s = replace(s, 'import { resolveProjectOwnershipSolana } from "./projectOwnershipResolveSolana.js";', 'import { resolveProjectOwnershipSolana } from "./projectOwnershipResolveSolana.js";\nimport { assertSolanaImportMainnet, resolveSolanaProjectAuthority } from "./projectSolanaProjectAuthority.js";')
    s = replace(s, '  const raw = await resolveProjectOwnershipSolana({ mint: tokenAddress, connectedWallet: signedWallet, connection });', '  await assertSolanaImportMainnet(connection);\n  const raw = await resolveProjectOwnershipSolana({ mint: tokenAddress, connectedWallet: signedWallet, connection });')
    s = replace(s, '  if (!raw?.validMint) throw Object.assign(new Error(`Solana mint resolution failed: ${raw?.reason || "invalid mint"}`), { code: "SOLANA_MINT_INVALID" });', '''  if (!raw?.validMint) throw Object.assign(new Error(raw?.reason === "mint_lookup_failed" ? "Solana token lookup is temporarily unavailable." : "No valid Solana token was found. Check the Contract Address and selected chain."), { code: raw?.reason === "mint_lookup_failed" ? "PROJECT_IMPORT_RPC_UNAVAILABLE" : "SOLANA_MINT_INVALID" });
  const authority = await resolveSolanaProjectAuthority({ connection, mint: raw.mint, mintAuthority: raw.mintAuthority });''')
    return replace(s, '    automaticOwnershipAvailable: Boolean(raw.automaticVerificationAvailable),\n    currentAuthority: raw.mintAuthority ?? null,\n    signedWalletMatchesAuthority: Boolean(raw.verified),', '''    automaticOwnershipAvailable: Boolean(authority.currentAuthority),
    ...authority,
    mintAuthority: raw.mintAuthority ?? null,
    signedWalletMatchesAuthority: Boolean(authority.currentAuthority && authority.currentAuthority === new PublicKey(signedWallet).toBase58()),''')
edit('frontend/api/lib/projectImportResolverAdapters.js', adapters)
edit('frontend/api/lib/projectImportResolvers.js', lambda s: replace(s, 'signedWalletMatchesAuthority:Boolean(result?.signedWalletMatchesAuthority)', 'signedWalletMatchesAuthority:Boolean(result?.signedWalletMatchesAuthority),authoritySource:result?.authoritySource??null,authorityEvidenceAccount:result?.authorityEvidenceAccount??null,ownershipReason:result?.ownershipReason??null,mintAuthority:result?.mintAuthority??null'))

def api(s):
    s = replace(s, '"PROJECT_IMPORT_RESOLVER_UNAVAILABLE", "PROJECT_IMPORT_RPC_UNAVAILABLE"].includes(code)', '"PROJECT_IMPORT_RESOLVER_UNAVAILABLE", "PROJECT_IMPORT_RPC_UNAVAILABLE", "PROJECT_IMPORT_CHAIN_MISMATCH"].includes(code)')
    s = replace(s, '    currentVersion: error?.currentVersion || undefined,', '    currentAuthority: error?.currentAuthority || undefined,\n    currentVersion: error?.currentVersion || undefined,')
    s = replace(s, 'throw Object.assign(new Error("Connected wallet is not the current token owner"), { code: "OWNERSHIP_PROOF_REQUIRED" });', '''const address = String(resolved.currentAuthority || "");
    const masked = address.length > 8 ? `${address.slice(0, 4)}...${address.slice(-4)}` : address;
    throw Object.assign(new Error(`This token is controlled by wallet ${masked}. Connect that wallet to continue.`), { code: "OWNERSHIP_PROOF_REQUIRED", currentAuthority: address });''')
    s = replace(s, 'throw Object.assign(new Error("Connected wallet is not the current token owner. Connect the owner wallet to continue."), { code: "OWNERSHIP_PROOF_REQUIRED" });', 'requireResolvedOwner(resolved);')
    s = replace(s, '        if (!project) return json(res, 404, { error: "Imported project not found", code: "PROJECT_NOT_FOUND" });\n        return json(res, 200, { project: publicProject(project) });', '        return json(res, 200, { found: Boolean(project), project: publicProject(project) });')
    s = replace(s, 'const project = await enrichExistingProjectIdentity(identity, resolved);', 'const project = await enrichExistingProjectIdentity(identity, resolved) || await lookupProjectImport(pool, identity);')
    return s
edit('frontend/api/projectImports.js', api)

def client(s):
    s = replace(s, '  security?: ProjectImportSecurity;', '  security?: ProjectImportSecurity;\n  authoritySource?: string | null;\n  authorityEvidenceAccount?: string | null;\n  ownershipReason?: string | null;\n  mintAuthority?: string | null;')
    s = replace(s, 'async function readJson(res: Response) { return res.json().catch(() => ({})) as Promise<any>; }', '''async function readJson(res: Response) { return res.json().catch(() => ({})) as Promise<any>; }
function importRequestError(res: Response, json: any, fallback: string) {
  return Object.assign(new Error(String(json?.error || fallback)), { status: res.status, code: json?.code || null, currentAuthority: json?.currentAuthority || null });
}''')
    s = replace(s, '  if (res.status === 404) return null;\n  const json = await readJson(res); if (!res.ok || !json?.project) throw new Error(String(json?.error || `Project lookup failed (${res.status})`)); return json.project;', '''  const json = await readJson(res);
  // Compatibility with the explicit legacy empty-lookup response only.
  if (res.status === 404 && json?.code === "PROJECT_NOT_FOUND") return null;
  if (!res.ok || !Object.hasOwn(json, "project")) throw importRequestError(res, json, `Project lookup failed (${res.status})`);
  return json.project ?? null;''')
    s = replace(s, '''  const res = await apiFetch("/api/project-imports/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const json = await readJson(res); if (!res.ok || !json?.resolved) throw new Error(String(json?.error || `Project resolve failed (${res.status})`)); return json.resolved;''', '''  return (await resolveProjectImportWithProject(input)).resolved;
}
export async function resolveProjectImportWithProject(input: { tokenAddress: string; chainId: number; auth: WalletActionAuthPayload }): Promise<{ resolved: ProjectResolveResult; project: ProjectImportItem | null }> {
  const res = await apiFetch("/api/project-imports/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const json = await readJson(res);
  if (!res.ok || !json?.resolved) throw importRequestError(res, json, `Project resolve failed (${res.status})`);
  return { resolved: json.resolved, project: json.project ?? null };''')
    return re.sub(r'throw new Error\(String\(json\?\.error \|\| (`[^`]+`)\)\)', r'throw importRequestError(res, json, \1)', s)
edit('frontend/src/lib/projectImports.ts', client)

add('frontend/src/lib/projectImportFeedback.mjs', r'''
export function projectImportFeedback(error) {
  const code = String(error?.code || '');
  if (error?.currentAuthority) {
    const address = String(error.currentAuthority);
    const short = address.length > 8 ? `${address.slice(0, 4)}...${address.slice(-4)}` : address;
    return { title: 'NOT TOKEN OWNER', message: `This token is controlled by wallet ${short}. Connect that wallet to continue.`, retry: false };
  }
  if (error?.code === 4001 || /user rejected|user denied|request rejected/i.test(String(error?.message || ''))) return { title: 'SIGNATURE CANCELLED', message: 'The wallet signature was cancelled. Press IMPORT to try again.', retry: false };
  if (Number(error?.status) >= 500 || error instanceof TypeError || ['AbortError','TimeoutError'].includes(error?.name) || /failed to fetch|network|timeout/i.test(String(error?.message || ''))) return { title: 'IMPORT CHECK TEMPORARILY UNAVAILABLE', message: 'We could not complete this request. Nothing has been approved by this failed check. Please retry.', retry: true };
  if (['INVALID_TOKEN','SOLANA_MINT_INVALID','NO_DEPLOYED_BYTECODE','IMPORT_IDENTITY_INVALID'].includes(code)) return { title: 'CHECK CONTRACT ADDRESS AND CHAIN', message: 'No valid token was found for this Contract Address on the selected chain. Check both and try again.', retry: false };
  if (code === 'PROJECT_IMPORTS_DISABLED') return { title: 'IMPORTS TEMPORARILY UNAVAILABLE', message: 'The import service is disabled. Please try again later.', retry: true };
  if (Number(error?.status) === 401) return { title: 'WALLET VERIFICATION REQUIRED', message: 'Your wallet authorization could not be verified. Press IMPORT and sign a fresh request.', retry: false };
  return { title: 'IMPORT NOT COMPLETED', message: String(error?.message || 'The request could not be completed. Please retry.'), retry: false };
}
''')

def page(s):
    s = replace(s, 'import { useEffect, useMemo, useState } from "react";', 'import { useEffect, useMemo, useRef, useState } from "react";\nimport { projectImportFeedback } from "@/lib/projectImportFeedback.mjs";')
    s = replace(s, '  lookupProjectImport,\n', '')
    s = replace(s, '  resolveProjectImport,\n', '  resolveProjectImportWithProject,\n')
    s = replace(s, 'const [lookupComplete,setLookupComplete]=useState(false);', 'const [lookupCompleted,setLookupComplete]=useState(false);')
    marker = '  const validAddress=useMemo('
    if s.count(marker) != 1: raise RuntimeError('UI validity anchor moved')
    s = s.replace(marker, '''  const [resolvedFor,setResolvedFor]=useState("");
  const [feedback,setFeedback]=useState<{title:string;message:string;retry:boolean}|null>(null);
  const contextKey=JSON.stringify([chainId,tokenAddress.trim(),connectedWallet]);
  const contextRef=useRef(contextKey);contextRef.current=contextKey;
  const current=()=>contextRef.current===contextKey;
  const lookupComplete=lookupCompleted&&resolvedFor===contextKey;
  const showError=(error:any)=>{if(!current())return;setFeedback(projectImportFeedback(error));if(error?.currentAuthority){setEvidence(null);setLookupComplete(false);}};
''' + marker)
    s = replace(s, '  const approvedOwner=Boolean(ownerVerified&&!conflictingVerified);\n  const wrongAuthorityWallet=!approvedOwner&&evidence?.automaticOwnershipAvailable===true&&Boolean(evidence.currentAuthority)&&!evidence.signedWalletMatchesAuthority;', '''  const wrongAuthorityWallet=lookupComplete&&evidence?.automaticOwnershipAvailable===true&&Boolean(evidence.currentAuthority)&&!sameWallet(evidence.currentAuthority,connectedWallet,chain==="solana");
  const approvedOwner=Boolean(lookupComplete&&connected&&ownerVerified&&!conflictingVerified&&!wrongAuthorityWallet);
  const suspended=item?.ownershipStatus==="ownership_suspended";''')
    s = replace(s, 'const manualReviewMine=Boolean(manualReviewPending&&sameWallet(item?.manualClaimWallet,connectedWallet,chain==="solana"));', 'const manualReviewMine=Boolean(lookupComplete&&!wrongAuthorityWallet&&!suspended&&manualReviewPending&&sameWallet(item?.manualClaimWallet,connectedWallet,chain==="solana"));')
    s = replace(s, 'const canRequestManual=lookupComplete&&Boolean(evidence)&&!wrongAuthorityWallet&&!approvedOwner&&!manualReviewPending&&manualReviewReason;', 'const canRequestManual=lookupComplete&&Boolean(evidence)&&!wrongAuthorityWallet&&!conflictingVerified&&!suspended&&!approvedOwner&&!manualReviewPending&&manualReviewReason;')
    s = replace(s, 'const canSelectImage=canProceedToImage||canRequestManual||manualReviewMine;', 'const canSelectImage=lookupComplete&&connected&&!wrongAuthorityWallet&&!conflictingVerified&&!suspended&&(canProceedToImage||canRequestManual||manualReviewMine);')
    s = replace(s, 'const reset=()=>{setItem(null);setEvidence(null);setLookupComplete(false);setImageFile(null);setImagePreview("");};', 'const reset=()=>{setItem(null);setEvidence(null);setLookupComplete(false);setResolvedFor("");setImageFile(null);setImagePreview("");setFeedback(null);};\n  useEffect(()=>{reset();},[chainId,connectedWallet]);\n  useEffect(()=>()=>{if(imagePreview)URL.revokeObjectURL(imagePreview);},[imagePreview]);')
    # Keep existing layout and wallet signing. Replace only the import actions.
    start=s.index('  const resolve=async()=>');end=s.index('\n  const securityRisks=',start)
    s=s[:start]+r'''  const resolve=async()=>{
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
  };''' +s[end:]
    # Error feedback is inline and remains until retry or input/wallet change.
    marker='    {lookupComplete?<section'
    s=replace(s,marker,'''    {feedback?<section role="alert" data-import-error="true" className="rounded-md border border-red-300/40 bg-red-400/10 p-4"><h2 className="font-retro text-sm text-red-100">{feedback.title}</h2><p className="mt-2 text-sm text-red-50">{feedback.message}</p>{feedback.retry?<Button type="button" variant="outline" className="mt-3" disabled={working||!validAddress||!connected} onClick={()=>void resolve()}>RETRY CHECK</Button>:null}</section>:null}
'''+marker)
    s=s.replace('variant={chain===', 'disabled={working} variant={chain===')
    s=replace(s,'<Input id="project-import-token" value=', '<Input id="project-import-token" disabled={working} value=')
    s=replace(s,'<input id="project-import-image" type="file"', '<input id="project-import-image" disabled={working} type="file"')
    s=replace(s,'if(!connectedWallet)throw new Error("Connect a wallet first.");', 'if(!connectedWallet||!current())throw new Error("Wallet changed. Connect the correct wallet and press IMPORT again.");')
    s=s.replace('catch(error:any){toast.error(String(error?.message||"Wallet connection failed."));}', 'catch(error:any){showError(error);}')
    for text in ['Connect the token owner wallet before continuing.','Complete the token checks before uploading an image.','Image is too large. Maximum size is 5 MB.','Use PNG, JPEG or WEBP.']:
        pass
    s=s.replace('toast.error("Image is too large. Maximum size is 5 MB.");','showError(new Error("Image is too large. Maximum size is 5 MB."));')
    s=s.replace('toast.error("Use PNG, JPEG or WEBP.");','showError(new Error("Use PNG, JPEG or WEBP."));')
    s=s.replace('{manualReviewMine&&item&&!item.imageUrl?', '{(manualReviewMine||approvedOwner)&&!wrongAuthorityWallet&&item&&!item.imageUrl?')
    s=s.replace('>ATTACH IMAGE TO REVIEW</Button>', '>{manualReviewMine?"ATTACH IMAGE TO REVIEW":"ATTACH REQUIRED IMAGE"}</Button>')
    # Some historical action rows use spaces around operators.
    s=s.replace('{manualReviewMine && item && !item.imageUrl ?', '{(manualReviewMine || approvedOwner) && !wrongAuthorityWallet && item && !item.imageUrl ?')
    return s
edit('frontend/src/pages/ProjectImport.tsx', page)

def ui_tests(s):
    s=s.replace('assert.match(api, /Connected wallet is not the current token owner\\. Connect the owner wallet to continue/);','assert.match(api, /Connect that wallet to continue/);')
    s=s.replace('Solana display metadata is optional on-chain metadata while ownership remains mintAuthority', 'Solana display metadata stays optional and separate from authenticated project-wallet evidence')
    s=s.replace('assert.match(resolverAdapters, /currentAuthority:\\s*raw\\.mintAuthority/);','assert.match(resolverAdapters, /resolveSolanaProjectAuthority/);')
    s=s.replace('assert.match(resolverAdapters, /signedWalletMatchesAuthority:\\s*Boolean\\(raw\\.verified\\)/);','assert.match(resolverAdapters, /signedWalletMatchesAuthority:\\s*Boolean\\(authority\\.currentAuthority/);')
    return s
edit('frontend/src/project-imports-ui.test.mjs',ui_tests)

add('frontend/src/lib/projectImportFeedback.test.mjs', r'''
import assert from 'node:assert/strict';
import test from 'node:test';
import { projectImportFeedback } from './projectImportFeedback.mjs';
test('server errors and failed fetch are unavailable checks, not ownership rejection',()=>{
  for(const error of [{status:503,message:'private DB error'},new TypeError('Failed to fetch')]){
    const result=projectImportFeedback(error);assert.equal(result.title,'IMPORT CHECK TEMPORARILY UNAVAILABLE');assert.equal(result.retry,true);assert.doesNotMatch(result.message,/private DB/);
  }
});
test('owner mismatch includes exactly the shortened real wallet',()=>{
  const result=projectImportFeedback({status:403,currentAuthority:'3cG2kAQ4NQfy4zN1g7pTYUUHSiCCMmECenBssYddBrS3'});
  assert.equal(result.title,'NOT TOKEN OWNER');assert.equal(result.message,'This token is controlled by wallet 3cG2...BrS3. Connect that wallet to continue.');
});
test('invalid address, disabled imports and signature cancellation remain distinct',()=>{
  assert.equal(projectImportFeedback({code:'SOLANA_MINT_INVALID'}).title,'CHECK CONTRACT ADDRESS AND CHAIN');
  assert.equal(projectImportFeedback({code:'PROJECT_IMPORTS_DISABLED',status:404}).title,'IMPORTS TEMPORARILY UNAVAILABLE');
  assert.equal(projectImportFeedback({code:4001}).title,'SIGNATURE CANCELLED');
});
''')
add('frontend/api/lib/projectSolanaProjectAuthority.test.mjs', r'''
import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey, Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PUMP_PROGRAM_ID, SOLANA_MAINNET_GENESIS, assertSolanaImportMainnet, decodePumpProjectCreator, pumpBondingCurveAddress, resolveSolanaProjectAuthority } from './projectSolanaProjectAuthority.js';
import { resolveSolanaProjectImport, setProjectImportReadClientsForTest } from './projectImportResolverAdapters.js';
// Public account snapshot: read-only Actions run 34390052080, slot 445680827.
const mint='7AVB9viRcpmr8gRMTCAYSmhP7gbuBMpBR51DMjwcpump';
const creator='3cG2kAQ4NQfy4zN1g7pTYUUHSiCCMmECenBssYddBrS3';
const curve='6Bizh2PkwgfZGhJPQYvwqAMRfE6JjgEZB6YhzQAr4jdH';
const raw='F7f4N2DYrGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAxqR+jQMAASa/slyxBtXEce/4qo5CEUssY14egVkuhvPYC0nkjcCgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
function account(){return {owner:PUMP_PROGRAM_ID,executable:false,data:Buffer.from(raw,'base64')};}
function connection(extra={}){return {
  async getGenesisHash(){return SOLANA_MAINNET_GENESIS;},
  async getParsedAccountInfo(){return {value:{owner:TOKEN_PROGRAM_ID,data:{parsed:{type:'mint',info:{mintAuthority:null,decimals:6,supply:'1000000000000000'}}}}};},
  async getAccountInfo(key){return key.toBase58()===curve?account():null;},...extra,
};}
test('canonical mint-derived Pump account identifies exact creator',()=>{assert.equal(pumpBondingCurveAddress(mint).toBase58(),curve);assert.equal(decodePumpProjectCreator(account()),creator);});
for(const match of [true,false])test(`revoked mintAuthority still resolves authenticated creator; signer match=${match}`,async()=>{
  setProjectImportReadClientsForTest({solana:connection()});try{
    const result=await resolveSolanaProjectImport({chainId:101,tokenAddress:mint,signedWallet:match?creator:Keypair.generate().publicKey.toBase58()});
    assert.equal(result.mintAuthority,null);assert.equal(result.currentAuthority,creator);assert.equal(result.authoritySource,'pump_bonding_curve_creator');assert.equal(result.authorityEvidenceAccount,curve);assert.equal(result.signedWalletMatchesAuthority,match);assert.equal(result.automaticOwnershipAvailable,true);
  }finally{setProjectImportReadClientsForTest();}
});
test('forged, malformed, executable, zero and non-signable creator records fail closed',()=>{
  const bad=[{...account(),owner:TOKEN_PROGRAM_ID},{...account(),executable:true},{...account(),data:Buffer.alloc(80)}];
  const discr=account();discr.data[0]^=1;bad.push(discr);
  const zero=account();zero.data.fill(0,49,81);bad.push(zero);
  const pda=account();pumpBondingCurveAddress(mint).toBuffer().copy(pda.data,49);bad.push(pda);
  for(const value of bad)assert.equal(decodePumpProjectCreator(value),null);
});
test('creator is read fresh, not hardcoded to the incident token',async()=>{
  const alternative=Keypair.generate().publicKey;const a=account();alternative.toBuffer().copy(a.data,49);
  const result=await resolveSolanaProjectAuthority({connection:connection({async getAccountInfo(){return a;}}),mint,mintAuthority:null});assert.equal(result.currentAuthority,alternative.toBase58());
});
test('conflicting signable authority remains manual',async()=>{const r=await resolveSolanaProjectAuthority({connection:connection(),mint,mintAuthority:Keypair.generate().publicKey.toBase58()});assert.equal(r.currentAuthority,null);assert.equal(r.ownershipReason,'conflicting_project_authorities');});
test('non-Pump mint authority and unavailable-authority fallbacks remain intact',async()=>{
  const rpc=connection({async getAccountInfo(){return null;}});const authority=Keypair.generate().publicKey.toBase58();
  assert.equal((await resolveSolanaProjectAuthority({connection:rpc,mint,mintAuthority:authority})).currentAuthority,authority);
  assert.equal((await resolveSolanaProjectAuthority({connection:rpc,mint,mintAuthority:null})).currentAuthority,null);
});
test('wrong RPC network and failed account lookup never become owner proof',async()=>{
  await assert.rejects(assertSolanaImportMainnet(connection({async getGenesisHash(){return 'devnet';}})),{code:'PROJECT_IMPORT_CHAIN_MISMATCH'});
  await assert.rejects(resolveSolanaProjectAuthority({connection:connection({async getAccountInfo(){throw Error('offline');}}),mint}),{code:'PROJECT_IMPORT_RPC_UNAVAILABLE'});
});
''')
add('frontend/api/lib/projectImportHttp.test.mjs', r'''
import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { buildWalletActionMessage } from './walletActionAuth.js';
import { projectImportIntent } from './projectImportSecurity.js';
import { registerProjectImportResolver } from './projectImportResolvers.js';
const mint='7AVB9viRcpmr8gRMTCAYSmhP7gbuBMpBR51DMjwcpump',owner='3cG2kAQ4NQfy4zN1g7pTYUUHSiCCMmECenBssYddBrS3';
let failDb=false,writes=0;const nonces=new Set();
globalThis.__memewarzone_pool={async query(sql,params){
  if(failDb)throw Object.assign(Error('Connection failed'),{code:'08006'});
  if(/update public.auth_nonces/i.test(sql)){if(!nonces.delete(params.join(':')))return {rows:[]};return {rows:[{expires_at:new Date(Date.now()+60000).toISOString()}]};}
  if(/insert into/i.test(sql))writes++;return {rows:[]};
}};
process.env.ENABLE_PROJECT_IMPORTS='true';
const {default:handler}=await import('../projectImports.js');
registerProjectImportResolver(101,async input=>({chainId:101,tokenAddress:input.tokenAddress,automaticOwnershipAvailable:true,currentAuthority:owner,signedWalletMatchesAuthority:input.signedWallet===owner,authoritySource:'pump_bonding_curve_creator'}));
const oldFetch=globalThis.fetch;globalThis.fetch=async()=>({ok:true,json:async()=>({code:1,result:{[mint]:{dex:[{}],holders:[]}}})});test.after(()=>{globalThis.fetch=oldFetch;});
function response(){return {statusCode:200,body:null,headersSent:false,headers:{},setHeader(k,v){this.headers[k]=v;},end(v){this.body=JSON.parse(v);this.headersSent=true;}};}
function signed(action,body){const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');const walletAddress=new PublicKey(publicKey.export({format:'der',type:'spki'}).subarray(-32)).toBase58();const nonce=crypto.randomUUID();nonces.add([101,walletAddress,nonce].join(':'));const intent=projectImportIntent({action,chainId:101,token:mint,body});const message=buildWalletActionMessage({action,chainId:101,walletAddress,nonce,extraLines:intent.extraLines});return {action,walletAddress,chainId:101,nonce,message,signature:crypto.sign(null,Buffer.from(message),privateKey).toString('base64'),walletType:'solana'};}
test('valid but unregistered lookup returns 200 with null project',async()=>{const res=response();await handler({method:'GET',url:`/project-imports?chainId=101&tokenAddress=${mint}`},res);assert.equal(res.statusCode,200);assert.deepEqual(res.body,{found:false,project:null});});
test('database failure is not disguised as an empty lookup',async()=>{failDb=true;try{const res=response();await handler({method:'GET',url:`/project-imports?chainId=101&tokenAddress=${mint}`},res);assert.ok(res.statusCode>=500);}finally{failDb=false;}});
for(const [path,action,intent] of [['/','project_import_create',{operation:'create'}],['/manual-claim','project_import_manual_claim',{note:null}]])test(`signed wrong-wallet request ${path} is blocked before any import insert`,async()=>{
  writes=0;const res=response();await handler({method:'POST',url:`/project-imports${path}`,body:{chainId:101,tokenAddress:mint,note:null,auth:signed(action,intent)}},res);
  assert.equal(res.statusCode,403,JSON.stringify(res.body));assert.equal(res.body.currentAuthority,owner);assert.match(res.body.error,/3cG2\.\.\.BrS3/);assert.equal(writes,0);
});
test('disabled service remains an actual error, not a null lookup',async()=>{process.env.ENABLE_PROJECT_IMPORTS='false';try{const res=response();await handler({method:'GET',url:`/project-imports?chainId=101&tokenAddress=${mint}`},res);assert.equal(res.statusCode,404);assert.equal(res.body.code,'PROJECT_IMPORTS_DISABLED');}finally{process.env.ENABLE_PROJECT_IMPORTS='true';}});
''')

add('frontend/playwright.imports.config.ts', r'''
import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'./e2e',testMatch:'project-import-feedback.browser.ts',workers:1,retries:0,timeout:20000,reporter:'list',use:{baseURL:'http://127.0.0.1:4181',browserName:'chromium',headless:true,screenshot:'only-on-failure',trace:'retain-on-failure'},webServer:{command:'npx vite --config e2e/import-harness/vite.config.mjs --host 127.0.0.1 --port 4181 --strictPort',url:'http://127.0.0.1:4181',reuseExistingServer:false,timeout:60000}});
''')
add('frontend/e2e/import-harness/vite.config.mjs', r'''
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
const local=name=>fileURLToPath(new URL(name,import.meta.url));
export default defineConfig({root:local('./'),resolve:{alias:[...['contexts/WalletContext','contexts/SolanaWalletContext','hooks/useActiveFeedWallet','lib/walletActionAuth','lib/solanaWallet','lib/apiBase','lib/chainConfig'].map(name=>({find:`@/${name}`,replacement:local('./mocks.tsx')})),{find:'@',replacement:local('../../src')}]},server:{fs:{allow:[local('../../')]}},esbuild:{jsx:'automatic'}});
''')
add('frontend/e2e/import-harness/index.html','<!doctype html><html><head><title>Import regression harness</title></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>\n')
add('frontend/e2e/import-harness/main.tsx',r'''
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ProjectImportPanel } from '@/pages/ProjectImport';
createRoot(document.getElementById('root')!).render(<BrowserRouter><ProjectImportPanel embedded /></BrowserRouter>);
''')
add('frontend/e2e/import-harness/mocks.tsx',r'''
import { useEffect,useState } from 'react';
function useAccount(){const [account,setAccount]=useState(new URLSearchParams(location.search).get('wallet')||'9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H');useEffect(()=>{const listener=(e:any)=>setAccount(e.detail);window.addEventListener('test-wallet-change',listener);return ()=>window.removeEventListener('test-wallet-change',listener);},[]);return account;}
export const BNB_CHAIN_ID=56,SOLANA_CHAIN_ID=101;
export function useWallet(){return {account:null,connecting:false,signer:null,connect:async()=>{}};}
export function useSolanaWallet(){return {solanaAccount:useAccount(),connectingSolana:false,connectSolana:async()=>{}};}
export function useActiveFeedWallet(){const account=useAccount();return {solanaAccount:account,evmAccount:null,isSolana:true,address:account};}
export async function signWalletAction(input:any){return {...input,extraLines:undefined,signer:undefined,signMessage:undefined,nonce:'browser-fixture',signature:'browser-fixture',message:'browser-fixture'};}
export async function signSolanaMessage(){return {signature:'browser-fixture'};}
export const apiFetch=(path:string,init?:RequestInit)=>fetch(path,init);
export function appendAuthToSearchParams(params:URLSearchParams,auth:Record<string,unknown>){for(const [key,value]of Object.entries(auth))if(value!=null)params.set(key,String(value));}
''')
add('frontend/e2e/project-import-feedback.browser.ts',r'''
import {test,expect,type Page} from '@playwright/test';
const mint='7AVB9viRcpmr8gRMTCAYSmhP7gbuBMpBR51DMjwcpump',owner='3cG2kAQ4NQfy4zN1g7pTYUUHSiCCMmECenBssYddBrS3',wrong='9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0N0AAAAASUVORK5CYII=','base64');
const resolved=(match:boolean)=>({chainId:101,tokenAddress:mint,currentAuthority:owner,automaticOwnershipAvailable:true,signedWalletMatchesAuthority:match,authoritySource:'pump_bonding_curve_creator',security:{status:'pass',criticalRisks:[],reviewRisks:[],provider:'fixture'}});
async function start(page:Page,wallet=wrong){await page.goto(`/?wallet=${wallet}`);await page.getByLabel('3. Contract Address').fill(mint);await page.getByRole('button',{name:'IMPORT',exact:true}).click();}
test('wrong wallet gets shortened creator warning, no image or manual bypass and no preliminary GET',async({page})=>{
  let lookups=0;page.on('request',r=>{if(r.method()==='GET'&&r.url().includes('/api/project-imports'))lookups++;});
  await page.route('**/api/project-imports/resolve',r=>r.fulfill({json:{resolved:resolved(false),project:null}}));await start(page);
  await expect(page.getByRole('heading',{name:'NOT TOKEN OWNER'})).toBeVisible();await expect(page.locator('[data-import-wrong-wallet-warning]')).toContainText('3cG2...BrS3');await expect(page.locator('#project-import-image')).toHaveCount(0);await expect(page.getByRole('button',{name:'REQUEST MANUAL CHECK'})).toHaveCount(0);expect(lookups).toBe(0);
});
test('503 stays visible after a toast would expire and grants no image permission',async({page})=>{
  await page.route('**/api/project-imports/resolve',r=>r.fulfill({status:503,json:{error:'Service unavailable'}}));await start(page);
  const error=page.locator('[data-import-error]');await expect(error).toContainText('IMPORT CHECK TEMPORARILY UNAVAILABLE');await page.waitForTimeout(5200);await expect(error).toBeVisible();await expect(page.getByRole('button',{name:'RETRY CHECK'})).toBeVisible();await expect(page.locator('#project-import-image')).toHaveCount(0);
});
test('manual image failure keeps saved review and retries image only',async({page})=>{
  const project={id:'fixture-project',chainId:101,tokenAddress:mint,ownershipStatus:'ownership_manual_review',manualClaimWallet:wrong,imageUrl:null};let requests=0,uploads=0;
  await page.route('**/api/project-imports/resolve',r=>r.fulfill({json:{resolved:{...resolved(false),currentAuthority:null,automaticOwnershipAvailable:false},project:null}}));
  await page.route('**/api/project-imports/manual-claim',r=>{requests++;return r.fulfill({json:{project}});});
  await page.route('**/api/project-imports/image?*',r=>{uploads++;return uploads===1?r.fulfill({status:503,json:{error:'Storage unavailable'}}):r.fulfill({json:{project:{...project,imageUrl:'https://example.test/project.png'}}});});
  await start(page);await page.locator('#project-import-image').setInputFiles({name:'logo.png',mimeType:'image/png',buffer:png});await page.getByRole('button',{name:'REQUEST MANUAL CHECK'}).click();
  await expect(page.locator('[data-import-error]')).toBeVisible();await page.getByRole('button',{name:'ATTACH IMAGE TO REVIEW'}).click();await expect.poll(()=>uploads).toBe(2);expect(requests).toBe(1);await expect(page.locator('[data-import-error]')).toHaveCount(0);
});
test('wallet swap revokes old creator image permission immediately',async({page})=>{
  await page.route('**/api/project-imports/resolve',r=>r.fulfill({json:{resolved:resolved(true),project:null}}));await start(page,owner);await expect(page.locator('#project-import-image')).toBeVisible();await page.evaluate(address=>window.dispatchEvent(new CustomEvent('test-wallet-change',{detail:address})),wrong);await expect(page.locator('#project-import-image')).toHaveCount(0);
});
''')
Path('/tmp/import-only-changed-files.txt').write_text('\n'.join(changed)+'\n')
print('\n'.join(changed))
