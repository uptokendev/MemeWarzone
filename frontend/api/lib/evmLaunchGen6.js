import { ethers } from "ethers";

/**
 * Generation 6/5 create options (docs/evm-launch C3 first buy, C6 fee choice).
 *
 * The factory signs these four fields with the request (LaunchFactory._hashCampaignRequest), so the
 * API validates them before it signs. Every rule here mirrors a revert in the contracts, so a request
 * the API signs cannot fail on chain for a reason we could have seen first:
 *
 * - feeChoice 1 Keep / 2 Holders / 3 Split / 4 Buyback; feeCreatorPct 1..99 only for Split, else 0
 *   (LaunchFactory._validateFeeChoice, CreatorRewardsVaultV2.setCampaignChoice).
 * - firstBuyTokens <= 10% of totalSupply and <= curveSupply (LaunchCampaign.creatorFirstBuy).
 * - costNoFee <= 50% of the live native graduation target (FirstBuyTooExpensive).
 * - firstBuyMaxCost >= the exact cost (FirstBuySlippage). Zero tokens means zero max cost and no value.
 * - firstBuyMaxCost <= cost + slack: at create sold == 0, so the cost is exact; the slack only covers a
 *   graduation-target re-price or config change between signing and mining. Anything above is refunded
 *   by the factory anyway, but we do not sign an open-ended amount.
 */

export const FEE_CHOICE_KEEP = 1;
export const FEE_CHOICE_HOLDERS = 2;
export const FEE_CHOICE_SPLIT = 3;
export const FEE_CHOICE_BUYBACK = 4;
export const FEE_CHOICE_NAMES = Object.freeze({ 1: "keep", 2: "holders", 3: "split", 4: "buyback" });
const FEE_CHOICE_BY_NAME = Object.freeze({ keep: 1, holders: 2, split: 3, buyback: 4 });

export const CREATOR_FIRST_BUY_MAX_SUPPLY_BPS = 1000n;
export const CREATOR_FIRST_BUY_MAX_TARGET_BPS = 5000n;
export const DEFAULT_FIRST_BUY_MAX_COST_SLACK_BPS = 500n;
export const MAX_FIRST_BUY_MAX_COST_SLACK_BPS = 2000n;
const MAX_BPS = 10_000n;
const WAD = 10n ** 18n;

export class Gen6CreateOptionError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = "Gen6CreateOptionError";
    this.code = code;
    this.httpStatus = 400;
    this.details = details;
  }
}

function fail(message, code, details) {
  throw new Gen6CreateOptionError(message, code, details);
}

function parseUintField(value, label, code) {
  if (value === undefined || value === null || value === "") return 0n;
  const raw = typeof value === "bigint" ? value.toString() : String(value).trim();
  if (!/^\d+$/.test(raw)) fail(`${label} must be a whole number of wei (no decimals, no sign).`, code);
  return BigInt(raw);
}

export function parseFeeChoice(value) {
  if (value === undefined || value === null || value === "") {
    fail("Choose what happens to the creator's share of the trade fee: keep, holders, split or buyback.", "GEN6_FEE_CHOICE_REQUIRED");
  }
  const byName = FEE_CHOICE_BY_NAME[String(value).trim().toLowerCase()];
  const n = byName ?? Number(value);
  if (!Number.isInteger(n) || n < FEE_CHOICE_KEEP || n > FEE_CHOICE_BUYBACK) {
    fail("feeChoice must be 1 (keep), 2 (holders), 3 (split) or 4 (buyback).", "GEN6_FEE_CHOICE_INVALID");
  }
  return n;
}

/**
 * Parse the four generation-6 fields from a request body (or `body.campaignRequest`). Pure: no chain
 * reads. Accepts `feeChoice` as 1..4 or the names keep/holders/split/buyback.
 */
export function parseGen6CreateOptions(source = {}, { autoMaxCost = false } = {}) {
  const feeChoice = parseFeeChoice(source.feeChoice ?? source.evmFeeChoice);
  const pctRaw = source.feeCreatorPct ?? source.evmFeeCreatorPct ?? source.creatorSharePct;
  let feeCreatorPct = 0;
  if (feeChoice === FEE_CHOICE_SPLIT) {
    const n = Number(pctRaw);
    if (!Number.isInteger(n) || n < 1 || n > 99) {
      fail("A split needs the creator's share as a whole percent from 1 to 99.", "GEN6_FEE_CREATOR_PCT_INVALID");
    }
    feeCreatorPct = n;
  } else if (pctRaw !== undefined && pctRaw !== null && pctRaw !== "" && Number(pctRaw) !== 0) {
    fail("feeCreatorPct is only used with the split choice; send 0 for keep, holders and buyback.", "GEN6_FEE_CREATOR_PCT_INVALID");
  }

  const firstBuyTokens = parseUintField(source.firstBuyTokens ?? source.firstBuyTokensWei, "firstBuyTokens", "GEN6_FIRST_BUY_TOKENS_INVALID");
  const firstBuyMaxCost = parseUintField(source.firstBuyMaxCost ?? source.firstBuyMaxCostWei, "firstBuyMaxCost", "GEN6_FIRST_BUY_MAX_COST_INVALID");
  if (firstBuyTokens === 0n && firstBuyMaxCost !== 0n) {
    fail("firstBuyMaxCost must be 0 when there is no first buy.", "GEN6_FIRST_BUY_MAX_COST_INVALID");
  }
  if (firstBuyTokens > 0n && firstBuyMaxCost === 0n && !autoMaxCost) {
    fail("A first buy needs firstBuyMaxCost, the most native you will pay for it including the 2% fee.", "GEN6_FIRST_BUY_MAX_COST_INVALID");
  }
  return { firstBuyTokens, firstBuyMaxCost, feeChoice, feeCreatorPct };
}

