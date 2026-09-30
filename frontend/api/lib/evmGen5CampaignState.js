import { ethers } from "ethers";

/**
 * Chain reads for a generation 5 LaunchCampaign (factory generation 6), for the coin page:
 * anti-sniper trade fee (C2), creator buy escrow (C4), graduation state (C5, E12) and the creator's
 * pull balances (C5 claimCreatorGraduation, C6 CreatorRewardsVaultV2). Everything comes from the
 * contracts' own views, so a fee or price shown here is the one the next trade pays in this block.
 *
 * Older campaigns are recognised through their factory's FACTORY_GENERATION and answered with
 * `supported: false`; the site keeps using its existing paths for them (E14).
 */

export const GEN5_MIN_FACTORY_GENERATION = 6;
export const ANTI_SNIPER_START_BPS = 5000;
export const ANTI_SNIPER_WINDOW_SECONDS = 60;
export const ESCROW_CLIFF_SECONDS = 30 * 86_400;
export const ESCROW_STEP_SECONDS = 7 * 86_400;
export const ESCROW_TRANCHES = 5;
export const ESCROW_FULL_SECONDS = ESCROW_CLIFF_SECONDS + (ESCROW_TRANCHES - 1) * ESCROW_STEP_SECONDS; // 58 days
export const NATIVE_FALLBACK_DELAY_SECONDS = 7 * 86_400;
export const PAUSE_HONOUR_WINDOW_SECONDS = 72 * 3600;
export const FEE_CHOICE_NAMES = Object.freeze({ 0: "unset", 1: "keep", 2: "holders", 3: "split", 4: "buyback" });

const ERRORS = [
  "AdapterResultInvalid()", "AlreadyInitialized()", "AuthorizedTradingRequired()", "BadRouteAuth()", "BuysPaused()",
  "CampaignPaused()", "CreatorBuyCapExceeded()", "ExceedsSold()", "Finalized()", "FirstBuyClosed()",
  "FirstBuyTooExpensive()", "FirstBuyTooLarge()", "GraduationIsPending()", "GraduationNotDue()", "GraduationPaused()",
  "Insolvent()", "InsufficientValue()", "NativeFallbackNotDue()", "NativeFallbackUnavailable()", "NativeTransferFailed()",
  "NotBeneficiary()", "NotCreator()", "NotFinalized()", "NothingToClaim()", "QuoteMismatch()",
  "ReentrancyGuardReentrantCall()", "SafeERC20FailedOperation(address)", "SellsPaused()", "Slippage()", "SoldOut()",
  "StartPriceOutOfBand()", "SupplyBound()", "TradingNotOpen()", "ZeroAmount()",
].map((sig) => `error ${sig}`);

export const GEN5_CAMPAIGN_ABI = [
  "function factory() view returns (address)",
  "function creator() view returns (address)",
  "function token() view returns (address)",
  "function launchAt() view returns (uint64)",
  "function protocolFeeBps() view returns (uint256)",
  "function currentTradeFeeBps() view returns (uint256)",
  "function quoteBuyExactTokens(uint256 amountOut) view returns (uint256)",
  "function quoteBuyExactBnb(uint256 totalInWei) view returns (uint256 tokensOut, uint256 totalCostWei, uint256 feeWei)",
  "function quoteSellExactTokens(uint256 amountIn) view returns (uint256)",
  "function creatorEscrowTotal() view returns (uint256)",
  "function creatorEscrowVested(uint256 t) view returns (uint256 vested)",
  "function creatorEscrowClaimed() view returns (uint256)",
  "function launched() view returns (bool)",
  "function graduationPending() view returns (bool)",
  "function pendingSince() view returns (uint64)",
  "function pendingTrigger() view returns (uint8)",
  "function graduationQuoteToken() view returns (address)",
  "function nativeFallback() view returns (bool)",
  "function paused() view returns (bool)",
  "function graduationPaused() view returns (bool)",
  "function pendingCreatorGraduation() view returns (uint256)",
  "function pendingCreatorQuote() view returns (uint256)",
  "function pendingProtocolGraduationFee() view returns (uint256)",
  "function creatorGraduationBeneficiary() view returns (address)",
  "function repairMemeSold() view returns (uint256)",
  "function sold() view returns (uint256)",
  "function curveSupply() view returns (uint256)",
  "function netRaisedWei() view returns (uint256)",
  "function graduationTarget() view returns (uint256)",
  "function graduationNativeTarget() view returns (uint256)",
  "function finalizedAt() view returns (uint256)",
  "function graduate() returns (address pool)",
  ...ERRORS,
];

