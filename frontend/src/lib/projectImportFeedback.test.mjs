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
  assert.equal(result.title,'NOT TOKEN OWNER');assert.equal(result.message,'This token is controlled by wallet 3cG2...BrS3. Connect that wallet to continue.');
});
test('invalid address, disabled imports and signature cancellation remain distinct',()=>{
  assert.equal(projectImportFeedback({code:'SOLANA_MINT_INVALID'}).title,'CHECK CONTRACT ADDRESS AND CHAIN');
  assert.equal(projectImportFeedback({code:'PROJECT_IMPORTS_DISABLED',status:404}).title,'IMPORTS TEMPORARILY UNAVAILABLE');
  assert.equal(projectImportFeedback({code:4001}).title,'SIGNATURE CANCELLED');
});

test("image failure explains saved progress without restarting import",()=>{const r=projectImportFeedback({status:503,importStage:"image"});assert.equal(r.title,"IMAGE UPLOAD NOT COMPLETED");assert.match(r.message,/request is saved/);assert.equal(r.retry,false);});
