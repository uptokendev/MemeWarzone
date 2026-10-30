// Pure parts of the DogeOS Bark fork rehearsal (barkswap plan t27, spec section 5 Gate 3): the L1-fee byte margin,
// per-step cost, per-role aggregation, funding and running-cost math, the app gas-floor / reserve verdicts and the
// report schema. scripts/rehearse-dogeos-bark-fork.ts drives the fork and calls these; the full fork run is the
// integration evidence.
//
//   node --test scripts/rehearse-dogeos-bark-fork.test.mjs
//
// No network, no hardhat, no key.
import assert from "node:assert/strict";
import test from "node:test";
import {
  BLOCK_GAS_LIMIT,
  BUDGET_ROLES,
  L1_MARGIN,
  appGasLimit,
  assertNoSecrets,
  buildStep,
  dailyRunningCost,
  floorVerdict,
  formatDoge,
  l1MarginBytes,
  paddedForL1,
  recommendFunding,
  reserveVerdict,
  roleTotals,
  stepCost,
  validateReport,
} from "./lib/dogeosBarkBudget.mjs";

const DOGE = 10n ** 18n;
const byteLen = (hex) => (hex.length - 2) / 2;

test("l1MarginBytes: at least 64 bytes, else 5% of the raw length rounded up", () => {
  assert.deepEqual(L1_MARGIN, { minBytes: 64, pct: 5 });
  assert.equal(l1MarginBytes(0), 64);
  assert.equal(l1MarginBytes(400), 64);
  assert.equal(l1MarginBytes(1280), 64);
  assert.equal(l1MarginBytes(1281), 65);
  assert.equal(l1MarginBytes(24_000), 1200);
  assert.equal(l1MarginBytes(100, { minBytes: 10, pct: 50 }), 50);
  assert.throws(() => l1MarginBytes(-1), /length/);
});

test("paddedForL1: keeps the raw bytes as a prefix and appends the margin as deterministic non-zero filler", () => {
  const raw = "0x02f8" + "ab".repeat(98);
  const padded = paddedForL1(raw);
  assert.equal(byteLen(padded), byteLen(raw) + 64);
  assert.ok(padded.startsWith(raw));
  const filler = padded.slice(raw.length);
  assert.ok(filler.match(/../g).every((b) => b !== "00"), "no zero byte in the filler");
  assert.equal(new Set(filler.match(/../g)).size > 32, true, "the filler is not a repeated byte (L1 fee charges compressibility)");
  assert.equal(paddedForL1(raw), padded, "deterministic");
  assert.throws(() => paddedForL1("0xabc"), /hex/);
  assert.throws(() => paddedForL1("abcd"), /hex/);
});

test("stepCost: L2 fee = gas x L2 price, total = L2 + L1; refuses non-bigint and negative inputs", () => {
  assert.deepEqual(stepCost({ gas: 100_000n, l2GasPriceWei: 15_680_108n, l1FeeWei: 22_000_000_000_000_000n }), {
    l2FeeWei: 1_568_010_800_000n,
    l1FeeWei: 22_000_000_000_000_000n,
    totalWei: 22_001_568_010_800_000n,
  });
  assert.throws(() => stepCost({ gas: 1, l2GasPriceWei: 1n, l1FeeWei: 1n }), /bigint/);
  assert.throws(() => stepCost({ gas: 1n, l2GasPriceWei: -1n, l1FeeWei: 1n }), /negative/);
});

test("buildStep: decimal-string record with both oracle sources; a step above the 10M block is refused", () => {
  const s = buildStep({
    name: "launch",
    role: "creator",
    lane: "lifecycle",
    gas: 6_000_000n,
    rawTxBytes: 1000,
    l1Bytes: 1064,
    l2GasPriceWei: 10n,
    l1FeeWei: { latest: 5n, forkBlock: 7n },
  });
  assert.deepEqual(s, {
    name: "launch",
    role: "creator",
    lane: "lifecycle",
    gas: "6000000",
    rawTxBytes: 1000,
    l1Bytes: 1064,
    l2FeeWei: "60000000",
    l1FeeWei: "5",
    totalWei: "60000005",
    l1FeeWeiAtForkBlock: "7",
    totalWeiAtForkBlock: "60000007",
  });
  assert.equal(BLOCK_GAS_LIMIT, 10_000_000n);
  const at = (gas) => buildStep({ name: "x", role: "keeper", lane: "lifecycle", gas, rawTxBytes: 1, l1Bytes: 65, l2GasPriceWei: 1n, l1FeeWei: { latest: 0n, forkBlock: 0n } });
  assert.equal(at(10_000_000n).gas, "10000000");
  assert.throws(() => at(10_000_001n), /x: gas 10000001 > 10000000/);
  assert.throws(() => buildStep({ ...at(1n), role: "nobody", gas: 1n, l2GasPriceWei: 1n, l1FeeWei: { latest: 0n, forkBlock: 0n } }), /role/);
});

