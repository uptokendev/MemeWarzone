import { ethers } from "ethers";
import type { CurveTradePoint } from "@/hooks/useCurveTrades";
import { isSolanaChainId } from "@/lib/chainConfig";
import type { MarketTrade } from "@/lib/marketContinuityApi";
import { isValidTradeTxHash, normalizeTradeTxHash } from "@/lib/tradeDedupe";
import { evmFeeFreeTradePrice } from "@/lib/chart/evmFeeFreePrice";

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS_RE = /^0x[a-f0-9]{40}$/;
const EVM_TX_RE = /^0x[a-f0-9]{64}$/;
const SOLANA_TX_RE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;

/** Campaign / token / wallet key: lowercase EVM, preserve Solana base58. */
export function campaignKey(chainId: number, address: unknown): string {
  const raw = String(address || "").trim();
  return isSolanaChainId(chainId) ? raw : raw.toLowerCase();
}

export function isCampaignAddress(chainId: number, address?: string | null): boolean {
  const raw = campaignKey(chainId, address || "");
  if (!raw) return false;
  return isSolanaChainId(chainId) ? SOLANA_ADDRESS_RE.test(raw) : EVM_ADDRESS_RE.test(raw);
}

export function isTradeTxId(chainId: number, tx: unknown): boolean {
  const raw = String(tx || "").trim();
  if (isSolanaChainId(chainId)) return SOLANA_TX_RE.test(raw);
  return EVM_TX_RE.test(raw.toLowerCase());
}

export function encodeCampaignPath(chainId: number, address: string): string {
  return encodeURIComponent(campaignKey(chainId, address));
}

/** Integer string, including pg numeric `10000000.000000`. */
export function parseRawAmount(rawValue: unknown): bigint {
  const raw = String(rawValue ?? "").trim();
  if (!raw || raw === "0") return 0n;
  const intish = raw.match(/^(\d+)(?:\.0+)?$/);
  if (intish) {
    try {
      return BigInt(intish[1]);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function maxPlausibleScaled(decimals: number): bigint {
  if (decimals <= 6) return 10n ** 15n; // 1B tokens at 6dp
  if (decimals <= 9) return 10n ** 12n; // 1,000 SOL
  return 10n ** 24n; // 1M BNB
}

/**
 * Human decimal → raw units.
 * Never use a digit-count heuristic: Solana lamports are 7–12 digits, so the
 * old “16+ digits means raw” rule turned 10_000_000 lamports into 10M SOL.
 * If scaling an integer as a whole-token amount exceeds a plausible fill,
 * the integer was already raw.
 */
export function parseHumanAmountToRaw(value: unknown, decimals: number): bigint {
  const text = String(value ?? "").trim();
  if (!text || text === "0") return 0n;
  if (/^\d+$/.test(text)) {
    try {
      const asInt = BigInt(text);
      const scale = 10n ** BigInt(Math.max(0, decimals));
      if (asInt * scale > maxPlausibleScaled(decimals)) return asInt;
      return asInt * scale;
    } catch {
      return 0n;
    }
  }
  try {
    return ethers.parseUnits(text, decimals);
  } catch {
    return 0n;
  }
}

/** Explicit raw field if present, otherwise human decimal. */
export function parseRawOrHumanAmount(
  rawValue: unknown,
  humanValue: unknown,
  decimals: number,
): bigint {
  const rawText = String(rawValue ?? "").trim();
  if (rawText !== "") {
    const parsed = parseRawAmount(rawText);
    if (parsed > 0n || /^0+(?:\.0+)?$/.test(rawText)) return parsed;
  }
  return parseHumanAmountToRaw(humanValue, decimals);
}

/** Unix seconds. Accepts sec, ms, Date, ISO, or numeric strings. */
export function timestampSec(value: unknown): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === "number") return Math.floor(value > 1e12 ? value / 1000 : value);
  const text = String(value || "").trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const n = Number(text);
    return Number.isFinite(n) ? Math.floor(n > 1e12 ? n / 1000 : n) : 0;
  }
  const ms = new Date(text).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

function venueFromSource(source: unknown, soldTokensAfterRaw: bigint | null): CurveTradePoint["venue"] {
  const raw = String(source || "").toLowerCase();
  if (raw === "dex" || raw === "topaz" || raw === "meteora") return "dex";
  if (raw === "curve" || raw === "bonding") return "curve";
  if (soldTokensAfterRaw != null) return "curve";
  return undefined;
}

/** Shared MarketTrade → chart/trade-table point (BNB + Solana). */
export function marketTradeToCurvePoint(trade: MarketTrade, chainId: number): CurveTradePoint | null {
  const txHash = normalizeTradeTxHash(trade.txHash);
  if (!txHash || !isValidTradeTxHash(txHash)) return null;
  const tokensWei = parseRawAmount(trade.tokenAmountRaw);
  const nativeWei = parseRawAmount(trade.nativeAmountRaw);
  const price = Number(trade.priceBnb || 0);
  const soldAfter =
    (trade as MarketTrade & { soldTokensAfterRaw?: string }).soldTokensAfterRaw != null
      ? parseRawAmount((trade as MarketTrade & { soldTokensAfterRaw?: string }).soldTokensAfterRaw)
      : null;
  const grossRaw = (trade as MarketTrade & { grossRaw?: string | null; gross_raw?: string | null }).grossRaw
    ?? (trade as MarketTrade & { gross_raw?: string | null }).gross_raw;
  return {
    type: trade.side === "sell" ? "sell" : "buy",
    from: campaignKey(chainId, trade.wallet),
    to: campaignKey(chainId, trade.recipient || trade.wallet),
    tokensWei,
    nativeWei,
    pricePerToken: Number.isFinite(price) ? price : 0,
    feeFreePricePerToken: isSolanaChainId(chainId) ? null : evmFeeFreeTradePrice(grossRaw, tokensWei),
    soldTokensAfterRaw: soldAfter,
    venue: venueFromSource(trade.source, soldAfter),
    timestamp: timestampSec(trade.blockTime),
    txHash,
    blockNumber: Number(trade.blockNumber || 0),
    logIndex: Number(trade.logIndex || 0),
  };
}

function formatUnitsNumber(raw: bigint, decimals: number): number {
  if (raw === 0n) return 0;
  const negative = raw < 0n;
  const value = negative ? -raw : raw;
  const base = 10n ** BigInt(Math.max(0, decimals));
  const whole = value / base;
  const frac = value % base;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, 12);
  const n = Number(`${whole}.${fracStr}`);
  return Number.isFinite(n) ? (negative ? -n : n) : 0;
}

