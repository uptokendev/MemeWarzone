import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { transform } from "esbuild";

const sourceUrl = new URL("./solanaWalletStandard.ts", import.meta.url);
let source = await readFile(sourceUrl, "utf8");
source = source.replace(
  'import { Transaction, VersionedTransaction } from "@solana/web3.js";',
  `class Transaction {\n  static from(bytes) { return bytes; }\n  serialize() { return new Uint8Array([1]); }\n}\nclass VersionedTransaction {\n  static deserialize(bytes) { return bytes; }\n  serialize() { return new Uint8Array([1]); }\n}`,
);
const compiled = await transform(source, {
  format: "esm",
  loader: "ts",
  target: "es2022",
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`;

class FakeWindow extends EventTarget {}
class DetailEvent extends Event {
  constructor(type, detail) {
    super(type);
    this.detail = detail;
  }
}

globalThis.window = new FakeWindow();

const {
  detectWalletStandardSolanaWallets,
  getWalletStandardRegistry,
} = await import(moduleUrl);

function account(address) {
  return {
    address,
    publicKey: new Uint8Array(32),
    chains: ["solana:mainnet"],
    features: [
      "solana:signMessage",
      "solana:signTransaction",
      "solana:signAndSendTransaction",
    ],
  };
}

test("unknown Solana Wallet Standard wallet works without a brand allowlist", async () => {
  const firstAccount = account("UnknownSolana11111111111111111111111111111111");
  const secondAccount = account("UnknownSolana22222222222222222222222222222222");
  let currentAccounts = [firstAccount];
  let changeListener = null;
  let disconnectCalls = 0;
  const calls = [];

  const wallet = {
    version: "1.0.0",
    name: "Future Solana Wallet X",
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
    chains: ["solana:mainnet"],
    get accounts() {
      return currentAccounts;
    },
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async ({ silent }) => {
          calls.push({ method: "connect", silent });
          return { accounts: currentAccounts };
        },
      },
      "standard:disconnect": {
        version: "1.0.0",
        disconnect: async () => {
          disconnectCalls += 1;
        },
      },
      "standard:events": {
        version: "1.0.0",
        on: (event, listener) => {
          assert.equal(event, "change");
          changeListener = listener;
          return () => {
            changeListener = null;
          };
        },
      },
      "solana:signMessage": {
        version: "1.0.0",
        signMessage: async (...inputs) => {
          calls.push({ method: "signMessage", inputs });
          return inputs.map(() => ({ signature: new Uint8Array([1, 2, 3]) }));
        },
      },
      "solana:signTransaction": {
        version: "1.0.0",
        signTransaction: async (...inputs) => {
          calls.push({ method: "signTransaction", inputs });
          return inputs.map(({ transaction }) => ({ signedTransaction: transaction }));
        },
      },
      "solana:signAndSendTransaction": {
        version: "1.0.0",
        signAndSendTransaction: async (...inputs) => {
          calls.push({ method: "signAndSendTransaction", inputs });
          return inputs.map(() => ({ signature: "5FutureSolanaWalletSignature" }));
        },
      },
    },
  };

  const registry = getWalletStandardRegistry();
  let unregister = null;
  window.dispatchEvent(new DetailEvent("wallet-standard:register-wallet", (api) => {
    unregister = api.register(wallet);
  }));

  assert.equal(registry.get().length, 1);

  const detected = detectWalletStandardSolanaWallets();
  assert.equal(detected.length, 1);
  assert.equal(detected[0].id, "wallet-standard:future-solana-wallet-x");
  assert.equal(detected[0].name, wallet.name);

  const provider = detected[0].provider;
  const connected = await provider.connect();
  assert.equal(connected.publicKey.toString(), firstAccount.address);

  const signedMessage = await provider.signMessage(new Uint8Array([9, 8, 7]));
  assert.deepEqual(Array.from(signedMessage.signature), [1, 2, 3]);

  const signedTransaction = await provider.signTransaction(new Uint8Array([4, 5, 6]));
  assert.deepEqual(Array.from(signedTransaction), [4, 5, 6]);

  const sent = await provider.signAndSendTransaction(new Uint8Array([7, 8, 9]));
  assert.equal(sent.signature, "5FutureSolanaWalletSignature");
  const sendCall = calls.find(({ method }) => method === "signAndSendTransaction");
  assert.equal(sendCall.inputs[0].chain, "solana:mainnet");

  let changedAddress = null;
  provider.on("accountChanged", (publicKey) => {
    changedAddress = publicKey?.toString() || null;
  });
  currentAccounts = [secondAccount];
  changeListener({ accounts: currentAccounts });
  assert.equal(changedAddress, secondAccount.address);
  assert.equal(provider.publicKey.toString(), secondAccount.address);

  await provider.disconnect();
  assert.equal(disconnectCalls, 1);
  assert.equal(provider.isConnected, false);
  assert.equal(provider.publicKey, null);

  assert.equal(typeof unregister, "function");
  unregister();
  assert.equal(registry.get().length, 0);
});
