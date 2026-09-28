/**
 * Pure (targetUsdMicros, stepUsdMicros, creatorFeeMode) -> DBC config params.
 * Builds a 16-point curve that follows today's linear price path (D9).
 */
import { createHash } from "node:crypto";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DammV2DynamicFeeMode,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  Rounding,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurve,
  buildCurveWithCustomSqrtPrices,
  feeNumeratorToBps,
  getBaseFeeNumerator,
  getDeltaAmountBaseUnsigned,
  getDeltaAmountBaseUnsigned256,
  getDeltaAmountQuoteUnsigned,
  getInitialLiquidityFromDeltaBase,
  getInitialLiquidityFromDeltaQuote,
  getLockedVestingParams,
  getNextSqrtPriceFromBaseAmountOutRoundingUp,
  getSqrtPriceFromPrice,
  getSwapAmountWithBuffer,
  getTotalVestingAmount,
  getBaseTokenForSwap,
  getMigrationThresholdPrice,
  validateConfigParameters,
  MIN_SQRT_PRICE,
  MAX_SQRT_PRICE,
  U128_MAX,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  DBC_ANTI_SNIPER_DURATION_SECONDS,
  DBC_ANTI_SNIPER_END_FEE_BPS,
  DBC_ANTI_SNIPER_PERIODS,
  DBC_ANTI_SNIPER_START_FEE_BPS,
  DBC_BASE_PRICE_LAMPORTS,
  DBC_CREATOR_MIGRATION_FEE_PCT,
  DBC_CREATOR_PERM_LOCK_PCT,
  DBC_CURVE_POINTS,
  DBC_ENABLE_FIRST_SWAP_WITH_MIN_FEE,
  DBC_GRADUATED_POOL_FEE_BPS,
  DBC_LOCKED_VESTING,
  DBC_MIGRATION_FEE_PCT,
  DBC_NANO_LAMPORTS_PER_LAMPORT,
  DBC_PARTNER_PERM_LOCK_PCT,
  DBC_PRICE_SLOPE_LAMPORTS,
  DBC_QUOTE_DECIMALS,
  DBC_RESERVE_RAW,
  DBC_RESERVE_WHOLE,
  DBC_SUPPLY_CEILING_RAW,
  DBC_TOKEN_DECIMALS,
  DBC_TOKEN_SCALE,
  creatorTradingFeePct,
  isCreatorFeeMode,
  migrationSplitLamports,
  roundUpToWholeTokens,
  thresholdLamportsFor,
} from "../../../shared/dbcEconomics.mjs";

const DUMMY_LEFTOVER = new PublicKey("11111111111111111111111111111112");

export function linearCostLamports(soldRaw, slope = DBC_PRICE_SLOPE_LAMPORTS) {
  const s = BigInt(soldRaw);
  if (s <= 0n) return 0n;
  const slopeDenom = DBC_TOKEN_SCALE * DBC_NANO_LAMPORTS_PER_LAMPORT;
  return (DBC_BASE_PRICE_LAMPORTS * s) / DBC_TOKEN_SCALE
    + (BigInt(slope) * s * s) / (2n * slopeDenom * DBC_TOKEN_SCALE);
}

export function linearMarginalLamports(soldRaw, slope = DBC_PRICE_SLOPE_LAMPORTS) {
  const s = BigInt(soldRaw);
  const slopeDenom = DBC_TOKEN_SCALE * DBC_NANO_LAMPORTS_PER_LAMPORT;
  return DBC_BASE_PRICE_LAMPORTS + (BigInt(slope) * s) / slopeDenom;
}

/** Exact (fractional) lamports per whole token; integer division here collapses early points. */
export function exactMarginalLamports(soldRaw, slope = DBC_PRICE_SLOPE_LAMPORTS) {
  const s = BigInt(soldRaw);
  const slopeDenom = Number(DBC_TOKEN_SCALE * DBC_NANO_LAMPORTS_PER_LAMPORT);
  return Number(DBC_BASE_PRICE_LAMPORTS) + Number(BigInt(slope) * s) / slopeDenom;
}

