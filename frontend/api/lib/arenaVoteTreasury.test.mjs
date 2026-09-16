import assert from "node:assert/strict";
import test from "node:test";

import { arenaEvmTreasury, arenaVotingConfigured } from "./arenaVoteTreasury.js";

const RH = "0xcDA6e2ca98c4BD6e831Ec04d4ED390535A6Da65C";
const BNB = "0x1111111111111111111111111111111111111111";

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("46630 uses suffixed Arena vote treasury and never inherits unsuffixed BNB", () => {
  withEnv({
    ARENA_VOTE_TREASURY_ADDRESS: BNB,
    VITE_ARENA_VOTE_TREASURY_ADDRESS: BNB,
    ARENA_VOTE_TREASURY_ADDRESS_46630: RH,
  }, () => {
    assert.equal(arenaEvmTreasury(46630), RH.toLowerCase());
  });
  withEnv({
    ARENA_VOTE_TREASURY_ADDRESS: BNB,
    VITE_ARENA_VOTE_TREASURY_ADDRESS: BNB,
    ARENA_VOTE_TREASURY_ADDRESS_46630: "",
    VITE_ARENA_VOTE_TREASURY_ADDRESS_46630: "",
  }, () => {
    assert.equal(arenaEvmTreasury(46630), "");
  });
});

test("4663 never inherits unsuffixed BNB vote treasury", () => {
  withEnv({
    ARENA_VOTE_TREASURY_ADDRESS: BNB,
    ARENA_VOTE_TREASURY_ADDRESS_4663: "",
  }, () => {
    assert.equal(arenaEvmTreasury(4663), "");
  });
});

test("56/97 still accept unsuffixed BNB fallback", () => {
  withEnv({
    ARENA_VOTE_TREASURY_ADDRESS: BNB,
    ARENA_VOTE_TREASURY_ADDRESS_56: "",
    VITE_ARENA_VOTE_TREASURY_ADDRESS_56: "",
    ARENA_VOTE_TREASURY_ADDRESS_97: "",
    VITE_ARENA_VOTE_TREASURY_ADDRESS_97: "",
  }, () => {
    assert.equal(arenaEvmTreasury(56), BNB.toLowerCase());
    assert.equal(arenaEvmTreasury(97), BNB.toLowerCase());
  });
});

test("arenaVotingConfigured includes 46630", () => {
  withEnv({
    ARENA_VOTE_TREASURY_ADDRESS: "",
    VITE_ARENA_VOTE_TREASURY_ADDRESS: "",
    ARENA_VOTE_TREASURY_ADDRESS_56: "",
    ARENA_VOTE_TREASURY_ADDRESS_97: "",
    ARENA_VOTE_TREASURY_ADDRESS_46630: RH,
    SOLANA_ARENA_VOTE_TREASURY_ADDRESS: "",
    VITE_SOLANA_ARENA_VOTE_TREASURY_ADDRESS: "",
  }, () => {
    assert.equal(arenaVotingConfigured(), true);
  });
});
