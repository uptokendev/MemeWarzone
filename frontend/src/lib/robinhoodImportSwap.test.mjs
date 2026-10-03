import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder } from "ethers";

import {
  IMPORT_SWAP_FEE_RECEIVER_4663,
  WETH_4663,
  encodeImportBuy,
  encodeImportSell,
  importSwapFee,
  minimumOut,
} from "./robinhoodImportSwap.mjs";

const coder = AbiCoder.defaultAbiCoder();
const TOKEN = "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C";
const ETH = "0x0000000000000000000000000000000000000000";
const SWAP = ["address", "uint256", "uint256", "bytes", "bool", "uint256[]"];

test("fee is 0.5% rounded down; slippage minimum", () => {
  assert.equal(importSwapFee(10_000_000_000_000_000n), 50_000_000_000_000n);
  assert.equal(importSwapFee(199n), 0n);
  assert.equal(minimumOut(10_000n, 100), 9_900n);
});

test("buy: pay 0.5% of the ETH to the vault, wrap the rest, swap WETH -> token to the sender", () => {
  const call = encodeImportBuy({ token: TOKEN, fee: 500, amountInWei: 10n ** 16n, minTokensOut: 123n });
  assert.equal(call.commands, "0x060b00");
  assert.equal(call.value, 10n ** 16n);
  const [feeToken, receiver, bips] = coder.decode(["address", "address", "uint256"], call.inputs[0]);
  assert.equal(feeToken, ETH);
  assert.equal(receiver, IMPORT_SWAP_FEE_RECEIVER_4663);
  assert.equal(bips, 50n);
  const [recipient, amountIn, minOut, path, payerIsUser, hops] = coder.decode(SWAP, call.inputs[2]);
  assert.equal(recipient, "0x0000000000000000000000000000000000000001");
  assert.equal(amountIn, 1n << 255n);
  assert.equal(minOut, 123n);
  assert.equal(path.toLowerCase(), (WETH_4663 + "0001f4" + TOKEN.slice(2)).toLowerCase());
  assert.equal(payerIsUser, false);
  assert.equal(hops.length, 0, "the deployed router decodes a sixth field; it must be present and empty");
});

test("sell: permit, swap to the router, unwrap, pay 0.5%, sweep the rest with the net minimum", () => {
  const permit = {
    permitSingle: { details: { token: TOKEN, amount: 5n, expiration: 9n, nonce: 0n }, spender: "0x8876789976dEcBfCbBbe364623C63652db8C0904", sigDeadline: 9n },
    signature: "0x" + "11".repeat(65),
  };
  const call = encodeImportSell({ token: TOKEN, fee: 500, amountIn: 5n, minGrossEthOut: 10_000n, permit });
  assert.equal(call.commands, "0x0a000c0604");
  assert.equal(call.value, 0n);
  const [recipient, amountIn, minOut, path, payerIsUser, hops] = coder.decode(SWAP, call.inputs[1]);
  assert.equal(recipient, "0x0000000000000000000000000000000000000002");
  assert.equal(amountIn, 5n);
  assert.equal(minOut, 10_000n);
  assert.equal(path.toLowerCase(), (TOKEN + "0001f4" + WETH_4663.slice(2)).toLowerCase());
  assert.equal(payerIsUser, true);
  assert.equal(hops.length, 0);
  const [, feeReceiver, bips] = coder.decode(["address", "address", "uint256"], call.inputs[3]);
  assert.equal(feeReceiver, IMPORT_SWAP_FEE_RECEIVER_4663);
  assert.equal(bips, 50n);
  const [sweepToken, sweepTo, sweepMin] = coder.decode(["address", "address", "uint256"], call.inputs[4]);
  assert.equal(sweepToken, ETH);
  assert.equal(sweepTo, "0x0000000000000000000000000000000000000001");
  assert.equal(sweepMin, 9_950n);
  assert.equal(call.minNetEthOut, 9_950n);
});
