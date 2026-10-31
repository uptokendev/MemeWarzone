import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import { METEORA_POOL_AUTHORITIES, readMeteoraPoolCustody } from './projectImportMeteoraCustody.js';
import { classifyProjectImportSecurity } from './projectImportRiskSecurity.js';

const DBC = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
// DAMM v2 program as read on mainnet 2026-10-29 (owner of HODL's pool 5dsESnst…oAYQ).
const DAMM_V2 = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const DBC_AUTHORITY = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM';
const DAMM_AUTHORITY = 'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC';

test('Meteora pool authorities are the pool_authority PDAs of the DBC and DAMM v2 programs', () => {
  const pda = (program) => PublicKey.findProgramAddressSync([Buffer.from('pool_authority')], new PublicKey(program))[0].toBase58();
  assert.equal(pda(DBC), DBC_AUTHORITY);
  assert.equal(pda(DAMM_V2), DAMM_AUTHORITY);
  assert.deepEqual(Object.keys(METEORA_POOL_AUTHORITIES).sort(), [DAMM_AUTHORITY, DBC_AUTHORITY].sort());
});

function tokenAccount(owner, mint, programOwner = TOKEN) {
  return { owner: new PublicKey(programOwner), data: { parsed: { type: 'account', info: { owner, mint } } } };
}

function rpc(entries) {
  return {
    async getTokenLargestAccounts() { return { value: entries.map((entry) => ({ address: new PublicKey(entry.address) })) }; },
    async getMultipleParsedAccounts() { return { value: entries.map((entry) => entry.account) }; },
  };
}

test('only on-chain token accounts of this mint owned by a Meteora pool authority become custody', async () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const vault = Keypair.generate().publicKey.toBase58(), dbcVault = Keypair.generate().publicKey.toBase58();
  const whale = Keypair.generate().publicKey.toBase58(), otherMintVault = Keypair.generate().publicKey.toBase58(), fake = Keypair.generate().publicKey.toBase58();
  const custody = await readMeteoraPoolCustody({ mint, connection: rpc([
    { address: vault, account: tokenAccount(DAMM_AUTHORITY, mint) },
    { address: dbcVault, account: tokenAccount(DBC_AUTHORITY, mint) },
    { address: whale, account: tokenAccount(Keypair.generate().publicKey.toBase58(), mint) },
    { address: otherMintVault, account: tokenAccount(DAMM_AUTHORITY, Keypair.generate().publicKey.toBase58()) },
    { address: fake, account: tokenAccount(DAMM_AUTHORITY, mint, '11111111111111111111111111111111') },
  ]) });
  assert.deepEqual(custody.map((entry) => [entry.tokenAccount, entry.kind]), [[vault, 'meteora_damm_v2_vault'], [dbcVault, 'meteora_dbc_vault']]);
  assert.ok(custody.every((entry) => entry.verified === true && entry.mint === mint));
});

test('RPC failure returns no custody, so every holder still counts', async () => {
  const custody = await readMeteoraPoolCustody({ mint: Keypair.generate().publicKey.toBase58(), connection: { async getTokenLargestAccounts() { throw Error('offline'); }, async getMultipleParsedAccounts() { return { value: [] }; } } });
  assert.deepEqual(custody, []);
});

test('more than 50% in one holder never blocks the import (founder 2026-10-31): a pool vault is market, a wallet is a review finding', async () => {
  const mint = Keypair.generate().publicKey.toBase58(), vault = Keypair.generate().publicKey.toBase58();
  const custody = await readMeteoraPoolCustody({ mint, connection: rpc([{ address: vault, account: tokenAccount(DBC_AUTHORITY, mint) }]) });
  const raw = { holders: [{ token_account: vault, account: DBC_AUTHORITY, percent: '0.78' }, { token_account: Keypair.generate().publicKey.toBase58(), account: 'w', percent: '0.04' }] };
  const withVault = classifyProjectImportSecurity({ chainId: 101, raw, tokenAddress: mint, custody });
  assert.ok(!withVault.criticalRisks.some((risk) => risk.code === 'holder_concentration_extreme'));
  const without = classifyProjectImportSecurity({ chainId: 101, raw, tokenAddress: mint, custody: [] });
  assert.ok(!without.criticalRisks.some((risk) => risk.code === 'holder_concentration_extreme'));
  assert.ok(without.reviewRisks.some((risk) => risk.code === 'holder_concentration_extreme'));
  assert.notEqual(without.status, 'blocked');
});

