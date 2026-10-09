import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const dir = path.dirname(fileURLToPath(import.meta.url));
const compiled = await build({
  absWorkingDir: dir,
  stdin: { contents: `export { toRaw, fromRaw, findInjectedWallet } from "./mwzSwapWidget.ts";`, resolveDir: dir, sourcefile: "widgetHarness.ts", loader: "ts" },
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
const { toRaw, fromRaw, findInjectedWallet } = widget;

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
