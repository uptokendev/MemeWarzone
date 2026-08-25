import assert from "node:assert/strict";
import test from "node:test";

import { Keypair, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import * as web3 from "@solana/web3.js";
import { loadSolanaUserV0Module } from "../../scripts/load-solana-v0-module.mjs";

const {
  assertSolanaUserV0Intent,
  buildSolanaUserV0Transaction,
  compileSolanaUserV0WithLatestBlockhash,
} = await loadSolanaUserV0Module();

const BLOCKHASH = Keypair.generate().publicKey.toBase58();

function transferFixture() {
  const payer = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const instruction = SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: recipient,
    lamports: 12345,
  });
  return { payer, recipient, instruction };
}

test("generic user transaction compiles as exact one-signer V0 intent", () => {
  const fixture = transferFixture();
  const transaction = buildSolanaUserV0Transaction(web3, {
    payer: fixture.payer,
    recentBlockhash: BLOCKHASH,
    instructions: [fixture.instruction],
  });
  const stats = assertSolanaUserV0Intent(web3, transaction, {
    payer: fixture.payer,
    instructions: [fixture.instruction],
  });

  assert.equal(transaction.version, 0);
  assert.equal(stats.requiredSigners, 1);
  assert.equal(stats.instructionCount, 1);
  assert.ok(stats.serializedBytes <= 1232);
});

test("generic user intent rejects a changed recipient/instruction", () => {
  const fixture = transferFixture();
  const mutated = SystemProgram.transfer({
    fromPubkey: fixture.payer,
    toPubkey: Keypair.generate().publicKey,
    lamports: 12345,
  });
  const transaction = buildSolanaUserV0Transaction(web3, {
    payer: fixture.payer,
    recentBlockhash: BLOCKHASH,
    instructions: [mutated],
  });

  assert.throws(() => assertSolanaUserV0Intent(web3, transaction, {
    payer: fixture.payer,
    instructions: [fixture.instruction],
  }), /instruction 0 changed/i);
});

test("generic user intent rejects an additional signer", () => {
  const fixture = transferFixture();
  const secondSigner = Keypair.generate().publicKey;
  const instruction = new TransactionInstruction({
    programId: Keypair.generate().publicKey,
    keys: [
      { pubkey: fixture.payer, isSigner: true, isWritable: true },
      { pubkey: secondSigner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
  const transaction = buildSolanaUserV0Transaction(web3, {
    payer: fixture.payer,
    recentBlockhash: BLOCKHASH,
    instructions: [instruction],
  });

  assert.throws(() => assertSolanaUserV0Intent(web3, transaction, {
    payer: fixture.payer,
    instructions: [instruction],
  }), /exactly 1 signer/i);
});

test("fresh blockhash compilation preserves exact intent", async () => {
  const fixture = transferFixture();
  const nextBlockhash = Keypair.generate().publicKey.toBase58();
  const result = await compileSolanaUserV0WithLatestBlockhash(web3, {
    getLatestBlockhash: async () => ({ blockhash: nextBlockhash, lastValidBlockHeight: 99 }),
  }, {
    payer: fixture.payer,
    instructions: [fixture.instruction],
  });

  assert.equal(result.latest.blockhash, nextBlockhash);
  assert.equal(result.stats.requiredSigners, 1);
  assert.equal(result.stats.instructionCount, 1);
});
