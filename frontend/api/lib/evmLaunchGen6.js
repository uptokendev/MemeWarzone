import { ethers } from "ethers";
import {
  EVM_GEN7_FACTORY_GENERATION,
  GEN7_FIRST_BUY_MAX_SUPPLY_BPS,
  gen7CurveFromConfig,
  graduationRaise,
  quoteGen7FirstBuy,
} from "../../shared/evmGen7Curve.mjs";

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
 *
 * Generation 7 (LaunchFactoryGen7, docs/evm-launch/EVM_GEN7_V2_PLAN.md G5) signs the same four fields.
 * Its rules: firstBuyTokens <= 70% of totalSupply and <= curveSupply; no cost cap (FirstBuyTooExpensive
 * is gone); the cost is on the constant-product curve the factory sizes at create from the oracle's
 * market cap in native (curveForMarketCap). That curve is fixed only when the create mines, so the
 * same max-cost slack covers an oracle move between signing and mining. The context reader reads
 * FACTORY_GENERATION on chain and picks the curve; a context without factoryGeneration is generation 6.
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

function isGen7Context(context) {
  return Number(context?.factoryGeneration) === EVM_GEN7_FACTORY_GENERATION;
}

/**
 * The creator first buy's cost on the context's curve: generation 7 constant product
 * (LaunchCampaignGen7.quoteCreatorFirstBuy), else the generation 6 linear curve, unchanged.
 */
