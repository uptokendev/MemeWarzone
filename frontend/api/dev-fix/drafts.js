import * as base from "./drafts-base.js";
export * from "./drafts-base.js";

import { getQuery, json } from "../../server/http.js";
import { runJsonTransform } from "./json-transform.js";
import { resolveRobinhoodStockGraduationAsset } from "./robinhoodStockCreatePolicy.js";
import {
  augmentDraftLifecycle,
  enrichDraftItems,
  getLifecyclePool,
  listPublicCampaignLifecycleDrafts,
  loadDraftRowById,
  reconcileScheduledDraftLifecycle,
} from "./scheduled-lifecycle.js";
import {
  loadTickerReservationByDraft,
  loadTickerReservationsByDraftIds,
} from "./ticker-reservation-service.js";

const ROBINHOOD_CHAIN_IDS = new Set([4663, 46630]);
const ROBINHOOD_MARKET_POLICY_VERSION = "robinhood_market_v1";

function requestBody(req) {
  if (req?.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req?.body === "string" && req.body.trim()) {
    try {
      return JSON.parse(req.body);
    } catch {}
  }
  return {};
}

function normalizeDraftPolicyRow(row, chainId) {
  const cid = Number(chainId);
  if (!ROBINHOOD_CHAIN_IDS.has(cid)) return null;
  if (!row) {
    return {
      graduationMarketKind: "NATIVE",
      graduationQuoteAsset: null,
      graduationMarketPolicyVersion: ROBINHOOD_MARKET_POLICY_VERSION,
    };
  }
  return {
    graduationMarketKind: String(row.market_kind || "NATIVE").toUpperCase() === "STOCK_TOKEN" ? "STOCK_TOKEN" : "NATIVE",
    graduationQuoteAsset: row.quote_asset || null,
    graduationMarketPolicyVersion: String(row.policy_version || ROBINHOOD_MARKET_POLICY_VERSION),
  };
}

async function loadDraftGraduationPolicies(pool, draftIds) {
  const ids = Array.from(new Set((draftIds || []).map((id) => String(id || "")).filter(Boolean)));
  const policies = new Map();
  if (!pool || !ids.length) return policies;
  try {
    const result = await pool.query(
      `select draft_id::text as draft_id, chain_id, market_kind, quote_asset, policy_version
         from public.campaign_draft_graduation_market_policy
        where draft_id::text = any($1::text[])`,
      [ids],
    );
    for (const row of result.rows) policies.set(String(row.draft_id), row);
  } catch (error) {
    if (error?.code !== "42P01" && error?.code !== "42703") throw error;
  }
  return policies;
}

function attachDraftPolicy(draft, row) {
  if (!draft) return draft;
  const policy = normalizeDraftPolicyRow(row, draft.chainId ?? draft.chain_id);
  return policy ? { ...draft, ...policy } : draft;
}

async function persistDraftGraduationPolicy(pool, draftId, body) {
  if (!pool) throw new Error("Draft Graduation Market requires DATABASE_URL-backed persistence.");
  const marketKind = String(body.graduationMarketKind || body.graduation_market_kind || "").trim().toUpperCase();
  if (!marketKind) return null;
  if (marketKind !== "NATIVE" && marketKind !== "STOCK_TOKEN") {
    throw new Error("Graduation Market must be NATIVE or STOCK_TOKEN.");
  }

  const draftResult = await pool.query(
    "select id::text as id, chain_id, status from public.campaign_drafts where id::text=$1 limit 1",
    [String(draftId)],
  );
  const draft = draftResult.rows[0];
  if (!draft) throw new Error("Draft not found while saving Graduation Market.");
  const chainId = Number(draft.chain_id);
  if (!ROBINHOOD_CHAIN_IDS.has(chainId)) {
    throw new Error("Graduation Market policy is Robinhood-only.");
  }
  if (String(draft.status || "").toLowerCase() === "deployed") {
    throw new Error("Graduation Market is locked after deployment.");
  }

  let quoteAsset = null;
  if (marketKind === "STOCK_TOKEN") {
    const requested = String(body.graduationQuoteAsset || body.stockToken || "").trim();
    const policyChainId = chainId === 4663 ? 4663 : 46630;
    const registryRaw = process.env[`ROBINHOOD_STOCK_TOKEN_REGISTRY_${policyChainId}`] || "[]";
    const asset = resolveRobinhoodStockGraduationAsset({ chainId, stockToken: requested, rawRegistry: registryRaw });
    quoteAsset = asset.contractAddress;
  }

  const result = await pool.query(
    `insert into public.campaign_draft_graduation_market_policy(
       draft_id,chain_id,market_kind,quote_asset,policy_version,updated_at
     ) values($1::uuid,$2,$3,$4,$5,now())
     on conflict(draft_id) do update set
       chain_id=excluded.chain_id,
       market_kind=excluded.market_kind,
       quote_asset=excluded.quote_asset,
       policy_version=excluded.policy_version,
       updated_at=now()
     returning draft_id::text as draft_id,chain_id,market_kind,quote_asset,policy_version`,
    [String(draftId), chainId, marketKind, quoteAsset, ROBINHOOD_MARKET_POLICY_VERSION],
  );
  return result.rows[0] || null;
}

