import baseHandler from "./campaigns-base.js";

import { pool } from "../server/db.js";
import { getQuery } from "../server/http.js";
import { runJsonTransform } from "./dev-fix/json-transform.js";
import { reconcileScheduledDraftLifecycle } from "./dev-fix/scheduled-lifecycle.js";

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

function matchesSearch(row, search) {
  const q = String(search || "").trim().toLowerCase();
  if (!q) return true;
  return [row.name, row.ticker, row.campaign_address, row.token_address, row.creator_wallet]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(q));
}

function lifecycleKey(chainId, campaignAddress) {
  const chain = Number(chainId);
  const addr = String(campaignAddress || "").trim();
  // Preserve Solana case in the map key.
  if (chain === 101 || chain === 102) return `${chain}:${addr}`;
  return `${chain}:${addr.toLowerCase()}`;
}

function applyLifecycle(item, row) {
  if (!row) return item;
  const draftCreatedAt = iso(row.created_at);
  const contractDeployedAt = iso(row.deployed_at) || item.createdAtChain || null;
  const scheduledLaunchAt = iso(row.scheduled_launch_at);
  const tradingLaunchAt = scheduledLaunchAt || item.createdAtChain || contractDeployedAt;
  return {
    ...item,
    draftCreatedAt,
    contractDeployedAt,
    scheduledLaunchAt,
    tradingLaunchAt,
    createdAtChain: tradingLaunchAt,
  };
}

function normalizeFeedAddress(value, chainId) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  // Solana base58 must keep case; EVM is case-insensitive.
  if (Number(chainId) === 101 || Number(chainId) === 102) return raw;
  return raw.toLowerCase();
}

function itemFromDraft(row) {
  const scheduledLaunchAt = iso(row.scheduled_launch_at);
  const contractDeployedAt = iso(row.deployed_at);
  const tradingLaunchAt = scheduledLaunchAt || contractDeployedAt;
  const chainId = Number(row.chain_id);
  return {
    chainId,
    campaignAddress: normalizeFeedAddress(row.campaign_address, chainId) || "",
    tokenAddress: normalizeFeedAddress(row.token_address, chainId),
    creatorAddress: normalizeFeedAddress(row.creator_wallet, chainId),
    name: row.name ?? null,
    symbol: row.ticker ?? null,
    logoUri: row.logo_url ?? null,
    website: row.website_url ?? null,
    xAccount: row.x_url ?? null,
    extraLink: row.other_url ?? null,
    draftCreatedAt: iso(row.created_at),
    contractDeployedAt,
    scheduledLaunchAt,
    tradingLaunchAt,
    createdAtChain: tradingLaunchAt,
    graduatedAtChain: null,
    isDexTrading: false,
    isActive: true,
    status: "live",
    lastActivityAt: null,
    lastPriceBnb: null,
    soldTokens: null,
    marketcapBnb: null,
    vol24hBnb: null,
    holderCount: 0,
    athMarketcapBnb: null,
    votes24h: 0,
    votesAllTime: 0,
    raisedTotalBnb: "0",
    raised10mBnb: "0",
    progressPct: 0,
    etaSec: null,
  };
}

async function loadPublicHiddenCampaignKeys(chainId) {
  const result = await pool.query(
    `select campaign_address
       from public.campaigns
      where chain_id = $1
        and campaign_address is not null
        and lower(coalesce(meta->>'publicHidden', 'false')) in ('true', '1', 'yes', 'on')`,
    [Number(chainId)],
  );
  return new Set(
    (result.rows || []).map((row) => lifecycleKey(chainId, row.campaign_address)),
  );
}

