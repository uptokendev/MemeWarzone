/**
 * DBC launch-type economics. Every numeric constant for the config ladder lives
 * here. Other files import these; they do not hard-code the values.
 *
 * Decision numbers (D1–D17) are in docs/dbc/DBC_BUILD_PLAN.md.
 */
import { WSOL_MINT } from "./dbcQuotes.mjs";

/** DBC program, same id on mainnet and devnet. */
export const DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";

/** Native SOL quote mint (WSOL). Default quote; other quotes live in dbcQuotes.mjs. */
export const DBC_QUOTE_MINT = WSOL_MINT;

/** Today's launchpad decimals. */
export const DBC_TOKEN_DECIMALS = 6;

export const DBC_TOKEN_SCALE = 1_000_000n;

/** 1B whole-token ceiling (D9). */
export const DBC_SUPPLY_CEILING_WHOLE = 1_000_000_000n;

export const DBC_SUPPLY_CEILING_RAW = DBC_SUPPLY_CEILING_WHOLE * DBC_TOKEN_SCALE;

/**
 * Creator reserve as today: 2% of 1B = 20M whole tokens, released at graduation.
 * DBC lockedVesting: when totalLockedVestingAmount === cliffUnlockAmount the SDK
 * stores amountPerPeriod = 1 whole token, frequency = 1, numberOfPeriod = 1,
 * cliffUnlockAmount = total-1. cliffDurationFromMigrationTime = 0 unlocks
 * everything at migration — the smallest valid "everything at migration" shape.
 */
export const DBC_RESERVE_WHOLE = 20_000_000n;
export const DBC_RESERVE_RAW = DBC_RESERVE_WHOLE * DBC_TOKEN_SCALE;
export const DBC_LOCKED_VESTING = Object.freeze({
  totalLockedVestingAmount: Number(DBC_RESERVE_WHOLE),
  numberOfVestingPeriod: 1,
  cliffUnlockAmount: Number(DBC_RESERVE_WHOLE),
  totalVestingDuration: 0,
  cliffDurationFromMigrationTime: 0,
});

/**
 * Today's economics v3 linear curve (solanaCurveCostLamports):
 * price per whole token = 1 lamport + 850 nano-lamports × whole tokens sold.
 */
export const DBC_BASE_PRICE_LAMPORTS = 1n;
export const DBC_PRICE_SLOPE_LAMPORTS = 850n;
export const DBC_NANO_LAMPORTS_PER_LAMPORT = 1_000_000_000n;
export const DBC_ECONOMICS_VERSION = 3;

/** D1 / D14: 2% after the anti-sniper window. */
export const DBC_TRADE_FEE_BPS = 200;

/**
 * D14: anti-sniper starts at 90% and falls to 2% over 60 seconds (founder 2026-10-01: was 50%; a
 * sniper one slot after the first mainnet DBC launch still moved the chart with half his buy).
 * BaseFeeMode.FeeSchedulerLinear, 60 periods of 1 second.
 * Fee at 0s = 90%, 5s = 82.67%, 30s = 46%, 60s = 2%, 120s = 2%. Applies to configs created after
 * the change (the params hash covers the fee); existing pools keep the fee they were born with.
 */
export const DBC_ANTI_SNIPER_START_FEE_BPS = 9000;
export const DBC_ANTI_SNIPER_END_FEE_BPS = DBC_TRADE_FEE_BPS;
export const DBC_ANTI_SNIPER_DURATION_SECONDS = 60;
export const DBC_ANTI_SNIPER_PERIODS = 60;

/**
 * D12 option A: extra creator buys through our site lock 20% at 30 days, then
 * 20% every 7 days for 4 periods (fully free after 58 days).
 */
export const DBC_LOCK_CLIFF_SECONDS = 30 * 24 * 60 * 60;
export const DBC_LOCK_FREQUENCY_SECONDS = 7 * 24 * 60 * 60;
export const DBC_LOCK_PERIODS = 4;
export const DBC_LOCK_STEP_BPS = 2000;
export const DBC_JUPITER_LOCK_PROGRAM_ID = "LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn";
export const DBC_CREATOR_LOCK_COPY =
  "As the creator, your buys are locked: 20% is released after 30 days, then 20% every 7 days.";

