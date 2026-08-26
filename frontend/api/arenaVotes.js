import { pool } from "../server/db.js";
import { badMethod, getQuery, json } from "../server/http.js";

function ident(value) {
  return String(value || "").trim();
}

async function namesFor(chainId, token) {
  const native = await pool.query(
    `select name, symbol from public.campaigns
      where chain_id = $1
        and (lower(coalesce(token_address::text, '')) = lower($2) or lower(campaign_address::text) = lower($2))
      order by created_block desc nulls last
      limit 1`,
    [chainId, token],
  );
  if (native.rows[0]) return native.rows[0];
  const imported = await pool.query(
    `select name, symbol from public.arena_token_imports
      where chain_id = $1 and lower(token_address) = lower($2) and status = 'passed'
      limit 1`,
    [chainId, token],
  );
  return imported.rows[0] || { name: null, symbol: null };
}

async function handleFeatured(req, res) {
  const query = getQuery(req);
  const chainId = Number(query.chainId || 0);
  const limit = Math.max(1, Math.min(20, Number(query.limit) || 20));
  const params = [];
  let where = "";
  if (Number.isFinite(chainId) && chainId > 0) {
    params.push(chainId);
    where = `where chain_id = $1`;
  }
  params.push(limit);
  const result = await pool.query(
    `select chain_id, token_address, votes_24h, votes_all_time, updated_at
       from public.arena_vote_aggregates
      ${where}
      order by votes_24h desc, votes_all_time desc, updated_at desc
      limit $${params.length}`,
    params,
  );
  const items = [];
  for (const row of result.rows) {
    const names = await namesFor(row.chain_id, row.token_address);
    items.push({
      chainId: Number(row.chain_id),
      tokenAddress: ident(row.token_address),
      tokenName: String(names.name || names.symbol || "Unknown"),
      symbol: String(names.symbol || "---"),
      votes24h: Number(row.votes_24h || 0),
      votesAllTime: Number(row.votes_all_time || 0),
    });
  }
  return json(res, 200, {
    items,
    updatedAt: new Date().toISOString(),
    votingLive: false,
    warning: "Arena UpVotes ranking is live from the ledger. Paying Arena UpVotes waits on a dedicated treasury.",
  });
}

export default async function handler(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);
  try {
    if (method === "GET" && /\/arena\/votes\/featured$/.test(path)) return handleFeatured(req, res);
    if (path.includes("/arena/votes")) return badMethod(res);
    return json(res, 404, { error: `Unknown arena votes route: ${path}` });
  } catch (error) {
    console.error("[api/arenaVotes]", error);
    return json(res, 200, {
      items: [],
      updatedAt: new Date().toISOString(),
      votingLive: false,
      warning: "Arena vote data is unavailable.",
    });
  }
}
