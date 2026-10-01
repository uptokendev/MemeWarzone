import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { DBC_PROGRAM_ID } from "../../shared/dbcEconomics.mjs";
import {
  DBC_CREATE_ALLOWED_PROGRAM_IDS,
  DBC_METAPLEX_METADATA_PROGRAM_ID,
  assertDbcCreateIntent,
  prepareDbcCreateTransaction,
  submitPreparedDbcCreate,
} from "./dbcCreateIntent.mjs";

const creator = Keypair.generate();
const mint = Keypair.generate();
const pool = Keypair.generate();
const config = Keypair.generate();

function envelope({ programId = DBC_PROGRAM_ID, feePayer = creator.publicKey, extraProgram = null } = {}) {
  const tx = new Transaction();
  tx.feePayer = feePayer;
  tx.recentBlockhash = "11111111111111111111111111111111";
  tx.add(new TransactionInstruction({
    keys: [
      { pubkey: creator.publicKey, isSigner: true, isWritable: true },
      { pubkey: mint.publicKey, isSigner: true, isWritable: true },
      { pubkey: pool.publicKey, isSigner: false, isWritable: true },
      { pubkey: config.publicKey, isSigner: false, isWritable: false },
    ],
    programId: new PublicKey(programId),
    data: Buffer.alloc(0),
  }));
  if (extraProgram) {
    tx.add(new TransactionInstruction({
      keys: [{ pubkey: creator.publicKey, isSigner: true, isWritable: true }],
      programId: new PublicKey(extraProgram),
      data: Buffer.alloc(0),
    }));
  }
  return tx;
}

test("allowlist includes DBC, System, SPL Token, ATA, compute budget, Metaplex", () => {
  assert.ok(DBC_CREATE_ALLOWED_PROGRAM_IDS.has(DBC_PROGRAM_ID));
  assert.ok(DBC_CREATE_ALLOWED_PROGRAM_IDS.has(SystemProgram.programId.toBase58()));
  assert.ok(DBC_CREATE_ALLOWED_PROGRAM_IDS.has(DBC_METAPLEX_METADATA_PROGRAM_ID));
});

test("intent accepts a DBC envelope and rejects an unexpected program or fee payer", () => {
  assert.doesNotThrow(() => assertDbcCreateIntent(envelope(), {
    creator: creator.publicKey.toBase58(),
    pool: pool.publicKey.toBase58(),
    config: config.publicKey.toBase58(),
    mint: mint.publicKey.toBase58(),
  }));
  assert.throws(
    () => assertDbcCreateIntent(envelope({ extraProgram: Keypair.generate().publicKey.toBase58() }), {
      creator: creator.publicKey.toBase58(),
      pool: pool.publicKey.toBase58(),
      config: config.publicKey.toBase58(),
      mint: mint.publicKey.toBase58(),
    }),
    /Unexpected program/,
  );
  assert.throws(
    () => assertDbcCreateIntent(envelope({ feePayer: mint.publicKey }), {
      creator: creator.publicKey.toBase58(),
      pool: pool.publicKey.toBase58(),
      config: config.publicKey.toBase58(),
      mint: mint.publicKey.toBase58(),
    }),
    /fee payer/,
  );
});

test("prepare replaces the placeholder blockhash and simulates before sign", async () => {
  const tx = envelope();
  let simulatedHash = null;
  const connection = {
    async getLatestBlockhash() {
      return { blockhash: "FreshBlockhash11111111111111111111", lastValidBlockHeight: 42 };
    },
    async simulateTransaction(prepared) {
      simulatedHash = prepared.recentBlockhash;
      return { value: { err: null, unitsConsumed: 12 } };
    },
  };
  const prepared = await prepareDbcCreateTransaction(connection, tx, {
    creator: creator.publicKey.toBase58(),
    pool: pool.publicKey.toBase58(),
    config: config.publicKey.toBase58(),
    mint: mint.publicKey.toBase58(),
  });
  assert.equal(prepared.blockhash, "FreshBlockhash11111111111111111111");
  assert.equal(prepared.lastValidBlockHeight, 42);
  assert.equal(simulatedHash, "FreshBlockhash11111111111111111111");
  assert.notEqual(simulatedHash, "11111111111111111111111111111111");
});

function fakeConnection(sent) {
  return {
    async getLatestBlockhash() {
      return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 42 };
    },
    async simulateTransaction() {
      return { value: { err: null, unitsConsumed: 12 } };
    },
    async sendRawTransaction(raw) {
      sent.push(raw);
      return "sig";
    },
    async confirmTransaction() {
      return { value: { err: null } };
    },
  };
}

const expected = () => ({
  mintSecretKey: mint.secretKey,
  mintAddress: mint.publicKey.toBase58(),
  creatorAddress: creator.publicKey.toBase58(),
  pool: pool.publicKey.toBase58(),
  config: config.publicKey.toBase58(),
  Keypair,
});

test("the wallet signs first: it receives a transaction with no signature on it", async () => {
  // Phantom 2026-10-01: a request already signed by the mint key was blocked as malicious.
  const sent = [];
  let seenByWallet = null;
  await submitPreparedDbcCreate({
    ...expected(),
    connection: fakeConnection(sent),
    transaction: envelope(),
    async signTransaction(tx) {
      seenByWallet = tx.signatures.map((s) => s.signature);
      tx.partialSign(creator);
      return tx;
    },
  });
  assert.ok(seenByWallet.every((s) => s === null), "no signature may be on the transaction the wallet sees");
  const final = Transaction.from(sent[0]);
  assert.equal(final.verifySignatures(), true);
});

test("an instruction the wallet adds is covered by the mint signature that follows", async () => {
  const sent = [];
  await submitPreparedDbcCreate({
    ...expected(),
    connection: fakeConnection(sent),
    transaction: envelope(),
    async signTransaction(tx) {
      // Phantom's Lighthouse guard appends instructions before it signs.
      tx.add(new TransactionInstruction({ keys: [], programId: SystemProgram.programId, data: Buffer.alloc(0) }));
      tx.partialSign(creator);
      return tx;
    },
  });
  const final = Transaction.from(sent[0]);
  assert.equal(final.instructions.length, 2);
  assert.equal(final.verifySignatures(), true);
});

test("a wallet that returns something the mint cannot co-sign is refused, nothing is sent", async () => {
  const sent = [];
  await assert.rejects(
    submitPreparedDbcCreate({
      ...expected(),
      connection: fakeConnection(sent),
      transaction: envelope(),
      async signTransaction() {
        return new Uint8Array([1, 2, 3]);
      },
    }),
    /cannot co-sign/,
  );
  assert.equal(sent.length, 0);
});
