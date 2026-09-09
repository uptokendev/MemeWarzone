import test from 'node:test';
import assert from 'node:assert/strict';
import {BNB_IMPORT_MARKETS as C,BNB_MARKET_ABI as I,readBnbImportMarket} from './projectImportBnbMarket.js';
import {assessProjectImport,assertReviewApproval,assertNewImportMarket} from './projectImportAssessment.js';
import {classifyProjectImportSecurity} from './projectImportRiskSecurity.js';
import {registerProjectImportResolver,resolveProjectToken,unregisterProjectImportResolver} from './projectImportResolvers.js';

const token='0x1111111111111111111111111111111111111111';
const pair='0x2222222222222222222222222222222222222222';
const wallet='0x3333333333333333333333333333333333333333';
const zero='0x0000000000000000000000000000000000000000';
const now=Date.UTC(2026,8,10);
const block={number:'0x61',hash:'0x'+'ab'.repeat(32),timestamp:'0x'+BigInt(now/1000).toString(16)};
function fixture(o={}) {
  const calls=[];let blockReads=0;
  return {calls,async send(method,params){
    calls.push({method,params});
    if(o.timeout)return new Promise(()=>{});
    if(method==='eth_chainId')return o.chain||'0x38';
    if(method==='eth_blockNumber')return '0x64';
    if(method==='eth_getBlockByNumber')return {...block,...(o.stale?{timestamp:'0x1'}:{}),...(o.reorg&&++blockReads>1?{hash:'0x'+'cd'.repeat(32)}:{})};
    if(method==='eth_getCode')return o.noCode?.includes(params[0])?'0x':'0x60016000';
    assert.equal(method,'eth_call');assert.equal(params[1],block.number);
    const {name,args}=I.parseTransaction(params[0]);const to=params[0].to.toLowerCase();let v;
    if(name==='getTokenInfo'){
      if(o.registryError)throw Error('provider failed');
      const ver=o.four?(o.version??2):0;
      v=[ver,ver?(o.manager||C.managers[2]):zero,o.quote||zero,1,1,1,1,1,10,1,10,o.four?(o.graduated??false):false];
    } else if(name==='getPair'||name==='getPool') {
      const allowed=(o.venue||'v2')===(name==='getPair'?'v2':'v3');
      v=[!o.noPool&&allowed&&args[1].toLowerCase()===(o.quote||C.wrappedNative)&& (name==='getPair'||Number(args[2])===500)?pair:zero];
    } else if(name==='token0')v=[o.wrongMint?wallet:token];
    else if(name==='token1')v=[o.quote||C.wrappedNative];
    else if(name==='factory')v=[o.wrongFactory?wallet:(o.venue==='v3'?C.v3Factory:C.v2Factory)];
    else if(name==='getReserves')v=[1000n,2000n,100];
    else if(name==='balanceOf')v=[o.empty?0n:o.unbacked?1n:to===token?1000n:2000n];
    else if(name==='totalSupply')v=[1000n];
    else if(name==='liquidity')v=[o.inactive?0n:1000n];
    else if(name==='fee')v=[o.wrongFee?10000:500];
    else if(name==='slot0')v=[o.uninitialized?0n:1n<<96n,0,1,1,1,0,!o.locked];
    else throw Error(`Unexpected ${name}`);
    return I.encodeFunctionResult(name,v);
  }};
}
const read=async(o={})=>{const provider=fixture(o);const result=await readBnbImportMarket({provider,tokenAddress:token,now:()=>now});return {result,provider};};
const safe={status:'pass',criticalRisks:[],reviewRisks:[]};
function assessment(result){return assessProjectImport({resolved:{...result,chainId:56,tokenAddress:token,currentAuthority:wallet,automaticOwnershipAvailable:true,signedWalletMatchesAuthority:true},claimantWallet:wallet,security:safe,proof:{signedWallet:wallet,verifiedBy:'server_wallet_action'},checkedAt:new Date(now).toISOString()});}
const approve=(s,reviewProof)=>assertReviewApproval(s,{project:{chain_id:56,token_address:token,manual_claim_wallet:wallet},evidenceId:'one',expectedEvidenceId:'one',now,reviewProof});

