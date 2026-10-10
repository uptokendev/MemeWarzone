import { pool } from "../server/db.js";
import { badMethod, json } from "../server/http.js";
import { publicHiddenOrBlockedWhere } from "./lib/publicHiddenCampaigns.js";

/**
 * GET /api/recruiters/:code/creator-coins (CO-9, founder 2026-10-03)
 * Public recruiter page: how many creators this recruiter brought in and their 5 best coins by
 * market cap. Recruited wallets are never returned (founder: they stay hidden). Same anti-cluster
 * rule as the recruiter summary (a recruiter's own cluster does not count). Read-only.
 */
export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);
  const code = String(req.params?.code || "").trim();
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(code)) return json(res, 400, { error: "Invalid recruiter code" });
  try {
    const { rows: recruiterRows } = await pool.query(
      `select id, wallet_address from public.recruiters where lower(code) = lower($1) limit 1`,
      [code],
    );
    const recruiter = recruiterRows[0];
    if (!recruiter) return json(res, 404, { error: "Recruiter not found" });

    const { rows } = await pool.query(
      `with recruited as (
         select distinct lower(m.wallet_address) as wallet_key, m.wallet_address
           from (
             select s.wallet_address from public.wallet_squad_memberships s
              where s.recruiter_id = $1 and s.is_active = true
             union
             select l.wallet_address from public.wallet_recruiter_links l
              where l.recruiter_id = $1 and l.is_active = true
           ) m
           left join public.wallet_risk_profiles mwr on lower(mwr.wallet_address) = lower(m.wallet_address)
           left join public.wallet_risk_profiles rwr on lower(rwr.wallet_address) = lower($2)
          where lower(m.wallet_address) <> lower($2)
            and not (mwr.cluster_id is not null and rwr.cluster_id is not null and mwr.cluster_id = rwr.cluster_id)
       ),
       coins as (
         select c.chain_id, c.campaign_address, c.token_address, c.name, c.symbol, c.logo_uri,
                c.creator_address, ms.market_cap_usd
           from public.campaigns c
           join recruited r
             on c.creator_address = r.wallet_address or lower(c.creator_address) = r.wallet_key
           left join public.market_stats ms
             on ms.chain_id = c.chain_id and ms.campaign_address = c.campaign_address
          where not (${publicHiddenOrBlockedWhere("c")})
       )
       select (select count(distinct lower(creator_address)) from coins)::int as creator_count,
              chain_id, campaign_address, token_address, name, symbol, logo_uri, market_cap_usd
         from coins
        order by market_cap_usd desc nulls last
        limit 5`,
      [recruiter.id, recruiter.wallet_address || ""],
    );
    return json(res, 200, {
      code,
      creatorsWithCoins: Number(rows[0]?.creator_count || 0),
      coins: rows.map((r) => ({
        chainId: Number(r.chain_id),
        campaignAddress: r.campaign_address,
        tokenAddress: r.token_address,
        name: r.name,
        symbol: r.symbol,
        logoUri: r.logo_uri,
        marketCapUsd: r.market_cap_usd == null ? null : Number(r.market_cap_usd),
      })),
    });
  } catch (e) {
    if (e?.code === "42P01" || e?.code === "42703") return json(res, 200, { code, creatorsWithCoins: 0, coins: [], warning: "schema not ready" });
    console.error("[api/recruiters creator-coins]", e);
    return json(res, 500, { error: "Server error" });
  }
}
