/**
 * Step 7b (D20-D23): a stock token (xStocks, Token-2022) as a DBC quote.
 *
 * Two reads, both fresh at the moment a launch is authorized:
 *  - the mint on chain: decimals, the ScaledUiAmount multiplier in force, pause state, transfer-hook
 *    program, transfer fee, and whether Meteora has badged the mint for DBC (only Meteora can);
 *  - the price: Jupiter's USD price is per displayed token (raw / 10^decimals x multiplier), checked
 *    2026-09-29: 1e8 raw NVDAx sold for 231.13 USDC with Jupiter at 230.79 and the multiplier 1.0017.
 * So the USD value of 10^decimals raw units = Jupiter price x multiplier.
 */
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getMint,
  getPausableConfig,
  getScaledUiAmountConfig,
  getTransferFeeConfig,
  getTransferHook,
} from "@solana/spl-token";
import { solPriceStep } from "./dbcPriceSteps.mjs";
import { effectiveMultiplier } from "../../../shared/dbcQuotes.mjs";

export { effectiveMultiplier };

export const DBC_PROGRAM_ID = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const JUPITER_PRICE_URL = "https://lite-api.jup.ag/price/v3";

export class DbcStockQuoteError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.httpStatus = 400;
  }
}

/** Token badge PDA: ["token_badge", mint] under the given program (DBC or DAMM v2). */
export function tokenBadgeAddress(mint, programId = DBC_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([Buffer.from("token_badge"), new PublicKey(mint).toBuffer()], programId)[0];
}

export function dbcTokenBadgeAddress(mint) {
  return tokenBadgeAddress(mint, DBC_PROGRAM_ID);
}

/** Read the mint and the badge; every field a launch decision needs. */
export async function readStockQuoteState(connection, mintAddress, { nowUnix = Math.floor(Date.now() / 1000) } = {}) {
  const mint = new PublicKey(mintAddress);
  const info = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const hook = getTransferHook(info);
  const pausable = getPausableConfig(info);
  const fee = getTransferFeeConfig(info);
  const badge = dbcTokenBadgeAddress(mint);
  const dammBadge = tokenBadgeAddress(mint, DAMM_V2_PROGRAM_ID);
  const [badgeInfo, dammBadgeInfo] = await connection.getMultipleAccountsInfo([badge, dammBadge], "confirmed");
  return {
    mint: mint.toBase58(),
    decimals: info.decimals,
    multiplier: effectiveMultiplier(getScaledUiAmountConfig(info), nowUnix),
    paused: Boolean(pausable?.paused),
    hookProgram: hook && !hook.programId.equals(PublicKey.default) ? hook.programId.toBase58() : null,
    transferFeeBps: fee
      ? Math.max(Number(fee.olderTransferFee.transferFeeBasisPoints), Number(fee.newerTransferFee.transferFeeBasisPoints))
      : 0,
    badge: badge.toBase58(),
    badgeExists: Boolean(badgeInfo && badgeInfo.owner.equals(DBC_PROGRAM_ID)),
    dammBadge: dammBadge.toBase58(),
    dammBadgeExists: Boolean(dammBadgeInfo && dammBadgeInfo.owner.equals(DAMM_V2_PROGRAM_ID)),
  };
}

/**
 * Refuse a stock quote that DBC or DAMM v2 cannot carry, with a reason a creator can read.
 * DBC and DAMM v2 never run a quote-side transfer hook, and refuse any transfer fee.
 */
export function assertStockQuoteUsable(state) {
  if (!state.badgeExists || !state.dammBadgeExists) {
    // DBC needs its badge to create the curve; DAMM v2 needs its own for the pool the coin graduates into.
    throw new DbcStockQuoteError("This stock token is not enabled on Meteora yet, so a coin cannot be paired with it.", "DBC_QUOTE_NO_BADGE");
  }
  if (state.paused) {
    throw new DbcStockQuoteError("The issuer has paused this stock token. Pick another pairing.", "DBC_QUOTE_PAUSED");
  }
  if (state.hookProgram) {
    throw new DbcStockQuoteError("The issuer switched on a transfer check for this stock token, so it cannot be traded on a curve.", "DBC_QUOTE_HOOK");
  }
  if (state.transferFeeBps > 0) {
    throw new DbcStockQuoteError("This stock token charges a transfer fee, which the curve cannot carry.", "DBC_QUOTE_TRANSFER_FEE");
  }
}

/**
 * Jupiter's current DEX price. `usdPrice` is per displayed token; `usdPricePrescaled` is per
 * 10^decimals raw and equals usdPrice x the multiplier in force (read 2026-09-29: 230.717 x 1.0017
 * = 231.109). Returns null when there is no price. No age check: the threshold only sizes the
 * graduation, stepped at 2%, the same tolerance a SOL launch has.
 */
export async function readJupiterStockPrice(mintAddress, { fetchImpl = fetch } = {}) {
  const url = `${JUPITER_PRICE_URL}?ids=${encodeURIComponent(String(mintAddress))}`;
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) return null;
  const body = await response.json();
  const row = body?.[String(mintAddress)];
  const usdPrice = Number(row?.usdPrice);
  if (!Number.isFinite(usdPrice) || usdPrice <= 0) return null;
  const prescaled = Number(row?.scaledUiConfig?.usdPricePrescaled);
  return { usdPrice, usdPricePrescaled: Number.isFinite(prescaled) && prescaled > 0 ? prescaled : null };
}

/**
 * USD (micros) of 10^decimals raw units: the displayed price x the multiplier read from the mint.
 * When Jupiter also reports its prescaled price, the two must agree within 1%, or its view of the
 * multiplier is not the chain's and the price is refused.
 */
export function stockUsdMicrosPerRawUnit(price, multiplier) {
  const perRaw = Number(price?.usdPrice) * Number(multiplier);
  if (!Number.isFinite(perRaw) || perRaw <= 0) {
    throw new DbcStockQuoteError("No price for this stock token right now. Try again in a minute.", "DBC_QUOTE_PRICE");
  }
  if (price.usdPricePrescaled != null && Math.abs(perRaw / price.usdPricePrescaled - 1) > 0.01) {
    throw new DbcStockQuoteError("The price for this stock token does not match its on-chain multiplier. Try again later.", "DBC_QUOTE_PRICE");
  }
  return BigInt(Math.round(perRaw * 1_000_000));
}

/**
 * The 2% price step for a stock quote, read fresh: the mint must still be usable (badges, not paused,
 * no hook, no transfer fee) and its decimals must match the registry. The step ladder is the SOL one
 * (1.02^index USD per 10^decimals raw), so configs are reused within a 2% band like SOL launches.
 */
export async function stockPriceStep(connection, quote, { fetchImpl = fetch, nowUnix } = {}) {
  const state = await readStockQuoteState(connection, quote.mint, nowUnix == null ? {} : { nowUnix });
  if (state.decimals !== Number(quote.decimals)) {
    throw new DbcStockQuoteError(`${quote.symbol} reports ${state.decimals} decimals on chain, not ${quote.decimals}.`, "DBC_QUOTE_DECIMALS");
  }
  assertStockQuoteUsable(state);
  const price = await readJupiterStockPrice(quote.mint, { fetchImpl });
  if (!price) throw new DbcStockQuoteError("No price for this stock token right now. Try again in a minute.", "DBC_QUOTE_PRICE");
  const usdMicrosPerRawUnit = stockUsdMicrosPerRawUnit(price, state.multiplier);
  return { ...solPriceStep(usdMicrosPerRawUnit), usdMicrosPerRawUnit, state };
}
