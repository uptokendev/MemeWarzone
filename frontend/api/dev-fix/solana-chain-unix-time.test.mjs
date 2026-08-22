import assert from "node:assert/strict";
import test from "node:test";
import { getSolanaChainUnixTime, isTransientSolanaBlockTimeError } from "./solana-chain-unix-time.js";

test("treats missing slot block time as transient", () => {
  assert.equal(
    isTransientSolanaBlockTimeError(new Error("Solana RPC getBlockTime failed: Block not available for slot 440980988")),
    true,
  );
  assert.equal(isTransientSolanaBlockTimeError(new Error("HTTP 429")), false);
});

test("retries getBlockTime on a slightly older slot after Block not available", async () => {
  const calls = [];
  async function rpc(_url, method, params) {
    calls.push({ method, params });
    if (method === "getSlot") return 440980988;
    const slot = params[0];
    if (slot === 440980988) {
      throw new Error("Solana RPC getBlockTime failed: Block not available for slot 440980988");
    }
    if (slot === 440980987) return 1787423000;
    throw new Error(`unexpected slot ${slot}`);
  }

  const unix = await getSolanaChainUnixTime("https://rpc.example", rpc);
  assert.equal(unix, 1787423000);
  assert.deepEqual(
    calls.map((item) => item.method),
    ["getSlot", "getBlockTime", "getBlockTime", "getBlockTime"],
  );
  assert.equal(calls[1].params[0], 440980988);
  assert.equal(calls[3].params[0], 440980987);
});