function soldRawFromExactLamports(pLamports, slope) {
  if (!(pLamports > 1)) return 0n;
  const slopeDenom = Number(DBC_TOKEN_SCALE * DBC_NANO_LAMPORTS_PER_LAMPORT);
  const raw = Math.round((pLamports - 1) * slopeDenom / Number(slope));
  if (!Number.isFinite(raw) || raw <= 0) return 0n;
  return BigInt(raw);
}

export function liquidityBitLength(liquidity) {
  const n = BigInt(liquidity?.toString?.() ?? liquidity ?? 0);
  if (n <= 0n) return 0;
  return n.toString(2).length;
}

function curveOverflow(message) {
  return Object.assign(new Error(message), { code: "DBC_CURVE_OVERFLOW" });
}

function assertSqrtInRange(label, sqrt) {
  if (sqrt.lt(MIN_SQRT_PRICE) || sqrt.gt(MAX_SQRT_PRICE)) {
    throw curveOverflow(`${label} is outside [MIN_SQRT_PRICE, MAX_SQRT_PRICE]`);
  }
}

function assertLiquidityU128(label, liquidity) {
  if (liquidity.isNeg() || liquidity.gt(U128_MAX)) {
    throw curveOverflow(`${label} does not fit u128 (${liquidityBitLength(liquidity)} bits)`);
  }
}

function sqrtPriceFromExactLamports(pLamports) {
  const sol = pLamports / 1e9;
  return getSqrtPriceFromPrice(sol.toExponential(18), DBC_TOKEN_DECIMALS, DBC_QUOTE_DECIMALS);
}

