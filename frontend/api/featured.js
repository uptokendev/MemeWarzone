import { pool } from "../server/db.js";
import { badMethod, getQuery, json } from "../server/http.js";
import { reconcileScheduledDraftLifecycle } from "./dev-fix/scheduled-lifecycle.js";
import { publicHiddenWhere } from "./lib/publicHiddenCampaigns.js";

const SORT_MAP = {
  activity: "last_activity_at",
  trending: "trending_score",
  "24h": "votes_24h",
  "7d": "votes_7d",
  all: "votes_all_time",
};

function safeEmptyFeatured(res, error) {
  console.error("[api/featured] indexer query failed; returning empty featured feed", error);
  return json(res, 200, {
    items: [],
    updatedAt: new Date().toISOString(),
    warning: "Featured campaign indexer data is not available yet.",
  });
}

const LIFECYCLE_SELECT = `
       dl.draft_created_at AS "draftCreatedAt",
       dl.contract_deployed_at AS "contractDeployedAt",
       dl.scheduled_launch_at AS "scheduledLaunchAt",
       COALESCE(dl.scheduled_launch_at, c.created_at_chain) AS "tradingLaunchAt",`;

// Prefer registry metadata (keyed by campaign OR token), then campaigns.logo_uri,
// then Prepare Mode draft logo (matched by campaign OR token address).
const LOGO_URI_SELECT = `
       COALESCE(
         NULLIF(BTRIM(tm.logo_uri), ''),
         NULLIF(BTRIM(c.logo_uri), ''),
         NULLIF(BTRIM(dl.draft_logo_url), '')
       ) AS "logoUri",`;

const LOGO_JOINS = `
      LEFT JOIN LATERAL (
        SELECT m.logo_uri
          FROM public.token_metadata_registry m
         WHERE m.chain_id = c.chain_id
           AND (
             m.campaign_address = c.campaign_address
             OR lower(m.campaign_address) = lower(c.campaign_address)
             OR (
               c.token_address IS NOT NULL
               AND (
                 m.token_address = c.token_address
                 OR lower(m.token_address) = lower(c.token_address)
               )
             )
           )
         ORDER BY
           CASE WHEN lower(m.campaign_address) = lower(c.campaign_address) THEN 0 ELSE 1 END,
           m.id ASC
         LIMIT 1
      ) tm ON true
      LEFT JOIN LATERAL (
        SELECT
          d.created_at AS draft_created_at,
          d.deployed_at AS contract_deployed_at,
          d.scheduled_launch_at,
          d.logo_url AS draft_logo_url
        FROM campaign_drafts d
        WHERE d.chain_id = c.chain_id
          AND (
            (
              d.campaign_address IS NOT NULL
              AND (
                d.campaign_address = c.campaign_address
                OR lower(d.campaign_address) = lower(c.campaign_address)
              )
            )
            OR (
              c.token_address IS NOT NULL
              AND d.token_address IS NOT NULL
              AND (
                d.token_address = c.token_address
                OR lower(d.token_address) = lower(c.token_address)
              )
            )
          )
        ORDER BY
          CASE
            WHEN d.campaign_address IS NOT NULL
             AND lower(d.campaign_address) = lower(c.campaign_address) THEN 0
            ELSE 1
          END,
          d.updated_at DESC
        LIMIT 1
      ) dl ON true`;

const LIFECYCLE_JOIN = LOGO_JOINS;

async function readFeaturedFromVotes({ chainId, sortCol, limit }) {
  const orderByExpr = sortCol === "last_activity_at" ? "ca.last_activity_at" : `va.${sortCol}`;
  const { rows } = await pool.query(
    `SELECT
       va.chain_id AS "chainId",
       va.campaign_address AS "campaignAddress",
       c.token_address AS "tokenAddress",
       c.creator_address AS "creatorAddress",
       c.name AS "name",
       c.symbol AS "symbol",
${LOGO_URI_SELECT}
${LIFECYCLE_SELECT}
       COALESCE(dl.scheduled_launch_at, c.created_at_chain) AS "createdAtChain",
       c.graduated_at_chain AS "graduatedAtChain",
       COALESCE(cc.mcap_c, ts.marketcap_bnb) AS "marketcapBnb",
       COALESCE(va.votes_1h, 0) AS "votes1h",
       COALESCE(va.votes_24h, 0) AS "votes24h",
       COALESCE(va.votes_7d, 0) AS "votes7d",
       COALESCE(va.votes_all_time, 0) AS "votesAllTime",
       COALESCE(va.trending_score, 0) AS "trendingScore",
       va.last_vote_at AS "lastVoteAt",
       ca.last_activity_at AS "lastActivityAt",
       'upvote'::text AS "featuredSource"
     FROM vote_aggregates va
     INNER JOIN campaigns c
       ON c.chain_id = va.chain_id
      AND (
        c.campaign_address = va.campaign_address
        OR (c.token_address is not null AND c.token_address = va.campaign_address)
        OR lower(c.campaign_address) = lower(va.campaign_address)
        OR (c.token_address is not null AND lower(c.token_address) = lower(va.campaign_address))
      )
${LIFECYCLE_JOIN}
     LEFT JOIN token_stats ts
       ON ts.chain_id = c.chain_id
      AND ts.campaign_address = c.campaign_address
     LEFT JOIN LATERAL (
       SELECT tc.mcap_c
       FROM token_candles tc
       WHERE tc.chain_id = c.chain_id
         AND tc.campaign_address = c.campaign_address
         AND tc.timeframe = '5s'
         AND COALESCE(tc.canonical_version, 0) >= 2
         AND tc.mcap_c IS NOT NULL
       ORDER BY tc.bucket_start DESC
       LIMIT 1
     ) cc ON true
     LEFT JOIN campaign_activity ca
       ON ca.chain_id = c.chain_id
      AND ca.campaign_address = c.campaign_address
     WHERE va.chain_id = $1
       AND c.campaign_address IS NOT NULL
       AND c.graduated_at_chain IS NULL
       AND COALESCE(c.is_active, true) = true
       -- Hidden test campaigns stay out of Featured like every other public listing.
       AND NOT ${publicHiddenWhere("c")}
       AND (dl.scheduled_launch_at IS NULL OR dl.scheduled_launch_at <= now())
     ORDER BY ${orderByExpr} DESC NULLS LAST,
       COALESCE(va.votes_24h, 0) DESC,
       COALESCE(va.votes_all_time, 0) DESC,
       COALESCE(dl.scheduled_launch_at, c.created_at_chain) DESC NULLS LAST
     LIMIT $2`,
    [chainId, limit],
  );
  return rows;
}

