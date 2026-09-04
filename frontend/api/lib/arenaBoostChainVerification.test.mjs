import assert from "node:assert/strict";
import test from "node:test";
import { Interface, id } from "ethers";

import {
  assertBattleBoostEventMatches,
  battleBoostTreasuryV2Address,
  decodeBattleBoostLog,
  expectedBattleBoostPoolId,
  verifyBattleBoostPayment,
} from "./arenaBoostChainVerification.mjs";

const treasury = "0x1000000000000000000000000000000000000001";
const booster = "0x2000000000000000000000000000000000000002";
const sideToken = "0x3000000000000000000000000000000000000003";
const battleId = "battle-chain-proof";
const iface = new Interface([
  "event BattleBoosted(bytes32 indexed poolId,address indexed booster,address indexed sideToken,uint256 boostUnits,uint256 unitPriceNativeRaw,uint256 grossNativeRaw,uint256 pricingVersion,uint256 oracleTimestamp,uint256 nonce)",
]);

function eventLog(overrides = {}) {
  const values = {
    poolId: expectedBattleBoostPoolId(battleId),
    booster,
    sideToken,
    boostUnits: 3n,
    unitPriceNativeRaw: 25n,
    grossNativeRaw: 75n,
    pricingVersion: 4n,
    oracleTimestamp: 1_800_000_000n,
    nonce: 99n,
    ...overrides,
  };
  const fragment = iface.getEvent("BattleBoosted");
  const encoded = iface.encodeEventLog(fragment, [
    values.poolId,
    values.booster,
    values.sideToken,
    values.boostUnits,
    values.unitPriceNativeRaw,
    values.grossNativeRaw,
    values.pricingVersion,
    values.oracleTimestamp,
    values.nonce,
  ]);
  return { address: treasury, index: 7, topics: encoded.topics, data: encoded.data };
}

test("V2 treasury address is chain-bound and does not accept an unconfigured fallback", () => {
  assert.equal(
    battleBoostTreasuryV2Address(56, { ARENA_WAR_POOL_TREASURY_V2_ADDRESS_56: treasury }),
    treasury,
  );
  assert.throws(() => battleBoostTreasuryV2Address(4663, {}), /not configured/);
});

test("BattleBoosted log decoding preserves the signed quote fields", () => {
  const decoded = decodeBattleBoostLog(eventLog(), { treasuryAddress: treasury });
  assert.equal(decoded.poolId, id(`arena-battle:${battleId}`));
  assert.equal(decoded.booster.toLowerCase(), booster.toLowerCase());
  assert.equal(decoded.sideToken.toLowerCase(), sideToken.toLowerCase());
  assert.equal(decoded.boostUnits, 3n);
  assert.equal(decoded.grossNativeRaw, 75n);
  assert.equal(decoded.pricingVersion, 4n);
  assert.equal(decoded.nonce, 99n);
});

test("confirmed Boost proof rejects replay-shaped payload drift and broken price math", () => {
  const decoded = decodeBattleBoostLog(eventLog(), { treasuryAddress: treasury });
  assert.equal(
    assertBattleBoostEventMatches(decoded, { battleId, wallet: booster, targetToken: sideToken, boostUnits: 3, grossNativeRaw: 75 }),
    decoded,
  );
  assert.throws(
    () => assertBattleBoostEventMatches(decoded, { battleId: "other", wallet: booster, targetToken: sideToken, boostUnits: 3, grossNativeRaw: 75 }),
    /pool id/,
  );
  assert.throws(
    () => assertBattleBoostEventMatches(decoded, { battleId, wallet: booster, targetToken: sideToken, boostUnits: 4, grossNativeRaw: 75 }),
    /unit count/,
  );
  const badMath = decodeBattleBoostLog(eventLog({ grossNativeRaw: 76n }), { treasuryAddress: treasury });
  assert.throws(
    () => assertBattleBoostEventMatches(badMath, { battleId, wallet: booster, targetToken: sideToken, boostUnits: 3, grossNativeRaw: 76 }),
    /signed unit price/,
  );
});

test("payment verification requires the exact successful treasury log and derives confirmation time from-chain", async () => {
  const log = eventLog();
  const provider = {
    async getTransactionReceipt(txHash) {
      return { status: 1, hash: txHash, blockNumber: 123, logs: [log] };
    },
    async getBlock(blockNumber) {
      assert.equal(blockNumber, 123);
      return { timestamp: 1_800_000_100 };
    },
  };
  const proof = await verifyBattleBoostPayment({
    provider,
    chainId: 56,
    txHash: `0x${"a".repeat(64)}`,
    logIndex: 7,
    battleId,
    wallet: booster,
    targetToken: sideToken,
    boostUnits: 3,
    grossNativeRaw: 75,
    treasuryAddress: treasury,
  });
  assert.equal(proof.blockNumber, 123);
  assert.equal(proof.logIndex, 7);
  assert.equal(proof.boostUnits, 3n);
  assert.equal(proof.confirmedAt, new Date(1_800_000_100 * 1000).toISOString());

  await assert.rejects(
    verifyBattleBoostPayment({
      provider: { async getTransactionReceipt() { return { status: 0, logs: [] }; } },
      chainId: 56,
      txHash: `0x${"b".repeat(64)}`,
      logIndex: 7,
      battleId,
      wallet: booster,
      targetToken: sideToken,
      boostUnits: 3,
      grossNativeRaw: 75,
      treasuryAddress: treasury,
    }),
    /did not succeed/,
  );
});
