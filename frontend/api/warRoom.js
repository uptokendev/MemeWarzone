import { pool } from "../server/db.js";
import { resolveSolUsdPrice } from "./lib/solUsdPrice.js";
import { withSolanaLaunchpadMarketCap } from "./lib/solanaCampaignProgress.js";
import { liveVoteWindowsJoin } from "./lib/liveVoteWindows.js";
import { badMethod, getQuery, isAddress, isSolanaAddress, isSolanaChain, json, normalizeAddress as normalizeChainAddress } from "../server/http.js";

const DEFAULT_GRAD_TARGET_BNB = 50;
const BNB_CHAIN_ID = 56;
const BNB_TESTNET_CHAIN_ID = 97;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toFloat(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function testnetCampaignsEnabled(q) {
  return (
    truthy(q.includeTestnet) ||
    truthy(q.testnet) ||
    truthy(process.env.VITE_ENABLE_TESTNET_CAMPAIGNS) ||
    truthy(process.env.VITE_WAR_ROOM_INCLUDE_TESTNET) ||
    truthy(process.env.WAR_ROOM_INCLUDE_TESTNET)
  );
}

function resolveWarRoomChainIds(chainId, includeTestnet) {
  if (isSolanaChain(chainId)) return [chainId];
  if (chainId === BNB_TESTNET_CHAIN_ID) return [BNB_TESTNET_CHAIN_ID];
  if (chainId === BNB_CHAIN_ID && includeTestnet) return [BNB_CHAIN_ID, BNB_TESTNET_CHAIN_ID];
  return [chainId || BNB_CHAIN_ID];
}

function normalizeMode(value) {
  const mode = String(value || "trending").toLowerCase();
  return mode === "new" || mode === "graduated" || mode === "draft" ? mode : "trending";
}

function addressLooksValid(value, chainId) {
  return isSolanaChain(chainId) ? isSolanaAddress(value) : isAddress(String(value || "").toLowerCase());
}

function normalizeOutputAddress(value, chainId) {
  return normalizeChainAddress(value, chainId) || String(value || "").trim();
}

function emptyWarRoom(res, error) {
  console.error("[api/warRoom] query failed", error);
  return json(res, 200, { items: [], updatedAt: new Date().toISOString(), warning: "War Room campaign data is unavailable." });
}

function buildSearchFilter(search, params) {
  if (!search) return null;
  params.push(`%${search}%`);
  const idx = params.length;
  return `(c.name ilike $${idx} or c.symbol ilike $${idx} or c.campaign_address::text ilike $${idx} or c.creator_address::text ilike $${idx})`;
}

function buildDetailFilter(detailAddress, params) {
  if (!detailAddress) return null;
  params.push(detailAddress);
  const idx = params.length;
  return `(c.campaign_address::text = $${idx} or lower(c.campaign_address::text) = lower($${idx}))`;
}

function modeFilter(mode) {
  if (mode === "graduated") return "c.graduated_at_chain is not null";
  if (mode === "draft") return "coalesce(c.is_active, false) = false and c.graduated_at_chain is null";
  return null;
}

function orderByForMode(mode) {
  if (mode === "new") return "created_block desc nulls last, created_at_chain desc nulls last, campaign_address asc";
  if (mode === "graduated") return "graduated_block desc nulls last, graduated_at_chain desc nulls last, last_activity_at desc nulls last, campaign_address asc";
  return "trending_score desc nulls last, last_activity_at desc nulls last, created_block desc nulls last, campaign_address asc";
}

function mapWarRoomRow(row) {
  const chainId = Number(row.chainId);
  const graduatedAt = row.graduatedAtChain ? String(row.graduatedAtChain) : null;
  return {
    chainId,
    campaignAddress: normalizeOutputAddress(row.campaignAddress, chainId),
    tokenAddress: row.tokenAddress ? normalizeOutputAddress(row.tokenAddress, chainId) : null,
    creatorAddress: row.creatorAddress ? normalizeOutputAddress(row.creatorAddress, chainId) : null,
    name: row.name ?? null,
    symbol: row.symbol ?? null,
    logoUri: row.logoUri ?? null,
    createdAtChain: row.createdAtChain ? String(row.createdAtChain) : null,
    graduatedAtChain: graduatedAt,
    isDexTrading: Boolean(graduatedAt),
    isActive: Boolean(row.isActive),
    status: graduatedAt ? "graduated" : row.isActive ? "live" : "draft",
    lastActivityAt: row.lastActivityAt ? String(row.lastActivityAt) : null,
    lastPriceBnb: row.lastPriceBnb != null ? String(row.lastPriceBnb) : null,
    soldTokens: row.soldTokens != null ? String(row.soldTokens) : null,
    marketcapBnb: row.marketcapBnb != null ? String(row.marketcapBnb) : null,
    vol24hBnb: row.vol24hBnb != null ? String(row.vol24hBnb) : null,
    holderCount: row.holderCount != null ? Number(row.holderCount) : 0,
    athMarketcapBnb: row.athMarketcapBnb != null ? String(row.athMarketcapBnb) : null,
    // Solana launchpad coins: the post-graduation supply the client values live prices on.
    fullyDilutedSupply: row.fullyDilutedSupply != null ? String(row.fullyDilutedSupply) : null,
    raisedTotalBnb: row.raisedTotalBnb != null ? String(row.raisedTotalBnb) : "0",
    raised10mBnb: row.raised10mBnb != null ? String(row.raised10mBnb) : "0",
    progressPct: row.progressPct != null ? Number(row.progressPct) : null,
    etaSec: row.etaSec != null ? Number(row.etaSec) : null,
    votes24h: row.votes24h != null ? Number(row.votes24h) : 0,
    votesAllTime: row.votesAllTime != null ? Number(row.votesAllTime) : 0,
    trendingScore: row.trendingScore != null ? Number(row.trendingScore) : 0,
    gradTargetBnb: row.gradTargetBnb != null ? Number(row.gradTargetBnb) : DEFAULT_GRAD_TARGET_BNB,
  };
}

async function watchlistState({ chainId, campaignAddress, userAddress }) {
  const user = normalizeChainAddress(userAddress, chainId);
  const campaign = normalizeChainAddress(campaignAddress, chainId);
  if (!addressLooksValid(user, chainId)) return { supported: true, following: false, reason: "wallet_not_connected" };
  if (!addressLooksValid(campaign, chainId)) return { supported: false, following: false, reason: "invalid_campaign_address" };

  const result = await pool.query(
    `select 1 from public.campaign_follows where chain_id = $1 and user_address = $2 and campaign_address = $3 limit 1`,
    [chainId, user, campaign],
  );
  return { supported: true, following: result.rows.length > 0, reason: result.rows.length > 0 ? null : "not_following" };
}

function detailPayload(row, watchlist) {
  const chainId = Number(row.chainId);
  const campaignAddress = normalizeOutputAddress(row.campaignAddress, chainId);
  const tokenAddress = row.tokenAddress ? normalizeOutputAddress(row.tokenAddress, chainId) : null;
  const isGraduated = Boolean(row.graduatedAtChain);
  const isLive = Boolean(row.isActive);
  const eligible = isLive && !isGraduated;
  return {
    campaign: mapWarRoomRow(row),
    chart: {
      source: isGraduated && tokenAddress ? "dex" : "bonding_curve",
      campaignAddress,
      tokenAddress,
      preferredTimeframe: isGraduated ? "5m" : "1m",
    },
    battleIntel: {
      status: eligible ? "eligible" : "unavailable",
      eligible,
      unavailableReason: eligible ? null : isGraduated ? "graduated_to_dex" : "campaign_not_active",
      summary: eligible
        ? "This coin is active and can be prepared for battle once battle rules are met."
        : isGraduated
          ? "This coin has graduated to DEX trading."
          : "This coin is not active for battles right now.",
    },
    tradeContext: {
      mode: isGraduated ? "dex" : "bonding_curve",
      canBuy: Boolean(isLive || isGraduated),
      canSell: Boolean(isLive || isGraduated),
      slippagePct: 5,
    },
    watchlist,
    updatedAt: new Date().toISOString(),
  };
}

async function fetchWarRoomRows({ chainIds, mode, search, detailAddress, limit, gradTargetBnb }) {
  const params = [chainIds, gradTargetBnb];
  const filters = ["c.chain_id = any($1::int[])", "c.campaign_address is not null"];
  const searchFilter = buildSearchFilter(search, params);
  const detailFilter = buildDetailFilter(detailAddress, params);
  const modeClause = detailAddress ? null : modeFilter(mode);
  if (searchFilter) filters.push(searchFilter);
  if (detailFilter) filters.push(detailFilter);
  if (modeClause) filters.push(modeClause);
  params.push(limit);

  const sql = `
    with base as (
      select
        c.chain_id,
        c.campaign_address,
        c.token_address,
        c.creator_address,
        c.name,
        c.symbol,
        c.logo_uri,
        c.created_block,
        c.created_at_chain,
        c.graduated_block,
        c.graduated_at_chain,
        c.is_active,
        ts.last_price_bnb,
        ts.sold_tokens,
        ts.marketcap_bnb,
        ts.vol_24h_bnb,
        vw.votes_24h,
        va.votes_all_time,
        coalesce(vw.trending_score, 0) as vote_trending_score,
        ca.last_activity_at
      from public.campaigns c
      left join public.token_stats ts
        on ts.chain_id = c.chain_id and ts.campaign_address = c.campaign_address
      left join public.vote_aggregates va
        on va.chain_id = c.chain_id and va.campaign_address = c.campaign_address
      ${liveVoteWindowsJoin("va.chain_id", "va.campaign_address")}
      left join public.campaign_activity ca
        on ca.chain_id = c.chain_id and ca.campaign_address = c.campaign_address
      where ${filters.join(" and ")}
    ),
    fills as (
      select
        t.chain_id,
        t.campaign_address,
        t.wallet,
        t.side,
        t.block_time,
        t.block_number,
        t.log_index,
        t.price_bnb,
        t.sold_tokens_after_raw,
        case
          when t.bnb_amount_raw::text ~ '^[0-9]+(\.0+)?$'
            then t.bnb_amount_raw::numeric / case when t.chain_id = 101 then 1e9 else 1e18 end
          else coalesce(t.bnb_amount, 0)
        end as native_amt,
        case
          when t.token_amount_raw::text ~ '^[0-9]+(\.0+)?$'
            then t.token_amount_raw::numeric / case when t.chain_id = 101 then 1e6 else 1e18 end
          else coalesce(t.token_amount, 0)
        end as token_amt
      from public.curve_trades t
      inner join base b
        on b.chain_id = t.chain_id and b.campaign_address = t.campaign_address
    ),
    rt as (
      select
        b.chain_id,
        b.campaign_address,
        coalesce(sum(case when f.side = 'buy' then f.native_amt else -f.native_amt end), 0) as raised_total_bnb,
        coalesce(
          sum(case when f.side = 'buy' then f.native_amt else -f.native_amt end)
            filter (where f.block_time >= now() - interval '10 minutes'),
          0
        ) as raised_10m_bnb,
        coalesce((
          select count(*)::int
          from (
            select f2.wallet
            from fills f2
            where f2.chain_id = b.chain_id and f2.campaign_address = b.campaign_address
            group by f2.wallet
            having sum(case when f2.side = 'buy' then f2.token_amt else -f2.token_amt end) > 0
          ) holders
        ), 0) as holder_count
      from base b
      left join fills f
        on f.chain_id = b.chain_id and f.campaign_address = b.campaign_address
      group by b.chain_id, b.campaign_address
    ),
    trade_stats as (
      select
        b.chain_id,
        b.campaign_address,
        latest.price_bnb as latest_price_bnb,
        coalesce(latest.sold_after, stats.sold_tokens) as indexed_sold_tokens,
        stats.vol_24h_bnb as indexed_vol_24h_bnb,
        case
          -- Solana: last fill price is VWAP, not spot. Keep token_stats mcap
          -- (indexer writes spot × sold). Only fall back to VWAP × sold on EVM.
          when b.chain_id = 101 then null
          when latest.price_bnb is not null then latest.price_bnb * coalesce(latest.sold_after, stats.sold_tokens)
          else null
        end as indexed_marketcap_bnb
      from base b
      left join lateral (
        select f.price_bnb,
          case
            when f.sold_tokens_after_raw::text ~ '^[0-9]+(\.0+)?$'
              then f.sold_tokens_after_raw::numeric
                / case when b.chain_id = 101 then 1e6 else 1e18 end
            else null
          end as sold_after
        from fills f
        where f.chain_id = b.chain_id and f.campaign_address = b.campaign_address
        order by f.block_number desc, f.log_index desc
        limit 1
      ) latest on true
      left join lateral (
        select
          coalesce(sum(case when f.side = 'buy' then f.token_amt else -f.token_amt end), 0) as sold_tokens,
          coalesce(sum(f.native_amt) filter (where f.block_time >= now() - interval '24 hours'), 0) as vol_24h_bnb
        from fills f
        where f.chain_id = b.chain_id and f.campaign_address = b.campaign_address
      ) stats on true
    ),
    ath as (
      select
        b.chain_id,
        b.campaign_address,
        max(tc.h) as ath_price_bnb
      from base b
      left join public.token_candles tc
        on tc.chain_id = b.chain_id
        and tc.campaign_address = b.campaign_address
        and tc.timeframe = '1m'
      group by b.chain_id, b.campaign_address
    ),
    calc as (
      select
        b.*,
        coalesce(trade_stats.latest_price_bnb, b.last_price_bnb) as current_price_bnb,
        coalesce(trade_stats.indexed_sold_tokens, b.sold_tokens) as current_sold_tokens,
        coalesce(trade_stats.indexed_marketcap_bnb, b.marketcap_bnb) as current_marketcap_bnb,
        coalesce(trade_stats.indexed_vol_24h_bnb, b.vol_24h_bnb) as current_vol_24h_bnb,
        rt.raised_total_bnb,
        rt.raised_10m_bnb,
        rt.holder_count,
        case
          when ath.ath_price_bnb is not null and coalesce(trade_stats.indexed_sold_tokens, b.sold_tokens) is not null then ath.ath_price_bnb * coalesce(trade_stats.indexed_sold_tokens, b.sold_tokens)
          else coalesce(trade_stats.indexed_marketcap_bnb, b.marketcap_bnb)
        end as ath_marketcap_bnb,
        ath.ath_price_bnb,
        case
          when $2::numeric <= 0 then null
          else least(100, greatest(0, (rt.raised_total_bnb / $2::numeric) * 100))
        end as progress_pct,
        case
          when rt.raised_total_bnb >= $2::numeric then 0
          when rt.raised_10m_bnb <= 0 then null
          else (($2::numeric - rt.raised_total_bnb) / (rt.raised_10m_bnb / 600.0))
        end as eta_sec,
        (
          coalesce(trade_stats.indexed_vol_24h_bnb, b.vol_24h_bnb, 0) * 1000
          + coalesce(b.votes_24h, 0) * 10
          + coalesce(rt.holder_count, 0) * 2
          + coalesce(b.vote_trending_score, 0)
        ) as trending_score
      from base b
      join rt on rt.chain_id = b.chain_id and rt.campaign_address = b.campaign_address
      left join trade_stats on trade_stats.chain_id = b.chain_id and trade_stats.campaign_address = b.campaign_address
      left join ath on ath.chain_id = b.chain_id and ath.campaign_address = b.campaign_address
    )
    select
      chain_id as "chainId",
      campaign_address as "campaignAddress",
      token_address as "tokenAddress",
      creator_address as "creatorAddress",
      name as "name",
      symbol as "symbol",
      logo_uri as "logoUri",
      created_block as "createdBlock",
      created_at_chain as "createdAtChain",
      graduated_block as "graduatedBlock",
      graduated_at_chain as "graduatedAtChain",
      is_active as "isActive",
      last_activity_at as "lastActivityAt",
      current_price_bnb as "lastPriceBnb",
      current_sold_tokens as "soldTokens",
      current_marketcap_bnb as "marketcapBnb",
      current_vol_24h_bnb as "vol24hBnb",
      holder_count as "holderCount",
      ath_marketcap_bnb as "athMarketcapBnb",
      ath_price_bnb as "athPriceBnb",
      raised_total_bnb as "raisedTotalBnb",
      raised_10m_bnb as "raised10mBnb",
      progress_pct as "progressPct",
      eta_sec as "etaSec",
      votes_24h as "votes24h",
      votes_all_time as "votesAllTime",
      trending_score as "trendingScore",
      $2::numeric as "gradTargetBnb"
    from calc
    order by ${detailAddress ? "chain_id desc, campaign_address asc" : orderByForMode(mode)}
    limit $${params.length}
  `;

  const result = await pool.query(sql, params);
  return result.rows;
}

async function fetchBasicWarRoomRows({ chainIds, mode, search, detailAddress, limit, gradTargetBnb }) {
  const params = [chainIds, gradTargetBnb];
  const filters = ["c.chain_id = any($1::int[])", "c.campaign_address is not null"];
  const searchFilter = buildSearchFilter(search, params);
  const detailFilter = buildDetailFilter(detailAddress, params);
  const modeClause = detailAddress ? null : modeFilter(mode);
  if (searchFilter) filters.push(searchFilter);
  if (detailFilter) filters.push(detailFilter);
  if (modeClause) filters.push(modeClause);
  params.push(limit);

  const result = await pool.query(
    `select
       c.chain_id as "chainId",
       c.campaign_address as "campaignAddress",
       c.token_address as "tokenAddress",
       c.creator_address as "creatorAddress",
       c.name as "name",
       c.symbol as "symbol",
       c.logo_uri as "logoUri",
       c.created_block as "createdBlock",
       c.created_at_chain as "createdAtChain",
       c.graduated_block as "graduatedBlock",
       c.graduated_at_chain as "graduatedAtChain",
       c.is_active as "isActive",
       null::timestamptz as "lastActivityAt",
       null::numeric as "lastPriceBnb",
       null::numeric as "soldTokens",
       null::numeric as "marketcapBnb",
       null::numeric as "vol24hBnb",
       0::numeric as "holderCount",
       null::numeric as "athMarketcapBnb",
       0::numeric as "raisedTotalBnb",
       0::numeric as "raised10mBnb",
       null::numeric as "progressPct",
       null::numeric as "etaSec",
       0::numeric as "votes24h",
       0::numeric as "votesAllTime",
       0::numeric as "trendingScore",
       $2::numeric as "gradTargetBnb"
     from public.campaigns c
     where ${filters.join(" and ")}
     order by ${detailAddress ? "c.chain_id desc, c.campaign_address asc" : mode === "new" ? "c.created_block desc nulls last, c.created_at_chain desc nulls last, c.campaign_address asc" : "c.created_block desc nulls last, c.created_at_chain desc nulls last, c.campaign_address asc"}
     limit $${params.length}`,
    params,
  );
  return result.rows;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);

  try {
    const q = getQuery(req);
    const chainId = toInt(q.chainId, BNB_CHAIN_ID);
    const includeTestnet = testnetCampaignsEnabled(q);
    const chainIds = resolveWarRoomChainIds(chainId, includeTestnet);
    const detailAddress = String(q.campaignAddress || q.campaign || "").trim();
    const mode = normalizeMode(q.mode);
    const search = String(q.search || "").trim();
    const limit = clamp(toInt(q.limit, detailAddress ? 1 : 250), 1, 250);
    const gradTargetBnb = clamp(toFloat(q.gradTargetBnb, DEFAULT_GRAD_TARGET_BNB), 0.0001, 10_000);

    if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });
    if (detailAddress && !chainIds.some((id) => addressLooksValid(detailAddress, id))) {
      return json(res, 400, { error: "Invalid campaign address", campaignAddress: detailAddress, updatedAt: new Date().toISOString() });
    }

    let rows;
    let warning = null;
    try {
      rows = await fetchWarRoomRows({ chainIds, mode, search, detailAddress, limit, gradTargetBnb });
    } catch (richError) {
      console.error("[api/warRoom] rich query failed; trying basic fallback", richError);
      rows = await fetchBasicWarRoomRows({ chainIds, mode, search, detailAddress, limit, gradTargetBnb });
      warning = "War Room is showing basic coin data while live metrics sync.";
    }

    // Solana launchpad coins: market cap and ATH on their post-graduation supply, as the cards show.
    if (rows.some((row) => Number(row.chainId) === 101)) {
      const solUsd = (await resolveSolUsdPrice().catch(() => null))?.price ?? null;
      for (const row of rows) row.chainId = Number(row.chainId);
      await withSolanaLaunchpadMarketCap(rows, solUsd);
    }

    if (detailAddress) {
      if (!rows[0]) return json(res, 404, { error: "War Room campaign detail not found", campaignAddress: detailAddress, updatedAt: new Date().toISOString() });
      const rowChainId = Number(rows[0].chainId || chainId);
      const watchlist = await watchlistState({ chainId: rowChainId, campaignAddress: rows[0].campaignAddress || detailAddress, userAddress: q.userAddress || q.user || q.wallet });
      return json(res, 200, detailPayload(rows[0], watchlist));
    }

    return json(res, 200, {
      items: rows.map(mapWarRoomRow),
      chainIds,
      includeTestnet,
      updatedAt: new Date().toISOString(),
      ...(warning ? { warning } : {}),
    });
  } catch (error) {
    return emptyWarRoom(res, error);
  }
}
