/**
 * EVM launch generation 6 (factory) / 5 (campaign): pure rules for the app.
 *
 * Every number mirrors the contracts on `claude/evm-core`
 * (contracts/LaunchCampaign.sol, contracts/LaunchFactory.sol) and the Solana DBC
 * values they copy (E2). The wording is the DBC wording wherever the concept is
 * the same, so the two launch types read alike.
 *
 * Only generation-6 factories and generation-5 campaigns use this. Older
 * factories stay on their existing create/trade code (E14).
 */
import {
  DBC_ANTI_SNIPER_DURATION_SECONDS,
  DBC_ANTI_SNIPER_START_FEE_BPS,
  DBC_CREATOR_LOCK_COPY,
  DBC_FIRST_BUY_MAX_BPS,
  DBC_LOCK_CLIFF_SECONDS,
  DBC_LOCK_FREQUENCY_SECONDS,
  DBC_LOCK_PERIODS,
} from "../../shared/dbcEconomics.mjs";
import { antiSniperFeeLine } from "../../shared/dbcAntiSniper.mjs";
import { creatorLockBadge } from "../../shared/dbcLockSchedule.mjs";

export const EVM_GEN6_FACTORY_GENERATION = 6;
export const EVM_GEN5_CAMPAIGN_GENERATION = 5;

const MAX_BPS = 10_000n;
const WAD = 10n ** 18n;

/** LaunchCampaign.CREATOR_FIRST_BUY_MAX_SUPPLY_BPS (= DBC D11, 10% of supply). */
export const EVM_FIRST_BUY_MAX_SUPPLY_BPS = BigInt(DBC_FIRST_BUY_MAX_BPS);
/** LaunchCampaign.CREATOR_FIRST_BUY_MAX_TARGET_BPS: cost before fee <= 50% of the native target (E8). */
export const EVM_FIRST_BUY_MAX_TARGET_BPS = 5_000n;

/** C2: the same 50% -> 2% over 60 s as DBC D14. */
export const EVM_ANTI_SNIPER_START_BPS = DBC_ANTI_SNIPER_START_FEE_BPS;
export const EVM_ANTI_SNIPER_WINDOW_SECONDS = DBC_ANTI_SNIPER_DURATION_SECONDS;

/** C4: 20% at 30 days after each buy, then 20% every 7 days (DBC D12). */
export const EVM_ESCROW_CLIFF_SECONDS = DBC_LOCK_CLIFF_SECONDS;
export const EVM_ESCROW_STEP_SECONDS = DBC_LOCK_FREQUENCY_SECONDS;
export const EVM_ESCROW_STEPS = DBC_LOCK_PERIODS + 1;
export const EVM_ESCROW_FULLY_FREE_SECONDS = EVM_ESCROW_CLIFF_SECONDS + DBC_LOCK_PERIODS * EVM_ESCROW_STEP_SECONDS;

/** E12: a quote coin may move to the native pool after 7 days in Pending. */
export const EVM_NATIVE_FALLBACK_DELAY_SECONDS = 7 * 24 * 60 * 60;

/** C5: creator 19.8% of the raise at graduation. */
export const EVM_GRADUATION_CREATOR_BPS = 1980;

/** The creator lock sentence shown before a creator buys (same as DBC). */
export const EVM_CREATOR_BUY_LOCK_COPY = DBC_CREATOR_LOCK_COPY;

/** The launch fee note on the create page (same sentence as the DBC create page). */
export const LAUNCH_FEE_NOTE =
  "The fee starts at 50% and falls to 2% within 60 seconds, so bots that buy at launch pay for it. Your own first buy does not.";

export function isEvmGen6Pair(factoryGeneration, campaignGeneration) {
  return (
    Number(factoryGeneration) === EVM_GEN6_FACTORY_GENERATION &&
    Number(campaignGeneration) === EVM_GEN5_CAMPAIGN_GENERATION
  );
}

// ---------------------------------------------------------------- fee choice (C6)

