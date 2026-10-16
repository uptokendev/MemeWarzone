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
  const snap = rpcUsageSnapshot();
  const keys = Object.keys(snap.bySourcePerDay);
  assert.ok(keys.some((k) => k.startsWith("56 rpcUsageAttribution.test.ts:evmLikeCaller")), JSON.stringify(keys));
  const row = Object.entries(snap.byCaller["56"] ?? {}).find(([key]) => key.startsWith("rpcUsageAttribution.test.ts:evmLikeCaller"));
  assert.ok(row, JSON.stringify(snap.byCaller));
  assert.equal(row[1].total, 1);
  assert.equal(row[1].methods.eth_blockNumber, 1);
  assert.ok(!JSON.stringify(snap).includes("http"));
  provider.destroy();
});

test("byCaller is the raw count for every caller, and bySourcePerDay stays the top 60 rates", async () => {
  resetRpcUsage();
  const counted = countingSolanaFetch((async () => new Response("{}")) as typeof fetch);
  for (let i = 0; i < 61; i += 1) {
    const fn = async function callOnce(fetchImpl: typeof fetch) {
      await fetchImpl("https://rpc.invalid", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }),
      });
    };
    Object.defineProperty(fn, "name", { value: `caller${String(i).padStart(2, "0")}` });
    await fn(counted);
  }
  const again = async function caller00(fetchImpl: typeof fetch) {
    await fetchImpl("https://rpc.invalid", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }),
    });
  };
  await again(counted);
  const snap = rpcUsageSnapshot();
  const callers = snap.byCaller.solana;
  const top = Object.entries(callers).find(([key]) => key.startsWith("rpcUsageAttribution.test.ts:caller00"));
  assert.ok(top, JSON.stringify(Object.keys(callers)));
  assert.equal(top[1].total, 2);
  assert.equal(top[1].methods.getSlot, 2);
  assert.equal(Object.keys(callers).length, 61);
  const rates = Object.keys(snap.bySourcePerDay);
  assert.equal(rates.length, 60);
  assert.equal(rates.some((key) => key.includes("caller60")), false);
  assert.equal(Object.keys(callers).some((key) => key.startsWith("rpcUsageAttribution.test.ts:caller60")), true);
  const rateKey = rates.find((key) => key.includes("caller00"));
  assert.ok(rateKey);
  assert.equal(snap.bySourcePerDay[rateKey], Math.round((2 / snap.uptimeSec) * 86_400));
  assert.equal(Object.keys(callers)[0].startsWith("rpcUsageAttribution.test.ts:caller00"), true);
  assert.ok(!JSON.stringify(snap).includes("http"));
});
