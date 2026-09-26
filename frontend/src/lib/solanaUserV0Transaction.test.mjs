import assert from "node:assert/strict";
import test from "node:test";

import { Keypair, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import * as web3 from "@solana/web3.js";
import { loadSolanaUserV0Module } from "../../scripts/load-solana-v0-module.mjs";

const {
  assertSolanaUserV0Intent,
  buildSolanaUserV0Transaction,
  compileSolanaUserV0WithLatestBlockhash,
  SOLANA_WALLET_REWRITE_BUDGET_BYTES,
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

function walletSafetyInstruction(payer) {
  return new TransactionInstruction({
    programId: Keypair.generate().publicKey,
    keys: [{ pubkey: payer, isSigner: true, isWritable: false }],
    data: Buffer.from([9, 9, 9]),
  });
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

test("wallet augmentation may wrap the unchanged expected V0 instruction sequence", () => {
  const fixture = transferFixture();
  const before = walletSafetyInstruction(fixture.payer);
  const after = walletSafetyInstruction(fixture.payer);
  const transaction = buildSolanaUserV0Transaction(web3, {
    payer: fixture.payer,
    recentBlockhash: BLOCKHASH,
    instructions: [before, fixture.instruction, after],
  });

  const stats = assertSolanaUserV0Intent(web3, transaction, {
    payer: fixture.payer,
    instructions: [fixture.instruction],
    allowAdditionalInstructions: true,
  });
  assert.equal(stats.requiredSigners, 1);
  assert.equal(stats.instructionCount, 3);
});

test("wallet augmentation cannot mutate or split the expected V0 instruction sequence", () => {
  const fixture = transferFixture();
  const memoLike = new TransactionInstruction({
    programId: Keypair.generate().publicKey,
    keys: [{ pubkey: fixture.payer, isSigner: true, isWritable: false }],
    data: Buffer.from([7]),
  });
  const secondExpected = new TransactionInstruction({
    programId: Keypair.generate().publicKey,
    keys: [{ pubkey: fixture.payer, isSigner: true, isWritable: false }],
    data: Buffer.from([8]),
  });
  const transaction = buildSolanaUserV0Transaction(web3, {
    payer: fixture.payer,
    recentBlockhash: BLOCKHASH,
    instructions: [fixture.instruction, memoLike, secondExpected],
  });

  assert.throws(() => assertSolanaUserV0Intent(web3, transaction, {
    payer: fixture.payer,
    instructions: [fixture.instruction, secondExpected],
    allowAdditionalInstructions: true,
  }), /expected instruction sequence changed/i);
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
test("a transaction that leaves the wallet too little room is refused", () => {
  // The failure this prevents is not a rejected transaction. Phantom silently
  // stops simulating and shows "this dApp could be malicious", which looks like
  // a domain reputation problem and sends you hunting in the wrong place. A
  // size error names the actual cause.
  const payer = Keypair.generate().publicKey;
  const budget = SOLANA_WALLET_REWRITE_BUDGET_BYTES;

  const build = (dataBytes) => {
    const instruction = new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [{ pubkey: payer, isSigner: true, isWritable: true }],
      data: Buffer.alloc(dataBytes),
    });
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: BLOCKHASH,
      instructions: [instruction],
    }).compileToV0Message();
    return { transaction: new VersionedTransaction(message), instruction };
  };

  // Comfortably small: passes, and reports how much room the wallet has left.
  const small = build(64);
  const stats = assertSolanaUserV0Intent(web3, small.transaction, {
    payer,
    instructions: [small.instruction],
    walletRewriteBudgetBytes: budget,
  });
  assert.ok(stats.walletHeadroomBytes > budget);
  assert.equal(stats.walletHeadroomBytes, 1232 - stats.serializedBytes);

  // Sized to eat into the wallet's share: must be refused.
  const oversized = build(1232 - budget);
  assert.throws(
    () => assertSolanaUserV0Intent(web3, oversized.transaction, {
      payer,
      instructions: [oversized.instruction],
      walletRewriteBudgetBytes: budget,
    }),
    /leaving \d+ for the wallet; it needs 257/,
  );

  // Without the budget the same transaction is allowed, because the Meteora
  // SDK builds swap instructions whose account count is not ours to bound.
  assert.doesNotThrow(() =>
    assertSolanaUserV0Intent(web3, oversized.transaction, {
      payer,
      instructions: [oversized.instruction],
    }),
  );
});

// League rewards are claimed with a Merkle proof inlined in the instruction
// data, 32 bytes per level, and nothing in the encoder bounds its depth. This
// pins where that runs out of room so the limit is a known number rather than
// something discovered when a season gets big enough.
test("a league claim fits a Merkle proof up to 17 levels", () => {
  const budget = SOLANA_WALLET_REWRITE_BUDGET_BYTES;
  const payer = Keypair.generate().publicKey;
  const key = () => Keypair.generate().publicKey;

  // 8 discriminator + 1 period + 8 epoch + 32 category + 1 rank + 8 amount + 4 length
  const FIXED = 62;

  const sizeAtDepth = (depth) => {
    const instruction = new TransactionInstruction({
      programId: key(),
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: key(), isSigner: false, isWritable: false },
        { pubkey: key(), isSigner: false, isWritable: true },
        { pubkey: key(), isSigner: false, isWritable: true },
        { pubkey: key(), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.alloc(FIXED + 32 * depth),
    });
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: BLOCKHASH,
      instructions: [instruction],
    }).compileToV0Message();
    return new VersionedTransaction(message).serialize().length;
  };

  assert.ok(1232 - sizeAtDepth(17) >= budget, "depth 17 must still fit");
  assert.ok(1232 - sizeAtDepth(18) < budget, "depth 18 must not fit");

  // 17 levels is 131,072 leaves. If a season can exceed that the proof has to
  // move out of the instruction data, not just be allowed to grow.
  assert.equal(2 ** 17, 131072);
});

