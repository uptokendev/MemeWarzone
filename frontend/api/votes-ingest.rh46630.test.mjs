import assert from "node:assert/strict";
import test from "node:test";

import { assertVoteIngestChain } from "./votes-ingest.js";

test("assertVoteIngestChain accepts Robinhood testnet 46630", () => {
  assert.equal(assertVoteIngestChain(46630), 46630);
  assert.equal(assertVoteIngestChain("46630"), 46630);
});

test("assertVoteIngestChain accepts Robinhood production 4663 (mainnet UPVoteTreasury, 2026-09-24)", () => {
  assert.equal(assertVoteIngestChain(4663), 4663);
  assert.equal(assertVoteIngestChain("4663"), 4663);
  assert.throws(() => assertVoteIngestChain(1), /Invalid chainId/);
});

test("assertVoteIngestChain keeps BNB 56 and 97 accepted", () => {
  assert.equal(assertVoteIngestChain(56), 56);
  assert.equal(assertVoteIngestChain(97), 97);
});
