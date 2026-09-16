import assert from "node:assert/strict";
import test from "node:test";

import { assertVoteIngestChain } from "./votes-ingest.js";

test("assertVoteIngestChain accepts Robinhood testnet 46630", () => {
  assert.equal(assertVoteIngestChain(46630), 46630);
  assert.equal(assertVoteIngestChain("46630"), 46630);
});

test("assertVoteIngestChain rejects Robinhood production 4663", () => {
  assert.throws(
    () => assertVoteIngestChain(4663),
    (error) => {
      assert.equal(error?.status, 400);
      assert.match(String(error?.message || ""), /4663.*not allowed/i);
      return true;
    },
  );
});

test("assertVoteIngestChain keeps BNB 56 and 97 accepted", () => {
  assert.equal(assertVoteIngestChain(56), 56);
  assert.equal(assertVoteIngestChain(97), 97);
});
