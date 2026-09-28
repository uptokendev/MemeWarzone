/**
 * DBC launch-type economics. Every numeric constant for the config ladder lives
 * here. Other files import these; they do not hard-code the values.
 *
 * Decision numbers (D1–D17) are in docs/dbc/DBC_BUILD_PLAN.md.
 */

/** DBC program, same id on mainnet and devnet. */
export const DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";

/** Native SOL quote mint (WSOL). */
export const DBC_QUOTE_MINT = "So11111111111111111111111111111111111111112";

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
 * D14: anti-sniper starts at 50% and falls to 2% over 60 seconds.
 * BaseFeeMode.FeeSchedulerLinear, 60 periods of 1 second.
 * Fee at 0s = 50%, 5s = 46%, 30s = 26%, 60s = 2%, 120s = 2%.
 */
export const DBC_ANTI_SNIPER_START_FEE_BPS = 5000;
export const DBC_ANTI_SNIPER_END_FEE_BPS = DBC_TRADE_FEE_BPS;
export const DBC_ANTI_SNIPER_DURATION_SECONDS = 60;
export const DBC_ANTI_SNIPER_PERIODS = 60;

/** D11: creator's first swap in the launch transaction pays the 2% ending fee. */
export const DBC_ENABLE_FIRST_SWAP_WITH_MIN_FEE = true;

/** D3: 7% of the post-Meteora 80% when the creator keeps the fee. */
export const DBC_CREATOR_TRADING_FEE_PCT_KEEP = 7;

/** D5: holders / buyback / split — creator share lands with the collector. */
export const DBC_CREATOR_TRADING_FEE_PCT_PLATFORM = 0;

export const DBC_CREATOR_FEE_MODES = Object.freeze(["creator", "platform"]);

/** D6: migration fee 22%, creator 90% of it → creator 19.8%, us 2.2%, pool 78%. */
export const DBC_MIGRATION_FEE_PCT = 22;
export const DBC_CREATOR_MIGRATION_FEE_PCT = 90;
export const DBC_POOL_AFTER_MIGRATION_PCT = 100 - DBC_MIGRATION_FEE_PCT;

/** D8: graduated pool 0.25%, SOL-only fees, 80/20 permanently locked. */
export const DBC_GRADUATED_POOL_FEE_BPS = 25;
export const DBC_CREATOR_PERM_LOCK_PCT = 80;
export const DBC_PARTNER_PERM_LOCK_PCT = 20;

/** D9: dollar targets of raised SOL. Micros. */
export const DBC_TARGET_USD_MICROS = Object.freeze({
  15000: 15_000_000_000n,
  30000: 30_000_000_000n,
  50000: 50_000_000_000n,
});

/** $150 test target — a real target costs ~130 SOL to fill; devnet cannot. */
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
    DBC_TARGET_USD_MICROS[15000],
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
 * D6 integer split, matching the program: pool = ceil(T * 78 / 100) (Rounding::Up),
 * fee = T - pool, then creator 90% of the fee.
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