/** D11: creator's first swap in the launch transaction pays the 2% ending fee. */
export const DBC_ENABLE_FIRST_SWAP_WITH_MIN_FEE = true;

/**
 * D11: first buy in the launch transaction, at most 70% of the config supply, for every creator
 * (founder + team 2026-10-08; was 10%, no per-wallet latch). Our own server check; Meteora has no
 * creator cap. With 85% of supply on the curve (DBC_CURVE_SUPPLY_PCT) a 70% first buy leaves 15% for
 * the public: ~14.2 SOL on a $30K config and ~23.7 SOL on a $50K config at $120.40 SOL (proven on a
 * local validator, scripts/dbc/prove-v2-economics-local.mjs).
 */
export const DBC_FIRST_BUY_MAX_BPS = 7000;

/** Creator limits for DBC (same numbers as today's CreatorProfile defaults). */
export const DBC_MAX_LIVE_BONDING = 3;
export const DBC_CREATOR_COOLDOWN_SECONDS = 86_400;

/** D3: 7% of the post-Meteora 80% when the creator keeps the fee. */
export const DBC_CREATOR_TRADING_FEE_PCT_KEEP = 7;

/** D5: holders / buyback / split — creator share lands with the collector. */
export const DBC_CREATOR_TRADING_FEE_PCT_PLATFORM = 0;

export const DBC_CREATOR_FEE_MODES = Object.freeze(["creator", "platform"]);

/**
 * D6 v2 (founder 2026-10-08): graduation (migration) fee 2%, creator 0% of it: all 2% to our side,
 * through the graduation fee routing (realtime-indexer dbcGraduationSplit). Pool gets 98%. Meteora's
 * own 0.2% liquidity migration fee comes on top and is no longer compensated to the creator.
 * Configs created before this keep their 22% / 90% (a config never changes).
 */
export const DBC_MIGRATION_FEE_PCT = 2;
export const DBC_CREATOR_MIGRATION_FEE_PCT = 0;
export const DBC_POOL_AFTER_MIGRATION_PCT = 100 - DBC_MIGRATION_FEE_PCT;

/**
 * v2 supply split of the 1B mint: 85% sold on the curve, 13% into the graduated pool, 2% creator
 * reserve (DBC_RESERVE_WHOLE, unlocked at graduation). The pool opens at the curve's last price.
 */
export const DBC_CURVE_SUPPLY_PCT = 85;
export const DBC_POOL_SUPPLY_PCT = 13;

/** D8: graduated pool 0.25%, SOL-only fees, 80/20 permanently locked (`keep`). */
export const DBC_GRADUATED_POOL_FEE_BPS = 25;
export const DBC_CREATOR_PERM_LOCK_PCT = 80;
export const DBC_PARTNER_PERM_LOCK_PCT = 20;
/** D19: holders/split/buyback — 100% partner lock so the keeper can claim LP fees. */
export const DBC_PLATFORM_CREATOR_PERM_LOCK_PCT = 0;
export const DBC_PLATFORM_PARTNER_PERM_LOCK_PCT = 100;

export function liquidityDistributionFor(creatorFeeMode) {
  if (String(creatorFeeMode) === "platform") {
    return {
      partnerPermanentLockedLiquidityPercentage: DBC_PLATFORM_PARTNER_PERM_LOCK_PCT,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: DBC_PLATFORM_CREATOR_PERM_LOCK_PCT,
      creatorLiquidityPercentage: 0,
    };
  }
  return {
    partnerPermanentLockedLiquidityPercentage: DBC_PARTNER_PERM_LOCK_PCT,
    partnerLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: DBC_CREATOR_PERM_LOCK_PCT,
    creatorLiquidityPercentage: 0,
  };
}

/**
 * D9 v2 (founder 2026-10-08): targets are the GRADUATION MARKET CAP, in USD micros at the SOL price
 * the config is built for: $30K (fast) and $50K (normal). $15K is gone. Before v2 these were dollars
 * of raised SOL; existing coins keep their configs.
 */
export const DBC_TARGET_USD_MICROS = Object.freeze({
  30000: 30_000_000_000n,
  50000: 50_000_000_000n,
});