export function quoteCreatorFirstBuyForContext(tokens, context) {
  if (isGen7Context(context)) {
    const q = quoteGen7FirstBuy({
      tokens,
      virtualNative: context.virtualNative,
      virtualToken: context.virtualToken,
      protocolFeeBps: context.protocolFeeBps,
    });
    return { costNoFee: q.costNoFee, fee: q.fee, cost: q.total };
  }
  return quoteGen6CreatorFirstBuy({
    tokens,
    basePrice: context.basePrice,
    priceSlope: context.priceSlope,
    protocolFeeBps: context.protocolFeeBps,
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

  const gen7 = isGen7Context(context);
  const totalSupply = BigInt(context.totalSupply);
  const curveSupply = (totalSupply * BigInt(context.curveBps)) / MAX_BPS;
  const maxSupplyBps = gen7 ? GEN7_FIRST_BUY_MAX_SUPPLY_BPS : CREATOR_FIRST_BUY_MAX_SUPPLY_BPS;
  const maxTokens = (totalSupply * maxSupplyBps) / MAX_BPS;
  if (firstBuyTokens > maxTokens) {
    fail(
      `The first buy can be at most ${gen7 ? "70%" : "10%"} of the supply (${maxTokens.toString()} token units); asked for ${firstBuyTokens.toString()}.`,
      "GEN6_FIRST_BUY_TOO_LARGE",
      { maxTokens: maxTokens.toString() },
    );
  }
  if (firstBuyTokens > curveSupply) {
    fail("The first buy is larger than the curve's supply.", "GEN6_FIRST_BUY_TOO_LARGE", { curveSupply: curveSupply.toString() });
  }

  const quote = quoteCreatorFirstBuyForContext(firstBuyTokens, context);
  // Generation 7 has no cost cap (G5); generation 6 refuses more than half the live native target.
  const nativeTarget = gen7 ? 0n : BigInt(context.nativeTargetWei);
  if (!gen7 && quote.costNoFee * MAX_BPS > nativeTarget * CREATOR_FIRST_BUY_MAX_TARGET_BPS) {
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
  const out = {
    tokens: firstBuyTokens.toString(),
    maxCost: firstBuyMaxCost.toString(),
    costNoFee: quote.costNoFee.toString(),
    fee: quote.fee.toString(),
    quotedCost: quote.cost.toString(),
  };
  if (!gen7) return out;
  // Generation 7 only: the curve the quote used (the coin's own curve is sized when the create mines).
  return {
    ...out,
    generation: EVM_GEN7_FACTORY_GENERATION,
    maxTokens: maxTokens.toString(),
    curve: {
      kind: "cp",
      virtualNative: BigInt(context.virtualNative).toString(),
      virtualToken: BigInt(context.virtualToken).toString(),
      curveSupply: curveSupply.toString(),
      marketCapNativeWei: BigInt(context.marketCapNativeWei).toString(),
      graduationRaiseWei: BigInt(context.graduationRaiseWei).toString(),
    },
  };
}

const GEN6_FACTORY_CONTEXT_ABI = [
  "function config() view returns (uint256 totalSupply,uint256 curveBps,uint256 liquidityTokenBps,uint256 basePrice,uint256 priceSlope,uint256 graduationTarget)",
  "function protocolFeeBps() view returns (uint256)",
  "function graduationOracle() view returns (address)",
  "function FACTORY_GENERATION() view returns (uint32)",
];
// LaunchFactoryGen7: config() has 4 fields (no basePrice / priceSlope); the curve comes from curveForMarketCap.
const GEN7_FACTORY_CONTEXT_ABI = [
  "function config() view returns (uint256 totalSupply,uint256 curveBps,uint256 liquidityTokenBps,uint256 graduationTarget)",
  "function curveForMarketCap(uint256 marketCapNative,uint256 supply,uint256 curveBps,uint256 liquidityBps) view returns (uint256 virtualNative,uint256 virtualToken)",
];
const ORACLE_ABI = ["function nativeTargetForUsd(uint256 usdAmount) view returns (uint256)"];
const gen6FactoryInterface = new ethers.Interface(GEN6_FACTORY_CONTEXT_ABI);
const gen7FactoryInterface = new ethers.Interface(GEN7_FACTORY_CONTEXT_ABI);

/**
 * The factory values validateGen6FirstBuy needs. `graduationTarget` 0 means the factory default.
 *
 * The generation is read from the factory itself (FACTORY_GENERATION, in the same round as the other
 * reads): config() has 6 fields on generation 6 and 4 on generation 7, and the caller's generation may
 * come from the client (scheduled arm), so it is only cross-checked. A mismatch throws (no signature).
 */
export async function readGen6FactoryCreateContext({ provider, factoryAddress, graduationTarget = 0, factoryGeneration = null }) {
  const factory = new ethers.Contract(factoryAddress, GEN6_FACTORY_CONTEXT_ABI, provider);
  // config() has the same selector on both generations; it is decoded once the generation is known.
  const [configData, protocolFeeBps, oracleAddress, generationRaw] = await Promise.all([
    provider.call({ to: factoryAddress, data: gen6FactoryInterface.encodeFunctionData("config", []) }),
    factory.protocolFeeBps(),
    factory.graduationOracle(),
    factory.FACTORY_GENERATION(),
  ]);
  const onChainGeneration = Number(generationRaw);
  if (factoryGeneration !== null && factoryGeneration !== undefined && Number(factoryGeneration) !== onChainGeneration) {
    throw new Error(`The factory reports generation ${onChainGeneration}, not ${Number(factoryGeneration)}.`);
  }
  if (onChainGeneration === EVM_GEN7_FACTORY_GENERATION) {
    const config = gen7FactoryInterface.decodeFunctionResult("config", configData);
    return readGen7CurveContext({ provider, factoryAddress, config, protocolFeeBps, oracleAddress, graduationTarget });
  }
  const config = gen6FactoryInterface.decodeFunctionResult("config", configData);
  const target = BigInt(graduationTarget || 0) === 0n ? BigInt(config.graduationTarget ?? config[5]) : BigInt(graduationTarget);
  const oracle = new ethers.Contract(oracleAddress, ORACLE_ABI, provider);
  const nativeTargetWei = await oracle.nativeTargetForUsd(target);
  return {
    factoryGeneration: onChainGeneration,
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
 * Generation 7: the curve the factory would give a coin created now. The oracle's market cap in native
 * (nativeTargetForUsd of the USD market-cap target) sized by evmGen7Curve.curveForMarketCap, cross-checked
 * against the factory's own curveForMarketCap view; any difference refuses (no signature on a curve we
 * cannot reproduce).
 */
async function readGen7CurveContext({ provider, factoryAddress, config, protocolFeeBps, oracleAddress, graduationTarget }) {
  const totalSupply = BigInt(config.totalSupply ?? config[0]);
  const curveBps = BigInt(config.curveBps ?? config[1]);
  const liquidityTokenBps = BigInt(config.liquidityTokenBps ?? config[2]);
  const target = BigInt(graduationTarget || 0) === 0n ? BigInt(config.graduationTarget ?? config[3]) : BigInt(graduationTarget);
  const oracle = new ethers.Contract(oracleAddress, ORACLE_ABI, provider);
  const marketCapNativeWei = BigInt(await oracle.nativeTargetForUsd(target));
  const curve = gen7CurveFromConfig({ totalSupply, curveBps, liquidityTokenBps, marketCapNativeWei });
  const factory = new ethers.Contract(factoryAddress, GEN7_FACTORY_CONTEXT_ABI, provider);
  const onChain = await factory.curveForMarketCap(marketCapNativeWei, totalSupply, curveBps, liquidityTokenBps);
  const onChainVn = BigInt(onChain.virtualNative ?? onChain[0]);
  const onChainVt = BigInt(onChain.virtualToken ?? onChain[1]);
  if (onChainVn !== curve.virtualNative || onChainVt !== curve.virtualToken) {
    throw new Error("The factory's curve differs from the API's generation 7 curve maths.");
  }
  return {
    factoryGeneration: EVM_GEN7_FACTORY_GENERATION,
    totalSupply,
    curveBps,
    liquidityTokenBps,
    curveSupply: curve.curveSupply,
    virtualNative: curve.virtualNative,
    virtualToken: curve.virtualToken,
    protocolFeeBps: BigInt(protocolFeeBps),
    graduationTargetUsdWad: target,
    marketCapNativeWei,
    graduationRaiseWei: graduationRaise(curve.virtualNative, curve.virtualToken, curve.curveSupply),
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
      const { cost } = quoteCreatorFirstBuyForContext(options.firstBuyTokens, context);
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
