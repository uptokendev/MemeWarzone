import { createClient } from "@supabase/supabase-js";
import formidable from "formidable";
import fs from "fs";
import crypto from "node:crypto";
import { pool } from "../server/db.js";
import projectImportXClaim from "./projectImportXClaim.js";
import { inspectImageFile, PROJECT_IMPORT_IMAGE_LIMITS } from "./lib/imageFileValidation.js";
import { PROJECT_IMPORT_ACTIONS, requireProjectImportWalletAuth } from "./lib/projectImportSecurity.js";
import { bindRegistrationImage, lookupProjectImport, normalizeProjectIdentity, persistProjectImage, publicProject } from "./lib/projectImportCore.js";

let storageClient=null;
function storage(){if(storageClient)return storageClient;const url=String(process.env.SUPABASE_URL||"").trim(),key=String(process.env.SUPABASE_SERVICE_ROLE_KEY||"").trim();if(!url||!key)throw Object.assign(new Error("Project image storage is not configured"),{code:"PROJECT_IMPORT_STORAGE_UNAVAILABLE"});storageClient=createClient(url,key);return storageClient;}
function first(value){return Array.isArray(value)?String(value[0]??""):String(value??"");}
function authFrom(q,fields){return{action:first(fields.action)||String(q.action||""),walletAddress:first(fields.walletAddress)||first(fields.address)||String(q.walletAddress||q.address||""),chainId:Number(first(fields.chainId)||q.chainId),nonce:first(fields.nonce)||String(q.nonce||""),message:(first(fields.message)||String(q.message||"")).replace(/\r\n/g,"\n"),signature:first(fields.signature)||String(q.signature||""),walletType:first(fields.walletType)||String(q.walletType||"")};}
function fail(res,status,error,code){return res.status(status).json({error,code});}
export default async function projectImportImage(req,res){
 const originalPath=String(req.originalUrl||req.url||"").split("?")[0];
 // X claim is deliberately mounted under the already-isolated project-import
 // boundary so this release does not broaden the shared API router.
 if(originalPath.includes("/api/project-imports/image/x/"))return projectImportXClaim(req,res);
 if(req.method!=="POST")return fail(res,405,"Method not allowed","METHOD_NOT_ALLOWED");
 if(!/^(1|true|yes|on)$/i.test(String(process.env.ENABLE_PROJECT_IMPORTS||"").trim()))return fail(res,404,"Project imports are disabled","PROJECT_IMPORTS_DISABLED");
 if(!pool)return fail(res,503,"Project imports require DATABASE_URL","PROJECT_IMPORT_DB_UNAVAILABLE");
 const q=req.query||{};let identity;
 try{identity=normalizeProjectIdentity(Number(q.chainId),String(q.tokenAddress||q.token||""));}catch(error){return fail(res,400,String(error?.message||error),error?.code||"INVALID_IDENTITY");}
 const form=formidable({multiples:false,maxFileSize:PROJECT_IMPORT_IMAGE_LIMITS.maxBytes,maxTotalFileSize:PROJECT_IMPORT_IMAGE_LIMITS.maxBytes});
 let fields,files;
 try{[fields,files]=await form.parse(req);}catch(error){return fail(res,400,String(error?.message||"Invalid image upload"),"PROJECT_IMPORT_IMAGE_PARSE_FAILED");}
 const file=Array.isArray(files.file)?files.file[0]:files.file;if(!file)return fail(res,400,"Missing file (field name: file)","PROJECT_IMPORT_IMAGE_MISSING");
 let buf;try{buf=fs.readFileSync(file.filepath||file.path);}finally{try{fs.unlinkSync(file.filepath||file.path);}catch{}}
 let info;try{info=inspectImageFile(buf,{declaredMime:String(file.mimetype||""),...PROJECT_IMPORT_IMAGE_LIMITS});}catch(error){return fail(res,400,String(error?.message||error),"PROJECT_IMPORT_IMAGE_INVALID");}
 try{
  const existing=await lookupProjectImport(pool,identity);if(!existing)return fail(res,404,"Imported project not found","PROJECT_NOT_FOUND");
  const auth=authFrom(q,fields);const digest=crypto.createHash("sha256").update(buf).digest("hex");
  const registration=String(auth.action||"")===PROJECT_IMPORT_ACTIONS.registrationImage;
  const action=registration?PROJECT_IMPORT_ACTIONS.registrationImage:PROJECT_IMPORT_ACTIONS.image;
  const verified=await requireProjectImportWalletAuth({res,pool,auth,expectedWallet:auth.walletAddress,chainId:identity.chainId,token:identity.tokenAddress,action,projectId:existing.id,imageDigest:digest,routeLabel:registration?"project-imports/registration-image":"project-imports/image"});if(!verified)return;
  const client=storage(),bucket=process.env.SUPABASE_BUCKET||"memebattles",uuid=crypto.randomUUID(),name=`project-imports/${identity.chainId}/${identity.tokenAddress}/${uuid}.${info.ext}`;
  const {error:uploadError}=await client.storage.from(bucket).upload(name,buf,{contentType:info.mime,upsert:false,cacheControl:"3600"});if(uploadError)throw Object.assign(new Error(`Project image upload failed: ${uploadError.message}`),{code:"PROJECT_IMPORT_IMAGE_STORAGE_FAILED"});
  const {data}=client.storage.from(bucket).getPublicUrl(name);if(!data?.publicUrl)throw Object.assign(new Error("Project image public URL unavailable"),{code:"PROJECT_IMPORT_IMAGE_STORAGE_FAILED"});
  const project=registration
    ? await bindRegistrationImage(pool,{...identity,signedWallet:verified.walletAddress,imageUrl:data.publicUrl})
    : await persistProjectImage(pool,{...identity,signedWallet:verified.walletAddress,imageUrl:data.publicUrl});
  return res.status(200).json({project:publicProject(project),url:data.publicUrl});
 }catch(error){console.error("[api/projectImportImage]",error);const code=error?.code||"PROJECT_IMPORT_IMAGE_ERROR",status=["IMPORT_OWNER_NOT_VERIFIED","IMPORT_OWNER_MISMATCH","PROJECT_OWNER_REQUIRED","PROJECT_REGISTRAR_REQUIRED"].includes(code)?403:code==="PROJECT_NOT_FOUND"?404:code==="PROJECT_IMAGE_ALREADY_SET"?409:code==="PROJECT_IMPORT_STORAGE_UNAVAILABLE"?503:500;return fail(res,status,String(error?.message||error),code);}
}
