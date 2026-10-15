/**
 * The six gen-8 view reads go out as one Multicall3 aggregate3 when that contract has code.
 * One failed inner call stays failed on its own. No code, or a thrown batch, keeps the per-call reads.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { GEN8_MULTICALL3, readGen8ViewBatch } from "./evmGen8CampaignState.js";

const HOOK = "0x0000000000000000000000000000000000000002";
const PM = "0x0000000000000000000000000000000000000003";
const LENS = "0x0000000000000000000000000000000000000006";
const POOL = ethers.id("pool");
const WORD = ethers.zeroPadValue(ethers.toBeHex(5n), 32);

const hookIface = new ethers.Interface([
  "function creatorOwed(bytes32) view returns (uint256)",
  "function pendingCreator(bytes32) view returns (address)",
  "function displayPair(bytes32) view returns (address)",
]);
const pmIface = new ethers.Interface(["function extsload(bytes32 slot) view returns (bytes32)"]);
const lensIface = new ethers.Interface([
  "function progress(bytes32 id) view returns (tuple(bool graduated, bool postPhase, uint40 graduatedAt, uint160 sqrtPriceX96, uint256 coinsSoldFromA, uint256 coinsInA, uint256 nativeInA, uint256 nativeTargetA))",
  "function tradingOpen(bytes32 id) view returns (bool open, uint256 openAt)",
]);
const mcIface = new ethers.Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

function providerFor(chainId, { code, call }) {
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:1", chainId, { staticNetwork: true });
  provider.getCode = async () => code;
  provider.call = async (tx) => call(tx);
  return provider;
}

function cfg(chainId) {
  return { chainId, hook: HOOK, poolManager: PM, lens: LENS };
}

test("Multicall3 batches the six reads and a failed inner call does not blank the others", async () => {
  const calls = [];
  const owed = hookIface.encodeFunctionResult("creatorOwed", [123n]);
  const pending = hookIface.encodeFunctionResult("pendingCreator", [ethers.ZeroAddress]);
  const display = hookIface.encodeFunctionResult("displayPair", ["0x0000000000000000000000000000000000000009"]);
  const word = pmIface.encodeFunctionResult("extsload", [WORD]);
  const progress = lensIface.encodeFunctionResult("progress", [[false, true, 0, 7n, 0n, 1n, 4n, 9n]]);
  const open = lensIface.encodeFunctionResult("tradingOpen", [true, 10n]);
  const raw = mcIface.encodeFunctionResult("aggregate3", [[
    [true, owed],
    [false, "0x"],
    [true, display],
    [true, word],
    [true, progress],
    [true, open],
  ]]);
  const provider = providerFor(501, {
    code: "0x6080",
    call: async (tx) => {
      calls.push(tx);
      return raw;
    },
  });
  const hook = new ethers.Contract(HOOK, hookIface, provider);
  const [owedR, pendingR, displayR, slotR, lensR, openR] = await readGen8ViewBatch({
    provider, cfg: cfg(501), pool: { poolId: POOL, hook }, lens: { progress() {}, tradingOpen() {} },
  });
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0].to).toLowerCase(), GEN8_MULTICALL3.toLowerCase());
  assert.equal(calls[0].data.slice(0, 10), "0x82ad56cb");
  assert.equal(owedR.ok, true);
  assert.equal(owedR.value, 123n);
  assert.equal(pendingR.ok, false);
  assert.equal(displayR.ok, true);
  assert.equal(String(displayR.value).toLowerCase(), "0x0000000000000000000000000000000000000009");
  assert.equal(slotR.ok, true);
  assert.equal(slotR.value.sqrtPriceX96, 5n);
  assert.equal(lensR.ok, true);
  assert.equal(Boolean(lensR.value.postPhase), true);
  assert.equal(BigInt(lensR.value.sqrtPriceX96), 7n);
  assert.equal(BigInt(lensR.value.nativeInA), 4n);
  assert.equal(openR.ok, true);
  assert.equal(Boolean(openR.value.open), true);
  provider.destroy();
});

test("no Multicall3 code keeps the six separate reads", async () => {
  const calls = [];
  const provider = providerFor(502, {
    code: "0x",
    call: async (tx) => {
      calls.push(tx);
      throw new Error("individual");
    },
  });
  const hook = new ethers.Contract(HOOK, hookIface, provider);
  const lens = new ethers.Contract(LENS, lensIface, provider);
  const rows = await readGen8ViewBatch({ provider, cfg: cfg(502), pool: { poolId: POOL, hook }, lens });
  assert.equal(calls.length, 6);
  assert.ok(calls.every((tx) => String(tx.data || "").slice(0, 10) !== "0x82ad56cb"));
  assert.ok(rows.every((r) => r.ok === false));
  const again = await readGen8ViewBatch({ provider, cfg: cfg(502), pool: { poolId: POOL, hook }, lens });
  assert.equal(calls.length, 12, "a chain with no code does not getCode again");
  assert.equal(again.length, 6);
  provider.destroy();
});

test("a thrown Multicall3 falls back to the separate reads", async () => {
  let n = 0;
  const provider = providerFor(503, {
    code: "0x6080",
    call: async () => {
      n += 1;
      throw new Error("batch down");
    },
  });
  const hook = new ethers.Contract(HOOK, hookIface, provider);
  const lens = new ethers.Contract(LENS, lensIface, provider);
  const rows = await readGen8ViewBatch({ provider, cfg: cfg(503), pool: { poolId: POOL, hook }, lens });
  assert.equal(n, 7, "one aggregate3 plus the six fallbacks");
  assert.ok(rows.every((r) => r.ok === false));
  provider.destroy();
});
