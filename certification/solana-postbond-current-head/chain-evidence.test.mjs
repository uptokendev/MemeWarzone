import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AddressLookupTableAccount,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
} from '@solana/web3.js';
import { payerNativeVolume, resolveTransactionAccountKeys } from './chain-evidence.mjs';

const blockhash = '11111111111111111111111111111111';
const pk = (seed) => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (seed + i) & 255));

function table(key, addresses) {
  return new AddressLookupTableAccount({
    key,
    state: {
      deactivationSlot: 18446744073709551615n,
      lastExtendedSlot: 1,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses,
    },
  });
}

function v0Tx({ payer, instructions, lookupTable, loadedAddresses, preBalances, postBalances, fee = 0 }) {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions })
    .compileToV0Message(lookupTable ? [lookupTable] : []);
  return {
    transaction: { message },
    meta: { loadedAddresses, preBalances, postBalances, fee },
  };
}

function legacyTx({ payer, instruction, preBalances, postBalances, fee = 0 }) {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [instruction] })
    .compileToLegacyMessage();
  return { transaction: { message }, meta: { preBalances, postBalances, fee } };
}

test('legacy transaction resolves without ALT', async () => {
  const payer = pk(1);
  const recipient = pk(2);
  const tx = legacyTx({
    payer,
    instruction: SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports: 1 }),
    preBalances: [100_000, 0, 0],
    postBalances: [89_000, 10_000, 0],
    fee: 1_000,
  });
  const keys = await resolveTransactionAccountKeys(null, tx);
  assert.equal(keys[0].toBase58(), payer.toBase58());
  assert.equal(await payerNativeVolume(null, tx, payer), 10_000n);
});

test('V0 writable lookup address preserves pre/post balance index ordering', async () => {
  const payer = pk(10);
  const lookedUpWritable = pk(11);
  const alt = table(pk(12), [lookedUpWritable]);
  const tx = v0Tx({
    payer,
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: lookedUpWritable, lamports: 1 })],
    lookupTable: alt,
    loadedAddresses: { writable: [lookedUpWritable], readonly: [] },
    preBalances: [100_000, 0, 20_000],
    postBalances: [89_000, 0, 30_000],
    fee: 1_000,
  });
  const keys = await resolveTransactionAccountKeys(null, tx);
  assert.equal(keys.at(-1).toBase58(), lookedUpWritable.toBase58());
  assert.equal(await payerNativeVolume(null, tx, payer), 10_000n);
  assert.equal(await payerNativeVolume(null, tx, lookedUpWritable), 10_000n);
});

test('V0 readonly lookup address is appended after writable lookup addresses', async () => {
  const payer = pk(20);
  const writable = pk(21);
  const readonly = pk(22);
  const program = pk(23);
  const alt = table(pk(24), [writable, readonly]);
  const ix = new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: writable, isSigner: false, isWritable: true },
      { pubkey: readonly, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [ix] })
    .compileToV0Message([alt]);
  const staticCount = message.staticAccountKeys.length;
  const tx = {
    transaction: { message },
    meta: {
      loadedAddresses: { writable: [writable], readonly: [readonly] },
      preBalances: Array(staticCount + 2).fill(100),
      postBalances: Array(staticCount + 2).fill(100),
      fee: 0,
    },
  };
  const keys = await resolveTransactionAccountKeys(null, tx);
  assert.equal(keys[staticCount].toBase58(), writable.toBase58());
  assert.equal(keys[staticCount + 1].toBase58(), readonly.toBase58());
});

test('payer in static keys is found and transaction fee is excluded exactly once', async () => {
  const payer = pk(30);
  const recipient = pk(31);
  const tx = legacyTx({
    payer,
    instruction: SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports: 1 }),
    preBalances: [50_000, 0, 0],
    postBalances: [39_000, 10_000, 0],
    fee: 1_000,
  });
  assert.equal(await payerNativeVolume(null, tx, payer), 10_000n);
});

test('payer not found returns null', async () => {
  const payer = pk(40);
  const recipient = pk(41);
  const tx = legacyTx({
    payer,
    instruction: SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports: 1 }),
    preBalances: [10, 0, 0],
    postBalances: [8, 1, 0],
    fee: 1,
  });
  assert.equal(await payerNativeVolume(null, tx, pk(42)), null);
});

test('missing ALT fails closed when RPC loaded addresses are absent', async () => {
  const payer = pk(50);
  const lookedUp = pk(51);
  const alt = table(pk(52), [lookedUp]);
  const tx = v0Tx({
    payer,
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: lookedUp, lamports: 1 })],
    lookupTable: alt,
    loadedAddresses: undefined,
    preBalances: [10, 0, 0],
    postBalances: [8, 0, 1],
    fee: 1,
  });
  await assert.rejects(
    resolveTransactionAccountKeys({ getAddressLookupTable: async () => ({ value: null }) }, tx),
    /ALT unavailable/,
  );
});

test('wrong or malformed ALT fails closed', async () => {
  const payer = pk(60);
  const lookedUp = pk(61);
  const alt = table(pk(62), [lookedUp]);
  const tx = v0Tx({
    payer,
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: lookedUp, lamports: 1 })],
    lookupTable: alt,
    loadedAddresses: undefined,
    preBalances: [10, 0, 0],
    postBalances: [8, 0, 1],
    fee: 1,
  });
  const wrong = table(pk(63), [lookedUp]);
  await assert.rejects(
    resolveTransactionAccountKeys({ getAddressLookupTable: async () => ({ value: wrong }) }, tx),
    /ALT key mismatch/,
  );
  await assert.rejects(
    resolveTransactionAccountKeys({ getAddressLookupTable: async () => ({ value: { key: alt.key, state: {} } }) }, tx),
    /ALT malformed/,
  );
});

test('balance arrays must align with complete account-key collection', async () => {
  const payer = pk(70);
  const recipient = pk(71);
  const tx = legacyTx({
    payer,
    instruction: SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports: 1 }),
    preBalances: [10],
    postBalances: [8],
    fee: 1,
  });
  await assert.rejects(payerNativeVolume(null, tx, payer), /balance\/account-key alignment mismatch/);
});

test('BUY and SELL native-volume calculation uses absolute fee-adjusted payer delta', async () => {
  const payer = pk(80);
  const counterparty = pk(81);
  const buy = legacyTx({
    payer,
    instruction: SystemProgram.transfer({ fromPubkey: payer, toPubkey: counterparty, lamports: 1 }),
    preBalances: [100_000, 0, 0],
    postBalances: [74_000, 25_000, 0],
    fee: 1_000,
  });
  const sell = legacyTx({
    payer,
    instruction: SystemProgram.transfer({ fromPubkey: payer, toPubkey: counterparty, lamports: 1 }),
    preBalances: [74_000, 25_000, 0],
    postBalances: [93_000, 5_000, 0],
    fee: 1_000,
  });
  assert.equal(await payerNativeVolume(null, buy, payer), 25_000n);
  assert.equal(await payerNativeVolume(null, sell, payer), 20_000n);
});