/** CreatorRewardsVaultV2.Choice: Unset 0, Keep 1, Holders 2, Split 3, Buyback 4. */
export const EVM_FEE_CHOICE_CODES = Object.freeze({ keep: 1, holders: 2, split: 3, buyback: 4 });
const CODE_TO_CHOICE = Object.freeze({ 1: "keep", 2: "holders", 3: "split", 4: "buyback" });

export const FEE_CHOICE_LABEL = Object.freeze({
  keep: "Keep it",
  holders: "Give it to holders",
  split: "Split",
  buyback: "Buyback and burn",
});

/** The create-request pair (feeChoice, feeCreatorPct) the factory validates in `_validateFeeChoice`. */
export function encodeEvmFeeChoice(choice, creatorSharePct) {
  const key = String(choice || "").trim().toLowerCase();
  const code = EVM_FEE_CHOICE_CODES[key];
  if (!code) throw new Error("Creator fee choice must be keep, holders, split or buyback.");
  if (key !== "split") return { feeChoice: code, feeCreatorPct: 0 };
  const pct = Math.trunc(Number(creatorSharePct));
  if (!Number.isFinite(pct) || pct < 1 || pct > 99) {
    throw new Error("Split needs your share as a whole percent from 1 to 99.");
  }
  return { feeChoice: code, feeCreatorPct: pct };
}

export function decodeEvmFeeChoice(code, pct) {
  const choice = CODE_TO_CHOICE[Number(code)] || null;
  return { choice, creatorSharePct: choice === "split" ? Number(pct) : null };
}

/**
 * One plain line about where the creator fees go. Same words as the DBC coin page
 * (api/lib/dbc/dbcFeeChoice.mjs); keep has no public line there, here the creator
 * panel needs one, so it says it plainly.
 */
export function evmFeeChoiceLine(choice, creatorSharePct) {
  const key = String(choice || "").toLowerCase();
  if (key === "split") {
    const pct = Math.trunc(Number(creatorSharePct)) || 0;
    return `Split: ${pct}% to the creator, ${100 - pct}% to holders`;
  }
  if (key === "holders") return "Holders: creator fees go to holders each week";
  if (key === "buyback") return "Buyback: creator fees buy the coin back and burn it";
  if (key === "keep") return "Keep: creator fees go to the creator";
  return null;
}

// ---------------------------------------------------------------- curve and first buy (C3)

function big(value) {
  if (typeof value === "bigint") return value;
  if (value == null || value === "") return 0n;
  return BigInt(String(value));
}

/** LaunchCampaign._area: floor(x*b/1e18) + floor(k*x^2 / (2*1e36)). */
export function curveArea(x, basePrice, priceSlope) {
  const n = big(x);
  return (n * big(basePrice)) / WAD + (big(priceSlope) * n * n) / (2n * WAD * WAD);
}

/** The campaign's figures at create, from factory.config() (LaunchCampaign._initialize). */
export function campaignFromFactoryConfig(config) {
  const totalSupply = big(config.totalSupply);
  const curveBps = big(config.curveBps);
  return {
    totalSupply,
    curveSupply: (totalSupply * curveBps) / MAX_BPS,
    basePrice: big(config.basePrice),
    priceSlope: big(config.priceSlope),
  };
}

/** LaunchCampaign.quoteCreatorFirstBuy at sold = 0: cost + flat protocol fee. */
export function quoteFirstBuy({ tokens, basePrice, priceSlope, protocolFeeBps }) {
  const t = big(tokens);
  const costNoFee = curveArea(t, basePrice, priceSlope);
  const fee = (costNoFee * big(protocolFeeBps)) / MAX_BPS;
  return { tokens: t, costNoFee, fee, total: costNoFee + fee };
}

/**
 * The first-buy limits for a coin that does not exist yet: 10% of supply, the curve,
 * and a cost before fee of at most 50% of the native graduation target.
 */
