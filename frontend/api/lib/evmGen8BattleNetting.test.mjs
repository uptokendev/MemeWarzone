// Audit D-L2: battle volume nets one transaction's gen-8 legs by one wallet (evmGen8BattleNetting.js), only for
// gen-8 coins on chains where gen-8 is configured. Run: node --test api/lib/evmGen8BattleNetting.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { netGen8BattleTrades } from "./evmGen8BattleNetting.js";
import { computeEligibleBattleVolume } from "./arenaBattleVolume.js";

const CHAIN = 97;
const GEN8_ENV = {
  [`EVM_GEN8_LAUNCHER_${CHAIN}`]: "0x00000000000000000000000000000000000000c8",
  [`EVM_GEN8_HOOK_${CHAIN}`]: "0x0000000000000000000000000000000000002aec",
  [`EVM_GEN8_POOL_MANAGER_${CHAIN}`]: "0x00000000000000000000000000000000000000e8",
};
const setGen8 = (on) => { for (const [k, v] of Object.entries(GEN8_ENV)) { if (on) process.env[k] = v; else delete process.env[k]; } };
const { loadBattleWindowTrades } = await import("./arenaBattleMetrics.js");

const E18 = 10n ** 18n;
const milli = (n) => ((BigInt(n) * E18) / 1000n).toString();
const COIN = "0x00000000000000000000000000000000000000a9";
const W4 = "0x0000000000000000000000000000000000000004";
const W5 = "0x0000000000000000000000000000000000000005";
const WASH = `0x${"ab".repeat(32)}`;
const T = "2026-10-10T12:00:00.000Z";
const liveAt = "2026-10-10T00:00:00.000Z";
const finishAt = "2026-10-11T00:00:00.000Z";

// market_trades_v rows: W4 buys 1.000 and sells 0.980 in one transaction; W5 buys 0.050 in its own.
const viewRows = () => [
  { campaignAddress: COIN, tokenAddress: COIN, source: "bonding", side: "buy", wallet: W4, recipient: W4, nativeAmountRaw: milli(1000), txHash: WASH, logIndex: 7, blockTime: T, status: "confirmed" },
  { campaignAddress: COIN, tokenAddress: COIN, source: "bonding", side: "sell", wallet: W4, recipient: W4, nativeAmountRaw: milli(980), txHash: WASH, logIndex: 9, blockTime: T, status: "confirmed" },
  { campaignAddress: COIN, tokenAddress: COIN, source: "bonding", side: "buy", wallet: W5, recipient: W5, nativeAmountRaw: milli(50), txHash: `0x${"cd".repeat(32)}`, logIndex: 1, blockTime: T, status: "confirmed" },
];

function fakeQuery(generation) {
  const calls = [];
  const query = async (text, params) => {
    calls.push(text);
    if (/from public\.market_trades_v/.test(text)) return { rows: viewRows() };
    if (/from public\.campaigns/.test(text)) return { rows: generation === null ? [] : [{ factory_generation: generation, graduated_at_chain: null }] };
    throw new Error(`unexpected query ${text}`);
  };
  return { query, calls };
}
const load = (deps) => loadBattleWindowTrades({ chainId: CHAIN, campaignAddress: COIN, tokenAddress: COIN, liveAt, finishAt }, { nativeUsd: 1000, ...deps });

test("netGen8BattleTrades: buy 1.000 + sell 0.980 in one transaction = one buy of 0.020; single legs unchanged", () => {
  const legs = [
    { wallet: W4, side: "buy", nativeAmount: milli(1000), usdAmount: 1000, valuationHealthy: true, valuationSource: "native_quote_fx", txHash: WASH, logIndex: 7 },
    { wallet: W4.toUpperCase().replace("0X", "0x"), side: "sell", nativeAmount: milli(980), usdAmount: 980, valuationHealthy: true, valuationSource: "native_quote_fx", txHash: WASH.toUpperCase().replace("0X", "0x"), logIndex: 9 },
    { wallet: W5, side: "buy", nativeAmount: milli(50), usdAmount: 50, valuationHealthy: true, txHash: "0x01", logIndex: 1 },
  ];
  const out = netGen8BattleTrades(legs);
  assert.equal(out.length, 2);
  assert.equal(out[0].side, "buy");
  assert.equal(out[0].nativeAmount, milli(20));
  assert.ok(Math.abs(out[0].usdAmount - 20) < 1e-9);
  assert.equal(out[0].logIndex, 9, "last leg");
  assert.equal(out[0].nettedLegs, 2);
  assert.equal(out[1], legs[2], "a one-leg transaction is the same object");

  // net sell, zero net, unhealthy leg, other wallet in the same transaction
  const sell = netGen8BattleTrades([
    { wallet: W4, side: "buy", nativeAmount: "100", usdAmount: 1, valuationHealthy: true, txHash: WASH, logIndex: 1 },
    { wallet: W4, side: "sell", nativeAmount: "130", usdAmount: 1.3, valuationHealthy: true, txHash: WASH, logIndex: 2 },
    { wallet: W5, side: "buy", nativeAmount: "100", usdAmount: 1, valuationHealthy: true, txHash: WASH, logIndex: 3 },
  ]);
  assert.deepEqual(sell.map((t) => [t.wallet, t.side, t.nativeAmount]), [[W4, "sell", "30"], [W5, "buy", "100"]]);
  assert.deepEqual(netGen8BattleTrades([
    { wallet: W4, side: "buy", nativeAmount: "100", usdAmount: 1, txHash: WASH, logIndex: 1 },
    { wallet: W4, side: "sell", nativeAmount: "100", usdAmount: 1, txHash: WASH, logIndex: 2 },
  ]), [], "a zero net leaves no trade");
  const unpriced = netGen8BattleTrades([
    { wallet: W4, side: "buy", nativeAmount: "100", usdAmount: 1, valuationHealthy: true, txHash: WASH, logIndex: 1 },
    { wallet: W4, side: "sell", nativeAmount: "40", usdAmount: null, valuationHealthy: false, txHash: WASH, logIndex: 2 },
  ]);
  assert.equal(unpriced[0].usdAmount, null);
  assert.equal(unpriced[0].valuationHealthy, false);
});

test("loadBattleWindowTrades: a gen-8 coin's wash pair counts as 0.020 of volume, not 1.980", async () => {
  setGen8(true);
  try {
    const { query } = fakeQuery(8);
    const trades = await load({ query });
    assert.equal(trades.length, 2);
    const vol = computeEligibleBattleVolume({ trades, liveAt, finishAt });
    assert.ok(Math.abs(vol.rawUsd - 70) < 1e-6, `net 20 + 50 USD at $1000/native, got ${vol.rawUsd}`);
  } finally {
    setGen8(false);
  }
});

test("loadBattleWindowTrades: gen-7 coins and chains without gen-8 are unchanged (no extra query)", async () => {
  setGen8(true);
  try {
    const { query } = fakeQuery(7);
    const trades = await load({ query });
    assert.equal(trades.length, 3, "a gen-7 coin keeps both legs");
    const unknown = await load({ query: fakeQuery(null).query });
    assert.equal(unknown.length, 3, "no campaigns row and no chain read: not netted");
  } finally {
    setGen8(false);
  }
  const off = fakeQuery(8);
  const trades = await load({ query: off.query });
  assert.equal(trades.length, 3);
  assert.equal(off.calls.length, 1, "only the market_trades_v read without gen-8 config");
  const vol = computeEligibleBattleVolume({ trades, liveAt, finishAt });
  assert.ok(Math.abs(vol.rawUsd - 2030) < 1e-6);
});
