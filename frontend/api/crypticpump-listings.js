/**
 * CrypticPump partner listings for campaign badges.
 * GET  ?chainId=&campaign=  → { listing: null | { listingUrl, ... } }
 * POST body: { chainId, campaignAddress, tokenAddress?, listingUrl, creatorWallet }
 *   Creator must match campaigns.creator_address (or draft creator if no campaign row).
 */
import { pool } from "../server/db.js";
import { badMethod, getQuery, isAddress, json, normalizeAddress, readJson } from "../server/http.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";

const PARTNER = "crypticpump";

function cleanUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // Prefer crypticpump.com but allow partner to use CDN/short links if needed.
    return u.toString().slice(0, 1000);
  } catch {
    return null;
  }
}

function mapRow(row) {
  if (!row) return null;
  return {
    chainId: Number(row.chain_id),
    campaignAddress: String(row.campaign_address || ""),
    tokenAddress: row.token_address ? String(row.token_address) : null,
    partner: String(row.partner || PARTNER),
    listingUrl: String(row.listing_url || ""),
    listedBy: row.listed_by ? String(row.listed_by) : null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

async function resolveCreator(chainId, campaignAddress) {
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `select lower(creator_address) as creator
         from public.campaigns
        where chain_id = $1 and lower(campaign_address) = lower($2)
        limit 1`,
      [chainId, campaignAddress],
    );
    if (rows[0]?.creator) return String(rows[0].creator);
  } catch {
    // fall through
  }
  try {
    const { rows } = await pool.query(
      `select lower(creator_wallet) as creator
         from public.campaign_drafts
        where chain_id = $1
          and (
            lower(coalesce(campaign_address, '')) = lower($2)
            or lower(coalesce(token_address, '')) = lower($2)
          )
        order by updated_at desc nulls last
        limit 1`,
      [chainId, campaignAddress],
    );
    if (rows[0]?.creator) return String(rows[0].creator);
  } catch {
    // fall through
  }
  return null;
}

async function getListing(req, res) {
  const q = getQuery(req);
  const chainId = Number(q.chainId ?? 0);
  const campaign = String(q.campaign ?? q.campaignAddress ?? "").trim();
  if (!Number.isFinite(chainId) || chainId <= 0 || !campaign) {
    return json(res, 400, { error: "chainId and campaign are required" });
  }
  if (!pool) return json(res, 200, { listing: null });

  try {
    const { rows } = await pool.query(
      `select chain_id, campaign_address, token_address, partner, listing_url, listed_by, created_at, updated_at
         from public.campaign_partner_listings
        where chain_id = $1
          and partner = $2
          and lower(campaign_address) = lower($3)
        limit 1`,
      [chainId, PARTNER, campaign],
    );
    return json(res, 200, { listing: mapRow(rows[0] || null) });
  } catch (error) {
    // Table may not exist yet
    if (error?.code === "42P01") return json(res, 200, { listing: null });
    console.error("[crypticpump-listings] GET failed", error);
    return json(res, 503, { error: "Listing lookup unavailable" });
  }
}

async function upsertListing(req, res) {
  const body = await readJson(req);
  const chainId = Number(body.chainId ?? 0);
  const campaignAddress = String(body.campaignAddress ?? body.campaign ?? "").trim();
  const tokenAddress = String(body.tokenAddress ?? body.token ?? "").trim() || null;
  const listingUrl = cleanUrl(body.listingUrl ?? body.url);
  const creatorWalletRaw = String(body.creatorWallet ?? body.walletAddress ?? body.auth?.walletAddress ?? "").trim();

  if (!Number.isFinite(chainId) || chainId <= 0 || !campaignAddress) {
    return json(res, 400, { error: "chainId and campaignAddress are required" });
  }
  if (!listingUrl) {
    return json(res, 400, { error: "A valid listingUrl is required" });
  }
  if (!isAddress(creatorWalletRaw) && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(creatorWalletRaw)) {
    return json(res, 400, { error: "creatorWallet is required" });
  }

  const creatorWallet = isAddress(creatorWalletRaw)
    ? normalizeAddress(creatorWalletRaw, chainId) || creatorWalletRaw.toLowerCase()
    : creatorWalletRaw;

  if (!pool) return json(res, 503, { error: "Database unavailable" });

  const expectedCreator = await resolveCreator(chainId, campaignAddress);
  if (!expectedCreator) {
    return json(res, 404, { error: "Campaign creator could not be resolved.", code: "CREATOR_NOT_FOUND" });
  }

  const session = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: expectedCreator,
    chainId,
    action: "crypticpump-listing",
    routeLabel: "crypticpump-listing",
  });
  if (!session) return;
  if (session.legacy) {
    return json(res, 401, {
      error: "CrypticPump listing writes require a signed wallet session.",
      code: "SIGNATURE_REQUIRED",
    });
  }
  if (String(session.walletAddress).toLowerCase() !== String(expectedCreator).toLowerCase()) {
    return json(res, 403, { error: "Only the campaign creator can attach a CrypticPump listing." });
  }

  try {
    const { rows } = await pool.query(
      `insert into public.campaign_partner_listings (
         chain_id, campaign_address, token_address, partner, listing_url, listed_by, updated_at
       ) values ($1, lower($2), nullif(lower($3), ''), $4, $5, lower($6), now())
       on conflict (chain_id, campaign_address, partner) do update set
         listing_url = excluded.listing_url,
         token_address = coalesce(excluded.token_address, campaign_partner_listings.token_address),
         listed_by = excluded.listed_by,
         updated_at = now()
       returning chain_id, campaign_address, token_address, partner, listing_url, listed_by, created_at, updated_at`,
      [chainId, campaignAddress, tokenAddress || "", PARTNER, listingUrl, session.walletAddress],
    );
    return json(res, 200, { listing: mapRow(rows[0]), ok: true });
  } catch (error) {
    if (error?.code === "42P01") {
      return json(res, 503, {
        error: "Run database/crypticpump_listings.sql in Supabase first.",
        code: "SCHEMA_MISSING",
      });
    }
    console.error("[crypticpump-listings] POST failed", error);
    return json(res, 503, { error: "Could not save listing", detail: String(error?.message || error) });
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") return getListing(req, res);
    if (req.method === "POST") return upsertListing(req, res);
    return badMethod(res);
  } catch (error) {
    console.error("[crypticpump-listings]", error);
    return json(res, 500, { error: "Internal error" });
  }
}
