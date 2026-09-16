import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { STAGING_ARENA_V2_AUTHORITY } from "./arenaTournamentBuyInV2.mjs";
import { WAR_POOL_GENERATION_V2, WAR_POOL_V2_ABI } from "./arenaWarPoolEscrow.js";
import { escrowRequired, stakeToWei } from "./arenaWarPoolLive.js";

const RH = STAGING_ARENA_V2_AUTHORITY[46630];
const liveSource = fs.readFileSync(new URL("./arenaWarPoolLive.js", import.meta.url), "utf8");

test("escrowRequired(46630) is true when V2 env is set to the attested treasury", () => {
  const env = {
    ARENA_WAR_POOL_TREASURY_V2_ADDRESS_46630: RH.treasury,
    ARENA_WAR_POOL_TREASURY_V2_RUNTIME_HASH_46630: RH.runtimeHash,
  };
  assert.equal(escrowRequired(46630, env), true);
  assert.equal(escrowRequired(46630, {}), false);
});

test("escrowRequired(4663) stays false and ignores BNB V1 fallback", () => {
  assert.equal(
    escrowRequired(4663, {
      ARENA_WAR_POOL_TREASURY_ADDRESS: "0x3333333333333333333333333333333333333333",
      ARENA_WAR_POOL_TREASURY_ADDRESS_56: "0x3333333333333333333333333333333333333333",
      ARENA_WAR_POOL_TREASURY_V2_ADDRESS_97: STAGING_ARENA_V2_AUTHORITY[97].treasury,
    }),
    false,
  );
});

test("battle readOnchainPool selects V2 ABI and runtime-hash gates V2 treasuries", () => {
  assert.match(liveSource, /WAR_POOL_V2_ABI/);
  assert.match(liveSource, /warPoolGeneration\(chainId\)/);
  assert.match(liveSource, /generation === WAR_POOL_GENERATION_V2 \? WAR_POOL_V2_ABI : WAR_POOL_ABI/);
  assert.match(liveSource, /runtime hash mismatch/);
  assert.match(liveSource, /GENERATION\(\)/);
  assert.equal(WAR_POOL_GENERATION_V2, "war_pool_v2");
  assert.ok(WAR_POOL_V2_ABI.some((entry) => entry.includes("claimLeague")));
});

test("native stake parsing stays 18-decimal ETH/BNB wei", () => {
  assert.equal(stakeToWei(1), 10n ** 18n);
  assert.equal(stakeToWei("0.0042"), 4_200_000_000_000_000n);
});
