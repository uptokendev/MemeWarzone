import assert from "node:assert/strict";
import test from "node:test";

import { STAGING_ARENA_V2_AUTHORITY } from "./arenaTournamentBuyInV2.mjs";
import {
  WAR_POOL_ABI,
  WAR_POOL_GENERATION_V1,
  WAR_POOL_GENERATION_V2,
  WAR_POOL_V2_ABI,
  battlePoolId,
  signResolvePoolV2,
  tournamentPoolId,
  warPoolAbiForGeneration,
  warPoolGeneration,
  warPoolTreasuryAddress,
} from "./arenaWarPoolEscrow.js";

const BSC = STAGING_ARENA_V2_AUTHORITY[97];
const RH = STAGING_ARENA_V2_AUTHORITY[46630];
const V1_BNB = "0x3333333333333333333333333333333333333333";
const WRONG = "0x2222222222222222222222222222222222222222";
const BNB_FALLBACK_ENV = {
  ARENA_WAR_POOL_TREASURY_ADDRESS: V1_BNB,
  VITE_ARENA_WAR_POOL_TREASURY_ADDRESS: V1_BNB,
  ARENA_WAR_POOL_TREASURY_ADDRESS_56: V1_BNB,
  ARENA_WAR_POOL_TREASURY_ADDRESS_97: V1_BNB,
};

test("46630 attested ArenaWarPoolTreasuryV2 address is accepted for battles", () => {
  const env = {
    ARENA_WAR_POOL_TREASURY_V2_ADDRESS_46630: RH.treasury,
    ARENA_WAR_POOL_TREASURY_V2_RUNTIME_HASH_46630: RH.runtimeHash,
    ...BNB_FALLBACK_ENV,
  };
  assert.equal(warPoolTreasuryAddress(46630, env), RH.treasury);
  assert.equal(warPoolGeneration(46630, env), WAR_POOL_GENERATION_V2);
});

test("46630 wrong V2 address throws and never falls back to BNB V1", () => {
  assert.throws(
    () => warPoolTreasuryAddress(46630, { ARENA_WAR_POOL_TREASURY_V2_ADDRESS_46630: WRONG, ...BNB_FALLBACK_ENV }),
    /attested authority/i,
  );
  assert.equal(warPoolTreasuryAddress(46630, BNB_FALLBACK_ENV), "");
  assert.equal(warPoolGeneration(46630, BNB_FALLBACK_ENV), "");
});

test("46630 wrong runtime hash fails closed", () => {
  assert.throws(
    () =>
      warPoolTreasuryAddress(46630, {
        ARENA_WAR_POOL_TREASURY_V2_ADDRESS_46630: RH.treasury,
        ARENA_WAR_POOL_TREASURY_V2_RUNTIME_HASH_46630: `0x${"11".repeat(32)}`,
      }),
    /runtime hash/i,
  );
});

test("4663 war-pool treasury is empty and never inherits BNB fallback", () => {
  const env = {
    ...BNB_FALLBACK_ENV,
    ARENA_WAR_POOL_TREASURY_V2_ADDRESS_4663: RH.treasury,
    ARENA_WAR_POOL_TREASURY_ADDRESS_4663: V1_BNB,
  };
  assert.equal(warPoolTreasuryAddress(4663, env), "");
  assert.equal(warPoolGeneration(4663, env), "");
});

test("97 attested V2 treasury is accepted and preferred over V1", () => {
  const env = {
    ARENA_WAR_POOL_TREASURY_V2_ADDRESS_97: BSC.treasury,
    ARENA_WAR_POOL_TREASURY_V2_RUNTIME_HASH_97: BSC.runtimeHash,
    ...BNB_FALLBACK_ENV,
  };
  assert.equal(warPoolTreasuryAddress(97, env), BSC.treasury);
  assert.equal(warPoolGeneration(97, env), WAR_POOL_GENERATION_V2);
});

