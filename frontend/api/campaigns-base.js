import { pool } from "../server/db.js";
import { badMethod, getQuery, json, defaultPublicChainId} from "../server/http.js";
import { nativeGraduationTarget } from "../src/lib/feedGraduationTarget.mjs";
import { resolveSolUsdPrice } from "./lib/solUsdPrice.js";

// LaunchFactory default graduation target is 50 BNB (see contracts/LaunchFactory.sol).
// Campaigns can override this, but until we persist per-campaign targets in DB,
// we treat this as the system default for progress/ETA on the homepage.
const DEFAULT_GRAD_TARGET_BNB = 50;
const SOLANA_CHAIN_IDS = new Set([101, 102]);
const NON_DEX_MARKET_STAGES = new Set(["BONDING", "LIVE", "ENDED"]);
const DEX_MARKET_STAGE_SQL = "coalesce(cms.market_stage, c.market_stage)";
const DEX_POOL_SQL = "coalesce(cms.dex_pair_address, c.meta->'solanaGraduation'->>'pool')";
const DEX_POSITION_SQL = "c.meta->'solanaGraduation'->>'position'";
const DEX_TRADING_SQL = `(
  c.graduated_at_chain is not null
  or ${DEX_POOL_SQL} is not null
  or ${DEX_POSITION_SQL} is not null
  or (
    ${DEX_MARKET_STAGE_SQL} is not null
    and upper(${DEX_MARKET_STAGE_SQL}) not in ('BONDING', 'LIVE', 'ENDED')
  )
)`;

function toInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toFloat(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeTab(v) {
  const t = String(v || "trending").toLowerCase();
  return t === "new" || t === "ending" || t === "dex" ? t : "trending";
}

function normalizeSort(v) {
  const s = String(v || "default").toLowerCase();
  return [
    "default",
    "created_desc",
    "created_asc",
    "mcap_desc",
    "mcap_asc",
    "votes_desc",
    "holders_desc",
    "volume_desc",
    "progress_desc",
  ].includes(s)
    ? s
    : "default";
}

function normalizeStatus(v) {
  const s = String(v || "all").toLowerCase();
  return s === "live" || s === "graduated" || s === "ended" ? s : "all";
}

function normalizeOutputAddress(value, chainId) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return SOLANA_CHAIN_IDS.has(Number(chainId)) ? raw : raw.toLowerCase();
}

function normalizeMarketStage(value) {
  const stage = String(value ?? "").trim();
  return stage || null;
}

function isDexTradingMarketStage(stage) {
  return Boolean(stage && !NON_DEX_MARKET_STAGES.has(String(stage).trim().toUpperCase()));
}

function deriveDexTradingState(row, chainId) {
  const marketStage = normalizeMarketStage(row.market_stage);
  const dexPool = row.dex_pool ? normalizeOutputAddress(row.dex_pool, chainId) : null;
  const dexPosition = row.dex_position ? normalizeOutputAddress(row.dex_position, chainId) : null;
  const isDexTrading = Boolean(
    row.graduated_at_chain || dexPool || dexPosition || isDexTradingMarketStage(marketStage),
  );
  return { marketStage, dexPool, dexPosition, isDexTrading };
}

function solanaFieldsFromMeta(meta, chainId) {
  if (!SOLANA_CHAIN_IDS.has(Number(chainId))) return null;
  const solana = meta && typeof meta === "object" ? meta.solana : null;
  if (!solana || typeof solana !== "object") return null;
  const tokenVault = String(solana.tokenVault || "").trim() || null;
  const solVault = String(solana.solVault || "").trim() || null;
  const campaignIdHex = String(solana.campaignIdHex || solana.campaignId || "")
    .replace(/^0x/i, "")
    .trim()
    .toLowerCase();
  const programId = String(solana.programId || "").trim() || null;
  if (!tokenVault && !solVault && !campaignIdHex) return null;
  return {
    tokenVault,
    solVault,
    campaignIdHex: /^[0-9a-f]{64}$/.test(campaignIdHex) ? campaignIdHex : null,
    programId,
  };
}