// The launchpad module cannot import this one: its test harness loads it from a
// data URL where "@/..." does not resolve, so the budget is defined in both.
// Two copies of a measured constant drift, and the drift would only show up as
// Phantom blocking one flow and not the other.
test("the wallet rewrite budget is the same on both sides", async () => {
  const { loadSolanaV0Module } = await import("../../scripts/load-solana-v0-module.mjs");
  const launchpad = await loadSolanaV0Module();
  assert.equal(
    launchpad.SOLANA_WALLET_REWRITE_BUDGET_BYTES,
    SOLANA_WALLET_REWRITE_BUDGET_BYTES,
    "solanaV0Transaction.ts and solanaUserV0Transaction.ts disagree on the wallet budget",
  );
});

test("UP Vote shape (memo signed by the fee payer + transfer) passes the pre-sign check", () => {
  // Regression 2026-09-26: the memo declared the voter read-only while the fee payer always compiles
  // writable, so every Solana UP Vote failed with "instruction 0 changed" before the wallet opened.
  const { payer, instruction: transfer } = transferFixture();
  const memo = (isWritable) => new TransactionInstruction({
    keys: [{ pubkey: payer, isSigner: true, isWritable }],
    programId: new web3.PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
    data: Buffer.from("mwz-upvote:campaign", "utf8"),
  });
  const build = (instructions) => buildSolanaUserV0Transaction(web3, { payer, recentBlockhash: BLOCKHASH, instructions });
  const fixed = [memo(true), transfer];
  assert.doesNotThrow(() => assertSolanaUserV0Intent(web3, build(fixed), { payer, instructions: fixed }));
  const broken = [memo(false), transfer];
  assert.throws(() => assertSolanaUserV0Intent(web3, build(broken), { payer, instructions: broken }), /instruction 0 changed/);
});

test("the live UP Vote builder declares its memo signer writable", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("./solanaUpvoteV0.ts", import.meta.url), "utf8");
  assert.match(source, /keys: \[\{ pubkey: from, isSigner: true, isWritable: true \}\]/);
});
