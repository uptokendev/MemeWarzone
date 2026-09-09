import test from 'node:test';import assert from 'node:assert/strict';
import {withImportTransaction,appendImportEvidence} from './projectImportEvidenceStore.js';
import {IMPORT_REVIEW_POLICY} from './projectImportAssessment.js';
test('a failed evidence write rolls back the registration transaction',async()=>{
 const calls=[];const client={query:async(sql)=>{calls.push(sql);if(sql.startsWith('INSERT INTO public.project_import_review_evidence'))throw Error('evidence unavailable');return{rows:[]};},release:()=>calls.push('RELEASE')};
 await assert.rejects(()=>withImportTransaction({connect:async()=>client},async db=>{await db.query('INSERT PROJECT');await appendImportEvidence(db,{project:{id:'p',chain_id:101,token_address:'token'},assessment:{chainId:101,tokenAddress:'token',policyVersion:IMPORT_REVIEW_POLICY,claimantWallet:'wallet',checkedAt:new Date().toISOString()},source:'manual_claim'});}),/evidence unavailable/);
 assert.equal(calls[0],'BEGIN');assert.ok(calls.includes('ROLLBACK'));assert.ok(!calls.includes('COMMIT'));assert.equal(calls.at(-1),'RELEASE');
});
test('snapshot identity mismatch fails before DB write',async()=>{let writes=0;await assert.rejects(()=>appendImportEvidence({query:async()=>{writes++;}},{project:{chain_id:101,token_address:'correct'},assessment:{chainId:101,tokenAddress:'wrong',policyVersion:IMPORT_REVIEW_POLICY},source:'manual_claim'}),{code:'PROJECT_IMPORT_EVIDENCE_MISMATCH'});assert.equal(writes,0);});
test('successful operations commit and release exactly once',async()=>{const calls=[];const client={query:async sql=>{calls.push(sql)},release:()=>calls.push('RELEASE')};assert.equal(await withImportTransaction({connect:async()=>client},async()=>42),42);assert.deepEqual(calls,['BEGIN','COMMIT','RELEASE']);});
