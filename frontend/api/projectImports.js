import { pool } from "../server/db.js";
import { getQuery, json, readJson } from "../server/http.js";
import { requireDashboardAdmin } from "./dashboard/_auth.js";
import { PROJECT_IMPORT_ACTIONS, requireProjectImportWalletAuth, sanitizeProjectImportMetadataPatch } from "./lib/projectImportSecurity.js";
import { assertResolverIdentity, claimExistingProject, createProjectImport, listRecentProjectImports, listUserProjectImports, lookupProjectImport, normalizeProjectIdentity, patchProjectMetadata, publicProject, requestManualProjectClaim } from "./lib/projectImportCore.js";
import { resolveProjectToken } from "./lib/projectImportResolvers.js";
import { registerDefaultProjectImportResolvers } from "./lib/projectImportResolverAdapters.js";

registerDefaultProjectImportResolvers();
function enabled(){return /^(1|true|yes|on)$/i.test(String(process.env.ENABLE_PROJECT_IMPORTS||"").trim());}
function routePath(req){return new URL(req.url,"http://localhost").pathname.replace(/^\/project-imports\/?/,"/");}
function errorStatus(code){if(["INVALID_CHAIN","INVALID_TOKEN","INVALID_WALLET","UNSUPPORTED_CHAIN","IMPORT_IDENTITY_INVALID","IMPORT_METADATA_INVALID","IMPORT_METADATA_FIELD_FORBIDDEN","NO_METADATA_FIELDS","SOLANA_MINT_INVALID","NO_DEPLOYED_BYTECODE","ERC20_READ_FAILED","ERC20_DECIMALS_INVALID","PROJECT_OWNERSHIP_REASON_REQUIRED","PROJECT_OWNERSHIP_EXPECTED_STATE_REQUIRED"].includes(code))return 400;if(["PROJECT_NOT_FOUND","IMPORT_NOT_FOUND"].includes(code))return 404;if(["OWNERSHIP_PROOF_REQUIRED","PROJECT_OWNER_REQUIRED","IMPORT_OWNER_NOT_VERIFIED","IMPORT_OWNER_MISMATCH"].includes(code))return 403;if(["OWNERSHIP_SUSPENDED","MANUAL_CLAIM_NOT_ALLOWED","RESOLVER_IDENTITY_MISMATCH","OWNERSHIP_CONFLICT","PROJECT_OWNERSHIP_STATE_CONFLICT"].includes(code))return 409;if(["PROJECT_IMPORT_RESOLVER_UNAVAILABLE","PROJECT_IMPORT_RPC_UNAVAILABLE"].includes(code))return 503;return 500;}
function projectError(res,error){const code=error?.code||"PROJECT_IMPORT_ERROR";return json(res,errorStatus(code),{error:String(error?.message||error),code,currentUpdatedAt:error?.currentUpdatedAt||undefined,currentOwnershipStatus:error?.currentOwnershipStatus||undefined});}
async function resolveForSigner(identity,signer){const result=await resolveProjectToken({chainId:identity.chainId,tokenAddress:identity.tokenAddress,signedWallet:signer});assertResolverIdentity(identity,result);return result;}
async function strictAuth(res,body,{identity,action,projectId=null,intentBody=null}){return requireProjectImportWalletAuth({res,pool,auth:body?.auth,expectedWallet:body?.auth?.walletAddress||body?.walletAddress||"",chainId:identity.chainId,token:identity.tokenAddress,action,projectId,body:intentBody,routeLabel:`project-imports/${action}`});}
function claimAdminItem(row){
  if(!row)return null;
  return{
    id:String(row.id),chainId:Number(row.chain_id),tokenAddress:String(row.token_address),name:row.name??null,symbol:row.symbol??null,imageUrl:row.image_url??null,
    importedByWallet:row.imported_by_wallet??null,claimantWallet:row.manual_claim_wallet??null,projectOwnerWallet:row.project_owner_wallet??null,
    ownershipStatus:String(row.ownership_status||"ownership_pending"),ownershipVerifiedAt:row.ownership_verified_at??null,manualClaimRequestedAt:row.manual_claim_requested_at??null,
    manualClaimNote:row.manual_claim_note??null,arenaStatus:row.status??null,arenaReviewRequestedAt:row.review_requested_at??null,
    scanJson:row.scan_json??null,createdAt:row.created_at??null,metadataUpdatedAt:row.metadata_updated_at??null,updatedAt:row.updated_at??null,
  };
}
function sameInstant(left,right){try{return new Date(left).toISOString()===new Date(right).toISOString();}catch{return false;}}
async function listProjectOwnershipClaims(){
  const r=await pool.query(`SELECT * FROM public.arena_token_imports WHERE ownership_status='ownership_manual_review' AND manual_claim_wallet IS NOT NULL AND manual_claim_requested_at IS NOT NULL ORDER BY manual_claim_requested_at ASC, created_at ASC`);
  return r.rows||[];
}
async function getProjectOwnershipClaim(id){const r=await pool.query(`SELECT * FROM public.arena_token_imports WHERE id=$1 LIMIT 1`,[id]);return r.rows?.[0]||null;}
async function getProjectOwnershipAudit(id){
  const r=await pool.query(`SELECT id,admin_user_id,action,target_type,target_id,before,after,created_at FROM public.wm_admin_audit_log WHERE target_type='project_ownership_claim' AND target_id=$1 ORDER BY created_at DESC LIMIT 100`,[id]);
  return r.rows||[];
}
async function reviewProjectOwnership({projectId,action,reason,expectedUpdatedAt,expectedClaimantWallet,admin}){
  const cleanReason=String(reason||"").trim().slice(0,1000);
  if(!cleanReason)throw Object.assign(new Error("Operator reason is required"),{code:"PROJECT_OWNERSHIP_REASON_REQUIRED"});
  if(!expectedUpdatedAt||!expectedClaimantWallet)throw Object.assign(new Error("Expected claim state is required"),{code:"PROJECT_OWNERSHIP_EXPECTED_STATE_REQUIRED"});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const found=await client.query(`SELECT * FROM public.arena_token_imports WHERE id=$1 FOR UPDATE`,[projectId]);
    const current=found.rows?.[0];
    if(!current)throw Object.assign(new Error("Imported project not found"),{code:"PROJECT_NOT_FOUND"});
    const currentClaimant=String(current.manual_claim_wallet||"").trim();
    if(current.ownership_status!=="ownership_manual_review"||!currentClaimant||!sameInstant(current.updated_at,expectedUpdatedAt)||currentClaimant!==String(expectedClaimantWallet||"").trim()){
      throw Object.assign(new Error("Project ownership claim changed before review"),{code:"PROJECT_OWNERSHIP_STATE_CONFLICT",currentUpdatedAt:current.updated_at,currentOwnershipStatus:current.ownership_status});
    }
    let updated;
    if(action==="verify_owner"){
      const r=await client.query(`UPDATE public.arena_token_imports SET project_owner_wallet=manual_claim_wallet,ownership_status='ownership_verified',ownership_verified_at=NOW(),manual_claim_wallet=NULL,manual_claim_requested_at=NULL,manual_claim_note=NULL,metadata_updated_at=NOW(),updated_at=NOW() WHERE id=$1 AND ownership_status='ownership_manual_review' AND updated_at=$2::timestamptz AND manual_claim_wallet=$3 RETURNING *`,[projectId,expectedUpdatedAt,currentClaimant]);
      updated=r.rows?.[0];
    }else if(action==="reject_claim"){
      const r=await client.query(`UPDATE public.arena_token_imports SET project_owner_wallet=NULL,ownership_status='ownership_pending',ownership_verified_at=NULL,manual_claim_wallet=NULL,manual_claim_requested_at=NULL,manual_claim_note=NULL,metadata_updated_at=NOW(),updated_at=NOW() WHERE id=$1 AND ownership_status='ownership_manual_review' AND updated_at=$2::timestamptz AND manual_claim_wallet=$3 RETURNING *`,[projectId,expectedUpdatedAt,currentClaimant]);
      updated=r.rows?.[0];
    }else{
      throw Object.assign(new Error("Unsupported project ownership action"),{code:"PROJECT_OWNERSHIP_ACTION_INVALID"});
    }
    if(!updated)throw Object.assign(new Error("Project ownership claim changed before review"),{code:"PROJECT_OWNERSHIP_STATE_CONFLICT"});
    const before=claimAdminItem(current),after=claimAdminItem(updated);
    await client.query(`INSERT INTO public.wm_admin_audit_log(admin_user_id,action,target_type,target_id,before,after) VALUES($1,$2,'project_ownership_claim',$3,$4::jsonb,$5::jsonb)`,[admin.id,action,projectId,JSON.stringify({...before,operatorReason:cleanReason,operatorEmail:admin.email||null}),JSON.stringify({...after,operatorReason:cleanReason,operatorEmail:admin.email||null})]);
    await client.query("COMMIT");
    return updated;
  }catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}
}
async function handleOwnershipAdmin(req,res,path){
  const admin=await requireDashboardAdmin(req,res);if(!admin)return true;
  if(req.method==="GET"&&path==="/admin/ownership-claims"){
    const rows=await listProjectOwnershipClaims();return json(res,200,{items:rows.map(claimAdminItem)});
  }
  const match=path.match(/^\/admin\/ownership-claims\/([0-9a-f-]+)$/i);
  if(req.method==="GET"&&match){const row=await getProjectOwnershipClaim(match[1]);if(!row)return json(res,404,{error:"Imported project not found",code:"PROJECT_NOT_FOUND"});const history=await getProjectOwnershipAudit(match[1]);return json(res,200,{item:claimAdminItem(row),history});}
  const actionMatch=path.match(/^\/admin\/ownership-claims\/([0-9a-f-]+)\/(verify|reject)$/i);
  if(req.method==="POST"&&actionMatch){const body=await readJson(req);const updated=await reviewProjectOwnership({projectId:actionMatch[1],action:actionMatch[2].toLowerCase()==="verify"?"verify_owner":"reject_claim",reason:body.reason,expectedUpdatedAt:body.expectedUpdatedAt,expectedClaimantWallet:body.claimantWallet,admin});return json(res,200,{item:claimAdminItem(updated)});}
  return false;
}