export function linearSoldForCost(costLamports, slope = DBC_PRICE_SLOPE_LAMPORTS) {
  const T = BigInt(costLamports);
  if (T <= 0n) return 0n;
  let lo = 0n;
  let hi = DBC_SUPPLY_CEILING_RAW;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (linearCostLamports(mid, slope) <= T) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

function linearEconomics(thresholdLamports, slope) {
  const soldRaw = linearSoldForCost(thresholdLamports, slope);
  const pEnd = linearMarginalLamports(soldRaw, slope);
  const { poolLamports, creatorGraduationLamports, ourGraduationLamports } = migrationSplitLamports(thresholdLamports);
  const poolTokens = pEnd > 0n ? (poolLamports * DBC_TOKEN_SCALE) / pEnd : 0n;
  const mintedRaw = soldRaw + poolTokens + DBC_RESERVE_RAW;
  return {
    soldRaw,
    pEnd,
    poolLamports,
    poolTokens,
    creatorGraduationLamports,
    ourGraduationLamports,
    mintedRaw,
    slope,
  };
}

function finalizeSoldPoints(soldAt, soldRaw) {
  const out = soldAt.filter((s, i) => i === 0 || s > soldAt[i - 1]);
  out[0] = 0n;
  out[out.length - 1] = soldRaw;
  return out;
}

/** Pack where dP/P is largest (the start). 16 points, seven in the first 8% of sold. */
export function soldPointsPackedStart(soldRaw, slope) {
  const fracs = [0, 0.0002, 0.0006, 0.0015, 0.003, 0.007, 0.015, 0.03, 0.06, 0.12, 0.22, 0.35, 0.5, 0.68, 0.85, 1];
  const soldAt = [];
  for (const f of fracs) {
    let s = (soldRaw * BigInt(Math.round(f * 1e9))) / 1_000_000_000n;
    if (soldAt.length && s <= soldAt[soldAt.length - 1]) s = soldAt[soldAt.length - 1] + DBC_TOKEN_SCALE;
    if (s > soldRaw) s = soldRaw;
    soldAt.push(s);
  }
  void slope;
  return finalizeSoldPoints(soldAt, soldRaw);
}

/** Equal price-ratio spacing in exact (fractional) lamports, then mapped back to sold. */
export function soldPointsEqualPriceRatio(soldRaw, slope) {
  const n = DBC_CURVE_POINTS;
  const p0 = exactMarginalLamports(0n, slope);
  const p1 = exactMarginalLamports(soldRaw, slope);
  const ratio = p1 / p0;
  const soldAt = [0n];
  for (let i = 1; i < n - 1; i += 1) {
    const pLamports = p0 * ratio ** (i / (n - 1));
    let s = soldRawFromExactLamports(pLamports, slope);
    if (s <= soldAt[soldAt.length - 1]) s = soldAt[soldAt.length - 1] + DBC_TOKEN_SCALE;
    if (s >= soldRaw) break;
    soldAt.push(s);
  }
  soldAt.push(soldRaw);
  return finalizeSoldPoints(soldAt, soldRaw);
}

/** Review 1 item 4: equal price-ratio had the lower tail error (see the packing table in the test). */
export const PRODUCTION_SOLD_POINTS = soldPointsEqualPriceRatio;

function curveFromSoldPoints(soldRaw, slope, soldAt) {
  const pts = [];
  for (const s of soldAt) {
    const sqrt = sqrtPriceFromExactLamports(exactMarginalLamports(s, slope));
    if (pts.length && !sqrt.gt(pts[pts.length - 1].sqrt)) continue;
    pts.push({ s, sqrt });
  }
  if (!pts.length) throw curveOverflow("DBC curve has no sqrt prices");
  const endSqrt = sqrtPriceFromExactLamports(exactMarginalLamports(soldRaw, slope));
  if (pts[pts.length - 1].s !== soldRaw) {
    if (!endSqrt.gt(pts[pts.length - 1].sqrt)) {
      throw curveOverflow("DBC end sqrt price is not strictly greater than the previous point");
    }
    pts.push({ s: soldRaw, sqrt: endSqrt });
  }
  if (pts.length < 2) throw curveOverflow("DBC curve needs at least two distinct sqrt prices");

  for (const [i, pt] of pts.entries()) assertSqrtInRange(i === 0 ? "sqrtStartPrice" : `curve[${i - 1}].sqrtPrice`, pt.sqrt);

  const curve = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const ds = pts[i + 1].s - pts[i].s;
    let L;
    try {
      L = getInitialLiquidityFromDeltaBase(
        new BN((ds > 0n ? ds : 1n).toString()),
        pts[i + 1].sqrt,
        pts[i].sqrt,
      );
    } catch (error) {
      throw curveOverflow(`curve[${i}].liquidity overflow: ${error.message}`);
    }
    assertLiquidityU128(`curve[${i}].liquidity`, L);
    curve.push({ sqrtPrice: pts[i + 1].sqrt, liquidity: L });
  }
  let qFull = 0n;
  let lower = pts[0].sqrt;
  for (const pt of curve) {
    qFull += BigInt(getDeltaAmountQuoteUnsigned(lower, pt.sqrtPrice, pt.liquidity, Rounding.Down).toString());
    lower = pt.sqrtPrice;
  }
  return { sqrtStartPrice: pts[0].sqrt, curve, qFull };
}

