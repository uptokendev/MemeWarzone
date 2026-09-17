import test from 'node:test';
import assert from 'node:assert/strict';
import { createChallengeLamports, parsedTransactionHasChallengeTransfer, PUMP_CHALLENGE_MIN_LAMPORTS, PUMP_CHALLENGE_MAX_LAMPORTS } from './projectImportPumpChallenge.js';

test('challenge amount stays tiny and unique-capable',()=>{
  assert.equal(createChallengeLamports((min,max)=>{assert.equal(min,PUMP_CHALLENGE_MIN_LAMPORTS);assert.equal(max,PUMP_CHALLENGE_MAX_LAMPORTS+1);return 54321;}),54321);
});

test('only exact system transfer from creator to claimant matches',()=>{
  const tx={transaction:{message:{instructions:[{program:'system',parsed:{type:'transfer',info:{source:'creator',destination:'claimant',lamports:54321}}}]}}};
  assert.equal(parsedTransactionHasChallengeTransfer(tx,{creatorWallet:'creator',claimantWallet:'claimant',lamports:54321}),true);
  assert.equal(parsedTransactionHasChallengeTransfer(tx,{creatorWallet:'other',claimantWallet:'claimant',lamports:54321}),false);
  assert.equal(parsedTransactionHasChallengeTransfer(tx,{creatorWallet:'creator',claimantWallet:'other',lamports:54321}),false);
  assert.equal(parsedTransactionHasChallengeTransfer(tx,{creatorWallet:'creator',claimantWallet:'claimant',lamports:54322}),false);
});

test('non-system and failed-shape instructions never match',()=>{
  const tx={transaction:{message:{instructions:[{program:'spl-token',parsed:{type:'transfer',info:{source:'creator',destination:'claimant',lamports:54321}}}]}}};
  assert.equal(parsedTransactionHasChallengeTransfer(tx,{creatorWallet:'creator',claimantWallet:'claimant',lamports:54321}),false);
});
