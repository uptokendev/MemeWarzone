import assert from "node:assert/strict";
import test from "node:test";

// Importing the API modules constructs the shared pg Pool but does not connect until queried.
// Give the module a syntactically valid local URL so this focused config test stays offline.
process.env.DATABASE_URL ||= "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

const { evmVoteNativeConfig } = await import("./arenaVotes.js");
const { assertVoteIngestChain } = await import("./votes-ingest.js");

test("Robinhood staging 46630 is accepted and prices the $3 vote in ETH/USD", () => {
  assert.deepEqual(evmVoteNativeConfig(46630), {
    chainId: 46630,
    nativeSymbol: "ETH",
    priceAssetId: "ethereum",
    binanceSymbol: "ETHUSDT",
  });
  assert.equal(assertVoteIngestChain(46630), 46630);
});

test("Robinhood production 4663: Arena UpVotes stay refused (no arena treasury there); launchpad UP-vote ingest is open since 2026-09-24", () => {
  assert.throws(() => evmVoteNativeConfig(4663), /4663.*not allowed/i);
  assert.equal(assertVoteIngestChain(4663), 4663);
});

test("BNB chains 56 and 97 remain BNB/USD", () => {
  for (const chainId of [56, 97]) {
    const config = evmVoteNativeConfig(chainId);
    assert.equal(config.chainId, chainId);
    assert.equal(config.nativeSymbol, "BNB");
    assert.equal(config.priceAssetId, "binancecoin");
    assert.equal(config.binanceSymbol, "BNBUSDT");
    assert.equal(assertVoteIngestChain(chainId), chainId);
  }
});
