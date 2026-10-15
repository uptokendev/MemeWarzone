// The gen-8 EVM widget's wallet helpers (src/widget/gen8Widget.ts): hex values, the EIP-712 JSON of a Permit2 permit
// (the sell path no longer asks for one; a caller that still has one recovers the same way the API checks it),
// wallet detection, and that mount() picks the EVM widget only for { chainId, token }. The swaps themselves are
// built by the API (api/gen8Swap.js; executed against Uniswap's real contracts in src/lib/evmGen8Client.chain.test.mjs).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Wallet, verifyTypedData, TypedDataEncoder, SigningKey, getBytes, Signature, recoverAddress } from "ethers";

const dir = path.dirname(fileURLToPath(import.meta.url));
const compiled = await build({
  absWorkingDir: dir,
  stdin: { contents: `export { hexValue, typedDataJson, findEvmWallet, formatPriceImpact, slippageRequest, shouldOfferProtectedRpc, GEN8_WIDGET_REFRESH_MS } from "./gen8Widget.ts";`, resolveDir: dir, sourcefile: "gen8Harness.ts", loader: "ts" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  packages: "external",
});
const harness = path.join(dir, `.gen8-harness-${process.pid}.mjs`);
fs.writeFileSync(harness, compiled.outputFiles[0].text);
let mod;
try {
  mod = await import(harness);
} finally {
  fs.rmSync(harness, { force: true });
}
const { hexValue, typedDataJson, findEvmWallet, formatPriceImpact, slippageRequest, shouldOfferProtectedRpc, GEN8_WIDGET_REFRESH_MS } = mod;
const { gen8PermitTypedData } = await import("../../shared/evmGen8Swap.mjs");

test("a sell sends allowance transactions and does not ask for a typed-data permit", () => {
  const src = fs.readFileSync(path.join(dir, "gen8Widget.ts"), "utf8");
  assert.match(src, /needsAllowance/);
  assert.match(src, /permit2Approval/);
  assert.doesNotMatch(src, /eth_signTypedData_v4/);
  assert.doesNotMatch(src, /needsPermit/);
});

test("the widget reloads the lens on a 60s timer, not a 5s one", () => {
  assert.equal(GEN8_WIDGET_REFRESH_MS, 60_000);
  const src = fs.readFileSync(path.join(dir, "gen8Widget.ts"), "utf8");
  assert.match(src, /setInterval\(\(\) => void this\.refreshLive\(\), GEN8_WIDGET_REFRESH_MS\)/);
  assert.match(src, /void this\.loadToken\(\);\s*void this\.loadBalances\(\)/);
  assert.match(src, /setInterval\(\(\) => this\.paintOpens\(\), 1000\)/);
});

test("hex values for eth_sendTransaction", () => {
  assert.equal(hexValue("0"), "0x0");
  assert.equal(hexValue(10n ** 18n), "0xde0b6b3a7640000");
});

test("the permit JSON a wallet signs with eth_signTypedData_v4 recovers to the wallet with the API's check", async () => {
  const w = Wallet.createRandom();
  const typed = gen8PermitTypedData({ chainId: 56, token: "0x1111111111111111111111111111111111111111", amount: 5n * 10n ** 21n, nonce: 2n, spender: "0xDc264714F68d84CF29BC605589405E78bDBE7C9f", nowSec: 1_000 });
  // the API sends the message with decimal strings (JSON); that is what the widget passes on
  const message = JSON.parse(JSON.stringify(typed.message, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  const json = JSON.parse(typedDataJson({ domain: typed.domain, types: typed.types, primaryType: typed.primaryType, message }));
  assert.deepEqual(json.types.EIP712Domain.map((f) => f.name), ["name", "chainId", "verifyingContract"]);
  assert.equal(json.primaryType, "PermitSingle");
  // what a v4 wallet does: hash domain + message with the given types (EIP712Domain excluded) and sign the digest
  const { EIP712Domain, ...types } = json.types;
  const digest = TypedDataEncoder.hash(json.domain, types, json.message);
  const signature = Signature.from(new SigningKey(w.privateKey).sign(getBytes(digest))).serialized;
  assert.equal(recoverAddress(digest, signature), w.address);
  assert.equal(verifyTypedData(typed.domain, typed.types, typed.message, signature), w.address, "the API's verifyTypedData on its own typed data");
});

test("EVM wallet detection: window.ethereum with request()", () => {
  assert.equal(findEvmWallet({}), null);
  assert.equal(findEvmWallet({ ethereum: {} }), null);
  const eth = { request: async () => null };
  assert.equal(findEvmWallet({ ethereum: eth }), eth);
});

test("F13: price impact text, and the API picks the slippage unless the partner set one", () => {
  assert.deepEqual([formatPriceImpact(null), formatPriceImpact(undefined), formatPriceImpact(0), formatPriceImpact(1234)], ["-", "-", "<0.01%", "12.34%"]);
  assert.deepEqual(slippageRequest({}), {}, "no slippageBps: the API sizes it (BNB) or uses 1% (Robinhood)");
  assert.deepEqual(slippageRequest({ slippageBps: 250 }), { slippageBps: 250 });
  assert.deepEqual(slippageRequest({ slippageBps: 0 }), { slippageBps: 0 });
});

test("F13 (founder 2026-10-12): the widget offers the protected BSC RPC on BNB mainnet only, once connected, until added or dismissed", () => {
  assert.equal(shouldOfferProtectedRpc(56, true, null), true);
  assert.equal(shouldOfferProtectedRpc(56, false, null), false, "not before a wallet is connected");
  assert.equal(shouldOfferProtectedRpc(56, true, { state: "added" }), false);
  assert.equal(shouldOfferProtectedRpc(56, true, { state: "dismissed" }), false);
  for (const id of [97, 4663, 46630]) assert.equal(shouldOfferProtectedRpc(id, true, null), false, `chain ${id}`);
  assert.equal(shouldOfferProtectedRpc(undefined, true, null), false);
});
