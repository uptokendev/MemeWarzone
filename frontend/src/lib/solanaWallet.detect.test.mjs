import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { transform } from "esbuild";

const sourceUrl = new URL("./solanaWallet.ts", import.meta.url);
let source = await readFile(sourceUrl, "utf8");
source = source
  .replace('import type { DraftActionAuth, DraftAuthAction } from "@/lib/draftAuth";\n', "")
  .replace('import { apiFetch } from "@/lib/apiBase";\n', "const apiFetch = async () => ({});\n")
  .replace(
    'import { detectWalletStandardSolanaWallets } from "@/lib/solanaWalletStandard";\n',
    "function detectWalletStandardSolanaWallets() {\n  return globalThis.__mwzStandardSolanaWallets || [];\n}\n",
  );

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

test("detectSolanaWallets keeps one Phantom and one Solflare when Wallet Standard and legacy globals both register", () => {
  const standardPhantom = connectable("ws-phantom");
  const standardSolflare = connectable("ws-solflare");
  const legacyPhantom = connectable("legacy-phantom");
  const legacySolflare = connectable("legacy-solflare");

  globalThis.__mwzStandardSolanaWallets = [
    { id: "wallet-standard:phantom", name: "Phantom", icon: "👻", provider: standardPhantom },
    { id: "wallet-standard:solflare", name: "Solflare", icon: "☀️", provider: standardSolflare },
  ];

  globalThis.window = {
    solana: Object.assign(legacyPhantom, { isPhantom: true }),
    phantom: { solana: legacyPhantom },
    solflare: legacySolflare,
  };

  const detected = detectSolanaWallets();
  const names = detected.map((wallet) => wallet.name);
  const ids = detected.map((wallet) => wallet.id);

  assert.deepEqual(names.filter((name) => name === "Phantom"), ["Phantom"]);
  assert.deepEqual(names.filter((name) => name === "Solflare"), ["Solflare"]);
  assert.deepEqual(ids, ["wallet-standard:phantom", "wallet-standard:solflare"]);
  assert.equal(detected[0].provider, standardPhantom);
  assert.equal(detected[1].provider, standardSolflare);
});

test("detectSolanaWallets still surfaces legacy Phantom/Solflare when Wallet Standard is empty", () => {
  const legacyPhantom = connectable("legacy-phantom");
  const legacySolflare = connectable("legacy-solflare");

  globalThis.__mwzStandardSolanaWallets = [];
  globalThis.window = {
    solana: Object.assign(legacyPhantom, { isPhantom: true }),
    solflare: legacySolflare,
  };

  const detected = detectSolanaWallets();
  assert.deepEqual(
    detected.map((wallet) => ({ id: wallet.id, name: wallet.name })),
    [
      { id: "legacy:phantom", name: "Phantom" },
      { id: "legacy:solflare", name: "Solflare" },
    ],
  );
});