test('Four bonding is authoritative even when a funded Pancake pool exists',async()=>{
 const {result,provider}=await read({four:true});assert.equal(result.market.phase,'bonding');assert.equal(result.market.verified,true);
 assert.ok(!provider.calls.some(x=>x.method==='eth_call'&&['getPair','getPool'].includes(I.parseTransaction(x.params[0]).name)));
 const a=assessment(result);assert.equal(a.manualRequestAllowed,false);assert.throws(()=>assertNewImportMarket(result),{code:'PROJECT_IMPORT_STILL_BONDING'});
});
for(const venue of ['v2','v3'])test(`Four graduation plus canonical ${venue} verifies only market eligibility`,async()=>{
 const {result,provider}=await read({four:true,graduated:true,venue});assert.equal(result.market.phase,'postgrad');assert.equal(result.market.verified,true);assert.equal(result.market.liquidityAvailable,true);assert.equal(result.market.executionTested,false);assert.equal(result.market.requiresLaunchReview,false);assert.equal(result.custody[0].owner,pair);assert.ok(provider.calls.length<=90);
 const a=assessment(result);assert.equal(a.automaticImportAllowed,true);assert.equal(a.permissions.trading,'locked');assert.equal(a.permissions.battle,'locked');approve(a);
});
test('ordinary DEX tokens stay manual until independent launch history is inspected',async()=>{
 const {result}=await read();assert.equal(result.market.phase,'dex_market');assert.equal(result.market.launchStageVerified,false);assert.equal(result.market.requiresLaunchReview,true);
 const a=assessment(result);assert.equal(a.canVerifyOwner,true);assert.equal(a.automaticImportAllowed,false);assert.equal(a.decision,'manual_review');assert.throws(()=>approve(a),{code:'PROJECT_IMPORT_MARKET_PROOF_REQUIRED'});
 approve(a,{marketMethod:'independent_launch_history',marketReference:'ticket: verified direct DEX launch and no active bonding'});
});
for(const options of [{wrongFactory:true},{wrongMint:true},{empty:true},{unbacked:true},{noCode:[pair]},{venue:'v3',locked:true},{venue:'v3',inactive:true},{venue:'v3',wrongFee:true},{venue:'v3',uninitialized:true}])test(`invalid or unfunded market cannot be approved: ${JSON.stringify(options)}`,async()=>{
 const {result}=await read({four:true,graduated:true,...options});assert.equal(result.market.verified,false);assert.equal(assessment(result).canVerifyOwner,false);
});
test('missing registry, wrong manager/version, unsupported quote and missing pool are distinct from a known bonding token',async()=>{
 for(const o of [{registryError:true},{four:true,version:9},{four:true,manager:pair},{four:true,graduated:true,quote:wallet},{four:true,graduated:true,noPool:true}]){
  const {result}=await read(o);assert.notEqual(result.market.phase,'bonding');assert.equal(result.market.verified,false);assert.equal(assessment(result).canVerifyOwner,false);
 }
});
test('wrong chain, stale block, fork change and hung RPC fail closed',async()=>{
 await assert.rejects(()=>read({chain:'0x61'}),{code:'PROJECT_IMPORT_CHAIN_MISMATCH'});
 await assert.rejects(()=>read({stale:true}),{code:'PROJECT_IMPORT_RPC_UNAVAILABLE'});
 await assert.rejects(()=>read({reorg:true}),{code:'PROJECT_IMPORT_RPC_UNAVAILABLE'});
 await assert.rejects(()=>readBnbImportMarket({provider:fixture({timeout:true}),tokenAddress:token,requestTimeoutMs:15}),{code:'PROJECT_IMPORT_RPC_UNAVAILABLE'});
});
test('only exact verified BNB factory custody is excluded, not another wallet or token',async()=>{
 const {result}=await read({four:true,graduated:true});const raw={is_honeypot:'0',cannot_sell_all:'0',holders:[{address:pair,percent:'0.8'},{address:wallet,percent:'0.25'}]};
 const scan=custody=>classifyProjectImportSecurity({chainId:56,raw,tokenAddress:token,market:result.market,custody});
 assert.equal(scan(result.custody).details.topHolderPercent,.25);assert.equal(scan([{...result.custody[0],mint:wallet}]).status,'blocked');
 assert.equal(scan([{...result.custody[0],chainId:101}]).status,'blocked');
 assert.ok(scan(result.custody).reviewRisks.some(r=>r.code==='holder_concentration_high'));
});
test('BNB display text names Four/Pancake rather than Pump and preserves observed block',async()=>{
 const {result}=await read({four:true});const a=assessment(result);assert.match(a.checks.find(x=>x.key==='market').finding,/Four.meme/);assert.deepEqual(a.observedBlock,result.observedBlock);
 registerProjectImportResolver(56,async()=>({...result,chainId:56,tokenAddress:token}));try{const r=await resolveProjectToken({chainId:56,tokenAddress:token});assert.deepEqual(r.launchEvidence,result.launchEvidence);assert.deepEqual(r.observedBlock,result.observedBlock);}finally{unregisterProjectImportResolver(56);}
});