test("97/56 keep V1 env fallback when V2 is unset so BNB does not break", () => {
  assert.equal(warPoolTreasuryAddress(97, BNB_FALLBACK_ENV), V1_BNB);
  assert.equal(warPoolGeneration(97, BNB_FALLBACK_ENV), WAR_POOL_GENERATION_V1);
  assert.equal(warPoolTreasuryAddress(56, { ARENA_WAR_POOL_TREASURY_ADDRESS: V1_BNB }), V1_BNB);
  assert.equal(warPoolGeneration(56, { ARENA_WAR_POOL_TREASURY_ADDRESS: V1_BNB }), WAR_POOL_GENERATION_V1);
});

test("97 wrong V2 address throws instead of silently using V1", () => {
  assert.throws(
    () => warPoolTreasuryAddress(97, { ARENA_WAR_POOL_TREASURY_V2_ADDRESS_97: WRONG, ...BNB_FALLBACK_ENV }),
    /attested authority/i,
  );
});

test("V2 battle ABI uses boost/league fields and keeps openBattlePool/depositStake", () => {
  const v2 = WAR_POOL_V2_ABI.join("\n");
  assert.match(v2, /openBattlePool/);
  assert.match(v2, /depositStake/);
  assert.match(v2, /boostTotal/);
  assert.match(v2, /pendingLeague/);
  assert.match(v2, /claimedLeague/);
  assert.match(v2, /claimLeague/);
  assert.doesNotMatch(v2, /supportTotal|pendingMwl|claimMwl|donateSupport/);
  assert.match(WAR_POOL_ABI.join("\n"), /supportTotal/);
  assert.match(WAR_POOL_ABI.join("\n"), /claimMwl/);
});

test("existing pool id helpers remain battle/tournament bound", () => {
  assert.match(battlePoolId("battle-1"), /^0x[0-9a-f]{64}$/i);
  assert.notEqual(battlePoolId("battle-1"), battlePoolId("battle-2"));
  assert.notEqual(battlePoolId("battle-1"), tournamentPoolId("battle-1"));
});

test("V2 ABI is selected only for war_pool_v2 generation", () => {
  assert.equal(warPoolAbiForGeneration(WAR_POOL_GENERATION_V2), WAR_POOL_V2_ABI);
  assert.equal(warPoolAbiForGeneration(WAR_POOL_GENERATION_V1), WAR_POOL_ABI);
  assert.equal(warPoolAbiForGeneration(""), WAR_POOL_ABI);
});

test("V2 resolve typed data uses version 2 and boostTotal not supportTotal", async () => {
  const previous = process.env.ARENA_WAR_POOL_RESOLVER_KEY;
  process.env.ARENA_WAR_POOL_RESOLVER_KEY = "0x" + "11".repeat(32);
  try {
    const signed = await signResolvePoolV2({
      treasuryAddress: RH.treasury,
      chainId: 46630,
      poolId: battlePoolId("battle-1"),
      winnerPayout: "0x1111111111111111111111111111111111111111",
      stakeTotal: 1n,
      buyInTotal: 0n,
      boostTotal: 2n,
      deadline: 1_800_000_000,
    });
    assert.equal(signed.domain.version, "2");
    assert.equal(signed.domain.chainId, 46630);
    assert.equal(signed.domain.verifyingContract, RH.treasury);
    assert.ok(signed.types.ResolvePoolV2);
    assert.equal(signed.types.ResolvePoolV2.some((field) => field.name === "boostTotal"), true);
    assert.equal(signed.types.ResolvePoolV2.some((field) => field.name === "supportTotal"), false);
    assert.match(signed.signature, /^0x[0-9a-f]{130}$/i);
  } finally {
    if (previous === undefined) delete process.env.ARENA_WAR_POOL_RESOLVER_KEY;
    else process.env.ARENA_WAR_POOL_RESOLVER_KEY = previous;
  }
});
