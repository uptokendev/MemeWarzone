// Shared gen-8 maths (frontend/shared/evmGen8.mjs) against independent computations. The on-chain equalities
// (hashRequest, authorizationDigest, Launched.firstBuyOut, MwzLaunchLens.progress) are proven on a local chain in
// api/dev-fix/evmGen8CreateAuthorization.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, Wallet, getBytes, hashMessage, keccak256, verifyMessage } from "ethers";
import {
  GEN8_CREATE_AUTH_TYPE, GEN8_TARGET_FAST_USD, GEN8_TARGET_TEST_USD, Q96, gen8AuthorizationPayload, gen8ExactInBuySplit, gen8FeeRate,
  gen8HashRequest, gen8MarketCapWei, gen8MetadataHash, gen8PoolId, gen8PoolKey, gen8Progress, isGen8TargetAllowed, nativePerCoinWei, sqrtAtTick,
} from "./evmGen8.mjs";

const coder = AbiCoder.defaultAbiCoder();

test("pool key and id: keccak256(abi.encode(native, token, 0x800000, 10, hook))", () => {
  const token = "0x00000000000000000000000000000000000000a8";
  const hook = "0x0000000000000000000000000000000000002aec";
  const k = gen8PoolKey(token, hook);
  assert.deepEqual([k.currency0, k.fee, k.tickSpacing], ["0x0000000000000000000000000000000000000000", 0x800000, 10]);
  assert.equal(gen8PoolId(token, hook), keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], ["0x0000000000000000000000000000000000000000", token, 0x800000, 10, hook])).toLowerCase());
});

test("TickMath: tick 0 is 2^96, symmetric ticks multiply to ~2^192, bounds", () => {
  assert.equal(sqrtAtTick(0), Q96);
  const p = sqrtAtTick(1000) * sqrtAtTick(-1000);
  assert.ok(p > (Q96 * Q96 * 999999n) / 1000000n && p < (Q96 * Q96 * 1000001n) / 1000000n);
  assert.equal(sqrtAtTick(-887272), 4295128739n);
  assert.equal(sqrtAtTick(887272), 1461446703485210103287273052203988822378723970342n);
  assert.throws(() => sqrtAtTick(887273));
});

test("price and fully diluted market cap from sqrtPriceX96 (coins per native)", () => {
  // 1 coin = 1 native when sqrtPrice = 2^96
  assert.equal(nativePerCoinWei(Q96), 10n ** 18n);
  assert.equal(gen8MarketCapWei(Q96), 1_000_000_000n * 10n ** 18n);
  // 4 coins per native -> 0.25 native per coin
  assert.equal(nativePerCoinWei(2n * Q96), 25n * 10n ** 16n);
});

test("progress: 0 at the start, complete at or past the top of A, graduated = complete", () => {
  const base = { liqA: 2485145006854016906826n, tickStart: 258260, tickGrad: 221110 };
  assert.equal(gen8Progress({ ...base, sqrtPriceX96: sqrtAtTick(258260) }).bps, 0);
  assert.equal(gen8Progress({ ...base, sqrtPriceX96: sqrtAtTick(221110) }).complete, true);
  assert.equal(gen8Progress({ ...base, sqrtPriceX96: sqrtAtTick(240000), graduated: true }).pct, 100);
  const mid = gen8Progress({ ...base, sqrtPriceX96: sqrtAtTick(240000) });
  assert.ok(mid.bps > 0 && mid.bps < 10_000);
  assert.ok(mid.capacityRaw > 849_999_999n * 10n ** 18n && mid.capacityRaw <= 850_000_001n * 10n ** 18n, "A holds 850M coins");
});

test("fee rate: launch window 90% -> 2% over 60 s, launcher 2%, graduated 1%", () => {
  assert.equal(gen8FeeRate({ graduated: false, launchTime: 1000, nowTs: 1000 }), 9000);
  assert.equal(gen8FeeRate({ graduated: false, launchTime: 1000, nowTs: 1030 }), 200 + Math.floor((8800 * 30) / 60));
  assert.equal(gen8FeeRate({ graduated: false, launchTime: 1000, nowTs: 1060 }), 200);
  assert.equal(gen8FeeRate({ graduated: false, isLauncher: true, launchTime: 1000, nowTs: 1000 }), 200);
  assert.equal(gen8FeeRate({ graduated: true, launchTime: 1000, nowTs: 1000 }), 100);
  const s = gen8ExactInBuySplit(102n, 200);
  assert.deepEqual([s.costWei, s.feeWei], [100n, 2n]);
});

test("targets: $30K / $50K everywhere, $150 on testnets and local only", () => {
  assert.equal(isGen8TargetAllowed(56, GEN8_TARGET_FAST_USD), true);
  assert.equal(isGen8TargetAllowed(56, GEN8_TARGET_TEST_USD), false);
  assert.equal(isGen8TargetAllowed(97, GEN8_TARGET_TEST_USD), true);
  assert.equal(isGen8TargetAllowed(4663, 15_000n * 10n ** 18n), false);
  assert.equal(isGen8TargetAllowed(56, "nope"), false);
});

test("create authorization payload: the launcher's abi.encode layout, personal-signed", async () => {
  const req = { name: "N", symbol: "S", logoURI: "L", xAccount: "X", website: "W", extraLink: "E", metadataHash: gen8MetadataHash({ name: "N" }), targetUsd: GEN8_TARGET_FAST_USD, feeChoice: 3, feeCreatorPct: 40, firstBuyValue: 5n, minFirstBuyOut: 7n, salt: 9n };
  const h = (s) => keccak256(new TextEncoder().encode(s));
  const reqHash = keccak256(coder.encode(
    ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint256", "uint8", "uint8", "uint256", "uint256", "uint256"],
    [h("N"), h("S"), h("L"), h("X"), h("W"), h("E"), req.metadataHash, req.targetUsd, 3, 40, 5n, 7n, 9n],
  ));
  assert.equal(gen8HashRequest(req), reqHash);
  const launcher = "0x00000000000000000000000000000000000000c8";
  const creator = "0x00000000000000000000000000000000000000d8";
  const payload = gen8AuthorizationPayload({ chainId: 56, launcher, creator, request: req, deadline: 123 });
  assert.equal(payload, keccak256(coder.encode(["bytes32", "uint256", "address", "address", "bytes32", "uint64"], [GEN8_CREATE_AUTH_TYPE, 56n, launcher, creator, reqHash, 123n])));
  const w = Wallet.createRandom();
  const sig = await w.signMessage(getBytes(payload));
  assert.equal(verifyMessage(getBytes(payload), sig), w.address);
  assert.equal(hashMessage(getBytes(payload)).length, 66);
  assert.notEqual(gen8AuthorizationPayload({ chainId: 4663, launcher, creator, request: req, deadline: 123 }), payload, "chain-bound");
});
