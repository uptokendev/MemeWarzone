import { pool } from "../server/db.js";
import { getQuery, json } from "../server/http.js";
import {
  absoluteUrl,
  embedShareCardImage,
  hudShareCardSvg,
  publicAssetUrl,
  respondHudShareCard,
} from "./lib/hudShareCardSvg.mjs";

function shortWallet(value) {
  const v = String(value || "");
  if (!v) return "Unknown";
  if (v.startsWith("@")) return v;
  return v.length > 10 ? `${v.slice(0, 6)}...${v.slice(-4)}` : v;
}

/**
 * Short crawler-friendly share cards: load draft by slug so og:image URLs stay short.
 * Query params still override when provided (PrepareBase "Copy PNG link").
 */
async function resolveShareCardQuery(req) {
  const q = getQuery(req);
  const slug = String(q.slug || "").trim();
  if (!slug || !pool) return q;

  try {
    const draftRes = await pool.query(
      `select id, chain_id, slug, name, ticker, description, logo_url, status, visibility, creator_wallet
         from public.campaign_drafts
        where lower(slug) = lower($1)
        limit 1`,
      [slug],
    );
    const draft = draftRes.rows[0];
    if (!draft) return q;

    const isPrivate = String(draft.visibility || "").toLowerCase() === "private";
    const appBase = String(process.env.PUBLIC_APP_URL || "https://app.memewar.zone").replace(/\/+$/, "");

    if (isPrivate) {
      return {
        ...q,
        name: q.name || "MemeWarzone",
        ticker: q.ticker || "MWZ",
        chain: q.chain || "BNB CHAIN",
        status: q.status || "PRIVATE",
        recruits: q.recruits || "0",
        heat: q.heat || "0%",
        creator: q.creator || "CLASSIFIED",
        link: q.link || `${appBase.replace(/^https?:\/\//i, "")}/prepare/${draft.slug}`,
        description: q.description || "Private dossier",
      };
    }

    const creator = String(draft.creator_wallet || "").trim();
    const solanaCreator = creator.length >= 32 && !creator.startsWith("0x");
    const commentAuthorNeq = solanaCreator
      ? "(wallet_address <> $2 and lower(wallet_address) <> lower($2))"
      : "lower(wallet_address) <> lower($2)";

    const [promoRes, metricsRes, followRes, nonCreatorCommentRes, reactionRes] = await Promise.all([
      pool
        .query(
          `select mission_statement, creator_note, share_message from public.campaign_draft_promotion where draft_id = $1 limit 1`,
          [draft.id],
        )
        .catch(() => ({ rows: [] })),
      pool
        .query(`select * from public.campaign_draft_metrics where draft_id = $1 limit 1`, [draft.id])
        .catch(() => ({ rows: [] })),
      pool
        .query(`select count(*)::int as count from public.campaign_draft_follows where draft_id = $1`, [draft.id])
        .catch(() => ({ rows: [{ count: 0 }] })),
      pool
        .query(
          `select count(*)::int as count
             from public.campaign_draft_comments
            where draft_id = $1
              and moderation_status = 'visible'
              and ${commentAuthorNeq}`,
          [draft.id, creator],
        )
        .catch(() => ({ rows: [{ count: 0 }] })),
      pool
        .query(
          `select coalesce(sum(reaction_count), 0)::int as count
             from public.campaign_draft_comments
            where draft_id = $1
              and moderation_status = 'visible'`,
          [draft.id],
        )
        .catch(() => ({ rows: [{ count: 0 }] })),
    ]);
    const promotion = promoRes.rows[0] || {};
    const metrics = metricsRes.rows[0] || {};
    const views = Number(metrics?.views || 0);
    const follows = Number(followRes.rows[0]?.count || 0);
    const comments = Number(nonCreatorCommentRes.rows[0]?.count || 0);
    const reactions = Number(reactionRes.rows[0]?.count || 0);
    const shares = Number(metrics?.shares || 0);
    const signedActions = Number(metrics?.signed_actions ?? metrics?.signedActions ?? 0);
    const rankingScore =
      follows * 10 +
      comments * 5 +
      reactions * 3 +
      shares * 4 +
      signedActions * 7 +
      Math.min(views, 2500) * 0.35;
    const heat = Math.max(0, Math.min(100, Math.round((rankingScore / 2200) * 100)));
    const chain =
      Number(draft.chain_id) === 101 || Number(draft.chain_id) === 102 ? "SOLANA" : "BNB CHAIN";
    const description =
      String(draft.description || promotion.mission_statement || promotion.creator_note || "").trim() ||
      "The launchpad that turns every drop into a war.";
    const logo = absoluteUrl(appBase, draft.logo_url || "");

    return {
      ...q,
      name: q.name || draft.name || "Campaign",
      ticker: q.ticker || draft.ticker || "TOKEN",
      chain: q.chain || chain,
      status: q.status || String(draft.status || "draft").replace(/_/g, " ").toUpperCase(),
      recruits: q.recruits || String(follows),
      heat: q.heat || `${heat}%`,
      creator: q.creator || shortWallet(draft.creator_wallet || ""),
      link: q.link || `${appBase.replace(/^https?:\/\//i, "")}/prepare/${draft.slug}`,
      description: q.description || description.slice(0, 280),
      logo: q.logo || q.logoUrl || logo,
      logoUrl: q.logoUrl || q.logo || logo,
    };
  } catch (err) {
    console.warn("[prepare-share-card] slug resolve failed", err?.message || err);
    return q;
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return json(res, 405, { error: "Method not allowed" });
  }
  try {
    const q = await resolveShareCardQuery(req);
    const logoDataUrl = await embedShareCardImage(q.logoUrl || q.logo || "");
    const brandFallback =
      q.brandLogo ||
      q.brand ||
      `${String(process.env.PUBLIC_APP_URL || "https://app.memewar.zone").replace(/\/+$/, "")}/assets/logo.png` ||
      publicAssetUrl(req, "/assets/logo.png");
    const brandLogoDataUrl = await embedShareCardImage(brandFallback);
    const svg = hudShareCardSvg(q, logoDataUrl, brandLogoDataUrl);
    return respondHudShareCard(req, res, {
      svg,
      ticker: q.ticker || "draft",
      format: q.format,
      download: String(q.download || "") === "1",
    });
  } catch (err) {
    console.error("[prepare-share-card]", err);
    return json(res, 500, { error: "Failed to render share card" });
  }
}
