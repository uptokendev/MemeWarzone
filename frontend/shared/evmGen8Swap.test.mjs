// Encoders for gen-8 swaps through the UniversalRouter (shared/evmGen8Swap.mjs): every call is decoded back and
// compared field by field, for both router layouts, buys and sells, exact input and output, with and without a
// Permit2 permit. Execution against the real routers is in src/lib/evmGen8Client.chain.test.mjs (local forks).
import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, Wallet, getAddress, verifyTypedData } from "ethers";
import {
  GEN8_KNOWN_ROUTERS,
  GEN8_REFERRER_APP,
  GEN8_REFERRER_WIDGET,
  PERMIT2_ADDRESS,
  UR_COMMANDS,
  UR_MSG_SENDER,
  UR_NATIVE,
  assertGen8NativeRefund,
  buildGen8RouterCall,
  decodeGen8RouterCall,
  encodeGen8V4SwapInput,
  gen8BuyFeeSplit,
  gen8CreatorShareWei,
  gen8HookData,
  gen8MinOut,
  gen8PermitTypedData,
  gen8QuoterFor,
  gen8RouterFor,
  gen8SellFeeSplit,
  permitFromJson,
  permitToJson,
} from "./evmGen8Swap.mjs";
import { gen8PoolKey } from "./evmGen8.mjs";

const TOKEN = getAddress("0x1111111111111111111111111111111111111111");
const HOOK = getAddress("0x00000000000000000000000000000000000028ec");
const ROUTER = getAddress("0xDc264714F68d84CF29BC605589405E78bDBE7C9f");
const KEY = gen8PoolKey(TOKEN, HOOK);
const ZERO = "0x0000000000000000000000000000000000000000";
const coder = AbiCoder.defaultAbiCoder();

test("router per chain: defaults pinned to their layout; env overrides; an unknown router needs its layout", () => {
  assert.deepEqual(gen8RouterFor(56), { address: GEN8_KNOWN_ROUTERS[56][0].address, layout: "v2.1", label: "UniversalRouter 2.1.2" });
  assert.equal(gen8RouterFor(4663).address, getAddress("0x8876789976decbfcbbbe364623c63652db8c0904"));
  assert.equal(gen8RouterFor(4663).layout, "v2.1");
  assert.equal(gen8RouterFor(97), null, "testnets: env only");
  const v20 = gen8RouterFor(56, { VITE_EVM_GEN8_UNIVERSAL_ROUTER_56: "0x1906c1d672b88cd1b9ac7593301ca990f94eae07" });
  assert.deepEqual([v20.address, v20.layout], [getAddress("0x1906c1d672b88cd1b9ac7593301ca990f94eae07"), "v2.0"]);
  // a known router named with the wrong layout keeps its proven layout
  assert.equal(gen8RouterFor(56, { EVM_GEN8_UNIVERSAL_ROUTER_56: "0x1906c1d672b88cd1b9ac7593301ca990f94eae07", EVM_GEN8_UNIVERSAL_ROUTER_LAYOUT_56: "v2.1" }).layout, "v2.0");
  assert.equal(gen8RouterFor(97, { EVM_GEN8_UNIVERSAL_ROUTER_97: "0x00000000000000000000000000000000000000a1" }), null, "unknown router without a layout");
  assert.deepEqual(gen8RouterFor(97, { EVM_GEN8_UNIVERSAL_ROUTER_97: "0x00000000000000000000000000000000000000a1", EVM_GEN8_UNIVERSAL_ROUTER_LAYOUT_97: "v2.0" }).layout, "v2.0");
  assert.equal(gen8RouterFor(56, { EVM_GEN8_UNIVERSAL_ROUTER_56: "not-an-address" }), null);
  assert.equal(gen8QuoterFor(56), getAddress("0x9f75dd27d6664c475b90e105573e550ff69437b0"));
  assert.equal(gen8QuoterFor(97), null);
  assert.equal(gen8QuoterFor(97, { VITE_EVM_GEN8_V4_QUOTER_97: "0x00000000000000000000000000000000000000b2" }), getAddress("0x00000000000000000000000000000000000000b2"));
});

