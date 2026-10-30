import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { MINT_CREATOR_MAX_PAGES, clearMintCreatorCacheForTest, mintCreatorFromParsedTransaction, resolveSolanaMintCreator, resolveSolanaProjectAuthority } from './projectSolanaProjectAuthority.js';
import { assessProjectImport } from './projectImportAssessment.js';

// HODL (Clashpad, Token-2022): creation tx read from mainnet 2026-10-29. Its fee payer is the
// claimant of the first manual review that led to the founder's mint-creator rule.
const HODL_MINT = '6roVXGp6izrreewkZNbuAd5yZrzwLfX4Zmyh1U5nLeEp';
const HODL_CREATOR = 'Hkh8KebWxAVvyDtCwE2RwDkZoDqWrghWjxbGFxthhkdT';
const HODL_SIG = '5q24b3v1NKo544wbs4fSZVdsbkFK1Xxhmx9sWWyVQuDHXuSKPxRFEUn9VpheEuEXtpts9P28NXSyzuRCtnrDNfUb';
const hodlTx = JSON.parse(readFileSync(new URL('./fixtures/hodl-mint-creation-tx.json', import.meta.url), 'utf8'));
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

function syntheticTx({ payer, mint, signer = true, err = null, inner = false, type = 'initializeMint2', programId = TOKEN_2022, mintAuthority = payer }) {
  const ix = { programId, parsed: { type, info: { mint, mintAuthority } } };
  return {
    slot: 1, blockTime: 2,
    meta: { err, innerInstructions: inner ? [{ index: 0, instructions: [ix] }] : [] },
    transaction: { message: { accountKeys: [{ pubkey: new PublicKey(payer), signer }, { pubkey: mint, signer: true }], instructions: inner ? [] : [ix] } },
  };
}

function rpc({ pages, txs = {}, failSignatures = false, failTx = false }) {
  const calls = { signatures: 0, tx: 0 };
  return {
    calls,
    async getAccountInfo() { return null; },
    async getSignaturesForAddress(_key, options) {
      calls.signatures++;
      if (failSignatures) throw Error('offline');
      if (!options.before) return pages[0] || [];
      const index = pages.findIndex((page) => page.length && page[page.length - 1].signature === options.before);
      return pages[index + 1] || [];
    },
    async getParsedTransaction(signature) { calls.tx++; if (failTx) throw Error('offline'); return txs[signature] ?? null; },
  };
}

function page(count, prefix, extra = {}) { return Array.from({ length: count }, (_, i) => ({ signature: `${prefix}${i}`, err: null, ...extra })); }

test('HODL creation tx: fee payer that initialized the mint is the creator', () => {
  assert.equal(mintCreatorFromParsedTransaction(hodlTx, HODL_MINT), HODL_CREATOR);
  assert.equal(hodlTx.transaction.signatures[0], HODL_SIG);
});

test('revoked mint authority without a Pump curve resolves the mint creator', async () => {
  clearMintCreatorCacheForTest();
  const connection = rpc({ pages: [[{ signature: 'newer', err: null }, { signature: HODL_SIG, err: null, slot: 9 }]], txs: { [HODL_SIG]: hodlTx } });
  const result = await resolveSolanaProjectAuthority({ connection, mint: HODL_MINT, mintAuthority: null });
  assert.equal(result.currentAuthority, HODL_CREATOR);
  assert.equal(result.authoritySource, 'mint_creator');
  assert.equal(result.authorityEvidenceAccount, HODL_SIG);
  assert.equal(result.ownershipReason, 'mint_creator_resolved');
  assert.equal(result.projectAuthorityEvidence.creationSignature, HODL_SIG);
  assert.equal(result.market.verified, false);
});

