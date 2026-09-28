import { badMethod, getQuery, isSolanaChain, normalizeAddress as normalizeAddressBase, normalizeWalletFlexible, json, readJson } from "../../server/http.js";
import { requireDraftActionAuth } from "./draft-auth.js";

const STATUSES = new Set([
  "draft",
  "promotion_published",
  "ready_to_launch",
  "scheduled",
  "deployed",
  "archived",
]);
const VISIBILITIES = new Set(["public", "unlisted", "private"]);
const ZERO = { views: 0, follows: 0, comments: 0, reactions: 0, shares: 0, signedActions: 0 };

function methodAllowed(req, res, allowed) {
  if (allowed.includes(req.method)) return true;
  badMethod(res);
  return false;
}

function normalizeAddress(value, chainId) {
  return normalizeAddressBase(value, chainId);
}

async function getPool() {
  if (!String(process.env.DATABASE_URL || "").trim()) return null;
  try {
    const mod = await import("../../server/db.js");
    return mod.pool || null;
  } catch (err) {
    console.warn("[draft-read] DB unavailable", err?.message || err);
    return null;
  }
}

function normalizeTicker(value) {
  return String(value || "")
    .trim()
    .replace(/^\$+/, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, 12);
}

function mapDraftRow(row) {
  if (!row) return null;
  const draftChainId = Number(row.chain_id ?? row.chainId ?? 97);
  const rawCreator = String(row.creator_wallet ?? row.creatorWallet ?? "");
  return {
    id: String(row.id),
    chainId: draftChainId,
    creatorWallet: isSolanaChain(draftChainId) ? rawCreator : rawCreator.toLowerCase(),
    name: String(row.name || ""),
    ticker: normalizeTicker(row.ticker),
    description: row.description || null,
    category: row.category || "meme",
    logoUrl: row.logo_url ?? row.logoUrl ?? null,
    websiteUrl: row.website_url ?? row.websiteUrl ?? null,
    xUrl: row.x_url ?? row.xUrl ?? null,
    otherUrl: row.other_url ?? row.otherUrl ?? null,
    slug: String(row.slug || ""),
    status: STATUSES.has(row.status) ? row.status : "draft",
    visibility: VISIBILITIES.has(row.visibility) ? row.visibility : "private",
    campaignAddress: row.campaign_address ?? row.campaignAddress ?? null,
    tokenAddress: row.token_address ?? row.tokenAddress ?? null,
    deployTxHash: row.deploy_tx_hash ?? row.deployTxHash ?? null,
    archivedAt: row.archived_at ?? row.archivedAt ?? null,
    deployedAt: row.deployed_at ?? row.deployedAt ?? null,
    graduationTargetWei: String(row.graduation_target_wei ?? row.graduationTargetWei ?? 30_000n * 10n ** 18n),
    scheduledLaunchAt: row.scheduled_launch_at ?? row.scheduledLaunchAt ?? null,
    launchType: String(row.launch_type ?? row.launchType ?? "launchpad"),
    dbcFeeChoice: row.dbc_fee_choice ?? row.dbcFeeChoice ?? null,
    dbcCreatorSharePct: row.dbc_creator_share_pct ?? row.dbcCreatorSharePct ?? null,
    dbcFirstBuyLamports: row.dbc_first_buy_lamports != null ? String(row.dbc_first_buy_lamports) : (row.dbcFirstBuyLamports != null ? String(row.dbcFirstBuyLamports) : null),
    createdAt: row.created_at ?? row.createdAt ?? new Date().toISOString(),
    updatedAt: row.updated_at ?? row.updatedAt ?? new Date().toISOString(),
  };
}

