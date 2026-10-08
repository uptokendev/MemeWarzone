/**
 * EVM launch generation 7 (factory 7 / campaign 6): the constant-product curve and the economics the
 * app and the API need, mirroring contracts/gen7 exactly (docs/evm-launch/EVM_GEN7_V2_PLAN.md).
 *
 *   Y(s)   = ceil(vN * vT / (vT - s))            native the curve holds at `s` tokens sold (plus vN)
 *   buy a  = Y(s + a) - Y(s)                     sell a = Y(s) - Y(s - a)
 *   price  = floor(Y(s) * 1e18 / (vT - s))       wei per whole token
 *
 * The factory sizes vN / vT at create from the oracle (curveForMarketCap); after that the curve is fixed.
 * Every function is integer-exact against the Solidity, so a quote here equals the contract's quote.
 * Gen-6 coins keep src/lib/evmGen6.mjs; nothing here applies to them.
 */

export const EVM_GEN7_FACTORY_GENERATION = 7;
export const EVM_GEN7_CAMPAIGN_GENERATION = 6;

export const GEN7_MAX_BPS = 10_000n;
const WAD = 10n ** 18n;

/** LaunchCampaignGen7.CREATOR_FIRST_BUY_MAX_SUPPLY_BPS: 70% of supply, no cost cap (G5). */
export const GEN7_FIRST_BUY_MAX_SUPPLY_BPS = 7000n;
/** LaunchCampaignGen7.ANTI_SNIPER_START_BPS: 90% falling to the base fee over 60 s (G6). */
export const GEN7_ANTI_SNIPER_START_BPS = 9000;
/** Graduation fee 2%, all to the fee router; creator 0% (G4). */
export const GEN7_GRAD_PROTOCOL_BPS = 200n;
export const GEN7_GRAD_CREATOR_BPS = 0n;
/** LaunchFactoryGen7 bounds. */
export const GEN7_POOL_MARGIN_BPS = 1n;
export const GEN7_MIN_MARKET_CAP_NATIVE = 10n ** 15n;
export const GEN7_MAX_VIRTUAL_NATIVE = 10n ** 30n;
/** Default supply split (G1): 85% curve, 13% pool, 2% creator reserve. */
export const GEN7_DEFAULT_CURVE_BPS = 8500n;
export const GEN7_DEFAULT_LIQUIDITY_BPS = 1300n;

/** Graduation market caps in USD (1e18), as LaunchFactoryGen7. The $150 one exists on testnets only. */
export const GEN7_TARGET_FAST_USD = 30_000n * WAD;
export const GEN7_TARGET_DEFAULT_USD = 50_000n * WAD;
export const GEN7_TARGET_TEST_USD = 150n * WAD;
export const GEN7_TEST_TARGET_CHAIN_IDS = Object.freeze([97, 46630, 6281971]);

/** Create-page note: same words as the Solana DBC note (DBC_LAUNCH_FEE_NOTE). */
export const GEN7_LAUNCH_FEE_NOTE =
  "The fee starts at 90% and falls to 2% within 60 seconds, so bots that buy at launch pay for it. Your own first buy does not.";

function big(value) {
  if (typeof value === "bigint") return value;
  if (value == null || value === "") return 0n;
  return BigInt(String(value));
}

function mulDiv(a, b, d) {
  return (a * b) / d;
}

function mulDivCeil(a, b, d) {
  const p = a * b;
  return p / d + (p % d === 0n ? 0n : 1n);
}

export function isEvmGen7Pair(factoryGeneration, campaignGeneration) {
  return (
    Number(factoryGeneration) === EVM_GEN7_FACTORY_GENERATION &&
    Number(campaignGeneration) === EVM_GEN7_CAMPAIGN_GENERATION
  );
}

/** LaunchFactoryGen7.isGraduationTargetAllowedForChain (31337 accepts any, as gen-6's test rule). */
export function isGen7TargetAllowed(chainId, targetUsdWad) {
  const t = big(targetUsdWad);
  if (Number(chainId) === 31337) return t > 0n;
  if (t === GEN7_TARGET_FAST_USD || t === GEN7_TARGET_DEFAULT_USD) return true;
  return t === GEN7_TARGET_TEST_USD && GEN7_TEST_TARGET_CHAIN_IDS.includes(Number(chainId));
}