for (const layout of ["v2.0", "v2.1"]) {
  test(`${layout}: exact-input buy decodes back to one V4 swap native -> coin with SETTLE_ALL / TAKE_ALL bounds`, () => {
    const call = buildGen8RouterCall({ router: ROUTER, layout, poolKey: KEY, side: "buy", amount: 10n ** 17n, limit: 123_456n, deadline: 1_900_000_000n });
    assert.equal(call.to, ROUTER);
    assert.equal(call.value, 10n ** 17n);
    assert.equal(call.commands, "0x10");
    const d = decodeGen8RouterCall(call.data, layout);
    assert.deepEqual(d.commands, [UR_COMMANDS.V4_SWAP]);
    assert.equal(d.deadline, 1_900_000_000n);
    assert.equal(d.permit, null);
    assert.equal(d.sweep, null);
    assert.deepEqual(d.swap.poolKey, KEY);
    assert.equal(d.swap.exactIn, true);
    assert.equal(d.swap.zeroForOne, true);
    assert.equal(d.swap.amount, 10n ** 17n);
    assert.equal(d.swap.limit, 123_456n);
    assert.equal(d.swap.hopPriceX36, layout === "v2.0" ? null : 0n, "0 = no per-hop price check");
    assert.deepEqual(d.swap.settle, { currency: ZERO, amount: 10n ** 17n });
    assert.deepEqual(d.swap.take, { currency: TOKEN, amount: 123_456n });
    assert.equal(d.swap.hookData, gen8HookData(GEN8_REFERRER_APP));
  });

  test(`${layout}: sell with a Permit2 permit: PERMIT2_PERMIT then V4_SWAP coin -> native, value 0`, () => {
    const permit = { permitSingle: { details: { token: TOKEN, amount: 5n * 10n ** 24n, expiration: 1_900_001_800n, nonce: 3n }, spender: ROUTER, sigDeadline: 1_900_001_800n }, signature: "0x" + "ab".repeat(65) };
    const call = buildGen8RouterCall({ router: ROUTER, layout, poolKey: KEY, side: "sell", amount: 5n * 10n ** 24n, limit: 7n, deadline: 1_900_000_000n, permit, hookData: gen8HookData(GEN8_REFERRER_WIDGET) });
    assert.equal(call.value, 0n);
    assert.equal(call.commands, "0x0a10");
    const d = decodeGen8RouterCall(call.data, layout);
    assert.deepEqual(d.commands, [UR_COMMANDS.PERMIT2_PERMIT, UR_COMMANDS.V4_SWAP]);
    assert.deepEqual(d.permit, permit);
    assert.equal(d.swap.zeroForOne, false);
    assert.deepEqual(d.swap.settle, { currency: TOKEN, amount: 5n * 10n ** 24n });
    assert.deepEqual(d.swap.take, { currency: ZERO, amount: 7n });
    assert.equal(d.swap.hookData, gen8HookData(GEN8_REFERRER_WIDGET));
  });

  test(`${layout}: exact-output buy settles at most the limit and sweeps unspent native back to the sender`, () => {
    const call = buildGen8RouterCall({ router: ROUTER, layout, poolKey: KEY, side: "buy", exactIn: false, amount: 10n ** 24n, limit: 5n * 10n ** 17n, deadline: 1n });
    assert.equal(call.value, 5n * 10n ** 17n);
    const d = decodeGen8RouterCall(call.data, layout);
    assert.deepEqual(d.commands, [UR_COMMANDS.V4_SWAP, UR_COMMANDS.SWEEP]);
    assert.equal(d.swap.exactIn, false);
    assert.deepEqual(d.swap.settle, { currency: ZERO, amount: 5n * 10n ** 17n });
    assert.deepEqual(d.swap.take, { currency: TOKEN, amount: 10n ** 24n });
    assert.deepEqual(d.sweep, { token: ZERO, recipient: UR_MSG_SENDER, amountMin: 0n });
  });
}

test("F14: exact-output native buy ends with SWEEP(address(0) = native, address(1) = msg.sender, 0), byte for byte", () => {
  for (const layout of ["v2.0", "v2.1"]) {
    const call = buildGen8RouterCall({ router: ROUTER, layout, poolKey: KEY, side: "buy", exactIn: false, amount: 10n ** 24n, limit: 5n * 10n ** 17n, deadline: 1n });
    assert.equal(call.commands, "0x1004", "V4_SWAP (0x10) then SWEEP (0x04)");
    assert.equal(call.inputs.length, 2);
    assert.equal(call.inputs[1], `0x${"00".repeat(32)}${"00".repeat(31)}01${"00".repeat(32)}`, "abi.encode(address(0), address(1), uint256(0))");
    assert.equal(UR_NATIVE, ZERO);
    assert.equal(UR_MSG_SENDER, "0x0000000000000000000000000000000000000001");
    assert.doesNotThrow(() => assertGen8NativeRefund(decodeGen8RouterCall(call.data, layout)));
  }
  // exact-input buys and sells need no sweep: the router is paid exactly what it settles
  const buy = buildGen8RouterCall({ router: ROUTER, layout: "v2.1", poolKey: KEY, side: "buy", amount: 1n, limit: 0n, deadline: 1n });
  assert.doesNotThrow(() => assertGen8NativeRefund(decodeGen8RouterCall(buy.data, "v2.1")));
  const sell = buildGen8RouterCall({ router: ROUTER, layout: "v2.1", poolKey: KEY, side: "sell", exactIn: false, amount: 1n, limit: 9n, deadline: 1n });
  assert.equal(sell.commands, "0x10", "an exact-output sell pays coins, no native to sweep");
  assert.doesNotThrow(() => assertGen8NativeRefund(decodeGen8RouterCall(sell.data, "v2.1")));
});

