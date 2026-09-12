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
let marketOverride=null,authoritySourceOverride='pump_bonding_curve_creator';
registerProjectImportResolver(101,async input=>({market:marketOverride,chainId:101,tokenAddress:input.tokenAddress,automaticOwnershipAvailable:true,currentAuthority:owner,signedWalletMatchesAuthority:input.signedWallet===owner,authoritySource:authoritySourceOverride}));
const oldFetch=globalThis.fetch;globalThis.fetch=async()=>({ok:true,json:async()=>({code:1,result:{[mint]:{dex:[{}],holders:[]}}})});test.after(()=>{globalThis.fetch=oldFetch;});
function response(){return {statusCode:200,body:null,headersSent:false,headers:{},setHeader(k,v){this.headers[k]=v;},end(v){this.body=JSON.parse(v);this.headersSent=true;}};}
function signed(action,body,token=mint){const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');const walletAddress=new PublicKey(publicKey.export({format:'der',type:'spki'}).subarray(-32)).toBase58();const nonce=crypto.randomUUID();nonces.add([101,walletAddress,nonce].join(':'));const intent=projectImportIntent({action,chainId:101,token,body});const message=buildWalletActionMessage({action,chainId:101,walletAddress,nonce,extraLines:intent.extraLines});return {action,walletAddress,chainId:101,nonce,message,signature:crypto.sign(null,Buffer.from(message),privateKey).toString('base64'),walletType:'solana'};}
test('valid but unregistered lookup returns 200 with null project',async()=>{const res=response();await handler({method:'GET',url:`/project-imports?chainId=101&tokenAddress=${mint}`},res);assert.equal(res.statusCode,200);assert.deepEqual(res.body,{found:false,project:null});});
test('database failure is not disguised as an empty lookup',async()=>{failDb=true;try{const res=response();await handler({method:'GET',url:`/project-imports?chainId=101&tokenAddress=${mint}`},res);assert.ok(res.statusCode>=500);}finally{failDb=false;}});
test('signed wrong-wallet automatic create is blocked before any import insert',async()=>{
  writes=0;const res=response();await handler({method:'POST',url:'/project-imports/',body:{chainId:101,tokenAddress:mint,auth:signed('project_import_create',{operation:'create'})}},res);
  assert.equal(res.statusCode,403,JSON.stringify(res.body));assert.equal(res.body.currentAuthority,owner);assert.match(res.body.error,/3cG2\.\.\.BrS3/);assert.equal(writes,0);
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
});