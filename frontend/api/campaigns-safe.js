import { pool } from "../server/db.js";
import { badMethod, getQuery, json, defaultPublicChainId} from "../server/http.js";

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isMissingSchema(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

function mapCampaignRow(row) {
  const graduatedAt = row.graduated_at_chain ? String(row.graduated_at_chain) : null;
  return {
    chainId: Number(row.chain_id),
    campaignAddress: String(row.campaign_address || "").toLowerCase(),
    tokenAddress: row.token_address ? String(row.token_address).toLowerCase() : null,
    creatorAddress: row.creator_address ? String(row.creator_address).toLowerCase() : null,
    name: row.name ?? null,
    symbol: row.symbol ?? null,
    logoUri: row.logo_uri ?? null,
    createdAtChain: row.created_at_chain ? String(row.created_at_chain) : null,
    graduatedAtChain: graduatedAt,
    isDexTrading: Boolean(graduatedAt),
    isActive: Boolean(row.is_active),
    status: graduatedAt ? "graduated" : row.is_active ? "live" : "ended",
    lastActivityAt: row.created_at_chain ? String(row.created_at_chain) : null,
    lastPriceBnb: null,
    soldTokens: null,
    marketcapBnb: null,
    vol24hBnb: null,
    votes24h: 0,
    votesAllTime: 0,
    raisedTotalBnb: "0",
    raised10mBnb: "0",
    progressPct: null,
    etaSec: null,
    gradTargetBnb: 50,
  };
}

function emptyCampaigns(res, warning) {
  return json(res, 200, {
    items: [],
    nextCursor: null,
    pageSize: 0,
    updatedAt: new Date().toISOString(),
    warning,
  });
}

async function fetchBasicCampaigns({ chainId, limit, cursor, status, search }) {
  const params = [chainId];
  let where = "where c.chain_id = $1 and c.campaign_address is not null";

  if (search) {
    params.push(`%${search}%`);
    where += ` and (c.name ilike $${params.length} or c.symbol ilike $${params.length} or c.campaign_address::text ilike $${params.length} or c.token_address::text ilike $${params.length} or c.creator_address::text ilike $${params.length})`;
  }

  if (status === "live") {
    where += " and c.is_active = true and c.graduated_at_chain is null";
  } else if (status === "graduated") {
    where += " and c.graduated_at_chain is not null";
  } else if (status === "ended") {
    where += " and c.is_active = false and c.graduated_at_chain is null";
  }

  params.push(cursor, limit);

  return pool.query(
    `select
       c.chain_id,
       c.campaign_address,
       c.token_address,
       c.creator_address,
       c.name,
       c.symbol,
       c.logo_uri,
       c.created_at_chain,
       c.graduated_at_chain,
       c.is_active
     from public.campaigns c
     ${where}
     order by c.created_at_chain desc nulls last, c.campaign_address asc
     offset $${params.length - 1}
     limit $${params.length}`,
    params,
  );
}

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);

  try {
    const q = getQuery(req);
    const chainId = toInt(q.chainId, defaultPublicChainId());
    const limit = clamp(toInt(q.limit, 24), 1, 50);
    const cursor = clamp(toInt(q.cursor, 0), 0, 1_000_000);
    const status = String(q.status || "all").toLowerCase();
    const search = String(q.search || "").trim();

    if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });

    const result = await fetchBasicCampaigns({ chainId, limit, cursor, status, search });
    const items = (result.rows || []).map(mapCampaignRow);

    return json(res, 200, {
      items,
      nextCursor: items.length === limit ? cursor + limit : null,
      pageSize: limit,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[api/campaigns-safe] basic campaign query failed", error);
    if (isMissingSchema(error)) {
      return emptyCampaigns(res, "Campaign indexer tables are not available yet.");
    }
    return emptyCampaigns(res, "Campaign feed is temporarily unavailable.");
  }
}