function mapCampaignRow(row, gradTargetBnb) {
  const chainId = Number(row.chain_id);
  const campaignAddress = normalizeOutputAddress(row.campaign_address, chainId);
  const graduatedAt = row.graduated_at_chain ? String(row.graduated_at_chain) : null;
  const solana = solanaFieldsFromMeta(row.meta, chainId);
  const { marketStage, dexPool, dexPosition, isDexTrading } = deriveDexTradingState(row, chainId);

  return {
    chainId,
    campaignAddress,
    tokenAddress: row.token_address ? normalizeOutputAddress(row.token_address, chainId) : null,
    creatorAddress: row.creator_address ? normalizeOutputAddress(row.creator_address, chainId) : null,
    name: row.name ?? null,
    symbol: row.symbol ?? null,
    logoUri: row.logo_uri ?? null,
    website: row.website ?? null,
    xAccount: row.x_account ?? null,
    extraLink: row.extra_link ?? null,
    createdAtChain: row.created_at_chain ? String(row.created_at_chain) : null,
    graduatedAtChain: graduatedAt,
    marketStage,
    dexPool,
    dexPosition,
    isDexTrading,

    // canonical status (useful for UI)
    isActive: Boolean(row.is_active),
    status: isDexTrading ? "graduated" : row.is_active ? "live" : "ended",

    // stats, present in rich mode and null/zero in basic fallback mode
    lastActivityAt: row.last_activity_at ? String(row.last_activity_at) : null,
    lastPriceBnb: row.last_price_bnb != null ? String(row.last_price_bnb) : null,
    soldTokens: row.sold_tokens != null ? String(row.sold_tokens) : null,
    marketcapBnb: row.marketcap_bnb != null ? String(row.marketcap_bnb) : null,
    vol24hBnb: row.vol_24h_bnb != null ? String(row.vol_24h_bnb) : null,
    holderCount: row.holder_count != null ? Number(row.holder_count) : 0,
    athMarketcapBnb: row.ath_marketcap_bnb != null ? String(row.ath_marketcap_bnb) : null,
    votes24h: row.votes_24h != null ? Number(row.votes_24h) : 0,
    votesAllTime: row.votes_all_time != null ? Number(row.votes_all_time) : 0,

    // derived, present in rich mode and safe defaults in basic fallback mode
    raisedTotalBnb: row.raised_total_bnb != null ? String(row.raised_total_bnb) : "0",
    raised10mBnb: row.raised_10m_bnb != null ? String(row.raised_10m_bnb) : "0",
    progressPct: row.progress_pct != null ? Number(row.progress_pct) : null,
    etaSec: row.eta_sec != null ? Number(row.eta_sec) : null,
    gradTargetBnb,

    // Solana V4 bonding vaults (from campaigns.meta.solana) — used by trade-authorize.
    ...(solana
      ? {
          tokenVault: solana.tokenVault,
          solVault: solana.solVault,
          campaignIdHex: solana.campaignIdHex,
          solanaProgramId: solana.programId,
        }
      : {}),
  };
}

function campaignPayload(rows, { limit, cursor, gradTargetBnb, warning = null }) {
  const items = (rows || []).map((row) => mapCampaignRow(row, gradTargetBnb));
  return {
    items,
    nextCursor: items.length === limit ? cursor + limit : null,
    pageSize: limit,
    updatedAt: new Date().toISOString(),
    ...(warning ? { warning } : {}),
  };
}

