import { pool } from "../../server/db.js";
import { badMethod, getQuery, isAddress, json, readJson } from "../../server/http.js";

const TIER_RULES = {
  New: { maxLiveBonding: 3, cooldownHours: 24, creatorBuyLockHours: 24, creatorBuyCapBnb: 0.25, maxClusterWallets: 3 },
  Trusted: { maxLiveBonding: 5, cooldownHours: 24, creatorBuyLockHours: 6, creatorBuyCapBnb: 1, maxClusterWallets: 5 },
  Proven: { maxLiveBonding: 10, cooldownHours: 24, creatorBuyLockHours: 1, creatorBuyCapBnb: 3, maxClusterWallets: 10 },
};

const CAMPAIGN_PAUSE_FIELDS = {
  paused: "paused",
  buyPaused: "buy_paused",
  sellPaused: "sell_paused",
  graduationPaused: "graduation_paused",
};

function methodAllowed(req, res, allowed) {
  if (allowed.includes(req.method)) return true;
  badMethod(res);
  return false;
}

function schemaMissing(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

function normalizeWallet(value) {
  const raw = String(value || "").trim().toLowerCase();
  return isAddress(raw) ? raw : "";
}

function normalizeTier(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "trusted") return "Trusted";
  if (raw === "proven") return "Proven";
  return "New";
}

function normalizeRiskLevel(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "high" || raw === "critical") return "high";
  if (raw === "medium" || raw === "watch") return "medium";
  return "low";
}

