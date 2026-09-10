import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PublicKey} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {readPumpImportEvidence,pumpCurveAddress,pumpGlobalAddress} from './projectImportPumpEvidence.js';
import {assessProjectImport} from './projectImportAssessment.js';
import {classifyProjectImportSecurity} from './projectImportRiskSecurity.js';
const recorded=JSON.parse(fs.readFileSync(new URL('./fixtures/ask-market-20260909.json',import.meta.url)));
const mint='7AVB9viRcpmr8gRMTCAYSmhP7gbuBMpBR51DMjwcpump';
const creator='3cG2kAQ4NQfy4zN1g7pTYUUHSiCCMmECenBssYddBrS3';
function accounts(){return new Map(recorded.accounts.map(({address,account})=>[address,account?{...account,owner:new PublicKey(account.owner),data:Buffer.from(account.data,'base64')}:null]));}
async function run(map=accounts()){
 return readPumpImportEvidence({connection:{getAccountInfo:async a=>map.get(a.toBase58())||null},mint,curveAccount:map.get(pumpCurveAddress(mint).toBase58()),tokenProgram:TOKEN_PROGRAM_ID,claimant:creator});
}
test('recorded ASK pool with a nonzero signed virtual-reserve extension verifies as its real canonical market',async()=>{
 const e=await run();assert.equal(e.market.phase,'postgrad');assert.equal(e.market.poolAddress,'5jCCA6YfURQGxdMF4HWevaMyHkyPhFGwMpuo8W2mbDxf');assert.equal(e.market.verified,true);assert.equal(e.market.liquidityAvailable,true);assert.equal(e.market.buyEnabled,true);assert.equal(e.market.sellEnabled,true);assert.notEqual(e.market.virtualQuoteReserves,'0');assert.equal(BigInt(e.market.effectiveQuoteReserves),BigInt(e.market.quoteReserve)+BigInt(e.market.virtualQuoteReserves));assert.equal(e.market.virtualReservesAreLiquidity,false);assert.equal(e.market.executionTested,false);assert.equal(e.custody.length,1);
});
test('ASK pool funding does not solve a different creator wallet',async()=>{
 const e=await run();const a=assessProjectImport({resolved:{chainId:101,tokenAddress:mint,market:e.market,currentAuthority:creator,automaticOwnershipAvailable:true,signedWalletMatchesAuthority:false},security:{status:'pass'},claimantWallet:'9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H'});assert.equal(a.decision,'wrong_wallet');assert.equal(a.manualRequestAllowed,false);
});
test('real pool data does not exempt disabled global controls or empty quote custody',async()=>{
 const map=accounts();map.get(pumpGlobalAddress().toBase58()).data[56]|=16;
 const e=await run(map);assert.equal(e.market.sellEnabled,false);
 const s=classifyProjectImportSecurity({chainId:101,raw:{default_account_state:'1',holders:[]},tokenAddress:mint,market:e.market,custody:e.custody});assert.ok(s.criticalRisks.some(r=>r.code==='market_trading_disabled'));
 const map2=accounts();map2.get('F4VKhJ8Ek63AQC21sLcTj9Rt9xDoTSWwoaFw6YDXEN6V').data.writeBigUInt64LE(0n,64);
 const empty=await run(map2);assert.equal(empty.market.liquidityAvailable,false);assert.ok(BigInt(empty.market.virtualQuoteReserves)>0n);
});

test('a missing ASK market observation is not reported as proof of a pending migration',async()=>{const map=accounts();map.delete('5jCCA6YfURQGxdMF4HWevaMyHkyPhFGwMpuo8W2mbDxf');const e=await run(map);assert.equal(e.market.phase,'postgrad_unverified');assert.equal(e.market.verified,false);assert.equal(e.market.reason,'supported_pool_not_verified');});
