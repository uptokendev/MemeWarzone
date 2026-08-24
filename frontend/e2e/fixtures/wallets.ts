import type { Page } from "@playwright/test";

const METAMASK_ACCOUNT = "0x1111111111111111111111111111111111111111";
const PHANTOM_ACCOUNT = "MWZSoLanaTestWad111111111111111111111";

type InjectOptions = {
  evmChainId?: 56 | 97;
};

function walletBootstrap(kind: "phantom" | "metamask", evmChainId: 56 | 97) {
  return `
(() => {
  const kind = ${JSON.stringify(kind)};
  const evmChainId = ${evmChainId};
  const metamaskAccount = ${JSON.stringify(METAMASK_ACCOUNT)};
  const phantomAccount = ${JSON.stringify(PHANTOM_ACCOUNT)};
  window.__mwzE2e = window.__mwzE2e || { ethSends: [], solanaSigns: [] };

  const storage = window.localStorage;
  storage.removeItem("mwz:wallet:disconnected");
  storage.removeItem("mwz:solana_wallet_disconnected");

  if (kind === "phantom") {
    storage.setItem("mwz:active_wallet_kind", "solana");
    storage.setItem("mwz:selected_feed_chain_id", "101");
    storage.setItem("mwz:last_featured_chain_id", "101");
    storage.setItem("mwz:solana_wallet", phantomAccount);
    storage.setItem("mwz:solana_wallet_name", "Phantom");
    storage.setItem("mwz:solana_wallet_id", "phantom");
    storage.removeItem("mwz:selected_wallet");
  } else {
    storage.setItem("mwz:active_wallet_kind", "bnb");
    storage.setItem("mwz:selected_feed_chain_id", String(evmChainId));
    storage.setItem("mwz:last_featured_chain_id", String(evmChainId));
    storage.setItem("mwz:last_evm_chain_id", String(evmChainId));
    storage.setItem("mwz:token_details_chain_id", String(evmChainId));
    storage.setItem("mwz:selected_wallet", "metamask");
    storage.removeItem("mwz:solana_wallet");
  }

  const hexChainId = "0x" + evmChainId.toString(16);
  const listeners = new Map();
  const emit = (eventName, payload) => {
    for (const fn of listeners.get(eventName) || []) fn(payload);
  };

  if (kind === "metamask") {
    const provider = {
      isMetaMask: true,
      isPhantom: false,
      selectedAddress: metamaskAccount,
      request: async ({ method, params }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [metamaskAccount];
        if (method === "eth_chainId" || method === "net_version") return method === "eth_chainId" ? hexChainId : String(evmChainId);
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
        if (method === "eth_sendTransaction" || method === "personal_sign" || method === "eth_signTypedData_v4") {
          window.__mwzE2e.ethSends.push({ method, params });
          throw new Error("E2E wallet refuses transactions");
        }
        if (method === "eth_getBalance") return "0x0";
        if (method === "eth_call") return "0x";
        if (method === "eth_estimateGas") return "0x5208";
        if (method === "eth_gasPrice") return "0x3b9aca00";
        if (method === "eth_blockNumber") return "0x1";
        if (method === "eth_getCode") return "0x";
        if (method === "eth_getLogs") return [];
        return null;
      },
      on: (eventName, listener) => {
        const list = listeners.get(eventName) || [];
        list.push(listener);
        listeners.set(eventName, list);
      },
      removeListener: (eventName, listener) => {
        const list = (listeners.get(eventName) || []).filter((fn) => fn !== listener);
        listeners.set(eventName, list);
      },
    };
    window.ethereum = provider;
    window.addEventListener("eip6963:requestProvider", () => {
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
        detail: {
          info: { uuid: "mwz-e2e-metamask", name: "MetaMask", icon: "data:image/svg+xml,<svg/>", rdns: "io.metamask" },
          provider,
        },
      }));
    });
  }

  if (kind === "phantom") {
    const publicKey = { toString: () => phantomAccount };
    const solana = {
      isPhantom: true,
      isConnected: true,
      publicKey,
      connect: async () => ({ publicKey }),
      disconnect: async () => {},
      signTransaction: async (transaction) => {
        window.__mwzE2e.solanaSigns.push({ method: "signTransaction", transaction });
        throw new Error("E2E Phantom refuses transactions");
      },
      signAndSendTransaction: async (transaction) => {
        window.__mwzE2e.solanaSigns.push({ method: "signAndSendTransaction", transaction });
        throw new Error("E2E Phantom refuses transactions");
      },
      signMessage: async () => {
        window.__mwzE2e.solanaSigns.push({ method: "signMessage" });
        throw new Error("E2E Phantom refuses transactions");
      },
      on: () => {},
      removeListener: () => {},
    };
    window.solana = solana;
    window.phantom = { solana };
  }
})();
`;
}

export async function injectPhantom(page: Page) {
  await page.addInitScript(walletBootstrap("phantom", 97));
}

export async function injectMetaMask(page: Page, options: InjectOptions = {}) {
  await page.addInitScript(walletBootstrap("metamask", options.evmChainId ?? 97));
}

export async function readWalletActions(page: Page) {
  return page.evaluate(() => (window as { __mwzE2e?: { ethSends: unknown[]; solanaSigns: unknown[] } }).__mwzE2e || { ethSends: [], solanaSigns: [] });
}