function parseBool(value) {
  return value === true || String(value || "").trim().toLowerCase() === "true";
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function addHours(value, hours) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function isFuture(value) {
  if (!value) return false;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() > Date.now();
}

function readJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function latestPaused(rows) {
  const payload = readJsonObject(rows?.[0]?.new_value);
  return parseBool(payload.paused);
}

function defaultCreator(walletAddress) {
  const tier = "New";
  const rules = TIER_RULES[tier];
  return {
    wallet: walletAddress,
    tier,
    trustScore: 0,
    liveBondingCount: 0,
    cooldownEndsAt: null,
    creatorBuyLockEndsAt: null,
    creatorBuyCapBnb: rules.creatorBuyCapBnb,
    clusterWallets: 0,
    restricted: false,
    manualReviewRequired: false,
    clusterId: null,
    source: "default",
  };
}

async function readCreatorProfile(walletAddress) {
  const wallet = normalizeWallet(walletAddress);
  if (!wallet) return { profile: null, schemaReady: true, error: "Invalid wallet address" };

  try {
    const { rows } = await pool.query(
      `select creator_wallet,
              tier,
              trust_score,
              live_bonding_count,
              last_launch_at,
              restricted,
              manual_review_required,
              cluster_id,
              updated_at
         from public.creator_profiles
        where creator_wallet = $1
        limit 1`,
      [wallet],
    );

    if (!rows[0]) return { profile: defaultCreator(wallet), schemaReady: true, error: null };

    const row = rows[0];
    const tier = normalizeTier(row.tier);
    const rules = TIER_RULES[tier];
    const cooldownEndsAt = addHours(row.last_launch_at, rules.cooldownHours);
    const creatorBuyLockEndsAt = addHours(row.last_launch_at, rules.creatorBuyLockHours);

    return {
      profile: {
        wallet,
        tier,
        trustScore: Number(row.trust_score || 0),
        liveBondingCount: Number(row.live_bonding_count || 0),
        cooldownEndsAt: toIso(cooldownEndsAt),
        creatorBuyLockEndsAt: toIso(creatorBuyLockEndsAt),
        creatorBuyCapBnb: rules.creatorBuyCapBnb,
        clusterWallets: 0,
        restricted: Boolean(row.restricted),
        manualReviewRequired: Boolean(row.manual_review_required),
        clusterId: row.cluster_id || null,
        updatedAt: toIso(row.updated_at),
        source: "creator_profiles",
      },
      schemaReady: true,
      error: null,
    };
  } catch (error) {
    if (schemaMissing(error)) return { profile: defaultCreator(wallet), schemaReady: false, error: "Security schema missing" };
    console.error("[security] creator profile lookup failed", error);
    return { profile: defaultCreator(wallet), schemaReady: false, error: "Creator profile lookup failed" };
  }
}

async function readWalletRisk(walletAddress) {
  const wallet = normalizeWallet(walletAddress);
  if (!wallet) return { risk: null, schemaReady: true, error: "Invalid wallet address" };

  try {
    const { rows } = await pool.query(
      `select wallet_address,
              risk_level,
              restricted,
              cluster_id,
              updated_at
         from public.wallet_risk_profiles
        where wallet_address = $1
        limit 1`,
      [wallet],
    );
    const row = rows[0];
    return {
      risk: row ? {
        walletAddress: wallet,
        riskLevel: normalizeRiskLevel(row.risk_level),
        restricted: Boolean(row.restricted),
        clusterId: row.cluster_id || null,
        updatedAt: toIso(row.updated_at),
      } : { walletAddress: wallet, riskLevel: "low", restricted: false, clusterId: null, updatedAt: null },
      schemaReady: true,
      error: null,
    };
  } catch (error) {
    if (schemaMissing(error)) {
      return {
        risk: { walletAddress: wallet, riskLevel: "low", restricted: false, clusterId: null, updatedAt: null },
        schemaReady: false,
        error: "Security schema missing",
      };
    }
    console.error("[security] wallet risk lookup failed", error);
    return {
      risk: { walletAddress: wallet, riskLevel: "low", restricted: false, clusterId: null, updatedAt: null },
      schemaReady: false,
      error: "Wallet risk lookup failed",
    };
  }
}

async function readCluster(clusterId) {
  if (!clusterId) return { cluster: null, schemaReady: true, error: null };
  try {
    const { rows } = await pool.query(
      `select cluster_id,
              wallet_count,
              risk_level,
              restricted,
              primary_signals,
              last_seen_at
         from public.wallet_clusters
        where cluster_id = $1
        limit 1`,
      [String(clusterId)],
    );
    const row = rows[0];
    return {
      cluster: row ? {
        id: String(row.cluster_id),
        wallets: Number(row.wallet_count || 0),
        riskLevel: normalizeRiskLevel(row.risk_level),
        restricted: Boolean(row.restricted),
        primarySignals: Array.isArray(row.primary_signals) ? row.primary_signals : [],
        lastSeenAt: toIso(row.last_seen_at),
      } : null,
      schemaReady: true,
      error: null,
    };
  } catch (error) {
    if (schemaMissing(error)) return { cluster: null, schemaReady: false, error: "Security schema missing" };
    console.error("[security] cluster lookup failed", error);
    return { cluster: null, schemaReady: false, error: "Cluster lookup failed" };
  }
}

// Founder 2026-10-10: one creator rule set on every launch chain. The creator tier limits (live bonding
// count, launch cooldown, cluster size) do not apply on BNB, Robinhood (gen-7 factories run without a
// CreatorRegistry: setRegistries(0x0, RiskRegistry)) or Solana (DBC). Restrictions, manual review and risk
// warnings stay. A chain not listed here keeps the tier limits.
export const OPEN_CREATOR_CHAIN_IDS = Object.freeze([56, 97, 4663, 46630, 101, 102]);

export function creatorTierLimitsApply(chainId) {
  const id = Number(chainId);
  return !(Number.isFinite(id) && OPEN_CREATOR_CHAIN_IDS.includes(id));
}

export function buildCreateEligibility({ creator, walletRisk, cluster, launchAt = null, chainId = null }) {
  const tierLimits = creatorTierLimitsApply(chainId);
  const rules = TIER_RULES[creator.tier] || TIER_RULES.New;
  const reasons = [];
  const warnings = [];
  const numericLaunchAt = Number(launchAt || 0);
  const evaluationAtMs = Number.isFinite(numericLaunchAt) && numericLaunchAt > 0
    ? (numericLaunchAt > 1e12 ? numericLaunchAt : numericLaunchAt * 1000)
    : Date.now();
  const cooldownEndsMs = creator.cooldownEndsAt ? new Date(creator.cooldownEndsAt).getTime() : NaN;

  if (creator.restricted) reasons.push("Creator is restricted.");
  if (creator.manualReviewRequired) reasons.push("Creator requires manual review.");
  if (tierLimits && creator.liveBondingCount >= rules.maxLiveBonding) reasons.push(`Creator has reached ${rules.maxLiveBonding} live bonding tokens for ${creator.tier}.`);
  if (tierLimits && Number.isFinite(cooldownEndsMs) && cooldownEndsMs > evaluationAtMs) {
    reasons.push(`Creator launch cooldown remains active at the selected launch time (${new Date(cooldownEndsMs).toISOString()}).`);
  }
  if (walletRisk?.restricted) reasons.push("Creator wallet is restricted.");
  if (cluster?.restricted) reasons.push("Creator wallet cluster is restricted.");
  if (tierLimits && cluster?.wallets > rules.maxClusterWallets) reasons.push(`Creator cluster has ${cluster.wallets} wallets; ${creator.tier} limit is ${rules.maxClusterWallets}.`);
  if (walletRisk?.riskLevel === "high") warnings.push("Creator wallet has high risk level.");
  if (cluster?.riskLevel === "high") warnings.push("Creator cluster has high risk level.");

  return {
    allowed: reasons.length === 0,
    reasons,
    warnings,
    tier: creator.tier,
    rules,
    creator,
    walletRisk,
    cluster,
    evaluationAt: new Date(evaluationAtMs).toISOString(),
  };
}

function buildTradeEligibility({ walletRisk, cluster, campaign }) {
  const reasons = [];
  const warnings = [];

  if (walletRisk?.restricted) reasons.push("Wallet is restricted.");
  if (cluster?.restricted) reasons.push("Wallet cluster is restricted.");
  if (campaign?.paused) reasons.push("Campaign is paused.");
  if (campaign?.buyPaused) warnings.push("Campaign buys are paused.");
  if (campaign?.sellPaused) warnings.push("Campaign sells are paused.");
  if (walletRisk?.riskLevel === "high") warnings.push("Wallet has high risk level.");
  if (cluster?.riskLevel === "high") warnings.push("Wallet cluster has high risk level.");

  return {
    allowed: reasons.length === 0,
    reasons,
    warnings,
    walletRisk,
    cluster,
    campaign,
  };
}

async function readCampaignSecurity(campaignAddress) {
  const campaign = normalizeWallet(campaignAddress);
  if (!campaign) return { campaign: null, schemaReady: true, error: null };
  try {
    const { rows } = await pool.query(
      `select campaign_address,
              creator_wallet,
              paused,
              buy_paused,
              sell_paused,
              graduation_paused,
              creator_buy_lock_until,
              creator_buy_cap_bnb,
              creator_bought_bnb,
              updated_at
         from public.campaign_security_states
        where campaign_address = $1
        limit 1`,
      [campaign],
    );
    const row = rows[0];
    return {
      campaign: row ? {
        campaignAddress: campaign,
        creatorWallet: row.creator_wallet || null,
        paused: Boolean(row.paused),
        buyPaused: Boolean(row.buy_paused),
        sellPaused: Boolean(row.sell_paused),
        graduationPaused: Boolean(row.graduation_paused),
        creatorBuyLockUntil: toIso(row.creator_buy_lock_until),
        creatorBuyCapBnb: Number(row.creator_buy_cap_bnb || 0),
        creatorBoughtBnb: Number(row.creator_bought_bnb || 0),
        updatedAt: toIso(row.updated_at),
      } : null,
      schemaReady: true,
      error: null,
    };
  } catch (error) {
    if (schemaMissing(error)) return { campaign: null, schemaReady: false, error: "Security schema missing" };
    console.error("[security] campaign security lookup failed", error);
    return { campaign: null, schemaReady: false, error: "Campaign security lookup failed" };
  }
}

async function readSecurityControlStatus() {
  const [factoryResult, solanaResult, campaignResult, syncResult] = await Promise.all([
    pool.query(
      `select new_value
         from public.security_actions
        where action in ('bnb_pause-factory', 'pause-factory')
        order by created_at desc
        limit 1`,
    ),
    pool.query(
      `select new_value
         from public.security_actions
        where action in ('solana_pause-global', 'pause-global')
        order by created_at desc
        limit 1`,
    ),
    pool.query(
      `select coalesce(bool_or(paused), false) as global_paused,
              coalesce(bool_or(buy_paused), false) as buy_paused,
              coalesce(bool_or(sell_paused), false) as sell_paused,
              coalesce(bool_or(graduation_paused), false) as graduation_paused
         from public.campaign_security_states`,
    ),
    pool.query(
      `select chain,
              count(*) filter (where status in ('queued', 'running'))::int as pending
         from public.contract_sync_jobs
        group by chain`,
    ),
  ]);

  const campaign = campaignResult.rows[0] || {};
  const sync = new Map(syncResult.rows.map((row) => [String(row.chain), Number(row.pending || 0)]));
  return {
    bnbFactoryPaused: latestPaused(factoryResult.rows),
    solanaGlobalPaused: latestPaused(solanaResult.rows),
    campaignPaused: Boolean(campaign.global_paused),
    buysPaused: Boolean(campaign.buy_paused),
    sellsPaused: Boolean(campaign.sell_paused),
    graduationPaused: Boolean(campaign.graduation_paused),
    bnbContractSync: (sync.get("bnb") || 0) > 0 ? "pending" : "synced",
    solanaProgramSync: (sync.get("solana") || 0) > 0 ? "pending" : "synced",
  };
}

async function updateCampaignPauseState(body) {
  const campaign = normalizeWallet(body.campaign || body.campaignAddress);
  const field = String(body.field || "").trim();
  const column = CAMPAIGN_PAUSE_FIELDS[field];
  if (!campaign || !column) return;

  await pool.query(
    `insert into public.campaign_security_states (campaign_address, ${column}, updated_at)
     values ($1, $2, now())
     on conflict (campaign_address) do update set ${column} = excluded.${column}, updated_at = now()`,
    [campaign, parseBool(body.paused)],
  );
}

async function queueContractSyncJob({ chain, action, target, payload = {} }) {
  await pool.query(
    `insert into public.contract_sync_jobs (chain, job_type, target, status, payload)
     values ($1, $2, $3, 'queued', $4::jsonb)`,
    [chain, action, String(target || action), JSON.stringify(payload || {})],
  );
}

async function readContractSyncJobs(chain) {
  const normalizedChain = String(chain || "").trim().toLowerCase();
  const chainFilter = normalizedChain === "bnb" || normalizedChain === "solana" ? normalizedChain : "";
  const { rows } = await pool.query(
    `select id,
            chain,
            job_type,
            target,
            status,
            tx_hash,
            error,
            payload,
            created_at,
            updated_at
       from public.contract_sync_jobs
      where ($1 = '' or chain = $1)
      order by created_at desc
      limit 100`,
    [chainFilter],
  );

  return rows.map((row) => ({
    id: String(row.id),
    chain: String(row.chain),
    jobType: row.job_type || "sync",
    target: row.target || "",
    status: row.status || "queued",
    txHash: row.tx_hash || null,
    error: row.error || null,
    payload: row.payload || {},
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }));
}

async function securityContractSyncJobs(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  try {
    const jobs = await readContractSyncJobs(getQuery(req).chain);
    return json(res, 200, jobs);
  } catch (error) {
    if (!schemaMissing(error)) console.error("[security] contract sync jobs failed", error);
    return json(res, 200, []);
  }
}

export async function evaluateCreatePreflight({ walletAddress, launchAt = null, chainId = null }) {
  const wallet = normalizeWallet(walletAddress);
  if (!wallet) return { allowed: false, reasons: ["Invalid or missing wallet address."], warnings: [], schemaReady: true };

  const creatorResult = await readCreatorProfile(wallet);
  const riskResult = await readWalletRisk(wallet);
  const clusterId = creatorResult.profile?.clusterId || riskResult.risk?.clusterId || null;
  const clusterResult = await readCluster(clusterId);
  const creator = { ...creatorResult.profile, clusterWallets: clusterResult.cluster?.wallets || 0 };
  const eligibility = buildCreateEligibility({ creator, walletRisk: riskResult.risk, cluster: clusterResult.cluster, launchAt, chainId });

  return {
    ...eligibility,
    schemaReady: creatorResult.schemaReady && riskResult.schemaReady && clusterResult.schemaReady,
    lookupErrors: [creatorResult.error, riskResult.error, clusterResult.error].filter(Boolean),
  };
}

export async function evaluateTradePreflight({ walletAddress, campaignAddress }) {
  const wallet = normalizeWallet(walletAddress);
  if (!wallet) return { allowed: false, reasons: ["Invalid or missing wallet address."], warnings: [], schemaReady: true };

  const riskResult = await readWalletRisk(wallet);
  const clusterResult = await readCluster(riskResult.risk?.clusterId || null);
  const campaignResult = await readCampaignSecurity(campaignAddress);
  const eligibility = buildTradeEligibility({ walletRisk: riskResult.risk, cluster: clusterResult.cluster, campaign: campaignResult.campaign });

  return {
    ...eligibility,
    schemaReady: riskResult.schemaReady && clusterResult.schemaReady && campaignResult.schemaReady,
    lookupErrors: [riskResult.error, clusterResult.error, campaignResult.error].filter(Boolean),
  };
}

export async function launchpadPreflightCreate(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  const body = await readJson(req);
  const walletAddress = normalizeWallet(body.walletAddress || body.creatorWallet || body.creator);
  const preflight = await evaluateCreatePreflight({ walletAddress, launchAt: body.launchAt || body.scheduledLaunchAt || null, chainId: body.chainId ?? null });
  return json(res, preflight.allowed ? 200 : 403, { preflight });
}

export async function launchpadPreflightBuy(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  const body = await readJson(req);
  const preflight = await evaluateTradePreflight({ walletAddress: body.walletAddress, campaignAddress: body.campaignAddress });
  if (preflight.campaign?.buyPaused) {
    preflight.allowed = false;
    preflight.reasons = [...preflight.reasons, "Campaign buys are paused."];
  }
  return json(res, preflight.allowed ? 200 : 403, { preflight });
}

export async function launchpadPreflightSell(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  const body = await readJson(req);
  const preflight = await evaluateTradePreflight({ walletAddress: body.walletAddress, campaignAddress: body.campaignAddress });
  if (preflight.campaign?.sellPaused) {
    preflight.allowed = false;
    preflight.reasons = [...preflight.reasons, "Campaign sells are paused."];
  }
  return json(res, preflight.allowed ? 200 : 403, { preflight });
}

export async function securityCreatorProfile(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  const walletAddress = normalizeWallet(req.params?.wallet || getQuery(req).walletAddress);
  const result = await readCreatorProfile(walletAddress);
  return json(res, result.profile ? 200 : 400, { profile: result.profile, schemaReady: result.schemaReady, error: result.error });
}

export async function securityCreatorLaunchEligibility(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  const walletAddress = normalizeWallet(req.params?.wallet || getQuery(req).walletAddress);
  const query = getQuery(req);
  const preflight = await evaluateCreatePreflight({ walletAddress, launchAt: query.launchAt || null, chainId: query.chainId ?? null });
  return json(res, preflight.allowed ? 200 : 403, { preflight });
}

export async function securityStatus(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  try {
    const [{ rows: reviews }, { rows: creators }, { rows: wallets }, { rows: clusters }, { rows: mass }, controls] = await Promise.all([
      pool.query("select count(*)::int as count from public.manual_review_queue where status = 'open'"),
      pool.query("select count(*)::int as count from public.creator_profiles where restricted = true"),
      pool.query("select count(*)::int as count from public.wallet_risk_profiles where restricted = true"),
      pool.query("select count(*)::int as count from public.wallet_clusters where risk_level in ('medium','high') or restricted = true"),
      pool.query("select count(*)::int as count from public.mass_deployer_flags where action in ('manual_review','restricted')"),
      readSecurityControlStatus(),
    ]);

    return json(res, 200, {
      globalRiskStatus: Number(mass[0]?.count || 0) > 0 || Number(clusters[0]?.count || 0) > 0 ? "watch" : "normal",
      openManualReviews: Number(reviews[0]?.count || 0),
      restrictedCreators: Number(creators[0]?.count || 0),
      restrictedWallets: Number(wallets[0]?.count || 0),
      suspiciousClusters: Number(clusters[0]?.count || 0),
      massDeployerAlerts: Number(mass[0]?.count || 0),
      bnbContractSync: controls.bnbContractSync,
      solanaProgramSync: controls.solanaProgramSync,
      backendSignerStatus: "unknown",
      routeAuthorityStatus: "unknown",
      paused: {
        global: controls.bnbFactoryPaused || controls.campaignPaused || controls.solanaGlobalPaused,
        create: controls.bnbFactoryPaused,
        buys: controls.buysPaused,
        sells: controls.sellsPaused,
        graduation: controls.graduationPaused,
      },
    });
  } catch (error) {
    if (!schemaMissing(error)) console.error("[security] status failed", error);
    return json(res, 200, {
      globalRiskStatus: "watch",
      openManualReviews: 0,
      restrictedCreators: 0,
      restrictedWallets: 0,
      suspiciousClusters: 0,
      massDeployerAlerts: 0,
      bnbContractSync: "unknown",
      solanaProgramSync: "unknown",
      backendSignerStatus: "unknown",
      routeAuthorityStatus: "unknown",
      paused: { global: false, create: false, buys: false, sells: false, graduation: false },
      schemaReady: false,
    });
  }
}

export async function securityCreators(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  try {
    const { rows } = await pool.query(
      `select creator_wallet from public.creator_profiles order by updated_at desc nulls last limit 100`,
    );
    const profiles = [];
    for (const row of rows) {
      const { profile } = await readCreatorProfile(row.creator_wallet);
      if (profile) profiles.push(profile);
    }
    return json(res, 200, profiles);
  } catch (error) {
    if (!schemaMissing(error)) console.error("[security] creators failed", error);
    return json(res, 200, []);
  }
}

export async function securityClusters(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  try {
    const { rows } = await pool.query(
      `select cluster_id, wallet_count, risk_level, restricted, primary_signals, last_seen_at
         from public.wallet_clusters
        order by restricted desc, risk_level desc, last_seen_at desc nulls last
        limit 100`,
    );
    return json(res, 200, rows.map((row) => ({
      id: String(row.cluster_id),
      wallets: Number(row.wallet_count || 0),
      riskLevel: normalizeRiskLevel(row.risk_level),
      restricted: Boolean(row.restricted),
      primarySignals: Array.isArray(row.primary_signals) ? row.primary_signals : [],
      lastSeenAt: toIso(row.last_seen_at),
    })));
  } catch (error) {
    if (!schemaMissing(error)) console.error("[security] clusters failed", error);
    return json(res, 200, []);
  }
}

export async function securityManualReview(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  try {
    const { rows } = await pool.query(
      `select id, creator_wallet, reason, priority, status, created_at
         from public.manual_review_queue
        where status = 'open'
        order by case priority when 'high' then 1 when 'medium' then 2 else 3 end, created_at asc
        limit 100`,
    );
    return json(res, 200, rows.map((row) => ({
      id: String(row.id),
      creatorWallet: row.creator_wallet,
      reason: row.reason || "Manual review required",
      priority: row.priority || "medium",
      status: row.status || "open",
      createdAt: toIso(row.created_at),
    })));
  } catch (error) {
    if (!schemaMissing(error)) console.error("[security] manual review failed", error);
    return json(res, 200, []);
  }
}

export async function securityMassDeployers(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  try {
    const { rows } = await pool.query(
      `select id, wallet_address, launches_24h, failed_tokens, repeated_metadata, action
         from public.mass_deployer_flags
        order by updated_at desc nulls last
        limit 100`,
    );
    return json(res, 200, rows.map((row) => ({
      id: String(row.id),
      wallet: row.wallet_address,
      launches24h: Number(row.launches_24h || 0),
      failedTokens: Number(row.failed_tokens || 0),
      repeatedMetadata: Number(row.repeated_metadata || 0),
      action: row.action || "watch",
    })));
  } catch (error) {
    if (!schemaMissing(error)) console.error("[security] mass deployers failed", error);
    return json(res, 200, []);
  }
}

export async function securityAuditLog(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  try {
    const { rows } = await pool.query(
      `select id, admin_email, action, target, old_value, new_value, reason, tx_hash, created_at
         from public.security_actions
        order by created_at desc
        limit 100`,
    );
    return json(res, 200, rows.map((row) => ({
      id: String(row.id),
      adminEmail: row.admin_email || "unknown",
      action: row.action,
      target: row.target,
      oldValue: row.old_value || "",
      newValue: row.new_value || "",
      reason: row.reason || "",
      txHash: row.tx_hash || null,
      timestamp: toIso(row.created_at),
    })));
  } catch (error) {
    if (!schemaMissing(error)) console.error("[security] audit log failed", error);
    return json(res, 200, []);
  }
}

async function recordSecurityAction({ req, action, target, oldValue = "", newValue = "", reason, txHash = null }) {
  const adminEmail = String(req.apiAuth?.admin?.email || req.headers["x-admin-email"] || req.headers["x-user-email"] || "unknown").trim() || "unknown";
  await pool.query(
    `insert into public.security_actions (admin_email, action, target, old_value, new_value, reason, tx_hash)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [adminEmail, action, String(target || ""), String(oldValue || ""), String(newValue || ""), String(reason || ""), txHash],
  );
}

function schemaMissingAction(res) {
  return json(res, 503, { error: "Security schema is not installed.", code: "SECURITY_SCHEMA_MISSING" });
}

export async function securityCreatorTier(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  const body = await readJson(req);
  const wallet = normalizeWallet(req.params?.wallet || body.walletAddress);
  const tier = normalizeTier(body.tier);
  if (!wallet) return json(res, 400, { error: "Invalid or missing wallet" });
  try {
    await pool.query(
      `insert into public.creator_profiles (creator_wallet, tier, updated_at)
       values ($1, $2, now())
       on conflict (creator_wallet) do update set tier = excluded.tier, updated_at = now()`,
      [wallet, tier],
    );
    await queueContractSyncJob({ chain: "bnb", action: "set-creator-tier", target: wallet, payload: { walletAddress: wallet, tier } });
    await recordSecurityAction({ req, action: "set_creator_tier", target: wallet, newValue: tier, reason: body.reason });
    return json(res, 200, { ok: true, wallet, tier, queued: true });
  } catch (error) {
    if (schemaMissing(error)) return schemaMissingAction(res);
    throw error;
  }
}

export async function securityCreatorRestrict(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  const body = await readJson(req);
  const wallet = normalizeWallet(req.params?.wallet || body.walletAddress);
  const restricted = parseBool(body.restricted);
  if (!wallet) return json(res, 400, { error: "Invalid or missing wallet" });
  try {
    await pool.query(
      `insert into public.creator_profiles (creator_wallet, restricted, updated_at)
       values ($1, $2, now())
       on conflict (creator_wallet) do update set restricted = excluded.restricted, updated_at = now()`,
      [wallet, restricted],
    );
    if (restricted) {
      await pool.query(
        `update public.manual_review_queue
            set status = 'restricted',
                updated_at = now()
          where creator_wallet = $1
            and status = 'open'`,
        [wallet],
      );
    }
    await queueContractSyncJob({ chain: "bnb", action: "set-creator-restricted", target: wallet, payload: { walletAddress: wallet, restricted } });
    await recordSecurityAction({ req, action: "set_creator_restricted", target: wallet, newValue: String(restricted), reason: body.reason });
    return json(res, 200, { ok: true, wallet, restricted, queued: true });
  } catch (error) {
    if (schemaMissing(error)) return schemaMissingAction(res);
    throw error;
  }
}

export async function securityCreatorManualReview(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  const body = await readJson(req);
  const wallet = normalizeWallet(req.params?.wallet || body.walletAddress);
  const required = parseBool(body.required);
  if (!wallet) return json(res, 400, { error: "Invalid or missing wallet" });
  try {
    await pool.query(
      `insert into public.creator_profiles (creator_wallet, manual_review_required, updated_at)
       values ($1, $2, now())
       on conflict (creator_wallet) do update set manual_review_required = excluded.manual_review_required, updated_at = now()`,
      [wallet, required],
    );
    if (required) {
      await pool.query(
        `insert into public.manual_review_queue (creator_wallet, reason, priority, status)
         values ($1, $2, $3, 'open')`,
        [wallet, String(body.reason || "Manual review required"), String(body.priority || "medium")],
      );
    } else {
      await pool.query(
        `update public.manual_review_queue
            set status = 'approved',
                updated_at = now()
          where creator_wallet = $1
            and status = 'open'`,
        [wallet],
      );
    }
    await queueContractSyncJob({ chain: "bnb", action: "set-creator-manual-review", target: wallet, payload: { walletAddress: wallet, required } });
    await recordSecurityAction({ req, action: "set_creator_manual_review", target: wallet, newValue: String(required), reason: body.reason });
    return json(res, 200, { ok: true, wallet, required, queued: true });
  } catch (error) {
    if (schemaMissing(error)) return schemaMissingAction(res);
    throw error;
  }
}

export async function securityClusterRestrict(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  const body = await readJson(req);
  const clusterId = String(req.params?.clusterId || body.clusterId || "").trim();
  const restricted = parseBool(body.restricted);
  if (!clusterId) return json(res, 400, { error: "Invalid or missing clusterId" });
  try {
    await pool.query(
      `insert into public.wallet_clusters (cluster_id, restricted, updated_at)
       values ($1, $2, now())
       on conflict (cluster_id) do update set restricted = excluded.restricted, updated_at = now()`,
      [clusterId, restricted],
    );
    await queueContractSyncJob({ chain: "bnb", action: "set-cluster-restricted", target: clusterId, payload: { clusterId, restricted } });
    await recordSecurityAction({ req, action: "set_cluster_restricted", target: clusterId, newValue: String(restricted), reason: body.reason });
    return json(res, 200, { ok: true, clusterId, restricted, queued: true });
  } catch (error) {
    if (schemaMissing(error)) return schemaMissingAction(res);
    throw error;
  }
}

export async function securityWalletRestrict(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  const body = await readJson(req);
  const wallet = normalizeWallet(req.params?.wallet || body.walletAddress);
  const restricted = parseBool(body.restricted);
  if (!wallet) return json(res, 400, { error: "Invalid or missing wallet" });
  try {
    await pool.query(
      `insert into public.wallet_risk_profiles (wallet_address, restricted, updated_at)
       values ($1, $2, now())
       on conflict (wallet_address) do update set restricted = excluded.restricted, updated_at = now()`,
      [wallet, restricted],
    );
    await queueContractSyncJob({ chain: "bnb", action: "set-wallet-restricted", target: wallet, payload: { walletAddress: wallet, restricted } });
    await recordSecurityAction({ req, action: "set_wallet_restricted", target: wallet, newValue: String(restricted), reason: body.reason });
    return json(res, 200, { ok: true, wallet, restricted, queued: true });
  } catch (error) {
    if (schemaMissing(error)) return schemaMissingAction(res);
    throw error;
  }
}

export async function securityContractAction(req, res) {
  const rawAction = String(req.params?.action || "contract_action");
  if (req.method === "GET" && rawAction === "sync-jobs") return securityContractSyncJobs(req, res);
  if (!methodAllowed(req, res, ["POST"])) return;
  const body = await readJson(req);
  const isSolana = String(req.originalUrl || req.url || "").includes("/security/solana/");
  const chain = isSolana ? "solana" : "bnb";
  const action = `${chain}_${rawAction}`;
  const target = body.wallet || body.walletAddress || body.target || body.campaign || body.campaignAddress || body.clusterId || rawAction;
  try {
    if (!isSolana && rawAction === "pause-campaign") {
      await updateCampaignPauseState(body);
    }
    await queueContractSyncJob({ chain, action: rawAction, target, payload: body });
    await recordSecurityAction({ req, action, target, newValue: JSON.stringify(body), reason: body.reason });
    return json(res, 200, { ok: true, queued: true, action, target });
  } catch (error) {
    if (schemaMissing(error)) return schemaMissingAction(res);
    throw error;
  }
}
