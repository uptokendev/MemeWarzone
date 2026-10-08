import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

// A local JSON-RPC node that counts what it is asked.
const calls = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const payload = JSON.parse(body);
    const one = (p) => { calls.push(p.method); return { jsonrpc: "2.0", id: p.id, result: p.method === "eth_chainId" ? "0xb626" : "0x10" }; };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(payload) ? payload.map(one) : one(payload)));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/secret-key`;

const original = { ...process.env };
process.env.ROBINHOOD_RPC_HTTP_46630 = url;
const { getServerReadProvider, resetServerReadProviders } = await import("./getServerReadProvider.js");

test.after(() => {
  server.close();
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
});

test("cached provider: the liveness ping runs once per SERVER_RPC_PING_TTL_MS, not on every call", async () => {
  resetServerReadProviders();
  process.env.SERVER_RPC_PING_TTL_MS = "60000";
  calls.length = 0;
  const first = await getServerReadProvider(46630);
  assert.deepEqual(calls, ["eth_blockNumber"], "a new provider is checked once (static network: no eth_chainId)");
  for (let i = 0; i < 5; i += 1) assert.equal(await getServerReadProvider(46630), first);
  assert.deepEqual(calls, ["eth_blockNumber"], "five more calls inside the TTL send nothing");

  process.env.SERVER_RPC_PING_TTL_MS = "0";
  await new Promise((resolve) => setTimeout(resolve, 300)); // past ethers' own 250 ms request dedupe
  assert.equal(await getServerReadProvider(46630), first);
  assert.deepEqual(calls, ["eth_blockNumber", "eth_blockNumber"], "TTL 0 = the old ping on every call");
  first.destroy();
  resetServerReadProviders();
});