function mapPromotionRow(row, draftId) {
  return {
    draftId: String(row?.draft_id ?? row?.draftId ?? draftId),
    missionStatement: row?.mission_statement ?? row?.missionStatement ?? "",
    roadmap: Array.isArray(row?.roadmap) ? row.roadmap : [],
    launchStrategy: row?.launch_strategy ?? row?.launchStrategy ?? "",
    telegramUrl: row?.telegram_url ?? row?.telegramUrl ?? "",
    discordUrl: row?.discord_url ?? row?.discordUrl ?? "",
    xUrl: row?.x_url ?? row?.xUrl ?? "",
    websiteUrl: row?.website_url ?? row?.websiteUrl ?? "",
    docs: Array.isArray(row?.docs) ? row.docs : [],
    creatorNote: row?.creator_note ?? row?.creatorNote ?? "",
    bannerUrl: row?.banner_url ?? row?.bannerUrl ?? "",
    shareMessage: row?.share_message ?? row?.shareMessage ?? "",
    publishedAt: row?.published_at ?? row?.publishedAt ?? null,
    createdAt: row?.created_at ?? row?.createdAt ?? null,
    updatedAt: row?.updated_at ?? row?.updatedAt ?? null,
  };
}

function popularityFromMetrics(metrics, extras = {}) {
  const m = { ...ZERO, ...(metrics || {}) };
  const views = Number(m.views || 0);
  const follows = Number(extras.follows ?? m.follows ?? 0);
  const comments = Number(extras.comments ?? m.comments ?? 0);
  const reactions = Number(extras.reactions ?? m.reactions ?? 0);
  const shares = Number(m.shares || 0);
  const signedActions = Number(m.signedActions ?? m.signed_actions ?? 0);
  const armedCount = Number(extras.armedCount ?? 0);
  const rankingScore = follows * 10 + comments * 5 + reactions * 3 + shares * 4 + signedActions * 7 + Math.min(views, 2500) * 0.35;
  const popularityPercentage = Math.max(0, Math.min(100, Math.round((rankingScore / 2200) * 100)));
  const heatLabel = popularityPercentage >= 90 ? "On Fire" : popularityPercentage >= 70 ? "Hot" : popularityPercentage >= 35 ? "Warming" : "Cold";
  return { views, follows, comments, reactions, shares, signedActions, armedCount, popularityPercentage, heatLabel, rankingScore: Math.round(rankingScore) };
}

