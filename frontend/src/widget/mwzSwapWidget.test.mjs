import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const dir = path.dirname(fileURLToPath(import.meta.url));
const compiled = await build({
  absWorkingDir: dir,
  stdin: { contents: `export { toRaw, fromRaw, findInjectedWallet, mountTarget } from "./mwzSwapWidget.ts";`, resolveDir: dir, sourcefile: "widgetHarness.ts", loader: "ts" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  packages: "external",
});
// Written next to the source so its package imports resolve; removed right after the import.
const harness = path.join(dir, `.harness-${process.pid}.mjs`);
fs.writeFileSync(harness, compiled.outputFiles[0].text);
let widget;
try {
  widget = await import(harness);
} finally {
  fs.rmSync(harness, { force: true });
}
const { toRaw, fromRaw, findInjectedWallet, mountTarget } = widget;

test("amounts are parsed to raw units without floats; too many decimals or junk is refused", () => {
  assert.equal(toRaw("0.5", 9), 500_000_000n);
  assert.equal(toRaw("1,25", 6), 1_250_000n);
  assert.equal(toRaw("0.1234567", 6), null);
  assert.equal(toRaw("abc", 9), null);
  assert.equal(toRaw("0", 9), null);
  assert.equal(toRaw(".", 9), null);
  assert.equal(toRaw("123456789.123456789", 9), 123456789123456789n);
});

test("raw units display with grouping, trimmed decimals and a floor for dust", () => {
  assert.equal(fromRaw(2_500_000n, 9), "0.0025");
  assert.equal(fromRaw(123_456_789n, 6), "123.456789");
  assert.equal(fromRaw(5_000_000_000_000n, 6), "5,000,000");
  assert.equal(fromRaw(1n, 9, 4), "<0.0001");
  assert.equal(fromRaw(0n, 9), "0");
});

test("wallet detection: Phantom first, only providers that can sign and send", () => {
  const send = async () => ({ signature: "x" });
  assert.equal(findInjectedWallet({}), null);
  assert.equal(findInjectedWallet({ phantom: { solana: { connect() {} } } }), null, "no signAndSendTransaction");
  assert.equal(findInjectedWallet({ solflare: { signAndSendTransaction: send } }).name, "Solflare");
  assert.equal(findInjectedWallet({ solflare: { signAndSendTransaction: send }, phantom: { solana: { signAndSendTransaction: send } } }).name, "Phantom");
});

test("widget build: the app's two Solana API calls go to the widget routes, nothing else is reachable", async () => {
  const shim = await build({ absWorkingDir: dir, entryPoints: [path.join(dir, "shims/apiBase.ts")], bundle: true, write: false, format: "esm", platform: "node" });
  const file = path.join(dir, `.shim-${process.pid}.mjs`);
  fs.writeFileSync(file, shim.outputFiles[0].text);
  let mod;
  try { mod = await import(file); } finally { fs.rmSync(file, { force: true }); }
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([url, init?.credentials]); return new Response("{}"); };
  mod.setWidgetApiBase("https://api.example/");
  await mod.apiFetch("/api/solana/trade-authorize", { method: "POST" });
  await mod.apiFetch("/api/solana/campaign-account?address=abc");
  await assert.rejects(mod.apiFetch("/api/feed/posts"), /does not call/);
  assert.deepEqual(calls, [
    ["https://api.example/api/widget/solana/trade-authorize", "omit"],
    ["https://api.example/api/widget/solana/campaign-account?address=abc", "omit"],
  ]);
});

test("mount routing: { mint } and { chainId: 101, token } get the Solana box; { chainId: 56 | 4663, token } the EVM box", () => {
  const mint = "2wT8AcQFEzXMEjb6qbs1GDg3mJ3DKBw6eBWp7GqsBAGS";
  const evm = "0x1a95c10e4839033686225eaad3ac348f0d8edc4f";
  assert.deepEqual(mountTarget({ mint }), { box: "solana", options: { mint } });
  const sol = mountTarget({ chainId: 101, token: mint, partner: "p" });
  assert.deepEqual([sol.box, sol.options.mint, sol.options.partner], ["solana", mint, "p"]);
  for (const chainId of [56, 4663, 97, 46630]) assert.equal(mountTarget({ chainId, token: evm }).box, "evm", `chain ${chainId}`);
  assert.equal(mountTarget({ chainId: 56, token: evm, mint }).box, "solana", "mint wins, as before");
  assert.equal(mountTarget({}).box, "solana", "nothing given: the Solana box says what is missing");
  assert.equal(mountTarget({ token: evm }).box, "solana", "a token without a chain is not guessed");
});