const FACTORY_ABI = [
  "function FACTORY_GENERATION() view returns (uint32)",
  "function CAMPAIGN_GENERATION() view returns (uint32)",
  "function campaignFeeChoice(address) view returns (address vault, uint8 choice, uint8 creatorPct)",
  "function nativeGraduationAdapter() view returns (address)",
];

const VAULT_ABI = [
  "function cfg(address) view returns (address creator, uint8 choice, uint8 creatorPct, address pool, address quote)",
  "function creatorBalance(address) view returns (uint256)",
  "function creatorQuoteBalance(address) view returns (uint256)",
  "function holderBalance(address) view returns (uint256)",
  "function holderQuoteBalance(address) view returns (uint256)",
  "function buybackBalance(address) view returns (uint256)",
  "function buybackQuoteBalance(address) view returns (uint256)",
  "function heldBuybackTokens(address) view returns (uint256)",
];

const campaignInterface = new ethers.Interface(GEN5_CAMPAIGN_ABI);
const ZERO = ethers.ZeroAddress;

/** C2, exactly as LaunchCampaign.currentTradeFeeBps, for a client that ticks the fee locally per second. */
export function antiSniperFeeBpsAt({ launchAt, protocolFeeBps, now }) {
  const base = Number(protocolFeeBps);
  const end = Number(launchAt) + ANTI_SNIPER_WINDOW_SECONDS;
  if (Number(now) >= end) return base;
  const left = Math.min(end - Number(now), ANTI_SNIPER_WINDOW_SECONDS);
  return base + Math.floor(((ANTI_SNIPER_START_BPS - base) * left) / ANTI_SNIPER_WINDOW_SECONDS);
}

/** Decode a revert from a campaign call into its error name (null when it is not one of ours). */
export function decodeCampaignRevert(error) {
  const candidates = [error?.data, error?.info?.error?.data, error?.error?.data, error?.revert?.data];
  for (const data of candidates) {
    if (typeof data !== "string" || data.length < 10) continue;
    try {
      const parsed = campaignInterface.parseError(data);
      if (parsed?.name === "Error") return String(parsed.args[0]); // require(..., "reason") in an adapter
      if (parsed) return parsed.name;
    } catch {}
    return `unknown:${data.slice(0, 10)}`;
  }
  if (error?.revert?.name) return error.revert.name;
  return null;
}

/**
 * Smallest t in (now, hi] where predicate(t) holds, for a predicate monotone in t (false at now).
 * `vestedAt` is an eth_call per probe; the window is at most 58 days, so ~23 probes.
 */
async function firstTimeWhere(now, hi, predicate) {
  let lo = now;
  let high = hi;
  if (!(await predicate(high))) return null;
  while (high - lo > 1) {
    const mid = lo + Math.floor((high - lo) / 2);
    if (await predicate(mid)) high = mid;
    else lo = mid;
  }
  return high;
}

/**
 * C4 escrow as the site shows it. vested(t) is a step function that reaches the total 58 days after the
 * creator's last escrowed buy (all buys are <= now), so both searches are bounded by now + 58 days.
 */
export async function readCreatorEscrow({ vestedAt, total, claimed, now }) {
  const totalBig = BigInt(total);
  const claimedBig = BigInt(claimed);
  const vestedNow = totalBig === 0n ? 0n : BigInt(await vestedAt(now));
  const out = {
    totalTokens: totalBig.toString(),
    vestedTokens: vestedNow.toString(),
    claimedTokens: claimedBig.toString(),
    claimableTokens: (vestedNow - claimedBig).toString(),
    lockedTokens: (totalBig - vestedNow).toString(),
    nextRelease: null,
    fullyReleasedAt: null,
    schedule: "Each creator buy releases 20% at 30 days, then 20% every 7 days; fully free after 58 days.",
  };
  if (vestedNow >= totalBig) return out;
  const hi = now + ESCROW_FULL_SECONDS;
  const cache = new Map();
  const at = async (t) => {
    if (!cache.has(t)) cache.set(t, BigInt(await vestedAt(t)));
    return cache.get(t);
  };
  const nextAt = await firstTimeWhere(now, hi, async (t) => (await at(t)) > vestedNow);
  if (nextAt !== null) {
    out.nextRelease = { at: nextAt, tokens: ((await at(nextAt)) - vestedNow).toString() };
  }
  const fullAt = await firstTimeWhere(now, hi, async (t) => (await at(t)) >= totalBig);
  out.fullyReleasedAt = fullAt;
  return out;
}