test('the creator wallet auto-approves; another wallet may still request manual review', () => {
  const resolved = { chainId: 101, tokenAddress: HODL_MINT, automaticOwnershipAvailable: true, currentAuthority: HODL_CREATOR, authoritySource: 'mint_creator', market: { phase: 'unknown', verified: false } };
  const security = { status: 'review', criticalRisks: [], reviewRisks: [{ code: 'holder_concentration_high' }] };
  const match = assessProjectImport({ resolved: { ...resolved, signedWalletMatchesAuthority: true }, security, claimantWallet: HODL_CREATOR });
  assert.equal(match.automaticImportAllowed, true);
  assert.equal(match.authority.status, 'matched');
  const other = Keypair.generate().publicKey.toBase58();
  const mismatch = assessProjectImport({ resolved: { ...resolved, signedWalletMatchesAuthority: false }, security, claimantWallet: other });
  assert.equal(mismatch.automaticImportAllowed, false);
  assert.equal(mismatch.manualRequestAllowed, true);
  assert.notEqual(mismatch.decision, 'wrong_wallet');
});

test('a live mint authority wins; a program-held one never falls back to the creator', async () => {
  clearMintCreatorCacheForTest();
  const connection = rpc({ pages: [[{ signature: HODL_SIG, err: null }]], txs: { [HODL_SIG]: hodlTx } });
  const live = Keypair.generate().publicKey.toBase58();
  assert.equal((await resolveSolanaProjectAuthority({ connection, mint: HODL_MINT, mintAuthority: live })).currentAuthority, live);
  const pda = PublicKey.findProgramAddressSync([Buffer.from('x')], new PublicKey(TOKEN_2022))[0].toBase58();
  const held = await resolveSolanaProjectAuthority({ connection, mint: HODL_MINT, mintAuthority: pda });
  assert.equal(held.currentAuthority, null);
  assert.equal(connection.calls.signatures, 0);
});

test('paging reads back to the oldest successful transaction', async () => {
  clearMintCreatorCacheForTest();
  const mint = Keypair.generate().publicKey.toBase58(), payer = Keypair.generate().publicKey.toBase58();
  const last = [{ signature: 'p2-new', err: null }, { signature: 'create', err: null }, { signature: 'failed-attempt', err: { InstructionError: [0, 'x'] } }];
  const connection = rpc({ pages: [page(1000, 'a'), page(1000, 'b'), last], txs: { create: syntheticTx({ payer, mint }) } });
  const result = await resolveSolanaMintCreator({ connection, mint });
  assert.equal(result.creator, payer);
  assert.equal(result.signature, 'create');
  assert.equal(connection.calls.signatures, 3);
  await resolveSolanaMintCreator({ connection, mint });
  assert.equal(connection.calls.signatures, 3, 'resolved creator is cached');
});

test('initializeMint in an inner instruction (launchpad CPI) also counts', () => {
  const mint = Keypair.generate().publicKey.toBase58(), payer = Keypair.generate().publicKey.toBase58();
  assert.equal(mintCreatorFromParsedTransaction(syntheticTx({ payer, mint, inner: true, type: 'initializeMint' }), mint), payer);
});

test('fail closed: unsigned payer, payer is the mint, failed tx, other mint, wrong program, PDA payer', () => {
  const mint = Keypair.generate().publicKey.toBase58(), payer = Keypair.generate().publicKey.toBase58();
  assert.equal(mintCreatorFromParsedTransaction(syntheticTx({ payer, mint, signer: false }), mint), null);
  assert.equal(mintCreatorFromParsedTransaction(syntheticTx({ payer: mint, mint }), mint), null);
  assert.equal(mintCreatorFromParsedTransaction(syntheticTx({ payer, mint, err: { InstructionError: [0, 'x'] } }), mint), null);
  assert.equal(mintCreatorFromParsedTransaction(syntheticTx({ payer, mint: Keypair.generate().publicKey.toBase58() }), mint), null);
  assert.equal(mintCreatorFromParsedTransaction(syntheticTx({ payer, mint, programId: '11111111111111111111111111111111' }), mint), null);
  const pda = PublicKey.findProgramAddressSync([Buffer.from('y')], new PublicKey(TOKEN_2022))[0].toBase58();
  assert.equal(mintCreatorFromParsedTransaction(syntheticTx({ payer: pda, mint }), mint), null);
});