export default async function projectImports(req,res){
 if(!enabled())return json(res,404,{error:"Project imports are disabled.",code:"PROJECT_IMPORTS_DISABLED"});
 if(!pool)return json(res,503,{error:"Project imports require DATABASE_URL."});
 try{
  const path=routePath(req);
  if(path.startsWith("/admin/ownership-claims")){const handled=await handleOwnershipAdmin(req,res,path);if(handled!==false)return handled;return json(res,405,{error:"Method or ownership review operation not allowed"});}
  if(req.method==="GET"&&path==="/"){
   const q=getQuery(req);const tokenAddress=q.tokenAddress||q.token;
   if(q.wallet){const items=await listUserProjectImports(pool,{chainId:q.chainId,walletAddress:q.wallet});return json(res,200,{items:items.map(publicProject)});}
   if(tokenAddress){const project=await lookupProjectImport(pool,{chainId:q.chainId,tokenAddress});if(!project)return json(res,404,{error:"Imported project not found",code:"PROJECT_NOT_FOUND"});return json(res,200,{project:publicProject(project)});}
   const items=await listRecentProjectImports(pool,{limit:q.limit||24});return json(res,200,{items:items.map(publicProject)});
  }
  if(req.method==="POST"&&path==="/resolve"){
   const body=await readJson(req),identity=normalizeProjectIdentity(body.chainId,body.tokenAddress);const auth=await strictAuth(res,body,{identity,action:PROJECT_IMPORT_ACTIONS.resolve});if(!auth)return;const resolved=await resolveForSigner(identity,auth.walletAddress);return json(res,200,{resolved});
  }
  if(req.method==="POST"&&path==="/"){
   const body=await readJson(req),identity=normalizeProjectIdentity(body.chainId,body.tokenAddress);const intentBody={operation:"create"};const auth=await strictAuth(res,body,{identity,action:PROJECT_IMPORT_ACTIONS.create,intentBody});if(!auth)return;const resolved=await resolveForSigner(identity,auth.walletAddress);const result=await createProjectImport(pool,{resolverResult:resolved,signedWallet:auth.walletAddress});return json(res,result.created?201:200,{created:result.created,project:publicProject(result.project),ownershipEvidence:{automaticOwnershipAvailable:resolved.automaticOwnershipAvailable,signedWalletMatchesAuthority:resolved.signedWalletMatchesAuthority,currentAuthority:resolved.currentAuthority}});
  }
  if(req.method==="POST"&&path==="/claim"){
   const body=await readJson(req),identity=normalizeProjectIdentity(body.chainId,body.tokenAddress);const existing=await lookupProjectImport(pool,identity);if(!existing)throw Object.assign(new Error("Imported project not found"),{code:"PROJECT_NOT_FOUND"});const auth=await strictAuth(res,body,{identity,action:PROJECT_IMPORT_ACTIONS.claim,projectId:existing.id,intentBody:{operation:"claim"}});if(!auth)return;const resolved=await resolveForSigner(identity,auth.walletAddress);const project=await claimExistingProject(pool,{resolverResult:resolved,signedWallet:auth.walletAddress});return json(res,200,{project:publicProject(project)});
  }
  if(req.method==="POST"&&path==="/manual-claim"){
   const body=await readJson(req),identity=normalizeProjectIdentity(body.chainId,body.tokenAddress);const existing=await lookupProjectImport(pool,identity);if(!existing)throw Object.assign(new Error("Imported project not found"),{code:"PROJECT_NOT_FOUND"});const note=body.note==null?null:String(body.note).slice(0,1000);const auth=await strictAuth(res,body,{identity,action:PROJECT_IMPORT_ACTIONS.manualClaim,projectId:existing.id,intentBody:{note}});if(!auth)return;const resolved=await resolveForSigner(identity,auth.walletAddress);if(resolved.automaticOwnershipAvailable)throw Object.assign(new Error("Automatic ownership evidence is available; manual claim is not permitted"),{code:"MANUAL_CLAIM_NOT_ALLOWED"});const project=await requestManualProjectClaim(pool,{...identity,signedWallet:auth.walletAddress,note});return json(res,200,{project:publicProject(project)});
  }
  if(req.method==="PATCH"&&path==="/"){
   const body=await readJson(req),identity=normalizeProjectIdentity(body.chainId,body.tokenAddress);const existing=await lookupProjectImport(pool,identity);if(!existing)throw Object.assign(new Error("Imported project not found"),{code:"PROJECT_NOT_FOUND"});const metadata=sanitizeProjectImportMetadataPatch(body.metadata||body.patch||{});const auth=await strictAuth(res,body,{identity,action:PROJECT_IMPORT_ACTIONS.metadata,projectId:existing.id,intentBody:metadata});if(!auth)return;const project=await patchProjectMetadata(pool,{...identity,signedWallet:auth.walletAddress,patch:metadata});return json(res,200,{project:publicProject(project)});
  }
  return json(res,405,{error:"Method or project-import operation not allowed"});
 }catch(error){console.error("[api/projectImports]",error);return projectError(res,error);}
}
