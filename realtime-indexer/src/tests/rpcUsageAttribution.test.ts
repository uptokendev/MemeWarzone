import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import {
  countingSolanaFetch,
  hookEthersRpcCounter,
  resetRpcUsage,
  rpcCallSource,
  rpcUsageSnapshot,
} from "../rpcUsage.js";

test("rpcCallSource: first frame of ours below the RPC plumbing, as file:function", () => {
  const stack = [
    "Error",
    "    at attributeRpcCall (file:///app/dist/rpcUsage.js:60:13)",
    "    at countedFetch (file:///app/dist/rpcUsage.js:200:7)",
    "    at ClientBrowser.callServer (file:///app/node_modules/@solana/web3.js/lib/index.cjs.js:8000:20)",
    "    at async Connection.getMultipleAccountsInfo (file:///app/node_modules/@solana/web3.js/lib/index.cjs.js:9000:5)",
    "    at async processFlushes (file:///app/dist/solanaFeeEscrowWorker.js:470:52)",
    "    at async tick (file:///app/dist/solanaFeeEscrowWorker.js:747:5)",
  ].join("\n");
  assert.equal(rpcCallSource(stack, "/app/dist/"), "solanaFeeEscrowWorker.js:processFlushes<tick");
});

test("rpcCallSource: rawRpcCall in rpcProvider is skipped in favour of its caller", () => {
  const stack = [
    "Error",
    "    at rawRpcCall (/app/dist/rpcProvider.js:103:3)",
    "    at probeRpcUrl (/app/dist/rpcProvider.js:150:5)",
    "    at async getRpcDiagnostics (/app/dist/server.js:2900:20)",
    "    at async statusRoute (/app/dist/statusRoutes.js:40:3)",
  ].join("\n");
  assert.equal(rpcCallSource(stack, "/app/dist/"), "server.js:getRpcDiagnostics<statusRoutes.js:statusRoute");
});

test("rpcCallSource: a shared helper is split by its caller; recursion is skipped", () => {
  const stack = [
    "Error",
    "    at countedFetch (/app/dist/rpcUsage.js:200:7)",
    "    at async rpc (/app/dist/solanaIndexer.js:430:20)",
    "    at async rpc (/app/dist/solanaIndexer.js:440:20)",
    "    at async runTipLane (/app/dist/solanaIndexer.js:2200:9)",
  ].join("\n");
  assert.equal(rpcCallSource(stack, "/app/dist/"), "solanaIndexer.js:rpc<runTipLane");
});

test("rpcCallSource: nothing of ours on the stack", () => {
  assert.equal(rpcCallSource("Error\n    at listOnTimeout (node:internal/timers:573:17)", "/app/dist/"), "unattributed");
  assert.equal(rpcCallSource(undefined, "/app/dist/"), "unattributed");
});

async function feeEscrowLikeCaller(fetchImpl: typeof fetch) {
  await fetchImpl("https://rpc.invalid", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [] }),
  });
}

test("solana fetch hook attributes to the calling function", async () => {
  resetRpcUsage();
  const counted = countingSolanaFetch((async () => new Response("{}")) as typeof fetch);
  await feeEscrowLikeCaller(counted);
  await feeEscrowLikeCaller(counted);
  const snap = rpcUsageSnapshot();
  const keys = Object.keys(snap.bySourcePerDay);
  assert.ok(keys.some((k) => k.startsWith("solana rpcUsageAttribution.test.ts:feeEscrowLikeCaller")), JSON.stringify(keys));
  assert.equal(snap.byChain.solana.methods.getMultipleAccounts, 2);
});

async function evmLikeCaller(provider: ethers.JsonRpcProvider) {
  return provider.send("eth_blockNumber", []);
}

test("ethers hook attributes provider.send to the calling function", async () => {
  hookEthersRpcCounter();
  resetRpcUsage();
  const network = ethers.Network.from(56);
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:1", network, { staticNetwork: network, batchMaxCount: 1 });
  // Answer from _send without any network I/O.
  (provider as any)._send = async (payload: any) => [{ id: payload.id, jsonrpc: "2.0", result: "0x10" }];
  assert.equal(await evmLikeCaller(provider), "0x10");
  const keys = Object.keys(rpcUsageSnapshot().bySourcePerDay);
  assert.ok(keys.some((k) => k.startsWith("56 rpcUsageAttribution.test.ts:evmLikeCaller")), JSON.stringify(keys));
  provider.destroy();
});
