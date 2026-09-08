import { canonicalTokenKey } from "./arenaLeagueScoreMath.js";
import { isRobinhoodChainId, isSolanaChainId } from "./chainNative.js";
import { resolveBnbUsdPrice } from "./bnbUsdPrice.js";
import { resolveEthUsdPrice } from "./ethUsdPrice.js";
import { resolveSolUsdPrice } from "./solUsdPrice.js";
import { BATTLE_POINTS_CONFIG } from "./arenaBattlePointsConfig.js";

async function defaultQuery(text, params) {
  const { pool } = await import("../../server/db.js");
  return pool.query(text, params);
}

function ident(value) {
  return canonicalTokenKey(value);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positiveNumber(value) {
  const n = finiteNumber(value);
  return n !== null && n > 0 ? n : null;
}

function nativeDecimals(chainId) {
  return isSolanaChainId(chainId) ? 9 : 18;
}

function identityEquals(chainId, expression, parameter) {
  return isSolanaChainId(chainId)
    ? `${expression} = ${parameter}`
    : `lower(${expression}) = lower(${parameter})`;
}

export async function resolveNativeUsdPrice(chainId, resolveNativeUsd) {
  if (typeof resolveNativeUsd === "function") return resolveNativeUsd(chainId);
  if (isSolanaChainId(chainId)) return resolveSolUsdPrice();
  if (isRobinhoodChainId(chainId)) return resolveEthUsdPrice();
  return resolveBnbUsdPrice();
}

export function nativeAmountToUsd(chainId, nativeAmount, nativeUsd) {
  const amount = finiteNumber(nativeAmount);
  const px = finiteNumber(nativeUsd?.price ?? nativeUsd);
  if (amount === null || !(px > 0)) return null;
  return amount * px;
}

export function nativeRawToUsd(chainId, raw, nativeUsd) {
  if (raw === null || raw === undefined || raw === "") return null;
  const rawN = Number(String(raw));
  const px = finiteNumber(nativeUsd?.price ?? nativeUsd);
  if (!Number.isFinite(rawN) || !(px > 0)) return null;
  return (rawN / 10 ** nativeDecimals(chainId)) * px;
}

function emptySnapshot(chainId, tokenAddress, reason, identity = null) {
  return {
    chainId: Number(chainId),
    tokenAddress: tokenAddress || null,
    campaignAddress: identity?.campaignAddress || null,
    origin: identity?.origin || "none",
    creatorAddress: identity?.creatorAddress || null,
    feeRecipientAddress: identity?.feeRecipientAddress || null,
    marketCapUsd: null,
    holders: null,
    liquidityUsd: null,
    volume24hUsd: null,
    updatedAt: null,
    dataSource: "none",
    healthy: false,
    dataLagSeconds: null,
    reason,
    reasons: [reason],
    quoteAssetType: null,
    quoteTokenAddress: null,
    nativeUsdPrice: null,
    fxSource: "none",
    componentHealth: {
      marketCap: false,
      holders: false,
      liquidity: false,
    },
  };
}

function lagFrom(updatedAt, nowMs) {
  if (!updatedAt) return null;
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, (nowMs - ts) / 1000);
}

async function lookupIdentity(query, chainId, tokenIdentity) {
  const normalized = ident(tokenIdentity);
  if (!normalized) return null;
  const campaignMatch = identityEquals(chainId, "c.campaign_address::text", "$2");
  const tokenMatch = identityEquals(chainId, "coalesce(c.token_address::text, '')", "$2");
  const native = await query(
    `select c.chain_id, c.campaign_address, c.token_address, c.creator_address, c.name, c.symbol,
            c.fee_recipient_address
       from public.campaigns c
      where c.chain_id = $1
        and (${campaignMatch} or ${tokenMatch})
      order by c.created_block desc nulls last
      limit 1`,
    [chainId, normalized],
  );
  if (native.rows[0]) {
    const row = native.rows[0];
    return {
      origin: "native",
      chainId: Number(row.chain_id),
      campaignAddress: ident(row.campaign_address),
      tokenAddress: ident(row.token_address || row.campaign_address),
      creatorAddress: ident(row.creator_address),
      feeRecipientAddress: ident(row.fee_recipient_address),
      importScan: null,
    };
  }
  const importMatch = identityEquals(chainId, "token_address", "$2");
  const imported = await query(
    `select chain_id, token_address, owner_wallet, scan_json
       from public.arena_token_imports
      where chain_id = $1 and ${importMatch}
      limit 1`,
    [chainId, normalized],
  );
  if (imported.rows[0]) {
    const row = imported.rows[0];
    return {
      origin: "import",
      chainId: Number(row.chain_id),
      campaignAddress: null,
      tokenAddress: ident(row.token_address),
      creatorAddress: ident(row.owner_wallet),
      feeRecipientAddress: null,
      importScan: row.scan_json && typeof row.scan_json === "object" ? row.scan_json : null,
    };
  }
  return {
    origin: "unknown",
    chainId: Number(chainId),
    campaignAddress: null,
    tokenAddress: normalized,
    creatorAddress: null,
    feeRecipientAddress: null,
    importScan: null,
  };
}

