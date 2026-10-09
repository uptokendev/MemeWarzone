import assert from "node:assert/strict";
import test from "node:test";
import bs58 from "bs58";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { JUPITER_PROGRAM, evmFingerprint, solanaFingerprintFromBuilt, solanaFingerprintFromLanded } from "./importSwapFingerprint.js";

const encode58 = (bs58.default || bs58).encode;

test("Solana: the built swap and the landed swap give the same fingerprint, whatever the wallet adds around it", () => {
  const wallet = Keypair.generate().publicKey;
  const data = Buffer.from([229, 23, 203, 151, 122, 227, 173, 42, 9, 9, 7, 1, 2, 3]);
  const jup = new TransactionInstruction({ programId: new PublicKey(JUPITER_PROGRAM), keys: [{ pubkey: wallet, isSigner: true, isWritable: true }], data });
  const message = new TransactionMessage({ payerKey: wallet, recentBlockhash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", instructions: [jup] }).compileToV0Message();
  const built = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
  const fromBuilt = solanaFingerprintFromBuilt(built, wallet.toBase58());
  // As landed: the wallet put a compute-budget and a Lighthouse instruction before and after ours.
  const landed = { transaction: { message: { instructions: [
    { programId: "ComputeBudget111111111111111111111111111111", data: "3gJqkocMWaMm" },
    { programId: JUPITER_PROGRAM, data: encode58(data) },
    { programId: "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95", data: "4ytJ" },
  ] } } };
  assert.ok(fromBuilt?.startsWith("sol:"));
  assert.equal(solanaFingerprintFromLanded(landed, wallet.toBase58()), fromBuilt);
  assert.notEqual(solanaFingerprintFromLanded(landed, Keypair.generate().publicKey.toBase58()), fromBuilt, "another wallet, another fingerprint");
  assert.equal(solanaFingerprintFromLanded({ transaction: { message: { instructions: [] } } }, wallet.toBase58()), null);
});

test("EVM: to, data and value, case-insensitive on hex; any change is another fingerprint", () => {
  const a = evmFingerprint("0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", "0xABCDEF", "1000");
  assert.equal(a, evmFingerprint("0x6131b5fae19ea4f9d964eac0408e4408b66337b5", "0xabcdef", 1000n));
  assert.notEqual(a, evmFingerprint("0x6131b5fae19ea4f9d964eac0408e4408b66337b5", "0xabcdee", "1000"));
  assert.notEqual(a, evmFingerprint("0x6131b5fae19ea4f9d964eac0408e4408b66337b5", "0xabcdef", "1001"));
  assert.ok(a.startsWith("evm:"));
  assert.equal(evmFingerprint(null, "0x", "0"), null);
});
