/**
 * EVM launch generation 7 (factory 7 / campaign 6): the app's rules on top of the curve maths in
 * shared/evmGen7Curve.mjs (docs/evm-launch/EVM_GEN7_V2_PLAN.md, G1-G9).
 *
 * Gen-7 takes the same 11-field create request as gen-6, so the create fields, the fee choice and the
 * signed-request check are gen-6's (evmGen6.mjs). What differs: the curve is constant product and sized
 * at create from the oracle, the first buy may be up to 70% of supply with no cost cap, the launch fee
 * starts at 90%, the graduation target is a market cap ($30K or $50K, $150 on testnets) and the creator
 * gets no graduation payout. Gen-6 coins never reach anything in this file.
 */
import {
  GEN7_ANTI_SNIPER_START_BPS,
  GEN7_TARGET_DEFAULT_USD,
  GEN7_TARGET_FAST_USD,
  GEN7_TARGET_TEST_USD,
  GEN7_TEST_TARGET_CHAIN_IDS,
  isEvmGen7Pair,
} from "../../shared/evmGen7Curve.mjs";
import { encodeEvmFeeChoice, isEvmGen6Pair } from "./evmGen6.mjs";

export * from "../../shared/evmGen7Curve.mjs";

const MAX_BPS = 10_000n;

/** LaunchCampaignGen7.ANTI_SNIPER_WINDOW. */
export const GEN7_ANTI_SNIPER_WINDOW_SECONDS = 60;

/**
 * A gen-7 coin's curve is sized from the oracle when the create mines, so the first buy's cost can
 * move between this page's quote and the block. The create carries firstBuyMaxCost = quote + 2%; the
 * factory refunds whatever the buy does not use, and the API refuses more than its own slack
 * (EVM_FIRST_BUY_MAX_COST_SLACK_BPS, 5% by default).
 */
export const EVM_GEN7_FIRST_BUY_SLACK_BPS = 200n;

/** 6 for a gen-6 factory (6/5), 7 for a gen-7 factory (7/6), null for every other pair. */
export function evmLaunchGeneration(factoryGeneration, campaignGeneration) {
  if (isEvmGen7Pair(factoryGeneration, campaignGeneration)) return 7;
  if (isEvmGen6Pair(factoryGeneration, campaignGeneration)) return 6;
  return null;
}

function big(value) {
  if (typeof value === "bigint") return value;
  if (value == null || value === "") return 0n;
  return BigInt(String(value));
}

/** The most a first-buy quote of `total` may cost when the create mines (ceil of total + slack). */
export function gen7FirstBuyMaxCost(total, slackBps = EVM_GEN7_FIRST_BUY_SLACK_BPS) {
  const t = big(total);
  if (t <= 0n) return 0n;
  const p = t * (MAX_BPS + big(slackBps));
  return p / MAX_BPS + (p % MAX_BPS === 0n ? 0n : 1n);
}

/**
 * The four create-request fields for a gen-7 factory, the same shape as gen6CreateFields. The value
 * sent is firstBuyMaxCost (quote + slack); the factory refunds the part the buy does not use.
 */
export function gen7CreateFields({ choice, creatorSharePct, firstBuy, slackBps = EVM_GEN7_FIRST_BUY_SLACK_BPS }) {
  const { feeChoice, feeCreatorPct } = encodeEvmFeeChoice(choice, creatorSharePct);
  const tokens = firstBuy ? big(firstBuy.tokens) : 0n;
  const maxCost = tokens > 0n ? gen7FirstBuyMaxCost(firstBuy.total, slackBps) : 0n;
  return {
    firstBuyTokens: tokens,
    firstBuyMaxCost: maxCost,
    feeChoice,
    feeCreatorPct,
    value: maxCost,
  };
}

/**
 * The largest first-buy budget the wallet can pay: the value sent is the quote plus the slack, and
 * `gasReserveWei` stays in the wallet for the create's gas. 0 when the balance does not cover the reserve.
 */
export function gen7MaxFirstBuyBudget({ balanceWei, gasReserveWei, slackBps = EVM_GEN7_FIRST_BUY_SLACK_BPS }) {
  const left = big(balanceWei) - big(gasReserveWei);
  if (left <= 0n) return 0n;
  return (left * MAX_BPS) / (MAX_BPS + big(slackBps));
}

