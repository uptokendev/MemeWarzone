import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID as SPL_TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@127.0.0.1:5432/test";

const { deriveAta, TOKEN_2022_PROGRAM_ID } = await import("./solana-graduation-authorization-v2.js");

const OWNER = "HuKfoFUuWxC5qFZXzr5dbaX4S7w4vJUW8AHV9LD4C2J9";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // devnet USDC

test("the classic derivation matches @solana/spl-token", () => {
  const canonical = getAssociatedTokenAddressSync(
    new PublicKey(MINT), new PublicKey(OWNER), false, SPL_TOKEN_PROGRAM_ID,
  ).toBase58();
  assert.equal(deriveAta(OWNER, MINT), canonical);
});

test("the Token-2022 derivation matches @solana/spl-token", () => {
  // Regression: the token program is one of the ATA seeds, and this helper
  // hardcoded the classic one. A Token-2022 quote therefore had its balance
  // read from, and its residual swept to, an address that is not its account.
  const canonical = getAssociatedTokenAddressSync(
    new PublicKey(MINT), new PublicKey(OWNER), false, SPL_TOKEN_2022_PROGRAM_ID,
  ).toBase58();
  assert.equal(deriveAta(OWNER, MINT, TOKEN_2022_PROGRAM_ID), canonical);
});

test("the two programs derive different addresses for the same owner and mint", () => {
  assert.notEqual(deriveAta(OWNER, MINT), deriveAta(OWNER, MINT, TOKEN_2022_PROGRAM_ID));
});

test("the exported Token-2022 id is the real one", () => {
  assert.equal(TOKEN_2022_PROGRAM_ID, SPL_TOKEN_2022_PROGRAM_ID.toBase58());
});

test("omitting the program keeps the classic behaviour callers already had", () => {
  assert.equal(deriveAta(OWNER, MINT), deriveAta(OWNER, MINT, SPL_TOKEN_PROGRAM_ID.toBase58()));
});
