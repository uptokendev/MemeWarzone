import test from 'node:test';import assert from 'node:assert/strict';
import {classifyProjectImportSecurity,scanProjectImportSecurity} from './projectImportRiskSecurity.js';
const mint='FcBb7avR9LgmgwFxRcVJDiroZxZfgvtnUJrRKQ7kpump';
const raw=()=>({default_account_state:'1',non_transferable:'0',freezable:{status:'0'},mintable:{status:'0'},balance_mutable_authority:{status:'0'},holders:[],dex:[{}]});
const scan=(r,extra={})=>classifyProjectImportSecurity({chainId:101,tokenAddress:mint,raw:r,...extra});
test('normal state 1 is not frozen; state 2 is blocked; 0/unknown require review',()=>{assert.equal(scan(raw()).status,'pass');assert.equal(scan({...raw(),default_account_state:'2'}).status,'blocked');for(const state of ['0','',null,undefined,'17'])assert.notEqual(scan({...raw(),default_account_state:state}).status,'pass');});
test('unknown scanner data never clears a token',()=>{for(const r of [null,{},[],{dex:[{}],holders:[]}])assert.equal(scan(r).status,'review');assert.equal(classifyProjectImportSecurity({chainId:56,raw:{dex:[{}],holders:[]}}).status,'review');});
test('only exact authenticated custody is excluded and remaining whale stays flagged',()=>{
 const r={...raw(),holders:[{account:'curve',token_account:'ata',percent:'0.4056'},{account:'whale',token_account:'other',percent:'0.61'}]};
 const c={verified:true,mint,owner:'curve',tokenAccount:'ata'};
 const result=scan(r,{custody:[c]});assert.equal(result.details.excludedMarketInventory.length,1);assert.equal(result.details.topHolderPercent,0.61);assert.equal(result.status,'blocked');
 for(const bad of [{...c,verified:false},{...c,mint:'other'},{...c,tokenAccount:'fake'},{...c,owner:'impostor'}])assert.equal(scan(r,{custody:[bad]}).details.excludedMarketInventory.length,0);
});
test('missing DEX data is unknown, not no liquidity; verified bonding is not a DEX failure',()=>{const r=raw();delete r.dex;const a=scan(r);assert.ok(a.reviewRisks.some(x=>x.code==='liquidity_data_unavailable'));assert.ok(!a.reviewRisks.some(x=>x.code==='no_dex_liquidity'));const b=scan(r,{market:{phase:'bonding',verified:true}});assert.equal(b.details.liquidityEvidence,'bonding_curve_not_graduated');assert.equal(b.status,'pass');});
test('Solana scanner result must match case-exact Contract Address',async()=>{const s=await scanProjectImportSecurity({chainId:101,tokenAddress:mint,fetchImpl:async()=>({ok:true,json:async()=>({code:1,result:{[mint.toLowerCase()]:raw()}})})});assert.equal(s.status,'review');assert.equal(s.reviewRisks[0].code,'no_security_data');});
test('genuine frozen and nontransferable risks are not removed by custody or market exemptions',()=>{const s=scan({...raw(),default_account_state:'2',non_transferable:'1'},{market:{phase:'postgrad',verified:true,liquidityAvailable:true},custody:[]});assert.equal(s.status,'blocked');assert.equal(s.criticalRisks.length,2);});