async function readMarketStats(query, chainId, campaignAddress, tokenAddress) {
  if (campaignAddress) {
    const byCampaign = await query(
      `select market_cap_usd, liquidity_usd, volume_24h_usd,
              market_cap_bnb, liquidity_bnb, holders, volume_24h_bnb,
              quote_asset_type, quote_token_address,
              updated_at, data_lag_seconds
         from public.market_stats
        where chain_id = $1 and campaign_address = $2
        limit 1`,
      [chainId, campaignAddress],
    );
    if (byCampaign.rows[0]) return byCampaign.rows[0];
  }

  // Compatibility for MemeWarzone-native tokens whose caller supplies token
  // address rather than campaign address. Imported tokens deliberately do not
  // masquerade as campaigns here.
  if (tokenAddress) {
    const tokenMatch = identityEquals(chainId, "coalesce(c.token_address::text, '')", "$2");
    const byToken = await query(
      `select ms.market_cap_usd, ms.liquidity_usd, ms.volume_24h_usd,
              ms.market_cap_bnb, ms.liquidity_bnb, ms.holders, ms.volume_24h_bnb,
              ms.quote_asset_type, ms.quote_token_address,
              ms.updated_at, ms.data_lag_seconds
         from public.market_stats ms
         join public.campaigns c
           on c.chain_id = ms.chain_id and c.campaign_address = ms.campaign_address
        where ms.chain_id = $1
          and ${tokenMatch}
        limit 1`,
      [chainId, tokenAddress],
    );
    if (byToken.rows[0]) return byToken.rows[0];
  }
  return null;
}

async function readTokenStats(query, chainId, campaignAddress) {
  if (!campaignAddress) return null;
  const result = await query(
    `select marketcap_bnb, vol_24h_bnb, updated_at
       from public.token_stats
      where chain_id = $1 and campaign_address = $2
      limit 1`,
    [chainId, campaignAddress],
  );
  return result.rows[0] || null;
}

async function readHolderCount(query, chainId, tokenAddress, campaignAddress) {
  if (!tokenAddress) return null;
  try {
    const tokenMatch = identityEquals(chainId, "token_address", "$2");
    const walletNotToken = isSolanaChainId(chainId) ? `wallet <> $2` : `lower(wallet) <> lower($2)`;
    const walletNotCampaign = isSolanaChainId(chainId)
      ? `($3::text is null or $3 = '' or wallet <> $3)`
      : `($3::text is null or $3 = '' or lower(wallet) <> lower($3))`;
    const result = await query(
      `select count(*)::int as n
         from public.token_holder_balances
        where chain_id = $1
          and ${tokenMatch}
          and balance_raw > 0
          and ${walletNotToken}
          and ${walletNotCampaign}`,
      [chainId, tokenAddress, campaignAddress || ""],
    );
    const n = finiteNumber(result.rows[0]?.n);
    return n === null ? null : Math.max(0, Math.floor(n));
  } catch {
    return null;
  }
}

async function readNativePoolLiquidity(query, chainId, campaignAddress, nativeUsd) {
  if (!campaignAddress) return null;
  try {
    const result = await query(
      `select reserve_native_raw
         from public.dex_pools
        where chain_id = $1 and campaign_address = $2
          and coalesce(quote_asset_type,'WRAPPED_NATIVE') = 'WRAPPED_NATIVE'
        order by updated_at desc nulls last
        limit 1`,
      [chainId, campaignAddress],
    );
    return nativeRawToUsd(chainId, result.rows[0]?.reserve_native_raw, nativeUsd);
  } catch {
    return null;
  }
}

/**
 * Chain adapters normalize into this contract. Scoring code must never infer
 * that a Stock Token quote is native ETH/BNB/SOL.
 */
