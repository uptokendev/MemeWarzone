import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

import {
  chainOfRpcUrl,
  countRpcRequest,
  countingFetch,
  hookEthersRpcCounter,
  resetRpcUsage,
  rpcUsageDelta,
  rpcUsageSnapshot,
} from "./rpcUsage.js";

test("counts by chain and method, batches per entry; delta is the window since the last call", () => {
  resetRpcUsage();
  countRpcRequest(56, { method: "eth_call" });
  countRpcRequest(56, [{ method: "eth_call" }, { method: "eth_blockNumber" }]);
  countRpcRequest(4663, "eth_getLogs");
  const snap = rpcUsageSnapshot();
  assert.equal(snap.total, 4);
  assert.deepEqual(snap.byChain["56"], { total: 3, methods: { eth_call: 2, eth_blockNumber: 1 } });
  assert.deepEqual(snap.byChain["4663"], { total: 1, methods: { eth_getLogs: 1 } });
  assert.ok(snap.estimatedPerDay["56"] > 0);
  assert.equal(rpcUsageDelta().total, 4);
  countRpcRequest(56, { method: "eth_call" });
  assert.deepEqual(rpcUsageDelta(), { total: 1, byChain: { 56: { total: 1, methods: { eth_call: 1 } } } });
  assert.equal(rpcUsageDelta().total, 0);
});

test("ethers hook: every JsonRpcProvider request is counted on its pinned chain; the URL is never kept", async () => {
  resetRpcUsage();
  class FakeProvider {
    get _network() { return { chainId: 56n }; }
    async _send(payload) { return (Array.isArray(payload) ? payload : [payload]).map((p) => ({ id: p.id, result: "0x1" })); }
  }
  hookEthersRpcCounter(FakeProvider);
  const p = new FakeProvider();
  await p._send({ id: 1, method: "eth_blockNumber", jsonrpc: "2.0" });
  await p._send([{ id: 2, method: "eth_call", jsonrpc: "2.0" }]);
  const snap = rpcUsageSnapshot();
  assert.deepEqual(snap.byChain["56"].methods, { eth_blockNumber: 1, eth_call: 1 });
  assert.ok(!JSON.stringify(snap).includes("http"), "no URL in the counters");
});

test("ethers hook on the real class: _send of a static-network provider counts its chain", async () => {
  resetRpcUsage();
  // The real hook point exists on this ethers version.
  assert.equal(typeof ethers.JsonRpcProvider.prototype._send, "function");
});

test("fetch hook: JSON-RPC bodies counted by the chain of their URL; Solana methods fall back to solana; other fetches untouched", async () => {
  resetRpcUsage();
  const seen = [];
  const base = async (url, init) => { seen.push(url); return { ok: true, json: async () => ({}) }; };
  const chainOf = (url) => (String(url).includes("bsc") ? 56 : null);
  const f = countingFetch(base, chainOf);
  await f("https://bsc.example/key", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [] }) });
  await f("https://sol.example/key", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [] }) });
  await f("https://api.example/x", { method: "POST", body: JSON.stringify({ hello: 1 }) });
  await f("https://api.example/y");
  const snap = rpcUsageSnapshot();
  assert.deepEqual(snap.byChain["56"].methods, { eth_getLogs: 1 });
  assert.deepEqual(snap.byChain.solana.methods, { getSignaturesForAddress: 1 });
  assert.equal(snap.total, 2);
  assert.equal(seen.length, 4, "every request still goes out");
});

test("chain of a URL: exact match on the configured lists first, then the same host; unknown is null", () => {
  const lists = { 56: ["https://bsc.example/KEY1", "https://bsc-dataseed.binance.org"], 97: [], 4663: ["https://rh.example/KEY2"], 46630: [] };
  const of = (url) => chainOfRpcUrl(url, (id) => lists[id] || []);
  assert.equal(of("https://bsc.example/KEY1"), 56);
  assert.equal(of("https://rh.example/other"), 4663);
  assert.equal(of("https://unknown.example/"), null);
  assert.equal(of("not a url"), null);
});