test("roleTotals: sums per role for both sources, lists every budget role (0 when it sent nothing)", () => {
  const mk = (role, gas, l1, l1f) =>
    buildStep({ name: `${role}-${gas}`, role, lane: "lifecycle", gas, rawTxBytes: 1, l1Bytes: 65, l2GasPriceWei: 2n, l1FeeWei: { latest: l1, forkBlock: l1f } });
  const steps = [mk("deployer", 10n, 100n, 1000n), mk("deployer", 5n, 50n, 500n), mk("keeper", 1n, 3n, 30n), mk("buyer", 7n, 1n, 1n)];
  const t = roleTotals(steps);
  assert.deepEqual(Object.keys(t).slice(0, BUDGET_ROLES.length), [...BUDGET_ROLES]);
  assert.deepEqual(t.deployer, { txs: 2, gas: "15", l2FeeWei: "30", l1FeeWei: "150", totalWei: "180", totalWeiAtForkBlock: "1530" });
  assert.deepEqual(t.keeper, { txs: 1, gas: "1", l2FeeWei: "2", l1FeeWei: "3", totalWei: "5", totalWeiAtForkBlock: "32" });
  assert.deepEqual(t.routeAuthority, { txs: 0, gas: "0", l2FeeWei: "0", l1FeeWei: "0", totalWei: "0", totalWeiAtForkBlock: "0" });
  assert.deepEqual(t.buyer, { txs: 1, gas: "7", l2FeeWei: "14", l1FeeWei: "1", totalWei: "15", totalWeiAtForkBlock: "15" });
});

test("dailyRunningCost: per role, count per day x the measured cost of that step kind; an unknown kind is refused", () => {
  const perKind = { collect: 10n, convert: 20n, route: 7n };
  const d = dailyRunningCost(perKind, { keeper: { collect: 4, convert: 2 }, operator: { route: 24 } });
  assert.deepEqual(d, { keeper: 80n, operator: 168n });
  assert.throws(() => dailyRunningCost(perKind, { keeper: { buyback: 1 } }), /buyback/);
});

test("recommendFunding: headroom x (one-off + days x daily), rounded up to a whole DOGE", () => {
  const r = recommendFunding({ deployer: 10n * DOGE + 1n, keeper: DOGE }, { keeper: DOGE / 2n }, { headroom: 3, days: 7 });
  assert.equal(r.deployer.recommendedWei, (31n * DOGE).toString(), "3 x 10.000...01 = 30.000...03 -> 31 DOGE");
  assert.equal(r.deployer.oneOffWei, (10n * DOGE + 1n).toString());
  assert.equal(r.deployer.dailyWei, "0");
  assert.equal(r.keeper.recommendedWei, (14n * DOGE).toString(), "3 x (1 + 7 x 0.5) = 13.5 -> 14 DOGE");
  assert.equal(r.keeper.recommendedDoge, "14");
  assert.throws(() => recommendFunding({ a: 1n }, {}, { headroom: 0, days: 1 }), /headroom/);
});

test("appGasLimit mirrors the app's gasWithHeadroom: estimate x 1.25 + 50,000, never below the floor", () => {
  assert.equal(appGasLimit(1_000_000n, 7_000_000n), 7_000_000n);
  assert.equal(appGasLimit(6_000_000n, 7_000_000n), 7_550_000n);
  assert.equal(appGasLimit(200_000n, null), 300_000n);
});

test("floorVerdict: the floor suffices when it covers the largest measured gas; reports whether it binds and fits the block", () => {
  assert.deepEqual(floorVerdict({ name: "launch", floor: 7_000_000n, maxGasUsed: 5_200_000n }), {
    name: "launch",
    floor: "7000000",
    maxGasUsed: "5200000",
    appGasLimit: "7000000",
    suffices: true,
    floorBinds: true,
    withinBlock: true,
  });
  const over = floorVerdict({ name: "launch", floor: 7_000_000n, maxGasUsed: 7_600_000n });
  assert.equal(over.suffices, false);
  assert.equal(over.appGasLimit, "9550000");
  assert.equal(over.withinBlock, true);
  assert.equal(floorVerdict({ name: "x", floor: 1_000_000n, maxGasUsed: 8_000_000n }).withinBlock, false);
});

test("reserveVerdict: the wallet must hold gasLimit x price + the L1 fee; reports need and shortfall", () => {
  const v = reserveVerdict({ name: "buy", reserveWei: 10n ** 16n, gasUsed: 300_000n, floor: 1_000_000n, l2GasPriceWei: 15_680_108n, l1FeeWei: 45_000_000_000_000_000n });
  assert.equal(v.gasLimit, "1000000");
  assert.equal(v.neededWei, (1_000_000n * 15_680_108n + 45_000_000_000_000_000n).toString());
  assert.equal(v.suffices, false);
  assert.equal(v.shortfallWei, (1_000_000n * 15_680_108n + 45_000_000_000_000_000n - 10n ** 16n).toString());
  const ok = reserveVerdict({ name: "buy", reserveWei: DOGE, gasUsed: 1n, floor: 1n, l2GasPriceWei: 1n, l1FeeWei: 1n });
  assert.equal(ok.suffices, true);
  assert.equal(ok.shortfallWei, "0");
});

