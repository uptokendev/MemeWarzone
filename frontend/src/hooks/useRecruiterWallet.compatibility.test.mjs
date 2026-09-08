import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("./useRecruiterWallet.ts", import.meta.url);
const source = await readFile(sourceUrl, "utf8");

test("recruiter EVM auth stays wallet-brand agnostic", () => {
  assert.match(source, /return bnbWallet\.signer\.signMessage\(message\)/);
  assert.doesNotMatch(source, /isMetaMask|isCryptoCom|metamask|cryptocom/i);
});

test("Robinhood keeps the legacy recruiter EVM discriminator while carrying its real chain id", () => {
  assert.match(source, /export type RecruiterWalletChain = "bnb" \| "solana";/);
  assert.match(source, /ROBINHOOD_CHAIN_ID/);
  assert.match(source, /ROBINHOOD_TESTNET_CHAIN_ID/);
  assert.match(source, /chain:\s*"bnb"/);
  assert.match(source, /chainId:\s*actualEvmChainId/);
  assert.match(source, /label:\s*evmRecruiterLabel\(actualEvmChainId\)/);
});

test("recruiter EVM signing rejects address mismatch before signing", () => {
  assert.match(source, /sameAddress\("bnb", bnbAddress, address\)/);
  assert.match(source, /Connected EVM wallet does not match the selected wallet/);
});
