import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";

import { resolveSolanaDisplayMetadata } from "./projectImportResolverAdapters.js";

const PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const MINT = new PublicKey("So11111111111111111111111111111111111111112");

function stringField(value) {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

function metadataBytes(name, symbol) {
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.alloc(32, 1),
    MINT.toBuffer(),
    stringField(name),
    stringField(symbol),
  ]);
}

test("Solana project metadata resolves Metaplex name and ticker from on-chain account", async () => {
  let calls = 0;
  const connection = {
    async getAccountInfo() {
      calls += 1;
      return { owner: PROGRAM, data: metadataBytes("Derpy Dave", "DERPY") };
    },
  };
  const metadata = await resolveSolanaDisplayMetadata(connection, MINT);
  assert.deepEqual(metadata, {
    name: "Derpy Dave",
    symbol: "DERPY",
    source: "metaplex",
    type: "token_metadata_pda",
  });
  assert.equal(calls, 1, "Metaplex success must remain first authority and avoid fallback reads");
});

test("missing optional metadata does not invalidate a normal mint", async () => {
  const missing = await resolveSolanaDisplayMetadata({ async getAccountInfo() { return null; } }, MINT);
  assert.deepEqual(missing, { name: null, symbol: null, source: null, type: null });
});

test("malformed Metaplex metadata fails gracefully for display identity only", async () => {
  const connection = {
    async getAccountInfo(address) {
      if (!address.equals(MINT)) return { owner: PROGRAM, data: Buffer.from([4, 1, 2, 3]) };
      return null;
    },
  };
  const malformed = await resolveSolanaDisplayMetadata(connection, MINT);
  assert.deepEqual(malformed, { name: null, symbol: null, source: null, type: null });
});

test("metadata owned by a different program is ignored", async () => {
  const metadata = await resolveSolanaDisplayMetadata({
    async getAccountInfo(address) {
      if (!address.equals(MINT)) return { owner: MINT, data: metadataBytes("Wrong", "BAD") };
      return null;
    },
  }, MINT);
  assert.deepEqual(metadata, { name: null, symbol: null, source: null, type: null });
});

test("invalid mint input returns empty optional display metadata", async () => {
  const metadata = await resolveSolanaDisplayMetadata({ async getAccountInfo() { throw new Error("should not run"); } }, "not-a-public-key");
  assert.deepEqual(metadata, { name: null, symbol: null, source: null, type: null });
});
