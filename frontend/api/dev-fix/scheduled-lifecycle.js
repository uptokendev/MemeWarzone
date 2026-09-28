import { isSolanaChain } from "../../server/http.js";

const PUBLIC_LIFECYCLE_STATUSES = ["scheduled", "deployed"];

export async function getLifecyclePool() {
  if (!String(process.env.DATABASE_URL || "").trim()) return null;
  try {
    const mod = await import("../../server/db.js");
    return mod.pool || null;
  } catch (error) {
    console.warn("[scheduled-lifecycle] database unavailable", error?.message || error);
    return null;
  }
}

/**
 * Scheduled lifecycle transitions are intentionally not performed from read
 * handlers. A browser GET must never mutate a draft just because its local or
 * server clock has reached launchAt. Railway/indexer reconciliation owns the
 * authoritative scheduled -> deployed transition after chain state is
 * confirmed.
 *
 * The compatibility export remains so older imports cannot accidentally bring
 * the previous read-time mutation back while this branch is being deployed.
 */
export async function reconcileScheduledDraftLifecycle(_pool) {
  return 0;
}

function normalizeTicker(value) {
  return String(value || "")
    .trim()
    .replace(/^\$+/, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, 12);
}

function normalizeAddress(value, chainId) {
  const raw = String(value || "").trim();
  return isSolanaChain(chainId) ? raw : raw.toLowerCase();
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

export function canonicalDraftTimestamps(draft = {}, row = null) {
  const draftCreatedAt = iso(row?.created_at ?? draft.draftCreatedAt ?? draft.createdAt) || new Date().toISOString();
  const contractDeployedAt = iso(row?.deployed_at ?? draft.contractDeployedAt ?? draft.deployedAt);
  const scheduledLaunchAt = iso(row?.scheduled_launch_at ?? draft.scheduledLaunchAt);
  const tradingLaunchAt = scheduledLaunchAt || contractDeployedAt;
  return { draftCreatedAt, contractDeployedAt, scheduledLaunchAt, tradingLaunchAt };
}

export function augmentDraftLifecycle(draft, row = null) {
  if (!draft) return draft;
  const timestamps = canonicalDraftTimestamps(draft, row);
  const campaignAddress = row?.campaign_address ?? draft.campaignAddress ?? null;
  const status = String(row?.status ?? draft.status ?? "draft");

  return {
    ...draft,
    status,
    campaignAddress,
    tokenAddress: row?.token_address ?? draft.tokenAddress ?? null,
    deployTxHash: row?.deploy_tx_hash ?? draft.deployTxHash ?? null,
    scheduledLaunchAt: timestamps.scheduledLaunchAt,
    launchType: row?.launch_type ?? draft.launchType ?? "launchpad",
    draftCreatedAt: timestamps.draftCreatedAt,
    contractDeployedAt: timestamps.contractDeployedAt,
    tradingLaunchAt: timestamps.tradingLaunchAt,
    deployedAt: timestamps.contractDeployedAt,
    createdAt: timestamps.draftCreatedAt,
  };
}

export function mapLifecycleDraftRow(row) {
  if (!row) return null;
  const chainId = Number(row.chain_id ?? 97);
  const timestamps = canonicalDraftTimestamps({}, row);
  return augmentDraftLifecycle({
    id: String(row.id),
    chainId,
    creatorWallet: normalizeAddress(row.creator_wallet, chainId),
    name: String(row.name || ""),
    ticker: normalizeTicker(row.ticker),
    description: row.description || null,
    category: row.category || "meme",
    logoUrl: row.logo_url ?? null,
    websiteUrl: row.website_url ?? null,
    xUrl: row.x_url ?? null,
    otherUrl: row.other_url ?? null,
    slug: String(row.slug || ""),
    status: String(row.status || "draft"),
    visibility: String(row.visibility || "private"),
    campaignAddress: row.campaign_address ?? null,
    tokenAddress: row.token_address ?? null,
    deployTxHash: row.deploy_tx_hash ?? null,
    archivedAt: iso(row.archived_at),
    deployedAt: timestamps.contractDeployedAt,
    createdAt: timestamps.draftCreatedAt,
    updatedAt: iso(row.updated_at) || timestamps.draftCreatedAt,
  }, row);
}

export async function loadDraftRowsByIds(pool, ids) {
  const unique = Array.from(new Set((ids || []).map((id) => String(id || "")).filter(Boolean)));
  if (!pool || unique.length === 0) return new Map();
  const result = await pool.query(
    "select * from public.campaign_drafts where id::text = any($1::text[])",
    [unique],
  );
  return new Map(result.rows.map((row) => [String(row.id), row]));
}

export async function loadDraftRowById(pool, id) {
  if (!pool || !id) return null;
  const result = await pool.query(
    "select * from public.campaign_drafts where id::text = $1 limit 1",
    [String(id)],
  );
  return result.rows[0] || null;
}

export async function enrichDraftItems(pool, items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const rows = await loadDraftRowsByIds(pool, items.map((item) => item?.id));
  return items.map((item) => augmentDraftLifecycle(item, rows.get(String(item?.id || "")) || null));
}

export async function listPublicCampaignLifecycleDrafts(
  pool,
  { chainId = null, limit = 200, includeLaunched = true } = {},
) {
  if (!pool) return [];
  const statuses = includeLaunched ? PUBLIC_LIFECYCLE_STATUSES : ["scheduled"];
  const params = [statuses];
  // Include armed campaigns even when scheduled_launch_at was never backfilled
  // (legacy live drafts: status=scheduled + campaign_address set, timestamp null).
  const where = [
    "visibility = 'public'",
    "campaign_address is not null",
    "status = any($1::text[])",
  ];
  if (!includeLaunched) {
    where.push("(scheduled_launch_at is null or scheduled_launch_at > now())");
  }
  if (chainId) {
    params.push(Number(chainId));
    where.push(`chain_id = $${params.length}`);
  }
  params.push(Math.max(1, Math.min(500, Number(limit || 200))));
  const result = await pool.query(
    `select *
       from public.campaign_drafts
      where ${where.join(" and ")}
      order by coalesce(scheduled_launch_at, deployed_at, created_at) desc
      limit $${params.length}`,
    params,
  );
  return result.rows.map(mapLifecycleDraftRow).filter(Boolean);
}
