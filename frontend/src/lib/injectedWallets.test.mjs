import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { transform } from "esbuild";

const sourceUrl = new URL("./injectedWallets.ts", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const compiled = await transform(source, {
  format: "esm",
  loader: "ts",
  target: "es2022",
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`;
const {
  createDetectedEvmWallet,
  discoverInjectedWallets,
  getEvmWalletCapabilities,
  getInjectedProvider,
  requestEvmAccounts,
  sendEvmTransaction,
  signEvmMessage,
  switchEvmWalletChain,
} = await import(moduleUrl);

class FakeWindow extends EventTarget {
  ethereum;

  setTimeout(callback, delay) {
    return globalThis.setTimeout(callback, delay);
  }

  clearTimeout(timer) {
    globalThis.clearTimeout(timer);
  }
}

class ProviderAnnouncement extends Event {
  constructor(detail) {
    super("eip6963:announceProvider");
    this.detail = detail;
  }
}

function createUnknownProvider({ rejectUnknownChainOnce = false } = {}) {
  const calls = [];
  let rejected = false;
  const listeners = new Map();
  const provider = {
    calls,
    on(event, listener) {
      listeners.set(event, listener);
    },
    removeListener(event) {
      listeners.delete(event);
    },
    async request({ method, params }) {
      calls.push({ method, params });
      if (method === "eth_requestAccounts") {
        return ["0x1111111111111111111111111111111111111111"];
      }
      if (method === "personal_sign") return "0xsigned";
      if (method === "eth_sendTransaction") return "0xtransaction";
      if (method === "wallet_switchEthereumChain" && rejectUnknownChainOnce && !rejected) {
        rejected = true;
        const error = new Error("unknown chain");
        error.code = 4902;
        throw error;
      }
      return null;
    },
  };
  return provider;
}

const UNKNOWN_INFO = {
  uuid: "0fbe66d1-c220-4fb2-b585-4057ef050d6a",
  name: "Future Wallet X",
  icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
  rdns: "xyz.future.wallet",
};

test("unknown EIP-6963 wallet identity is accepted without a brand enum", () => {
  const provider = createUnknownProvider();
  const wallet = createDetectedEvmWallet(provider, "eip6963", UNKNOWN_INFO);

  assert.equal(wallet.id, UNKNOWN_INFO.uuid);
  assert.equal(wallet.uuid, UNKNOWN_INFO.uuid);
  assert.equal(wallet.name, "Future Wallet X");
  assert.equal(wallet.rdns, "xyz.future.wallet");
  assert.equal(wallet.provider, provider);
});

test("EIP-6963 wins while legacy window.ethereum remains a generic fallback", async () => {
  const windowObject = new FakeWindow();
  const announcedProvider = createUnknownProvider();
  const legacyProvider = createUnknownProvider();
  legacyProvider.name = "Legacy Unknown Wallet";
  legacyProvider.rdns = "legacy.wallet.example";
  windowObject.ethereum = legacyProvider;

  globalThis.setTimeout(() => {
    windowObject.dispatchEvent(
      new ProviderAnnouncement({ info: UNKNOWN_INFO, provider: announcedProvider }),
    );
  }, 0);

  const wallets = await discoverInjectedWallets({ timeoutMs: 10, windowObject });

  assert.equal(wallets[0].source, "eip6963");
  assert.equal(wallets[0].id, UNKNOWN_INFO.uuid);
  assert.ok(wallets.some((wallet) => wallet.provider === legacyProvider));
});

test("generic provider lookup resolves unknown wallet by UUID", async () => {
  const windowObject = new FakeWindow();
  const provider = createUnknownProvider();

  globalThis.setTimeout(() => {
    windowObject.dispatchEvent(new ProviderAnnouncement({ info: UNKNOWN_INFO, provider }));
  }, 0);

  const selected = await getInjectedProvider(UNKNOWN_INFO.uuid, {
    timeoutMs: 10,
    windowObject,
  });
  assert.equal(selected, provider);
});

test("unknown wallet supports accounts, signing, transactions, events and both EVM chain ids", async () => {
  const provider = createUnknownProvider();
  const capabilities = getEvmWalletCapabilities(provider);

  assert.deepEqual(capabilities, {
    accounts: true,
    signMessage: true,
    sendTransaction: true,
    switchChain: true,
    providerEvents: true,
  });

  const accounts = await requestEvmAccounts(provider);
  assert.deepEqual(accounts, ["0x1111111111111111111111111111111111111111"]);

  assert.equal(
    await signEvmMessage(provider, accounts[0], "0x68656c6c6f"),
    "0xsigned",
  );
  assert.equal(
    await sendEvmTransaction(provider, { from: accounts[0], to: accounts[0], value: "0x0" }),
    "0xtransaction",
  );

  await switchEvmWalletChain(provider, 56);
  await switchEvmWalletChain(provider, 4663);

  const switchCalls = provider.calls.filter(
    ({ method }) => method === "wallet_switchEthereumChain",
  );
  assert.deepEqual(
    switchCalls.map(({ params }) => params[0].chainId),
    ["0x38", "0x1237"],
  );
});

test("generic chain switch adds an unknown chain after EIP-4902", async () => {
  const provider = createUnknownProvider({ rejectUnknownChainOnce: true });
  const params = {
    chainId: "0x1237",
    chainName: "Robinhood Chain",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://example.invalid"],
    blockExplorerUrls: ["https://explorer.example.invalid"],
  };

  await switchEvmWalletChain(provider, 4663, params);

  assert.deepEqual(
    provider.calls.map(({ method }) => method),
    [
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
      "wallet_switchEthereumChain",
    ],
  );
});