function classifyGraduate(errorName) {
  if (!errorName) return { callable: false, repairNeeded: false, reason: "reverted" };
  if (errorName === "StartPriceOutOfBand") return { callable: false, repairNeeded: true, reason: errorName };
  return { callable: false, repairNeeded: false, reason: errorName };
}

async function settle(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

/** FACTORY_GENERATION / CAMPAIGN_GENERATION of the campaign's factory, or nulls for pre-constant factories. */
export async function readCampaignGeneration(provider, campaignAddress) {
  const campaign = new ethers.Contract(campaignAddress, GEN5_CAMPAIGN_ABI, provider);
  const factoryRead = await settle(campaign.factory());
  if (!factoryRead.ok) return { factoryAddress: null, factoryGeneration: null, campaignGeneration: null };
  const factoryAddress = ethers.getAddress(factoryRead.value);
  const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);
  const [f, c] = await Promise.all([settle(factory.FACTORY_GENERATION()), settle(factory.CAMPAIGN_GENERATION())]);
  return {
    factoryAddress,
    factoryGeneration: f.ok ? Number(f.value) : null,
    campaignGeneration: c.ok ? Number(c.value) : null,
  };
}

function parseQuoteAmount(value) {
  if (value === undefined || value === null || value === "") return null;
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw) || BigInt(raw) === 0n) throw Object.assign(new Error("Quote amounts must be positive whole numbers of wei or token units."), { httpStatus: 400 });
  return BigInt(raw);
}

/** Fee previews from the campaign's own quote functions (C2 fee included), in the current block. */
export async function readGen5Quotes(campaign, { buyNativeWei, buyTokens, sellTokens } = {}) {
  const quotes = {};
  if (buyNativeWei) {
    const r = await settle(campaign.quoteBuyExactBnb(buyNativeWei));
    quotes.buyExactNative = r.ok
      ? { inWei: buyNativeWei.toString(), tokensOut: r.value[0].toString(), totalCostWei: r.value[1].toString(), feeWei: r.value[2].toString() }
      : { inWei: buyNativeWei.toString(), error: decodeCampaignRevert(r.error) || "reverted" };
  }
  if (buyTokens) {
    const r = await settle(campaign.quoteBuyExactTokens(buyTokens));
    quotes.buyExactTokens = r.ok
      ? { tokens: buyTokens.toString(), totalCostWei: r.value.toString() }
      : { tokens: buyTokens.toString(), error: decodeCampaignRevert(r.error) || "reverted" };
  }
  if (sellTokens) {
    const r = await settle(campaign.quoteSellExactTokens(sellTokens));
    quotes.sellExactTokens = r.ok
      ? { tokens: sellTokens.toString(), payoutWei: r.value.toString() }
      : { tokens: sellTokens.toString(), error: decodeCampaignRevert(r.error) || "reverted" };
  }
  return quotes;
}

export function parseGen5QuoteParams(q = {}) {
  return {
    buyNativeWei: parseQuoteAmount(q.buyNativeWei ?? q.buyWei),
    buyTokens: parseQuoteAmount(q.buyTokens),
    sellTokens: parseQuoteAmount(q.sellTokens),
  };
}

/**
 * The whole coin-page state for one generation 5 campaign. `provider` is any ethers provider;
 * `quoteParams` from parseGen5QuoteParams.
 */