/** True when the body carries any generation-6 field with a non-empty value. */
export function hasGen6CreateFields(source = {}) {
  return [
    "firstBuyTokens",
    "firstBuyTokensWei",
    "firstBuyMaxCost",
    "firstBuyMaxCostWei",
    "feeChoice",
    "evmFeeChoice",
    "feeCreatorPct",
    "evmFeeCreatorPct",
  ].some((key) => {
    const value = source?.[key];
    if (value === undefined || value === null || value === "") return false;
    if (key.startsWith("firstBuy")) {
      try {
        return BigInt(value) !== 0n;
      } catch {
        return true;
      }
    }
    return true;
  });
}

/** LaunchCampaign._area with Math.mulDiv floors, exactly. */
export function curveArea(x, basePrice, priceSlope) {
  const tokens = BigInt(x);
  return (tokens * BigInt(basePrice)) / WAD + (BigInt(priceSlope) * tokens * tokens) / (2n * WAD * WAD);
}

/** LaunchCampaign.quoteCreatorFirstBuy at sold == 0 (the only state the first buy can run in). */
export function quoteGen6CreatorFirstBuy({ tokens, basePrice, priceSlope, protocolFeeBps }) {
  const costNoFee = curveArea(tokens, basePrice, priceSlope);
  const fee = (costNoFee * BigInt(protocolFeeBps)) / MAX_BPS;
  return { costNoFee, fee, cost: costNoFee + fee };
}

export function firstBuyMaxCostSlackBps(env = process.env) {
  const raw = String(env.EVM_FIRST_BUY_MAX_COST_SLACK_BPS || "").trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_FIRST_BUY_MAX_COST_SLACK_BPS;
  const n = BigInt(raw);
  return n > MAX_FIRST_BUY_MAX_COST_SLACK_BPS ? MAX_FIRST_BUY_MAX_COST_SLACK_BPS : n;
}

/**
 * Check the first buy against the factory's curve and the live native target. `context` is what
 * readGen6FactoryCreateContext returns. Returns the quote the client needs to build the create
 * transaction (msg.value = quotedCost is enough; the factory refunds anything above the cost).
 */
export function validateGen6FirstBuy(options, context, { slackBps = firstBuyMaxCostSlackBps() } = {}) {
  const { firstBuyTokens, firstBuyMaxCost } = options;
  if (firstBuyTokens === 0n) return { tokens: "0", maxCost: "0", costNoFee: "0", fee: "0", quotedCost: "0" };

  const totalSupply = BigInt(context.totalSupply);
  const curveSupply = (totalSupply * BigInt(context.curveBps)) / MAX_BPS;
  const maxTokens = (totalSupply * CREATOR_FIRST_BUY_MAX_SUPPLY_BPS) / MAX_BPS;
  if (firstBuyTokens > maxTokens) {
    fail(
      `The first buy can be at most 10% of the supply (${maxTokens.toString()} token units); asked for ${firstBuyTokens.toString()}.`,
      "GEN6_FIRST_BUY_TOO_LARGE",
      { maxTokens: maxTokens.toString() },
    );
  }
  if (firstBuyTokens > curveSupply) {
    fail("The first buy is larger than the curve's supply.", "GEN6_FIRST_BUY_TOO_LARGE", { curveSupply: curveSupply.toString() });
  }

  const quote = quoteGen6CreatorFirstBuy({
    tokens: firstBuyTokens,
    basePrice: context.basePrice,
    priceSlope: context.priceSlope,
    protocolFeeBps: context.protocolFeeBps,
  });
  const nativeTarget = BigInt(context.nativeTargetWei);
  if (quote.costNoFee * MAX_BPS > nativeTarget * CREATOR_FIRST_BUY_MAX_TARGET_BPS) {
    fail(
      "The first buy would cost more than half of the coin's graduation target at today's price. Choose fewer tokens.",
      "GEN6_FIRST_BUY_TOO_EXPENSIVE",
      { costNoFee: quote.costNoFee.toString(), nativeTargetWei: nativeTarget.toString() },
    );
  }
  if (firstBuyMaxCost < quote.cost) {
    fail(
      `firstBuyMaxCost ${firstBuyMaxCost.toString()} is below the first buy's cost of ${quote.cost.toString()} wei including the 2% fee.`,
      "GEN6_FIRST_BUY_MAX_COST_TOO_LOW",
      { quotedCost: quote.cost.toString() },
    );
  }
  const ceiling = quote.cost + (quote.cost * BigInt(slackBps)) / MAX_BPS;
  if (firstBuyMaxCost > ceiling) {
    fail(
      `firstBuyMaxCost may be at most ${ceiling.toString()} wei (the cost plus ${Number(slackBps) / 100}%).`,
      "GEN6_FIRST_BUY_MAX_COST_TOO_HIGH",
      { quotedCost: quote.cost.toString(), maxAllowed: ceiling.toString() },
    );
  }
  return {
    tokens: firstBuyTokens.toString(),
    maxCost: firstBuyMaxCost.toString(),
    costNoFee: quote.costNoFee.toString(),
    fee: quote.fee.toString(),
    quotedCost: quote.cost.toString(),
  };
}