export async function getArenaMarketSnapshot(chainId, tokenIdentity, deps = {}) {
  const query = deps.query || defaultQuery;
  const nowMs = deps.nowMs || Date.now();
  const staleSeconds = deps.staleSeconds ?? BATTLE_POINTS_CONFIG.staleSeconds;
  const idNum = Number(chainId);
  const identity = await lookupIdentity(query, idNum, tokenIdentity);
  if (!identity?.tokenAddress && !identity?.campaignAddress) {
    return emptySnapshot(idNum, ident(tokenIdentity), "market_identity_missing", identity);
  }

  const stats = await readMarketStats(query, idNum, identity.campaignAddress, identity.origin === "native" ? identity.tokenAddress : null);
  if (!stats && identity.origin === "import") {
    // Import scanning proves token identity/safety metadata only; it is not an
    // authoritative market-data oracle. External/import market adapters can feed
    // normalized stats later without a second scoring implementation.
    return emptySnapshot(idNum, identity.tokenAddress, "import_market_data_missing", identity);
  }

  const quoteAssetType = String(stats?.quote_asset_type || "WRAPPED_NATIVE").toUpperCase();
  const quoteTokenAddress = ident(stats?.quote_token_address) || null;
  const stockQuoted = quoteAssetType === "STOCK_TOKEN";

  let nativeUsd = null;
  let px = 0;
  if (!stockQuoted) {
    nativeUsd = await resolveNativeUsdPrice(idNum, deps.resolveNativeUsd);
    px = finiteNumber(nativeUsd?.price ?? nativeUsd) || 0;
  }

  const tokenStats = stats || stockQuoted ? null : await readTokenStats(query, idNum, identity.campaignAddress);
  let dataSource = "none";
  let marketCapUsd = positiveNumber(stats?.market_cap_usd);
  let liquidityUsd = positiveNumber(stats?.liquidity_usd);
  let volume24hUsd = finiteNumber(stats?.volume_24h_usd);
  let holders = stats ? finiteNumber(stats.holders) : null;
  let updatedAt = stats?.updated_at || tokenStats?.updated_at || null;
  let dataLagSeconds = finiteNumber(stats?.data_lag_seconds);

  if (marketCapUsd !== null || liquidityUsd !== null || volume24hUsd !== null) {
    dataSource = stockQuoted ? "normalized_stock_market_stats" : "normalized_market_stats";
  }

  if (!stockQuoted && px > 0) {
    if (marketCapUsd === null && stats) marketCapUsd = nativeAmountToUsd(idNum, stats.market_cap_bnb, nativeUsd);
    if (liquidityUsd === null && stats) liquidityUsd = nativeAmountToUsd(idNum, stats.liquidity_bnb, nativeUsd);
    if (volume24hUsd === null && stats) volume24hUsd = nativeAmountToUsd(idNum, stats.volume_24h_bnb, nativeUsd);
    if (stats && dataSource === "none") dataSource = "legacy_native_market_stats+fx";

    if (!stats && tokenStats) {
      marketCapUsd = nativeAmountToUsd(idNum, tokenStats.marketcap_bnb, nativeUsd);
      volume24hUsd = nativeAmountToUsd(idNum, tokenStats.vol_24h_bnb, nativeUsd);
      dataSource = "legacy_token_stats+fx";
    }
  }

  if (holders === null) {
    const counted = await readHolderCount(query, idNum, identity.tokenAddress, identity.campaignAddress);
    if (counted !== null) {
      holders = counted;
      if (dataSource === "none") dataSource = "token_holder_balances";
    }
  }

  if (liquidityUsd === null && !stockQuoted) {
    liquidityUsd = await readNativePoolLiquidity(query, idNum, identity.campaignAddress, nativeUsd);
    if (liquidityUsd !== null && dataSource === "none") dataSource = "native_dex_pool+fx";
  }

  if (dataLagSeconds === null) dataLagSeconds = lagFrom(updatedAt, nowMs);

  const reasons = [];
  if (!(marketCapUsd > 0)) reasons.push(stockQuoted ? "stock_market_cap_usd_missing" : "market_cap_usd_missing");
  if (holders === null) reasons.push("holders_missing");
  if (!(liquidityUsd > 0)) reasons.push(stockQuoted ? "stock_liquidity_usd_missing" : "liquidity_usd_missing");
  if (stockQuoted && volume24hUsd === null) reasons.push("stock_volume_usd_missing");
  if (!stockQuoted && marketCapUsd === null && !(px > 0)) reasons.push("native_usd_price_missing");
  if (dataLagSeconds !== null && dataLagSeconds > staleSeconds) reasons.push("stale");

  const uniqueReasons = [...new Set(reasons)];
  const healthy = uniqueReasons.length === 0;

  return {
    chainId: idNum,
    tokenAddress: identity.tokenAddress,
    campaignAddress: identity.campaignAddress,
    origin: identity.origin,
    creatorAddress: identity.creatorAddress,
    feeRecipientAddress: identity.feeRecipientAddress,
    marketCapUsd,
    holders: holders === null ? null : Math.max(0, Math.floor(holders)),
    liquidityUsd,
    volume24hUsd,
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
    dataSource,
    healthy,
    dataLagSeconds,
    reason: uniqueReasons[0] || null,
    reasons: uniqueReasons,
    quoteAssetType,
    quoteTokenAddress,
    nativeUsdPrice: !stockQuoted && px > 0 ? px : null,
    fxSource: stockQuoted ? "not_applicable_stock_quote" : nativeUsd?.source || (px > 0 ? "injected" : "none"),
    componentHealth: {
      marketCap: marketCapUsd !== null && marketCapUsd > 0,
      holders: holders !== null,
      liquidity: liquidityUsd !== null && liquidityUsd > 0,
    },
  };
}