async function readFeaturedFromCampaigns({ chainId, limit }) {
  const { rows } = await pool.query(
    `SELECT
       c.chain_id AS "chainId",
       c.campaign_address AS "campaignAddress",
       c.token_address AS "tokenAddress",
       c.creator_address AS "creatorAddress",
       c.name AS "name",
       c.symbol AS "symbol",
${LOGO_URI_SELECT}
${LIFECYCLE_SELECT}
       COALESCE(dl.scheduled_launch_at, c.created_at_chain) AS "createdAtChain",
       c.graduated_at_chain AS "graduatedAtChain",
       COALESCE(cc.mcap_c, ts.marketcap_bnb) AS "marketcapBnb",
       0::int AS "votes1h",
       0::int AS "votes24h",
       0::int AS "votes7d",
       0::int AS "votesAllTime",
       0::numeric AS "trendingScore",
       null::timestamptz AS "lastVoteAt",
       COALESCE(dl.scheduled_launch_at, c.created_at_chain) AS "lastActivityAt",
       'campaign_fallback'::text AS "featuredSource"
     FROM campaigns c
${LIFECYCLE_JOIN}
     LEFT JOIN token_stats ts
       ON ts.chain_id = c.chain_id
      AND ts.campaign_address = c.campaign_address
     LEFT JOIN LATERAL (
       SELECT tc.mcap_c
       FROM token_candles tc
       WHERE tc.chain_id = c.chain_id
         AND tc.campaign_address = c.campaign_address
         AND tc.timeframe = '5s'
         AND COALESCE(tc.canonical_version, 0) >= 2
         AND tc.mcap_c IS NOT NULL
       ORDER BY tc.bucket_start DESC
       LIMIT 1
     ) cc ON true
     WHERE c.chain_id = $1
       AND c.campaign_address IS NOT NULL
       AND c.graduated_at_chain IS NULL
       AND COALESCE(c.is_active, true) = true
       -- Hidden test campaigns stay out of Featured like every other public listing.
       AND NOT ${publicHiddenWhere("c")}
       AND (dl.scheduled_launch_at IS NULL OR dl.scheduled_launch_at <= now())
     ORDER BY
       COALESCE(cc.mcap_c, ts.marketcap_bnb, 0) DESC,
       COALESCE(dl.scheduled_launch_at, c.created_at_chain) DESC NULLS LAST,
       c.campaign_address ASC
     LIMIT $2`,
    [chainId, limit],
  );
  return rows;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);

  try {
    const q = getQuery(req);
    const chainId = Number(q.chainId ?? 56);
    const sortKeyRaw = String(q.sort ?? "activity").toLowerCase();
    const sortCol = SORT_MAP[sortKeyRaw] ?? SORT_MAP.activity;
    const limit = Math.max(1, Math.min(50, Number(q.limit ?? 10)));

    if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });

    await reconcileScheduledDraftLifecycle(pool);

    let items = [];
    let warning = null;

    try {
      items = await readFeaturedFromVotes({ chainId, sortCol, limit });
    } catch (error) {
      warning = "Featured UPvote aggregates are unavailable; using live campaign fallback.";
      console.warn("[api/featured] vote aggregate query unavailable; using campaign fallback", error);
    }

    if (!items.length) {
      try {
        items = await readFeaturedFromCampaigns({ chainId, limit });
        if (!warning) warning = "Featured UPvote data is empty; using live campaign fallback.";
      } catch (error) {
        if (warning) console.warn("[api/featured] campaign fallback query failed", error);
        else return safeEmptyFeatured(res, error);
      }
    }

    return json(res, 200, {
      items,
      updatedAt: new Date().toISOString(),
      ...(warning ? { warning } : {}),
    });
  } catch (e) {
    return safeEmptyFeatured(res, e);
  }
}