function buildLinearCurve(thresholdLamports, soldRaw, slope, soldPoints = PRODUCTION_SOLD_POINTS) {
  const T = BigInt(thresholdLamports);
  const soldAt = soldPoints(soldRaw, slope);
  const built = curveFromSoldPoints(soldRaw, slope, soldAt);
  if (built.curve.length) {
    const last = built.curve[built.curve.length - 1];
    const prev = built.curve.length > 1 ? built.curve[built.curve.length - 2].sqrtPrice : built.sqrtStartPrice;
    let qPrev = new BN(0);
    let lower = built.sqrtStartPrice;
    for (let i = 0; i < built.curve.length - 1; i += 1) {
      qPrev = qPrev.add(getDeltaAmountQuoteUnsigned(lower, built.curve[i].sqrtPrice, built.curve[i].liquidity, Rounding.Down));
      lower = built.curve[i].sqrtPrice;
    }
    const lastQ = new BN(T.toString()).sub(qPrev);
    if (lastQ.gtn(0)) {
      let L;
      try {
        L = getInitialLiquidityFromDeltaQuote(lastQ, prev, last.sqrtPrice);
      } catch (error) {
        throw curveOverflow(`last-segment liquidity overflow: ${error.message}`);
      }
      assertLiquidityU128("curve[last].liquidity", L);
      last.liquidity = L;
    }
  }
  return { sqrtStartPrice: built.sqrtStartPrice, curve: built.curve, sqrtPrices: [built.sqrtStartPrice, ...built.curve.map((p) => p.sqrtPrice)] };
}

function feeEnvelope({ creatorFeePct }) {
  return buildCurve({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: DBC_QUOTE_DECIMALS,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000_000,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: DBC_ANTI_SNIPER_START_FEE_BPS,
          endingFeeBps: DBC_ANTI_SNIPER_END_FEE_BPS,
          numberOfPeriod: DBC_ANTI_SNIPER_PERIODS,
          totalDuration: DBC_ANTI_SNIPER_DURATION_SECONDS,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: creatorFeePct,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: DBC_ENABLE_FIRST_SWAP_WITH_MIN_FEE,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: { feePercentage: DBC_MIGRATION_FEE_PCT, creatorFeePercentage: DBC_CREATOR_MIGRATION_FEE_PCT },
      migratedPoolFee: {
        collectFeeMode: MigratedCollectFeeMode.QuoteToken,
        dynamicFee: DammV2DynamicFeeMode.Disabled,
        poolFeeBps: DBC_GRADUATED_POOL_FEE_BPS,
      },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: DBC_PARTNER_PERM_LOCK_PCT,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: DBC_CREATOR_PERM_LOCK_PCT,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: { ...DBC_LOCKED_VESTING },
    activationType: ActivationType.Timestamp,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: 1.5,
  });
}

function lockedVestingParams() {
  return getLockedVestingParams(
    DBC_LOCKED_VESTING.totalLockedVestingAmount,
    DBC_LOCKED_VESTING.numberOfVestingPeriod,
    DBC_LOCKED_VESTING.cliffUnlockAmount,
    DBC_LOCKED_VESTING.totalVestingDuration,
    DBC_LOCKED_VESTING.cliffDurationFromMigrationTime,
    DBC_TOKEN_DECIMALS,
  );
}

/**
 * Program create_config supply floors (process_create_config.rs).
 * quote = ceil(T * (100 - fee%) / 100)
 * L = get_initial_liquidity_from_delta_quote(quote, MIN_SQRT_PRICE, migration_sqrt)
 * includedBase = get_delta_amount_base_unsigned_256(migration_sqrt, MAX_SQRT_PRICE, L, Up)
 * min_without_buffer = swap + includedBase + vesting
 * min_with_buffer = swapBuffer + includedBase + vesting
 */
export function programMigrationQuoteLamports(thresholdLamports, feePct = DBC_MIGRATION_FEE_PCT) {
  const T = BigInt(thresholdLamports);
  return (T * BigInt(100 - Number(feePct)) + 99n) / 100n;
}

