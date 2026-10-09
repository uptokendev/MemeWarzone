import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

import { failoverSend, makeFailoverReadProvider } from "./readProviderFailover.mjs";

const ok = (payload) => [{ id: payload.id, result: "0x1" }];

test("first URL answers: the others are never asked", async () => {
  const asked = [];
  const send = failoverSend([async (p) => { asked.push("a"); return ok(p); }, async (p) => { asked.push("b"); return ok(p); }]);
  assert.deepEqual(await send({ id: 1 }), [{ id: 1, result: "0x1" }]);
  assert.deepEqual(asked, ["a"]);
});

test("a transport failure or a rate limit moves to the next URL, which is then tried first", async () => {
  const asked = [];
  const send = failoverSend([
    async () => { asked.push("a"); throw new Error("socket hang up"); },
    async (p) => { asked.push("b"); return ok(p); },
  ]);
  await send({ id: 1 });
  await send({ id: 2 });
  assert.deepEqual(asked, ["a", "b", "b"], "the URL that answered is preferred afterwards");

  const asked2 = [];
  const send2 = failoverSend([
    async (p) => { asked2.push("a"); return [{ id: p.id, error: { code: -32005, message: "limit exceeded" } }]; },
    async (p) => { asked2.push("b"); return ok(p); },
  ]);
  assert.deepEqual(await send2({ id: 3 }), [{ id: 3, result: "0x1" }]);
  assert.deepEqual(asked2, ["a", "b"]);
});

test("a normal JSON-RPC error (a revert) is an answer: no failover; all failing throws the last error", async () => {
  const asked = [];
  const revert = [{ id: 1, error: { code: 3, message: "execution reverted" } }];
  const send = failoverSend([async () => { asked.push("a"); return revert; }, async (p) => { asked.push("b"); return ok(p); }]);
  assert.deepEqual(await send({ id: 1 }), revert);
  assert.deepEqual(asked, ["a"]);
  const dead = failoverSend([async () => { throw new Error("one"); }, async () => { throw new Error("two"); }]);
  await assert.rejects(dead({ id: 1 }), /two/);
  const limited = [{ id: 1, error: { code: -32005, message: "limit exceeded" } }];
  const allLimited = failoverSend([async () => limited, async () => limited]);
  assert.deepEqual(await allLimited({ id: 1 }), limited, "every URL rate-limited: the answer is returned as is");
});

test("one URL: a plain JsonRpcProvider, as before; several: the same class with failover", () => {
  const network = ethers.Network.from(56);
  const opts = { staticNetwork: network, batchMaxCount: 1, batchStallTime: 0 };
  const single = makeFailoverReadProvider(ethers, ["http://127.0.0.1:9/a"], network, opts);
  assert.ok(single instanceof ethers.JsonRpcProvider);
  assert.ok(!Object.prototype.hasOwnProperty.call(single, "_send"));
  const multi = makeFailoverReadProvider(ethers, ["http://127.0.0.1:9/a", "http://127.0.0.1:9/b"], network, opts);
  assert.ok(multi instanceof ethers.JsonRpcProvider);
  assert.ok(Object.prototype.hasOwnProperty.call(multi, "_send"));
  single.destroy();
  multi.destroy();
});
