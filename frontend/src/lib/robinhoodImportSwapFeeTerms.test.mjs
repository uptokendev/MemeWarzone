// CO-IMP rev 2 CI3: the Robinhood import swap's fee rate and receiver come from one place and move
// together: 1% to the ImportFeeVault only while the receiver IS that vault, else the old 0.5%.
import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder } from "ethers";

import {
  IMPORT_SWAP_FEE_BPS,
  IMPORT_SWAP_FEE_RECEIVER_4663,
  UNIVERSAL_ROUTER_4663,
  activeImportSwapFeeTerms4663,
  encodeImportBuy,
  encodeImportSell,
  executeImportSwap4663,
  importSwapFeeTerms4663,
  importSwapGasLimit,
} from "./robinhoodImportSwap.mjs";

const coder = AbiCoder.defaultAbiCoder();
const TOKEN = "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C";
const VAULT = "0x00000000000000000000000000000000000000aA";
const VAULT_CHECKSUM = "0x00000000000000000000000000000000000000AA";
const PAY = ["address", "address", "uint256"];

test("terms: off by default, off on a mismatch, on (1%, creator half) when the receiver is the vault", () => {
  const off = { feeBps: 50, feeReceiver: IMPORT_SWAP_FEE_RECEIVER_4663, creatorShareBps: 0, split: false };
  assert.equal(IMPORT_SWAP_FEE_BPS, 50);
  assert.deepEqual(importSwapFeeTerms4663({}), off);
  assert.deepEqual(importSwapFeeTerms4663({ VITE_IMPORT_FEE_VAULT_4663: VAULT }), off, "vault alone");
  assert.deepEqual(importSwapFeeTerms4663({ VITE_IMPORT_SWAP_FEE_RECEIVER_4663: VAULT }), off, "receiver alone");
  assert.deepEqual(importSwapFeeTerms4663({ VITE_IMPORT_FEE_VAULT_4663: VAULT, VITE_IMPORT_SWAP_FEE_RECEIVER_4663: IMPORT_SWAP_FEE_RECEIVER_4663 }), off, "mismatch");
  assert.deepEqual(importSwapFeeTerms4663({ VITE_IMPORT_FEE_VAULT_4663: "nope", VITE_IMPORT_SWAP_FEE_RECEIVER_4663: "nope" }), off, "not an address");
  const on = { feeBps: 100, feeReceiver: VAULT_CHECKSUM, creatorShareBps: 50, split: true };
  assert.deepEqual(importSwapFeeTerms4663({ VITE_IMPORT_FEE_VAULT_4663: VAULT, VITE_IMPORT_SWAP_FEE_RECEIVER_4663: VAULT.toUpperCase().replace("0X", "0x") }), on, "app (VITE_), case-insensitive");
  assert.deepEqual(importSwapFeeTerms4663({ IMPORT_FEE_VAULT_4663: VAULT, IMPORT_SWAP_FEE_RECEIVER_4663: VAULT }), on, "Node names (rehearsal)");
  assert.equal(importSwapFeeTerms4663({ IMPORT_FEE_VAULT_4663: VAULT, IMPORT_SWAP_FEE_RECEIVER_4663: VAULT, IMPORT_SWAP_FEE_BPS_4663: "999" }).feeBps, 200, "capped at 2%");
  assert.equal(importSwapFeeTerms4663({ IMPORT_SWAP_FEE_BPS_4663: "100" }).feeBps, 50, "a rate alone never moves the fee");
});

test("encode: the active terms by default; explicit terms need both rate and receiver", () => {
  const buy = encodeImportBuy({ token: TOKEN, fee: 500, amountInWei: 10n ** 16n, minTokensOut: 1n });
  assert.deepEqual(coder.decode(PAY, buy.inputs[0]).map(String), ["0x0000000000000000000000000000000000000000", IMPORT_SWAP_FEE_RECEIVER_4663, "50"]);
  const explicit = encodeImportBuy({ token: TOKEN, fee: 500, amountInWei: 10n ** 16n, minTokensOut: 1n, feeReceiver: VAULT_CHECKSUM, feeBps: 100 });
  assert.deepEqual(coder.decode(PAY, explicit.inputs[0]).map(String), ["0x0000000000000000000000000000000000000000", VAULT_CHECKSUM, "100"]);
  assert.equal(explicit.commands, buy.commands, "command list unchanged");
  assert.deepEqual(explicit.inputs.slice(1), buy.inputs.slice(1), "only the PAY_PORTION input differs");
  assert.throws(() => encodeImportBuy({ token: TOKEN, fee: 500, amountInWei: 1n, minTokensOut: 1n, feeReceiver: VAULT_CHECKSUM }), /together/);
  assert.throws(() => encodeImportSell({ token: TOKEN, fee: 500, amountIn: 1n, minGrossEthOut: 1n, feeBps: 100 }), /together/);
});

test("switch on in the env: encode and sell minimum use 1% to the vault", () => {
  process.env.IMPORT_FEE_VAULT_4663 = VAULT;
  process.env.IMPORT_SWAP_FEE_RECEIVER_4663 = VAULT;
  try {
    assert.equal(activeImportSwapFeeTerms4663().feeBps, 100);
    const sell = encodeImportSell({ token: TOKEN, fee: 500, amountIn: 5n, minGrossEthOut: 10_000n });
    assert.equal(sell.commands, "0x000c0604");
    assert.deepEqual(coder.decode(PAY, sell.inputs[2]).map(String), ["0x0000000000000000000000000000000000000000", VAULT_CHECKSUM, "100"]);
    assert.equal(sell.minNetEthOut, 9_900n, "SWEEP minimum after the 1% fee");
    assert.equal(coder.decode(PAY, sell.inputs[3])[2], 9_900n);
  } finally {
    delete process.env.IMPORT_FEE_VAULT_4663;
    delete process.env.IMPORT_SWAP_FEE_RECEIVER_4663;
  }
  assert.equal(activeImportSwapFeeTerms4663().feeBps, 50);
});

test("execute: signs the quote's terms with gas = estimate + 20%", async () => {
  assert.equal(importSwapGasLimit(100_000n), 120_000n);
  let sent = null;
  const signer = {
    provider: null,
    async getAddress() { return "0x1111111111111111111111111111111111111111"; },
    async estimateGas(tx) { assert.equal(tx.to, UNIVERSAL_ROUTER_4663); return 250_000n; },
    async sendTransaction(tx) { sent = tx; throw new Error("stop after capture"); },
  };
  const quote = { side: "buy", route: { fee: 10000 }, amountIn: 10n ** 16n, minOut: 7n, feeBps: 100, feeReceiver: VAULT };
  await assert.rejects(executeImportSwap4663({ signer, quote, token: TOKEN }), /stop after capture/);
  assert.equal(BigInt(sent.gasLimit), 300_000n);
  assert.equal(BigInt(sent.value), 10n ** 16n);
  const [, inputs] = coder.decode(["bytes", "bytes[]", "uint256"], "0x" + sent.data.slice(10));
  assert.deepEqual(coder.decode(PAY, inputs[0]).map(String), ["0x0000000000000000000000000000000000000000", VAULT_CHECKSUM, "100"], "the quote's terms, not the (off) env");
});