async function enrichPayload(payload, pool) {
  if (!payload || typeof payload !== "object") return payload;

  if (Array.isArray(payload.items)) {
    const items = await enrichDraftItems(pool, payload.items);
    if (!pool) return { ...payload, items };
    const ids = items.map((item) => item.id);
    const [reservations, policies] = await Promise.all([
      loadTickerReservationsByDraftIds(pool, ids),
      loadDraftGraduationPolicies(pool, ids),
    ]);
    return {
      ...payload,
      items: items.map((item) => ({
        ...attachDraftPolicy(item, policies.get(String(item.id))),
        tickerReservation: reservations.get(String(item.id)) || null,
      })),
    };
  }

  if (payload.draft?.id) {
    const row = await loadDraftRowById(pool, payload.draft.id);
    const [tickerReservation, policies] = await Promise.all([
      pool ? loadTickerReservationByDraft(pool, payload.draft.id, { includeReleased: true }) : null,
      loadDraftGraduationPolicies(pool, [payload.draft.id]),
    ]);
    return {
      ...payload,
      draft: {
        ...attachDraftPolicy(augmentDraftLifecycle(payload.draft, row), policies.get(String(payload.draft.id))),
        tickerReservation,
      },
    };
  }

  return payload;
}

function scheduledLaunchSeconds(item) {
  const raw = item?.scheduledLaunchAt ?? item?.tradingLaunchAt ?? item?.scheduled_launch_at ?? null;
  if (raw == null || raw === "") return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
  }
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function belongsInDraftSection(item, nowMs = Date.now()) {
  const status = String(item?.status || "draft");
  if (status === "deployed") return false;

  if (status === "scheduled") {
    const campaignAddress = String(item?.campaignAddress || item?.campaign_address || "").trim();
    if (campaignAddress) {
      const launchAt = scheduledLaunchSeconds(item);
      const nowSec = Math.floor(nowMs / 1000);
      if (!launchAt || launchAt <= nowSec) return false;
    }
  }

  return true;
}

function mergeDraftItems(primary, lifecycle) {
  const byId = new Map();
  for (const item of [...(primary || []), ...(lifecycle || [])]) {
    const id = String(item?.id || "");
    if (!id) continue;
    byId.set(id, { ...(byId.get(id) || {}), ...item });
  }
  return Array.from(byId.values()).sort((a, b) =>
    String(b.draftCreatedAt || b.createdAt || "").localeCompare(String(a.draftCreatedAt || a.createdAt || "")),
  );
}

async function runLifecycleWrapped(handler, req, res) {
  const pool = await getLifecyclePool();
  await reconcileScheduledDraftLifecycle(pool);
  return runJsonTransform(handler, req, res, (payload) => enrichPayload(payload, pool));
}

