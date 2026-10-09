// With none of the new env set, BNB and Robinhood trade exactly as before the ImportFeeVault split:
// 0.5% to the ProtocolRevenueVault, no creator share, graduated coins on their direct pool trade, no fee router,
// and the finance flow text unchanged. Every switch below is env-driven; this pins the "nothing set" state.
import assert from "node:assert/strict";
import test from "node:test";

import { IMPORT_SWAP_FEE_BPS, IMPORT_SWAP_FEE_RECEIVER_4663, encodeImportBuy, importSwapFeeTerms4663 } from "./robinhoodImportSwap.mjs";
import { graduatedEvmTradeRoute, graduatedImportRouteEnabled } from "./graduatedEvmTradeRoute.mjs";
import { importSwapFeeRouterAddress } from "./importSwapFeeRouter.mjs";
import { importSwapFeeBps } from "../../api/importSwap.js";
import { evmFeeRoutingRegistry } from "../../api/lib/financeFeeRoutingEvm.js";

const NEW_ENV = [
  "IMPORT_FEE_VAULT_56", "IMPORT_SWAP_FEE_RECEIVER_56", "IMPORT_SWAP_FEE_BPS_56", "VITE_IMPORT_FEE_VAULT_56",
  "IMPORT_FEE_VAULT_4663", "IMPORT_SWAP_FEE_RECEIVER_4663", "IMPORT_SWAP_FEE_BPS_4663",
  "VITE_IMPORT_FEE_VAULT_4663", "VITE_IMPORT_SWAP_FEE_RECEIVER_4663", "VITE_IMPORT_SWAP_FEE_BPS_4663",
  "VITE_IMPORT_SWAP_FEE_ROUTER_56", "VITE_IMPORT_SWAP_FEE_ROUTER_97", "IMPORT_SWAP_FEE_ROUTER_56", "IMPORT_SWAP_FEE_ROUTER_97",
];
for (const key of NEW_ENV) delete process.env[key];

test("Robinhood 4663, nothing set: 0.5% to the ProtocolRevenueVault 0x632061cA, no creator share", () => {
  assert.equal(IMPORT_SWAP_FEE_BPS, 50);
  const expected = { feeBps: 50, feeReceiver: "0x632061cA786f7B585Bbd46A792FDA92B02f70671", creatorShareBps: 0, split: false };
  assert.deepEqual(importSwapFeeTerms4663({}), expected);
  assert.deepEqual(importSwapFeeTerms4663(process.env), expected, "the process env without the new names");
  assert.equal(IMPORT_SWAP_FEE_RECEIVER_4663, expected.feeReceiver);
  // The encoded PAY_PORTION carries exactly those terms when the caller passes none (the active terms).
  const call = encodeImportBuy({ token: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", fee: 3000, amountInWei: 10n ** 16n, minTokensOut: 1n });
  const pay = call.inputs[0].toLowerCase();
  assert.ok(pay.includes(expected.feeReceiver.slice(2).toLowerCase()), "fee receiver = ProtocolRevenueVault");
  assert.ok(pay.endsWith((50).toString(16).padStart(64, "0")), "50 bps");
});

test("BNB 56, nothing set: 0.5% (the Kyber fee to the old receiver)", () => {
  assert.equal(importSwapFeeBps(56, {}), 50);
  assert.equal(importSwapFeeBps(56, process.env), 50);
});

test("nothing set: graduated coins keep the direct pool trade, no fee router anywhere", () => {
  for (const chainId of [56, 97, 4663, 46630]) {
    assert.equal(graduatedImportRouteEnabled(chainId, {}), false, `chain ${chainId}`);
    assert.equal(graduatedEvmTradeRoute({ chainId, graduated: true }, {}), "direct-pool", `chain ${chainId}`);
    assert.equal(graduatedEvmTradeRoute({ chainId, graduated: false }, {}), "bonding", `chain ${chainId}`);
    assert.equal(importSwapFeeRouterAddress(chainId, {}), null, `chain ${chainId}`);
  }
});

test("nothing set: the finance import flow still reads 0.5% to the ProtocolRevenueVault", () => {
  for (const chainId of [56, 4663]) {
    const flow = evmFeeRoutingRegistry(chainId, {}).flows.find((f) => f.id === "evm_import_swaps");
    assert.match(flow.totalFee, /^0\.5%/);
    assert.deepEqual(flow, evmFeeRoutingRegistry(chainId).flows.find((f) => f.id === "evm_import_swaps"));
  }
});
