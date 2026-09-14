import assert from "node:assert/strict";
import test from "node:test";

import {
  AddressLookupTableAccount,
  Ed25519Program,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import * as web3 from "@solana/web3.js";
import { loadSolanaV0Module } from "../../scripts/load-solana-v0-module.mjs";

const {
  assertLaunchpadV0Intent,
  buildLaunchpadV0Transaction,
  inspectLaunchpadV0Envelope,
} = await loadSolanaV0Module();

const PROGRAM_ID = new PublicKey("3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const U64_MAX = (1n << 64n) - 1n;

function makeLookupTable(addresses) {
  return new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: U64_MAX,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: Keypair.generate().publicKey,
      addresses,
    },
  });
}

function makeFixture() {
  const payer = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const [ata] = PublicKey.findProgramAddressSync(
    [payer.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  );
  const ataInstruction = new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Uint8Array.from([1]),
  });
  const ed25519Instruction = Ed25519Program.createInstructionWithPublicKey({
    publicKey: Keypair.generate().publicKey.toBytes(),
    message: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    signature: Uint8Array.from({ length: 64 }, (_, index) => (index + 11) & 0xff),
  });
  const tradeInstruction = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      ...Array.from({ length: 13 }, (_, index) => ({
        pubkey: Keypair.generate().publicKey,
        isSigner: false,
        isWritable: index >= 5,
      })),
    ],
    data: Buffer.alloc(73, 0x31),
  });
  const lookupTable = makeLookupTable([
    ASSOCIATED_TOKEN_PROGRAM,
    TOKEN_PROGRAM,
    web3.SystemProgram.programId,
    ...tradeInstruction.keys.filter((key) => !key.isSigner).slice(0, 8).map((key) => key.pubkey),
  ]);
  return { payer, ataInstruction, ed25519Instruction, tradeInstruction, lookupTable };
}

test("first BUY may prefix idempotent ATA creation while preserving Ed25519 -> trade adjacency", () => {
  const fixture = makeFixture();
  const transaction = buildLaunchpadV0Transaction(web3, {
    payer: fixture.payer,
    recentBlockhash: BLOCKHASH,
    instructions: [fixture.ataInstruction, fixture.ed25519Instruction, fixture.tradeInstruction],
    lookupTableAccounts: [fixture.lookupTable],
  });

  assert.doesNotThrow(() => assertLaunchpadV0Intent(web3, transaction, {
    payer: fixture.payer,
    ed25519Instruction: fixture.ed25519Instruction,
    programInstruction: fixture.tradeInstruction,
    lookupTableAccounts: [fixture.lookupTable],
    releaseMaxBytes: null,
  }));
  const stats = inspectLaunchpadV0Envelope(web3, transaction, [fixture.lookupTable]);
  assert.equal(stats.requiredSigners, 1);
  assert.equal(stats.instructionCount, 3);
  assert.ok(stats.serializedBytes <= 1232);
});

test("ATA creation inserted between Ed25519 and trade is rejected", () => {
  const fixture = makeFixture();
  const transaction = buildLaunchpadV0Transaction(web3, {
    payer: fixture.payer,
    recentBlockhash: BLOCKHASH,
    instructions: [fixture.ed25519Instruction, fixture.ataInstruction, fixture.tradeInstruction],
    lookupTableAccounts: [fixture.lookupTable],
  });

  assert.throws(() => assertLaunchpadV0Intent(web3, transaction, {
    payer: fixture.payer,
    ed25519Instruction: fixture.ed25519Instruction,
    programInstruction: fixture.tradeInstruction,
    lookupTableAccounts: [fixture.lookupTable],
    releaseMaxBytes: null,
  }), /immediately before MemeWarzone/i);
});