/** True when a first buy of `totalWei` (quote) plus the slack and the gas reserve is above the balance. */
export function gen7FirstBuyOverBalance({ totalWei, balanceWei, gasReserveWei, slackBps = EVM_GEN7_FIRST_BUY_SLACK_BPS }) {
  if (balanceWei == null) return false;
  const total = big(totalWei);
  if (total <= 0n) return false;
  return gen7FirstBuyMaxCost(total, slackBps) + big(gasReserveWei) > big(balanceWei);
}

// ---------------------------------------------------------------- graduation tiers (G3, C8)

/** Where a gen-7 coin's pool opens: Uniswap on Robinhood (V3 fee 3000), Topaz on BNB (V2, 30 bps). */
export function evmGen7DexName(chainId) {
  const id = Number(chainId);
  if (id === 4663 || id === 46630) return "Uniswap";
  if (id === 56 || id === 97) return "Topaz";
  return "DEX";
}

export const EVM_GEN7_DEFAULT_GRADUATION_TARGET_WEI = GEN7_TARGET_DEFAULT_USD;

/**
 * The create page's graduation choices for a gen-7 factory: the graduation MARKET CAP, worded like the
 * DBC tiers (src/lib/dbcGraduationTiers.ts). $150 only where the factory accepts it (97, 46630, 6281971)
 * and the app's test tier is enabled for the chain.
 */
export function evmGen7GraduationTiers(chainId, { testTierEnabled = false } = {}) {
  const dex = evmGen7DexName(chainId);
  const tiers = [
    {
      id: "fast",
      label: "$30K MC",
      title: "Fast grad",
      description: `Moves to a ${dex} pool when the market cap reaches $30K.`,
      targetWei: GEN7_TARGET_FAST_USD,
    },
    {
      id: "normal",
      label: "$50K MC",
      title: "Normal",
      description: `Moves to a ${dex} pool when the market cap reaches $50K.`,
      targetWei: GEN7_TARGET_DEFAULT_USD,
    },
  ];
  if (testTierEnabled && GEN7_TEST_TARGET_CHAIN_IDS.includes(Number(chainId))) {
    tiers.unshift({
      id: "test",
      label: "$150",
      title: "Testnet rehearsal",
      description: "Testnet only: graduates at a $150 market cap.",
      targetWei: GEN7_TARGET_TEST_USD,
      testOnly: true,
    });
  }
  return tiers;
}

// ---------------------------------------------------------------- launch fee (G6, C6)

/** LaunchCampaignGen7.currentTradeFeeBps, exact integer arithmetic: 90% falling to the base over 60 s. */
export function gen7TradeFeeBps({ launchAt, nowUnix, baseFeeBps = 200 }) {
  const base = Number(baseFeeBps);
  const end = Number(launchAt) + GEN7_ANTI_SNIPER_WINDOW_SECONDS;
  const now = Number(nowUnix);
  if (now >= end) return base;
  let left = end - now;
  if (left > GEN7_ANTI_SNIPER_WINDOW_SECONDS) left = GEN7_ANTI_SNIPER_WINDOW_SECONDS;
  return base + Math.floor(((GEN7_ANTI_SNIPER_START_BPS - base) * left) / GEN7_ANTI_SNIPER_WINDOW_SECONDS);
}

/** "Launch fee: X% now, 2% from HH:MM:SS.": the DBC line (antiSniperFeeLine), from the gen-7 contract formula. */
export function gen7AntiSniperLine({ launchAt, nowUnix, baseFeeBps = 200, timeZone } = {}) {
  const now = Number(nowUnix ?? Math.floor(Date.now() / 1000));
  const start = Number(launchAt || 0);
  const bps = gen7TradeFeeBps({ launchAt: start, nowUnix: now, baseFeeBps });
  const pct = Math.round(bps / 100);
  const basePct = Math.round(Number(baseFeeBps) / 100);
  if (bps <= Number(baseFeeBps)) return `Launch fee: ${pct}% now.`;
  const when = new Date((start + GEN7_ANTI_SNIPER_WINDOW_SECONDS) * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone,
  });
  return `Launch fee: ${pct}% now, ${basePct}% from ${when}.`;
}

// ---------------------------------------------------------------- creator panel (G4, C4)

/**
 * Gen-7 pays the creator nothing at graduation. The campaign can still hold native the pool did not
 * take, or quote tokens left over, for the coin owner (pendingCreatorGraduation / pendingCreatorQuote);
 * the panel shows that row only when something is there.
 */
export function gen7ShowsGraduationRefund({ launched, pendingGraduation, pendingGraduationQuote }) {
  return Boolean(launched) && (big(pendingGraduation) > 0n || big(pendingGraduationQuote) > 0n);
}
