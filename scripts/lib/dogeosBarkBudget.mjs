/**
 * DogeOS Bark fork rehearsal (barkswap plan t27, spec section 5 Gate 3): the pure parts of the DOGE budget. The fork
 * driver (scripts/rehearse-dogeos-bark-fork.ts) measures every step's gas and raw-transaction bytes and reads
 * L1GasPriceOracle.getL1Fee for those bytes; this module turns that into per-step costs, per-role totals, funding
 * recommendations, the app gas-floor / reserve verdicts and the checked report. No network, no hardhat, no key
 * (tests: scripts/rehearse-dogeos-bark-fork.test.mjs).
 *
 * Every amount is a bigint in wei (DOGE, 18 decimals); the report carries them as decimal strings.
 */

/** Chikyū's block gas limit (eth_getBlockByNumber gasLimit 0x989680): every transaction must fit. */
export const BLOCK_GAS_LIMIT = 10_000_000n;
/** Spec section 5: a launch stays under ~7M. */
export const LAUNCH_GAS_GATE = 7_000_000n;

/**
 * Margin added to a transaction's raw bytes before getL1Fee (MINORS: "add margin to raw-tx bytes for L1 fee"). The
 * fork's raw transaction differs from the real one in nonce, gas limit, fee fields and signature, and a real launch
 * carries user-chosen strings (name, symbol, links) that may be longer than the rehearsal's: at least 64 bytes, or 5%
 * of the raw length when that is more.
 */
export const L1_MARGIN = Object.freeze({ minBytes: 64, pct: 5 });

/** Roles we fund (spec "Roles and keys (B9)"), in report order. */
export const BUDGET_ROLES = Object.freeze(["deployer", "keeper", "operator", "oracleUpdater", "routeAuthority"]);
/** Roles that send in the rehearsal but are not ours to fund: app users, and Barkswap's admin in the incident lane. */
export const OTHER_ROLES = Object.freeze(["creator", "buyer", "barkswapAdmin"]);
const ALL_ROLES = new Set([...BUDGET_ROLES, ...OTHER_ROLES]);

function assertBig(name, v) {
  if (typeof v !== "bigint") throw new TypeError(`${name} must be a bigint`);
  if (v < 0n) throw new RangeError(`${name} is negative`);
}

/** Bytes of margin for a raw transaction of `len` bytes. */
export function l1MarginBytes(len, margin = L1_MARGIN) {
  if (!Number.isSafeInteger(len) || len < 0) throw new RangeError(`bad raw length ${len}`);
  return Math.max(margin.minBytes, Math.ceil((len * margin.pct) / 100));
}

/**
 * `rawHex` with the margin appended. The filler is deterministic and incompressible-looking (xorshift bytes, never
 * zero): Chikyū's oracle prices by size and compressibility (a repeated byte is cheaper than random bytes of the same
 * length), so the filler must not be a cheap pattern.
 */
export function paddedForL1(rawHex, margin = L1_MARGIN) {
  if (typeof rawHex !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(rawHex)) throw new TypeError("rawHex must be 0x-prefixed whole-byte hex");
  const len = (rawHex.length - 2) / 2;
  const extra = l1MarginBytes(len, margin);
  let x = 0x9e3779b9 ^ len;
  let out = "";
  for (let i = 0; i < extra; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    const b = (x & 0xff) || 0x5a;
    out += b.toString(16).padStart(2, "0");
  }
  return rawHex + out;
}

/** One transaction's DOGE cost: L2 execution (gas used x the L2 gas price) plus the L1 data fee. */
export function stepCost({ gas, l2GasPriceWei, l1FeeWei }) {
  assertBig("gas", gas);
  assertBig("l2GasPriceWei", l2GasPriceWei);
  assertBig("l1FeeWei", l1FeeWei);
  const l2FeeWei = gas * l2GasPriceWei;
  return { l2FeeWei, l1FeeWei, totalWei: l2FeeWei + l1FeeWei };
}

/**
 * A report step. `l1FeeWei.latest` is the live oracle at "latest" (the primary budget source); `l1FeeWei.forkBlock`
 * the same oracle at the fork block. Refuses a step above the block gas limit and an unknown role.
 */