/**
 * LaunchFactoryGen7.curveForMarketCap, integer-exact. `marketCapNative` is the native wei for the whole
 * supply at the graduation price (oracle.nativeTargetForUsd(targetUsd)). Throws with the contract's
 * error name when the contract would revert.
 */
export function curveForMarketCap(marketCapNative, supply, curveBps = GEN7_DEFAULT_CURVE_BPS, liquidityBps = GEN7_DEFAULT_LIQUIDITY_BPS) {
  const mc = big(marketCapNative);
  const s = big(supply);
  if (mc < GEN7_MIN_MARKET_CAP_NATIVE) throw new Error("TargetOutOfRangeAtPrice");
  const curve = (s * big(curveBps)) / GEN7_MAX_BPS;
  const poolDesign = (((s * big(liquidityBps)) / GEN7_MAX_BPS) * (GEN7_MAX_BPS - GEN7_POOL_MARGIN_BPS)) / GEN7_MAX_BPS;
  const rn = poolDesign * GEN7_MAX_BPS;
  const rd = (GEN7_MAX_BPS - GEN7_GRAD_PROTOCOL_BPS - GEN7_GRAD_CREATOR_BPS) * curve;
  if (curve === 0n || rn === 0n || rn >= rd) throw new Error("SupplyBoundBroken");
  const virtualToken = mulDiv(curve, rd, rd - rn);
  const virtualNative = mulDiv(mulDiv(mulDiv(mc, virtualToken, s), rn, rd), rn, rd);
  if (virtualNative === 0n || virtualNative > GEN7_MAX_VIRTUAL_NATIVE) throw new Error("TargetOutOfRangeAtPrice");
  return { virtualNative, virtualToken };
}

/** LaunchCampaignGen7._curveNative: Y(s), rounded up. `s` must be below vT (every caller bounds it). */
export function curveNative(virtualNative, virtualToken, sold) {
  const vT = big(virtualToken);
  const s = big(sold);
  if (s < 0n || s >= vT) throw new Error("sold outside the curve");
  return mulDivCeil(big(virtualNative), vT, vT - s);
}

/** Native cost before fee of buying `amount` at `sold` (LaunchCampaignGen7._quoteBuyNoFee). */
export function buyCostNoFee(virtualNative, virtualToken, sold, amount) {
  const s = big(sold);
  return curveNative(virtualNative, virtualToken, s + big(amount)) - curveNative(virtualNative, virtualToken, s);
}

/** Native payout before fee of selling `amount` at `sold` (LaunchCampaignGen7._quoteSellNoFee). */
export function sellPayoutNoFee(virtualNative, virtualToken, sold, amount) {
  const s = big(sold);
  return curveNative(virtualNative, virtualToken, s) - curveNative(virtualNative, virtualToken, s - big(amount));
}

/** LaunchCampaignGen7._currentPrice: wei per whole token (1e18 units) at `sold`. */
export function spotPrice(virtualNative, virtualToken, sold) {
  const vT = big(virtualToken);
  const s = big(sold);
  return mulDiv(curveNative(virtualNative, virtualToken, s), WAD, vT - s);
}

/** LaunchCampaignGen7.graduationNativeTarget: what the curve raises when it sells out. */
export function graduationRaise(virtualNative, virtualToken, curveSupply) {
  return curveNative(virtualNative, virtualToken, curveSupply) - curveNative(virtualNative, virtualToken, 0n);
}

/** The curve a gen-7 factory would give a coin created now: config + the oracle's market cap in native. */
export function gen7CurveFromConfig({ totalSupply, curveBps, liquidityTokenBps, marketCapNativeWei }) {
  const supply = big(totalSupply);
  const curveSupply = (supply * big(curveBps)) / GEN7_MAX_BPS;
  const { virtualNative, virtualToken } = curveForMarketCap(marketCapNativeWei, supply, curveBps, liquidityTokenBps);
  return { totalSupply: supply, curveSupply, virtualNative, virtualToken };
}