export function programSupplyMinimums({ thresholdLamports, sqrtStartPrice, curve, vesting }) {
  const T = new BN(BigInt(thresholdLamports).toString());
  const quote = programMigrationQuoteLamports(thresholdLamports, DBC_MIGRATION_FEE_PCT);
  const sqrtMigration = getMigrationThresholdPrice(T, sqrtStartPrice, curve);
  const liquidity = getInitialLiquidityFromDeltaQuote(
    new BN(quote.toString()),
    MIN_SQRT_PRICE,
    sqrtMigration,
  );
  const includedBaseBn = getDeltaAmountBaseUnsigned256(
    sqrtMigration,
    MAX_SQRT_PRICE,
    liquidity,
    Rounding.Up,
  );
  const includedBase = BigInt(includedBaseBn.toString());
  const swapBase = BigInt(getBaseTokenForSwap(sqrtStartPrice, sqrtMigration, curve).toString());
  const swapBuffer = BigInt(getSwapAmountWithBuffer(new BN(swapBase.toString()), sqrtStartPrice, curve).toString());
  const vest = BigInt(getTotalVestingAmount(vesting).toString());
  return {
    migrationQuote: quote,
    includedBase,
    swapBase,
    swapBuffer,
    vesting: vest,
    sqrtMigration,
    minWithoutBuffer: swapBase + includedBase + vest,
    minWithBuffer: swapBuffer + includedBase + vest,
  };
}

function customSqrtInput({ creatorFeePct, totalWhole, sqrtPrices, leftover = 0 }) {
  return {
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: DBC_QUOTE_DECIMALS,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: Number(totalWhole),
      leftover,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: DBC_ANTI_SNIPER_START_FEE_BPS,
          endingFeeBps: DBC_ANTI_SNIPER_END_FEE_BPS,
          numberOfPeriod: DBC_ANTI_SNIPER_PERIODS,
          totalDuration: DBC_ANTI_SNIPER_DURATION_SECONDS,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: creatorFeePct,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: DBC_ENABLE_FIRST_SWAP_WITH_MIN_FEE,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: { feePercentage: DBC_MIGRATION_FEE_PCT, creatorFeePercentage: DBC_CREATOR_MIGRATION_FEE_PCT },
      migratedPoolFee: {
        collectFeeMode: MigratedCollectFeeMode.QuoteToken,
        dynamicFee: DammV2DynamicFeeMode.Disabled,
        poolFeeBps: DBC_GRADUATED_POOL_FEE_BPS,
      },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: DBC_PARTNER_PERM_LOCK_PCT,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: DBC_CREATOR_PERM_LOCK_PCT,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: { ...DBC_LOCKED_VESTING },
    activationType: ActivationType.Timestamp,
    sqrtPrices,
  };
}

function assembleParams({ thresholdLamports, soldRaw, slope, creatorFeePct, poolTokens, soldPoints }) {
  const { sqrtStartPrice, curve, sqrtPrices } = buildLinearCurve(thresholdLamports, soldRaw, slope, soldPoints);
  const vesting = lockedVestingParams();
  const mins = programSupplyMinimums({
    thresholdLamports,
    sqrtStartPrice,
    curve,
    vesting,
  });
  const poolForCirculating = mins.includedBase > poolTokens ? mins.includedBase : poolTokens;
  const linearCirculating = roundUpToWholeTokens(soldRaw + poolForCirculating + DBC_RESERVE_RAW);
  const circulatingRaw = linearCirculating > mins.minWithoutBuffer ? linearCirculating : mins.minWithoutBuffer;
  const preRaw = circulatingRaw > mins.minWithBuffer ? circulatingRaw : mins.minWithBuffer;
  if (preRaw > DBC_SUPPLY_CEILING_RAW) {
    return { configParams: null, totalRaw: preRaw, circulatingRaw, sqrtPrices, mins };
  }
  const totalWhole = (preRaw + DBC_TOKEN_SCALE - 1n) / DBC_TOKEN_SCALE;
  let envelope = feeEnvelope({ creatorFeePct });
  try {
    envelope = buildCurveWithCustomSqrtPrices(customSqrtInput({
      creatorFeePct,
      totalWhole: totalWhole > 0n ? totalWhole : 1n,
      sqrtPrices,
      leftover: 0,
    }));
  } catch {
    // SDK allocation can refuse leftover:0 when the 25% swap buffer overruns; we keep the fee envelope.
  }
  const configParams = {
    ...envelope,
    sqrtStartPrice,
    curve,
    migrationQuoteThreshold: new BN(thresholdLamports.toString()),
    tokenSupply: {
      preMigrationTokenSupply: new BN(preRaw.toString()),
      postMigrationTokenSupply: new BN(circulatingRaw.toString()),
    },
    lockedVesting: vesting,
  };
  return { configParams, totalRaw: preRaw, circulatingRaw, sqrtPrices, mins };
}

