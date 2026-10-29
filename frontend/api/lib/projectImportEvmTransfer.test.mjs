import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface, Wallet, ZeroAddress, getAddress, id } from 'ethers';
import { issueEvmTransferChallenge, verifyEvmTransferProof } from './projectImportEvmTransfer.js';
import { assessProjectImport } from './projectImportAssessment.js';

process.env.PROJECT_IMPORT_CHALLENGE_SECRET = 'test-challenge-secret';
const addr = () => Wallet.createRandom().address;
const SAFE = new Interface(['function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)']);
const SAFE_OK = id('ExecutionSuccess(bytes32,uint256)');
const HASH = `0x${'ab'.repeat(32)}`;
const NOW = 1_800_000_000_000;

function setup(overrides = {}) {
  const authority = addr(), claimant = addr(), token = addr();
  const c = issueEvmTransferChallenge({ chainId: 56, tokenAddress: token, projectId: 'p1', authority, claimant, now: NOW });
  const base = { chainId: 56, tokenAddress: token, projectId: 'p1', authority, claimant, challenge: c.challenge, txHash: HASH, now: NOW + 60_000 };
  return { authority, claimant, token, c, base, ...overrides };
}

function provider({ tx, receipt = { status: 1, logs: [], blockNumber: 9 }, timestamp = (NOW + 30_000) / 1000 }) {
  return { async getTransaction() { return tx; }, async getTransactionReceipt() { return receipt; }, async getBlock() { return { timestamp }; } };
}

test('an exact transfer from the authority wallet to the claimant inside the window proves control', async () => {
  const { authority, claimant, c, base } = setup();
  const proof = await verifyEvmTransferProof({ ...base, provider: provider({ tx: { from: authority, to: claimant, value: BigInt(c.amountWei), data: '0x' } }) });
  assert.equal(proof.ownershipProofSource, 'evm_authority_transfer');
  assert.equal(proof.ownershipProofCreatorWallet, getAddress(authority));
  assert.equal(proof.ownershipProofClaimantWallet, getAddress(claimant));
  assert.ok(BigInt(c.amountWei) >= 10_000_000_000_000n && BigInt(c.amountWei) < 100_000_000_000_000n);
});

test('a Safe executing the exact transfer proves the Safe\'s consent', async () => {
  const { authority, claimant, c, base } = setup();
  const data = SAFE.encodeFunctionData('execTransaction', [claimant, BigInt(c.amountWei), '0x', 0, 0, 0, 0, ZeroAddress, ZeroAddress, '0x']);
  const receipt = { status: 1, blockNumber: 9, logs: [{ address: authority, topics: [SAFE_OK] }] };
  const proof = await verifyEvmTransferProof({ ...base, provider: provider({ tx: { from: addr(), to: authority, value: 0n, data }, receipt }) });
  assert.equal(proof.ownershipProofCreatorWallet, getAddress(authority));
  await assert.rejects(verifyEvmTransferProof({ ...base, provider: provider({ tx: { from: addr(), to: authority, value: 0n, data }, receipt: { ...receipt, logs: [] } }) }), { code: 'PROJECT_IMPORT_TRANSFER_PROOF_INVALID' }, 'Safe execution must have succeeded');
  const delegate = SAFE.encodeFunctionData('execTransaction', [claimant, BigInt(c.amountWei), '0x', 1, 0, 0, 0, ZeroAddress, ZeroAddress, '0x']);
  await assert.rejects(verifyEvmTransferProof({ ...base, provider: provider({ tx: { from: addr(), to: authority, value: 0n, data: delegate }, receipt }) }), { code: 'PROJECT_IMPORT_TRANSFER_PROOF_INVALID' }, 'delegatecall is not a plain transfer');
});

