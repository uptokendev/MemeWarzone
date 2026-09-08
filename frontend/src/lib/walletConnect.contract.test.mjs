import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("./walletConnect.ts", import.meta.url);
const source = await readFile(sourceUrl, "utf8");

test("WalletConnect is exposed through EIP-6963 instead of a parallel wallet state", () => {
  assert.match(source, /eip6963:announceProvider/);
  assert.match(source, /eip6963:requestProvider/);
  assert.match(source, /provider:\s*placeholderProvider/);
  assert.doesNotMatch(source, /BrowserProvider|JsonRpcSigner/);
});

test("WalletConnect runtime stays lazy until an account request needs a real session", () => {
  assert.match(source, /await import\("@walletconnect\/ethereum-provider"\)/);
  assert.match(source, /args\.method === "eth_requestAccounts"/);
  assert.match(source, /await runtime\.connect/);
  assert.match(source, /showQrModal:\s*true/);
});

test("WalletConnect negotiates only enabled MemeWarzone EVM chains", () => {
  assert.match(source, /getAllowedChainIds\(\)\.filter\(\(chainId\) => isEvmChainId\(chainId\)\)/);
  assert.match(source, /optionalChains/);
  assert.match(source, /wallet_switchEthereumChain/);
  assert.match(source, /wallet_addEthereumChain/);
  assert.match(source, /4663:\s*"https:\/\/rpc\.mainnet\.chain\.robinhood\.com"/);
  assert.match(source, /46630:\s*"https:\/\/rpc\.testnet\.chain\.robinhood\.com"/);
});

test("WalletConnect remains disabled when no public project id is configured", () => {
  assert.match(source, /VITE_WALLETCONNECT_PROJECT_ID/);
  assert.match(source, /!getProjectId\(\)/);
  assert.match(source, /return false/);
});