async function loadLifecycleRows(chainId, campaignAddresses, { includeUnindexedSolanaDrafts = false } = {}) {
  const chain = Number(chainId);
  const isSolana = chain === 101 || chain === 102;
  const addresses = Array.from(
    new Set(
      (campaignAddresses || [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .map((value) => (isSolana ? value : value.toLowerCase())),
    ),
  );
  // Only attach draft metadata for campaigns already in the indexer, unless
  // includeTestnet is on (legacy Solana path that promoted public deployed drafts).
  const queryArgs = isSolana ? [chain, addresses, includeUnindexedSolanaDrafts] : [chain, addresses];
  const result = await pool.query(
    isSolana
      ? `select *
           from public.campaign_drafts
          where chain_id = $1
            and campaign_address is not null
            and (
              campaign_address = any($2::text[])
              or (
                $3::bool
                and status = 'deployed'
                and visibility = 'public'
              )
            )
          order by updated_at desc`
      : `select *
           from public.campaign_drafts
          where chain_id = $1
            and campaign_address is not null
            and (
              lower(campaign_address) = any($2::text[])
              or (
                scheduled_launch_at is not null
                and scheduled_launch_at <= now()
                and status = 'deployed'
                and visibility = 'public'
              )
            )
          order by updated_at desc`,
    queryArgs,
  );

  const byCampaign = new Map();
  for (const row of result.rows) {
    const key = lifecycleKey(row.chain_id, row.campaign_address);
    if (!byCampaign.has(key)) byCampaign.set(key, row);
  }
  return { rows: result.rows, byCampaign };
}

export default async function handler(req, res) {
  await reconcileScheduledDraftLifecycle(pool);
  const query = getQuery(req);
  const chainId = Number(query.chainId || 56);
  const tab = String(query.tab || "trending").toLowerCase();
  const status = String(query.status || "all").toLowerCase();
  const sort = String(query.sort || "default").toLowerCase();
  const includeTestnet = ["1", "true", "yes", "on"].includes(String(query.includeTestnet || query.testnet || "").toLowerCase());

  return runJsonTransform(baseHandler, req, res, async (payload) => {
    if (!payload || !Array.isArray(payload.items)) return payload;

    const publicHidden = await loadPublicHiddenCampaignKeys(chainId);
    const visiblePayloadItems = payload.items.filter(
      (item) => !publicHidden.has(lifecycleKey(item.chainId ?? chainId, item.campaignAddress)),
    );

    const { rows, byCampaign } = await loadLifecycleRows(
      chainId,
      visiblePayloadItems.map((item) => item?.campaignAddress),
      { includeUnindexedSolanaDrafts: includeTestnet },
    );
    const now = Date.now();
    const seen = new Set();
    const items = [];

    for (const item of visiblePayloadItems) {
      const key = lifecycleKey(item.chainId ?? chainId, item.campaignAddress);
      if (publicHidden.has(key)) continue;
      const row = byCampaign.get(key);
      const scheduledMs = row?.scheduled_launch_at ? new Date(row.scheduled_launch_at).getTime() : NaN;
      if (Number.isFinite(scheduledMs) && scheduledMs > now) continue;
      seen.add(key);
      items.push(applyLifecycle(item, row));
    }

    const canAddLiveFallback = tab !== "dex" && status !== "graduated" && status !== "ended";
    if (canAddLiveFallback) {
      const solanaFeed = Number(chainId) === 101 || Number(chainId) === 102;
      for (const row of rows) {
        const key = lifecycleKey(row.chain_id, row.campaign_address);
        if (publicHidden.has(key)) continue;
        const scheduledMs = row?.scheduled_launch_at ? new Date(row.scheduled_launch_at).getTime() : NaN;
        const isFutureSchedule = Number.isFinite(scheduledMs) && scheduledMs > now;
        if (isFutureSchedule) continue;
        // BNB: only past-schedule draft arms (pre-existing behavior — indexer owns live rows).
        // Solana: also include immediately deployed public drafts (no full indexer yet).
        const isDeployedLiveSolana =
          includeTestnet &&
          solanaFeed &&
          String(row.status) === "deployed" &&
          String(row.visibility) === "public" &&
          Boolean(row.campaign_address);
        const isPastSchedule = Number.isFinite(scheduledMs) && scheduledMs <= now;
        if (!isDeployedLiveSolana && !isPastSchedule) continue;
        if (!matchesSearch(row, query.search)) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(itemFromDraft(row));
      }
    }

    if (tab === "new" || sort === "created_desc") {
      items.sort((a, b) => Date.parse(String(b.createdAtChain || 0)) - Date.parse(String(a.createdAtChain || 0)));
    } else if (sort === "created_asc") {
      items.sort((a, b) => Date.parse(String(a.createdAtChain || 0)) - Date.parse(String(b.createdAtChain || 0)));
    }

    return {
      ...payload,
      items,
      nextCursor: items.length ? payload.nextCursor : null,
      pageSize: items.length,
      updatedAt: new Date().toISOString(),
    };
  });
}
