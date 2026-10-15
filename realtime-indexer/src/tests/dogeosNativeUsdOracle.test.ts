import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// DogeOS 6281971 DOGE/USD reader (foundation; kept when the gen-7/MuchFi paths went, B8). Moved out of
// the removed V3 pool indexer test; it no longer goes through the Robinhood valuation dispatch.
// Env is fixed before any module import because env.ts snapshots it.
process.env.RUNTIME_ENVIRONMENT = "local";
process.env.LOCAL_DISABLE_ABLY = "1";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/memewarzone_dogeos_local";
process.env.DB_WATCHDOG_EXIT = "0";
process.env.DOGEOS_RPC_HTTP_6281971 = "https://rpc.testnet.dogeos.com";
delete process.env.DOGEOS_NATIVE_USD_ORACLE_ADDRESS_6281971;

const { ethers } = await import("ethers");
const { getDogeosNativeUsdReference, evaluateDogeosNativeUsdRound, dogeosNativeUsdOracleInternals } = await import(
  "../dogeosNativeUsdOracle.js"
);

const DOGEOS = 6281971;
const DOGEOS_ORACLE = "0x00000000000000000000000000000000000d0e05";

type OracleRpc = { url: string; requests: string[]; close: () => Promise<void> };
async function startOracleRpc(input: {
  chainId: number;
  oracle: string;
  answer: bigint;
  updatedAt: number;
  decimals: number;
}): Promise<OracleRpc> {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const requests: string[] = [];
  const handle = (req: any) => {
    requests.push(req.method);
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
    const fail = (message: string) => ({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message } });
    switch (req.method) {
      case "eth_chainId":
        return reply(`0x${input.chainId.toString(16)}`);
      case "eth_blockNumber":
        return reply("0x10");
      case "eth_getCode":
        return reply(String(req.params?.[0] || "").toLowerCase() === input.oracle.toLowerCase() ? "0x6080604052" : "0x");
      case "eth_call": {
        const call = req.params?.[0] || {};
        if (String(call.to || "").toLowerCase() !== input.oracle.toLowerCase()) return fail("execution reverted");
        const selector = String(call.data || call.input || "").slice(0, 10);
        if (selector === "0xfeaf968c") {
          return reply(coder.encode(
            ["uint80", "int256", "uint256", "uint256", "uint80"],
            [7n, input.answer, BigInt(input.updatedAt), BigInt(input.updatedAt), 7n],
          ));
        }
        if (selector === "0x313ce567") return reply(coder.encode(["uint8"], [input.decimals]));
        return fail("execution reverted");
      }
      default:
        return fail(`unsupported ${req.method}`);
    }
  };
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      const out = Array.isArray(parsed) ? parsed.map(handle) : handle(parsed);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

test("DogeOS reader: same AggregatorV3 evaluation shape, max age 3600 s", () => {
  assert.equal(dogeosNativeUsdOracleInternals.MAX_AGE_SECONDS, 3600);
  const fresh = evaluateDogeosNativeUsdRound({
    nowSeconds: 10_000,
    roundId: 3n,
    answeredInRound: 3n,
    answer: 25_000_000n,
    updatedAtSeconds: 10_000 - 3_000,
    decimals: 8,
    maxAgeSeconds: 3600,
  });
  assert.equal(fresh.healthy, true);
  assert.equal(fresh.priceUsd, "0.25");
  const stale = evaluateDogeosNativeUsdRound({
    nowSeconds: 10_000,
    roundId: 3n,
    answeredInRound: 3n,
    answer: 25_000_000n,
    updatedAtSeconds: 10_000 - 3_601,
    decimals: 8,
    maxAgeSeconds: 3600,
  });
  assert.equal(stale.healthy, false);
  assert.match(stale.error || "", /DogeOS native USD oracle is stale/);
  const zero = evaluateDogeosNativeUsdRound({
    nowSeconds: 10_000, roundId: 3n, answeredInRound: 3n, answer: 0n, updatedAtSeconds: 9_999, decimals: 8, maxAgeSeconds: 3600,
  });
  assert.equal(zero.healthy, false);
  assert.match(zero.error || "", /non-positive/);
});

test("DogeOS reader refuses other chains and reports a missing oracle address without any RPC call", async () => {
  const other = await getDogeosNativeUsdReference(46630);
  assert.equal(other.healthy, false);
  assert.match(other.error || "", /Unsupported DogeOS chain/);
  const unconfigured = await getDogeosNativeUsdReference(DOGEOS);
  assert.equal(unconfigured.healthy, false);
  assert.match(unconfigured.error || "", /DogeOS native USD oracle is not configured/);
});

test("DogeOS reader reads the DOGE/USD oracle over the DogeOS RPC (healthy at 2,000 s under the 3600 s limit)", async () => {
  const now = Math.floor(Date.now() / 1000);
  const dogeosRpc = await startOracleRpc({ chainId: DOGEOS, oracle: DOGEOS_ORACLE, answer: 25_000_000n, updatedAt: now - 2_000, decimals: 8 });
  const savedRpc = process.env.DOGEOS_RPC_HTTP_6281971;
  process.env.DOGEOS_RPC_HTTP_6281971 = dogeosRpc.url;
  process.env.DOGEOS_NATIVE_USD_ORACLE_ADDRESS_6281971 = DOGEOS_ORACLE;
  try {
    const reference = await getDogeosNativeUsdReference(DOGEOS);
    assert.equal(reference.error, null);
    assert.equal(reference.healthy, true);
    assert.equal(reference.priceUsd, "0.25");
    assert.equal(reference.source, "aggregator_v3");
    assert.equal(reference.oracleFeedAddress, ethers.getAddress(DOGEOS_ORACLE));
    assert.ok(dogeosRpc.requests.includes("eth_call"), "the DogeOS RPC served the oracle read");
  } finally {
    process.env.DOGEOS_RPC_HTTP_6281971 = savedRpc;
    delete process.env.DOGEOS_NATIVE_USD_ORACLE_ADDRESS_6281971;
    await dogeosRpc.close();
  }
});