/** LaunchCampaignGen7.quoteCreatorFirstBuy at sold = 0: cost + flat protocol fee. */
export function quoteGen7FirstBuy({ tokens, virtualNative, virtualToken, protocolFeeBps }) {
  const t = big(tokens);
  const costNoFee = t > 0n ? buyCostNoFee(virtualNative, virtualToken, 0n, t) : 0n;
  const fee = (costNoFee * big(protocolFeeBps)) / GEN7_MAX_BPS;
  return { tokens: t, costNoFee, fee, total: costNoFee + fee };
}

/** The first-buy limit: 70% of supply (never the whole curve; the factory refuses a config where it could be). */
export function gen7FirstBuyLimits({ totalSupply, curveSupply, virtualNative, virtualToken, protocolFeeBps }) {
  const supplyCap = (big(totalSupply) * GEN7_FIRST_BUY_MAX_SUPPLY_BPS) / GEN7_MAX_BPS;
  const maxTokens = supplyCap < big(curveSupply) ? supplyCap : big(curveSupply);
  const maxQuote = quoteGen7FirstBuy({ tokens: maxTokens, virtualNative, virtualToken, protocolFeeBps });
  return { maxTokens, maxTotalWei: maxQuote.total, supplyCapTokens: supplyCap, limitedBy: "supply" };
}

/** The most tokens a native budget buys at the flat fee (mirror of quoteBuyExactBnb at sold = 0). */
export function gen7FirstBuyTokensForBudget({ budgetWei, virtualNative, virtualToken, protocolFeeBps, maxTokens }) {
  const budget = big(budgetWei);
  if (budget <= 0n) return 0n;
  let lo = 0n;
  let hi = big(maxTokens);
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (quoteGen7FirstBuy({ tokens: mid, virtualNative, virtualToken, protocolFeeBps }).total <= budget) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/**
 * The create page's first-buy plan for `budgetWei` native, same shape as evmGen6.planFirstBuy.
 * `config` is factory.config() ({ totalSupply, curveBps, liquidityTokenBps }); `marketCapNativeWei` is
 * oracle.nativeTargetForUsd(target) now. The coin's real curve is sized when the create mines, so the
 * create carries firstBuyMaxCost with slack (the API's EVM_FIRST_BUY_MAX_COST_SLACK_BPS).
 */
export function planGen7FirstBuy({ budgetWei, config, protocolFeeBps, marketCapNativeWei }) {
  // Named fields or an ethers Result of factory.config() (totalSupply, curveBps, liquidityTokenBps, graduationTarget).
  const c = gen7CurveFromConfig({
    totalSupply: config.totalSupply ?? config[0],
    curveBps: config.curveBps ?? config[1],
    liquidityTokenBps: config.liquidityTokenBps ?? config[2],
    marketCapNativeWei,
  });
  const limits = gen7FirstBuyLimits({ ...c, protocolFeeBps });
  const raise = graduationRaise(c.virtualNative, c.virtualToken, c.curveSupply);
  const budget = big(budgetWei);
  const base = { ...limits, graduationRaiseWei: raise, curve: c };
  if (budget <= 0n) {
    return { ...base, tokens: 0n, costNoFee: 0n, fee: 0n, total: 0n, supplyBps: 0, exceedsCap: false };
  }
  const tokens = gen7FirstBuyTokensForBudget({ budgetWei: budget, ...c, protocolFeeBps, maxTokens: limits.maxTokens });
  const quote = quoteGen7FirstBuy({ tokens, ...c, protocolFeeBps });
  const supplyBps = c.totalSupply > 0n ? Number((tokens * GEN7_MAX_BPS) / c.totalSupply) : 0;
  return { ...base, ...quote, supplyBps, exceedsCap: budget > limits.maxTotalWei };
}

/** Market cap in native wei at `sold`: price x total supply (the graduation target is this at sell-out). */
export function gen7MarketCapNative({ virtualNative, virtualToken, sold, totalSupply }) {
  return mulDiv(spotPrice(virtualNative, virtualToken, sold), big(totalSupply), WAD);
}