export function curveQuoteFull(configParams) {
  let q = 0n;
  let lower = configParams.sqrtStartPrice;
  for (const pt of configParams.curve) {
    q += BigInt(getDeltaAmountQuoteUnsigned(lower, pt.sqrtPrice, pt.liquidity, Rounding.Down).toString());
    lower = pt.sqrtPrice;
  }
  return q;
}

export function quoteAlongDbcCurve(configParams, soldRaw) {
  let remaining = new BN(BigInt(soldRaw).toString());
  let quote = new BN(0);
  let lower = configParams.sqrtStartPrice;
  for (const pt of configParams.curve) {
    if (remaining.lten(0)) break;
    const segBase = getDeltaAmountBaseUnsigned(lower, pt.sqrtPrice, pt.liquidity, Rounding.Down);
    if (remaining.gte(segBase)) {
      quote = quote.add(getDeltaAmountQuoteUnsigned(lower, pt.sqrtPrice, pt.liquidity, Rounding.Down));
      remaining = remaining.sub(segBase);
      lower = pt.sqrtPrice;
    } else {
      try {
        const next = getNextSqrtPriceFromBaseAmountOutRoundingUp(lower, pt.liquidity, remaining);
        if (next.gt(lower)) {
          quote = quote.add(getDeltaAmountQuoteUnsigned(lower, next, pt.liquidity, Rounding.Down));
        }
      } catch {
        quote = quote.add(getDeltaAmountQuoteUnsigned(lower, pt.sqrtPrice, pt.liquidity, Rounding.Down));
      }
      remaining = new BN(0);
    }
  }
  return BigInt(quote.toString());
}

export function feeBpsAtSeconds(configParams, seconds) {
  const fee = configParams.poolFees.baseFee;
  const current = new BN(Math.max(0, Number(seconds)));
  const numerator = getBaseFeeNumerator(
    fee.cliffFeeNumerator,
    fee.firstFactor,
    fee.secondFactor,
    fee.thirdFactor,
    fee.baseFeeMode,
    current,
    new BN(0),
  );
  return feeNumeratorToBps(numerator);
}

function canonicalJson(value) {
  if (value == null) return null;
  if (typeof value === "bigint") return value.toString();
  if (BN.isBN(value)) return value.toString();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === "object") {
    if (typeof value.toBase58 === "function") return value.toBase58();
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalJson(value[key]);
    return out;
  }
  return String(value);
}

export function paramsHashOf(payload) {
  return createHash("sha256").update(JSON.stringify(canonicalJson(payload))).digest("hex");
}

