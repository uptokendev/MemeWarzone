import { pool } from "../server/db.js";
import { json, readJson } from "../server/http.js";
import { lookupProjectImport, normalizeProjectIdentity } from "./lib/projectImportCore.js";
import { PROJECT_IMPORT_ACTIONS, requireProjectImportWalletAuth } from "./lib/projectImportSecurity.js";
import { finishProjectXClaim, projectXClaimRedirect, resolvePumpOfficialX, startProjectXClaim } from "./lib/projectImportXClaim.js";

function enabled() { return /^(1|true|yes|on)$/i.test(String(process.env.ENABLE_PROJECT_IMPORTS || "").trim()); }
function routePath(req) {
  const raw = String(req.originalUrl || req.url || "");
  return new URL(raw, "http://localhost").pathname.replace(/^\/api\/project-imports\/image\/x\/?/, "/");
}
function statusFor(code) {
  if (["INVALID_CHAIN","INVALID_TOKEN","PROJECT_IMPORT_X_NOT_PUMP","PROJECT_IMPORT_X_NOT_FOUND"].includes(code)) return 400;
  if (["PROJECT_NOT_FOUND","IMPORT_NOT_FOUND"].includes(code)) return 404;
  if (["OWNERSHIP_SUSPENDED","OWNERSHIP_CONFLICT","PROJECT_IMPORT_X_ACCOUNT_MISMATCH","PROJECT_IMPORT_X_ACCOUNT_CHANGED"].includes(code)) return 409;
  if (["PROJECT_IMPORT_X_OAUTH_STATE_INVALID","PROJECT_IMPORT_X_OAUTH_STATE_EXPIRED","PROJECT_IMPORT_X_OAUTH_SESSION_MISSING"].includes(code)) return 401;
  if (["PROJECT_IMPORT_X_METADATA_UNAVAILABLE","PROJECT_IMPORT_RPC_UNAVAILABLE"].includes(code)) return 503;
  return 500;
}
function fail(res,error){const code=String(error?.code||"PROJECT_IMPORT_X_ERROR");return json(res,statusFor(code),{error:String(error?.message||error),code});}
async function requireStartAuth(res,body,identity,project){
  return requireProjectImportWalletAuth({res,pool,auth:body?.auth,expectedWallet:body?.auth?.walletAddress||"",chainId:identity.chainId,token:identity.tokenAddress,action:PROJECT_IMPORT_ACTIONS.claim,projectId:project.id,body:{operation:"claim"},routeLabel:"project-imports/x/start"});
}

export default async function projectImportXClaim(req,res){
  if(!enabled())return json(res,404,{error:"Project imports are disabled.",code:"PROJECT_IMPORTS_DISABLED"});
  if(!pool)return json(res,503,{error:"Project imports require DATABASE_URL."});
  const path=routePath(req);
  try{
    if(req.method==="POST"&&path==="/resolve"){
      const body=await readJson(req),identity=normalizeProjectIdentity(body.chainId,body.tokenAddress);
      if(identity.chainId!==101)throw Object.assign(new Error("X verification is currently available for Pump.fun Solana projects only"),{code:"INVALID_CHAIN"});
      const project=await lookupProjectImport(pool,identity);if(!project)throw Object.assign(new Error("Imported project not found"),{code:"PROJECT_NOT_FOUND"});
      const expected=await resolvePumpOfficialX(identity.tokenAddress);
      return json(res,200,{available:true,username:expected.username,xUrl:expected.xUrl,source:expected.source});
    }
    if(req.method==="POST"&&path==="/start"){
      const body=await readJson(req),identity=normalizeProjectIdentity(body.chainId,body.tokenAddress);
      if(identity.chainId!==101)throw Object.assign(new Error("X verification is currently available for Pump.fun Solana projects only"),{code:"INVALID_CHAIN"});
      const project=await lookupProjectImport(pool,identity);if(!project)throw Object.assign(new Error("Imported project not found"),{code:"PROJECT_NOT_FOUND"});
      const auth=await requireStartAuth(res,body,identity,project);if(!auth)return;
      return json(res,200,await startProjectXClaim({req,res,project,walletAddress:auth.walletAddress}));
    }
    if(req.method==="GET"&&path==="/callback"){
      const url=new URL(String(req.originalUrl||req.url||""),"http://localhost"),state=String(url.searchParams.get("state")||""),code=String(url.searchParams.get("code")||""),denied=String(url.searchParams.get("error")||"");
      let tokenAddress="",chainId=101;
      try{
        if(denied||!state||!code)throw Object.assign(new Error("X authorization was cancelled"),{code:"PROJECT_IMPORT_X_OAUTH_CANCELLED"});
        const result=await finishProjectXClaim({req,res,pool,state,code});tokenAddress=String(result.project.token_address||"");chainId=Number(result.project.chain_id||101);
        return res.redirect(302,projectXClaimRedirect({ok:true,tokenAddress,chainId}));
      }catch(error){console.error("[api/projectImportXClaim callback]",error);return res.redirect(302,projectXClaimRedirect({ok:false,tokenAddress,chainId,errorCode:error?.code||"PROJECT_IMPORT_X_ERROR"}));}
    }
    return json(res,405,{error:"Method or X claim operation not allowed"});
  }catch(error){console.error("[api/projectImportXClaim]",error);return fail(res,error);}
}