test("F14 guard: a hand-built exact-output native buy without the SWEEP, or sweeping elsewhere, is refused", () => {
  const noSweep = { commands: [UR_COMMANDS.V4_SWAP], swap: { exactIn: false, zeroForOne: true }, sweep: null };
  assert.throws(() => assertGen8NativeRefund(noSweep), /sweep unspent native/);
  const elsewhere = { commands: [UR_COMMANDS.V4_SWAP, UR_COMMANDS.SWEEP], swap: { exactIn: false, zeroForOne: true }, sweep: { token: ZERO, recipient: getAddress("0x0000000000000000000000000000000000000002"), amountMin: 0n } };
  assert.throws(() => assertGen8NativeRefund(elsewhere), /sweep unspent native/, "address(2) = the router itself");
});

test("the two layouts are not interchangeable: the v2.1 single params carry one more word", () => {
  const a = encodeGen8V4SwapInput({ layout: "v2.0", poolKey: KEY, side: "buy", amount: 1n, limit: 0n });
  const b = encodeGen8V4SwapInput({ layout: "v2.1", poolKey: KEY, side: "buy", amount: 1n, limit: 0n });
  const [, pa] = coder.decode(["bytes", "bytes[]"], a);
  const [, pb] = coder.decode(["bytes", "bytes[]"], b);
  assert.equal((pb[0].length - pa[0].length) / 2, 32);
  assert.throws(() => decodeGen8RouterCall(buildGen8RouterCall({ router: ROUTER, layout: "v2.0", poolKey: KEY, side: "buy", amount: 1n, limit: 0n, deadline: 1n }).data, "v2.1"));
});

test("refusals: unknown layout, coin as currency0, zero amount, a permit on a buy, slippage out of range", () => {
  assert.throws(() => encodeGen8V4SwapInput({ layout: "v3", poolKey: KEY, side: "buy", amount: 1n, limit: 0n }), /layout/);
  assert.throws(() => encodeGen8V4SwapInput({ layout: "v2.1", poolKey: { ...KEY, currency0: TOKEN, currency1: ZERO }, side: "buy", amount: 1n, limit: 0n }), /native/);
  assert.throws(() => encodeGen8V4SwapInput({ layout: "v2.1", poolKey: KEY, side: "buy", amount: 0n, limit: 0n }), /positive/);
  assert.throws(() => buildGen8RouterCall({ router: ROUTER, layout: "v2.1", poolKey: KEY, side: "buy", amount: 1n, limit: 0n, deadline: 1n, permit: { permitSingle: {}, signature: "0x" } }), /sell/);
  assert.throws(() => gen8MinOut(100n, 6000), /slippage/);
  assert.equal(gen8MinOut(10_000n, 100), 9_900n);
});

test("Permit2 typed data: signed by the wallet, recovers, round-trips through JSON", async () => {
  const w = Wallet.createRandom();
  const typed = gen8PermitTypedData({ chainId: 56, token: TOKEN, amount: 42n * 10n ** 18n, nonce: 7n, spender: ROUTER, nowSec: 1_000 });
  assert.equal(typed.domain.verifyingContract, PERMIT2_ADDRESS);
  assert.equal(typed.message.details.expiration, 2_800n);
  assert.equal(typed.message.sigDeadline, 2_800n);
  const signature = await w.signTypedData(typed.domain, typed.types, typed.message);
  assert.equal(verifyTypedData(typed.domain, typed.types, typed.message, signature), w.address);
  const permit = { permitSingle: typed.message, signature };
  assert.deepEqual(permitFromJson(JSON.parse(JSON.stringify(permitToJson(permit)))), permit);
});

test("fee split for quotes: the hook's exact-input buy split and the gross-for-net of a sell (MwzFeeMath)", () => {
  assert.deepEqual(gen8BuyFeeSplit(10_200n, 200), { curveWei: 10_000n, feeWei: 200n });
  assert.deepEqual(gen8BuyFeeSplit(10n ** 18n, 9000), { curveWei: (10n ** 18n * 10_000n) / 19_000n, feeWei: 10n ** 18n - (10n ** 18n * 10_000n) / 19_000n });
  for (const rate of [100, 200, 4567, 9000]) {
    for (const net of [1n, 999n, 10n ** 15n + 7n, 12_345_678_901_234_567n]) {
      const { curveWei: p, feeWei } = gen8SellFeeSplit(net, rate);
      assert.equal(p - (p * BigInt(rate)) / 10_000n, net, "payout minus the hook's fee is the net");
      assert.ok(p - 1n - ((p - 1n) * BigInt(rate)) / 10_000n < net, "smallest such payout");
      assert.equal(feeWei, p - net);
    }
  }
  assert.equal(gen8CreatorShareWei({ graduated: false, curveWei: 10_000n, feeWei: 200n }), 11n, "560 bps of the bonding fee");
  assert.equal(gen8CreatorShareWei({ graduated: true, curveWei: 10_000n, feeWei: 100n }), 50n, "0.5% of volume after graduation");
});
