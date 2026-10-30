import assert from "node:assert/strict";
import test from "node:test";
import { tokenStatsChainId } from "./tokenStatsChain.ts";

test("supported chain ids pass through, including Robinhood", () => {
  assert.equal(tokenStatsChainId(56, "0x68C681F488Bae70DEEa2f1D375037958a0f80073"), 56);
  assert.equal(tokenStatsChainId(97), 97);
  assert.equal(tokenStatsChainId(101), 101);
  assert.equal(tokenStatsChainId(4663), 4663);
  assert.equal(tokenStatsChainId(46630, "0x68C681F488Bae70DEEa2f1D375037958a0f80073"), 46630);
});

test("a missing chain id stays 56, and a bare Solana address stays 101", () => {
  assert.equal(tokenStatsChainId(undefined), 56);
  assert.equal(tokenStatsChainId(null), 56);
  assert.equal(tokenStatsChainId(1, "0x68C681F488Bae70DEEa2f1D375037958a0f80073"), 56);
  assert.equal(tokenStatsChainId(1, "11111111111111111111111111111111"), 101);
});

test("DogeOS 6281971 stays itself and never asks the BNB book", () => {
  assert.equal(tokenStatsChainId(6281971, "0x68C681F488Bae70DEEa2f1D375037958a0f80073"), 6281971);
  assert.equal(tokenStatsChainId(6281971), 6281971);
});
