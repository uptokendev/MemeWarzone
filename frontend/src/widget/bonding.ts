/**
 * Bonding coins in the swap widget: our own Solana launchpad and DBC coins while they are on their curve.
 * Quotes and transactions come from the app's own modules, unchanged and called in the same order as the
 * token page (TokenDetails.tsx), so the CREATE/BUY/SELL transaction shape cannot differ: the same
 * builders produce it. Only the four app-only helpers are swapped in the widget build (see shims/).
 */
import { applySlippageMinOut, quoteBuyExactSolIn, quoteSellExactTokensIn, requestSolanaTradeAuthorization, submitSolanaTradeV1 } from "@/lib/solanaTradeV1";
import { resolveSolanaCampaignCurve } from "@/lib/solanaCampaignRead";
import { submitDbcBondingTrade } from "@/lib/dbcTradeSubmit";
import { loadDbcPool, loadReferralTokenAccount, quoteDbcExactIn } from "@/lib/dbcTrade.mjs";
import { getSolanaReadConnection } from "@/lib/solanaReadConnection";

export type BondingKind = "launchpad" | "dbc";
export type BondingQuote = { amountOut: bigint; amountInUsed: bigint; feeBps: number | null; note: string | null };

/** Same slippage as the token page (TokenDetails SLIPPAGE_PCT). */
export const BONDING_SLIPPAGE_PCT = 5;

async function launchpadCurve(campaignAddress: string) {
  const curve = await resolveSolanaCampaignCurve(campaignAddress);
  if (!curve) throw new Error("Could not read this coin's curve.");
  if (curve.graduated || curve.curveClosed) throw new Error("This coin has left its curve. Trade it on MemeWarzone.");
  if (curve.paused) throw new Error("Trading on this coin is paused.");
  return curve;
}

function launchpadQuote(curve: Awaited<ReturnType<typeof launchpadCurve>>, side: "buy" | "sell", amountIn: bigint): BondingQuote {
  const common = { basePrice: curve.basePriceLamports, slope: curve.priceSlopeLamports, sold: curve.soldTokens, economicsVersion: curve.economicsVersion, tokenDecimals: curve.tokenDecimals };
  if (side === "buy") {
    const q = quoteBuyExactSolIn({ ...common, lamportsIn: amountIn, curveSupply: curve.curveTokenSupply, buyFeeBps: curve.buyFeeBps });
    return { amountOut: q.tokensOut, amountInUsed: amountIn, feeBps: curve.buyFeeBps, note: null };
  }
  const q = quoteSellExactTokensIn({ ...common, tokensIn: amountIn, sellFeeBps: curve.sellFeeBps });
  return { amountOut: q.lamportsOut, amountInUsed: amountIn, feeBps: curve.sellFeeBps, note: null };
}

async function dbcQuote(pool: string, side: "buy" | "sell", amountIn: bigint): Promise<BondingQuote> {
  const connection = getSolanaReadConnection();
  const loaded = await loadDbcPool(connection, pool);
  const referral = await loadReferralTokenAccount(connection, import.meta.env);
  const quoted = quoteDbcExactIn({
    client: loaded.client,
    pool: loaded.pool,
    config: loaded.config,
    side,
    amountIn,
    hasReferral: Boolean(referral),
    nowUnix: loaded.nowUnix,
    activationUnix: loaded.activationUnix,
  });
  return {
    amountOut: BigInt(quoted.amountOut),
    amountInUsed: quoted.partialFill ? BigInt(quoted.amountInUsed) : amountIn,
    feeBps: null,
    note: quoted.partialFill ? "This buy completes the curve: only the amount needed is used, the rest stays in the wallet." : null,
  };
}

export async function quoteBonding(input: { kind: BondingKind; campaignAddress: string; side: "buy" | "sell"; amountIn: bigint }): Promise<BondingQuote> {
  if (input.kind === "dbc") return dbcQuote(input.campaignAddress, input.side, input.amountIn);
  return launchpadQuote(await launchpadCurve(input.campaignAddress), input.side, input.amountIn);
}

/** Runs the trade exactly as the token page does; returns the confirmed signature. */
export async function tradeBonding(input: { kind: BondingKind; campaignAddress: string; creator: string | null; side: "buy" | "sell"; amountIn: bigint; trader: string }): Promise<string> {
  if (input.kind === "dbc") {
    // A creator's own buys are locked buys; those stay on MemeWarzone.
    if (input.side === "buy" && input.creator && input.trader === input.creator) throw new Error("Creator buys go through MemeWarzone (they are locked buys).");
    const result = await submitDbcBondingTrade({ pool: input.campaignAddress, trader: input.trader, side: input.side, amountIn: input.amountIn, lockedBuy: false, tokenAmountOut: 0n });
    return result.signature;
  }
  const curve = await launchpadCurve(input.campaignAddress);
  if (input.side === "buy" && curve.creator && input.trader === curve.creator && curve.creatorBuyLockUntil > Math.floor(Date.now() / 1000)) {
    throw new Error(`Creator buy lock active until ${new Date(curve.creatorBuyLockUntil * 1000).toLocaleString()}.`);
  }
  const quote = launchpadQuote(curve, input.side, input.amountIn);
  const minOut = applySlippageMinOut(quote.amountOut, BONDING_SLIPPAGE_PCT);
  const auth = await requestSolanaTradeAuthorization({
    side: input.side,
    campaignAddress: curve.campaignAddress,
    mintAddress: curve.mint,
    traderAddress: input.trader,
    amountIn: input.amountIn,
    minOut,
    tokenVault: curve.tokenVault || null,
    solVault: curve.solVault || null,
    campaignId: curve.campaignIdHex || null,
    chainId: 101,
  });
  const result = await submitSolanaTradeV1(auth, { traderAddress: input.trader });
  return result.signature;
}
