import test from "node:test";
import assert from "node:assert/strict";

import { getLogsWithRetry, isRangeLimitRpcError, isTransientRpcError } from "./evmLogScan.js";

// The exact shape ethers v6 produced against BlockPI BSC testnet when claim
// recovery failed: a rate limit, wrapped, reported as UNKNOWN_ERROR.
function blockPiLimitExceeded() {
  const error = new Error(
    'could not coalesce error (error={ "code": -32005, "message": "limit exceeded" }, payload={ "method": "eth_getLogs" }, code=UNKNOWN_ERROR, version=6.16.0)',
  );
  error.code = "UNKNOWN_ERROR";
  error.error = { code: -32005, message: "limit exceeded" };
  return error;
}

function rangeLimit() {
  const error = new Error("query returned more than 10000 results, block range too large");
  error.code = "SERVER_ERROR";
  return error;
}

const noSleep = async () => {};

test("a wrapped -32005 rate limit counts as transient", () => {
  assert.equal(isTransientRpcError(blockPiLimitExceeded()), true);
});

test("HTTP 429 and 5xx count as transient", () => {
  assert.equal(isTransientRpcError({ status: 429, message: "Too Many Requests" }), true);
  assert.equal(isTransientRpcError({ info: { status: 503 }, message: "upstream" }), true);
});

test("a malformed-filter rejection is not transient", () => {
  const error = new Error("invalid topic filter");
  error.code = "INVALID_ARGUMENT";
  assert.equal(isTransientRpcError(error), false);
});

test("a rate limit is not mistaken for a block-range limit", () => {
  // This is the distinction that matters: narrowing the window in response to
  // throttling issues MORE requests and makes recovery strictly less likely.
  assert.equal(isRangeLimitRpcError(blockPiLimitExceeded()), false);
  assert.equal(isRangeLimitRpcError(rangeLimit()), true);
});

test("a throttled scan succeeds once the provider recovers", async () => {
  let calls = 0;
  const provider = {
    async getLogs() {
      calls += 1;
      if (calls < 3) throw blockPiLimitExceeded();
      return [{ blockNumber: 7 }];
    },
  };
  const logs = await getLogsWithRetry(provider, { fromBlock: 1, toBlock: 2 }, { sleep: noSleep });
  assert.equal(calls, 3);
  assert.deepEqual(logs, [{ blockNumber: 7 }]);
});

test("retries stop at the attempt budget and rethrow the provider error", async () => {
  let calls = 0;
  const provider = {
    async getLogs() {
      calls += 1;
      throw blockPiLimitExceeded();
    },
  };
  await assert.rejects(
    getLogsWithRetry(provider, {}, { attempts: 4, sleep: noSleep }),
    /limit exceeded/,
  );
  assert.equal(calls, 4);
});

test("a non-transient rejection is not retried", async () => {
  let calls = 0;
  const provider = {
    async getLogs() {
      calls += 1;
      const error = new Error("invalid topic filter");
      error.code = "INVALID_ARGUMENT";
      throw error;
    },
  };
  await assert.rejects(getLogsWithRetry(provider, {}, { sleep: noSleep }), /invalid topic filter/);
  assert.equal(calls, 1, "a bad filter must not burn the retry budget");
});

test("backoff grows and stays bounded", async () => {
  const delays = [];
  const provider = { async getLogs() { throw blockPiLimitExceeded(); } };
  await assert.rejects(
    getLogsWithRetry(provider, {}, {
      attempts: 6,
      baseDelayMs: 100,
      maxDelayMs: 500,
      sleep: async (ms) => { delays.push(ms); },
    }),
  );
  assert.equal(delays.length, 5);
  assert.ok(delays[0] >= 100 && delays[0] < 200, `first delay ${delays[0]}`);
  assert.ok(delays[1] > delays[0], "delay must grow");
  assert.ok(delays.every((ms) => ms <= 750), `capped, saw ${delays.join(",")}`);
});
