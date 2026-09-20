import { pool } from "../server/db.js";
import { badMethod, getQuery, json, defaultPublicChainId} from "../server/http.js";

/**
 * Sponsored placements feed.
 *
 * Default (Arena rail — DO NOT break):
 *   GET /api/sponsored?chainId=97&limit=8
 *   → ordered list of active paid placements (all slots unless filtered)
 *
 * Featured top-left (additive):
 *   GET /api/sponsored?chainId=97&slot=featured-top-left&select=one&strategy=weighted
 *   → single weighted-random pick from that slot pool (page-load rotation)
 *
 * House "Advertise here" for Featured:
 *   - Only injected when house inventory is enabled (DB setting or env)
 *   - Never competes with live paid/partner inventory (paid ads always win exclusivity)
 *   - When house is disabled and inventory is empty, returns empty items
 *
 * Battle/postgrad rails continue to call without select=one.
 */

const FEATURED_SLOT = "featured-top-left";
const RAIL_SLOT = "homepage-sponsored-rail";
const HOUSE_SETTING_KEY = "featured_house_ad";
const LIVE_PAYMENT_STATUSES = ["paid", "verified", "waived"];

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function normSlot(value) {
  const s = String(value || "").trim().toLowerCase();
  return s || "";
}

function rotationWeight(item) {
  const explicit = Number(item.rotationWeight ?? item.rotation_weight);
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(10_000, Math.trunc(explicit));
  // Higher priority number = more featured exposure (ops-friendly tiers: 1000 base, 2000 2x).
  const p = Number(item.placementPriority ?? item.priority ?? 1000);
  if (!Number.isFinite(p)) return 1;
  return Math.max(1, Math.min(10_000, Math.trunc(p)));
}

function pickWeighted(items) {
  if (!items.length) return null;
  let total = 0;
  const weights = items.map((item) => {
    const w = rotationWeight(item);
    total += w;
    return w;
  });
  if (total <= 0) return items[0];
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i += 1) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const v = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

/** Always-on house inventory so Featured can fill an empty sponsor cell when enabled. */
function featuredHouseAd(chainId) {
  const weight = Math.max(1, Number(process.env.FEATURED_HOUSE_AD_WEIGHT || 1000) || 1000);
  return {
    id: "house-advertise-featured",
    chainId,
    campaignAddress: "house-advertise-featured",
    name: "Advertise here",
    symbol: "ADS",
    logoUri: "/assets/memewarzone.png",
    imageUrl: "/assets/memewarzone.png",
    isActive: true,
    placementType: "house",
    placementLabel: "Open spot",
    placementPriority: weight,
    rotationWeight: weight,
    slotCode: FEATURED_SLOT,
    targetUrl: null,
    websiteUrl: null,
    bio: "Put your project in Featured. Apply for a rotating sponsorship slot.",
    isHouseAd: true,
  };
}

function isHouseItem(item) {
  return (
    Boolean(item?.isHouseAd) ||
    String(item?.id || "") === "house-advertise-featured" ||
    String(item?.placementType || "") === "house"
  );
}

function isChainAgnosticPlacement(item) {
  const type = String(item?.placementType || item?.project_type || "").toLowerCase();
  if (["external", "partner", "featured"].includes(type)) return true;
  // Website-backed / synthetic campaign keys are not on-chain campaign addresses.
  const campaign = String(item?.campaignAddress || "").trim().toLowerCase();
  if (!campaign) return true;
  if (campaign.startsWith("http://") || campaign.startsWith("https://")) return true;
  if (campaign.startsWith("sponsored-placement-")) return true;
  return false;
}

function matchesChain(item, chainId) {
  if (isChainAgnosticPlacement(item)) return true;
  const itemChain = Number(item.chainId ?? item.chain_id);
  if (!Number.isFinite(itemChain)) return true;
  return itemChain === Number(chainId);
}

let settingsTableEnsured = false;

async function ensureSponsorshipSettingsTable() {
  if (settingsTableEnsured || !pool) return;
  try {
    await pool.query(`
      create table if not exists public.sponsorship_settings (
        key text primary key,
        value jsonb not null default '{}'::jsonb,
        updated_at timestamptz not null default now()
      )
    `);
    await pool.query(
      `insert into public.sponsorship_settings (key, value)
       values ($1, jsonb_build_object('enabled', true))
       on conflict (key) do nothing`,
      [HOUSE_SETTING_KEY],
    );
    settingsTableEnsured = true;
  } catch (error) {
    console.warn("[api/sponsored] ensure sponsorship_settings failed", error?.message || error);
  }
}

/**
 * House ad enablement:
 * 1) Env FEATURED_HOUSE_AD_ENABLED forces on/off when set
 * 2) Else DB sponsorship_settings.featured_house_ad.enabled
 * 3) Else default true (empty inventory can still show Advertise here)
 */
