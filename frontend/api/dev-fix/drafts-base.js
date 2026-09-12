import { randomUUID } from "node:crypto";
import { badMethod, getQuery, isAddress, isSolanaChain, normalizeAddress as normalizeAddressBase, json, readJson } from "../../server/http.js";
import { requireDraftActionAuth } from "./draft-auth.js";
import { notifyDraftCreated } from "../lib/campaignLifecycleNotifications.js";
import { notifyDraftOwner } from "./prepare-notify.js";
import {
  TickerReservationError,
  createTickerReservation,
  isTickerReservationConflict,
  promoteTickerReservation,
  releaseTickerReservation,
  withTickerReservationTransaction,
} from "./ticker-reservation-service.js";

const STATUSES = new Set([
  "draft",
  "promotion_published",
  "ready_to_launch",
  "scheduled",
  "deployed",
  "archived",
]);
const PUBLIC_DISCOVERY_STATUSES = new Set([
  "promotion_published",
  "ready_to_launch",
  "scheduled",
  // Keep deployed drafts discoverable until campaigns registry is populated.
  "deployed",
]);
const VISIBILITIES = new Set(["public", "unlisted", "private"]);
const ZERO = { views: 0, follows: 0, comments: 0, reactions: 0, shares: 0, signedActions: 0 };
const DEFAULT_GRADUATION_TARGET_WEI = 30_000n * 10n ** 18n;
const TEST_GRADUATION_TARGET_WEI = 6n * 10n ** 18n;
const STANDARD_GRADUATION_TARGETS = new Set([15_000n, 30_000n, 50_000n].map((value) => value * 10n ** 18n));

function methodAllowed(req, res, allowed) {
  if (allowed.includes(req.method)) return true;
  badMethod(res);
  return false;
}

function normalizeAddress(value, chainId) {
  // delegate to http.js version that handles Solana vs EVM based on chain
  return normalizeAddressBase(value, chainId);
}

function normalizeTicker(value) {
  return String(value || "")
    .trim()
    .replace(/^\$+/, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, 12);
}

function cleanText(value, max = 5000) {
  return String(value || "").trim().slice(0, max);
}

function cleanUrl(value) {
  const raw = cleanText(value, 500);
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) return raw;
  try {
    return new URL(raw).toString();
  } catch {
    return raw;
  }
}

function cleanStringArray(value, maxItems = 12, maxLen = 600) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanText(item, maxLen)).filter(Boolean).slice(0, maxItems);
}

function normalizeDraftGraduationTarget(chainId, value) {
  let target = DEFAULT_GRADUATION_TARGET_WEI;
  if (value != null && String(value).trim()) {
    try {
      target = BigInt(String(value));
    } catch {
      throw new TickerReservationError("Invalid graduation target.", { code: "INVALID_GRADUATION_TARGET", httpStatus: 400 });
    }
  }
  if (STANDARD_GRADUATION_TARGETS.has(target)) return target.toString();
  // $6 test threshold: BNB testnet (97) and Solana product chains (101/102).
  const cid = Number(chainId);
  if ((cid === 97 || cid === 101 || cid === 102) && target === TEST_GRADUATION_TARGET_WEI) {
    return target.toString();
  }
  throw new TickerReservationError("Unsupported graduation target for this chain.", { code: "INVALID_GRADUATION_TARGET", httpStatus: 400 });
}

function slugify(value) {
  const base = String(value || "draft")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "draft";
}