export function firstBuyLimits({ totalSupply, curveSupply, basePrice, priceSlope, protocolFeeBps, nativeTargetWei }) {
  const supplyCap = (big(totalSupply) * EVM_FIRST_BUY_MAX_SUPPLY_BPS) / MAX_BPS;
  let hi = supplyCap < big(curveSupply) ? supplyCap : big(curveSupply);
  const target = big(nativeTargetWei);
  const withinTarget = (t) => curveArea(t, basePrice, priceSlope) * MAX_BPS <= target * EVM_FIRST_BUY_MAX_TARGET_BPS;
  let limitedBy = "supply";
  if (target > 0n && !withinTarget(hi)) {
    limitedBy = "target";
    let lo = 0n;
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      if (withinTarget(mid)) lo = mid;
      else hi = mid - 1n;
    }
  }
  const maxQuote = quoteFirstBuy({ tokens: hi, basePrice, priceSlope, protocolFeeBps });
  return { maxTokens: hi, maxTotalWei: maxQuote.total, supplyCapTokens: supplyCap, limitedBy };
}

/** The most tokens a native budget buys at the flat fee (mirror of quoteBuyExactBnb at sold = 0). */
export function firstBuyTokensForBudget({ budgetWei, basePrice, priceSlope, protocolFeeBps, maxTokens }) {
  const budget = big(budgetWei);
  if (budget <= 0n) return 0n;
  let lo = 0n;
  let hi = big(maxTokens);
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (quoteFirstBuy({ tokens: mid, basePrice, priceSlope, protocolFeeBps }).total <= budget) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/**
 * Everything the create page shows and sends for a first buy of `budgetWei` native.
 * `exceedsCap` means the budget is above the cap; the plan then buys the cap.
 */
export function planFirstBuy({ budgetWei, config, protocolFeeBps, nativeTargetWei }) {
  const c = campaignFromFactoryConfig(config);
  const limits = firstBuyLimits({ ...c, protocolFeeBps, nativeTargetWei });
  const budget = big(budgetWei);
  if (budget <= 0n) {
    return { ...limits, tokens: 0n, costNoFee: 0n, fee: 0n, total: 0n, supplyBps: 0, exceedsCap: false };
  }
  const tokens = firstBuyTokensForBudget({ budgetWei: budget, ...c, protocolFeeBps, maxTokens: limits.maxTokens });
  const quote = quoteFirstBuy({ tokens, ...c, protocolFeeBps });
  const supplyBps = c.totalSupply > 0n ? Number((tokens * MAX_BPS) / c.totalSupply) : 0;
  return { ...limits, ...quote, supplyBps, exceedsCap: budget > limits.maxTotalWei };
}

/**
 * The four create-request fields a generation-6 factory signs and checks.
 * `firstBuyMaxCost` is the exact cost: the curve at sold = 0 is fixed by the factory
 * config, and the factory refunds anything sent above the cost.
 */
export function gen6CreateFields({ choice, creatorSharePct, firstBuy }) {
  const { feeChoice, feeCreatorPct } = encodeEvmFeeChoice(choice, creatorSharePct);
  const tokens = firstBuy ? big(firstBuy.tokens) : 0n;
  const total = tokens > 0n ? big(firstBuy.total) : 0n;
  return {
    firstBuyTokens: tokens,
    firstBuyMaxCost: total,
    feeChoice,
    feeCreatorPct,
    value: total,
  };
}

// ---------------------------------------------------------------- anti-sniper fee (C2)

/** LaunchCampaign.currentTradeFeeBps, exact integer arithmetic. */
export function evmTradeFeeBps({ launchAt, nowUnix, baseFeeBps = 200 }) {
  const base = Number(baseFeeBps);
  const end = Number(launchAt) + EVM_ANTI_SNIPER_WINDOW_SECONDS;
  const now = Number(nowUnix);
  if (now >= end) return base;
  let left = end - now;
  if (left > EVM_ANTI_SNIPER_WINDOW_SECONDS) left = EVM_ANTI_SNIPER_WINDOW_SECONDS;
  return base + Math.floor(((EVM_ANTI_SNIPER_START_BPS - base) * left) / EVM_ANTI_SNIPER_WINDOW_SECONDS);
}

/** "Launch fee: X% now, 2% from HH:MM:SS.": the DBC line, with trading start = launchAt. */
export function evmAntiSniperLine({ launchAt, nowUnix, timeZone } = {}) {
  return antiSniperFeeLine({ activationUnix: Number(launchAt || 0), nowUnix, timeZone });
}

// ---------------------------------------------------------------- creator escrow (C4)

/**
 * Reference model of LaunchCampaign.creatorEscrowVested for a list of creator buys
 * ({ at: unix seconds, amount }): each buy releases a fifth at +30 d, +37 d, … +58 d.
 */
export function escrowVested(buys, t) {
  const now = Number(t);
  let sum = 0n;
  for (let k = 0; k < EVM_ESCROW_STEPS; k += 1) {
    const offset = EVM_ESCROW_CLIFF_SECONDS + k * EVM_ESCROW_STEP_SECONDS;
    let cum = 0n;
    for (const buy of buys || []) if (Number(buy.at) <= now - offset) cum += big(buy.amount);
    sum += cum;
  }
  return sum / BigInt(EVM_ESCROW_STEPS);
}

/** The next release time after `nowUnix` for known buys, or 0 when everything is released. */
export function nextEscrowRelease(buys, nowUnix) {
  const now = Number(nowUnix);
  let next = 0;
  for (const buy of buys || []) {
    for (let k = 0; k < EVM_ESCROW_STEPS; k += 1) {
      const at = Number(buy.at) + EVM_ESCROW_CLIFF_SECONDS + k * EVM_ESCROW_STEP_SECONDS;
      if (at > now && (next === 0 || at < next)) next = at;
    }
  }
  return next;
}

/**
 * The smallest time t in (lo, hi] for which the monotone async `predicate(t)` is true,
 * or 0 when it is false at hi. `fanout` probes run in parallel per round, so a
 * 58-day range at one-second precision takes about eight rounds.
 */
export async function findFirstTime(predicate, lo, hi, { fanout = 8 } = {}) {
  let low = Math.floor(Number(lo));
  let high = Math.floor(Number(hi));
  if (!(high > low)) return 0;
  if (!(await predicate(high))) return 0;
  while (high - low > 1) {
    const span = high - low;
    const points = [];
    for (let i = 1; i < fanout; i += 1) {
      const p = low + Math.floor((span * i) / fanout);
      if (p > low && p < high && !points.includes(p)) points.push(p);
    }
    if (!points.length) break;
    const results = await Promise.all(points.map((p) => predicate(p)));
    let newLow = low;
    let newHigh = high;
    for (let i = 0; i < points.length; i += 1) {
      if (results[i]) {
        newHigh = points[i];
        break;
      }
      newLow = points[i];
    }
    low = newLow;
    high = newHigh;
  }
  return high;
}

/**
 * The first time in (lo, hi] at which an increasing step function changes, found with
 * `probe(t)` (for example creatorEscrowVested(t) on the campaign). 0 when it does not
 * change in the range.
 */
export async function findNextStepTime(probe, lo, hi, options) {
  const base = big(await probe(Math.floor(Number(lo))));
  return findFirstTime(async (t) => big(await probe(t)) > base, lo, hi, options);
}

/** The escrow summary the creator panel and the coin badge show. */
export function escrowSummary({ total, claimed, vestedNow }) {
  const t = big(total);
  const c = big(claimed);
  const v = big(vestedNow);
  const held = t > c ? t - c : 0n;
  const locked = t > v ? t - v : 0n;
  const claimable = v > c ? v - c : 0n;
  return { held, locked, claimable };
}

/**
 * The coin badge (DBC D12 wording): what the creator holds, including escrow, and how
 * much of it is still locked.
 */
export function evmCreatorBadge({ walletBalance, escrowHeld, locked, totalSupply, fullyFreeUnix, nowUnix }) {
  return creatorLockBadge({
    creatorHeldRaw: big(walletBalance) + big(escrowHeld),
    lockedRaw: big(locked),
    supplyRaw: big(totalSupply),
    fullyFreeUnix,
    nowUnix,
  });
}

// ---------------------------------------------------------------- graduation (C5, E12)

/**
 * The graduation state line for a coin page.
 * phase: "trading" | "pending" | "graduated".
 */
export function evmGraduationStatus({
  launched,
  graduationPending,
  pendingSince,
  quoteToken,
  nativeFallback,
  quoteSymbol,
  nativeSymbol = "native",
  nowUnix,
}) {
  const now = Number(nowUnix ?? Math.floor(Date.now() / 1000));
  if (launched) {
    return { phase: "graduated", line: "Graduated: trading has moved to the locked DEX pool.", fallbackDue: false, fallbackAt: 0 };
  }
  if (!graduationPending) return { phase: "trading", line: null, fallbackDue: false, fallbackAt: 0 };
  const isQuoteCoin = Boolean(quoteToken) && !/^0x0{40}$/i.test(String(quoteToken));
  const since = Number(pendingSince || 0);
  const fallbackAt = isQuoteCoin && !nativeFallback && since > 0 ? since + EVM_NATIVE_FALLBACK_DELAY_SECONDS : 0;
  const fallbackDue = fallbackAt > 0 && now >= fallbackAt;
  let note = null;
  if (isQuoteCoin && nativeFallback) {
    note = `This coin now graduates into a ${nativeSymbol} pool because the ${quoteSymbol || "quote"} route did not open within 7 days.`;
  } else if (fallbackDue) {
    note = `The ${quoteSymbol || "quote"} route has not opened for 7 days. Anyone can now switch this coin to a ${nativeSymbol} pool, with the same split.`;
  } else if (fallbackAt > 0) {
    const when = new Date(fallbackAt * 1000).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    note = `If the ${quoteSymbol || "quote"} route is still closed on ${when}, the coin can graduate into a ${nativeSymbol} pool instead.`;
  }
  return {
    phase: "pending",
    line: "Graduating: the pool is being created.",
    note,
    fallbackDue,
    fallbackAt,
  };
}

// ---------------------------------------------------------------- API campaign-state

/**
 * Maps GET /api/evm/campaign-state (supported: true) onto the creator view the coin page
 * shows; the token balances come from the caller. Null for an older campaign.
 */
export function creatorStateFromApi(payload, token) {
  if (!payload || payload.supported !== true) return null;
  const escrow = payload.creatorEscrow || {};
  const claims = payload.creatorClaims || {};
  const vault = claims.vault && !claims.vault.error ? claims.vault : null;
  const num = (v) => {
    try {
      return BigInt(String(v ?? "0"));
    } catch {
      return 0n;
    }
  };
  const total = num(escrow.totalTokens);
  const claimed = num(escrow.claimedTokens);
  return {
    walletBalance: big(token?.walletBalance),
    totalSupply: big(token?.totalSupply),
    escrowTotal: total,
    escrowClaimed: claimed,
    escrowHeld: total > claimed ? total - claimed : 0n,
    escrowLocked: num(escrow.lockedTokens),
    escrowClaimable: num(escrow.claimableTokens),
    nextReleaseAt: Number(escrow.nextRelease?.at || 0),
    fullyFreeAt: Number(escrow.fullyReleasedAt || 0),
    graduationBeneficiary: String(claims.graduationBeneficiary || "0x0000000000000000000000000000000000000000"),
    pendingGraduation: num(claims.graduationNativeWei),
    pendingGraduationQuote: num(claims.graduationQuote),
    vaultCreatorBalance: num(vault?.creatorClaimableWei),
    vaultCreatorQuoteBalance: num(vault?.creatorClaimableQuote),
  };
}
