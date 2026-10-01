import assert from "node:assert/strict";
import test from "node:test";
import { assertWalletOnChain } from "./walletChainGuard.mjs";

const signerOn = (chainId, code = "0x6080") => ({ provider: { getNetwork: async () => ({ chainId: BigInt(chainId) }), getCode: async () => code } });

test("passes when the wallet is on the expected chain and the contract exists there", async () => {
  await assertWalletOnChain(signerOn(4663), 4663, "0xc673B116b4eA8E8923Aad1fa60F0452966F2437F");
});

test("refuses when the wallet is on the other chain (the BNB/Robinhood switch case)", async () => {
  await assert.rejects(assertWalletOnChain(signerOn(56), 4663, "0xc673B116b4eA8E8923Aad1fa60F0452966F2437F"), /wallet is on BNB Chain, but this is on Robinhood Chain/);
});

test("refuses when the target has no contract on the wallet's chain, so no value is sent to an empty address", async () => {
  await assert.rejects(assertWalletOnChain(signerOn(56, "0x"), 56, "0xc673B116b4eA8E8923Aad1fa60F0452966F2437F"), /does not exist on BNB Chain/);
});

test("refuses without a wallet provider", async () => {
  await assert.rejects(assertWalletOnChain({}, 56, null), /Wallet provider is unavailable/);
});