export async function readGen5CampaignState({ provider, campaignAddress, wallet = null, quoteParams = {} }) {
  const address = ethers.getAddress(campaignAddress);
  const generation = await readCampaignGeneration(provider, address);
  if (!generation.factoryGeneration || generation.factoryGeneration < GEN5_MIN_FACTORY_GENERATION) {
    return { campaignAddress: address, supported: false, generation };
  }

  const campaign = new ethers.Contract(address, GEN5_CAMPAIGN_ABI, provider);
  const block = await provider.getBlock("latest");
  const now = Number(block.timestamp);

  const [
    creator, token, launchAt, protocolFeeBps, currentTradeFeeBps, escrowTotal, escrowClaimed,
    launched, graduationPending, pendingSince, pendingTrigger, quoteToken, nativeFallback, paused, graduationPaused,
    pendingCreatorGraduation, pendingCreatorQuote, pendingProtocolGraduationFee, beneficiary, repairMemeSold,
    sold, curveSupply, netRaisedWei, graduationTarget, finalizedAt,
  ] = await Promise.all([
    campaign.creator(), campaign.token(), campaign.launchAt(), campaign.protocolFeeBps(), campaign.currentTradeFeeBps(),
    campaign.creatorEscrowTotal(), campaign.creatorEscrowClaimed(),
    campaign.launched(), campaign.graduationPending(), campaign.pendingSince(), campaign.pendingTrigger(),
    campaign.graduationQuoteToken(), campaign.nativeFallback(), campaign.paused(), campaign.graduationPaused(),
    campaign.pendingCreatorGraduation(), campaign.pendingCreatorQuote(), campaign.pendingProtocolGraduationFee(),
    campaign.creatorGraduationBeneficiary(), campaign.repairMemeSold(),
    campaign.sold(), campaign.curveSupply(), campaign.netRaisedWei(), campaign.graduationTarget(), campaign.finalizedAt(),
  ]);

  const launchAtN = Number(launchAt);
  const antiSniperEndsAt = launchAtN + ANTI_SNIPER_WINDOW_SECONDS;
  const nativeTargetRead = launched ? null : await settle(campaign.graduationNativeTarget());

  const escrow = await readCreatorEscrow({
    vestedAt: (t) => campaign.creatorEscrowVested(t),
    total: escrowTotal,
    claimed: escrowClaimed,
    now,
  });

  // Graduation. graduate() is permissionless; a static call in this block tells whether it would
  // succeed now and, if not, why. StartPriceOutOfBand means a pre-made pool needs repairPool() first.
  const isQuoteCoin = quoteToken !== ZERO;
  const pendingSinceN = Number(pendingSince);
  let graduate = { callable: false, repairNeeded: false, reason: launched ? "graduated" : "not_due" };
  if (!launched && now >= launchAtN) {
    const sim = await settle(campaign.graduate.staticCall());
    graduate = sim.ok
      ? { callable: true, repairNeeded: false, reason: null, pool: ethers.getAddress(sim.value) }
      : classifyGraduate(decodeCampaignRevert(sim.error));
  }
  const fallbackAt = graduationPending && isQuoteCoin ? pendingSinceN + NATIVE_FALLBACK_DELAY_SECONDS : null;
  const pauseHonouredUntil = graduationPending && (paused || graduationPaused) ? pendingSinceN + PAUSE_HONOUR_WINDOW_SECONDS : null;

  // C6 fee choice and the creator's vault balances.
  const factory = new ethers.Contract(generation.factoryAddress, FACTORY_ABI, provider);
  const choiceRead = await settle(factory.campaignFeeChoice(address));
  let feeChoice = null;
  let creatorVault = null;
  if (choiceRead.ok && choiceRead.value[0] !== ZERO) {
    const vaultAddress = ethers.getAddress(choiceRead.value[0]);
    const choice = Number(choiceRead.value[1]);
    feeChoice = { id: choice, name: FEE_CHOICE_NAMES[choice] || "unknown", creatorPct: Number(choiceRead.value[2]), vault: vaultAddress };
    const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);
    // cfg, creatorBalance and creatorQuoteBalance are the vault's stable public surface; the holder and
    // buyback getters are informational and read tolerantly (the vault is being trimmed for size).
    const required = await settle(Promise.all([vault.cfg(address), vault.creatorBalance(address), vault.creatorQuoteBalance(address)]));
    if (!required.ok) {
      // A vault without this surface (not a CreatorRewardsVaultV2) must not hide the rest of the page.
      creatorVault = { address: vaultAddress, error: "The creator vault could not be read." };
    } else {
      const [cfg, creatorBal, creatorQuoteBal] = required.value;
      const optional = await Promise.all([
        settle(vault.holderBalance(address)), settle(vault.holderQuoteBalance(address)),
        settle(vault.buybackBalance(address)), settle(vault.buybackQuoteBalance(address)),
        settle(vault.heldBuybackTokens(address)),
      ]);
      const opt = (i) => (optional[i].ok ? optional[i].value.toString() : null);
      const cfgPool = cfg.pool ?? cfg[3];
      const cfgQuote = cfg.quote ?? cfg[4];
      creatorVault = {
        address: vaultAddress,
        creator: ethers.getAddress(cfg.creator ?? cfg[0]),
        pool: cfgPool === ZERO ? null : ethers.getAddress(cfgPool),
        quoteToken: cfgQuote === ZERO ? null : ethers.getAddress(cfgQuote),
        // claimCreatorFees(campaign): keep, and the creator part of split
        creatorClaimableWei: creatorBal.toString(),
        // claimCreatorQuote(campaign): the creator part of LP fees on a quote-bound split coin
        creatorClaimableQuote: creatorQuoteBal.toString(),
        holderPendingWei: opt(0),
        holderPendingQuote: opt(1),
        buybackPendingWei: opt(2),
        buybackPendingQuote: opt(3),
        heldBuybackTokens: opt(4),
      };
    }
  }

  const beneficiaryAddress = beneficiary === ZERO ? null : ethers.getAddress(beneficiary);
  const creatorAddress = ethers.getAddress(creator);
  const viewer = wallet && ethers.isAddress(wallet) ? ethers.getAddress(wallet) : null;
  const quotes = await readGen5Quotes(campaign, quoteParams);

  return {
    campaignAddress: address,
    supported: true,
    generation,
    blockNumber: Number(block.number),
    blockTimestamp: now,
    creator: creatorAddress,
    token: ethers.getAddress(token),
    tradeFee: {
      currentBps: Number(currentTradeFeeBps),
      baseBps: Number(protocolFeeBps),
      antiSniperStartBps: ANTI_SNIPER_START_BPS,
      antiSniperWindowSeconds: ANTI_SNIPER_WINDOW_SECONDS,
      launchAt: launchAtN,
      antiSniperEndsAt,
      antiSniperActive: now < antiSniperEndsAt,
      appliesTo: "buys and sells; the creator's first buy at create pays the base fee",
    },
    quotes,
    creatorEscrow: escrow,
    graduation: {
      state: launched ? "graduated" : graduationPending ? "pending" : "trading",
      pendingSince: graduationPending ? pendingSinceN : null,
      pendingTrigger: graduationPending ? (Number(pendingTrigger) === 1 ? "sold_out" : "target") : null,
      finalizedAt: launched ? Number(finalizedAt) : null,
      sold: sold.toString(),
      curveSupply: curveSupply.toString(),
      netRaisedWei: netRaisedWei.toString(),
      targetUsdWad: graduationTarget.toString(),
      nativeTargetWei: nativeTargetRead?.ok ? nativeTargetRead.value.toString() : null,
      quoteToken: isQuoteCoin ? ethers.getAddress(quoteToken) : null,
      nativeFallback: Boolean(nativeFallback),
      nativeFallbackAvailableAt: fallbackAt,
      nativeFallbackAvailable: Boolean(fallbackAt !== null && !nativeFallback && !launched && now >= fallbackAt),
      pauseHonouredUntil,
      graduate,
      repairMemeSold: repairMemeSold.toString(),
      pendingProtocolGraduationFeeWei: pendingProtocolGraduationFee.toString(),
    },
    creatorClaims: {
      // claimCreatorGraduation(to, includeQuote): only the beneficiary (owner() at graduation)
      graduationBeneficiary: beneficiaryAddress,
      graduationNativeWei: pendingCreatorGraduation.toString(),
      graduationQuote: pendingCreatorQuote.toString(),
      graduationQuoteToken: isQuoteCoin ? ethers.getAddress(quoteToken) : null,
      // claimCreatorEscrow(): only the creator
      escrowClaimableTokens: escrow.claimableTokens,
      feeChoice,
      vault: creatorVault,
    },
    viewer: viewer
      ? {
          wallet: viewer,
          isCreator: viewer === creatorAddress,
          canClaimGraduation: Boolean(beneficiaryAddress && viewer === beneficiaryAddress && (pendingCreatorGraduation > 0n || pendingCreatorQuote > 0n)),
          canClaimEscrow: viewer === creatorAddress && BigInt(escrow.claimableTokens) > 0n,
          canClaimVaultFees: Boolean(creatorVault && !creatorVault.error && viewer === creatorVault.creator && (BigInt(creatorVault.creatorClaimableWei) > 0n || BigInt(creatorVault.creatorClaimableQuote) > 0n)),
        }
      : null,
  };
}
