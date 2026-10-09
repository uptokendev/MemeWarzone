import assert from "node:assert/strict";
import { ethers } from "ethers";
import test from "node:test";

import { recordTipScan, resetTipWindows, tipScanStart, tipWindowOptionsFromEnv } from "../tipScanWindow.js";
import { countRpcRequest, hookEthersRpcCounter, resetRpcUsage, rpcUsageDelta, rpcUsageSnapshot } from "../rpcUsage.js";
import { maskRpcUrl } from "../rpcProvider.js";

const OPTS = { windowBlocks: 20_000, overlapBlocks: 200, fullSweepMs: 600_000 };

test("tip window: the first scan reads the full window; the next only the new blocks plus the overlap", () => {
  resetTipWindows();
  const t0 = 1_000_000;
  const first = tipScanStart(56, "campaign:0xabc", 100_000, OPTS, t0);
  assert.deepEqual(first, { from: 80_000, full: true, skip: false });
  recordTipScan(56, "campaign:0xabc", 100_000, { full: true, complete: true }, t0);

  const next = tipScanStart(56, "campaign:0xABC", 100_022, OPTS, t0 + 10_000);
  assert.deepEqual(next, { from: 99_801, full: false, skip: false }, "22 new blocks + 200 overlap = one 500-block chunk, not 40");
  recordTipScan(56, "campaign:0xabc", 100_022, { full: false, complete: true }, t0 + 10_000);

  assert.equal(tipScanStart(56, "campaign:0xabc", 100_022, OPTS, t0 + 11_000).skip, true, "head unchanged: no request");
  assert.equal(tipScanStart(4663, "campaign:0xabc", 100_022, OPTS, t0 + 11_000).full, true, "per chain");
});

test("tip window: the full window comes back every fullSweepMs, after a cut-short scan, and when 0 turns the window off", () => {
  resetTipWindows();
  const t0 = 5_000_000;
  recordTipScan(56, "votes-tip", 100_000, { full: true, complete: true }, t0);
  recordTipScan(56, "votes-tip", 100_500, { full: false, complete: true }, t0 + 300_000);
  assert.equal(tipScanStart(56, "votes-tip", 100_600, OPTS, t0 + 599_000).full, false);
  assert.deepEqual(tipScanStart(56, "votes-tip", 100_600, OPTS, t0 + 600_000), { from: 80_600, full: true, skip: false }, "sweep due, measured from the last full scan");

  recordTipScan(56, "votes-tip", 100_700, { full: false, complete: false }, t0 + 601_000);
  assert.equal(tipScanStart(56, "votes-tip", 100_701, OPTS, t0 + 602_000).full, true, "an incomplete scan forgets the window");

  recordTipScan(56, "c", 100_000, { full: true, complete: true }, t0);
  assert.equal(tipScanStart(56, "c", 100_010, { ...OPTS, fullSweepMs: 0 }, t0 + 1).full, true, "0 = old behaviour");

  recordTipScan(56, "d", 100_000, { full: true, complete: true }, t0);
  assert.equal(tipScanStart(56, "d", 130_000, OPTS, t0 + 1).from, 110_000, "a gap larger than the window never reads more than the window");
});

test("tip window env: defaults 200 blocks overlap, 10 minute sweep; bad values fall back", () => {
  assert.deepEqual(tipWindowOptionsFromEnv(20_000, {}), { windowBlocks: 20_000, overlapBlocks: 200, fullSweepMs: 600_000 });
  assert.deepEqual(tipWindowOptionsFromEnv(5_000, { INDEXER_TIP_OVERLAP_BLOCKS: "50", INDEXER_TIP_FULL_SWEEP_MS: "0" }), { windowBlocks: 5_000, overlapBlocks: 50, fullSweepMs: 0 });
  assert.deepEqual(tipWindowOptionsFromEnv(5_000, { INDEXER_TIP_OVERLAP_BLOCKS: "x", INDEXER_TIP_FULL_SWEEP_MS: "-1" }), { windowBlocks: 5_000, overlapBlocks: 200, fullSweepMs: 600_000 });
});

test("rpc usage: counted by chain and method, batches per entry, windows by delta", () => {
  resetRpcUsage();
  countRpcRequest(56, { method: "eth_getLogs" });
  countRpcRequest(56, [{ method: "eth_getLogs" }, { method: "eth_blockNumber" }]);
  countRpcRequest(4663, "eth_call");
  const snap = rpcUsageSnapshot();
  assert.equal(snap.total, 4);
  assert.deepEqual(snap.byChain["56"], { total: 3, methods: { eth_getLogs: 2, eth_blockNumber: 1 } });
  assert.equal(rpcUsageDelta().total, 4);
  countRpcRequest(4663, "eth_call");
  assert.deepEqual(rpcUsageDelta(), { total: 1, byChain: { 4663: { total: 1, methods: { eth_call: 1 } } } });
});

test("rpc usage: every ethers JsonRpcProvider in the process is counted on its pinned chain (hooked by rpcProvider.ts)", async () => {
  resetRpcUsage();
  hookEthersRpcCounter(); // already done at import; a second call is a no-op
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:9", ethers.Network.from(4663), { staticNetwork: ethers.Network.from(4663) });
  await provider._send({ id: 1, method: "eth_call", params: [], jsonrpc: "2.0" }).catch(() => null);
  provider.destroy();
  assert.deepEqual(rpcUsageSnapshot().byChain["4663"].methods, { eth_call: 1 });
});

test("maskRpcUrl: scheme and host only, for every provider's key layout", () => {
  assert.equal(maskRpcUrl("https://bsc-mainnet.core.chainstack.com/0123456789abcdef0123456789abcdef"), "https://bsc-mainnet.core.chainstack.com/…");
  assert.equal(maskRpcUrl("https://bsc.blockpi.network/v1/rpc/0123456789abcdef"), "https://bsc.blockpi.network/…");
  assert.equal(maskRpcUrl("https://mainnet.helius-rpc.com/?api-key=secret"), "https://mainnet.helius-rpc.com/…");
  assert.equal(maskRpcUrl("https://rpc.mainnet.chain.robinhood.com"), "https://rpc.mainnet.chain.robinhood.com");
  assert.equal(maskRpcUrl("not a url with a key 0123456789"), "rpc");
});