export function buildLaunchConfigParams(targetUsdMicros, stepUsdMicros, creatorFeeMode, { soldPoints = PRODUCTION_SOLD_POINTS } = {}) {
  if (!isCreatorFeeMode(creatorFeeMode)) {
    throw Object.assign(new Error("creatorFeeMode must be creator or platform"), { code: "DBC_BAD_FEE_MODE" });
  }
  const target = BigInt(targetUsdMicros);
  const step = BigInt(stepUsdMicros);
  const thresholdLamports = thresholdLamportsFor(target, step);
  const creatorFeePct = creatorTradingFeePct(creatorFeeMode);
  let slope = DBC_PRICE_SLOPE_LAMPORTS;
  let steepened = false;
  let assembled;
  let econ;
  for (let i = 0; i < 48; i += 1) {
    econ = linearEconomics(thresholdLamports, slope);
    assembled = assembleParams({
      thresholdLamports,
      soldRaw: econ.soldRaw,
      poolTokens: econ.poolTokens,
      slope,
      creatorFeePct,
      soldPoints,
    });
    if (assembled.totalRaw <= DBC_SUPPLY_CEILING_RAW) break;
    steepened = true;
    if (i === 0) {
      let lo = DBC_PRICE_SLOPE_LAMPORTS;
      let hi = DBC_PRICE_SLOPE_LAMPORTS * 50_000n;
      while (lo < hi) {
        const mid = (lo + hi) / 2n;
        const trial = linearEconomics(thresholdLamports, mid);
        const built = assembleParams({
          thresholdLamports,
          soldRaw: trial.soldRaw,
          poolTokens: trial.poolTokens,
          slope: mid,
          creatorFeePct,
          soldPoints,
        });
        if (built.totalRaw <= DBC_SUPPLY_CEILING_RAW) hi = mid;
        else lo = mid + 1n;
      }
      slope = lo;
      continue;
    }
    slope = (slope * 11n) / 10n + 1n;
  }
  if (assembled.totalRaw > DBC_SUPPLY_CEILING_RAW) {
    throw Object.assign(new Error("DBC config would mint more than 1B tokens"), { code: "DBC_SUPPLY_CEILING" });
  }

  const { configParams, totalRaw, circulatingRaw, mins } = assembled;
  if (!configParams) {
    throw Object.assign(new Error("DBC config would mint more than 1B tokens"), { code: "DBC_SUPPLY_CEILING" });
  }
  validateConfigParameters({ ...configParams, leftoverReceiver: DUMMY_LEFTOVER });
  const postRaw = BigInt(configParams.tokenSupply.postMigrationTokenSupply.toString());
  const preRaw = BigInt(configParams.tokenSupply.preMigrationTokenSupply.toString());
  if (mins.minWithoutBuffer > postRaw || postRaw > preRaw || mins.minWithBuffer > preRaw) {
    throw Object.assign(new Error("DBC tokenSupply is below the program minimums"), { code: "DBC_TOKEN_SUPPLY" });
  }

  const liquidityBits = configParams.curve.map((pt) => liquidityBitLength(pt.liquidity));
  assertSqrtInRange("sqrtStartPrice", configParams.sqrtStartPrice);
  for (const [i, pt] of configParams.curve.entries()) {
    assertSqrtInRange(`curve[${i}].sqrtPrice`, pt.sqrtPrice);
    assertLiquidityU128(`curve[${i}].liquidity`, pt.liquidity);
  }

  const expected = {
    thresholdLamports,
    soldRaw: econ.soldRaw,
    poolLamports: econ.poolLamports,
    poolTokens: econ.poolTokens,
    creatorGraduationLamports: econ.creatorGraduationLamports,
    ourGraduationLamports: econ.ourGraduationLamports,
    reserveTokens: DBC_RESERVE_RAW,
    totalTokenSupply: totalRaw,
    circulatingAfterGraduation: circulatingRaw,
    bufferTokens: preRaw - postRaw,
    slopeUsed: slope,
    steepened,
    liquidityBits,
    includedBase: mins.includedBase,
    minWithoutBuffer: mins.minWithoutBuffer,
    minWithBuffer: mins.minWithBuffer,
    migrationQuote: mins.migrationQuote,
  };
  const paramsHash = paramsHashOf({
    targetUsdMicros: target.toString(),
    stepUsdMicros: step.toString(),
    creatorFeeMode,
    configParams,
  });
  return { configParams, expected, paramsHash };
}

export { DUMMY_LEFTOVER as DBC_VALIDATE_LEFTOVER_RECEIVER };
