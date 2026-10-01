import assert from "node:assert/strict";
import test from "node:test";

import { POST_MAX_CHARS, buildPostCreateMessage, buildPostDeleteMessage, canonPostWallet } from "./postsCanon.js";

test("posts allow 1000 characters", () => {
  assert.equal(POST_MAX_CHARS, 1000);
});

const SOLANA_CHAIN = 101;
const EVM_CHAIN = 97;
const SOL_WALLET = "2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB";

test("post wallet keeps Solana base58 case", () => {
  assert.equal(canonPostWallet(SOLANA_CHAIN, SOL_WALLET), SOL_WALLET);
  assert.equal(
    canonPostWallet(EVM_CHAIN, "0x52D3c9E6E4E6C5D4C3B2A1908877665544332211"),
    "0x52d3c9e6e4e6c5d4c3b2a1908877665544332211",
  );
});

test("create message does not lowercase Solana identities", () => {
  const msg = buildPostCreateMessage({
    chainId: SOLANA_CHAIN,
    address: SOL_WALLET,
    nonce: "abc",
    body: "K88 is moving.",
  });
  assert.match(msg, /POST_CREATE/);
  assert.match(msg, new RegExp(SOL_WALLET));
  assert.match(msg, /K88 is moving/);
});

test("delete message binds the post id", () => {
  const msg = buildPostDeleteMessage({
    chainId: SOLANA_CHAIN,
    address: SOL_WALLET,
    nonce: "abc",
    postId: 42,
  });
  assert.match(msg, /POST_DELETE/);
  assert.match(msg, /PostId: 42/);
});

test("the signed post message carries the whole body, not a preview (no unsigned tail)", async () => {
  const { buildPostCreateMessage, POST_MAX_CHARS } = await import("./postsCanon.js");
  const body = "a".repeat(200) + " tail-that-must-be-signed " + "b".repeat(POST_MAX_CHARS - 226);
  const msg = buildPostCreateMessage({ chainId: 56, address: "0x" + "1".repeat(40), nonce: "n1", body });
  assert.ok(msg.endsWith(body.trim()), "message must end with the full trimmed body");
  assert.ok(msg.includes("tail-that-must-be-signed"));
});