export function buildStep({ name, role, lane, gas, rawTxBytes, l1Bytes, l2GasPriceWei, l1FeeWei }) {
  if (!ALL_ROLES.has(role)) throw new Error(`${name}: unknown role ${role}`);
  assertBig("gas", gas);
  if (gas > BLOCK_GAS_LIMIT) throw new Error(`${name}: gas ${gas} > ${BLOCK_GAS_LIMIT} (Chikyū block)`);
  const now = stepCost({ gas, l2GasPriceWei, l1FeeWei: l1FeeWei.latest });
  const then = stepCost({ gas, l2GasPriceWei, l1FeeWei: l1FeeWei.forkBlock });
  return {
    name,
    role,
    lane,
    gas: gas.toString(),
    rawTxBytes,
    l1Bytes,
    l2FeeWei: now.l2FeeWei.toString(),
    l1FeeWei: now.l1FeeWei.toString(),
    totalWei: now.totalWei.toString(),
    l1FeeWeiAtForkBlock: then.l1FeeWei.toString(),
    totalWeiAtForkBlock: then.totalWei.toString(),
  };
}

/** Per-role totals over report steps; every budget role is listed (0 when it sent nothing), then any other role seen. */
export function roleTotals(steps) {
  const zero = () => ({ txs: 0, gas: 0n, l2FeeWei: 0n, l1FeeWei: 0n, totalWei: 0n, totalWeiAtForkBlock: 0n });
  const acc = new Map(BUDGET_ROLES.map((r) => [r, zero()]));
  for (const s of steps) {
    if (!acc.has(s.role)) acc.set(s.role, zero());
    const t = acc.get(s.role);
    t.txs += 1;
    t.gas += BigInt(s.gas);
    t.l2FeeWei += BigInt(s.l2FeeWei);
    t.l1FeeWei += BigInt(s.l1FeeWei);
    t.totalWei += BigInt(s.totalWei);
    t.totalWeiAtForkBlock += BigInt(s.totalWeiAtForkBlock);
  }
  const out = {};
  for (const [role, t] of acc) {
    out[role] = {
      txs: t.txs,
      gas: t.gas.toString(),
      l2FeeWei: t.l2FeeWei.toString(),
      l1FeeWei: t.l1FeeWei.toString(),
      totalWei: t.totalWei.toString(),
      totalWeiAtForkBlock: t.totalWeiAtForkBlock.toString(),
    };
  }
  return out;
}

/** wei per day per role: sum over step kinds of (sends per day x the measured cost of one such send). */
export function dailyRunningCost(costPerKindWei, activityPerDay) {
  const out = {};
  for (const [role, kinds] of Object.entries(activityPerDay)) {
    let total = 0n;
    for (const [kind, perDay] of Object.entries(kinds)) {
      const cost = costPerKindWei[kind];
      if (cost === undefined) throw new Error(`no measured cost for step kind ${kind}`);
      assertBig(kind, cost);
      total += cost * BigInt(perDay);
    }
    out[role] = total;
  }
  return out;
}

const DOGE = 10n ** 18n;
const ceilDiv = (a, b) => (a + b - 1n) / b;

/** headroom x (one-off + days x daily) per role, rounded up to a whole DOGE. */
export function recommendFunding(oneOffWei, dailyWei, { headroom, days }) {
  if (!Number.isInteger(headroom) || headroom < 1) throw new RangeError("headroom must be an integer >= 1");
  if (!Number.isInteger(days) || days < 0) throw new RangeError("days must be an integer >= 0");
  const roles = new Set([...Object.keys(oneOffWei), ...Object.keys(dailyWei)]);
  const out = {};
  for (const role of roles) {
    const once = oneOffWei[role] ?? 0n;
    const daily = dailyWei[role] ?? 0n;
    assertBig(`${role} one-off`, once);
    assertBig(`${role} daily`, daily);
    const wholeDoge = ceilDiv(BigInt(headroom) * (once + BigInt(days) * daily), DOGE);
    out[role] = {
      oneOffWei: once.toString(),
      dailyWei: daily.toString(),
      recommendedWei: (wholeDoge * DOGE).toString(),
      recommendedDoge: wholeDoge.toString(),
    };
  }
  return out;
}

/** The app's gas limit (frontend/src/lib/evmGasHeadroom.mjs gasWithHeadroom): estimate x 1.25 + 50,000, at least the floor. */
export function appGasLimit(estimate, floor) {
  const padded = (estimate * 125n) / 100n + 50_000n;
  return floor != null && padded < floor ? floor : padded;
}

