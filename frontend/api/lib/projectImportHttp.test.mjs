import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { buildWalletActionMessage } from './walletActionAuth.js';
import { projectImportIntent } from './projectImportSecurity.js';
import { registerProjectImportResolver } from './projectImportResolvers.js';
const mint='7AVB9viRcpmr8gRMTCAYSmhP7gbuBMpBR51DMjwcpump',owner='3cG2kAQ4NQfy4zN1g7pTYUUHSiCCMmECenBssYddBrS3';
let failDb=false,writes=0,lastImportInsert=null;const nonces=new Set();
async function query(sql,params=[]){
  if(failDb)throw Object.assign(Error('Connection failed'),{code:'08006'});
  if(/update public.auth_nonces/i.test(sql)){if(!nonces.delete(params.join(':')))return {rows:[]};return {rows:[{expires_at:new Date(Date.now()+60000).toISOString()}]};}
  if(/insert into/i.test(sql))writes++;
  if(/insert into public\.arena_token_imports/i.test(sql))lastImportInsert=params;
  if(existingRow&&/from public\.arena_token_imports/i.test(sql)&&!/for update/i.test(sql))return {rows:[existingRow]};
  return {rows:[]};
}
globalThis.__memewarzone_pool={query,async connect(){return {query,release(){}};}};
process.env.ENABLE_PROJECT_IMPORTS='true';
const {default:handler}=await import('../projectImports.js');
let marketOverride=null,authoritySourceOverride='pump_bonding_curve_creator',graduationOverride={proven:true,method:'pump_curve_complete'},existingRow=null;
registerProjectImportResolver(101,async input=>({market:marketOverride,chainId:101,tokenAddress:input.tokenAddress,automaticOwnershipAvailable:true,currentAuthority:owner,signedWalletMatchesAuthority:input.signedWallet===owner,authoritySource:authoritySourceOverride,graduationProof:graduationOverride}));
const oldFetch=globalThis.fetch;globalThis.fetch=async()=>({ok:true,json:async()=>({code:1,result:{[mint]:{dex:[{}],holders:[]}}})});test.after(()=>{globalThis.fetch=oldFetch;});
function response(){return {statusCode:200,body:null,headersSent:false,headers:{},setHeader(k,v){this.headers[k]=v;},end(v){this.body=JSON.parse(v);this.headersSent=true;}};}
function signed(action,body,token=mint){const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');const walletAddress=new PublicKey(publicKey.export({format:'der',type:'spki'}).subarray(-32)).toBase58();const nonce=crypto.randomUUID();nonces.add([101,walletAddress,nonce].join(':'));const intent=projectImportIntent({action,chainId:101,token,body});const message=buildWalletActionMessage({action,chainId:101,walletAddress,nonce,extraLines:intent.extraLines});return {action,walletAddress,chainId:101,nonce,message,signature:crypto.sign(null,Buffer.from(message),privateKey).toString('base64'),walletType:'solana'};}
test('valid but unregistered lookup returns 200 with null project',async()=>{const res=response();await handler({method:'GET',url:`/project-imports?chainId=101&tokenAddress=${mint}`},res);assert.equal(res.statusCode,200);assert.deepEqual(res.body,{found:false,project:null});});
test('database failure is not disguised as an empty lookup',async()=>{failDb=true;try{const res=response();await handler({method:'GET',url:`/project-imports?chainId=101&tokenAddress=${mint}`},res);assert.ok(res.statusCode>=500);}finally{failDb=false;}});
test('Pump.fun wrong-wallet create registers the project without granting ownership',async()=>{
  writes=0;const res=response();await handler({method:'POST',url:'/project-imports/',body:{chainId:101,tokenAddress:mint,auth:signed('project_import_create',{operation:'create'})}},res);
  assert.equal(res.statusCode,200,JSON.stringify(res.body));
  // This unit stub intentionally returns no INSERT row, so the handler reports created:false;
  // the important boundary is that registration is attempted once while ownership stays unresolved.
  assert.equal(res.body.created,false);
  assert.equal(res.body.project,null);
  assert.equal(res.body.ownershipEvidence.currentAuthority,owner);
  assert.equal(res.body.ownershipEvidence.signedWalletMatchesAuthority,false);
  assert.equal(res.body.ownershipEvidence.assessment.manualRequestAllowed,true);
  assert.equal(res.body.ownershipEvidence.assessment.automaticImportAllowed,false);
  assert.equal(res.body.ownershipEvidence.assessment.permissions.trading,'locked');
  assert.equal(res.body.ownershipEvidence.assessment.permissions.battle,'locked');
  assert.equal(writes,1);
});
test('known non-Pump wrong wallet cannot use manual-review fallback',async()=>{
  authoritySourceOverride='mint_authority';writes=0;
  const otherMint='So11111111111111111111111111111111111111112';
  try{const res=response();await handler({method:'POST',url:'/project-imports/manual-claim',body:{chainId:101,tokenAddress:otherMint,note:null,auth:signed('project_import_manual_claim',{note:null},otherMint)}},res);assert.equal(res.statusCode,403,JSON.stringify(res.body));assert.equal(res.body.currentAuthority,owner);assert.equal(writes,0);}finally{authoritySourceOverride='pump_bonding_curve_creator';}
});
test('disabled service remains an actual error, not a null lookup',async()=>{process.env.ENABLE_PROJECT_IMPORTS='false';try{const res=response();await handler({method:'GET',url:`/project-imports?chainId=101&tokenAddress=${mint}`},res);assert.equal(res.statusCode,404);assert.equal(res.body.code,'PROJECT_IMPORTS_DISABLED');}finally{process.env.ENABLE_PROJECT_IMPORTS='true';}});
for(const [path,action,intent] of [['/','project_import_create',{operation:'create'}],['/manual-claim','project_import_manual_claim',{note:null}]])test(`server-known bonding blocks forged client graduation at ${path}`,async()=>{
 marketOverride={phase:'bonding',verified:true};writes=0;
 try{const res=response();await handler({method:'POST',url:`/project-imports${path}`,body:{chainId:101,tokenAddress:mint,note:null,market:{phase:'postgrad',verified:true},auth:signed(action,intent)}},res);assert.equal(res.statusCode,409);assert.equal(res.body.code,'PROJECT_IMPORT_STILL_BONDING');assert.equal(writes,0);}finally{marketOverride=null;}
});test('manual review needs a proven X sign-in from the claiming wallet; a typed note is not enough',async()=>{
  writes=0;
  const note='Contact X: https://x.com/anyone';
  const res=response();await handler({method:'POST',url:'/project-imports/manual-claim',body:{chainId:101,tokenAddress:mint,note,auth:signed('project_import_manual_claim',{note})}},res);
  assert.equal(res.statusCode,409,JSON.stringify(res.body));assert.equal(res.body.code,'PROJECT_IMPORT_X_CONTACT_REQUIRED');assert.equal(writes,0);
});

test('import needs no signature: the connected wallet is recorded, ownership is not granted even when it is the creator',async()=>{
  writes=0;const res=response();await handler({method:'POST',url:'/project-imports/',body:{chainId:101,tokenAddress:mint,walletAddress:owner}},res);
  assert.equal(res.statusCode,200,JSON.stringify(res.body));
  assert.equal(writes,1);
  // INSERT params: chain, token, imported_by_wallet, project_owner_wallet, ..., ownership_status
  assert.equal(lastImportInsert[2],owner,'the connected wallet is recorded as importer');
  assert.equal(lastImportInsert[3],null,'an unsigned wallet never becomes the project owner');
  assert.equal(lastImportInsert[8],'ownership_pending');
  assert.equal(res.body.ownershipEvidence.assessment.proof,null);
});
test('import without a valid connected wallet is refused before anything is written',async()=>{
  for (const walletAddress of [undefined,'','0xnot-a-solana-wallet']) {
    writes=0;const res=response();await handler({method:'POST',url:'/project-imports/',body:{chainId:101,tokenAddress:mint,walletAddress}},res);
    assert.equal(res.statusCode,400,JSON.stringify(res.body));assert.equal(res.body.code,'INVALID_WALLET');assert.equal(writes,0);
  }
});
test('HARD RULE: a new import without proven graduation is refused before anything is written',async()=>{
  for (const proof of [null,{proven:false,reason:'no_verified_dex_pool'},{proven:false,reason:'pump_curve_bonding'}]) {
    graduationOverride=proof;writes=0;
    try{const res=response();await handler({method:'POST',url:'/project-imports/',body:{chainId:101,tokenAddress:mint,auth:signed('project_import_create',{operation:'create'})}},res);
      assert.equal(res.statusCode,409,JSON.stringify(res.body));assert.equal(res.body.code,'PROJECT_IMPORT_GRADUATION_UNPROVEN');assert.equal(writes,0);}
    finally{graduationOverride={proven:true,method:'pump_curve_complete'};}
  }
});
test('HARD RULE: a retryable market lookup failure asks for a retry instead of refusing',async()=>{
  graduationOverride={proven:false,reason:'pool_lookup_unavailable',retryable:true};writes=0;
  try{const res=response();await handler({method:'POST',url:'/project-imports/',body:{chainId:101,tokenAddress:mint,auth:signed('project_import_create',{operation:'create'})}},res);
    assert.equal(res.statusCode,503);assert.equal(writes,0);}
  finally{graduationOverride={proven:true,method:'pump_curve_complete'};}
});
test('HARD RULE: projects that already exist are not affected by the graduation gate',async()=>{
  graduationOverride={proven:false,reason:'no_verified_dex_pool'};existingRow={id:'7d1c4a6e-0000-4000-8000-000000000009',chain_id:101,token_address:mint,ownership_status:'ownership_pending'};
  try{const res=response();await handler({method:'POST',url:'/project-imports/',body:{chainId:101,tokenAddress:mint,auth:signed('project_import_create',{operation:'create'},mint)}},res);
    assert.notEqual(res.body?.code,'PROJECT_IMPORT_GRADUATION_UNPROVEN',JSON.stringify(res.body));}
  finally{graduationOverride={proven:true,method:'pump_curve_complete'};existingRow=null;}
});
