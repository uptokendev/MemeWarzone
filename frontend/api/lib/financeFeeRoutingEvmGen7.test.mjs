import assert from "node:assert/strict";
import test from "node:test";

import { evmFeeRoutingRegistry } from "./financeFeeRoutingEvm.js";

const GEN6_FINALIZE_TEXT = "2.2% of the raise (GRAD_PROTOCOL_BPS 220) to the router; 19.8% to the creator (GRAD_CREATOR_BPS 1980); about 78% to the pool";
const GEN6_TRADE_TEXT = "2% (protocolFeeBps 200); 50% falling to 2% over the first 60 s (anti-sniper)";

test("gen-7 graduation lane: 2% to the router, 0% to the creator, about 98% to the pool, on every EVM chain", () => {
  for (const chainId of [56, 4663, 97, 46630]) {
    const { flows } = evmFeeRoutingRegistry(chainId);
    const fin7 = flows.find((f) => f.id === "evm_finalize_gen7");
    assert.ok(fin7, `chain ${chainId}`);
    assert.equal(fin7.totalFee, "2% of the raise (GRAD_PROTOCOL_BPS 200) to the router; 0% to the creator (GRAD_CREATOR_BPS 0); about 98% to the pool");
    assert.ok(!fin7.splits.some((s) => /creator/.test(s.destinationId)), "no creator slice");
    const trade7 = flows.find((f) => f.id === "evm_trade_v4_gen7");
    assert.match(trade7.totalFee, /90% falling to 2% over the first 60 s/);
    for (const f of [fin7, trade7]) assert.ok(!/—/.test(JSON.stringify(f)), "no em dashes in copy");
  }
});

test("gen-6 lanes keep their text and their place", () => {
  for (const chainId of [56, 4663, 97, 46630]) {
    const { flows } = evmFeeRoutingRegistry(chainId);
    assert.equal(flows.find((f) => f.id === "evm_finalize").totalFee, GEN6_FINALIZE_TEXT);
    assert.equal(flows.find((f) => f.id === "evm_trade_v4").totalFee, GEN6_TRADE_TEXT);
    assert.equal(flows[0].id, "evm_trade_v4");
  }
  const mainnetIds = evmFeeRoutingRegistry(56).flows.map((f) => f.id);
  assert.deepEqual(mainnetIds.slice(0, 3), ["evm_trade_v4", "evm_trade_v3", "evm_finalize"]);
  assert.deepEqual(evmFeeRoutingRegistry(97).flows.map((f) => f.id).slice(0, 2), ["evm_trade_v4", "evm_finalize"]);
});

test("gen-7 lockers from EVM_GEN7_LOCKER_<id> are appended after the pinned locker; unset changes nothing", () => {
  const L1 = "0x6666666666666666666666666666666666666666";
  const L2 = "0x7777777777777777777777777777777777777777";
  for (const chainId of [56, 4663, 97, 46630]) {
    assert.deepEqual(evmFeeRoutingRegistry(chainId, {}), evmFeeRoutingRegistry(chainId, { EVM_GEN7_LOCKER_1: L1 }), "other chains' env is ignored");
  }
  const plain = evmFeeRoutingRegistry(56, {});
  assert.ok(!plain.destinations.some((d) => d.id.startsWith("lp_locker_gen7")));
  const reg = evmFeeRoutingRegistry(56, { EVM_GEN7_LOCKER_56: `${L1},${L2},bogus` });
  const ids = reg.destinations.map((d) => d.id);
  const at = ids.indexOf("lp_locker");
  assert.deepEqual(ids.slice(at, at + 3), ["lp_locker", "lp_locker_gen7_1", "lp_locker_gen7_2"]);
  assert.deepEqual(reg.destinations.filter((d) => d.id !== "lp_locker_gen7_1" && d.id !== "lp_locker_gen7_2"), plain.destinations, "existing entries unchanged");
  assert.equal(reg.destinations[at + 1].address, L1);
  assert.equal(reg.destinations[at + 1].label, "PermanentLpLocker (gen-7) 1");
  assert.deepEqual(reg.destinations[at + 1].assets, ["native", "WBNB"]);
  const wiring = reg.wiring.filter((w) => w.id.startsWith("lp_locker_gen7"));
  assert.deepEqual(wiring.map((w) => [w.contract, w.getter, w.expected]), [[L1, "treasuryRouter", plain.wiring.find((w) => w.id === "locker_router").expected], [L2, "treasuryRouter", plain.wiring.find((w) => w.id === "locker_router").expected]]);
  assert.equal(reg.alerts.filter((a) => /EVM_GEN7_LOCKER_56/.test(a.message)).length, 1, "the bad entry is reported");

  const rh = evmFeeRoutingRegistry(46630, { EVM_GEN7_LOCKER_46630: L1 });
  const d = rh.destinations.find((x) => x.id === "lp_locker_gen7_1");
  assert.equal(d.label, "PermanentV3PositionLocker (gen-7)");
  assert.deepEqual(d.assets, ["native", "WETH"]);
});
