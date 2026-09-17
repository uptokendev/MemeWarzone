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
const { detectSolanaWallets } = await import(moduleUrl);

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