test('a payer that did not make itself the initial mint authority is not the creator (relayer, launchpad PDA, multisig)', () => {
  const mint = Keypair.generate().publicKey.toBase58(), relayer = Keypair.generate().publicKey.toBase58(), user = Keypair.generate().publicKey.toBase58();
  assert.equal(mintCreatorFromParsedTransaction(syntheticTx({ payer: relayer, mint, mintAuthority: user }), mint), null);
  const launchpadPda = PublicKey.findProgramAddressSync([Buffer.from('mint_authority')], new PublicKey(TOKEN_2022))[0].toBase58();
  assert.equal(mintCreatorFromParsedTransaction(syntheticTx({ payer: relayer, mint, inner: true, mintAuthority: launchpadPda }), mint), null);
  assert.equal(mintCreatorFromParsedTransaction(syntheticTx({ payer: relayer, mint, mintAuthority: null }), mint), null);
});

test('negative creator results are not cached', async () => {
  clearMintCreatorCacheForTest();
  const mint = Keypair.generate().publicKey.toBase58(), payer = Keypair.generate().publicKey.toBase58();
  const txs = { first: syntheticTx({ payer, mint, type: 'mintTo' }) };
  const connection = rpc({ pages: [[{ signature: 'first', err: null }]], txs });
  assert.equal((await resolveSolanaMintCreator({ connection, mint })).creator, null);
  txs.first = syntheticTx({ payer, mint });
  assert.equal((await resolveSolanaMintCreator({ connection, mint })).creator, payer);
});

test('oldest successful tx that does not initialize the mint stays unresolved', async () => {
  clearMintCreatorCacheForTest();
  const mint = Keypair.generate().publicKey.toBase58(), payer = Keypair.generate().publicKey.toBase58();
  const connection = rpc({ pages: [[{ signature: 'first', err: null }]], txs: { first: syntheticTx({ payer, mint, type: 'mintTo' }) } });
  const result = await resolveSolanaProjectAuthority({ connection, mint, mintAuthority: null });
  assert.equal(result.currentAuthority, null);
  assert.equal(result.ownershipReason, 'mint_creator_unverified');
});

test('a history longer than the page cap stays on manual review without reading a transaction', async () => {
  clearMintCreatorCacheForTest();
  const mint = Keypair.generate().publicKey.toBase58();
  const pages = Array.from({ length: MINT_CREATOR_MAX_PAGES + 1 }, (_, i) => page(1000, `p${i}-`));
  const connection = rpc({ pages });
  const result = await resolveSolanaProjectAuthority({ connection, mint, mintAuthority: null });
  assert.equal(result.currentAuthority, null);
  assert.equal(result.ownershipReason, 'mint_creator_history_too_long');
  assert.equal(connection.calls.signatures, MINT_CREATOR_MAX_PAGES);
  assert.equal(connection.calls.tx, 0);
});

test('RPC failure is a retryable error, never "no creator"', async () => {
  clearMintCreatorCacheForTest();
  const mint = Keypair.generate().publicKey.toBase58();
  await assert.rejects(resolveSolanaMintCreator({ connection: rpc({ pages: [], failSignatures: true }), mint }), { code: 'PROJECT_IMPORT_RPC_UNAVAILABLE' });
  await assert.rejects(resolveSolanaMintCreator({ connection: rpc({ pages: [[{ signature: 's', err: null }]], failTx: true }), mint }), { code: 'PROJECT_IMPORT_RPC_UNAVAILABLE' });
  await assert.rejects(resolveSolanaMintCreator({ connection: rpc({ pages: [[{ signature: 's', err: null }]] }), mint }), { code: 'PROJECT_IMPORT_RPC_UNAVAILABLE' });
});
