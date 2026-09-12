import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey, Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PUMP_PROGRAM_ID, SOLANA_MAINNET_GENESIS, assertSolanaImportMainnet, decodePumpProjectCreator, pumpBondingCurveAddress, resolveSolanaProjectAuthority } from './projectSolanaProjectAuthority.js';
import { resolveSolanaProjectImport, setProjectImportReadClientsForTest } from './projectImportResolverAdapters.js';
// Public account snapshot: read-only Actions run 34390052080, slot 445680827.
const mint='7AVB9viRcpmr8gRMTCAYSmhP7gbuBMpBR51DMjwcpump';
const creator='3cG2kAQ4NQfy4zN1g7pTYUUHSiCCMmECenBssYddBrS3';
const curve='6Bizh2PkwgfZGhJPQYvwqAMRfE6JjgEZB6YhzQAr4jdH';
const raw='F7f4N2DYrGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAxqR+jQMAASa/slyxBtXEce/4qo5CEUssY14egVkuhvPYC0nkjcCgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
function account(){return {owner:PUMP_PROGRAM_ID,executable:false,data:Buffer.from(raw,'base64')};}
function connection(extra={}){return {
  async getGenesisHash(){return SOLANA_MAINNET_GENESIS;},
  async getParsedAccountInfo(){return {value:{owner:TOKEN_PROGRAM_ID,data:{parsed:{type:'mint',info:{mintAuthority:null,decimals:6,supply:'1000000000000000'}}}}};},
  async getAccountInfo(key){return key.toBase58()===curve?account():null;},...extra,
};}
test('canonical mint-derived Pump account identifies exact creator',()=>{assert.equal(pumpBondingCurveAddress(mint).toBase58(),curve);assert.equal(decodePumpProjectCreator(account()),creator);});
for(const match of [true,false])test(`revoked mintAuthority still resolves authenticated creator; signer match=${match}`,async()=>{
  setProjectImportReadClientsForTest({solana:connection()});try{
    const result=await resolveSolanaProjectImport({chainId:101,tokenAddress:mint,signedWallet:match?creator:Keypair.generate().publicKey.toBase58()});
    assert.equal(result.mintAuthority,null);assert.equal(result.currentAuthority,creator);assert.equal(result.authoritySource,'pump_bonding_curve_creator');assert.equal(result.authorityEvidenceAccount,curve);assert.equal(result.signedWalletMatchesAuthority,match);assert.equal(result.automaticOwnershipAvailable,true);
  }finally{setProjectImportReadClientsForTest();}
});
test('registration-only Pump resolution keeps bonding evidence but never resolves creator ownership',async()=>{
  setProjectImportReadClientsForTest({solana:connection()});try{
    const result=await resolveSolanaProjectImport({chainId:101,tokenAddress:mint,signedWallet:Keypair.generate().publicKey.toBase58(),registrationOnly:true});
    assert.equal(result.currentAuthority,null);
    assert.equal(result.authoritySource,null);
    assert.equal(result.signedWalletMatchesAuthority,false);
    assert.equal(result.automaticOwnershipAvailable,false);
    assert.equal(result.ownershipReason,'registration_does_not_resolve_ownership');
    assert.equal(result.market.phase,'bonding');
    assert.equal(result.market.verified,true);
  }finally{setProjectImportReadClientsForTest();}
});
test('forged, malformed, executable, zero and non-signable creator records fail closed',()=>{
  const bad=[{...account(),owner:TOKEN_PROGRAM_ID},{...account(),executable:true},{...account(),data:Buffer.alloc(80)}];
  const discr=account();discr.data[0]^=1;bad.push(discr);
  const zero=account();zero.data.fill(0,49,81);bad.push(zero);
  const pda=account();pumpBondingCurveAddress(mint).toBuffer().copy(pda.data,49);bad.push(pda);
  for(const value of bad)assert.equal(decodePumpProjectCreator(value),null);
});
test('creator is read fresh, not hardcoded to the incident token',async()=>{
  const alternative=Keypair.generate().publicKey;const a=account();alternative.toBuffer().copy(a.data,49);
  const result=await resolveSolanaProjectAuthority({connection:connection({async getAccountInfo(){return a;}}),mint,mintAuthority:null});assert.equal(result.currentAuthority,alternative.toBase58());
});
test('conflicting signable authority remains manual',async()=>{const r=await resolveSolanaProjectAuthority({connection:connection(),mint,mintAuthority:Keypair.generate().publicKey.toBase58()});assert.equal(r.currentAuthority,null);assert.equal(r.ownershipReason,'conflicting_project_authorities');});
test('non-Pump mint authority and unavailable-authority fallbacks remain intact',async()=>{
  const rpc=connection({async getAccountInfo(){return null;}});const authority=Keypair.generate().publicKey.toBase58();
  assert.equal((await resolveSolanaProjectAuthority({connection:rpc,mint,mintAuthority:authority})).currentAuthority,authority);
  assert.equal((await resolveSolanaProjectAuthority({connection:rpc,mint,mintAuthority:null})).currentAuthority,null);
});
test('wrong RPC network and failed account lookup never become owner proof',async()=>{
  await assert.rejects(assertSolanaImportMainnet(connection({async getGenesisHash(){return 'devnet';}})),{code:'PROJECT_IMPORT_CHAIN_MISMATCH'});
  await assert.rejects(resolveSolanaProjectAuthority({connection:connection({async getAccountInfo(){throw Error('offline');}}),mint}),{code:'PROJECT_IMPORT_RPC_UNAVAILABLE'});
});
