import { pool } from "../server/db.js";
import { getQuery, json, readJson } from "../server/http.js";
import { PROJECT_IMPORT_ACTIONS, requireProjectImportWalletAuth, sanitizeProjectImportMetadataPatch } from "./lib/projectImportSecurity.js";
import { assertResolverIdentity, claimExistingProject, createProjectImport, listUserProjectImports, lookupProjectImport, normalizeProjectIdentity, patchProjectMetadata, publicProject, requestManualProjectClaim } from "./lib/projectImportCore.js";
import { resolveProjectToken } from "./lib/projectImportResolvers.js";
import { registerDefaultProjectImportResolvers } from "./lib/projectImportResolverAdapters.js";

registerDefaultProjectImportResolvers();
function enabled(){return /^(1|true|yes|on)$/i.test(String(process.env.ENABLE_PROJECT_IMPORTS||"").trim());}
function routePath(req){return new URL(req.url,"http://localhost").pathname.replace(/^\/project-imports\/?/,"/");}
function errorStatus(code){if(["INVALID_CHAIN","INVALID_TOKEN","INVALID_WALLET","UNSUPPORTED_CHAIN","IMPORT_IDENTITY_INVALID","IMPORT_METADATA_INVALID","IMPORT_METADATA_FIELD_FORBIDDEN","NO_METADATA_FIELDS","SOLANA_MINT_INVALID","NO_DEPLOYED_BYTECODE","ERC20_READ_FAILED","ERC20_DECIMALS_INVALID"].includes(code))return 400;if(["PROJECT_NOT_FOUND","IMPORT_NOT_FOUND"].includes(code))return 404;if(["OWNERSHIP_PROOF_REQUIRED","PROJECT_OWNER_REQUIRED","IMPORT_OWNER_NOT_VERIFIED","IMPORT_OWNER_MISMATCH"].includes(code))return 403;if(["OWNERSHIP_SUSPENDED","MANUAL_CLAIM_NOT_ALLOWED","RESOLVER_IDENTITY_MISMATCH","OWNERSHIP_CONFLICT"].includes(code))return 409;if(["PROJECT_IMPORT_RESOLVER_UNAVAILABLE","PROJECT_IMPORT_RPC_UNAVAILABLE"].includes(code))return 503;return 500;}
function projectError(res,error){const code=error?.code||"PROJECT_IMPORT_ERROR";return json(res,errorStatus(code),{error:String(error?.message||error),code});}
async function resolveForSigner(identity,signer){const result=await resolveProjectToken({chainId:identity.chainId,tokenAddress:identity.tokenAddress,signedWallet:signer});assertResolverIdentity(identity,result);return result;}
async function strictAuth(res,body,{identity,action,projectId=null,intentBody=null}){return requireProjectImportWalletAuth({res,pool,auth:body?.auth,expectedWallet:body?.auth?.walletAddress||body?.walletAddress||"",chainId:identity.chainId,token:identity.tokenAddress,action,projectId,body:intentBody,routeLabel:`project-imports/${action}`});}

export default async function projectImports(req,res){
 if(!enabled())return json(res,404,{error:"Project imports are disabled.",code:"PROJECT_IMPORTS_DISABLED"});
 if(!pool)return json(res,503,{error:"Project imports require DATABASE_URL."});
 try{
  const path=routePath(req);
  if(req.method==="GET"&&path==="/"){
   const q=getQuery(req);const tokenAddress=q.tokenAddress||q.token;
   if(q.wallet){const items=await listUserProjectImports(pool,{chainId:q.chainId,walletAddress:q.wallet});return json(res,200,{items:items.map(publicProject)});}
   const project=await lookupProjectImport(pool,{chainId:q.chainId,tokenAddress});if(!project)return json(res,404,{error:"Imported project not found",code:"PROJECT_NOT_FOUND"});return json(res,200,{project:publicProject(project)});
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
