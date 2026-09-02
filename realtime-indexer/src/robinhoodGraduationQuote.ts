export type RobinhoodGraduationQuotePolicy = {
  version: string;
  maxOracleAgeSeconds: number;
  maxSwapSlippageBps: number;
  maxOracleDeviationBps: number;
  maxPriceImpactBps: number;
  minimumRouteLiquidityUsd: number;
  quoteDeadlineSeconds: number;
};

export type RobinhoodGraduationQuoteInput = {
  nowMs: number;
  quoteTimestampMs: number;
  deadlineMs: number;
  nativeLiquidityUsd: number;
  expectedQuoteOutRaw: bigint;
  minimumQuoteOutRaw: bigint;
  routeLiquidityUsd: number;
  priceImpactBps: number;
  oracleDeviationBps: number;
  oracleHealthy: boolean;
  oracleUpdatedAtMs: number | null;
  canonicalToken: boolean;
  graduationEnabled: boolean;
  routeVerified: boolean;
  campaignEligible: boolean;
};

export type RobinhoodGraduationQuoteDecision = {
  accepted: boolean;
  policyVersion: string;
  failures: string[];
  oracleAgeSeconds: number | null;
  slippageBps: number | null;
};

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function defaultRobinhoodGraduationQuotePolicy(env: NodeJS.ProcessEnv = process.env): RobinhoodGraduationQuotePolicy {
  return {
    version: String(env.ROBINHOOD_STOCK_GRADUATION_POLICY_VERSION || "robinhood_stock_graduation_v1"),
    maxOracleAgeSeconds: Number(env.ROBINHOOD_STOCK_GRADUATION_MAX_ORACLE_AGE_SECONDS || 900),
    maxSwapSlippageBps: Number(env.ROBINHOOD_STOCK_GRADUATION_MAX_SWAP_SLIPPAGE_BPS || 300),
    maxOracleDeviationBps: Number(env.ROBINHOOD_STOCK_GRADUATION_MAX_ORACLE_DEVIATION_BPS || 300),
    maxPriceImpactBps: Number(env.ROBINHOOD_STOCK_GRADUATION_MAX_PRICE_IMPACT_BPS || 500),
    minimumRouteLiquidityUsd: Number(env.ROBINHOOD_STOCK_GRADUATION_MIN_ROUTE_LIQUIDITY_USD || 25000),
    quoteDeadlineSeconds: Number(env.ROBINHOOD_STOCK_GRADUATION_QUOTE_DEADLINE_SECONDS || 60),
  };
}

export function validateRobinhoodGraduationQuotePolicy(policy: RobinhoodGraduationQuotePolicy): void {
  const boundedBps = [policy.maxSwapSlippageBps, policy.maxOracleDeviationBps, policy.maxPriceImpactBps];
  if (!policy.version.trim()) throw new Error("Graduation quote policy version is required");
  if (!Number.isFinite(policy.maxOracleAgeSeconds) || policy.maxOracleAgeSeconds <= 0) throw new Error("Invalid max oracle age");
  if (boundedBps.some((value) => !Number.isFinite(value) || value < 0 || value > 10000)) throw new Error("Invalid graduation quote BPS policy");
  if (!finiteNonNegative(policy.minimumRouteLiquidityUsd)) throw new Error("Invalid minimum route liquidity");
  if (!Number.isFinite(policy.quoteDeadlineSeconds) || policy.quoteDeadlineSeconds <= 0) throw new Error("Invalid quote deadline");
}

function calculateSlippageBps(expected: bigint, minimum: bigint): number | null {
  if (expected <= 0n || minimum <= 0n || minimum > expected) return null;
  return Number(((expected - minimum) * 10000n) / expected);
}

export function evaluateRobinhoodGraduationQuote(
  input: RobinhoodGraduationQuoteInput,
  policy = defaultRobinhoodGraduationQuotePolicy(),
): RobinhoodGraduationQuoteDecision {
  validateRobinhoodGraduationQuotePolicy(policy);
  const failures: string[] = [];
  const oracleAgeSeconds = input.oracleUpdatedAtMs == null
    ? null
    : Math.max(0, Math.floor((input.nowMs - input.oracleUpdatedAtMs) / 1000));
  const slippageBps = calculateSlippageBps(input.expectedQuoteOutRaw, input.minimumQuoteOutRaw);

  if (!input.canonicalToken) failures.push("STOCK_TOKEN_NOT_CANONICAL");
  if (!input.graduationEnabled) failures.push("STOCK_TOKEN_GRADUATION_DISABLED");
  if (!input.oracleHealthy) failures.push("ORACLE_UNHEALTHY");
  if (oracleAgeSeconds == null || oracleAgeSeconds > policy.maxOracleAgeSeconds) failures.push("ORACLE_STALE");
  if (!input.routeVerified) failures.push("ROUTE_UNVERIFIED");
  if (input.expectedQuoteOutRaw <= 0n) failures.push("ZERO_QUOTED_OUTPUT");
  if (slippageBps == null || slippageBps > policy.maxSwapSlippageBps) failures.push("SLIPPAGE_TOO_HIGH");
  if (!finiteNonNegative(input.routeLiquidityUsd) || input.routeLiquidityUsd < policy.minimumRouteLiquidityUsd) failures.push("ROUTE_LIQUIDITY_TOO_LOW");
  if (!finiteNonNegative(input.priceImpactBps) || input.priceImpactBps > policy.maxPriceImpactBps) failures.push("PRICE_IMPACT_TOO_HIGH");
  if (!finiteNonNegative(input.oracleDeviationBps) || input.oracleDeviationBps > policy.maxOracleDeviationBps) failures.push("ORACLE_DEVIATION_TOO_HIGH");
  if (!input.campaignEligible) failures.push("CAMPAIGN_NOT_ELIGIBLE");
  if (!Number.isFinite(input.deadlineMs) || input.deadlineMs <= input.nowMs) failures.push("QUOTE_DEADLINE_EXPIRED");
  if (input.deadlineMs - input.quoteTimestampMs > policy.quoteDeadlineSeconds * 1000) failures.push("QUOTE_DEADLINE_TOO_LONG");
  if (!finiteNonNegative(input.nativeLiquidityUsd) || input.nativeLiquidityUsd <= 0) failures.push("INVALID_LIQUIDITY_ALLOCATION");

  return {
    accepted: failures.length === 0,
    policyVersion: policy.version,
    failures,
    oracleAgeSeconds,
    slippageBps,
  };
}