/** $150 market-cap test target for devnet, where a real target's SOL is hard to come by. */
export const DBC_DEVNET_TEST_TARGET_USD_MICROS = 150_000_000n;

export const DBC_USD_MICROS = 1_000_000n;
export const DBC_LAMPORTS_PER_SOL = 1_000_000_000n;

/** D9: geometric SOL-price steps of 2%. */
export const DBC_SOL_PRICE_STEP_RATIO = 1.02;

/** Live SOL price must be no older than this (brief). */
export const DBC_SOL_USD_MAX_STALE_MS = 60_000;

/** Customizable DAMM v2 migration fee option index. */
export const DBC_MIGRATION_FEE_OPTION_CUSTOMIZABLE = 6;

/** Max sqrt-price points on a DBC config (SDK MAX_CURVE_POINT). */
export const DBC_CURVE_POINTS = 16;

export const DBC_QUOTE_DECIMALS = 9;

export function creatorTradingFeePct(mode) {
  if (mode === "creator") return DBC_CREATOR_TRADING_FEE_PCT_KEEP;
  if (mode === "platform") return DBC_CREATOR_TRADING_FEE_PCT_PLATFORM;
  return null;
}

export function isCreatorFeeMode(mode) {
  return DBC_CREATOR_FEE_MODES.includes(String(mode || ""));
}

export function allowedTargetUsdMicros(cluster) {
  const targets = [
    DBC_TARGET_USD_MICROS[30000],
    DBC_TARGET_USD_MICROS[50000],
  ];
  if (String(cluster || "") === "devnet") targets.push(DBC_DEVNET_TEST_TARGET_USD_MICROS);
  return targets;
}

export function parseTargetUsdToMicros(targetUsd) {
  const n = Number(targetUsd);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n === 150) return DBC_DEVNET_TEST_TARGET_USD_MICROS;
  const micros = DBC_TARGET_USD_MICROS[n];
  return micros ?? null;
}

/**
 * D6 integer split, matching the program: pool = ceil(T * (100 - fee%) / 100) (Rounding::Up),
 * fee = T - pool, then the creator's share of the fee (0% in v2).
 */
export function migrationSplitLamports(thresholdLamports) {
  const T = BigInt(thresholdLamports);
  const poolLamports = (T * BigInt(DBC_POOL_AFTER_MIGRATION_PCT) + 99n) / 100n;
  const feeLamports = T - poolLamports;
  const creatorGraduationLamports = (feeLamports * BigInt(DBC_CREATOR_MIGRATION_FEE_PCT)) / 100n;
  const ourGraduationLamports = feeLamports - creatorGraduationLamports;
  return { poolLamports, feeLamports, creatorGraduationLamports, ourGraduationLamports };
}

export function roundUpToWholeTokens(raw) {
  const n = BigInt(raw);
  if (n <= 0n) return 0n;
  return ((n + DBC_TOKEN_SCALE - 1n) / DBC_TOKEN_SCALE) * DBC_TOKEN_SCALE;
}

export function thresholdLamportsFor(targetUsdMicros, stepUsdMicros) {
  const target = BigInt(targetUsdMicros);
  const step = BigInt(stepUsdMicros);
  if (target <= 0n || step <= 0n) throw new Error("target and step must be positive");
  return (target * DBC_LAMPORTS_PER_SOL + step - 1n) / step;
}

/**
 * v2: the SOL (in USD micros) a curve must raise to graduate at `marketCapUsdMicros`. The pool opens at
 * the curve's last price with 98% of the raise against 13% of the supply, so
 * marketCap = 1B x price = raise x 98% / 13%  ->  raise = marketCap x 13 / 98 (rounded up).
 */
export function thresholdUsdMicrosForMarketCap(marketCapUsdMicros) {
  const mc = BigInt(marketCapUsdMicros);
  if (mc <= 0n) throw new Error("market cap must be positive");
  const num = mc * BigInt(DBC_POOL_SUPPLY_PCT);
  const den = BigInt(DBC_POOL_AFTER_MIGRATION_PCT);
  return (num + den - 1n) / den;
}