/** Indexer / Ably / wallet-report row → chart point. */
export function indexerRowToCurvePoint(
  row: Record<string, unknown>,
  chainId: number,
  campaignAddress: string,
  decimals?: { token?: number; native?: number },
): CurveTradePoint | null {
  const txHash = normalizeTradeTxHash(row.tx_hash ?? row.txHash);
  if (!txHash || !isValidTradeTxHash(txHash)) return null;

  const soldAfterRaw = row.sold_tokens_after_raw ?? row.soldTokensAfterRaw;
  const soldTokensAfterRaw =
    soldAfterRaw != null && String(soldAfterRaw).trim() !== "" ? parseRawAmount(soldAfterRaw) : null;

  const tokenDecimals = decimals?.token ?? (isSolanaChainId(chainId) ? 6 : 18);
  const nativeDecimals = decimals?.native ?? (isSolanaChainId(chainId) ? 9 : 18);
  const tokensWei = parseRawOrHumanAmount(
    row.token_amount_raw ?? row.tokenAmountRaw ?? row.tokensWei,
    row.token_amount ?? row.tokenAmount,
    tokenDecimals,
  );
  const nativeWei = parseRawOrHumanAmount(
    row.bnb_amount_raw ?? row.native_amount_raw ?? row.nativeAmountRaw ?? row.nativeWei,
    row.bnb_amount ?? row.bnbAmount ?? row.nativeAmount,
    nativeDecimals,
  );

  const suppliedPrice = Number(row.price_bnb ?? row.pricePerToken ?? row.priceBnb ?? 0);
  const tokens = formatUnitsNumber(tokensWei, tokenDecimals);
  const native = formatUnitsNumber(nativeWei, nativeDecimals);
  const pricePerToken =
    Number.isFinite(suppliedPrice) && suppliedPrice > 0
      ? suppliedPrice
      : tokens > 0
        ? native / tokens
        : 0;

  return {
    type: String(row.side || row.type || "").toLowerCase() === "sell" ? "sell" : "buy",
    from: campaignKey(chainId, row.wallet || row.trader || row.from || ""),
    to: campaignKey(chainId, row.to || campaignAddress),
    tokensWei,
    nativeWei,
    pricePerToken,
    // EVM gen-6/7 rows from the indexer carry gross_raw (the fill without the trade fee).
    feeFreePricePerToken: isSolanaChainId(chainId)
      ? null
      : evmFeeFreeTradePrice(row.gross_raw ?? row.grossRaw, tokensWei, tokenDecimals, nativeDecimals),
    soldTokensAfterRaw,
    venue: venueFromSource(row.venue ?? row.source, soldTokensAfterRaw),
    timestamp: timestampSec(row.block_time ?? row.timestamp ?? row.time ?? row.blockTime ?? row.ts),
    txHash,
    blockNumber: Number(row.block_number ?? row.blockNumber ?? 0),
    logIndex: Number(row.log_index ?? row.logIndex ?? 0),
  };
}