const GEN6_FACTORY_CONTEXT_ABI = [
  "function config() view returns (uint256 totalSupply,uint256 curveBps,uint256 liquidityTokenBps,uint256 basePrice,uint256 priceSlope,uint256 graduationTarget)",
  "function protocolFeeBps() view returns (uint256)",
  "function graduationOracle() view returns (address)",
];
const ORACLE_ABI = ["function nativeTargetForUsd(uint256 usdAmount) view returns (uint256)"];

/** The factory values validateGen6FirstBuy needs. `graduationTarget` 0 means the factory default. */
export async function readGen6FactoryCreateContext({ provider, factoryAddress, graduationTarget = 0 }) {
  const factory = new ethers.Contract(factoryAddress, GEN6_FACTORY_CONTEXT_ABI, provider);
  const [config, protocolFeeBps, oracleAddress] = await Promise.all([
    factory.config(),
    factory.protocolFeeBps(),
    factory.graduationOracle(),
  ]);
  const target = BigInt(graduationTarget || 0) === 0n ? BigInt(config.graduationTarget ?? config[5]) : BigInt(graduationTarget);
  const oracle = new ethers.Contract(oracleAddress, ORACLE_ABI, provider);
  const nativeTargetWei = await oracle.nativeTargetForUsd(target);
  return {
    totalSupply: BigInt(config.totalSupply ?? config[0]),
    curveBps: BigInt(config.curveBps ?? config[1]),
    basePrice: BigInt(config.basePrice ?? config[3]),
    priceSlope: BigInt(config.priceSlope ?? config[4]),
    protocolFeeBps: BigInt(protocolFeeBps),
    graduationTargetUsdWad: target,
    nativeTargetWei: BigInt(nativeTargetWei),
  };
}

/**
 * Parse + validate the generation-6 fields and return the request additions to sign plus the
 * first-buy quote. `readContext` is injectable for tests.
 */
export async function prepareGen6CreateOptions({ source, graduationTarget, readContext, slackBps, autoMaxCost = false }) {
  const options = parseGen6CreateOptions(source, { autoMaxCost });
  let firstBuy = { tokens: "0", maxCost: "0", costNoFee: "0", fee: "0", quotedCost: "0" };
  if (options.firstBuyTokens > 0n) {
    let context;
    try {
      context = await readContext({ graduationTarget });
    } catch (error) {
      const err = new Gen6CreateOptionError(
        `The first buy could not be priced against the factory: ${String(error?.shortMessage || error?.message || error)}`,
        "GEN6_FIRST_BUY_PRICE_UNAVAILABLE",
      );
      err.httpStatus = 503;
      throw err;
    }
    const slack = slackBps === undefined ? firstBuyMaxCostSlackBps() : BigInt(slackBps);
    if (autoMaxCost && options.firstBuyMaxCost === 0n) {
      // Saved drafts store only the token amount; the max cost is set at arm time to the exact cost
      // plus the slack, the most validateGen6FirstBuy accepts.
      const { cost } = quoteGen6CreatorFirstBuy({
        tokens: options.firstBuyTokens,
        basePrice: context.basePrice,
        priceSlope: context.priceSlope,
        protocolFeeBps: context.protocolFeeBps,
      });
      options.firstBuyMaxCost = cost + (cost * slack) / MAX_BPS;
    }
    firstBuy = validateGen6FirstBuy(options, context, { slackBps: slack });
  }
  return {
    requestFields: {
      firstBuyTokens: options.firstBuyTokens.toString(),
      firstBuyMaxCost: options.firstBuyMaxCost.toString(),
      feeChoice: options.feeChoice,
      feeCreatorPct: options.feeCreatorPct,
    },
    feeChoiceName: FEE_CHOICE_NAMES[options.feeChoice],
    firstBuy,
  };
}

/** For factories older than generation 6: the fields have no place in the signed request. */
export function assertNoGen6FieldsForLegacy(source, factoryGeneration) {
  if (hasGen6CreateFields(source)) {
    fail(
      `This factory (generation ${factoryGeneration}) has no creator first buy or fee choice. Remove those fields or create on the generation 6 factory.`,
      "GEN6_FIELDS_ON_LEGACY_FACTORY",
    );
  }
}
