import assert from 'node:assert/strict';
import test from 'node:test';
import { projectImportFeedback } from './projectImportFeedback.mjs';
test('server errors and failed fetch are unavailable checks, not ownership rejection',()=>{
  for(const error of [{status:503,message:'private DB error'},new TypeError('Failed to fetch')]){
    const result=projectImportFeedback(error);assert.equal(result.title,'IMPORT CHECK TEMPORARILY UNAVAILABLE');assert.equal(result.retry,true);assert.doesNotMatch(result.message,/private DB/);
  }
});
test('owner mismatch includes exactly the shortened real wallet',()=>{
  const result=projectImportFeedback({status:403,currentAuthority:'3cG2kAQ4NQfy4zN1g7pTYUUHSiCCMmECenBssYddBrS3'});
  assert.equal(result.title,'CREATOR WALLET DOES NOT MATCH');assert.equal(result.message,'The recorded creator wallet is 3cG2...BrS3. Connect that wallet to continue.');
});
test('invalid address, disabled imports and signature cancellation remain distinct',()=>{
  assert.equal(projectImportFeedback({code:'SOLANA_MINT_INVALID'}).title,'CHECK CONTRACT ADDRESS AND CHAIN');
  assert.equal(projectImportFeedback({code:'PROJECT_IMPORTS_DISABLED',status:404}).title,'IMPORTS TEMPORARILY UNAVAILABLE');
  assert.equal(projectImportFeedback({code:4001}).title,'SIGNATURE CANCELLED');
});

test('saved image failure does not tell the user to register twice',()=>{const r=projectImportFeedback({status:503,importStage:'image'});assert.equal(r.title,'IMAGE UPLOAD NOT COMPLETED');assert.equal(r.retry,false);assert.match(r.message,/request is saved/);});
test('bonding and new policy failure are explicit',()=>{assert.equal(projectImportFeedback({code:'PROJECT_IMPORT_STILL_BONDING'}).title,'STILL BONDING');assert.equal(projectImportFeedback({code:'PROJECT_IMPORT_REVIEW_REQUIRED'}).title,'ADDITIONAL REVIEW REQUIRED');});
test('Phantom JSON-RPC Unexpected error is a wallet sign failure, not an import rejection',()=>{
  for (const error of [
    {code:-32603,message:'Unexpected error'},
    new Error('Unexpected error'),
    {code:'UNKNOWN_ERROR',message:'could not coalesce error (error={ "code": -32603, "message": "Unexpected error" })'},
    {code:'WALLET_SIGN_FAILED',message:'Unexpected error'},
  ]) {
    const result=projectImportFeedback(error);
    assert.equal(result.title,'WALLET COULD NOT SIGN');
    assert.equal(result.retry,true);
    assert.doesNotMatch(result.message,/Unexpected error/i);
  }
});
