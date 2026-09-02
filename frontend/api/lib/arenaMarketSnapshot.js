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

function nativeDecimals(chainId) {
  return isSolanaChainId(chainId) ? 9 : 18;
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
  const rawN = finiteNumber(raw);
  const px = finiteNumber(nativeUsd?.price ?? nativeUsd);
  if (rawN === null || !(px > 0)) return null;
  return (rawN / 10 ** nativeDecimals(chainId)) * px;
}

function emptySnapshot(chainId, tokenAddress, reason) {
  return {
    chainId: Number(chainId),
    tokenAddress: tokenAddress || null,
    campaignAddress: null,
    origin: "none",
    marketCapUsd: null,
    holders: null,
    liquidityUsd: null,
    volume24hUsd: null,
    updatedAt: null,
    dataSource: "none",
    healthy: false,
    dataLagSeconds: null,
    reason,
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
  const native = await query(
    `select c.chain_id, c.campaign_address, c.token_address, c.creator_address, c.name, c.symbol,
            c.fee_recipient_address
       from public.campaigns c
      where c.chain_id = $1
        and (lower(c.campaign_address::text) = lower($2) or lower(coalesce(c.token_address::text, '')) = lower($2))
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
    };
  }
  const imported = await query(
    `select chain_id, token_address, owner_wallet
       from public.arena_token_imports
      where chain_id = $1 and lower(token_address) = lower($2)
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
    };
  }
  return {
    origin: "unknown",
    chainId: Number(chainId),
    campaignAddress: null,
    tokenAddress: normalized,
    creatorAddress: null,
    feeRecipientAddress: null,
  };
}

async function readMarketStats(query, chainId, campaignAddress, tokenAddress) {
  if (campaignAddress) {
    const byCampaign = await query(
      `select market_cap_bnb, liquidity_bnb, holders, volume_24h_bnb, updated_at, data_lag_seconds
         from public.market_stats
        where chain_id = $1 and campaign_address = $2
        limit 1`,
      [chainId, campaignAddress],
    );
    if (byCampaign.rows[0]) return byCampaign.rows[0];
  }
  if (tokenAddress) {
    const byToken = await query(
      `select ms.market_cap_bnb, ms.liquidity_bnb, ms.holders, ms.volume_24h_bnb, ms.updated_at, ms.data_lag_seconds
         from public.market_stats ms
         join public.campaigns c
           on c.chain_id = ms.chain_id and c.campaign_address = ms.campaign_address
        where ms.chain_id = $1
          and lower(coalesce(c.token_address::text, '')) = lower($2)
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
    const result = await query(
      `select count(*)::int as n
         from public.token_holder_balances
        where chain_id = $1
          and lower(token_address) = lower($2)
          and balance_raw > 0
          and lower(wallet) <> lower($2)
          and ($3::text is null or $3 = '' or lower(wallet) <> lower($3))`,
      [chainId, tokenAddress, campaignAddress || ""],
    );
    const n = finiteNumber(result.rows[0]?.n);
    return n === null ? null : Math.max(0, Math.floor(n));
  } catch {
    return null;
  }
}

async function readPoolLiquidity(query, chainId, campaignAddress, nativeUsd) {
  if (!campaignAddress) return null;
  try {
    const result = await query(
      `select reserve_native_raw
         from public.dex_pools
        where chain_id = $1 and campaign_address = $2
        order by updated_at desc nulls last
        limit 1`,
      [chainId, campaignAddress],
    );
    const raw = result.rows[0]?.reserve_native_raw;
    return nativeRawToUsd(chainId, raw, nativeUsd);
  } catch {
    return null;
  }
}

export async function getArenaMarketSnapshot(chainId, tokenIdentity, deps = {}) {
  const query = deps.query || defaultQuery;
  const nowMs = deps.nowMs || Date.now();
  const staleSeconds = deps.staleSeconds ?? BATTLE_POINTS_CONFIG.staleSeconds;
  const idNum = Number(chainId);
  const identity = await lookupIdentity(query, idNum, tokenIdentity);
  if (!identity?.tokenAddress && !identity?.campaignAddress) {
    return emptySnapshot(idNum, ident(tokenIdentity), "missing");
  }

  const nativeUsd = await resolveNativeUsdPrice(idNum, deps.resolveNativeUsd);
  const px = finiteNumber(nativeUsd?.price ?? nativeUsd) || 0;
  const stats = await readMarketStats(query, idNum, identity.campaignAddress, identity.tokenAddress);
  const tokenStats = stats ? null : await readTokenStats(query, idNum, identity.campaignAddress);

  let dataSource = "none";
  let marketCapUsd = null;
  let liquidityUsd = null;
  let volume24hUsd = null;
  let holders = stats ? finiteNumber(stats.holders) : null;
  let updatedAt = stats?.updated_at || tokenStats?.updated_at || null;
  let dataLagSeconds = finiteNumber(stats?.data_lag_seconds);

  if (stats) {
    dataSource = "market_stats";
    if (px > 0) {
      marketCapUsd = nativeAmountToUsd(idNum, stats.market_cap_bnb, nativeUsd);
      liquidityUsd = nativeAmountToUsd(idNum, stats.liquidity_bnb, nativeUsd);
      volume24hUsd = nativeAmountToUsd(idNum, stats.volume_24h_bnb, nativeUsd);
    }
  } else if (tokenStats) {
    dataSource = "token_stats+fx";
    if (px > 0) {
      marketCapUsd = nativeAmountToUsd(idNum, tokenStats.marketcap_bnb, nativeUsd);
      volume24hUsd = nativeAmountToUsd(idNum, tokenStats.vol_24h_bnb, nativeUsd);
    }
  }

  if (holders === null) {
    const counted = await readHolderCount(query, idNum, identity.tokenAddress, identity.campaignAddress);
    if (counted !== null) {
      holders = counted;
      if (dataSource === "none") dataSource = "token_holder_balances";
    }
  }
  if (liquidityUsd === null) {
    liquidityUsd = await readPoolLiquidity(query, idNum, identity.campaignAddress, nativeUsd);
    if (liquidityUsd !== null && dataSource === "none") dataSource = "dex_pools";
  }

  if (dataLagSeconds === null) dataLagSeconds = lagFrom(updatedAt, nowMs);

  const reasons = [];
  if (marketCapUsd === null) {
    reasons.push(px > 0 ? "missing" : "native_units_unpriced");
  }
  if (dataLagSeconds !== null && dataLagSeconds > staleSeconds) reasons.push("stale");
  const reason = reasons[0] || null;
  const healthy = reasons.length === 0 && marketCapUsd !== null && marketCapUsd > 0;

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
    reason,
    nativeUsdPrice: px > 0 ? px : null,
    fxSource: nativeUsd?.source || (px > 0 ? "injected" : "none"),
  };
}