async function isFeaturedHouseAdEnabled() {
  if (Object.prototype.hasOwnProperty.call(process.env, "FEATURED_HOUSE_AD_ENABLED")) {
    return envBool("FEATURED_HOUSE_AD_ENABLED", true);
  }

  try {
    await ensureSponsorshipSettingsTable();
    const result = await pool.query(
      `select value
         from public.sponsorship_settings
        where key = $1
        limit 1`,
      [HOUSE_SETTING_KEY],
    );
    const value = result.rows[0]?.value;
    if (value && typeof value === "object" && value.enabled != null) {
      return Boolean(value.enabled);
    }
    if (typeof value === "boolean") return value;
  } catch (error) {
    // Table may not exist until migration is applied — fall through to default.
    if (String(error?.code || "") !== "42P01") {
      console.warn("[api/sponsored] sponsorship_settings read failed", error?.message || error);
    }
  }

  return true;
}

/**
 * Inject house ad only for featured-top-left when:
 * - house inventory is enabled, AND
 * - there are no live paid/partner placements in the pool.
 * Paid inventory is exclusive: house never steals rotation from real ads.
 */
function withFeaturedHouseAd(items, chainId, slotFilter, houseEnabled) {
  if (slotFilter !== FEATURED_SLOT) return items;
  const paid = (items || []).filter((item) => !isHouseItem(item));
  if (paid.length > 0) return paid;
  if (!houseEnabled) return [];
  return [featuredHouseAd(chainId)];
}

function externalPlacements(chainId, slotFilter) {
  const raw = String(process.env.SPONSORED_PLACEMENTS_JSON || process.env.VITE_SPONSORED_PLACEMENTS_JSON || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];
    return items
      .filter((item) => item && (item.chainId == null || Number(item.chainId) === Number(chainId) || isChainAgnosticPlacement(item)))
      .map((item, index) => {
        const slotCode = String(item.slotCode || item.slot_code || item.slot || RAIL_SLOT).trim();
        return {
          id: item.id || `external-${index}`,
          chainId: item.chainId ?? chainId,
          campaignAddress: String(item.campaignAddress || item.campaign || `external-sponsored-${index}`),
          tokenAddress: item.tokenAddress ?? null,
          creatorAddress: item.creatorAddress ?? null,
          name: String(item.name || item.title || "Sponsored project"),
          symbol: String(item.symbol || item.ticker || "SPON"),
          logoUri: item.logoUri || item.logoURI || item.logoUrl || item.imageUrl || null,
          imageUrl: item.imageUrl || item.logoUri || item.logoURI || item.logoUrl || null,
          isActive: true,
          marketcapBnb: Number(item.marketcapBnb || 0),
          vol24hBnb: Number(item.vol24hBnb || item.volumeBnb || 0),
          holderCount: Number(item.holderCount || 0),
          raisedTotalBnb: Number(item.raisedTotalBnb || 0),
          votes24h: Number(item.votes24h || 0),
          votesAllTime: Number(item.votesAllTime || 0),
          placementType: String(item.placementType || item.project_type || "external"),
          placementLabel: String(item.placementLabel || item.slotLabel || "Sponsored"),
          placementPriority: Number(item.priority || 1000 + index),
          rotationWeight: Number(item.rotationWeight || item.priority || 1000 + index),
          slotCode,
          targetUrl: item.targetUrl || item.url || item.websiteUrl || null,
          startsAt: item.startsAt || null,
          endsAt: item.endsAt || null,
          bio: item.bio || item.summary || item.description || null,
          websiteUrl: item.websiteUrl || item.targetUrl || item.url || null,
        };
      })
      .filter((item) => !slotFilter || normSlot(item.slotCode) === slotFilter);
  } catch (error) {
    console.warn("[api/sponsored] invalid SPONSORED_PLACEMENTS_JSON", error);
    return [];
  }
}