test("formatDoge: 6 decimals, rounded up so a budget is never under-stated", () => {
  assert.equal(formatDoge(0n), "0.000000");
  assert.equal(formatDoge(DOGE), "1.000000");
  assert.equal(formatDoge(1n), "0.000001");
  assert.equal(formatDoge(12_345_678_900_000_000_000n), "12.345679");
});

test("assertNoSecrets: refuses 32-byte hex values (keys look like that) and secret-named fields", () => {
  assertNoSecrets({ steps: [{ name: "launch", gas: "1" }], address: "0x5300000000000000000000000000000000000002" });
  assert.throws(() => assertNoSecrets({ x: "0x" + "ab".repeat(32) }), /32-byte hex/);
  assert.throws(() => assertNoSecrets({ nested: ["ab".repeat(32)] }), /32-byte hex/);
  assert.throws(() => assertNoSecrets({ privateKey: "x" }), /privateKey/);
  assert.throws(() => assertNoSecrets({ a: { mnemonic: "x" } }), /mnemonic/);
});

function sampleReport() {
  const step = buildStep({ name: "launch", role: "creator", lane: "lifecycle", gas: 5_000_000n, rawTxBytes: 1000, l1Bytes: 1064, l2GasPriceWei: 1n, l1FeeWei: { latest: 1n, forkBlock: 2n } });
  const steps = [step];
  return {
    kind: "dogeos-bark-fork-rehearsal",
    version: 1,
    generatedAt: "2026-10-17T00:00:00.000Z",
    chainId: 6281971,
    forkBlock: 8578734,
    evm: "x",
    oracle: { address: "0x5300000000000000000000000000000000000002", method: "getL1Fee(bytes)", primary: "latest", sources: {} },
    l2GasPrice: { usedWei: "1" },
    l1Margin: L1_MARGIN,
    steps,
    failedSteps: [],
    maxStepGas: "5000000",
    roles: roleTotals(steps),
    totals: { budgetWei: "0", budgetDoge: "0.000000", budgetWeiAtForkBlock: "0" },
    recommendedFunding: {},
    runningCostPerDay: {},
    verdicts: { gasFloors: [], reserves: [] },
  };
}

test("validateReport: accepts a complete report; refuses a missing field, an empty step list, a step above 10M, a failed step and a secret", () => {
  validateReport(sampleReport());
  for (const key of ["chainId", "forkBlock", "oracle", "steps", "roles", "recommendedFunding", "verdicts", "totals", "failedSteps"]) {
    const r = sampleReport();
    delete r[key];
    assert.throws(() => validateReport(r), new RegExp(key));
  }
  assert.throws(() => validateReport({ ...sampleReport(), steps: [] }), /no steps/);
  assert.throws(() => validateReport({ ...sampleReport(), chainId: 1 }), /6281971/);
  const big = sampleReport();
  big.steps[0].gas = "10000001";
  assert.throws(() => validateReport(big), /launch: gas 10000001/);
  const missing = sampleReport();
  delete missing.steps[0].l1FeeWei;
  assert.throws(() => validateReport(missing), /launch: l1FeeWei/);
  assert.throws(() => validateReport({ ...sampleReport(), failedSteps: [{ name: "x", error: "boom" }] }), /failed step x/);
  assert.throws(() => validateReport({ ...sampleReport(), note: "0x" + "11".repeat(32) }), /32-byte hex/);
});

test("app reserves: the rehearsal reads the app's DogeOS floors and live estimate from the frontend module, never a copy (t34)", async () => {
  const budget = await import("./lib/dogeosBarkBudget.mjs");
  const app = await import("../frontend/shared/dogeosGasReserve.mjs");
  for (const name of ["DOGE_BUY_RESERVE_FLOOR_WEI", "DOGE_LAUNCH_RESERVE_FLOOR_WEI", "DOGEOS_BUY_GAS_LIMIT", "DOGEOS_LAUNCH_GAS_LIMIT", "L1_MARGIN", "dogeosReserveFromFees", "l1MarginBytes", "paddedForL1"]) {
    assert.equal(budget[name], app[name], name);
  }
  assert.equal(budget.DOGE_BUY_RESERVE_FLOOR_WEI, 5n * 10n ** 16n);
  assert.equal(budget.DOGE_LAUNCH_RESERVE_FLOOR_WEI, 2n * 10n ** 17n);
  const { readFileSync } = await import("node:fs");
  const script = readFileSync(new URL("./rehearse-dogeos-bark-fork.ts", import.meta.url), "utf8");
  assert.doesNotMatch(script, /APP_(BUY|LAUNCH)_RESERVE_WEI/);
  assert.doesNotMatch(script, /reserveWei: 10n \*\*/);
  assert.match(script, /reserveWei: buyFloor/);
  assert.match(script, /reserveWei: launchFloor/);
  assert.match(script, /budget\.dogeosReserveFromFees\(\{ kind: "buy"/);
  assert.match(script, /budget\.dogeosReserveFromFees\(\{ kind: "launch"/);
});
