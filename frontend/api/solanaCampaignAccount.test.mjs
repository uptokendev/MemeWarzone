import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SOLANA_RPC_URL = "https://rpc.test.invalid";
process.env.SOLANA_CAMPAIGN_ACCOUNT_CACHE_MS = "60000";

const calls = [];
let failNext = false;
globalThis.fetch = async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body) });
  await new Promise((resolve) => setTimeout(resolve, 5));
  if (failNext) {
    failNext = false;
    throw new Error("rpc down");
  }
  return {
    json: async () => ({ result: { value: { data: ["AAEC", "base64"], owner: "Owner111", lamports: 42 } } }),
  };
};

const { default: handler } = await import("./solanaCampaignAccount.js");

function call(address) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) {
        this.headers[name] = value;
      },
      end(body) {
        resolve({ status: this.statusCode, body: JSON.parse(body) });
      },
    };
    handler({ method: "GET", url: `/api/solana/campaign-account?address=${address}` }, res);
  });
}

const A = "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt";
const B = "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX";
const C = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";

test("concurrent tabs share one getAccountInfo, and the result stays cached", async () => {
  const before = calls.length;
  const results = await Promise.all([call(A), call(A), call(A)]);
  assert.equal(calls.length - before, 1);
  for (const r of results) {
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, found: true, dataBase64: "AAEC", owner: "Owner111", lamports: 42 });
  }
  await call(A);
  assert.equal(calls.length - before, 1);
  assert.equal(calls.at(-1).body.method, "getAccountInfo");
});

test("different addresses are cached separately", async () => {
  const before = calls.length;
  await call(B);
  assert.equal(calls.length - before, 1);
});

test("an RPC failure is not cached", async () => {
  const before = calls.length;
  failNext = true;
  const first = await call(C);
  assert.deepEqual(first.body, { ok: true, found: false });
  const second = await call(C);
  assert.equal(second.body.found, true);
  assert.equal(calls.length - before, 2);
});

test("invalid address is still rejected", async () => {
  const r = await call("not-an-address");
  assert.equal(r.status, 400);
});
