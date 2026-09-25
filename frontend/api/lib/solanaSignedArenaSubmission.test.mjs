import assert from "node:assert/strict";
import test from "node:test";
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { encodeBase58 } from "../dev-fix/solana-v4-primitives.js";
import { verifySignedArenaSubmission } from "./solanaSignedArenaSubmission.mjs";

const programId = new PublicKey("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");
const data = Buffer.from("deposit-prize-boost-v2-data-with-funding-and-lamports");
const blockhash = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

function signed(payer, { instructions, signer = payer, hash = blockhash } = {}) {
  const ix = new TransactionInstruction({ programId, keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }], data });
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: hash, instructions: instructions || [ix] }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([signer]);
  return tx;
}

function input(tx, wallet, overrides = {}) {
  return {
    transactionBase64: Buffer.from(tx.serialize()).toString("base64"),
    signature: encodeBase58(tx.signatures[0]),
    blockhash,
    wallet: wallet.toBase58(),
    programId: programId.toBase58(),
    dataBase64: data.toString("base64"),
    ...overrides,
  };
}

test("the payer's own signed transaction proves the submission", () => {
  const payer = Keypair.generate();
  assert.deepEqual(verifySignedArenaSubmission(input(signed(payer), payer.publicKey)), { ok: true });
});

test("wallet-added ComputeBudget instructions around ours are accepted", () => {
  const payer = Keypair.generate();
  const ours = new TransactionInstruction({ programId, keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }], data });
  const tx = signed(payer, { instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ours, ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })] });
  assert.equal(verifySignedArenaSubmission(input(tx, payer.publicKey)).ok, true);
});

test("someone else's transaction cannot bind the quote", () => {
  const payer = Keypair.generate();
  const attacker = Keypair.generate();
  assert.equal(verifySignedArenaSubmission(input(signed(attacker), payer.publicKey)).reason, "payer_mismatch");
});

test("a forged signature is refused", () => {
  const payer = Keypair.generate();
  const tx = signed(payer);
  tx.signatures[0] = new Uint8Array(64).fill(7);
  assert.equal(verifySignedArenaSubmission(input(tx, payer.publicKey)).reason, "signature_invalid");
});

test("the claimed signature must be the transaction's", () => {
  const payer = Keypair.generate();
  const other = signed(payer, { hash: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" });
  assert.equal(verifySignedArenaSubmission(input(signed(payer), payer.publicKey, { signature: encodeBase58(other.signatures[0]) })).reason, "signature_mismatch");
});

test("a different amount or funding id (instruction data) is refused", () => {
  const payer = Keypair.generate();
  assert.equal(verifySignedArenaSubmission(input(signed(payer), payer.publicKey, { dataBase64: Buffer.from("other").toString("base64") })).reason, "instruction_mismatch");
});

test("the registered blockhash must be the signed one", () => {
  const payer = Keypair.generate();
  assert.equal(verifySignedArenaSubmission(input(signed(payer), payer.publicKey, { blockhash: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" })).reason, "blockhash_mismatch");
});

test("garbage is refused", () => {
  const payer = Keypair.generate();
  assert.equal(verifySignedArenaSubmission({ ...input(signed(payer), payer.publicKey), transactionBase64: "AAAA" }).ok, false);
});
