import { pool } from "../server/db.js";
import { json, readJson } from "../server/http.js";
import { lookupProjectImport, normalizeProjectIdentity } from "./lib/projectImportCore.js";
import { registerDefaultProjectImportResolvers } from "./lib/projectImportResolverAdapters.js";
import { resolveProjectToken } from "./lib/projectImportResolvers.js";
import { PROJECT_IMPORT_ACTIONS, requireProjectImportWalletAuth } from "./lib/projectImportSecurity.js";
import { finishProjectXClaim, projectXClaimRedirect, resolveOfficialProjectX, startProjectXClaim } from "./lib/projectImportXClaim.js";

const COOKIE_PATH="/api/project-imports/image/x";
const EVM_CHAINS=new Set([56,4663]);
registerDefaultProjectImportResolvers();
function enabled(){return /^(1|true|yes|on)$/i.test(String(process.env.ENABLE_PROJECT_IMPORTS||"").trim());}
function routePath(req){const raw=String(req.originalUrl||req.url||"");return new URL(raw,"http://localhost").pathname.replace(/^\/api\/project-imports\/image\/x\/?/,"/");}
function statusFor(code){if(["INVALID_CHAIN","INVALID_TOKEN","INVALID_WALLET","PROJECT_IMPORT_X_NOT_PUMP","PROJECT_IMPORT_X_NOT_FOUND","PROJECT_IMPORT_X_UNSUPPORTED_CHAIN"].includes(code))return 400;if(["PROJECT_NOT_FOUND","IMPORT_NOT_FOUND","PROJECT_IMPORT_CHAIN_DISABLED"].includes(code))return 404;if(["OWNERSHIP_SUSPENDED","OWNERSHIP_CONFLICT","PROJECT_IMPORT_X_ACCOUNT_MISMATCH","PROJECT_IMPORT_X_ACCOUNT_CHANGED","PROJECT_IMPORT_X_CONFLICT"].includes(code))return 409;if(["PROJECT_IMPORT_X_OAUTH_STATE_INVALID","PROJECT_IMPORT_X_OAUTH_STATE_EXPIRED","PROJECT_IMPORT_X_OAUTH_SESSION_MISSING"].includes(code))return 401;if(["PROJECT_IMPORT_X_METADATA_UNAVAILABLE","PROJECT_IMPORT_RPC_UNAVAILABLE","PROJECT_IMPORT_RESOLVER_UNAVAILABLE","PROJECT_IMPORT_CHAIN_MISMATCH"].includes(code))return 503;return 500;}
function fail(res,error){const code=String(error?.code||"PROJECT_IMPORT_X_ERROR");return json(res,statusFor(code),{error:String(error?.message||error),code,currentAuthority:error?.currentAuthority||undefined});}
function normalizeCookiePath(res){const raw=res.getHeader("Set-Cookie");if(!raw)return;const values=Array.isArray(raw)?raw:[String(raw)];res.setHeader("Set-Cookie",values.map((v)=>String(v).replace("Path=/api/project-imports/x",`Path=${COOKIE_PATH}`)));}
function clearCookie(res){res.setHeader("Set-Cookie",`mwz_x_claim=; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);}
function recoverNavigation(state){try{const encoded=String(state||"").split(".")[0];const p=JSON.parse(Buffer.from(encoded,"base64url").toString("utf8"));return{tokenAddress:String(p?.tokenAddress||""),chainId:Number(p?.chainId||101)};}catch{return{tokenAddress:"",chainId:101};}}
async function requireStartAuth(res,body,identity,project){return requireProjectImportWalletAuth({res,pool,auth:body?.auth,expectedWallet:body?.auth?.walletAddress||"",chainId:identity.chainId,token:identity.tokenAddress,action:PROJECT_IMPORT_ACTIONS.claim,projectId:project.id,body:{operation:"claim"},routeLabel:"project-imports/x/start"});}

export default async function projectImportXClaim(req,res){
 if(!enabled())return json(res,404,{error:"Project imports are disabled.",code:"PROJECT_IMPORTS_DISABLED"});if(!pool)return json(res,503,{error:"Project imports require DATABASE_URL."});const path=routePath(req);
 try{
  if(req.method==="POST"&&path==="/authority"){
   const body=await readJson(req),identity=normalizeProjectIdentity(body.chainId,body.tokenAddress);
   if(!EVM_CHAINS.has(identity.chainId))throw Object.assign(new Error("Owner-wallet verification is available on BNB and Robinhood only"),{code:"INVALID_CHAIN"});
   const project=await lookupProjectImport(pool,identity);if(!project)throw Object.assign(new Error("Imported project not found"),{code:"PROJECT_NOT_FOUND"});
   const walletAddress=String(body.walletAddress||"0x0000000000000000000000000000000000000000").trim();
   const resolved=await resolveProjectToken({chainId:identity.chainId,tokenAddress:identity.tokenAddress,signedWallet:walletAddress});
   return json(res,200,{available:Boolean(resolved.automaticOwnershipAvailable),currentAuthority:resolved.currentAuthority||null,matchesConnected:Boolean(resolved.signedWalletMatchesAuthority),authoritySource:resolved.authoritySource||null});
  }
  if(req.method==="POST"&&path==="/resolve"){
   const body=await readJson(req),identity=normalizeProjectIdentity(body.chainId,body.tokenAddress);const project=await lookupProjectImport(pool,identity);if(!project)throw Object.assign(new Error("Imported project not found"),{code:"PROJECT_NOT_FOUND"});const expected=await resolveOfficialProjectX(identity.chainId,identity.tokenAddress);return json(res,200,{available:true,username:expected.username,xUrl:expected.xUrl,source:expected.source});
  }
  if(req.method==="POST"&&path==="/start"){
   const body=await readJson(req),identity=normalizeProjectIdentity(body.chainId,body.tokenAddress);const project=await lookupProjectImport(pool,identity);if(!project)throw Object.assign(new Error("Imported project not found"),{code:"PROJECT_NOT_FOUND"});const auth=await requireStartAuth(res,body,identity,project);if(!auth)return;const started=await startProjectXClaim({req,res,project,walletAddress:auth.walletAddress});normalizeCookiePath(res);return json(res,200,started);
  }
  if(req.method==="GET"&&path==="/callback"){const url=new URL(String(req.originalUrl||req.url||""),"http://localhost"),state=String(url.searchParams.get("state")||""),code=String(url.searchParams.get("code")||""),denied=String(url.searchParams.get("error")||"");let{tokenAddress,chainId}=recoverNavigation(state);try{if(denied||!state||!code)throw Object.assign(new Error("X authorization was cancelled"),{code:"PROJECT_IMPORT_X_OAUTH_CANCELLED"});const result=await finishProjectXClaim({req,res,pool,state,code});clearCookie(res);tokenAddress=String(result.project.token_address||tokenAddress);chainId=Number(result.project.chain_id||chainId);return res.redirect(302,projectXClaimRedirect({ok:true,tokenAddress,chainId}));}catch(error){clearCookie(res);console.error("[api/projectImportXClaim callback]",error);return res.redirect(302,projectXClaimRedirect({ok:false,tokenAddress,chainId,errorCode:error?.code||"PROJECT_IMPORT_X_ERROR"}));}}
  return json(res,405,{error:"Method or X claim operation not allowed"});
 }catch(error){console.error("[api/projectImportXClaim]",error);return fail(res,error);}
}