function makeSlug(name, ticker) {
  return `${slugify(name)}-${String(ticker || "mwz").toLowerCase()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function getPool() {
  if (!String(process.env.DATABASE_URL || "").trim()) return null;
  try {
    const mod = await import("../../server/db.js");
    return mod.pool || null;
  } catch (err) {
    console.warn("[drafts] DB unavailable; using in-memory fallback", err?.message || err);
    return null;
  }
}

function defaultPromotion(draftId, now = new Date().toISOString()) {
  return {
    draftId,
    missionStatement:
      "MemeWarzone is the creator-first meme launchpad — every launch becomes a competition, UpVotes drive discovery, and on-chain leagues turn drops into repeatable events.",
    roadmap: [
      "Recon: recruits, hype, visuals.",
      "Deploy: bonding curve goes live.",
      "Graduate: LP locks and DEX migration opens.",
      "Conquest: weekly meme leagues and holder rewards.",
    ],
    launchStrategy:
      "Build the army first. Launch only when the bunker is full, the comms channels are active, and the squad is ready to push the campaign into the bonding curve.",
    telegramUrl: "",
    discordUrl: "",
    xUrl: "https://x.com/memewarzone",
    websiteUrl: "https://memewar.zone",
    docs: [],
    creatorNote: "No premature trading. No silent deployers. No rugs. This is Prepare Mode.",
    bannerUrl: "",
    shareMessage:
      "Incoming transmission from the Warzone:\n\nthis draft is preparing for war on MemeWarzone.\n\nFollow the signal → @memewarzone",
    publishedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function memoryStore() {
  if (!globalThis.__mwz_prepare_mode_store) {
    const now = new Date().toISOString();
    const demoDraft = {
      id: "demo-mwz-draft",
      chainId: 97,
      creatorWallet: "0x0000000000000000000000000000000000000001",
      name: "MEMEWARZONE",
      ticker: "MWZ",
      description: "The launchpad that turns every drop into a war.",
      category: "meme",
      logoUrl: "",
      websiteUrl: "https://memewar.zone",
      xUrl: "https://x.com/memewarzone",
      otherUrl: "",
      slug: "memewarzone-mwz-demo",
      status: "promotion_published",
      visibility: "public",
      campaignAddress: null,
      tokenAddress: null,
      deployTxHash: null,
      archivedAt: null,
      deployedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const c1 = {
      id: "demo-c1",
      draftId: demoDraft.id,
      walletAddress: "@whalepaw",
      body: "early bag, easy alpha. squad assembled.",
      parentCommentId: null,
      reactionCount: 14,
      createdAt: now,
      replies: [],
    };
    const c2 = {
      id: "demo-c2",
      draftId: demoDraft.id,
      walletAddress: "@grunt_404",
      body: "LP lock + no silent deployer nonsense = notify-on-launch armed.",
      parentCommentId: null,
      reactionCount: 12,
      createdAt: now,
      replies: [],
    };
    globalThis.__mwz_prepare_mode_store = {
      drafts: new Map([[demoDraft.id, demoDraft]]),
      promotions: new Map([[demoDraft.id, defaultPromotion(demoDraft.id, now)]]),
      follows: new Map([[demoDraft.id, new Set()]]),
      comments: new Map([[demoDraft.id, [c1, c2]]]),
      metrics: new Map([
        [demoDraft.id, { ...ZERO, views: 6294, follows: 412, comments: 127, reactions: 219, shares: 93, signedActions: 1843 }],
      ]),
    };
  }
  return globalThis.__mwz_prepare_mode_store;
}

function mapDraftRow(row) {
  if (!row) return null;
  const chainId = Number(row.chain_id ?? row.chainId ?? 97);
  const rawCreator = String(row.creator_wallet ?? row.creatorWallet ?? "");
  return {
    id: String(row.id),
    chainId,
    creatorWallet: isSolanaChain(chainId) ? rawCreator : rawCreator.toLowerCase(),
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
    graduationTargetWei: String(row.graduation_target_wei ?? row.graduationTargetWei ?? DEFAULT_GRADUATION_TARGET_WEI),
    scheduledLaunchAt: row.scheduled_launch_at ?? row.scheduledLaunchAt ?? null,
    createdAt: row.created_at ?? row.createdAt ?? new Date().toISOString(),
    updatedAt: row.updated_at ?? row.updatedAt ?? new Date().toISOString(),
  };
}

function mapPromotionRow(row, draftId) {
  if (!row) return defaultPromotion(draftId);
  return {
    draftId: String(row.draft_id ?? row.draftId ?? draftId),
    missionStatement: row.mission_statement ?? row.missionStatement ?? "",
    roadmap: Array.isArray(row.roadmap) ? row.roadmap : [],
    launchStrategy: row.launch_strategy ?? row.launchStrategy ?? "",
    telegramUrl: row.telegram_url ?? row.telegramUrl ?? "",
    discordUrl: row.discord_url ?? row.discordUrl ?? "",
    xUrl: row.x_url ?? row.xUrl ?? "",
    websiteUrl: row.website_url ?? row.websiteUrl ?? "",
    docs: Array.isArray(row.docs) ? row.docs : [],
    creatorNote: row.creator_note ?? row.creatorNote ?? "",
    bannerUrl: row.banner_url ?? row.bannerUrl ?? "",
    shareMessage: row.share_message ?? row.shareMessage ?? "",
    publishedAt: row.published_at ?? row.publishedAt ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null,
  };
}

function popularityFromMetrics(metrics) {
  const m = { ...ZERO, ...(metrics || {}) };
  const views = Number(m.views || 0);
  const follows = Number(m.follows || 0);
  const comments = Number(m.comments || 0);
  const reactions = Number(m.reactions || 0);
  const shares = Number(m.shares || 0);
  const signedActions = Number(m.signedActions ?? m.signed_actions ?? 0);
  const rankingScore = follows * 10 + comments * 5 + reactions * 3 + shares * 4 + signedActions * 7 + Math.min(views, 2500) * 0.35;
  const popularityPercentage = Math.max(0, Math.min(100, Math.round((rankingScore / 2200) * 100)));
  const heatLabel = popularityPercentage >= 90 ? "On Fire" : popularityPercentage >= 70 ? "Hot" : popularityPercentage >= 35 ? "Warming" : "Cold";
  return { views, follows, comments, reactions, shares, signedActions, popularityPercentage, heatLabel, rankingScore: Math.round(rankingScore) };
}

function isPublicDiscoverableDraft(draft) {
  return draft?.visibility === "public" && PUBLIC_DISCOVERY_STATUSES.has(String(draft.status));
}

function canViewDraft(draft, viewer) {
  if (!draft) return false;
  if (String(draft.status) === "archived") return false;
  if (draft.visibility !== "private") return true;
  const c = normalizeAddress(draft.creatorWallet, draft.chainId);
  const v = normalizeAddress(viewer, draft.chainId);
  return !!c && !!v && c === v;
}

async function getDraftBundleById(id, viewer, { bypassVisibility = false } = {}) {
  const pool = await getPool();
  if (pool) {
    const draftRes = await pool.query("select * from campaign_drafts where id::text = $1 limit 1", [id]);
    const draft = mapDraftRow(draftRes.rows[0]);
    if (!draft) return null;
    if (!bypassVisibility && !canViewDraft(draft, viewer)) return { forbidden: true };
    const promoRes = await pool.query("select * from campaign_draft_promotion where draft_id = $1 limit 1", [draft.id]);
    const metricsRes = await pool.query("select * from campaign_draft_metrics where draft_id = $1 limit 1", [draft.id]).catch(() => ({ rows: [] }));
    return { draft, promotion: mapPromotionRow(promoRes.rows[0], draft.id), popularity: popularityFromMetrics(metricsRes.rows[0] || ZERO) };
  }

  const store = memoryStore();
  const draft = store.drafts.get(id);
  if (!draft) return null;
  if (!bypassVisibility && !canViewDraft(draft, viewer)) return { forbidden: true };
  return { draft, promotion: store.promotions.get(id) || defaultPromotion(id), popularity: popularityFromMetrics(store.metrics.get(id)) };
}

async function getDraftBundleBySlug(slug, viewer, countView = false) {
  const pool = await getPool();
  if (pool) {
    const draftRes = await pool.query("select * from campaign_drafts where slug = $1 limit 1", [slug]);
    const draft = mapDraftRow(draftRes.rows[0]);
    if (!draft) return null;
    if (!canViewDraft(draft, viewer)) return { forbidden: true };
    if (countView) {
      await pool
        .query(
          "insert into campaign_draft_metrics (draft_id, views) values ($1, 1) on conflict (draft_id) do update set views = campaign_draft_metrics.views + 1, updated_at = now()",
          [draft.id],
        )
        .catch(() => {});
    }
    return getDraftBundleById(draft.id, viewer);
  }

  const store = memoryStore();
  const draft = Array.from(store.drafts.values()).find((item) => item.slug === slug);
  if (!draft) return null;
  if (!canViewDraft(draft, viewer)) return { forbidden: true };
  if (countView) {
    const metrics = store.metrics.get(draft.id) || { ...ZERO };
    metrics.views += 1;
    store.metrics.set(draft.id, metrics);
  }
  return getDraftBundleById(draft.id, viewer);
}

function nestComments(flat) {
  const parents = [];
  const byId = new Map();
  for (const raw of flat) {
    const item = { ...raw, parentCommentId: raw.parentCommentId ?? raw.parent_comment_id ?? null, replies: [] };
    byId.set(item.id, item);
    if (!item.parentCommentId) parents.push(item);
  }
  for (const item of byId.values()) {
    if (item.parentCommentId && byId.has(item.parentCommentId)) byId.get(item.parentCommentId).replies.push(item);
  }
  return parents;
}

function mapCommentRow(row) {
  const rawDisplayName = row.author_display_name ?? row.display_name ?? null;
  const displayName =
    typeof rawDisplayName === "string" && rawDisplayName.trim().length > 0
      ? rawDisplayName.trim()
      : null;
  const rawAvatar = row.author_avatar_url ?? row.avatar_url ?? null;
  const avatarUrl =
    typeof rawAvatar === "string" && rawAvatar.trim().length > 0 ? rawAvatar.trim() : null;
  return {
    id: String(row.id),
    draftId: String(row.draft_id),
    walletAddress: String(row.wallet_address),
    displayName,
    avatarUrl,
    body: row.body,
    parentCommentId: row.parent_comment_id ? String(row.parent_comment_id) : null,
    reactionCount: Number(row.reaction_count || 0),
    createdAt: row.created_at,
  };
}

export async function drafts(req, res) {
  if (!methodAllowed(req, res, ["GET", "POST"])) return;

  if (req.method === "GET") {
    const q = getQuery(req);
    const ownerChain = q.chainId ? Number(q.chainId) : null;
    // Prefer chain-aware normalize; also accept raw Solana base58 when chainId omitted.
    let owner = normalizeAddress(q.owner, ownerChain);
    if (!owner && String(q.owner || "").trim()) {
      const rawOwner = String(q.owner).trim();
      // Solana base58 is case-sensitive — never lowercase for owner match.
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(rawOwner)) owner = rawOwner;
      else if (/^0x[a-fA-F0-9]{40}$/.test(rawOwner)) owner = rawOwner.toLowerCase();
    }
    const pool = await getPool();

    if (pool) {
      if (owner) {
        const isSolanaOwner = !owner.startsWith("0x");
        const result = isSolanaOwner
          ? await pool.query(
              `select * from campaign_drafts
                where creator_wallet = $1
                  and status <> 'archived'
                order by created_at desc
                limit 100`,
              [owner],
            )
          : await pool.query(
              `select * from campaign_drafts
                where lower(creator_wallet) = lower($1)
                  and status <> 'archived'
                order by created_at desc
                limit 100`,
              [owner],
            );
        return json(res, 200, { items: result.rows.map(mapDraftRow) });
      }
      const chainId = q.chainId ? Number(q.chainId) : null;
      const where = ["d.visibility = 'public'", "d.status = any($1::text[])"];
      const params = [Array.from(PUBLIC_DISCOVERY_STATUSES)];
      if (chainId) {
        where.push(`d.chain_id = $${params.length + 1}`);
        params.push(chainId);
      }
      // Single query with promotion + metrics so home grid can render without N+1 /api/drafts/:id.
      let rows = [];
      try {
        const result = await pool.query(
          `select d.*,
                  p.mission_statement,
                  p.creator_note,
                  p.banner_url,
                  m.views,
                  m.follows,
                  m.comments,
                  m.reactions,
                  m.shares,
                  m.signed_actions
             from public.campaign_drafts d
             left join public.campaign_draft_promotion p on p.draft_id = d.id
             left join public.campaign_draft_metrics m on m.draft_id = d.id
            where ${where.join(" and ")}
            order by d.created_at desc
            limit 50`,
          params,
        );
        rows = result.rows;
      } catch (joinError) {
        console.warn("[api/drafts] enriched list failed; falling back to plain drafts", joinError?.message || joinError);
        const plainWhere = where.map((clause) => clause.replace(/^d\./, ""));
        const result = await pool.query(
          `select * from public.campaign_drafts where ${plainWhere.join(" and ")} order by created_at desc limit 50`,
          params,
        );
        rows = result.rows;
      }
      const items = rows.map((row) => {
        const draft = mapDraftRow(row);
        const popularity = popularityFromMetrics({
          views: row.views,
          follows: row.follows,
          comments: row.comments,
          reactions: row.reactions,
          shares: row.shares,
          signed_actions: row.signed_actions,
        });
        const mission =
          String(row.mission_statement || row.creator_note || draft.description || "").trim() ||
          "Creator is preparing the campaign before the battlefield opens.";
        return {
          ...draft,
          mission,
          missionStatement: row.mission_statement || "",
          creatorNote: row.creator_note || "",
          bannerUrl: row.banner_url || null,
          popularity,
        };
      });
      return json(res, 200, { items });
    }

    const store = memoryStore();
    const items = Array.from(store.drafts.values())
      .filter((draft) => (owner
        ? draft.creatorWallet === owner && draft.status !== "archived"
        : isPublicDiscoverableDraft(draft)))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return json(res, 200, { items });
  }

  const body = await readJson(req);
  const chainId = Number(body.chainId || process.env.VITE_TARGET_CHAIN_ID || 97);
  const creatorWallet = normalizeAddress(body.creatorWallet || body.walletAddress, chainId);
  if (!creatorWallet) return json(res, 400, { error: "Draft requires a connected wallet." });

  const name = cleanText(body.name, 80);
  const ticker = normalizeTicker(body.ticker);
  if (!name) return json(res, 400, { error: "Draft name is required." });
  if (!ticker) return json(res, 400, { error: "Draft ticker is required." });

  const visibility = VISIBILITIES.has(body.visibility) ? body.visibility : "private";
  let graduationTargetWei;
  try {
    graduationTargetWei = normalizeDraftGraduationTarget(chainId, body.graduationTargetWei);
  } catch (error) {
    return json(res, error?.httpStatus || 400, {
      error: error?.message || "Unsupported graduation target for this chain.",
      code: error?.code || "INVALID_GRADUATION_TARGET",
    });
  }
  const now = new Date().toISOString();
  const pool = await getPool();

  const authOk = await requireDraftActionAuth({ res, pool, auth: body.auth, expectedWallet: creatorWallet, chainId, action: "create_draft" });
  if (!authOk) return;

  // Prefer explicit Solana cluster from client or env (devnet vs mainnet-beta).
  const reservationCluster =
    body.cluster ||
    body.networkCluster ||
    (Number(chainId) === 102
      ? "solana-devnet"
      : Number(chainId) === 101
        ? process.env.SOLANA_CLUSTER || process.env.VITE_SOLANA_CLUSTER || "solana-mainnet-beta"
        : "");

  if (pool) {
    try {
      const created = await withTickerReservationTransaction(pool, async (db) => {
        const limitRes = await db.query("select count(*)::int as count from campaign_drafts where creator_wallet = $1 and status <> 'archived'", [creatorWallet]);
        if (Number(limitRes.rows[0]?.count || 0) >= 10) {
          throw new TickerReservationError("Draft limit reached. Max 10 non-archived drafts per creator.", {
            code: "DRAFT_LIMIT_REACHED",
            httpStatus: 409,
          });
        }

        const inserted = await db.query(
          "insert into campaign_drafts (chain_id, creator_wallet, name, ticker, description, category, logo_url, website_url, x_url, other_url, graduation_target_wei, slug, status, visibility) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft',$13) returning *",
          [
            chainId,
            creatorWallet,
            name,
            ticker,
            cleanText(body.description, 1200) || null,
            cleanText(body.category, 40) || "meme",
            cleanUrl(body.logoUrl) || null,
            cleanUrl(body.websiteUrl) || null,
            cleanUrl(body.xUrl) || null,
            cleanUrl(body.otherUrl) || null,
            graduationTargetWei,
            makeSlug(name, ticker),
            visibility,
          ],
        );

        const draft = mapDraftRow(inserted.rows[0]);
        const tickerReservation = await createTickerReservation(db, {
          draftId: draft.id,
          creatorWallet,
          chainId,
          cluster: reservationCluster,
          ticker,
          published: visibility === "public",
        });
        const promotionRes = await db.query(
          "insert into campaign_draft_promotion (draft_id, telegram_url, discord_url, x_url, website_url, docs, updated_at) values ($1,$2,$3,$4,$5,$6::jsonb,now()) on conflict (draft_id) do update set telegram_url = excluded.telegram_url, discord_url = excluded.discord_url, x_url = excluded.x_url, website_url = excluded.website_url, docs = excluded.docs, updated_at = now() returning *",
          [
            draft.id,
            cleanUrl(body.telegramUrl),
            cleanUrl(body.discordUrl),
            cleanUrl(body.xUrl),
            cleanUrl(body.websiteUrl),
            JSON.stringify(cleanStringArray(body.docs, 8, 500)),
          ],
        );
        await db.query("insert into campaign_draft_metrics (draft_id) values ($1) on conflict (draft_id) do nothing", [draft.id]);
        return {
          draft,
          promotion: mapPromotionRow(promotionRes.rows[0], draft.id),
          popularity: popularityFromMetrics(ZERO),
          tickerReservation,
        };
      });
      await notifyDraftCreated(pool, {
        chainId,
        draftId: created.draft.id,
        slug: created.draft.slug,
        name: created.draft.name,
        ticker: created.draft.ticker,
        imageUrl: created.draft.logoUrl,
        creatorWallet: created.draft.creatorWallet,
        scheduledFor: created.draft.scheduledLaunchAt || null,
      });
      return json(res, 201, created);
    } catch (error) {
      if (
        error instanceof TickerReservationError ||
        error?.name === "TickerReservationError" ||
        isTickerReservationConflict(error)
      ) {
        return json(res, error.httpStatus || 409, {
          error: error.message || "Ticker already reserved by an active draft or live campaign.",
          code: error.code || "TICKER_UNAVAILABLE",
        });
      }
      console.error("[drafts] create failed", {
        message: error?.message,
        code: error?.code,
        detail: error?.detail,
        constraint: error?.constraint,
        chainId,
        creatorWallet,
      });
      return json(res, 500, {
        error: "Server error",
        message: String(error?.message || error),
        code: error?.code || "DRAFT_CREATE_FAILED",
      });
    }
  }

  const store = memoryStore();
  const activeForOwner = Array.from(store.drafts.values()).filter((draft) => draft.creatorWallet === creatorWallet && draft.status !== "archived");
  if (activeForOwner.length >= 10) return json(res, 409, { error: "Draft limit reached. Max 10 non-archived drafts per creator." });

  const dup = Array.from(store.drafts.values()).find((draft) => Number(draft.chainId) === chainId && draft.ticker === ticker && draft.status !== "archived");
  if (dup) return json(res, 409, { error: "Ticker already reserved by an active draft or live campaign." });

  const draft = {
    id: randomUUID(),
    chainId,
    creatorWallet,
    name,
    ticker,
    description: cleanText(body.description, 1200) || null,
    category: cleanText(body.category, 40) || "meme",
    logoUrl: cleanUrl(body.logoUrl) || null,
    websiteUrl: cleanUrl(body.websiteUrl) || null,
    xUrl: cleanUrl(body.xUrl) || null,
    otherUrl: cleanUrl(body.otherUrl) || null,
    slug: makeSlug(name, ticker),
    status: "draft",
    visibility,
    campaignAddress: null,
    tokenAddress: null,
    deployTxHash: null,
    archivedAt: null,
    deployedAt: null,
    graduationTargetWei,
    scheduledLaunchAt: null,
    createdAt: now,
    updatedAt: now,
  };
  store.drafts.set(draft.id, draft);
  store.promotions.set(draft.id, {
    ...defaultPromotion(draft.id, now),
    telegramUrl: cleanUrl(body.telegramUrl),
    discordUrl: cleanUrl(body.discordUrl),
    xUrl: cleanUrl(body.xUrl),
    websiteUrl: cleanUrl(body.websiteUrl),
    docs: cleanStringArray(body.docs, 8, 500),
    publishedAt: null,
  });
  store.metrics.set(draft.id, { ...ZERO });
  return json(res, 201, {
    draft,
    promotion: store.promotions.get(draft.id),
    popularity: popularityFromMetrics(ZERO),
  });
}

export async function draftById(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  const q = getQuery(req);
  const bundle = await getDraftBundleById(String(req.params?.draftId || ""), normalizeAddress(q.viewer, q.chainId ? Number(q.chainId) : null));
  if (!bundle) return json(res, 404, { error: "Draft not found" });
  if (bundle.forbidden) return json(res, 403, { error: "This draft is private." });
  return json(res, 200, bundle);
}

export async function prepareBySlug(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  const q = getQuery(req);
  const bundle = await getDraftBundleBySlug(String(req.params?.slug || ""), normalizeAddress(q.viewer, q.chainId ? Number(q.chainId) : null), true);
  if (!bundle) return json(res, 404, { error: "Prepare page not found" });
  if (bundle.forbidden) return json(res, 403, { error: "This draft is private." });
  return json(res, 200, bundle);
}

export async function draftPromotion(req, res) {
  if (!methodAllowed(req, res, ["PUT", "POST"])) return;

  const id = String(req.params?.draftId || "");
  const body = await readJson(req);
  const visibility = VISIBILITIES.has(body.visibility) ? body.visibility : undefined;
  const publish = Boolean(body.publish);
  const now = new Date().toISOString();
  const promotion = {
    missionStatement: cleanText(body.missionStatement, 5000),
    roadmap: cleanStringArray(body.roadmap, 8, 240),
    launchStrategy: cleanText(body.launchStrategy, 5000),
    telegramUrl: cleanUrl(body.telegramUrl),
    discordUrl: cleanUrl(body.discordUrl),
    xUrl: cleanUrl(body.xUrl),
    websiteUrl: cleanUrl(body.websiteUrl),
    docs: cleanStringArray(body.docs, 8, 500),
    creatorNote: cleanText(body.creatorNote, 3000),
    bannerUrl: cleanUrl(body.bannerUrl),
    shareMessage: cleanText(body.shareMessage, 500),
  };
  const pool = await getPool();

  if (pool) {
    const exists = await pool.query("select id, creator_wallet, chain_id, ticker, slug, status from campaign_drafts where id::text = $1 limit 1", [id]);
    if (!exists.rows.length) return json(res, 404, { error: "Draft not found" });
    const before = exists.rows[0];

    const ownerOk = await requireDraftActionAuth({
      res,
      pool,
      auth: body.auth,
      expectedWallet: before.creator_wallet,
      chainId: Number(before.chain_id),
      action: publish ? "publish_promotion" : "save_promotion",
      draftId: id,
    });
    if (!ownerOk) return;

    const updateVis = publish ? "public" : (visibility || null);
    try {
      await withTickerReservationTransaction(pool, async (db) => {
        await db.query(
          "insert into campaign_draft_promotion (draft_id, mission_statement, roadmap, launch_strategy, telegram_url, discord_url, x_url, website_url, docs, creator_note, banner_url, share_message, published_at, updated_at) values ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,now()) on conflict (draft_id) do update set mission_statement = excluded.mission_statement, roadmap = excluded.roadmap, launch_strategy = excluded.launch_strategy, telegram_url = excluded.telegram_url, discord_url = excluded.discord_url, x_url = excluded.x_url, website_url = excluded.website_url, docs = excluded.docs, creator_note = excluded.creator_note, banner_url = excluded.banner_url, share_message = excluded.share_message, published_at = coalesce(excluded.published_at, campaign_draft_promotion.published_at), updated_at = now()",
          [id, promotion.missionStatement, JSON.stringify(promotion.roadmap), promotion.launchStrategy, promotion.telegramUrl, promotion.discordUrl, promotion.xUrl, promotion.websiteUrl, JSON.stringify(promotion.docs), promotion.creatorNote, promotion.bannerUrl, promotion.shareMessage, publish ? now : null],
        );
        await db.query("update campaign_drafts set visibility = coalesce($2, visibility), status = case when $3 then 'promotion_published' else status end, updated_at = now() where id = $1", [id, updateVis, publish]);
        if (publish) {
          await promoteTickerReservation(db, {
            draftId: id,
            creatorWallet: before.creator_wallet,
            chainId: Number(before.chain_id),
            cluster: body.cluster || body.networkCluster || "",
            ticker: before.ticker,
            publishedAt: new Date(now),
          });
        }
      });
    } catch (error) {
      if (error instanceof TickerReservationError || isTickerReservationConflict(error)) {
        return json(res, error.httpStatus || 409, { error: error.message, code: error.code });
      }
      throw error;
    }
    const updated = await getDraftBundleById(id, "", { bypassVisibility: true });

    if (publish && before.status !== "promotion_published" && updated?.draft) {
      await notifyDraftOwner(pool, updated.draft, {
        eventType: "publish",
        title: "Promotion page published",
        body: `$${updated.draft.ticker || before.ticker || "DRAFT"} is now visible in Prepare Mode.`,
        metadata: {
          target: `/prepare/${updated.draft.slug || before.slug}`,
          ticker: updated.draft.ticker || before.ticker,
        },
      });
    }

    return json(res, 200, updated);
  }

  return json(res, 503, { error: "Draft promotion edits require DATABASE_URL-backed wallet auth." });
}

export async function draftArchive(req, res) {
  if (!methodAllowed(req, res, ["POST", "DELETE"])) return;

  const id = String(req.params?.draftId || "");
  const body = await readJson(req);
  const pool = await getPool();

  if (!pool) return json(res, 503, { error: "Draft archive requires DATABASE_URL-backed wallet auth." });

  const exists = await pool.query("select id, creator_wallet, chain_id, status from campaign_drafts where id::text = $1 limit 1", [id]);
  if (!exists.rows.length) return json(res, 404, { error: "Draft not found" });

  const row = exists.rows[0];
  if (row.status === "deployed") return json(res, 409, { error: "Deployed drafts cannot be removed from Prepare Mode." });
  if (row.status === "archived") {
    const updated = await getDraftBundleById(id, "", { bypassVisibility: true });
    return json(res, 200, updated);
  }

  const ownerOk = await requireDraftActionAuth({
    res,
    pool,
    auth: body.auth,
    expectedWallet: row.creator_wallet,
    chainId: Number(row.chain_id),
    action: "archive_draft",
    draftId: id,
  });
  if (!ownerOk) return;

  try {
    await withTickerReservationTransaction(pool, async (db) => {
      await db.query("update campaign_drafts set status = 'archived', archived_at = now(), updated_at = now() where id::text = $1", [id]);
      await releaseTickerReservation(db, {
        draftId: id,
        creatorWallet: row.creator_wallet,
        reason: "Draft removed by creator; ticker returned to the chain availability pool.",
      });
    });
  } catch (error) {
    if (error instanceof TickerReservationError || isTickerReservationConflict(error)) {
      return json(res, error.httpStatus || 409, { error: error.message, code: error.code });
    }
    throw error;
  }
  const updated = await getDraftBundleById(id, "", { bypassVisibility: true });
  return json(res, 200, updated);
}

export async function draftFollow(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  const id = String(req.params?.draftId || "");
  const body = await readJson(req);
  const wallet = normalizeAddress(body.walletAddress || body.address);
  if (!wallet) return json(res, 400, { error: "Connect wallet to watchlist this draft." });

  const pool = await getPool();
  if (pool) {
    await pool.query("insert into campaign_draft_follows (draft_id, wallet_address) values ($1,$2) on conflict (draft_id, wallet_address) do nothing", [id, wallet]);
    const countRes = await pool.query("select count(*)::int as count from campaign_draft_follows where draft_id = $1", [id]);
    await pool
      .query(
        "insert into campaign_draft_metrics (draft_id, follows, signed_actions) values ($1, 1, 1) on conflict (draft_id) do update set follows = greatest(campaign_draft_metrics.follows, $2), signed_actions = campaign_draft_metrics.signed_actions + 1, updated_at = now()",
        [id, Number(countRes.rows[0]?.count || 0)],
      )
      .catch(() => {});
    return json(res, 200, { following: true, followCount: Number(countRes.rows[0]?.count || 0) });
  }

  const store = memoryStore();
  if (!store.drafts.has(id)) return json(res, 404, { error: "Draft not found" });
  const set = store.follows.get(id) || new Set();
  set.add(wallet);
  store.follows.set(id, set);
  const metrics = store.metrics.get(id) || { ...ZERO };
  metrics.follows = set.size;
  metrics.signedActions += 1;
  store.metrics.set(id, metrics);
  return json(res, 200, { following: true, followCount: set.size });
}

export async function draftComments(req, res) {
  if (!methodAllowed(req, res, ["GET", "POST"])) return;
  const id = String(req.params?.draftId || "");

  if (req.method === "GET") {
    const pool = await getPool();
    if (pool) {
      const result = await pool.query(
        `select c.*,
                up.display_name as author_display_name,
                up.avatar_url as author_avatar_url
           from campaign_draft_comments c
           left join campaign_drafts d on d.id = c.draft_id
           left join lateral (
             select p.display_name, p.avatar_url
               from public.user_profiles p
              where lower(p.address) = lower(c.wallet_address)
              order by
                case
                  when p.chain_id = d.chain_id then 0
                  when p.chain_id = 0 then 1
                  when p.chain_id in (56, 97) and d.chain_id in (56, 97) then 2
                  else 3
                end,
                p.updated_at desc nulls last
              limit 1
           ) up on true
          where c.draft_id = $1 and c.moderation_status = 'visible'
          order by c.created_at asc
          limit 120`,
        [id],
      );
      return json(res, 200, { items: nestComments(result.rows.map(mapCommentRow)) });
    }
    const store = memoryStore();
    return json(res, 200, { items: nestComments(store.comments.get(id) || []) });
  }

  const body = await readJson(req);
  const wallet = normalizeAddress(body.walletAddress || body.address);
  const commentBody = cleanText(body.body, 800);
  const parentCommentId = cleanText(body.parentCommentId, 80) || null;
  if (!wallet) return json(res, 400, { error: "Connect wallet to send a transmission." });
  if (!commentBody) return json(res, 400, { error: "Transmission body is required." });

  const bundle = await getDraftBundleById(id, "", { bypassVisibility: true });
  if (!bundle || bundle.forbidden) return json(res, 404, { error: "Draft not found" });
  if (parentCommentId && normalizeAddress(wallet, bundle.draft.chainId) !== normalizeAddress(bundle.draft.creatorWallet, bundle.draft.chainId)) {
    return json(res, 403, { error: "Only the creator can reply to transmissions." });
  }

  const pool = await getPool();
  if (pool) {
    const inserted = await pool.query("insert into campaign_draft_comments (draft_id, wallet_address, body, parent_comment_id) values ($1,$2,$3,$4) returning *", [id, wallet, commentBody, parentCommentId]);
    await pool
      .query(
        "insert into campaign_draft_metrics (draft_id, comments, signed_actions) values ($1, 1, 1) on conflict (draft_id) do update set comments = campaign_draft_metrics.comments + 1, signed_actions = campaign_draft_metrics.signed_actions + 1, updated_at = now()",
        [id],
      )
      .catch(() => {});
    return json(res, 201, { comment: mapCommentRow(inserted.rows[0]) });
  }

  const store = memoryStore();
  if (!store.drafts.has(id)) return json(res, 404, { error: "Draft not found" });
  const item = { id: randomUUID(), draftId: id, walletAddress: wallet, body: commentBody, parentCommentId, reactionCount: 0, createdAt: new Date().toISOString() };
  const comments = store.comments.get(id) || [];
  comments.push(item);
  store.comments.set(id, comments);
  const metrics = store.metrics.get(id) || { ...ZERO };
  metrics.comments += 1;
  metrics.signedActions += 1;
  store.metrics.set(id, metrics);
  return json(res, 201, { comment: item });
}
