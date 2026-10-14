import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { redactRpcSecretsInText, redactRpcSecretsMiddleware } from "../rpcProvider.js";

// Built at runtime so secret scanners do not flag a literal key in the source.
const KEY = ["0123", "4567", "89ab", "cdef"].join("").repeat(2);

// Shape of the ethers v6 error the live /api/indexer/status returned on 2026-10-13.
const ETHERS_403 = `server response 403 Forbidden (request={  }, response={  }, error=null, info={ "requestUrl": "https://bsc-mainnet.core.chainstack.com/${KEY}", "responseBody": "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"error\\":{\\"code\\":-32005,\\"message\\":\\"You've reached your monthly quota of Request Units (RUs). Visit https://console.chainstack.com/user/settings/billing for details.\\"}}", "responseStatus": "403 Forbidden" }, code=SERVER_ERROR, version=6.16.0)`;

test("provider URLs in free text are cut to scheme + host", () => {
  const out = redactRpcSecretsInText(ETHERS_403);
  assert.ok(!out.includes(KEY), out);
  assert.ok(out.includes("https://bsc-mainnet.core.chainstack.com/…"));
  assert.ok(out.includes("403 Forbidden"));
  assert.equal(
    redactRpcSecretsInText(`rpc https://robinhood-mainnet.core.chainstack.com/${KEY} failed`),
    "rpc https://robinhood-mainnet.core.chainstack.com/… failed",
  );
  assert.equal(
    redactRpcSecretsInText(`ws wss://mainnet.helius-rpc.com/?api-key=${KEY} closed`),
    "ws wss://mainnet.helius-rpc.com/… closed",
  );
});

test("any URL with a key query param is masked, whatever the host", () => {
  assert.equal(redactRpcSecretsInText(`https://rpc.example.org/?api-key=${KEY}`), "https://rpc.example.org/…");
  assert.equal(redactRpcSecretsInText(`https://rpc.example.org/x?token=${KEY}&a=1`), "https://rpc.example.org/…");
});

test("public RPCs, IPFS and logo URLs are left alone", () => {
  const text =
    "https://bsc-rpc.publicnode.com https://rpc.mainnet.chain.robinhood.com " +
    "https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG https://cdn.memewar.zone/logo/abc.png?v=2";
  assert.equal(redactRpcSecretsInText(text), text);
  assert.equal(redactRpcSecretsInText("no urls here"), "no urls here");
  assert.equal(redactRpcSecretsInText(""), "");
});

test("middleware masks res.json error bodies and keeps other bodies byte-identical", async () => {
  const app = express();
  app.use(redactRpcSecretsMiddleware);
  app.get("/status", (_req, res) => {
    res.json({ ok: true, runtime: { lastIndexerErrorMsg: ETHERS_403 } });
  });
  app.get("/token", (_req, res) => {
    res.json({ logo: "https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", price: 1.5 });
  });
  app.get("/fail", () => {
    throw new Error(`call to https://bsc-mainnet.core.chainstack.com/${KEY} failed`);
  });
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  });
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const status = await fetch(`${base}/status`);
    const statusText = await status.text();
    assert.ok(!statusText.includes(KEY), statusText);
    assert.equal(JSON.parse(statusText).ok, true);
    assert.ok(JSON.parse(statusText).runtime.lastIndexerErrorMsg.includes("https://bsc-mainnet.core.chainstack.com/…"));

    const token = await (await fetch(`${base}/token`)).json();
    assert.deepEqual(token, { logo: "https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", price: 1.5 });

    const fail = await fetch(`${base}/fail`);
    assert.equal(fail.status, 500);
    const failBody = await fail.json();
    assert.equal(failBody.error, "call to https://bsc-mainnet.core.chainstack.com/… failed");
  } finally {
    server.close();
  }
});