async function getDraftEngagementCounts(pool, draft) {
  const creator = String(draft.creatorWallet || "").trim();
  const solanaCreator = creator.length >= 32 && !creator.startsWith("0x");
  const commentAuthorNeq = solanaCreator
    ? "(wallet_address <> $2 and lower(wallet_address) <> lower($2))"
    : "lower(wallet_address) <> lower($2)";

  const [followRes, armedCountRes, nonCreatorCommentRes, reactionRes] = await Promise.all([
    pool
      .query("select count(*)::int as count from public.campaign_draft_follows where draft_id = $1", [draft.id])
      .catch(() => ({ rows: [{ count: 0 }] })),
    pool
      .query("select count(*)::int as count from public.campaign_draft_notification_subscriptions where draft_id = $1", [draft.id])
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

  return {
    follows: Number(followRes.rows[0]?.count || 0),
    armedCount: Number(armedCountRes.rows[0]?.count || 0),
    comments: Number(nonCreatorCommentRes.rows[0]?.count || 0),
    reactions: Number(reactionRes.rows[0]?.count || 0),
  };
}

export async function signedDraftById(req, res) {
  if (!methodAllowed(req, res, ["GET", "POST"])) return;

  const draftId = String(req.params?.draftId || "");
  const pool = await getPool();
  if (!pool) return json(res, 503, { error: "Signed draft reads require DATABASE_URL-backed wallet auth." });

  const draftRes = await pool.query("select * from campaign_drafts where id::text = $1 limit 1", [draftId]);
  const draft = mapDraftRow(draftRes.rows[0]);
  if (!draft) return json(res, 404, { error: "Draft not found" });

  if (req.method === "POST") {
    const body = await readJson(req);
    const auth = body.auth || null;
    if (!auth) {
      return json(res, 401, {
        error: "Draft owner access requires signed wallet auth.",
        code: "DRAFT_OWNER_AUTH_REQUIRED",
        chainId: draft.chainId,
        draftId,
      });
    }

    const ok = await requireDraftActionAuth({
      res,
      pool,
      auth,
      expectedWallet: draft.creatorWallet,
      chainId: draft.chainId,
      action: "read_draft",
      draftId,
    });
    if (!ok) return;
  } else if (draft.visibility === "private") {
    return json(res, 401, {
      error: "Private draft requires signed owner wallet auth.",
      code: "PRIVATE_DRAFT_AUTH_REQUIRED",
      chainId: draft.chainId,
      draftId,
    });
  }

  const promoRes = await pool.query("select * from campaign_draft_promotion where draft_id = $1 limit 1", [draft.id]);
  const metricsRes = await pool.query("select * from campaign_draft_metrics where draft_id = $1 limit 1", [draft.id]).catch(() => ({ rows: [] }));
  const engagementCounts = await getDraftEngagementCounts(pool, draft);

  return json(res, 200, {
    draft,
    promotion: mapPromotionRow(promoRes.rows[0], draft.id),
    popularity: popularityFromMetrics(metricsRes.rows[0] || ZERO, engagementCounts),
  });
}

export async function signedPrepareBySlug(req, res) {
  if (!methodAllowed(req, res, ["GET", "POST"])) return;

  const slug = String(req.params?.slug || "");
  const pool = await getPool();
  if (!pool) return json(res, 503, { error: "Signed prepare reads require DATABASE_URL-backed wallet auth." });

  const draftRes = await pool.query("select * from campaign_drafts where slug = $1 limit 1", [slug]);
  const draft = mapDraftRow(draftRes.rows[0]);
  if (!draft) return json(res, 404, { error: "Prepare page not found" });

  const q = getQuery(req);
  // Public viewer hydrate (Armed / Following) is wallet-identity, not draft-chain.
  let viewer = normalizeWalletFlexible(q.viewer || "");

  if (draft.visibility === "private") {
    let auth = null;
    if (req.method === "POST") {
      const body = await readJson(req);
      auth = body.auth || null;
    }

    if (!auth) {
      return json(res, 401, {
        error: "Private draft requires signed owner wallet auth.",
        code: "PRIVATE_DRAFT_AUTH_REQUIRED",
        chainId: draft.chainId,
        draftId: draft.id,
      });
    }

    const ok = await requireDraftActionAuth({
      res,
      pool,
      auth,
      expectedWallet: draft.creatorWallet,
      chainId: draft.chainId,
      action: "read_draft",
      draftId: draft.id,
    });
    if (!ok) return;
    viewer = normalizeAddress(auth.walletAddress, draft.chainId);
  }

  await pool
    .query(
      "insert into campaign_draft_metrics (draft_id, views) values ($1, 1) on conflict (draft_id) do update set views = campaign_draft_metrics.views + 1, updated_at = now()",
      [draft.id],
    )
    .catch(() => {});

  const promoRes = await pool.query("select * from campaign_draft_promotion where draft_id = $1 limit 1", [draft.id]);
  const metricsRes = await pool.query("select * from campaign_draft_metrics where draft_id = $1 limit 1", [draft.id]).catch(() => ({ rows: [] }));
  const engagementCounts = await getDraftEngagementCounts(pool, draft);

  let viewerFollowing = false;
  let viewerArmed = false;
  if (viewer) {
    const [followRes, armRes] = await Promise.all([
      pool
        .query(
          "select 1 from campaign_draft_follows where draft_id = $1 and wallet_address = $2 limit 1",
          [draft.id, viewer],
        )
        .catch(() => ({ rowCount: 0 })),
      pool
        .query(
          "select 1 from public.campaign_draft_notification_subscriptions where draft_id = $1 and wallet_address = $2 limit 1",
          [draft.id, viewer],
        )
        .catch(() => ({ rowCount: 0 })),
    ]);
    viewerFollowing = (followRes.rowCount || 0) > 0;
    viewerArmed = (armRes.rowCount || 0) > 0;
  }

  return json(res, 200, {
    draft,
    promotion: mapPromotionRow(promoRes.rows[0], draft.id),
    popularity: popularityFromMetrics(metricsRes.rows[0] || ZERO, engagementCounts),
    viewer: {
      wallet: viewer || null,
      isFollowing: viewerFollowing,
      isArmed: viewerArmed,
    },
  });
}