export async function drafts(req, res) {
  const query = getQuery(req);
  const lifecycleMode = req.method === "GET" && String(query.lifecycle || "").toLowerCase() === "campaign";

  if (lifecycleMode) {
    const pool = await getLifecyclePool();
    if (!pool) return json(res, 200, { items: [] });
    const chainId = query.chainId ? Number(query.chainId) : null;
    const limit = Math.max(1, Math.min(500, Number(query.limit || 200) || 200));
    const items = await listPublicCampaignLifecycleDrafts(pool, { chainId, limit, includeLaunched: true });
    const policies = await loadDraftGraduationPolicies(pool, items.map((item) => item.id));
    return json(res, 200, {
      items: items.map((item) => attachDraftPolicy(item, policies.get(String(item.id)))),
    });
  }

  const pool = await getLifecyclePool();
  await reconcileScheduledDraftLifecycle(pool);
  const body = requestBody(req);
  const wantsGraduationPolicy = req.method === "POST" && Boolean(
    String(body.graduationMarketKind || body.graduation_market_kind || "").trim(),
  );

  return runJsonTransform(base.drafts, req, res, async (payload, meta) => {
    let enriched = await enrichPayload(payload, pool);

    if (
      wantsGraduationPolicy &&
      meta.statusCode >= 200 &&
      meta.statusCode < 300 &&
      enriched?.draft?.id
    ) {
      try {
        const policyRow = await persistDraftGraduationPolicy(pool, enriched.draft.id, body);
        if (policyRow) {
          enriched = {
            ...enriched,
            graduationMarketPolicyPersisted: true,
            draft: attachDraftPolicy(enriched.draft, policyRow),
          };
        }
      } catch (error) {
        enriched = {
          ...enriched,
          graduationMarketPolicyPersisted: false,
          graduationMarketPolicyError: String(error?.message || error || "Graduation Market policy could not be saved."),
        };
      }
    }

    if (!Array.isArray(enriched?.items)) return enriched;

    const nowMs = Date.now();
    const draftItems = enriched.items.filter((item) => belongsInDraftSection(item, nowMs));
    const isPublicList = req.method === "GET" && !String(query.owner || "").trim();
    if (!isPublicList || !pool) return { ...enriched, items: draftItems };

    const chainId = query.chainId ? Number(query.chainId) : null;
    const limit = Math.max(1, Math.min(500, Number(query.limit || 50) || 50));
    const lifecycleItems = await listPublicCampaignLifecycleDrafts(pool, {
      chainId,
      limit,
      includeLaunched: false,
    });
    const policies = await loadDraftGraduationPolicies(pool, lifecycleItems.map((item) => item.id));
    const enrichedLifecycle = lifecycleItems.map((item) => attachDraftPolicy(item, policies.get(String(item.id))));

    return {
      ...enriched,
      items: mergeDraftItems(draftItems, enrichedLifecycle)
        .filter((item) => belongsInDraftSection(item, nowMs))
        .slice(0, limit),
    };
  });
}

export async function draftById(req, res) {
  return runLifecycleWrapped(base.draftById, req, res);
}

export async function prepareBySlug(req, res) {
  return runLifecycleWrapped(base.prepareBySlug, req, res);
}

export async function draftPromotion(req, res) {
  const pool = await getLifecyclePool();
  await reconcileScheduledDraftLifecycle(pool);
  const body = requestBody(req);
  const wantsGraduationPolicy = Boolean(String(body.graduationMarketKind || body.graduation_market_kind || "").trim());

  return runJsonTransform(base.draftPromotion, req, res, async (payload, meta) => {
    let next = await enrichPayload(payload, pool);
    if (!wantsGraduationPolicy || meta.statusCode < 200 || meta.statusCode >= 300) return next;

    try {
      const policyRow = await persistDraftGraduationPolicy(pool, String(req.params?.draftId || ""), body);
      if (policyRow && next?.draft) {
        next = {
          ...next,
          graduationMarketPolicyPersisted: true,
          draft: attachDraftPolicy(next.draft, policyRow),
        };
      }
      return next;
    } catch (error) {
      return {
        ...next,
        graduationMarketPolicyPersisted: false,
        graduationMarketPolicyError: String(error?.message || error || "Graduation Market policy could not be saved."),
      };
    }
  });
}

export async function draftArchive(req, res) {
  return runLifecycleWrapped(base.draftArchive, req, res);
}

export const robinhoodDraftGraduationPolicyInternals = {
  normalizeDraftPolicyRow,
  attachDraftPolicy,
};