async function dbPlacements(limit, slotFilter) {
  const params = [limit];
  let slotClause = "";
  if (slotFilter) {
    params.push(slotFilter);
    slotClause = ` and lower(coalesce(sp.slot_code, sa.preferred_slot, '${RAIL_SLOT}')) = lower($${params.length})`;
  }

  const paymentList = LIVE_PAYMENT_STATUSES.map((s) => `'${s}'`).join(", ");

  const result = await pool.query(
    `select
       sp.id::text as "id",
       coalesce(sp.chain_id, 97) as "chainId",
       coalesce(sp.campaign_address, sp.website_url, sa.website_url, concat('sponsored-placement-', sp.id)) as "campaignAddress",
       sp.token_address as "tokenAddress",
       sp.creator_address as "creatorAddress",
       coalesce(sp.project_name, sa.project_name, 'Sponsored project') as "name",
       coalesce(sp.symbol, '') as "symbol",
       coalesce(sp.image_url, sa.image_url) as "logoUri",
       coalesce(sp.image_url, sa.image_url) as "imageUrl",
       coalesce(sp.active, false) as "isActive",
       coalesce(sp.updated_at, sp.created_at, sa.updated_at, sa.created_at) as "lastActivityAt",
       coalesce(sp.project_type, 'external') as "placementType",
       coalesce(sp.placement_label, sp.slot_code, sa.preferred_slot, 'Homepage rail') as "placementLabel",
       coalesce(sp.priority, 1000) as "placementPriority",
       coalesce(sp.priority, 1000) as "rotationWeight",
       lower(coalesce(sp.slot_code, sa.preferred_slot, '${RAIL_SLOT}')) as "slotCode",
       coalesce(sp.target_url, sp.website_url, sa.website_url) as "targetUrl",
       sp.starts_at as "startsAt",
       sp.ends_at as "endsAt",
       coalesce(sp.bio, sa.bio) as "bio",
       coalesce(sp.website_url, sa.website_url) as "websiteUrl"
     from public.sponsored_placements sp
     left join public.sponsorship_applications sa on sa.id = sp.application_id
     where coalesce(sp.active, false) = true
       and coalesce(sp.payment_status, 'pending') in (${paymentList})
       and (sp.starts_at is null or sp.starts_at <= now())
       and (sp.ends_at is null or sp.ends_at >= now())
       ${slotClause}
     order by coalesce(sp.priority, 1000) asc, sp.starts_at asc nulls first, sp.created_at desc nulls last
     limit $1`,
    params,
  );
  return result.rows;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);

  const q = getQuery(req);
  const chainId = toInt(q.chainId, defaultPublicChainId());
  const limit = clamp(toInt(q.limit, 8), 1, 24);
  const slotFilter = normSlot(q.slot || q.slotCode || q.slot_code);
  const selectOne = ["1", "true", "yes", "one"].includes(String(q.select || "").trim().toLowerCase());
  const strategy = String(q.strategy || (selectOne ? "weighted" : "priority")).trim().toLowerCase();

  if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });

  try {
    const houseEnabled = await isFeaturedHouseAdEnabled();

    // Fetch a wider pool when selecting one so rotation has candidates.
    const fetchLimit = selectOne ? Math.max(limit, 24) : limit;
    let placements = await dbPlacements(fetchLimit, slotFilter || null);
    placements = placements.filter((item) => matchesChain(item, chainId));
    if (!placements.length) {
      placements = externalPlacements(chainId, slotFilter || null).filter((item) => matchesChain(item, chainId));
    }
    // Featured: house only if enabled and no live paid inventory.
    placements = withFeaturedHouseAd(placements, chainId, slotFilter, houseEnabled);

    if (selectOne) {
      const poolItems = placements.slice(0, 24);
      let chosen = null;
      if (strategy === "priority" || strategy === "first") {
        chosen = poolItems[0] || null;
      } else if (strategy === "random") {
        chosen = poolItems.length ? poolItems[Math.floor(Math.random() * poolItems.length)] : null;
      } else {
        chosen = pickWeighted(poolItems);
      }
      // Empty is valid when house inventory is disabled and no paid ads are live.
      if (!chosen && slotFilter === FEATURED_SLOT && houseEnabled) {
        chosen = featuredHouseAd(chainId);
      }
      return json(res, 200, {
        items: chosen ? [chosen] : [],
        candidates: poolItems.slice(0, 8),
        slot: slotFilter || null,
        strategy: strategy || "weighted",
        select: "one",
        houseAdEnabled: houseEnabled,
        updatedAt: new Date().toISOString(),
      });
    }

    // Default list behavior for Arena / battle rails (unchanged contract).
    return json(res, 200, {
      items: placements.slice(0, limit),
      slot: slotFilter || null,
      houseAdEnabled: houseEnabled,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[api/sponsored] query failed", error);
    const fallback = externalPlacements(chainId, slotFilter || null);
    if (selectOne) {
      const chosen = pickWeighted(fallback);
      return json(res, 200, {
        items: chosen ? [chosen] : [],
        candidates: fallback.slice(0, 8),
        slot: slotFilter || null,
        strategy: "weighted",
        select: "one",
        updatedAt: new Date().toISOString(),
        warning: "Sponsored placement data is unavailable.",
      });
    }
    return json(res, 200, {
      items: fallback.slice(0, limit),
      updatedAt: new Date().toISOString(),
      warning: "Sponsored placement data is unavailable.",
    });
  }
}

export const FEATURED_SPONSOR_SLOT = FEATURED_SLOT;