test("Solana box: price impact and minimum rows, Unlisted coin, onSwap carries chainId 101 and token", () => {
  const src = fs.readFileSync(path.join(dir, "mwzSwapWidget.ts"), "utf8");
  assert.match(src, /data-k="impactRow" hidden/);
  assert.match(src, /data-k="minRow" hidden/);
  assert.match(src, /"Unlisted coin"/);
  assert.equal((src.match(/onSwap\?\.\(\{ signature, side: this\.side, mint: [a-zA-Z.]+, chainId: 101, token: [a-zA-Z.]+ \}\)/g) || []).length, 2);
});

test("usage per partner: the widget sends partner on token lookups and quotes; the bonding shim adds it to trade-authorize only", async () => {
  const shim = await build({ absWorkingDir: dir, entryPoints: [path.join(dir, "shims/apiBase.ts")], bundle: true, write: false, format: "esm", platform: "node" });
  const file = path.join(dir, `.shim-partner-${process.pid}.mjs`);
  fs.writeFileSync(file, shim.outputFiles[0].text);
  let mod;
  try { mod = await import(file); } finally { fs.rmSync(file, { force: true }); }
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(url); return new Response("{}"); };
  mod.setWidgetApiBase("https://api.example");
  // Two boxes, two partners: each trade sends its own partner, read when the call starts; nothing sticks afterwards.
  const a = mod.withWidgetPartner("crypticpump", () => mod.apiFetch("/api/solana/trade-authorize", { method: "POST" }));
  const b = mod.withWidgetPartner("other-site", () => mod.apiFetch("/api/solana/trade-authorize", { method: "POST" }));
  await Promise.all([a, b]);
  await mod.withWidgetPartner("crypticpump", () => mod.apiFetch("/api/solana/campaign-account?address=abc"));
  await mod.apiFetch("/api/solana/trade-authorize", { method: "POST" });
  await mod.withWidgetPartner(null, () => mod.apiFetch("/api/solana/trade-authorize", { method: "POST" }));
  assert.deepEqual(calls, [
    "https://api.example/api/widget/solana/trade-authorize?partner=crypticpump",
    "https://api.example/api/widget/solana/trade-authorize?partner=other-site",
    "https://api.example/api/widget/solana/campaign-account?address=abc",
    "https://api.example/api/widget/solana/trade-authorize",
    "https://api.example/api/widget/solana/trade-authorize",
  ]);

  const shared = await build({ absWorkingDir: dir, entryPoints: [path.join(dir, "widgetShared.ts")], bundle: true, write: false, format: "esm", platform: "node" });
  const sharedFile = path.join(dir, `.shared-${process.pid}.mjs`);
  fs.writeFileSync(sharedFile, shared.outputFiles[0].text);
  let sharedMod;
  try { sharedMod = await import(sharedFile); } finally { fs.rmSync(sharedFile, { force: true }); }
  assert.equal(sharedMod.partnerQuery("crypticpump"), "&partner=crypticpump");
  assert.equal(sharedMod.partnerQuery(" a b "), "&partner=a%20b");
  assert.equal(sharedMod.partnerQuery(undefined), "");

  const sol = fs.readFileSync(path.join(dir, "mwzSwapWidget.ts"), "utf8");
  const evm = fs.readFileSync(path.join(dir, "gen8Widget.ts"), "utf8");
  assert.match(sol, /\/api\/widget\/swap\/token\?mint=\$\{encodeURIComponent\(mint\)\}\$\{partnerQuery\(this\.options\.partner\)\}/);
  assert.match(evm, /\/api\/widget\/swap\/evm\/token\?chainId=\$\{chainId\}&token=\$\{token\}\$\{partnerQuery\(this\.options\.partner\)\}/);
  assert.match(evm, /\/api\/widget\/swap\/gen8\/token\?chainId=\$\{chainId\}&token=\$\{token\}\$\{partnerQuery\(this\.options\.partner\)\}/);
  // Every quote and build body carries the partner when the host set one.
  for (const [name, src, expected] of [["solana", sol, 2], ["evm", evm, 4]]) {
    assert.equal((src.match(/\.\.\.\(this\.options\.partner \? \{ partner: this\.options\.partner \} : \{\}\)/g) || []).length, expected, name);
  }
  // The bonding module's API base is set once when it loads (as before); the partner goes with each trade call.
  assert.equal((sol.match(/loadBonding\(this\.api\)/g) || []).length, 2);
  assert.match(sol, /api\.setWidgetApiBase\(apiBase\); resolve\(api\);/);
  assert.match(sol, /trader: this\.account, partner: this\.options\.partner \?\? null \}\)/);
  const bondingSrc = fs.readFileSync(path.join(dir, "bonding.ts"), "utf8");
  assert.match(bondingSrc, /await withWidgetPartner\(input\.partner, \(\) => requestSolanaTradeAuthorization\(\{/);
});
