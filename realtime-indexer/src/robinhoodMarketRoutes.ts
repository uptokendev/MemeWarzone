import { pool } from "./db.js";
import { describeRobinhoodQuoteAsset } from "./robinhoodStockTokenRegistry.js";

export type RobinhoodTradeSide = "buy" | "sell";

export type RobinhoodMarketRoute = {
  chainId: number;
  marketId: string;
  campaignAddress: string;
  baseToken: string;
  quoteToken: string;
  baseDecimals: number;
  quoteDecimals: number;
  poolAddress: string;
  routerAddress: string | null;
  factoryAddress: string | null;
  routeKind: "DIRECT_NATIVE" | "STOCK_TWO_HOP" | "UNKNOWN";
  quoteAssetType: "WRAPPED_NATIVE" | "STOCK_TOKEN" | "UNKNOWN";
  marketRole: string;
  feeTier: number | null;
  referenceOracle: string | null;
  canonical: boolean;
  verified: boolean;
  tradingEnabled: boolean;
  indexingEnabled: boolean;
  marketPolicyVersion: string | null;
  inputAsset: string | null;
  outputAsset: string | null;
  legs: Array<{ from: string; to: string }>;
};

type MarketPairRow = Record<string, unknown>;

function text(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function integer(value: unknown, fallback = 18): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 36 ? parsed : fallback;
}

export function buildRobinhoodMarketRoute(input: {
  row: MarketPairRow;
  wrappedNativeAddress?: string | null;
  side?: RobinhoodTradeSide | null;
}): RobinhoodMarketRoute {
  const row = input.row;
  const chainId = Number(row.chain_id);
  const campaignAddress = text(row.campaign_address);
  const baseToken = text(row.base_token_address);
  const quoteToken = text(row.quote_token_address);
  const poolAddress = text(row.pool_address);
  if (!Number.isInteger(chainId) || !campaignAddress || !baseToken || !quoteToken || !poolAddress) {
    throw new Error("Robinhood market route row is incomplete");
  }

  const descriptor = describeRobinhoodQuoteAsset({
    chainId,
    quoteToken,
    wrappedNativeAddress: input.wrappedNativeAddress,
  });
  const storedQuoteType = String(row.quote_asset_type || "").trim().toUpperCase();
  const quoteAssetType =
    descriptor.quoteAssetType !== "UNKNOWN"
      ? descriptor.quoteAssetType
      : storedQuoteType === "WRAPPED_NATIVE" || storedQuoteType === "STOCK_TOKEN"
        ? storedQuoteType
        : "UNKNOWN";
  const routeKind =
    quoteAssetType === "WRAPPED_NATIVE"
      ? "DIRECT_NATIVE"
      : quoteAssetType === "STOCK_TOKEN"
        ? "STOCK_TWO_HOP"
        : "UNKNOWN";

  const side = input.side || null;
  const nativeAsset = "native:eth";
  const inputAsset = side === "buy" ? nativeAsset : side === "sell" ? baseToken : null;
  const outputAsset = side === "buy" ? baseToken : side === "sell" ? nativeAsset : null;
  const legs = !side
    ? []
    : routeKind === "DIRECT_NATIVE"
      ? side === "buy"
        ? [{ from: nativeAsset, to: baseToken }]
        : [{ from: baseToken, to: nativeAsset }]
      : routeKind === "STOCK_TWO_HOP"
        ? side === "buy"
          ? [
              { from: nativeAsset, to: quoteToken },
              { from: quoteToken, to: baseToken },
            ]
          : [
              { from: baseToken, to: quoteToken },
              { from: quoteToken, to: nativeAsset },
            ]
        : [];

  const marketRole = String(row.market_role || "").trim().toUpperCase();
  return {
    chainId,
    marketId: `robinhood:${chainId}:${String(row.id ?? poolAddress)}`,
    campaignAddress,
    baseToken,
    quoteToken,
    baseDecimals: integer(row.base_decimals),
    quoteDecimals: integer(row.quote_decimals),
    poolAddress,
    routerAddress: text(row.router_address) || null,
    factoryAddress: text(row.factory_address) || null,
    routeKind,
    quoteAssetType,
    marketRole,
    feeTier: row.fee_tier == null ? null : Number(row.fee_tier),
    referenceOracle: descriptor.referenceOracle || text(row.oracle_feed_address) || null,
    canonical: marketRole === "CANONICAL_NATIVE" || marketRole === "CANONICAL_STOCK",
    verified: Boolean(row.verified),
    tradingEnabled: Boolean(row.trading_enabled),
    indexingEnabled: Boolean(row.indexing_enabled),
    marketPolicyVersion: String(row.market_policy_version || "").trim() || null,
    inputAsset,
    outputAsset,
    legs,
  };
}

export async function readCanonicalRobinhoodMarketRoute(input: {
  chainId: number;
  campaignAddress: string;
  wrappedNativeAddress?: string | null;
  side?: RobinhoodTradeSide | null;
}): Promise<RobinhoodMarketRoute | null> {
  const result = await pool.query(
    `select id,chain_id,campaign_address,pool_address,base_token_address,quote_token_address,
            base_decimals,quote_decimals,quote_asset_type,market_role,venue,fee_tier,
            router_address,factory_address,verified,trading_enabled,indexing_enabled,
            oracle_feed_address,market_policy_version
       from public.market_pairs
      where chain_id=$1
        and lower(campaign_address)=lower($2)
        and market_role in ('CANONICAL_NATIVE','CANONICAL_STOCK')
      order by case market_role when 'CANONICAL_STOCK' then 0 else 1 end,id asc
      limit 1`,
    [input.chainId, input.campaignAddress],
  );
  const row = result.rows[0];
  return row
    ? buildRobinhoodMarketRoute({ row, wrappedNativeAddress: input.wrappedNativeAddress, side: input.side })
    : null;
}