import { readMeteoraImportEvidence } from './projectImportMeteoraCustody.js';
import { resolveSolanaProjectAuthority } from './projectSolanaProjectAuthority.js';
import { assertNewImportMarket } from './projectImportAssessment.js';

test('a DBC pool that has not migrated is still bonding and keeps the graduation rule', async () => {
  const mint = Keypair.generate().publicKey.toBase58(), vault = Keypair.generate().publicKey.toBase58(), creator = Keypair.generate().publicKey.toBase58();
  const connection = rpc([{ address: vault, account: tokenAccount(DBC_AUTHORITY, mint) }]);
  const bonding = await readMeteoraImportEvidence({ connection, mint, dbcLookup: async () => ({ pool: 'P', creator, isMigrated: false }) });
  assert.deepEqual([bonding.market.phase, bonding.market.verified, bonding.market.platform], ['bonding', true, 'meteora_dbc']);
  assert.throws(() => assertNewImportMarket({ market: bonding.market }), { code: 'PROJECT_IMPORT_STILL_BONDING' });
  const migrated = await readMeteoraImportEvidence({ connection, mint, dbcLookup: async () => ({ pool: 'P', creator, isMigrated: true }) });
  assert.equal(migrated.market.phase, 'unknown');
  assert.doesNotThrow(() => assertNewImportMarket({ market: migrated.market }));
});

test('a failed DBC lookup while a DBC vault holds supply is retryable, never a pass', async () => {
  const mint = Keypair.generate().publicKey.toBase58(), vault = Keypair.generate().publicKey.toBase58();
  const fail = async () => { throw Error('gPA refused'); };
  await assert.rejects(readMeteoraImportEvidence({ connection: rpc([{ address: vault, account: tokenAccount(DBC_AUTHORITY, mint) }]), mint, dbcLookup: fail }), { code: 'PROJECT_IMPORT_RPC_UNAVAILABLE' });
  const noVault = await readMeteoraImportEvidence({ connection: rpc([]), mint, dbcLookup: fail });
  assert.equal(noVault.market.phase, 'unknown');
});

test('authority order for non-Pump coins: live mint authority, then DBC pool creator, then mint creator', async () => {
  const mint = Keypair.generate().publicKey.toBase58(), creator = Keypair.generate().publicKey.toBase58();
  const connection = { async getAccountInfo() { return null; }, async getSignaturesForAddress() { throw Error('must not read history'); }, async getParsedTransaction() { return null; } };
  const readMeteora = async () => ({ custody: [], dbcPool: { pool: 'POOL', creator, isMigrated: true }, market: { phase: 'unknown', verified: false } });
  const dbc = await resolveSolanaProjectAuthority({ connection, mint, mintAuthority: null, readMeteora });
  assert.deepEqual([dbc.currentAuthority, dbc.authoritySource, dbc.authorityEvidenceAccount], [creator, 'meteora_dbc_creator', 'POOL']);
  const live = Keypair.generate().publicKey.toBase58();
  assert.equal((await resolveSolanaProjectAuthority({ connection, mint, mintAuthority: live, readMeteora })).currentAuthority, live);
  const pda = PublicKey.findProgramAddressSync([Buffer.from('pool_authority')], new PublicKey(DBC))[0].toBase58();
  assert.equal((await resolveSolanaProjectAuthority({ connection, mint, mintAuthority: pda, readMeteora })).currentAuthority, creator);
  const offCurve = await resolveSolanaProjectAuthority({ connection, mint, mintAuthority: pda, readMeteora: async () => ({ custody: [], dbcPool: { pool: 'POOL', creator: pda, isMigrated: true }, market: { phase: 'unknown' } }) });
  assert.equal(offCurve.currentAuthority, null);
});