/** Does the app's gas floor cover the largest gas measured for that kind of transaction? */
export function floorVerdict({ name, floor, maxGasUsed }) {
  const limit = appGasLimit(maxGasUsed, floor);
  return {
    name,
    floor: floor.toString(),
    maxGasUsed: maxGasUsed.toString(),
    appGasLimit: limit.toString(),
    suffices: maxGasUsed <= floor,
    floorBinds: limit === floor,
    withinBlock: limit <= BLOCK_GAS_LIMIT,
  };
}

/**
 * Does the app's DOGE reserve cover what a wallet must hold for the transaction besides its value: the app's gas
 * limit x the L2 gas price (what the node checks up front) plus the L1 data fee?
 */
export function reserveVerdict({ name, reserveWei, gasUsed, floor, l2GasPriceWei, l1FeeWei }) {
  const gasLimit = appGasLimit(gasUsed, floor);
  const neededWei = gasLimit * l2GasPriceWei + l1FeeWei;
  return {
    name,
    reserveWei: reserveWei.toString(),
    gasLimit: gasLimit.toString(),
    l2GasPriceWei: l2GasPriceWei.toString(),
    l1FeeWei: l1FeeWei.toString(),
    neededWei: neededWei.toString(),
    suffices: reserveWei >= neededWei,
    shortfallWei: (reserveWei >= neededWei ? 0n : neededWei - reserveWei).toString(),
  };
}

/** wei as DOGE with 6 decimals, rounded up (a budget is never under-stated). */
export function formatDoge(wei) {
  const micro = ceilDiv(BigInt(wei), 10n ** 12n);
  return `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, "0")}`;
}

const SECRET_KEY = /private|secret|mnemonic|seed/i;
const HEX32 = /(?:^|[^0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?:[^0-9a-fA-F]|$)/;

/** Throws if anything in `value` looks like a key: a 32-byte hex string, or a field named private / secret / mnemonic / seed. */
export function assertNoSecrets(value, where = "report") {
  if (typeof value === "string") {
    if (HEX32.test(value)) throw new Error(`${where}: a 32-byte hex value (keys look like that) is not allowed in the report`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, `${where}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) throw new Error(`${where}.${k}: secret-named field not allowed in the report`);
      assertNoSecrets(v, `${where}.${k}`);
    }
  }
}

const REQUIRED = ["kind", "chainId", "forkBlock", "generatedAt", "evm", "oracle", "l2GasPrice", "l1Margin", "steps", "failedSteps", "maxStepGas", "roles", "totals", "recommendedFunding", "runningCostPerDay", "verdicts"];
const STEP_FIELDS = ["name", "role", "lane", "gas", "rawTxBytes", "l1Bytes", "l2FeeWei", "l1FeeWei", "totalWei", "l1FeeWeiAtForkBlock", "totalWeiAtForkBlock"];

/** The report contract the Verify step reads: every field present, every step within the block, no failed step, no secret. */
export function validateReport(r) {
  for (const k of REQUIRED) if (!(k in r)) throw new Error(`report: ${k} missing`);
  if (r.kind !== "dogeos-bark-fork-rehearsal") throw new Error("report: kind");
  if (r.chainId !== 6281971) throw new Error("report: chainId must be 6281971");
  if (!Array.isArray(r.steps) || r.steps.length === 0) throw new Error("report: no steps");
  for (const s of r.steps) {
    for (const f of STEP_FIELDS) if (!(f in s)) throw new Error(`report step ${s.name}: ${f} missing`);
    if (BigInt(s.gas) > BLOCK_GAS_LIMIT) throw new Error(`${s.name}: gas ${s.gas} > ${BLOCK_GAS_LIMIT} (Chikyū block)`);
    if (BigInt(s.totalWei) !== BigInt(s.l2FeeWei) + BigInt(s.l1FeeWei)) throw new Error(`${s.name}: totalWei != l2 + l1`);
  }
  if (!Array.isArray(r.failedSteps)) throw new Error("report: failedSteps must be a list");
  for (const f of r.failedSteps) throw new Error(`report: failed step ${f.name}: ${f.error}`);
  assertNoSecrets(r);
  return true;
}
