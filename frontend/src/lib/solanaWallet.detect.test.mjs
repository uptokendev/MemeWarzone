import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { transform } from "esbuild";

const sourceUrl = new URL("./solanaWallet.ts", import.meta.url);
let source = await readFile(sourceUrl, "utf8");
source = source
  .replace('import type { DraftActionAuth, DraftAuthAction } from "@/lib/draftAuth";\n', "")
  .replace('import { apiFetch } from "@/lib/apiBase";\n', "const apiFetch = async () => ({});\n");

const compiled = await transform(source, {
  format: "esm",
  loader: "ts",
  target: "es2022",
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`;
const { detectSolanaWallets, connectSolanaWallet } = await import(moduleUrl);

function memoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(String(key), String(value));
    },
    removeItem: (key) => {
      store.delete(String(key));
    },
  };
}

function connectable(label) {
  return {
    label,
    connect: async () => ({ publicKey: { toString: () => label } }),
  };
}

test("detectSolanaWallets uses window.solana Phantom first (main behavior)", () => {
  const windowSolana = Object.assign(connectable("window-solana"), { isPhantom: true });
  const phantomSolana = connectable("phantom-solana");
  const solflare = connectable("solflare");

  globalThis.window = {
    solana: windowSolana,
    phantom: { solana: phantomSolana },
    solflare,
  };

  const detected = detectSolanaWallets();
  assert.deepEqual(
    detected.map((wallet) => ({ id: wallet.id, name: wallet.name })),
    [
      { id: "phantom", name: "Phantom" },
      { id: "solflare", name: "Solflare" },
    ],
  );
  assert.equal(detected[0].provider, windowSolana);
});

test("detectSolanaWallets falls back to window.phantom.solana when window.solana is not Phantom", () => {
  const phantomSolana = connectable("phantom-solana");
  globalThis.window = {
    solana: { isPhantom: false },
    phantom: { solana: phantomSolana },
  };

  const detected = detectSolanaWallets();
  assert.deepEqual(detected.map((wallet) => wallet.id), ["phantom"]);
  assert.equal(detected[0].provider, phantomSolana);
});

test("connectSolanaWallet calls window.solana.connect() before awaiting another wallet disconnect", async () => {
  const order = [];
  const windowSolana = Object.assign(connectable("window-solana"), {
    isPhantom: true,
    connect: async () => {
      order.push("connect");
      return { publicKey: { toString: () => "Pk11111111111111111111111111111111" } };
    },
  });
  const solflare = Object.assign(connectable("solflare"), {
    disconnect: async () => {
      order.push("disconnect-start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("disconnect-end");
    },
  });

  globalThis.window = {
    isSecureContext: true,
    localStorage: memoryStorage(),
    solana: windowSolana,
    solflare,
  };
  globalThis.window.localStorage.setItem("mwz:solana_wallet_id", "solflare");

  const result = await connectSolanaWallet("phantom");
  assert.equal(result.walletId, "phantom");
  assert.equal(order[0], "connect");
  assert.ok(!order.includes("disconnect-end") || order.indexOf("connect") < order.indexOf("disconnect-end"));
});

test("connectSolanaWallet refuses HTTP pages so Phantom does not hang with no popup", async () => {
  const windowSolana = Object.assign(connectable("window-solana"), { isPhantom: true });
  let connectCalls = 0;
  windowSolana.connect = async () => {
    connectCalls += 1;
    return { publicKey: { toString: () => "Pk11111111111111111111111111111111" } };
  };

  globalThis.window = {
    isSecureContext: false,
    localStorage: memoryStorage(),
    solana: windowSolana,
  };

  await assert.rejects(
    () => connectSolanaWallet("phantom"),
    /HTTPS/,
  );
  assert.equal(connectCalls, 0);
});
