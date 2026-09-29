import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { readOwnerMintBalanceRaw, readQuoteUiMultiplier } from "./dbcQuoteMultiplier.mjs";
import { WSOL_MINT, formatScaledQuote, quoteRawToUi, quoteUiToRaw } from "../../shared/dbcQuotes.mjs";

test("displayed stock amounts convert through the multiplier, rounding the raw amount down", () => {
  assert.equal(quoteUiToRaw("1.5", 8, 1.0017), 149_745_432n);
  assert.equal(quoteUiToRaw("12.34", 6), 12_340_000n);
  assert.equal(quoteUiToRaw("", 6), 0n);
  assert.equal(quoteUiToRaw("1e3", 6), 0n);
  assert.ok(Math.abs(quoteRawToUi(149_745_432n, 8, 1.0017) - 1.5) < 1e-7);
  assert.equal(formatScaledQuote(1.50001), "1.5000");
  assert.equal(formatScaledQuote(0.000012346), "0.00001235");
});

test("SOL and classic mints read multiplier 1 without a Token-2022 account", async () => {
  assert.equal(await readQuoteUiMultiplier({}, WSOL_MINT), 1);
  const classic = { async getAccountInfo() { return { owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), data: Buffer.alloc(82) }; } };
  assert.equal(await readQuoteUiMultiplier(classic, Keypair.generate().publicKey.toBase58()), 1);
});

test("owner balance sums every account for the mint, reading amount at offset 64", async () => {
  const acct = (amount) => {
    const data = Buffer.alloc(165);
    data.writeBigUInt64LE(amount, 64);
    return { account: { data: new Uint8Array(data) } };
  };
  const connection = { async getTokenAccountsByOwner() { return { value: [acct(5n), acct(7n)] }; } };
  const k = () => Keypair.generate().publicKey.toBase58();
  assert.equal(await readOwnerMintBalanceRaw(connection, k(), k()), 12n);
});