for (const [label, mutate, code = 'PROJECT_IMPORT_TRANSFER_PROOF_INVALID'] of [
  ['another sender', ({ claimant, c }) => ({ tx: { from: addr(), to: claimant, value: BigInt(c.amountWei), data: '0x' } })],
  ['another recipient', ({ authority, c }) => ({ tx: { from: authority, to: addr(), value: BigInt(c.amountWei), data: '0x' } })],
  ['wrong amount', ({ authority, claimant, c }) => ({ tx: { from: authority, to: claimant, value: BigInt(c.amountWei) + 1n, data: '0x' } })],
  ['a contract call, not a transfer', ({ authority, claimant, c }) => ({ tx: { from: authority, to: claimant, value: BigInt(c.amountWei), data: '0x1234' } })],
  ['failed transaction', ({ authority, claimant, c }) => ({ tx: { from: authority, to: claimant, value: BigInt(c.amountWei), data: '0x' }, receipt: { status: 0, logs: [], blockNumber: 9 } })],
  ['sent before the challenge', ({ authority, claimant, c }) => ({ tx: { from: authority, to: claimant, value: BigInt(c.amountWei), data: '0x' }, timestamp: (NOW - 3_600_000) / 1000 })],
  ['sent after the window', ({ authority, claimant, c }) => ({ tx: { from: authority, to: claimant, value: BigInt(c.amountWei), data: '0x' }, timestamp: (NOW + 31 * 60_000) / 1000 })],
  ['not mined yet', () => ({ tx: null, receipt: null }), 'PROJECT_IMPORT_TRANSFER_NOT_FOUND'],
]) test(`transfer check fails closed: ${label}`, async () => {
  const s = setup();
  await assert.rejects(verifyEvmTransferProof({ ...s.base, provider: provider(mutate(s)) }), { code });
});

test('the challenge is bound to project, token, claimant and authority, and cannot be edited', async () => {
  const { authority, claimant, c, base } = setup();
  const p = provider({ tx: { from: authority, to: claimant, value: BigInt(c.amountWei), data: '0x' } });
  await assert.rejects(verifyEvmTransferProof({ ...base, provider: p, claimant: addr() }), /another wallet/);
  await assert.rejects(verifyEvmTransferProof({ ...base, provider: p, projectId: 'p2' }), /another project/);
  await assert.rejects(verifyEvmTransferProof({ ...base, provider: p, authority: addr() }), { code: 'PROJECT_IMPORT_TRANSFER_AUTHORITY_CHANGED' });
  const [encoded, sig] = c.challenge.split('.');
  const edited = JSON.parse(Buffer.from(encoded, 'base64url').toString());
  edited.amountWei = '1';
  await assert.rejects(verifyEvmTransferProof({ ...base, provider: p, challenge: `${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${sig}` }), /invalid/);
  await assert.rejects(verifyEvmTransferProof({ ...base, provider: p, now: NOW + 3 * 3_600_000 }), { code: 'PROJECT_IMPORT_TRANSFER_EXPIRED' });
});

test('assessment: a verified transfer from the live owner lets the claimant claim; without it the owner mismatch stands', () => {
  const owner = addr(), claimant = addr(), token = addr();
  const resolved = { chainId: 56, tokenAddress: token, automaticOwnershipAvailable: true, currentAuthority: owner, authoritySource: 'evm_owner', market: { phase: 'postgrad', verified: true, liquidityAvailable: true } };
  const security = { status: 'pass', criticalRisks: [], reviewRisks: [] };
  const without = assessProjectImport({ resolved: { ...resolved, signedWalletMatchesAuthority: false }, security, claimantWallet: claimant });
  assert.equal(without.decision, 'wrong_wallet');
  const proven = assessProjectImport({ resolved: { ...resolved, signedWalletMatchesAuthority: true, ownershipProofSource: 'evm_authority_transfer', ownershipProofTxSignature: HASH, ownershipProofCreatorWallet: owner, ownershipProofClaimantWallet: claimant }, security, claimantWallet: claimant });
  assert.equal(proven.automaticImportAllowed, true);
  assert.equal(proven.authority.controlProof.method, 'evm_authority_transfer');
  const forged = assessProjectImport({ resolved: { ...resolved, signedWalletMatchesAuthority: true, ownershipProofSource: 'evm_authority_transfer', ownershipProofTxSignature: HASH, ownershipProofCreatorWallet: addr(), ownershipProofClaimantWallet: claimant }, security, claimantWallet: claimant });
  assert.equal(forged.automaticImportAllowed, false, 'proof from another wallet than the authority');
});
