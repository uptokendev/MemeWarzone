/**
 * Pure (targetUsdMicros, stepUsdMicros, creatorFeeMode) -> DBC config params.
 * v2 (2026-10-08): target = graduation market cap; one constant-product segment from Meteora's
 * buildCurve. The linear-path helpers below are kept for the economics v3 tests and old proofs.
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
  feeNumeratorToBps,
  getBaseFeeNumerator,
  getDeltaAmountBaseUnsigned,
  getDeltaAmountBaseUnsigned256,
  getDeltaAmountQuoteUnsigned,
  getInitialLiquidityFromDeltaQuote,
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
  DBC_CURVE_POINTS,
  DBC_ENABLE_FIRST_SWAP_WITH_MIN_FEE,
  DBC_GRADUATED_POOL_FEE_BPS,
  DBC_LOCKED_VESTING,
  DBC_MIGRATION_FEE_PCT,
  DBC_NANO_LAMPORTS_PER_LAMPORT,
  DBC_PRICE_SLOPE_LAMPORTS,
  liquidityDistributionFor,
  DBC_QUOTE_DECIMALS,
  DBC_RESERVE_RAW,
  DBC_SUPPLY_CEILING_RAW,
  DBC_TOKEN_DECIMALS,
  DBC_TOKEN_SCALE,
  creatorTradingFeePct,
  isCreatorFeeMode,
  migrationSplitLamports,
  roundUpToWholeTokens,
  thresholdLamportsFor,
  thresholdUsdMicrosForMarketCap,
  DBC_POOL_SUPPLY_PCT,
} from "../../../shared/dbcEconomics.mjs";
import { thresholdQuoteRaw } from "../../../shared/dbcQuotes.mjs";

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

function sqrtPriceFromExactLamports(pLamports, quoteDecimals = DBC_QUOTE_DECIMALS) {
  const human = pLamports / (10 ** Number(quoteDecimals));
  return getSqrtPriceFromPrice(human.toExponential(18), DBC_TOKEN_DECIMALS, Number(quoteDecimals));
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

/** Everything buildCurve needs except the split and threshold: today's fees, anti-sniper, DAMM v2, LP split. */
function curveInput({ creatorFeePct, quoteDecimals = DBC_QUOTE_DECIMALS }) {
  const creatorFeeMode = Number(creatorFeePct) === 0 ? "platform" : "creator";
  return {
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: Number(quoteDecimals),
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
    liquidityDistribution: liquidityDistributionFor(creatorFeeMode),
    lockedVesting: { ...DBC_LOCKED_VESTING },
    activationType: ActivationType.Timestamp,
  };
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

/**
 * v2 (founder 2026-10-08): a config that graduates at `targetUsdMicros` MARKET CAP (at the SOL price of
 * `stepUsdMicros`), with 85% of the 1B supply on the curve, 13% into the graduated pool, the 2% creator
 * reserve, and a 2% graduation fee with no creator share. The curve is the first segment of Meteora's
 * buildCurve (one constant-product segment from the start price to the graduation price). buildCurve's
 * extra segment up to the maximum price is dropped: with it the program demands a 25% swap buffer
 * (getSwapAmountWithBuffer) that does not fit in 1B; ending at graduation, the buffer is zero.
 * Proven end to end on a local validator: scripts/dbc/prove-v2-economics-local.mjs.
 */
export function buildLaunchConfigParams(targetUsdMicros, stepUsdMicros, creatorFeeMode, { quote = null } = {}) {
  if (!isCreatorFeeMode(creatorFeeMode)) {
    throw Object.assign(new Error("creatorFeeMode must be creator or platform"), { code: "DBC_BAD_FEE_MODE" });
  }
  const target = BigInt(targetUsdMicros);
  const step = BigInt(stepUsdMicros);
  const quoteDecimals = Number(quote?.decimals ?? DBC_QUOTE_DECIMALS);
  const thresholdUsd = thresholdUsdMicrosForMarketCap(target);
  const thresholdRaw = quote && quote.kind !== "native"
    ? thresholdQuoteRaw(thresholdUsd, quote, step)
    : thresholdLamportsFor(thresholdUsd, step);
  const creatorFeePct = creatorTradingFeePct(creatorFeeMode);

  const built = buildCurve({
    ...curveInput({ creatorFeePct, quoteDecimals }),
    // 1 token of slack so the program's rounded-up pool amount still fits inside 1B.
    token: { ...curveInput({ creatorFeePct, quoteDecimals }).token, leftover: 1 },
    percentageSupplyOnMigration: DBC_POOL_SUPPLY_PCT,
    migrationQuoteThreshold: Number(thresholdRaw) / 10 ** quoteDecimals,
  });
  const curve = [built.curve[0]];
  const T = BigInt(built.migrationQuoteThreshold.toString());
  const mins = programSupplyMinimums({ thresholdLamports: T, sqrtStartPrice: built.sqrtStartPrice, curve, vesting: built.lockedVesting });
  const preRaw = DBC_SUPPLY_CEILING_RAW;
  if (mins.minWithBuffer > preRaw || mins.minWithoutBuffer > preRaw) {
    throw Object.assign(new Error("DBC config would mint more than 1B tokens"), { code: "DBC_SUPPLY_CEILING" });
  }
  const configParams = {
    ...built,
    curve,
    migrationQuoteThreshold: new BN(T.toString()),
    tokenSupply: {
      preMigrationTokenSupply: new BN(preRaw.toString()),
      postMigrationTokenSupply: new BN(mins.minWithoutBuffer.toString()),
    },
  };
  validateConfigParameters({ ...configParams, leftoverReceiver: DUMMY_LEFTOVER });
  assertSqrtInRange("sqrtStartPrice", configParams.sqrtStartPrice);
  for (const [i, pt] of configParams.curve.entries()) {
    assertSqrtInRange(`curve[${i}].sqrtPrice`, pt.sqrtPrice);
    assertLiquidityU128(`curve[${i}].liquidity`, pt.liquidity);
  }

  const split = migrationSplitLamports(T);
  const expected = {
    thresholdLamports: T,
    graduationMarketCapUsdMicros: target,
    soldRaw: mins.swapBase,
    poolLamports: split.poolLamports,
    poolTokens: mins.includedBase,
    creatorGraduationLamports: split.creatorGraduationLamports,
    ourGraduationLamports: split.ourGraduationLamports,
    reserveTokens: DBC_RESERVE_RAW,
    totalTokenSupply: preRaw,
    circulatingAfterGraduation: mins.minWithoutBuffer,
    bufferTokens: preRaw - mins.minWithoutBuffer,
    liquidityBits: configParams.curve.map((pt) => liquidityBitLength(pt.liquidity)),
    includedBase: mins.includedBase,
    minWithoutBuffer: mins.minWithoutBuffer,
    minWithBuffer: mins.minWithBuffer,
    migrationQuote: mins.migrationQuote,
  };
  const paramsHash = paramsHashOf({
    economics: "v2-market-cap",
    targetUsdMicros: target.toString(),
    stepUsdMicros: step.toString(),
    creatorFeeMode,
    configParams,
  });
  return { configParams, expected, paramsHash };
}

export { DUMMY_LEFTOVER as DBC_VALIDATE_LEFTOVER_RECEIVER };