async function fetchBasicCampaignRows({ chainId, limit, cursor, effectiveStatus, searchRaw, tab, sort }) {
  const params = [chainId];
  let where = "where c.chain_id = $1 and c.campaign_address is not null";

  if (searchRaw) {
    params.push(`%${searchRaw}%`);
    where += ` and (c.name ilike $${params.length} or c.symbol ilike $${params.length} or c.campaign_address::text ilike $${params.length} or c.token_address::text ilike $${params.length} or c.creator_address::text ilike $${params.length})`;
  }

  if (effectiveStatus === "live") {
    where += ` and c.is_active = true and not ${DEX_TRADING_SQL}`;
  } else if (effectiveStatus === "graduated") {
    where += ` and ${DEX_TRADING_SQL}`;
  } else if (effectiveStatus === "ended") {
    where += ` and c.is_active = false and not ${DEX_TRADING_SQL}`;
  }

  const orderBy = (() => {
    if (sort === "created_asc") return "c.created_block asc nulls last, c.created_at_chain asc nulls last, c.campaign_address asc";
    if (tab === "dex") return "c.graduated_block desc nulls last, c.graduated_at_chain desc nulls last, c.created_block desc nulls last, c.campaign_address asc";
    return "c.created_block desc nulls last, c.created_at_chain desc nulls last, c.campaign_address asc";
  })();

  params.push(cursor, limit);

  return pool.query(
    `select
       c.chain_id,
       c.campaign_address,
       c.token_address,
       c.creator_address,
       c.name,
       c.symbol,
       coalesce(
         nullif(btrim(c.logo_uri), ''),
         nullif(btrim(dl.draft_logo_url), '')
       ) as logo_uri,
       null::text as website,
       null::text as x_account,
       null::text as extra_link,
       c.created_block,
       c.created_at_chain,
       c.graduated_block,
       c.graduated_at_chain,
       c.is_active,
       c.meta,
       ${DEX_MARKET_STAGE_SQL} as market_stage,
       ${DEX_POOL_SQL} as dex_pool,
       ${DEX_POSITION_SQL} as dex_position,
       null::numeric as last_price_bnb,
       null::numeric as sold_tokens,
       null::numeric as marketcap_bnb,
       null::numeric as vol_24h_bnb,
       null::numeric as holder_count,
       null::numeric as ath_marketcap_bnb,
       null::timestamptz as last_activity_at,
       0::numeric as votes_24h,
       0::numeric as votes_all_time,
       0::numeric as raised_total_bnb,
       0::numeric as raised_10m_bnb,
       null::numeric as progress_pct,
       null::numeric as eta_sec
     from public.campaigns c
     left join public.campaign_market_state cms
       on cms.chain_id = c.chain_id and cms.campaign_address = c.campaign_address
     left join lateral (
       select d.logo_url as draft_logo_url
         from public.campaign_drafts d
        where d.chain_id = c.chain_id
          and (
            (
              d.campaign_address is not null
              and lower(d.campaign_address) = lower(c.campaign_address)
            )
            or (
              c.token_address is not null
              and d.token_address is not null
              and lower(d.token_address) = lower(c.token_address)
            )
          )
        order by
          case
            when d.campaign_address is not null
             and lower(d.campaign_address) = lower(c.campaign_address) then 0
            else 1
          end,
          d.updated_at desc
        limit 1
     ) dl on true
     ${where}
     order by ${orderBy}
     offset $${params.length - 1}
     limit $${params.length}`,
    params,
  );
}

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);

  const q = getQuery(req);

  const chainId = toInt(q.chainId, defaultPublicChainId());
  // TokenDetails intentionally requests a large enough page to locate a token by address.
  // Keep this capped, but do not silently crush limit=500 down to 50.
  const limit = clamp(toInt(q.limit, 24), 1, 500);
  const cursor = clamp(toInt(q.cursor, 0), 0, 1_000_000); // offset-based pagination

  const tab = normalizeTab(q.tab);
  const sort = normalizeSort(q.sort);
  const status = normalizeStatus(q.status);

  // Contract rule:
  // - /api/campaigns defaults to "all"
  // - "Ending Soon" is always Live-only
  // - "Trading on DEX" is always Graduated-only
  const effectiveStatus = tab === "ending" ? "live" : tab === "dex" ? "graduated" : status;
  const searchRaw = String(q.search || "").trim();
  const search = searchRaw ? `%${searchRaw}%` : null;

  // Optional filters
  const bnbUsd = Number.isFinite(Number(q.bnbUsd)) ? toFloat(q.bnbUsd, NaN) : null;
  const mcapMinUsd = Number.isFinite(Number(q.mcapMinUsd)) ? toFloat(q.mcapMinUsd, NaN) : null;
  const mcapMaxUsd = Number.isFinite(Number(q.mcapMaxUsd)) ? toFloat(q.mcapMaxUsd, NaN) : null;
  const progressMinPct = Number.isFinite(Number(q.progressMinPct)) ? toFloat(q.progressMinPct, NaN) : null;
  const progressMaxPct = Number.isFinite(Number(q.progressMaxPct)) ? toFloat(q.progressMaxPct, NaN) : null;

  let gradTargetBnb = clamp(toFloat(q.gradTargetBnb, DEFAULT_GRAD_TARGET_BNB), 0.0001, 10_000);
  if (SOLANA_CHAIN_IDS.has(chainId) && q.gradTargetBnb == null) {
    // No price must never fail the list: progress is then shown as unknown, not 500.
    const sol = await resolveSolUsdPrice().catch(() => null);
    const native = nativeGraduationTarget({ chainId, nativeUsd: sol?.price, suppliedTarget: 50 });
    gradTargetBnb = Number.isFinite(native) && native > 0 ? native : null;
  }

  try {
    // Deterministic ordering per tab/sort.
    // IMPORTANT: the outer query selects from the CTE `calc`.
    // So ORDER BY must only reference columns available on `calc`.
    const orderBy = (() => {
      if (sort === "created_desc") return "calc.created_block desc, calc.campaign_address asc";
      if (sort === "created_asc") return "calc.created_block asc, calc.campaign_address asc";
      if (sort === "mcap_desc") return "coalesce(calc.marketcap_bnb, 0) desc, calc.created_block desc, calc.campaign_address asc";
      if (sort === "mcap_asc") return "coalesce(calc.marketcap_bnb, 0) asc, calc.created_block desc, calc.campaign_address asc";
      if (sort === "holders_desc") return "coalesce(calc.holder_count, 0) desc, calc.created_block desc, calc.campaign_address asc";
      if (sort === "volume_desc") return "coalesce(calc.vol_24h_bnb, 0) desc, calc.created_block desc, calc.campaign_address asc";
      if (sort === "votes_desc") return "coalesce(calc.votes_24h, 0) desc, calc.created_block desc, calc.campaign_address asc";
      if (sort === "progress_desc") return "coalesce(calc.progress_pct, -1) desc, calc.created_block desc, calc.campaign_address asc";

      // Tab defaults
      if (tab === "new") return "calc.created_block desc, calc.campaign_address asc";
      if (tab === "ending")
        return "calc.eta_sec asc nulls last, calc.progress_pct desc nulls last, calc.created_block desc, calc.campaign_address asc";
      if (tab === "dex") return "calc.graduated_block desc nulls last, calc.created_block desc, calc.campaign_address asc";

      // trending default
      return "calc.trending_score desc nulls last, calc.created_block desc, calc.campaign_address asc";
    })();

    const sql = `
      with base as (
        select
          c.chain_id,
          c.campaign_address,
          c.token_address,
          c.creator_address,
          c.name,
          c.symbol,
          coalesce(
            nullif(btrim(tm.logo_uri), ''),
            nullif(btrim(c.logo_uri), ''),
            nullif(btrim(dl.draft_logo_url), '')
          ) as logo_uri,
          tm.website,
          tm.x_account,
          coalesce(tm.metadata ->> 'extraLink', tm.metadata ->> 'extra_link') as extra_link,
          c.created_block,
          c.created_at_chain,
          c.graduated_block,
          c.graduated_at_chain,
          c.is_active,
          c.meta,
          ${DEX_MARKET_STAGE_SQL} as market_stage,
          ${DEX_POOL_SQL} as dex_pool,
          ${DEX_POSITION_SQL} as dex_position,
          coalesce(cc.price_c, ts.last_price_bnb) as last_price_bnb,
          ts.sold_tokens,
          coalesce(cc.mcap_c, ts.marketcap_bnb) as marketcap_bnb,
          ts.vol_24h_bnb,
          va.votes_24h,
          va.votes_all_time
        from public.campaigns c
        left join public.campaign_market_state cms
          on cms.chain_id = c.chain_id and cms.campaign_address = c.campaign_address
        left join public.token_stats ts
          on ts.chain_id = c.chain_id and ts.campaign_address = c.campaign_address
        left join lateral (
          select tc.price_c, tc.mcap_c
          from public.token_candles tc
          where tc.chain_id = c.chain_id
            and tc.campaign_address = c.campaign_address
            and tc.timeframe = '5s'
            and coalesce(tc.canonical_version, 0) >= 2
            and tc.price_c is not null
            and tc.mcap_c is not null
          order by tc.bucket_start desc
          limit 1
        ) cc on true
        left join lateral (
          select
            m.logo_uri,
            m.website,
            m.x_account,
            m.metadata
          from public.token_metadata_registry m
          where m.chain_id = c.chain_id
            and (
              lower(m.campaign_address) = lower(c.campaign_address)
              or lower(m.token_address) = lower(c.token_address)
            )
          order by
            case when lower(m.campaign_address) = lower(c.campaign_address) then 0 else 1 end,
            m.id asc
          limit 1
        ) tm on true
        left join lateral (
          select d.logo_url as draft_logo_url
            from public.campaign_drafts d
           where d.chain_id = c.chain_id
             and (
               (
                 d.campaign_address is not null
                 and lower(d.campaign_address) = lower(c.campaign_address)
               )
               or (
                 c.token_address is not null
                 and d.token_address is not null
                 and lower(d.token_address) = lower(c.token_address)
               )
             )
           order by
             case
               when d.campaign_address is not null
                and lower(d.campaign_address) = lower(c.campaign_address) then 0
               else 1
             end,
             d.updated_at desc
           limit 1
        ) dl on true
        left join public.vote_aggregates va
          on va.chain_id = c.chain_id
         and (
           va.campaign_address = c.campaign_address
           or (c.token_address is not null and va.campaign_address = c.token_address)
           or lower(va.campaign_address) = lower(c.campaign_address)
           or (c.token_address is not null and lower(va.campaign_address) = lower(c.token_address))
         )
        where c.chain_id = $1
          and ($3::text is null or (
            c.name ilike $3
            or c.symbol ilike $3
            or c.campaign_address::text ilike $3
            or c.token_address::text ilike $3
            or c.creator_address::text ilike $3
          ))
          and (
            $4::text = 'all'
            or ($4::text = 'live' and c.is_active = true and not ${DEX_TRADING_SQL})
            or ($4::text = 'graduated' and ${DEX_TRADING_SQL})
            or ($4::text = 'ended' and c.is_active = false and not ${DEX_TRADING_SQL})
          )
          and (
            $5::text <> 'dex'
            or ${DEX_TRADING_SQL}
          )
      ),
      rt as (
        select
          b.chain_id,
          b.campaign_address,
          coalesce(
            sum(case when t.side = 'buy' then t.bnb_amount else -t.bnb_amount end)
            ,0
          ) as raised_total_bnb,
          coalesce(
            sum(case when t.side = 'buy' then t.bnb_amount else -t.bnb_amount end)
              filter (where t.block_time >= now() - interval '10 minutes')
            ,0
          ) as raised_10m_bnb,
          coalesce(count(distinct t.wallet) filter (where t.side = 'buy'), 0) as holder_count
        from base b
        left join public.curve_trades t
          on t.chain_id = b.chain_id and t.campaign_address = b.campaign_address
        group by b.chain_id, b.campaign_address
      ),
      ath as (
        select
          b.chain_id,
          b.campaign_address,
          max(tc.h) as ath_price_bnb,
          max(tc.mcap_h) as ath_marketcap_bnb
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
          rt.raised_total_bnb,
          rt.raised_10m_bnb,
          rt.holder_count,
          coalesce(
            ath.ath_marketcap_bnb,
            case when ath.ath_price_bnb is not null and b.sold_tokens is not null then ath.ath_price_bnb * b.sold_tokens end,
            b.marketcap_bnb
          ) as ath_marketcap_bnb,
          case
            when $2::numeric is null or $2::numeric <= 0 then null
            else least(100, greatest(0, (rt.raised_total_bnb / $2::numeric) * 100))
          end as progress_pct,
          case
            when rt.raised_total_bnb >= $2::numeric then 0
            when rt.raised_10m_bnb <= 0 then null
            else (
              ($2::numeric - rt.raised_total_bnb)
              / (rt.raised_10m_bnb / 600.0)
            )
          end as eta_sec,
          (
            coalesce(b.vol_24h_bnb, 0) * 1000
            + coalesce(b.votes_24h, 0) * 10
            + coalesce(rt.holder_count, 0) * 2
          ) as trending_score
        from base b
        join rt
          on rt.chain_id = b.chain_id and rt.campaign_address = b.campaign_address
        left join ath
          on ath.chain_id = b.chain_id and ath.campaign_address = b.campaign_address
      )
      select *
      from calc
      where 1=1
        and (
          $9::numeric is null
          or calc.progress_pct >= $9::numeric
        )
        and (
          $10::numeric is null
          or calc.progress_pct <= $10::numeric
        )
        and (
          $6::numeric is null
          or $7::numeric is null
          or (calc.marketcap_bnb is not null and (calc.marketcap_bnb * $6::numeric) >= $7::numeric)
        )
        and (
          $6::numeric is null
          or $8::numeric is null
          or (calc.marketcap_bnb is not null and (calc.marketcap_bnb * $6::numeric) <= $8::numeric)
        )
      order by ${orderBy}
      offset $11
      limit $12
    `;

    const r = await pool.query(sql, [
      chainId,
      gradTargetBnb,
      search,
      effectiveStatus,
      tab,
      bnbUsd,
      mcapMinUsd,
      mcapMaxUsd,
      progressMinPct,
      progressMaxPct,
      cursor,
      limit,
    ]);

    return json(res, 200, campaignPayload(r.rows, { limit, cursor, gradTargetBnb }));
  } catch (e) {
    console.error("[api/campaigns] rich campaign query failed; trying basic fallback", e);

    try {
      const fallback = await fetchBasicCampaignRows({
        chainId,
        limit,
        cursor,
        effectiveStatus,
        searchRaw,
        tab,
        sort,
      });

      return json(
        res,
        200,
        campaignPayload(fallback.rows, {
          limit,
          cursor,
          gradTargetBnb,
          warning: "Campaign feed returned basic data because rich stats are temporarily unavailable.",
        }),
      );
    } catch (fallbackError) {
      console.error("[api/campaigns] basic campaign fallback failed", fallbackError);
      return json(res, 200, {
        items: [],
        nextCursor: null,
        pageSize: 0,
        updatedAt: new Date().toISOString(),
        warning: "Campaign feed is temporarily unavailable.",
      });
    }
  }
}
