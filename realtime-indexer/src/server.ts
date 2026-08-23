import express from "express";
import cors from "cors";
import { ENV } from "./env.js";
import "dotenv/config";
import { pool } from "./db.js";
import { ablyRest, tokenChannel, leagueChannel, publishUserRankUpdated } from "./ably.js";
import { ingestCampaignTransaction, runDiscoveryOnce, runIndexerOnce, runRepairOnce, runTipScanOnce, runTradeRepairOnce } from "./indexer.js";
import { startTelemetryReporter, type TelemetrySnapshot } from "./telemetry.js";
import { applyRecruiterDisputeOverride, captureReferralWindow, createOrUpdateRecruiter, getWalletAttributionState, linkWalletOnConnect, linkWalletToRecruiter, resolveRecruiterByCode, setRecruiterOgStatus, setRecruiterStatus } from "./rewards/attribution.js";
import { getCurrentWeeklyRewardEpoch, listRewardEpochs, listRewardEvents } from "./rewards/ingest.js";
import { createExclusionFlag, listEligibilityResults, listExclusionFlags, processRewardEligibilityForEpoch, resolveExclusionFlag } from "./rewards/eligibility.js";
import { AIRDROP_DRAW_PROGRAMS, AIRDROP_DRAW_STATUSES, getAirdropPreview, getCurrentAirdropSnapshot, listAirdropDraws, listAirdropWinners, publishAirdropDraw, runAirdropDrawForEpoch } from "./rewards/airdrops.js";
import { listRecruiterLeaderboard } from "./rewards/recruiterLeaderboard.js";
import { ELIGIBILITY_PROGRAMS, EXCLUSION_FLAG_SEVERITIES, ELIGIBILITY_REASON_CODES } from "./rewards/reasonCodes.js";
import { listRecruiterAdminActions, listRecruiterClaimableSettlements, recordRecruiterAdminAction, RECRUITER_ADMIN_ACTION_TYPES } from "./rewards/recruiterAdmin.js";
import { listClaimRollovers, listRewardClaims, recordRewardClaim, REWARD_PROGRAMS } from "./rewards/ledger.js";
import { CLAIM_REMINDER_KINDS, CLAIM_REMINDER_STATUSES, listClaimReminderDeliveries, listClaimReminderStates, processClaimReminders } from "./rewards/reminders.js";
import { getRewardClaimVaultPosture, getRewardPublicationState, getRewardRoutingDiagnostics, listRewardAdminActions, listRewardEpochProcessorStatuses, listRewardOpsAlerts, recordRewardAdminAction, setRewardPublicationState } from "./rewards/rewardOps.js";
import { createCampaignRouteAuthorization, createTradeRouteAuthorization, getRouteAuthorityAddress, getWalletRouteSnapshot } from "./rewards/routing.js";
import { getRewardAdminEpochSummary, getRecruiterSummaryByCode, getRecruiterSummaryByWalletAddress, getSquadSummaryByRecruiterCode, getWalletRewardSummary, listRecruiterClosureDiagnostics, listRecruiterSummaries, listRewardAdminEpochSummaries, listRewardProgramEpochReconciliations, listSquadSummaries, listWalletEligibilityHistory, listWalletRewardHistory } from "./rewards/readModels.js";
import { getSquadAllocationPreview } from "./rewards/squads.js";
import {
  createStaticJsonRpcProvider,
  maskRpcUrl,
  parseRpcList,
  probeRpcUrl,
  rawRpcCall,
} from "./rpcProvider.js";
import { resolveMarketIdentity, resolveMarketIdentityOrPassthrough } from "./marketIdentity.js";
import { runGraduationReconcilerOnce } from "./graduationReconciler.js";
import { ensureDexPoolForCampaign } from "./marketApi.js";
import { registerLpFeesRoutes } from "./lpFeesRoutes.js";
import { runTopazPoolIndexerOnce } from "./topazPoolIndexer.js";
import { parseWalletAddressOrNull, walletEqualsSql } from "./walletAddress.js";
import type { Request, Response, NextFunction, RequestHandler } from "express";

const app = express();
app.use(express.json({ limit: "256kb" }));

// Boot self-check: prove this process pins static networks (no detect-network retry spam).
// If this throws, deploy/runtime is wrong — better fail loud than flood logs.
try {
  const defaultEvmChainId = ENV.DEFAULT_EVM_CHAIN_ID === 97 ? 97 : 56;
  const defaultRpc = defaultEvmChainId === 97 ? ENV.BSC_RPC_HTTP_97 : ENV.BSC_RPC_HTTP_56;
  const urls = parseRpcList(defaultRpc);
  if (urls[0]) {
    const probeProvider = createStaticJsonRpcProvider(urls[0], defaultEvmChainId, { timeoutMs: 3_000 });
    // Accessing _network throws if unpinned — that is the detect-loop bug class.
    const pinned = (probeProvider as any)._network;
    console.log("[rpc] static network pin OK", {
      chainId: String(pinned?.chainId ?? defaultEvmChainId),
      url: maskRpcUrl(urls[0]),
    });
    probeProvider.destroy();
  } else {
    console.warn(`[rpc] BSC_RPC_HTTP_${defaultEvmChainId} empty - indexer loops will idle/fail without a URL`);
  }
} catch (error: any) {
  console.error("[rpc] static network pin FAILED", error?.message || String(error));
}

// ---------------------------------------------------------------------------
// Minimal in-process metrics (safe to expose)
// ---------------------------------------------------------------------------
let reqCount1m = 0;
let errCount1m = 0;

setInterval(() => {
  reqCount1m = 0;
  errCount1m = 0;
}, 60_000);

app.use((req, res, next) => {
  reqCount1m++;
  res.on("finish", () => {
    if (res.statusCode >= 500) errCount1m++;
  });
  next();
});

app.use((req, res, next) => {
  const path = String(req.path || "");
  if (
    path.startsWith("/api/token/") ||
    path.startsWith("/api/campaigns") ||
    path.startsWith("/api/featured") ||
    path.startsWith("/api/war-room") ||
    path.startsWith("/api/market/")
  ) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

const VALID_RANKS = ["Recruit", "Soldier", "Corporal", "Captain", "General"] as const;
const VALID_RECRUITER_STATUSES = ["active", "inactive", "closed", "suspended"] as const;
type ValidRank = (typeof VALID_RANKS)[number];

function normalizeAddress(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

const PRIVATE_PUBLIC_REASON_CODES = new Set([
  "SELF_TRADING",
  "COMMON_CONTROL_CLUSTER",
  "CIRCULAR_TRADING",
  "WALLET_SPLITTING",
  "CREATOR_FUNDED_FAKE_DEMAND",
  "RECRUITER_FARMING_LOOP",
]);

function uniqStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function sanitizePublicReasonCodes(values: unknown): string[] {
  const rawCodes = Array.isArray(values) ? values.map((value) => String(value)) : [];
  const safeCodes = rawCodes.filter((code) => !PRIVATE_PUBLIC_REASON_CODES.has(code));
  if (rawCodes.some((code) => PRIVATE_PUBLIC_REASON_CODES.has(code))) {
    safeCodes.push("REVIEW_REQUIRED");
  }
  return uniqStrings(safeCodes.filter((code) => (ELIGIBILITY_REASON_CODES as readonly string[]).includes(code)));
}

function toPublicWalletRewardSummary(summary: NonNullable<Awaited<ReturnType<typeof getWalletRewardSummary>>>) {
  return {
    walletAddress: summary.walletAddress,
    pendingByProgram: summary.pendingByProgram,
    claimableByProgram: summary.claimableByProgram,
    claimedByProgram: summary.claimedByProgram,
    totalClaimableAmount: summary.totalClaimableAmount,
    claimedLifetimeAmount: summary.claimedLifetimeAmount,
    lastClaimedAt: summary.lastClaimedAt,
    materializedAt: summary.materializedAt,
  };
}

function toPublicWalletHistoryItem(item: any) {
  return {
    id: item.id,
    epochId: item.epochId,
    chainId: item.chainId,
    epochType: item.epochType,
    startAt: item.startAt,
    endAt: item.endAt,
    program: item.program,
    grossAmount: item.grossAmount,
    netAmount: item.netAmount,
    status: item.status,
    claimableAt: item.claimableAt,
    claimDeadlineAt: item.claimDeadlineAt,
    claimedAt: item.claimedAt,
    expiredAt: item.expiredAt,
    cancelledAt: item.cancelledAt,
    claim: item.claim
      ? {
          id: item.claim.id,
          claimedAmount: item.claim.claimedAmount,
          claimTxHash: item.claim.claimTxHash,
          claimedAt: item.claim.claimedAt,
          status: item.claim.status,
        }
      : null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function toPublicRewardClaim(claim: any) {
  return {
    id: claim.id,
    walletAddress: claim.walletAddress,
    epochId: claim.epochId,
    program: claim.program,
    claimedAmount: claim.claimedAmount,
    claimTxHash: claim.claimTxHash,
    claimedAt: claim.claimedAt,
    status: claim.status,
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
  };
}

function toPublicEligibilityItem(item: any) {
  return {
    id: item.id,
    epochId: item.epochId,
    chainId: item.chainId,
    epochType: item.epochType,
    startAt: item.startAt,
    endAt: item.endAt,
    program: item.program,
    isEligible: item.isEligible,
    reasonCodes: sanitizePublicReasonCodes(item.reasonCodes),
    computedAt: item.computedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function toPublicAttributionState(state: Awaited<ReturnType<typeof getWalletAttributionState>>) {
  return {
    walletAddress: state.walletAddress,
    hasActivity: state.hasActivity,
    recruiterLinkState: state.recruiterLinkState,
    recruiterCode: state.recruiter?.code ?? null,
    recruiterDisplayName: state.recruiter?.displayName ?? null,
    recruiterIsOg: Boolean(state.recruiter?.isOg),
    squadState: state.squadState,
  };
}

async function requirePublishedResource(
  res: Response,
  resourceType: "airdrop_winners" | "recruiter_leaderboard" | "squad_leaderboard",
  resourceKey = "default",
): Promise<boolean> {
  const state = await getRewardPublicationState(resourceType, resourceKey);
  if (!state.isPublished) {
    res.status(404).json({ error: "Not found" });
    return false;
  }
  return true;
}

function normalizeRank(value: unknown): ValidRank | null {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();

  if (!normalized) return null;

  const match = VALID_RANKS.find((rank) => rank.toLowerCase() === normalized);
  return match ?? null;
}

function rankIndex(value: unknown): number {
  const normalized = normalizeRank(value);
  return normalized ? VALID_RANKS.indexOf(normalized) : -1;
}

function requireInternalAuth(req: Request, res: Response): boolean {
  const expected = String(ENV.RANK_EVENTS_TOKEN || "").trim();
  if (!expected) {
    res.status(503).json({ ok: false, error: "Internal endpoints are disabled: RANK_EVENTS_TOKEN missing" });
    return false;
  }

  const token = readBearerToken(req);
  if (!token || token !== expected) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return false;
  }

  return true;
}

function readBearerToken(req: Request): string {
  const authHeader = String(req.headers.authorization || "").trim();
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  return String(req.headers["x-rank-events-token"] || "").trim();
}

const allowedOrigins = new Set(
  [
   "http://localhost:5173",
   "http://localhost:3000",
   "http://localhost:8080",
   "http://localhost:8081",
   "https://memewarzone.netlify.app",
  "https://memewar.zone",
  "https://www.memewar.zone",
  ]
    .concat(
      String(process.env.CORS_ALLOWED_ORIGINS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    )
);


const CORS_RELAXED = /^(1|true|yes|on)$/i.test(String(process.env.CORS_RELAXED || "").trim());

function isCoolifyOrSelfHostPreview(host: string) {
  if (host.endsWith(".sslip.io") || host.endsWith(".nip.io")) return true;
  const coolifySuffix = String(process.env.CORS_COOLIFY_HOST_SUFFIX || "").trim().toLowerCase();
  if (coolifySuffix) {
    const suffix = coolifySuffix.startsWith(".") ? coolifySuffix : `.${coolifySuffix}`;
    if (host === coolifySuffix.replace(/^\./, "") || host.endsWith(suffix)) return true;
  }
  return false;
}

function isAllowedOrigin(origin?: string) {
  if (!origin) return true; // allow non-browser (curl, server-to-server)
  if (CORS_RELAXED) return true;
  if (allowedOrigins.has(origin)) return true;

  try {
    const u = new URL(origin);
    const host = u.hostname.toLowerCase();

    // Local frontend dev / preview ports.
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return true;
    }

    // Current production/custom domains
    if (host === "memewar.zone" || host === "www.memewar.zone" || host.endsWith(".memewar.zone")) {
      return true;
    }

    // Netlify deploy previews / branch deploys
    if (host === "memewarzone.netlify.app" || host.endsWith("--memewarzone.netlify.app")) {
      return true;
    }

    // Coolify / self-host temporary public hostnames
    if (isCoolifyOrSelfHostPreview(host)) {
      return true;
    }

    // Old Vercel previews
    if (
      host === "memebattles.vercel.app" || 
      host.endsWith("--memebattles.vercel.app") ||
      host === "meme-battles.vercel.app" || 
      host.endsWith("--meme-battles.vercel.app") ||
      host === "memewar.vercel.app" || 
      host.endsWith("--memewar.vercel.app")
    ) {
      return true;
    }
  } catch {
    // ignore invalid origin
  }

  return false;
}

const corsOptions: cors.CorsOptions = {
  origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
  credentials: false,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Always attach ACAO on errors so browser reports the real 5xx/timeout, not a fake CORS failure.
app.use((req, res, next) => {
  const origin = String(req.headers.origin || "");
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  next();
});

// Extremely lightweight health (no DB). Safe for frequent monitoring.
app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/health", async (_req, res) => {
  try {
    const r = await pool.query("select 1 as ok");
    const { solanaIndexerPublicHealth } = await import("./solanaIndexer.js");
    res.json({
      ok: true,
      db: r.rows[0].ok,
      // Bump when shipping indexer loop fixes so deploy can be confirmed from /health.
      indexerBuild: "live-c4.2-lease-2026-08-23",
      normalScope: ENV.INDEXER_NORMAL_SCOPE,
      solana: solanaIndexerPublicHealth(),
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get("/api/indexer/status", wrap(async (req, res) => {
  const chainId = Number(req.query.chainId || ENV.DEFAULT_EVM_CHAIN_ID);
  const rawAddress = normalizeAddress(req.query.campaign || req.query.campaignAddress || req.query.token || "");
  const identity = rawAddress
    ? await resolveMarketIdentityOrPassthrough(chainId, rawAddress)
    : null;
  const campaign = identity?.campaignAddress || "";

  const cursorRows = await pool.query(
    `select cursor,last_indexed_block,updated_at
       from public.indexer_state
      where chain_id=$1
        and (
          cursor in ('factory','votes','rewards-router')
          or ($2 <> '' and cursor = $3)
        )
      order by cursor asc`,
    [chainId, campaign, campaign ? `campaign:${campaign}` : ""]
  );

  const campaignRows = campaign
    ? await pool.query(
        `select
           c.campaign_address,
           c.factory_address,
           c.token_address,
           c.creator_address,
           c.name,
           c.symbol,
           c.created_block,
           c.created_at_chain,
           c.graduated_block,
           c.graduated_at_chain,
           c.is_active,
           count(t.*)::int as trade_count,
           max(t.block_number)::int as last_trade_block,
           max(t.block_time) as last_trade_at
         from public.campaigns c
         left join public.curve_trades t
           on t.chain_id=c.chain_id and t.campaign_address=c.campaign_address
        where c.chain_id=$1 and c.campaign_address=$2
        group by
          c.chain_id,
          c.campaign_address,
          c.factory_address,
          c.token_address,
          c.creator_address,
          c.name,
          c.symbol,
          c.created_block,
          c.created_at_chain,
          c.graduated_block,
          c.graduated_at_chain,
          c.is_active`,
        [chainId, campaign]
      )
    : null;

  const totals = await pool.query(
    `select
       (select count(*)::int from public.campaigns where chain_id=$1) as campaigns,
       (select count(*)::int from public.campaigns where chain_id=$1 and is_active=true) as active_campaigns,
       (select count(*)::int from public.curve_trades where chain_id=$1) as trades,
       (select max(block_number)::int from public.curve_trades where chain_id=$1) as last_trade_block`,
    [chainId]
  );
  const rpc = await getRpcDiagnostics(chainId, campaign || null);

  res.json({
    ok: true,
    chainId,
    config: {
      factoryConfigured: Boolean(ENV.FACTORY_ADDRESS_97 || ENV.FACTORY_ADDRESS_56),
      factoryAddress:
        chainId === 56
          ? ENV.FACTORY_ADDRESS_56 || null
          : ENV.FACTORY_ADDRESS_97 || null,
      rpcConfigured: Boolean(chainId === 56 ? ENV.BSC_RPC_HTTP_56 : ENV.BSC_RPC_HTTP_97),
      voteTreasuryConfigured: Boolean(chainId === 56 ? ENV.VOTE_TREASURY_ADDRESS_56 : ENV.VOTE_TREASURY_ADDRESS_97),
      factoryStartBlock:
        chainId === 56
          ? ENV.FACTORY_START_BLOCK_56 || null
          : ENV.FACTORY_START_BLOCK_97 || null,
      lookbackBlocks: ENV.FACTORY_LOOKBACK_BLOCKS,
      repairLookbackBlocks: ENV.REPAIR_LOOKBACK_BLOCKS,
    },
    rpc,
    totals: totals.rows[0] || null,
    cursors: cursorRows.rows,
    identity: identity
      ? {
          inputAddress: identity.inputAddress,
          matchedBy: identity.matchedBy,
          campaignAddress: identity.campaignAddress,
          tokenAddress: identity.tokenAddress || null,
        }
      : null,
    campaign: campaign ? (campaignRows?.rows?.[0] || null) : null,
    runtime: {
      running,
      runningForMs: running && runningStartedAt ? Date.now() - runningStartedAt : null,
      staleAfterMs: ENV.INDEXER_STALE_AFTER_MS,
      lastIndexerRunAt: lastIndexerRunAt ? new Date(lastIndexerRunAt).toISOString() : null,
      lastIndexerErrorAt: lastIndexerErrorAt ? new Date(lastIndexerErrorAt).toISOString() : null,
      lastIndexerErrorMsg,
    },
  });
}));

// One-shot graduation handoff (campaign → TOPAZ_ACTIVE + dex_pools). Prefer this on
// Railway shells when `npm run job:…` is unavailable (wrong cwd / no tsx in image).
app.post("/internal/wtr/reconcile-graduations", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const result = await runGraduationReconcilerOnce();
  res.status(result.errors ? 207 : 200).json({ ok: result.errors === 0, ...result });
}));

// Repair missing dex_pools row (full schema) for one graduated campaign, then optional index pass.
app.post("/internal/wtr/ensure-dex-pool", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const chainId = Number(req.query.chainId || req.body?.chainId || ENV.DEFAULT_EVM_CHAIN_ID);
  const campaign = normalizeAddress(
    req.query.campaign || req.query.campaignAddress || req.body?.campaign || req.body?.campaignAddress || "",
  );
  if (!campaign || !/^0x[a-f0-9]{40}$/.test(campaign)) {
    return res.status(400).json({ ok: false, error: "campaign (0x…) required" });
  }
  const ensured = await ensureDexPoolForCampaign(chainId, campaign);
  let indexResult: any = null;
  if (ensured.ok && String(req.query.index || req.body?.index || "") === "1") {
    indexResult = await runTopazPoolIndexerOnce();
  }
  res.status(ensured.ok ? 200 : 500).json({ ok: ensured.ok, ensured, indexResult });
}));

// One-shot Topaz pool swap indexer pass (fills dex_trades / candles when dex_pools rows exist).
app.post("/internal/wtr/index-topaz-pools", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const result = await runTopazPoolIndexerOnce();
  res.status(200).json({ ok: true, ...result });
}));

app.post("/internal/indexer/run", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;

  const mode = String(req.query.mode || req.body?.mode || "normal").toLowerCase();
  if (mode !== "normal" && mode !== "repair" && mode !== "discover" && mode !== "trades" && mode !== "campaigns") {
    return res.status(400).json({ ok: false, error: "mode must be normal, repair, discover, trades, or campaigns" });
  }

  const campaign = normalizeAddress(req.query.campaign || req.query.campaignAddress || req.body?.campaign || req.body?.campaignAddress || "");
  if (campaign && !/^0x[a-f0-9]{40}$/.test(campaign)) {
    return res.status(400).json({ ok: false, error: "Invalid campaign address" });
  }
  const fromBlock = Number(req.query.fromBlock || req.body?.fromBlock || 0);
  const toBlock = Number(req.query.toBlock || req.body?.toBlock || 0);
  if (fromBlock && (!Number.isFinite(fromBlock) || fromBlock < 0)) {
    return res.status(400).json({ ok: false, error: "Invalid fromBlock" });
  }
  if (toBlock && (!Number.isFinite(toBlock) || toBlock < 0)) {
    return res.status(400).json({ ok: false, error: "Invalid toBlock" });
  }
  if (fromBlock && toBlock && fromBlock > toBlock) {
    return res.status(400).json({ ok: false, error: "fromBlock must be <= toBlock" });
  }

  const result = await runIndexerJob(mode as "normal" | "repair" | "discover" | "trades" | "campaigns", "manual", {
    campaignAddress: campaign || undefined,
    fromBlock: fromBlock || undefined,
    toBlock: toBlock || undefined,
  });
  const status = result.ok ? 200 : result.skipped ? 409 : 500;
  res.status(status).json(result);
}));

app.post("/internal/indexer/ingest-tx", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;

  const chainId = Number(req.query.chainId || req.body?.chainId || ENV.DEFAULT_EVM_CHAIN_ID);
  const campaign = normalizeAddress(req.query.campaign || req.query.campaignAddress || req.body?.campaign || req.body?.campaignAddress || "");
  const txHash = String(req.query.txHash || req.query.tx || req.body?.txHash || req.body?.tx || "").trim().toLowerCase();

  if (!Number.isFinite(chainId) || chainId <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid chainId" });
  }
  if (!/^0x[a-f0-9]{40}$/.test(campaign)) {
    return res.status(400).json({ ok: false, error: "Invalid campaign address" });
  }
  if (!/^0x[a-f0-9]{64}$/.test(txHash)) {
    return res.status(400).json({ ok: false, error: "Invalid tx hash" });
  }

  const result = await ingestCampaignTransaction({ chainId, campaignAddress: campaign, txHash });
  res.json(result);
}));

app.post("/internal/indexer/solana-backfill-campaign", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const campaign = String(
    req.query.campaign || req.query.campaignAddress || req.body?.campaign || req.body?.campaignAddress || "",
  ).trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(campaign)) {
    return res.status(400).json({ ok: false, error: "solana campaign PDA required" });
  }
  const { backfillSolanaCampaign } = await import("./solanaIndexer.js");
  const result = await backfillSolanaCampaign(campaign);
  res.json({ ok: true, ...result });
}));

/**
 * Ably token auth endpoint
 *
 * TokenDetails (per-campaign): /api/ably/token?chainId=97&campaign=0x...
 * League (global):             /api/ably/token?chainId=97&scope=league
 */
app.get("/api/ably/token", async (req, res) => {
  try {
    const chainId = Number(req.query.chainId || ENV.DEFAULT_EVM_CHAIN_ID);
    const scope = String(req.query.scope || "token");

    if (scope === "live") {
      // Live launch-party / AMA chat channel. Bilateral: clients subscribe AND
      // publish, enter presence, fetch history. Channel name is restricted to
      // live:<safe-slug> to prevent tokens being minted for unrelated channels.
      const liveChannel = String(req.query.channel || "").toLowerCase();
      if (!/^live:[a-z0-9._-]+$/.test(liveChannel)) {
        return res.status(400).json({ error: "Invalid live channel name" });
      }
      // For presence to count each wallet uniquely, the token must be bound to
      // the caller's clientId (defaults to the wallet address passed by the
      // useLiveChannel hook). Falls back to "public" if absent (history-only).
      const liveClientId = String(req.query.clientId || "public");
      const capability = {
        [liveChannel]: ["subscribe", "publish", "presence", "history"],
      };
      const tokenRequest = await ablyRest.auth.createTokenRequest({
        clientId: liveClientId,
        capability: JSON.stringify(capability),
        ttl: 60 * 60 * 1000,
      });
      return res.json(tokenRequest);
    }

    if (scope === "league") {
      const channel = leagueChannel(chainId);
      const capability = { [channel]: ["subscribe"] };

      const tokenRequest = await ablyRest.auth.createTokenRequest({
        clientId: "public",
        capability: JSON.stringify(capability),
        ttl: 60 * 60 * 1000, // 1 hour
      });

      return res.json(tokenRequest);
    }

    const campaignRaw = String(req.query.campaign || "").trim();
    const isSolanaCampaign = chainId === 101 && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(campaignRaw);
    const campaign = isSolanaCampaign ? campaignRaw : campaignRaw.toLowerCase();
    if (!isSolanaCampaign && !/^0x[a-f0-9]{40}$/.test(campaign)) {
      return res.status(400).json({ error: "Invalid campaign address" });
    }

    const channel = tokenChannel(chainId, campaign);
    const capability = { [channel]: ["subscribe"] };

    const tokenRequest = await ablyRest.auth.createTokenRequest({
      // IMPORTANT: clientId MUST be stable across re-auth on an existing connection.
      // Using a random clientId triggers Ably 40102 (mismatched clientId).
      clientId: "public",
      capability: JSON.stringify(capability),
      ttl: 60 * 60 * 1000, // 1 hour
    });

    return res.json(tokenRequest);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

app.post("/internal/user-rank-updated", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;

  const chainId = Number(req.body?.chainId || ENV.DEFAULT_EVM_CHAIN_ID);
  const address = normalizeAddress(req.body?.address ?? req.body?.userAddress ?? req.body?.wallet);
  const requestedOldRank = normalizeRank(req.body?.oldRank ?? req.body?.previousRank);
  const newRank = normalizeRank(req.body?.newRank ?? req.body?.rank);
  const rankPointsRaw = req.body?.rankPoints;
  const rankPoints = rankPointsRaw == null || rankPointsRaw === ""
    ? null
    : Number.isFinite(Number(rankPointsRaw))
      ? Number(rankPointsRaw)
      : null;

  if (!Number.isFinite(chainId)) {
    return res.status(400).json({ ok: false, error: "Invalid chainId" });
  }
  if (!/^0x[a-f0-9]{40}$/.test(address)) {
    return res.status(400).json({ ok: false, error: "Invalid address" });
  }
  if (!newRank) {
    return res.status(400).json({ ok: false, error: "Invalid newRank" });
  }

  let storedPreviousRank: ValidRank | null = null;
  let persisted = false;

  try {
    const prev = await pool.query(
      `select current_rank from public.user_rank_state where chain_id=$1 and address=$2 limit 1`,
      [chainId, address]
    );
    storedPreviousRank = normalizeRank(prev.rows?.[0]?.current_rank ?? null);

    await pool.query(
      `insert into public.user_rank_state (chain_id, address, current_rank, previous_rank, rank_points, created_at, updated_at)
       values ($1, $2, $3, $4, $5, now(), now())
       on conflict (chain_id, address)
       do update set current_rank = excluded.current_rank,
                     previous_rank = excluded.previous_rank,
                     rank_points = excluded.rank_points,
                     updated_at = now()`,
      [chainId, address, newRank, requestedOldRank ?? storedPreviousRank, rankPoints]
    );
    persisted = true;
  } catch (e: any) {
    const code = e?.code;
    if (code !== "42P01" && code !== "42703") {
      throw e;
    }
  }

  const oldRank = requestedOldRank ?? storedPreviousRank;

  await publishUserRankUpdated(chainId, {
    address,
    oldRank,
    newRank,
    rankPoints,
    updatedAt: new Date().toISOString(),
  });

  return res.json({
    ok: true,
    persisted,
    chainId,
    address,
    oldRank,
    newRank,
    promoted: oldRank ? rankIndex(newRank) > rankIndex(oldRank) : null,
  });
}));

// ---------------------------------------------------------------------------
// Profile Activity (v1)
// ---------------------------------------------------------------------------

app.get("/internal/attribution/wallet/:wallet", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const walletAddress = normalizeAddress(req.params.wallet);
  const state = await getWalletAttributionState(walletAddress);
  res.json({ ok: true, state });
}));

app.post("/internal/recruiters/upsert", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;

  const statusRaw = String(req.body?.status || "active").trim().toLowerCase();
  if (!(VALID_RECRUITER_STATUSES as readonly string[]).includes(statusRaw)) {
    return res.status(400).json({ ok: false, error: "Invalid recruiter status" });
  }

  const recruiter = await createOrUpdateRecruiter({
    walletAddress: req.body?.walletAddress ?? req.body?.wallet,
    code: req.body?.code,
    displayName: req.body?.displayName ?? null,
    isOg: Boolean(req.body?.isOg),
    status: statusRaw as (typeof VALID_RECRUITER_STATUSES)[number],
  });

  const adminAction = await recordRecruiterAdminAction({
    recruiterId: recruiter.id,
    walletAddress: recruiter.walletAddress,
    actionType: "recruiter_upsert",
    actedBy: req.body?.actedBy ?? null,
    reason: req.body?.reason ?? null,
    detailsJson: {
      code: recruiter.code,
      displayName: recruiter.displayName,
      isOg: recruiter.isOg,
      status: recruiter.status,
    },
  });

  res.json({ ok: true, recruiter, adminAction });
}));

app.post("/internal/attribution/referral/capture", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;

  let recruiterId = Number(req.body?.recruiterId || 0);
  if (!Number.isFinite(recruiterId) || recruiterId <= 0) {
    const recruiterCode = String(req.body?.recruiterCode || req.body?.code || "").trim();
    if (!recruiterCode) {
      return res.status(400).json({ ok: false, error: "recruiterId or recruiterCode required" });
    }
    const recruiter = await resolveRecruiterByCode(recruiterCode);
    if (!recruiter) return res.status(404).json({ ok: false, error: "Recruiter not found" });
    recruiterId = recruiter.id;
  }

  const referral = await captureReferralWindow({
    recruiterId,
    walletAddress: req.body?.walletAddress ?? null,
    clientFingerprint: req.body?.clientFingerprint ?? null,
    sessionToken: req.body?.sessionToken ?? null,
    expiresAt: req.body?.expiresAt ? new Date(String(req.body.expiresAt)) : undefined,
    metadata: req.body?.metadata ?? null,
  });

  res.json({ ok: true, referral });
}));

app.post("/internal/attribution/wallet-connect", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const result = await linkWalletOnConnect({
    walletAddress: req.body?.walletAddress ?? req.body?.wallet,
    sessionToken: req.body?.sessionToken ?? null,
    clientFingerprint: req.body?.clientFingerprint ?? null,
    linkedAt: req.body?.linkedAt ? new Date(String(req.body.linkedAt)) : undefined,
  });
  res.json({ ok: true, ...result });
}));

app.post("/internal/attribution/link", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;

  let recruiterId = Number(req.body?.recruiterId || 0);
  if (!Number.isFinite(recruiterId) || recruiterId <= 0) {
    const recruiterCode = String(req.body?.recruiterCode || req.body?.code || "").trim();
    if (!recruiterCode) {
      return res.status(400).json({ ok: false, error: "recruiterId or recruiterCode required" });
    }
    const recruiter = await resolveRecruiterByCode(recruiterCode);
    if (!recruiter) return res.status(404).json({ ok: false, error: "Recruiter not found" });
    recruiterId = recruiter.id;
  }

  const result = await linkWalletToRecruiter({
    walletAddress: req.body?.walletAddress ?? req.body?.wallet,
    recruiterId,
    linkSource: (String(req.body?.linkSource || "manual").trim() || "manual") as any,
    linkedAt: req.body?.linkedAt ? new Date(String(req.body.linkedAt)) : undefined,
  });
  res.json({ ok: true, ...result });
}));

app.post("/internal/recruiters/:recruiterId/status", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const recruiterId = Number(req.params.recruiterId || 0);
  const statusRaw = String(req.body?.status || "").trim().toLowerCase();
  if (!Number.isFinite(recruiterId) || recruiterId <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid recruiterId" });
  }
  if (!(VALID_RECRUITER_STATUSES as readonly string[]).includes(statusRaw)) {
    return res.status(400).json({ ok: false, error: "Invalid recruiter status" });
  }

  const result = await setRecruiterStatus({
    recruiterId,
    status: statusRaw as (typeof VALID_RECRUITER_STATUSES)[number],
    detachMembers: Boolean(req.body?.detachMembers),
    detachReason: req.body?.detachReason ?? null,
    changedAt: req.body?.changedAt ? new Date(String(req.body.changedAt)) : undefined,
  });

  const adminAction = await recordRecruiterAdminAction({
    recruiterId,
    walletAddress: result.recruiter.walletAddress,
    actionType: "status_change",
    actedBy: req.body?.actedBy ?? null,
    reason: req.body?.reason ?? req.body?.detachReason ?? null,
    detailsJson: {
      status: result.recruiter.status,
      detachMembers: Boolean(req.body?.detachMembers),
      detachReason: req.body?.detachReason ?? null,
      detachedWalletCount: result.detachedWalletCount,
    },
  });

  res.json({ ok: true, ...result, adminAction });
}));

app.post("/internal/recruiters/:recruiterId/og-tag", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const recruiterId = Number(req.params.recruiterId || 0);
  if (!Number.isFinite(recruiterId) || recruiterId <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid recruiterId" });
  }

  const recruiter = await setRecruiterOgStatus({
    recruiterId,
    isOg: Boolean(req.body?.isOg),
  });

  const adminAction = await recordRecruiterAdminAction({
    recruiterId,
    walletAddress: recruiter.walletAddress,
    actionType: "og_tag_update",
    actedBy: req.body?.actedBy ?? null,
    reason: req.body?.reason ?? null,
    detailsJson: {
      isOg: recruiter.isOg,
      code: recruiter.code,
    },
  });

  res.json({ ok: true, recruiter, adminAction });
}));

app.post("/internal/recruiters/dispute-override", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;

  let recruiterId = Number(req.body?.recruiterId || 0);
  if (!Number.isFinite(recruiterId) || recruiterId <= 0) {
    const recruiterCode = String(req.body?.recruiterCode || req.body?.code || "").trim();
    if (!recruiterCode) {
      return res.status(400).json({ ok: false, error: "recruiterId or recruiterCode required" });
    }
    const recruiter = await resolveRecruiterByCode(recruiterCode);
    if (!recruiter) return res.status(404).json({ ok: false, error: "Recruiter not found" });
    recruiterId = recruiter.id;
  }

  const result = await applyRecruiterDisputeOverride({
    walletAddress: req.body?.walletAddress ?? req.body?.wallet,
    recruiterId,
    linkedAt: req.body?.linkedAt ? new Date(String(req.body.linkedAt)) : undefined,
    reason: req.body?.detachReason ?? req.body?.reason ?? null,
  });

  const adminAction = await recordRecruiterAdminAction({
    recruiterId: result.recruiter.id,
    walletAddress: result.state.walletAddress,
    actionType: "dispute_override",
    actedBy: req.body?.actedBy ?? null,
    reason: req.body?.reason ?? req.body?.detachReason ?? null,
    detailsJson: {
      previousRecruiterId: result.previousRecruiter?.id ?? null,
      previousRecruiterCode: result.previousRecruiter?.code ?? null,
      recruiterId: result.recruiter.id,
      recruiterCode: result.recruiter.code,
      recruiterLinkState: result.state.recruiterLinkState,
      squadState: result.state.squadState,
      hasActivity: result.state.hasActivity,
    },
  });

  res.json({ ok: true, ...result, adminAction });
}));

app.get("/internal/recruiters/admin-actions", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const recruiterId = req.query.recruiterId != null && String(req.query.recruiterId).trim() !== "" ? Number(req.query.recruiterId) : null;
  const walletAddress = req.query.walletAddress ? String(req.query.walletAddress) : null;
  const recruiterCode = req.query.recruiterCode ? String(req.query.recruiterCode) : null;
  const actionType = req.query.actionType != null && String(req.query.actionType).trim() !== "" ? String(req.query.actionType).trim() : null;
  const limit = Math.min(Number(req.query.limit || 100), 500);
  if (recruiterId != null && !Number.isFinite(recruiterId)) {
    return res.status(400).json({ ok: false, error: "Invalid recruiterId" });
  }
  if (actionType != null && !(RECRUITER_ADMIN_ACTION_TYPES as readonly string[]).includes(actionType)) {
    return res.status(400).json({ ok: false, error: "Invalid recruiter admin action type" });
  }

  const items = await listRecruiterAdminActions({
    recruiterId,
    walletAddress,
    recruiterCode,
    actionType: actionType as any,
    limit,
  });
  res.json({ ok: true, items });
}));

app.get("/internal/recruiters/claimable-settlements", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const epochId = req.query.epochId != null && String(req.query.epochId).trim() !== "" ? Number(req.query.epochId) : null;
  const recruiterId = req.query.recruiterId != null && String(req.query.recruiterId).trim() !== "" ? Number(req.query.recruiterId) : null;
  const recruiterCode = req.query.recruiterCode ? String(req.query.recruiterCode) : null;
  const walletAddress = req.query.walletAddress ? String(req.query.walletAddress) : null;
  const chainId = req.query.chainId != null && String(req.query.chainId).trim() !== "" ? Number(req.query.chainId) : null;
  const limit = Math.min(Number(req.query.limit || 100), 500);
  if (epochId != null && !Number.isFinite(epochId)) {
    return res.status(400).json({ ok: false, error: "Invalid epochId" });
  }
  if (recruiterId != null && !Number.isFinite(recruiterId)) {
    return res.status(400).json({ ok: false, error: "Invalid recruiterId" });
  }
  if (chainId != null && !Number.isFinite(chainId)) {
    return res.status(400).json({ ok: false, error: "Invalid chainId" });
  }

  const items = await listRecruiterClaimableSettlements({
    epochId,
    recruiterId,
    recruiterCode,
    walletAddress,
    chainId,
    limit,
  });
  res.json({ ok: true, items });
}));

app.post("/api/recruiters/:code/referral/capture", wrap(async (req, res) => {
  const recruiter = await resolveRecruiterByCode(req.params.code);
  if (!recruiter) return res.status(404).json({ ok: false, error: "Recruiter not found" });

  const metadata = req.body?.metadata && typeof req.body.metadata === "object" ? req.body.metadata : {};
  const referral = await captureReferralWindow({
    recruiterId: recruiter.id,
    walletAddress: req.body?.walletAddress ?? null,
    clientFingerprint: req.body?.clientFingerprint ?? null,
    sessionToken: req.body?.sessionToken ?? null,
    metadata: { source: "public_referral_capture", ...metadata },
  });

  res.json({
    ok: true,
    recruiter: {
      code: recruiter.code,
      displayName: recruiter.displayName,
      isOg: recruiter.isOg,
      status: recruiter.status,
    },
    referral,
  });
}));

app.get("/api/recruiters", wrap(async (req, res) => {
  if (!(await requirePublishedResource(res, "recruiter_leaderboard"))) return;
  const limit = Math.min(Number(req.query.limit || 100), 200);
  const status = req.query.status != null && String(req.query.status).trim() !== "" ? String(req.query.status).trim() : null;
  const leaderboard = await listRecruiterLeaderboard({ status, limit });
  res.json({ ok: true, recruiters: leaderboard.recruiters, weights: leaderboard.weights });
}));

app.post("/api/attribution/wallet-connect", wrap(async (req, res) => {
  const result = await linkWalletOnConnect({
    walletAddress: req.body?.walletAddress ?? req.body?.wallet,
    sessionToken: req.body?.sessionToken ?? null,
    clientFingerprint: req.body?.clientFingerprint ?? null,
    linkedAt: req.body?.linkedAt ? new Date(String(req.body.linkedAt)) : undefined,
  });

  res.json({
    ok: true,
    changed: result.changed,
    errorCode: result.errorCode,
    state: toPublicAttributionState(result.state),
  });
}));

app.get("/api/attribution/wallet/:wallet", wrap(async (req, res) => {
  const walletAddress = normalizeAddress(req.params.wallet);
  const state = await getWalletAttributionState(walletAddress);
  res.json({ ok: true, state: toPublicAttributionState(state) });
}));

app.get("/api/recruiter-routing/wallet/:wallet", wrap(async (req, res) => {
  const walletAddress = normalizeAddress(req.params.wallet);
  const routing = await getWalletRouteSnapshot(walletAddress);
  res.json({ ok: true, routing, routeAuthority: getRouteAuthorityAddress() });
}));

app.post("/api/recruiter-routing/trade-authorization", wrap(async (req, res) => {
  const authorization = await createTradeRouteAuthorization({
    walletAddress: req.body?.walletAddress ?? req.body?.wallet,
    campaignAddress: req.body?.campaignAddress ?? req.body?.campaign,
    chainId: Number(req.body?.chainId),
  });
  res.json({ ok: true, authorization, routeAuthority: getRouteAuthorityAddress() });
}));

app.post("/api/recruiter-routing/create-authorization", wrap(async (req, res) => {
  const authorization = await createCampaignRouteAuthorization({
    walletAddress: req.body?.walletAddress ?? req.body?.wallet,
    factoryAddress: req.body?.factoryAddress ?? req.body?.factory,
    chainId: Number(req.body?.chainId),
  });
  res.json({ ok: true, authorization, routeAuthority: getRouteAuthorityAddress() });
}));

app.get("/internal/rewards/epochs/current", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const chainId = Number(req.query.chainId || ENV.DEFAULT_EVM_CHAIN_ID);
  if (!Number.isFinite(chainId)) {
    return res.status(400).json({ ok: false, error: "Invalid chainId" });
  }

  const epoch = await getCurrentWeeklyRewardEpoch(chainId);
  res.json({ ok: true, epoch });
}));

app.get("/internal/rewards/epochs", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const chainId = Number(req.query.chainId || ENV.DEFAULT_EVM_CHAIN_ID);
  const limit = Math.min(Number(req.query.limit || 20), 100);
  if (!Number.isFinite(chainId)) {
    return res.status(400).json({ ok: false, error: "Invalid chainId" });
  }

  const epochs = await listRewardEpochs(chainId, limit);
  res.json({ ok: true, epochs });
}));

app.get("/internal/rewards/events", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const chainId = Number(req.query.chainId || ENV.DEFAULT_EVM_CHAIN_ID);
  const epochId = req.query.epochId != null && String(req.query.epochId).trim() !== "" ? Number(req.query.epochId) : null;
  const limit = Math.min(Number(req.query.limit || 50), 200);
  if (!Number.isFinite(chainId)) {
    return res.status(400).json({ ok: false, error: "Invalid chainId" });
  }
  if (epochId != null && !Number.isFinite(epochId)) {
    return res.status(400).json({ ok: false, error: "Invalid epochId" });
  }

  const events = await listRewardEvents({
    chainId,
    epochId,
    campaignAddress: req.query.campaignAddress ? String(req.query.campaignAddress) : null,
    walletAddress: req.query.walletAddress ? String(req.query.walletAddress) : null,
    txHash: req.query.txHash ? String(req.query.txHash) : null,
    limit,
  });

  res.json({ ok: true, events });
}));

app.get("/internal/rewards/eligibility", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const epochId = req.query.epochId != null && String(req.query.epochId).trim() !== "" ? Number(req.query.epochId) : null;
  const walletAddress = req.query.walletAddress ? String(req.query.walletAddress) : null;
  const programRaw = req.query.program != null ? String(req.query.program).trim() : null;
  const limit = Math.min(Number(req.query.limit || 100), 500);
  if (epochId != null && !Number.isFinite(epochId)) {
    return res.status(400).json({ ok: false, error: "Invalid epochId" });
  }
  if (programRaw != null && !(ELIGIBILITY_PROGRAMS as readonly string[]).includes(programRaw)) {
    return res.status(400).json({ ok: false, error: "Invalid eligibility program" });
  }

  const results = await listEligibilityResults({
    epochId,
    walletAddress,
    program: (programRaw as any) ?? null,
    limit,
  });
  res.json({ ok: true, results });
}));

app.get("/internal/rewards/exclusions", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const epochId = req.query.epochId != null && String(req.query.epochId).trim() !== "" ? Number(req.query.epochId) : null;
  const walletAddress = req.query.walletAddress ? String(req.query.walletAddress) : null;
  const programRaw = req.query.program != null ? String(req.query.program).trim() : null;
  const severityRaw = req.query.severity != null ? String(req.query.severity).trim() : null;
  const onlyOpen = String(req.query.onlyOpen || "true").trim().toLowerCase() !== "false";
  const limit = Math.min(Number(req.query.limit || 100), 500);
  if (epochId != null && !Number.isFinite(epochId)) {
    return res.status(400).json({ ok: false, error: "Invalid epochId" });
  }
  if (programRaw != null && !(ELIGIBILITY_PROGRAMS as readonly string[]).includes(programRaw)) {
    return res.status(400).json({ ok: false, error: "Invalid exclusion program" });
  }
  if (severityRaw != null && !(EXCLUSION_FLAG_SEVERITIES as readonly string[]).includes(severityRaw)) {
    return res.status(400).json({ ok: false, error: "Invalid exclusion severity" });
  }

  const flags = await listExclusionFlags({
    epochId,
    walletAddress,
    program: (programRaw as any) ?? null,
    severity: (severityRaw as any) ?? null,
    onlyOpen,
    limit,
  });
  res.json({ ok: true, flags });
}));

app.post("/internal/rewards/exclusions", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const epochId = req.body?.epochId != null && String(req.body.epochId).trim() !== "" ? Number(req.body.epochId) : null;
  const programRaw = req.body?.program != null && String(req.body.program).trim() !== "" ? String(req.body.program).trim() : null;
  const severityRaw = String(req.body?.severity || "").trim();
  const flagTypeRaw = String(req.body?.flagType || "").trim();
  if (epochId != null && !Number.isFinite(epochId)) {
    return res.status(400).json({ ok: false, error: "Invalid epochId" });
  }
  if (programRaw != null && !(ELIGIBILITY_PROGRAMS as readonly string[]).includes(programRaw)) {
    return res.status(400).json({ ok: false, error: "Invalid exclusion program" });
  }
  if (!(EXCLUSION_FLAG_SEVERITIES as readonly string[]).includes(severityRaw)) {
    return res.status(400).json({ ok: false, error: "Invalid exclusion severity" });
  }
  if (!(ELIGIBILITY_REASON_CODES as readonly string[]).includes(flagTypeRaw)) {
    return res.status(400).json({ ok: false, error: "Invalid exclusion flag type" });
  }

  const flag = await createExclusionFlag({
    walletAddress: req.body?.walletAddress ?? req.body?.wallet,
    epochId,
    program: (programRaw as any) ?? null,
    flagType: flagTypeRaw as any,
    severity: severityRaw as any,
    detailsJson: req.body?.detailsJson ?? req.body?.details ?? null,
    metadata: req.body?.metadata ?? null,
  });
  const adminAction = await recordRewardAdminAction({
    actionType: "exclusion_create",
    resourceType: "exclusion_flag",
    resourceKey: String(flag.id),
    actedBy: req.body?.actedBy ?? null,
    reason: req.body?.reason ?? null,
    detailsJson: {
      epochId,
      program: (programRaw as any) ?? null,
      flagType: flagTypeRaw,
      severity: severityRaw,
      walletAddress: flag.walletAddress,
    },
  });
  res.json({ ok: true, flag, adminAction });
}));

app.post("/internal/rewards/exclusions/:exclusionFlagId/resolve", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const exclusionFlagId = Number(req.params.exclusionFlagId || 0);
  if (!Number.isFinite(exclusionFlagId) || exclusionFlagId <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid exclusionFlagId" });
  }

  const flag = await resolveExclusionFlag({
    exclusionFlagId,
    resolvedBy: req.body?.resolvedBy ?? null,
    resolutionNote: req.body?.resolutionNote ?? null,
    resolvedAt: req.body?.resolvedAt ? new Date(String(req.body.resolvedAt)) : undefined,
  });
  if (!flag) return res.status(404).json({ ok: false, error: "Exclusion flag not found" });
  const adminAction = await recordRewardAdminAction({
    actionType: "exclusion_resolve",
    resourceType: "exclusion_flag",
    resourceKey: String(flag.id),
    actedBy: req.body?.resolvedBy ?? null,
    reason: req.body?.resolutionNote ?? null,
    detailsJson: {
      walletAddress: flag.walletAddress,
      resolvedAt: flag.resolvedAt,
      resolutionNote: flag.resolutionNote,
    },
  });
  res.json({ ok: true, flag, adminAction });
}));

app.post("/internal/rewards/epochs/:epochId/process-eligibility", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const epochId = Number(req.params.epochId || 0);
  if (!Number.isFinite(epochId) || epochId <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid epochId" });
  }

  const result = await processRewardEligibilityForEpoch(epochId);
  res.json({ ok: true, ...result });
}));

app.get("/internal/rewards/claims", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const epochId = req.query.epochId != null && String(req.query.epochId).trim() !== "" ? Number(req.query.epochId) : null;
  const walletAddress = req.query.walletAddress ? String(req.query.walletAddress) : null;
  const programRaw = req.query.program != null ? String(req.query.program).trim() : null;
  const limit = Math.min(Number(req.query.limit || 100), 500);
  if (epochId != null && !Number.isFinite(epochId)) {
    return res.status(400).json({ ok: false, error: "Invalid epochId" });
  }
  if (programRaw != null && !(REWARD_PROGRAMS as readonly string[]).includes(programRaw)) {
    return res.status(400).json({ ok: false, error: "Invalid reward program" });
  }

  const claims = await listRewardClaims({
    epochId,
    walletAddress,
    program: (programRaw as any) ?? null,
    limit,
  });
  res.json({ ok: true, claims });
}));

app.post("/internal/rewards/claims/record", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const epochId = Number(req.body?.epochId || 0);
  const programRaw = String(req.body?.program || "").trim();
  if (!Number.isFinite(epochId) || epochId <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid epochId" });
  }
  if (!(REWARD_PROGRAMS as readonly string[]).includes(programRaw)) {
    return res.status(400).json({ ok: false, error: "Invalid reward program" });
  }

  const result = await recordRewardClaim({
    walletAddress: req.body?.walletAddress ?? req.body?.wallet,
    epochId,
    program: programRaw as any,
    claimTxHash: req.body?.claimTxHash ?? null,
    claimedAt: req.body?.claimedAt ? new Date(String(req.body.claimedAt)) : undefined,
    metadata: req.body?.metadata ?? null,
  });
  res.json({ ok: true, ...result });
}));

app.get("/internal/rewards/reminders", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const walletAddress = req.query.walletAddress ? String(req.query.walletAddress) : null;
  const reminderKindRaw = req.query.reminderKind != null ? String(req.query.reminderKind).trim() : null;
  const statusRaw = req.query.status != null ? String(req.query.status).trim() : null;
  const limit = Math.min(Number(req.query.limit || 100), 500);
  if (reminderKindRaw != null && !(CLAIM_REMINDER_KINDS as readonly string[]).includes(reminderKindRaw)) {
    return res.status(400).json({ ok: false, error: "Invalid reminder kind" });
  }
  if (statusRaw != null && !(CLAIM_REMINDER_STATUSES as readonly string[]).includes(statusRaw)) {
    return res.status(400).json({ ok: false, error: "Invalid reminder status" });
  }

  const reminders = await listClaimReminderStates({
    walletAddress,
    reminderKind: (reminderKindRaw as any) ?? null,
    status: (statusRaw as any) ?? null,
    limit,
  });
  res.json({ ok: true, reminders });
}));

app.get("/internal/rewards/reminders/deliveries", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const walletAddress = req.query.walletAddress ? String(req.query.walletAddress) : null;
  const reminderStateId = req.query.reminderStateId != null && String(req.query.reminderStateId).trim() !== "" ? Number(req.query.reminderStateId) : null;
  const reminderKindRaw = req.query.reminderKind != null ? String(req.query.reminderKind).trim() : null;
  const limit = Math.min(Number(req.query.limit || 100), 500);
  if (reminderStateId != null && !Number.isFinite(reminderStateId)) {
    return res.status(400).json({ ok: false, error: "Invalid reminderStateId" });
  }
  if (reminderKindRaw != null && !(CLAIM_REMINDER_KINDS as readonly string[]).includes(reminderKindRaw)) {
    return res.status(400).json({ ok: false, error: "Invalid reminder kind" });
  }

  const deliveries = await listClaimReminderDeliveries({
    walletAddress,
    reminderStateId,
    reminderKind: (reminderKindRaw as any) ?? null,
    limit,
  });
  res.json({ ok: true, deliveries });
}));

app.post("/internal/rewards/reminders/process", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const limit = req.body?.limit != null ? Number(req.body.limit) : undefined;
  if (limit != null && (!Number.isFinite(limit) || limit <= 0)) {
    return res.status(400).json({ ok: false, error: "Invalid limit" });
  }

  const result = await processClaimReminders(
    req.body?.asOf ? new Date(String(req.body.asOf)) : new Date(),
    limit != null ? Math.min(limit, 500) : undefined,
  );
  res.json({ ok: true, ...result });
}));

app.get("/internal/rewards/rollovers", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const fromLedgerEntryId = req.query.fromLedgerEntryId != null && String(req.query.fromLedgerEntryId).trim() !== "" ? Number(req.query.fromLedgerEntryId) : null;
  const program = req.query.program != null && String(req.query.program).trim() !== "" ? String(req.query.program).trim() : null;
  const limit = Math.min(Number(req.query.limit || 100), 500);
  if (fromLedgerEntryId != null && !Number.isFinite(fromLedgerEntryId)) {
    return res.status(400).json({ ok: false, error: "Invalid fromLedgerEntryId" });
  }
  if (program != null && !(REWARD_PROGRAMS as readonly string[]).includes(program)) {
    return res.status(400).json({ ok: false, error: "Invalid reward program" });
  }
  const rollovers = await listClaimRollovers({ fromLedgerEntryId, program: program as any, limit });
  res.json({ ok: true, rollovers });
}));


app.get("/internal/rewards/read-models/wallet/:wallet", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const summary = await getWalletRewardSummary(req.params.wallet);
  if (!summary) return res.status(404).json({ ok: false, error: "Wallet reward summary not found" });
  res.json({ ok: true, summary });
}));

app.get("/internal/rewards/read-models/recruiters", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const limit = Math.min(Number(req.query.limit || 100), 200);
  const status = req.query.status != null && String(req.query.status).trim() !== "" ? String(req.query.status).trim() : null;
  const recruiters = await listRecruiterSummaries({ status, limit });
  res.json({ ok: true, recruiters });
}));

app.get("/internal/rewards/read-models/recruiters/:code", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const recruiter = await getRecruiterSummaryByCode(req.params.code);
  if (!recruiter) return res.status(404).json({ ok: false, error: "Recruiter summary not found" });
  res.json({ ok: true, recruiter });
}));

app.get("/internal/rewards/read-models/squads", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const limit = Math.min(Number(req.query.limit || 100), 200);
  const status = req.query.status != null && String(req.query.status).trim() !== "" ? String(req.query.status).trim() : null;
  const squads = await listSquadSummaries({ status, limit });
  res.json({ ok: true, squads });
}));

app.get("/internal/rewards/read-models/squads/:recruiterCode", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const squad = await getSquadSummaryByRecruiterCode(req.params.recruiterCode);
  if (!squad) return res.status(404).json({ ok: false, error: "Squad summary not found" });
  res.json({ ok: true, squad });
}));

app.get("/internal/rewards/admin/epochs", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const chainId = req.query.chainId != null && String(req.query.chainId).trim() !== "" ? Number(req.query.chainId) : null;
  const status = req.query.status != null && String(req.query.status).trim() !== "" ? String(req.query.status).trim() : null;
  if (chainId != null && !Number.isFinite(chainId)) {
    return res.status(400).json({ ok: false, error: "Invalid chainId" });
  }
  const epochs = await listRewardAdminEpochSummaries({ chainId, status, limit });
  res.json({ ok: true, epochs });
}));

app.get("/internal/rewards/admin/epochs/:epochId", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const epochId = Number(req.params.epochId || 0);
  if (!Number.isFinite(epochId) || epochId <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid epochId" });
  }
  const epoch = await getRewardAdminEpochSummary(epochId);
  if (!epoch) return res.status(404).json({ ok: false, error: "Reward admin epoch summary not found" });
  res.json({ ok: true, epoch });
}));

app.get("/internal/rewards/admin/reconciliations", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const epochId = req.query.epochId != null && String(req.query.epochId).trim() !== "" ? Number(req.query.epochId) : null;
  const program = req.query.program != null && String(req.query.program).trim() !== "" ? String(req.query.program).trim() : null;
  const limit = Math.min(Number(req.query.limit || 100), 500);
  if (epochId != null && !Number.isFinite(epochId)) {
    return res.status(400).json({ ok: false, error: "Invalid epochId" });
  }
  if (program != null && !(REWARD_PROGRAMS as readonly string[]).includes(program)) {
    return res.status(400).json({ ok: false, error: "Invalid reward program" });
  }
  const items = await listRewardProgramEpochReconciliations({ epochId, program: program as any, limit });
  res.json({ ok: true, items });
}));

app.get("/internal/rewards/admin/closures", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const status = req.query.status != null && String(req.query.status).trim() !== "" ? String(req.query.status).trim() : null;
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const items = await listRecruiterClosureDiagnostics({ status, limit });
  res.json({ ok: true, items });
}));

app.get("/internal/rewards/airdrops/draws", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const epochId = req.query.epochId != null && String(req.query.epochId).trim() !== "" ? Number(req.query.epochId) : null;
  const program = req.query.program != null && String(req.query.program).trim() !== "" ? String(req.query.program).trim() : null;
  const status = req.query.status != null && String(req.query.status).trim() !== "" ? String(req.query.status).trim() : null;
  const limit = Math.min(Number(req.query.limit || 100), 500);
  if (epochId != null && !Number.isFinite(epochId)) {
    return res.status(400).json({ ok: false, error: "Invalid epochId" });
  }
  if (program != null && !(AIRDROP_DRAW_PROGRAMS as readonly string[]).includes(program)) {
    return res.status(400).json({ ok: false, error: "Invalid airdrop program" });
  }
  if (status != null && !(AIRDROP_DRAW_STATUSES as readonly string[]).includes(status)) {
    return res.status(400).json({ ok: false, error: "Invalid draw status" });
  }
  const items = await listAirdropDraws({ epochId, program: program as any, status: status as any, limit });
  res.json({ ok: true, items });
}));

app.get("/internal/rewards/airdrops/winners", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const epochId = req.query.epochId != null && String(req.query.epochId).trim() !== "" ? Number(req.query.epochId) : null;
  const program = req.query.program != null && String(req.query.program).trim() !== "" ? String(req.query.program).trim() : null;
  const walletAddress = req.query.walletAddress ? String(req.query.walletAddress) : null;
  const limit = Math.min(Number(req.query.limit || 100), 500);
  if (epochId != null && !Number.isFinite(epochId)) {
    return res.status(400).json({ ok: false, error: "Invalid epochId" });
  }
  if (program != null && !(AIRDROP_DRAW_PROGRAMS as readonly string[]).includes(program)) {
    return res.status(400).json({ ok: false, error: "Invalid airdrop program" });
  }
  const items = await listAirdropWinners({ epochId, program: program as any, walletAddress, limit });
  res.json({ ok: true, items });
}));

app.post("/internal/rewards/airdrops/epochs/:epochId/draws/run", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const epochId = Number(req.params.epochId || 0);
  const program = req.body?.program != null && String(req.body.program).trim() !== "" ? String(req.body.program).trim() : null;
  const publish = Boolean(req.body?.publish);
  if (!Number.isFinite(epochId) || epochId <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid epochId" });
  }
  if (program != null && !(AIRDROP_DRAW_PROGRAMS as readonly string[]).includes(program)) {
    return res.status(400).json({ ok: false, error: "Invalid airdrop program" });
  }

  const programs = program ? [program as any] : [...AIRDROP_DRAW_PROGRAMS];
  const results = [];
  for (const currentProgram of programs) {
    const result = await runAirdropDrawForEpoch({
      epochId,
      program: currentProgram,
      seed: req.body?.seed ?? null,
      createdBy: req.body?.actedBy ?? null,
      publish,
    });
    results.push(result);
    await recordRewardAdminAction({
      actionType: "draw_run",
      resourceType: "airdrop_draw",
      resourceKey: String(result.draw.id),
      actedBy: req.body?.actedBy ?? null,
      reason: req.body?.reason ?? null,
      detailsJson: {
        epochId,
        program: currentProgram,
        drawId: result.draw.id,
        published: publish,
        winnerCount: result.winners.length,
      },
    });
    if (publish) {
      await recordRewardAdminAction({
        actionType: "draw_publish",
        resourceType: "airdrop_draw",
        resourceKey: String(result.draw.id),
        actedBy: req.body?.actedBy ?? null,
        reason: req.body?.reason ?? null,
        detailsJson: {
          epochId,
          program: currentProgram,
          drawId: result.draw.id,
        },
      });
    }
  }

  res.json({ ok: true, results });
}));

app.post("/internal/rewards/airdrops/draws/:drawId/publish", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const drawId = Number(req.params.drawId || 0);
  if (!Number.isFinite(drawId) || drawId <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid drawId" });
  }
  const draw = await publishAirdropDraw(drawId, req.body?.actedBy ?? null);
  if (!draw) return res.status(404).json({ ok: false, error: "Draw not found" });
  await recordRewardAdminAction({
    actionType: "draw_publish",
    resourceType: "airdrop_draw",
    resourceKey: String(draw.id),
    actedBy: req.body?.actedBy ?? null,
    reason: req.body?.reason ?? null,
    detailsJson: {
      epochId: draw.epochId,
      program: draw.program,
      drawId: draw.id,
    },
  });
  res.json({ ok: true, draw });
}));

app.get("/internal/rewards/publications", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const resourceType = req.query.resourceType != null && String(req.query.resourceType).trim() !== "" ? String(req.query.resourceType).trim() : null;
  const resourceKey = req.query.resourceKey != null && String(req.query.resourceKey).trim() !== "" ? String(req.query.resourceKey).trim() : "default";
  if (resourceType == null) {
    const states = await Promise.all([
      getRewardPublicationState("airdrop_winners"),
      getRewardPublicationState("recruiter_leaderboard"),
      getRewardPublicationState("squad_leaderboard"),
    ]);
    return res.json({ ok: true, items: states });
  }
  if (!["airdrop_winners", "recruiter_leaderboard", "squad_leaderboard"].includes(resourceType)) {
    return res.status(400).json({ ok: false, error: "Invalid resourceType" });
  }
  const item = await getRewardPublicationState(resourceType as any, resourceKey);
  res.json({ ok: true, item });
}));

app.post("/internal/rewards/publications", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const resourceType = String(req.body?.resourceType || "").trim();
  const resourceKey = String(req.body?.resourceKey || "default").trim() || "default";
  if (!["airdrop_winners", "recruiter_leaderboard", "squad_leaderboard"].includes(resourceType)) {
    return res.status(400).json({ ok: false, error: "Invalid resourceType" });
  }
  const state = await setRewardPublicationState({
    resourceType: resourceType as any,
    resourceKey,
    isPublished: Boolean(req.body?.isPublished),
    changedBy: req.body?.actedBy ?? null,
    reason: req.body?.reason ?? null,
    metadataJson: req.body?.metadataJson ?? null,
  });
  const adminAction = await recordRewardAdminAction({
    actionType: "publication_change",
    resourceType,
    resourceKey,
    actedBy: req.body?.actedBy ?? null,
    reason: req.body?.reason ?? null,
    detailsJson: {
      isPublished: state.isPublished,
      metadataJson: state.metadataJson,
    },
  });
  res.json({ ok: true, state, adminAction });
}));

app.get("/internal/rewards/ops/routing", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const chainId = req.query.chainId != null && String(req.query.chainId).trim() !== "" ? Number(req.query.chainId) : ENV.DEFAULT_EVM_CHAIN_ID;
  if (!Number.isFinite(chainId)) {
    return res.status(400).json({ ok: false, error: "Invalid chainId" });
  }
  const diagnostics = await getRewardRoutingDiagnostics(chainId);
  res.json({ ok: true, diagnostics });
}));

app.get("/internal/rewards/ops/claim-vault", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const posture = await getRewardClaimVaultPosture();
  res.json({ ok: true, posture });
}));

app.get("/internal/rewards/ops/epoch-status", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const limit = Math.min(Number(req.query.limit || 20), 100);
  const items = await listRewardEpochProcessorStatuses(limit);
  res.json({ ok: true, items });
}));

app.get("/internal/rewards/ops/alerts", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const items = await listRewardOpsAlerts();
  res.json({ ok: true, items });
}));

app.get("/internal/rewards/ops/admin-actions", wrap(async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const resourceType = req.query.resourceType != null && String(req.query.resourceType).trim() !== "" ? String(req.query.resourceType).trim() : null;
  const actionType = req.query.actionType != null && String(req.query.actionType).trim() !== "" ? String(req.query.actionType).trim() : null;
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const items = await listRewardAdminActions({ resourceType, actionType, limit });
  res.json({ ok: true, items });
}));

app.get("/api/rewards/me", wrap(async (req, res) => {
  const address = parseWalletAddressOrNull(req.query.address);
  if (!address) {
    return res.status(400).json({ error: "Invalid address" });
  }
  const summary = await getWalletRewardSummary(address);
  if (!summary) return res.status(404).json({ error: "Wallet reward summary not found" });
  res.json(toPublicWalletRewardSummary(summary));
}));

app.get("/api/rewards/me/history", wrap(async (req, res) => {
  const address = parseWalletAddressOrNull(req.query.address);
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const program = req.query.program != null && String(req.query.program).trim() !== "" ? String(req.query.program).trim() : null;
  if (!address) {
    return res.status(400).json({ error: "Invalid address" });
  }
  const items = await listWalletRewardHistory(address, { limit, program: program as any });
  res.json({ items: items.map(toPublicWalletHistoryItem) });
}));

app.get("/api/rewards/me/claims", wrap(async (req, res) => {
  const address = parseWalletAddressOrNull(req.query.address);
  const epochId = req.query.epochId != null && String(req.query.epochId).trim() !== "" ? Number(req.query.epochId) : null;
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const program = req.query.program != null && String(req.query.program).trim() !== "" ? String(req.query.program).trim() : null;
  if (!address) {
    return res.status(400).json({ error: "Invalid address" });
  }
  if (epochId != null && !Number.isFinite(epochId)) {
    return res.status(400).json({ error: "Invalid epochId" });
  }
  if (program != null && !(REWARD_PROGRAMS as readonly string[]).includes(program)) {
    return res.status(400).json({ error: "Invalid reward program" });
  }
  const items = await listRewardClaims({ walletAddress: address, epochId, program: program as any, limit });
  const claims = items.map(toPublicRewardClaim);
  res.json({ items: claims, claims });
}));

app.get("/api/rewards/me/eligibility", wrap(async (req, res) => {
  const address = parseWalletAddressOrNull(req.query.address);
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const program = req.query.program != null && String(req.query.program).trim() !== "" ? String(req.query.program).trim() : null;
  if (!address) {
    return res.status(400).json({ error: "Invalid address" });
  }
  if (program != null && !(ELIGIBILITY_PROGRAMS as readonly string[]).includes(program)) {
    return res.status(400).json({ error: "Invalid eligibility program" });
  }
  const items = await listWalletEligibilityHistory(address, { limit, program: program as any });
  res.json({ items: items.map(toPublicEligibilityItem) });
}));

app.get("/api/airdrops/current", wrap(async (req, res) => {
  const chainId = Number(req.query.chainId || ENV.DEFAULT_EVM_CHAIN_ID);
  if (!Number.isFinite(chainId) || chainId <= 0) {
    return res.status(400).json({ error: "Invalid chainId" });
  }
  res.json(await getCurrentAirdropSnapshot(chainId));
}));

app.get("/api/airdrops/preview", wrap(async (req, res) => {
  const chainId = Number(req.query.chainId || ENV.DEFAULT_EVM_CHAIN_ID);
  if (!Number.isFinite(chainId) || chainId <= 0) {
    return res.status(400).json({ error: "Invalid chainId" });
  }
  res.json(await getAirdropPreview(chainId));
}));

app.get("/api/airdrops/winners", wrap(async (req, res) => {
  if (!(await requirePublishedResource(res, "airdrop_winners"))) return;
  const epochId = req.query.epochId != null && String(req.query.epochId).trim() !== "" ? Number(req.query.epochId) : null;
  const program = req.query.program != null && String(req.query.program).trim() !== "" ? String(req.query.program).trim() : null;
  const walletAddress = req.query.walletAddress ? String(req.query.walletAddress) : null;
  const limit = Math.min(Number(req.query.limit || 100), 500);
  if (epochId != null && !Number.isFinite(epochId)) {
    return res.status(400).json({ error: "Invalid epochId" });
  }
  if (program != null && !(AIRDROP_DRAW_PROGRAMS as readonly string[]).includes(program)) {
    return res.status(400).json({ error: "Invalid airdrop program" });
  }
  const items = await listAirdropWinners({ epochId, program: program as any, walletAddress, publishedOnly: true, limit });
  res.json({ items });
}));

app.get("/api/squads", wrap(async (req, res) => {
  if (!(await requirePublishedResource(res, "squad_leaderboard"))) return;
  const epochId = req.query.epochId != null && String(req.query.epochId).trim() !== "" ? Number(req.query.epochId) : null;
  if (epochId != null && !Number.isFinite(epochId)) {
    return res.status(400).json({ error: "Invalid epochId" });
  }
  const preview = await getSquadAllocationPreview(epochId ?? null);
  res.json({
    ok: true,
    epoch: preview.epoch,
    globalPoolAmount: preview.globalPoolAmount,
    carryoverAmount: preview.carryoverAmount,
    squads: preview.leaderboard,
  });
}));

app.get("/api/squads/members", wrap(async (req, res) => {
  if (!(await requirePublishedResource(res, "squad_leaderboard"))) return;
  const epochId = req.query.epochId != null && String(req.query.epochId).trim() !== "" ? Number(req.query.epochId) : null;
  const recruiterCode = req.query.recruiterCode != null && String(req.query.recruiterCode).trim() !== "" ? String(req.query.recruiterCode).trim().toLowerCase() : null;
  const walletAddress = req.query.walletAddress ? String(req.query.walletAddress).trim().toLowerCase() : null;
  const limit = Math.min(Number(req.query.limit || 200), 500);
  if (epochId != null && !Number.isFinite(epochId)) {
    return res.status(400).json({ error: "Invalid epochId" });
  }
  const preview = await getSquadAllocationPreview(epochId ?? null);
  const items = preview.members
    .filter((member) => !recruiterCode || String(member.recruiterCode ?? "").toLowerCase() === recruiterCode)
    .filter((member) => !walletAddress || member.walletAddress === walletAddress)
    .slice(0, limit);
  res.json({ ok: true, epoch: preview.epoch, items });
}));

app.get("/api/recruiters/:code/summary", wrap(async (req, res) => {
  const recruiter = await getRecruiterSummaryByCode(req.params.code);
  if (!recruiter) return res.status(404).json({ error: "Recruiter summary not found" });
  res.json(recruiter);
}));

app.get("/api/recruiters/wallet/:wallet/summary", wrap(async (req, res) => {
  const recruiter = await getRecruiterSummaryByWalletAddress(req.params.wallet);
  if (!recruiter) return res.status(404).json({ error: "Recruiter summary not found" });
  res.json(recruiter);
}));

app.get("/api/recruiters/:code/replacements", wrap(async (req, res) => {
  const recruiter = await getRecruiterSummaryByCode(req.params.code);
  if (!recruiter) return res.status(404).json({ ok: false, error: "Recruiter summary not found" });

  const limit = Math.min(Number(req.query.limit || 5), 20);
  const replacements = (await listRecruiterSummaries({ status: "active", limit: limit + 1 }))
    .filter((item) => item.code.toLowerCase() !== recruiter.code.toLowerCase())
    .slice(0, limit);

  res.json({
    ok: true,
    recruiter: {
      recruiterId: recruiter.recruiterId,
      code: recruiter.code,
      displayName: recruiter.displayName,
      status: recruiter.status,
      closedAt: recruiter.closedAt,
    },
    replacements,
  });
}));

app.get("/api/squads/:recruiterCode/summary", wrap(async (req, res) => {
  if (!(await requirePublishedResource(res, "squad_leaderboard"))) return;
  const squad = await getSquadSummaryByRecruiterCode(req.params.recruiterCode);
  if (!squad) return res.status(404).json({ error: "Squad summary not found" });
  res.json(squad);
}));

// Trades activity (bonding curve buys/sells) for a wallet.
// GET /api/activity/trades?chainId=97&address=0x...&limit=50&cursor=BLOCK:LOG
app.get("/api/activity/trades", wrap(async (req, res) => {
  const chainId = Number(req.query.chainId || ENV.DEFAULT_EVM_CHAIN_ID);
  const address = parseWalletAddressOrNull(req.query.address);
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const cursorRaw = String(req.query.cursor || "").trim();

  if (!Number.isFinite(chainId)) {
    return res.status(400).json({ error: "Invalid chainId" });
  }
  if (!address) {
    return res.status(400).json({ error: "Invalid address" });
  }

  let cursorBlock: number | null = null;
  let cursorLog: number | null = null;
  if (cursorRaw) {
    const parts = cursorRaw.split(":");
    const b = Number(parts[0]);
    const l = Number(parts[1]);
    if (Number.isFinite(b) && Number.isFinite(l)) {
      cursorBlock = b;
      cursorLog = l;
    }
  }

  const params: any[] = [chainId, address];
  let whereCursor = "";
  if (cursorBlock != null && cursorLog != null) {
    params.push(cursorBlock, cursorLog);
    whereCursor = "and (t.block_number < $3 or (t.block_number = $3 and t.log_index < $4))";
  }

  params.push(limit);

  const r = await pool.query(
    `select
       t.tx_hash,
       t.log_index,
       t.block_number,
       t.block_time,
       t.side,
       t.wallet,
       t.token_amount,
       t.bnb_amount,
       t.price_bnb,
       t.campaign_address,
       c.name,
       c.symbol,
       c.logo_uri
     from public.curve_trades t
     left join public.campaigns c
       on c.chain_id = t.chain_id
      and c.campaign_address = t.campaign_address
     where t.chain_id = $1
       and ${walletEqualsSql("t.wallet", 2)}
       ${whereCursor}
     order by t.block_number desc, t.log_index desc
     limit $${params.length}`,
    params
  );

  const items = (r.rows || []).map((row: any) => ({
    id: `${row.tx_hash}:${row.log_index}`,
    txHash: row.tx_hash,
    logIndex: Number(row.log_index),
    blockNumber: Number(row.block_number),
    blockTime: row.block_time,
    side: row.side,
    wallet: row.wallet,
    tokenAmount: row.token_amount,
    bnbAmount: row.bnb_amount,
    priceBnb: row.price_bnb,
    campaignAddress: row.campaign_address,
    campaignName: row.name ?? null,
    campaignSymbol: row.symbol ?? null,
    logoUri: row.logo_uri ?? null,
  }));

  const last = items[items.length - 1];
  const nextCursor = last ? `${last.blockNumber}:${last.logIndex}` : null;

  res.json({ items, nextCursor });
}));

// Comments activity for a wallet (authored comments).
// GET /api/activity/comments?chainId=97&address=0x...&limit=50&cursor=TS:ID
app.get("/api/activity/comments", wrap(async (req, res) => {
  const chainId = Number(req.query.chainId || ENV.DEFAULT_EVM_CHAIN_ID);
  const address = parseWalletAddressOrNull(req.query.address);
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const cursorRaw = String(req.query.cursor || "").trim();

  if (!Number.isFinite(chainId)) {
    return res.status(400).json({ error: "Invalid chainId" });
  }
  if (!address) {
    return res.status(400).json({ error: "Invalid address" });
  }

  let cursorTs: Date | null = null;
  let cursorId: number | null = null;
  if (cursorRaw) {
    const parts = cursorRaw.split(":");
    const ts = Number(parts[0]);
    const id = Number(parts[1]);
    if (Number.isFinite(ts) && Number.isFinite(id)) {
      cursorTs = new Date(ts * 1000);
      cursorId = id;
    }
  }

  const params: any[] = [chainId, address];
  let whereCursor = "";
  if (cursorTs && cursorId != null) {
    params.push(cursorTs, cursorId);
    whereCursor = "and (c.created_at < $3 or (c.created_at = $3 and c.id < $4))";
  }

  params.push(limit);

  const r = await pool.query(
    `select
       c.id,
       c.campaign_address,
       c.token_address,
       c.author_address,
       c.body,
       c.parent_id,
       c.created_at,
       camp.name,
       camp.symbol,
       camp.logo_uri
     from public.token_comments c
     left join public.campaigns camp
       on camp.chain_id = c.chain_id
      and camp.campaign_address = c.campaign_address
     where c.chain_id = $1
       and ${walletEqualsSql("c.author_address", 2)}
       and c.status = 0
       ${whereCursor}
     order by c.created_at desc, c.id desc
     limit $${params.length}`,
    params
  );

  const items = (r.rows || []).map((row: any) => ({
    id: Number(row.id),
    campaignAddress: row.campaign_address,
    tokenAddress: row.token_address,
    authorAddress: row.author_address,
    body: row.body,
    parentId: row.parent_id,
    createdAt: row.created_at,
    campaignName: row.name ?? null,
    campaignSymbol: row.symbol ?? null,
    logoUri: row.logo_uri ?? null,
  }));

  const last = items[items.length - 1];
  const nextCursor = last
    ? `${Math.floor(new Date(last.createdAt).getTime() / 1000)}:${last.id}`
    : null;

  res.json({ items, nextCursor });
}));

// Created campaigns for a wallet.
// GET /api/activity/created?chainId=97&address=0x...&limit=50&cursor=TS:ADDR
app.get("/api/activity/created", wrap(async (req, res) => {
  const chainId = Number(req.query.chainId || ENV.DEFAULT_EVM_CHAIN_ID);
  const address = parseWalletAddressOrNull(req.query.address);
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const cursorRaw = String(req.query.cursor || "").trim();

  if (!Number.isFinite(chainId)) {
    return res.status(400).json({ error: "Invalid chainId" });
  }
  if (!address) {
    return res.status(400).json({ error: "Invalid address" });
  }

  let cursorTs: Date | null = null;
  let cursorAddr: string | null = null;
  if (cursorRaw) {
    const parts = cursorRaw.split(":");
    const ts = Number(parts[0]);
    const addr = parseWalletAddressOrNull(parts[1]);
    if (Number.isFinite(ts) && addr) {
      cursorTs = new Date(ts * 1000);
      cursorAddr = addr;
    }
  }

  const params: any[] = [chainId, address];
  let whereCursor = "";
  if (cursorTs && cursorAddr) {
    params.push(cursorTs, cursorAddr);
    whereCursor = `and (
      coalesce(c.created_at_chain, c.created_at) < $3
      or (coalesce(c.created_at_chain, c.created_at) = $3 and c.campaign_address < $4)
    )`;
  }

  params.push(limit);

  const r = await pool.query(
    `select
       c.campaign_address,
       c.token_address,
       c.name,
       c.symbol,
       c.logo_uri,
       c.created_at_chain,
       c.created_at
     from public.campaigns c
     where c.chain_id = $1
       and ${walletEqualsSql("c.creator_address", 2)}
       ${whereCursor}
     order by coalesce(c.created_at_chain, c.created_at) desc, c.campaign_address desc
     limit $${params.length}`,
    params
  );

  const items = (r.rows || []).map((row: any) => ({
    campaignAddress: row.campaign_address,
    tokenAddress: row.token_address,
    name: row.name ?? null,
    symbol: row.symbol ?? null,
    logoUri: row.logo_uri ?? null,
    createdAt: row.created_at_chain ?? row.created_at ?? null,
  }));

  const last = items[items.length - 1];
  const lastTs = last?.createdAt ? Math.floor(new Date(last.createdAt).getTime() / 1000) : null;
  const nextCursor = last && lastTs ? `${lastTs}:${last.campaignAddress}` : null;

  res.json({ items, nextCursor });
}));

// Interactions (Upvotes) for a wallet.
// GET /api/activity/interactions?chainId=97&address=0x...&limit=50&cursor=BLOCK:LOG
app.get("/api/activity/interactions", wrap(async (req, res) => {
  const chainId = Number(req.query.chainId || ENV.DEFAULT_EVM_CHAIN_ID);
  const address = parseWalletAddressOrNull(req.query.address);
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const cursorRaw = String(req.query.cursor || "").trim();

  if (!Number.isFinite(chainId)) {
    return res.status(400).json({ error: "Invalid chainId" });
  }
  if (!address) {
    return res.status(400).json({ error: "Invalid address" });
  }

  let cursorBlock: number | null = null;
  let cursorLog: number | null = null;
  if (cursorRaw) {
    const parts = cursorRaw.split(":");
    const b = Number(parts[0]);
    const l = Number(parts[1]);
    if (Number.isFinite(b) && Number.isFinite(l)) {
      cursorBlock = b;
      cursorLog = l;
    }
  }

  const params: any[] = [chainId, address];
  let whereCursor = "";
  if (cursorBlock != null && cursorLog != null) {
    params.push(cursorBlock, cursorLog);
    whereCursor = "and (v.block_number < $3 or (v.block_number = $3 and v.log_index < $4))";
  }

  params.push(limit);

  const r = await pool.query(
    `select
       v.tx_hash,
       v.log_index,
       v.block_number,
       v.block_timestamp,
       v.campaign_address,
       v.voter_address,
       v.asset_address,
       v.amount_raw,
       v.meta,
       c.name,
       c.symbol,
       c.logo_uri
     from public.votes v
     left join public.campaigns c
       on c.chain_id = v.chain_id
      and c.campaign_address = v.campaign_address
     where v.chain_id = $1
       and ${walletEqualsSql("v.voter_address", 2)}
       and v.status = 'confirmed'
       ${whereCursor}
     order by v.block_number desc, v.log_index desc
     limit $${params.length}`,
    params
  );

  const items = (r.rows || []).map((row: any) => ({
    id: `${row.tx_hash}:${row.log_index}`,
    txHash: row.tx_hash,
    logIndex: Number(row.log_index),
    blockNumber: Number(row.block_number),
    blockTime: row.block_timestamp,
    campaignAddress: row.campaign_address,
    voterAddress: row.voter_address,
    assetAddress: row.asset_address,
    amountRaw: row.amount_raw,
    meta: row.meta,
    campaignName: row.name ?? null,
    campaignSymbol: row.symbol ?? null,
    logoUri: row.logo_uri ?? null,
    type: "upvote",
  }));

  const last = items[items.length - 1];
  const nextCursor = last ? `${last.blockNumber}:${last.logIndex}` : null;

  res.json({ items, nextCursor });
}));

/**
 * Snapshot endpoints for TokenDetails.
 * Path :campaign accepts either LaunchCampaign or public ERC-20 token address.
 */
app.get("/api/token/:campaign/summary", wrap(async (req, res) => {
  const chainId = Number(req.query.chainId || ENV.DEFAULT_EVM_CHAIN_ID);
  const identity = await resolveMarketIdentityOrPassthrough(chainId, String(req.params.campaign || ""));
  const campaign = identity.campaignAddress;

  await pool.query(
    `alter table public.token_stats add column if not exists ath_marketcap_bnb double precision`,
  );

  const r = await pool.query(
    `with stored as (
       select *
       from public.token_stats
       where chain_id=$1 and campaign_address=$2
     ),
     latest as (
       select price_bnb, block_time
       from public.curve_trades
       where chain_id=$1 and campaign_address=$2
       order by block_number desc, log_index desc
       limit 1
     ),
     agg as (
       select
         count(*)::int as trade_count,
         coalesce(sum(case when side='buy' then token_amount else 0 end),0) -
           coalesce(sum(case when side='sell' then token_amount else 0 end),0) as sold_tokens,
         coalesce(sum(case when block_time >= now() - interval '24 hours' then bnb_amount else 0 end),0) as vol_24h_bnb,
         max(block_time) as last_trade_at
       from public.curve_trades
       where chain_id=$1 and campaign_address=$2
     )
     select
       $1::int as chain_id,
       $2::text as campaign_address,
       case when coalesce(agg.trade_count,0) > 0 then latest.price_bnb else stored.last_price_bnb end as last_price_bnb,
       case when coalesce(agg.trade_count,0) > 0 then agg.sold_tokens else stored.sold_tokens end as sold_tokens,
       stored.reserve_bnb,
       case
         when coalesce(agg.trade_count,0) > 0 and latest.price_bnb is not null then latest.price_bnb * agg.sold_tokens
         else stored.marketcap_bnb
       end as marketcap_bnb,
       stored.ath_marketcap_bnb,
       case when coalesce(agg.trade_count,0) > 0 then agg.vol_24h_bnb else stored.vol_24h_bnb end as vol_24h_bnb,
       stored.change_5m,
       stored.change_1h,
       stored.change_24h,
       case
         when coalesce(agg.trade_count,0) > 0 then greatest(coalesce(stored.updated_at, to_timestamp(0)), coalesce(agg.last_trade_at, to_timestamp(0)))
         else stored.updated_at
       end as updated_at
     from agg
     left join stored on true
     left join latest on true
     where stored.chain_id is not null or coalesce(agg.trade_count,0) > 0`,
    [chainId, campaign]
  );
  res.json(r.rows[0] || null);
}));

function rawIntString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = text.match(/^(\d+)(?:\.0+)?$/);
  return match ? match[1] : text;
}

function serializeCurveTradeRow(row: Record<string, unknown>) {
  return {
    ...row,
    token_amount_raw: rawIntString(row.token_amount_raw) ?? row.token_amount_raw,
    bnb_amount_raw: rawIntString(row.bnb_amount_raw) ?? row.bnb_amount_raw,
    sold_tokens_after_raw: rawIntString(row.sold_tokens_after_raw) ?? row.sold_tokens_after_raw,
  };
}

async function handleTokenTrades(req: any, res: any) {
  const chainId = Number(req.query.chainId || ENV.DEFAULT_EVM_CHAIN_ID);
  let identity = await resolveMarketIdentityOrPassthrough(chainId, String(req.params.campaign || ""));
  let campaign = identity.campaignAddress;
  const limit = Math.min(Number(req.query.limit || 50), 200);

  // Fast path: never block the HTTP response on multi-minute getLogs backfills.
  // AWTT-style empty history used to hang /trades for 90s+ and starve the UI.
  const r = await pool.query(
    `select
       tx_hash, log_index, block_number, block_time,
       side, wallet,
       token_amount_raw, bnb_amount_raw,
       token_amount, bnb_amount, price_bnb,
       sold_tokens_after_raw
     from public.curve_trades
     where chain_id=$1 and campaign_address=$2
     order by block_number desc, log_index desc
     limit $3`,
    [chainId, campaign, limit],
  );

  if ((r.rowCount ?? 0) > 0) {
    res.json(r.rows.map((row: Record<string, unknown>) => serializeCurveTradeRow(row)));
    // EVM history can still repair its cursor in the background. Solana uses the
    // dedicated program-signature indexer and must never enter eth_getLogs recovery.
    if (chainId === 101) {
      void import("./solanaIndexer.js")
        .then(({ kickSolanaCampaignHistoryBackfill }) => kickSolanaCampaignHistoryBackfill(campaign))
        .catch((error) => {
          console.warn("[api] solana campaign backfill kick failed", error instanceof Error ? error.message : String(error));
        });
    } else {
      void import("./emptyTradeCursorRewind.js")
        .then(({ rewindEmptyCampaignTradeCursor }) => rewindEmptyCampaignTradeCursor(chainId, campaign))
        .catch(() => undefined);
    }
    return;
  }

  if (chainId === 101) {
    // Return immediately, then scan this campaign PDA so empty books recover
    // without blocking Token Details / WTR.
    void import("./solanaIndexer.js")
      .then(({ kickSolanaCampaignHistoryBackfill }) => kickSolanaCampaignHistoryBackfill(campaign))
      .catch((error) => {
        console.warn("[api] solana campaign backfill kick failed", error instanceof Error ? error.message : String(error));
      });
    return res.json([]);
  }

  // Empty history: bounded ensure+backfill (paid RPC). Graduated tokens often need
  // a longer window than bonding (WIC had 0 rows after cleanup).
  try {
    const { ensureCampaignTradeHistory } = await import("./ensureCampaignTradeHistory.js");
    const { rewindEmptyCampaignTradeCursor } = await import("./emptyTradeCursorRewind.js");
    await Promise.race([
      (async () => {
        const ensured = await ensureCampaignTradeHistory(chainId, campaign);
        if (ensured.campaign) campaign = ensured.campaign;
        await rewindEmptyCampaignTradeCursor(chainId, campaign);
      })(),
      new Promise<void>((resolve) => setTimeout(resolve, 20_000)),
    ]);
  } catch (error) {
    console.warn("[api] ensureCampaignTradeHistory skipped", String((error as any)?.message || error));
  }

  // Kick a full backfill after the response if still empty (non-blocking).
  void import("./ensureCampaignTradeHistory.js")
    .then(({ ensureCampaignTradeHistory }) => ensureCampaignTradeHistory(chainId, campaign))
    .catch(() => undefined);

  try {
    identity = await resolveMarketIdentityOrPassthrough(chainId, campaign);
    campaign = identity.campaignAddress || campaign;
  } catch {
    // keep campaign
  }

  const r2 = await pool.query(
    `select
       tx_hash, log_index, block_number, block_time,
       side, wallet,
       token_amount_raw, bnb_amount_raw,
       token_amount, bnb_amount, price_bnb,
       sold_tokens_after_raw
     from public.curve_trades
     where chain_id=$1 and campaign_address=$2
     order by block_number desc, log_index desc
     limit $3`,
    [chainId, campaign, limit],
  );

  res.json(r2.rows.map((row: Record<string, unknown>) => serializeCurveTradeRow(row)));
}

app.get("/api/token/:campaign/trades", wrap(handleTokenTrades));
// Common typo / singular form — same payload as /trades
app.get("/api/token/:campaign/trade", wrap(handleTokenTrades));


// ---------------------------------------------
// UP Only League (objective leaderboards)
// ---------------------------------------------
// /api/league?chainId=97&category=straight_up|fastest_graduation|largest_buy&period=weekly|monthly|all_time&limit=50
app.get("/api/league", wrap(async (req, res) => {
  const chainId = Number(req.query.chainId || ENV.DEFAULT_EVM_CHAIN_ID);
  const category = String(req.query.category || "fastest_graduation");
  const period = String(req.query.period || "weekly");
  const limit = Math.min(Number(req.query.limit || 50), 200);

  const periodFilterCampaign =
    period === "monthly"
      ? "c.graduated_at_chain >= date_trunc('month', now()) and c.graduated_at_chain < date_trunc('month', now()) + interval '1 month'"
      : period === "weekly"
      ? "c.graduated_at_chain >= date_trunc('week', now()) and c.graduated_at_chain < date_trunc('week', now()) + interval '1 week'"
      : "true";

  const periodFilterTrades =
    period === "monthly"
      ? "t.block_time >= date_trunc('month', now()) and t.block_time < date_trunc('month', now()) + interval '1 month'"
      : period === "weekly"
      ? "t.block_time >= date_trunc('week', now()) and t.block_time < date_trunc('week', now()) + interval '1 week'"
      : "true";

  if (category === "largest_buy") {
    // One row per campaign: the single largest buy in the epoch (weekly or monthly).
    // Weekly and monthly use separate period windows; monthly is not a list of weekly rows.
    const r = await pool.query(
      `with buys as (
         select
           t.campaign_address,
           c.name,
           c.symbol,
           c.logo_uri,
           c.creator_address,
           c.fee_recipient_address,
           c.token_address,
           t.wallet as buyer_address,
           t.bnb_amount_raw as bnb_amount_raw,
           t.tx_hash,
           t.log_index,
           t.block_number,
           t.block_time,
           row_number() over (
             partition by t.campaign_address
             order by (t.bnb_amount_raw::numeric) desc, t.block_number desc, t.log_index desc
           ) as rn
         from public.curve_trades t
         join public.campaigns c
           on c.chain_id = t.chain_id and c.campaign_address = t.campaign_address
         where t.chain_id = $1
           and t.side = 'buy'
           and ${periodFilterTrades}
           and lower(t.wallet) <> lower(c.creator_address)
           and (c.fee_recipient_address is null or lower(t.wallet) <> lower(c.fee_recipient_address))
           and lower(t.wallet) <> lower(c.campaign_address)
       )
       select
         campaign_address,
         name,
         symbol,
         logo_uri,
         creator_address,
         fee_recipient_address,
         token_address,
         buyer_address,
         bnb_amount_raw,
         tx_hash,
         log_index,
         block_number,
         block_time
       from buys
       where rn = 1
       order by (bnb_amount_raw::numeric) desc, block_number desc, log_index desc
       limit $2`,
      [chainId, limit]
    );

    return res.json({ chainId, category, period, items: r.rows });
  }

  if (category === "top_earner") {
    // Trader PnL inside bonding curve for the selected epoch.
    // Creator buys/sells on *their own* campaign are excluded.
    // The same wallet trading *other* campaigns counts (creator can be a trader elsewhere).
    const solana = chainId === 101;
    const walletSel = solana ? "t.wallet" : "lower(t.wallet)";
    const walletEq = (left: string, right: string) =>
      solana ? `${left} = ${right}` : `lower(${left}) = lower(${right})`;
    const r = await pool.query(
      `with wallet_pnl as (
         select
           ${walletSel} as wallet,
           sum(
             case
               when t.side = 'sell' then (t.bnb_amount_raw::numeric)
               when t.side = 'buy' then -(t.bnb_amount_raw::numeric)
               else 0
             end
           ) as profit_raw_num,
           sum(case when t.side = 'sell' then (t.bnb_amount_raw::numeric) else 0 end) as sells_raw_num,
           count(*)::int as trades_count,
           count(*) filter (where t.side = 'sell')::int as sell_trades,
           count(distinct t.campaign_address)::int as campaigns_traded
         from public.curve_trades t
         join public.campaigns c
           on c.chain_id = t.chain_id and c.campaign_address = t.campaign_address
         where t.chain_id = $1
           and ${periodFilterTrades}
           and t.wallet is not null
           and ${walletEq("t.wallet", "c.campaign_address")} is false
           and (c.fee_recipient_address is null or ${walletEq("t.wallet", "c.fee_recipient_address")} is false)
           and ${walletEq("t.wallet", "c.creator_address")} is false
         group by ${walletSel}
         having count(*) filter (where t.side = 'sell') > 0
             or sum(
               case
                 when t.side = 'sell' then (t.bnb_amount_raw::numeric)
                 when t.side = 'buy' then -(t.bnb_amount_raw::numeric)
                 else 0
               end
             ) > 0
       )
       select
         wallet,
         trunc(profit_raw_num)::text as profit_raw,
         trunc(sells_raw_num)::text as sells_raw,
         trades_count,
         campaigns_traded
       from wallet_pnl
       order by profit_raw_num desc, sells_raw_num desc, trades_count desc, wallet asc
       limit $2`,
      [chainId, limit]
    );

    return res.json({ chainId, category, period, items: r.rows });
  }

  const requireUniqueBuyers = category === "fastest_graduation";
  // Mainnet keeps the anti-sybil bar; testnet (97) uses a low bar so real grads appear in leagues.
  const minUniqueBuyers = chainId === 97 ? 1 : 25;
  const extra: string[] = [];
  if (requireUniqueBuyers) extra.push(`coalesce(s.unique_buyers,0) >= ${minUniqueBuyers}`);
  if (category === "straight_up") extra.push("coalesce(s.sells_count,0) = 0");
  const extraWhere = extra.length ? `and ${extra.join(" and ")}` : "";

  // Scope trade stats to graduated campaigns in-period only (was full-table group by).
  const r = await pool.query(
    `with graduated as (
       select c.chain_id, c.campaign_address
         from public.campaigns c
        where c.chain_id = $1
          and c.created_at_chain is not null
          and c.graduated_at_chain is not null
          and ${periodFilterCampaign}
     ),
     stats as (
       select
         t.chain_id,
         t.campaign_address,
         count(distinct case when t.side='buy' then t.wallet end) as unique_buyers,
         sum(case when t.side='sell' then 1 else 0 end) as sells_count,
         sum(case when t.side='buy' then (t.bnb_amount_raw::numeric) else 0 end) as buy_volume_raw
       from public.curve_trades t
       inner join graduated g
         on g.chain_id = t.chain_id and g.campaign_address = t.campaign_address
       where t.chain_id = $1
       group by t.chain_id, t.campaign_address
     )
     select
       c.campaign_address,
       c.creator_address,
       c.fee_recipient_address,
       c.token_address,
       c.name,
       c.symbol,
       c.logo_uri,
       c.created_at_chain,
       c.graduated_at_chain,
       c.graduated_block,
       coalesce(s.unique_buyers,0)::int as unique_buyers,
       coalesce(s.sells_count,0)::int as sells_count,
       coalesce(s.buy_volume_raw,0)::text as buy_volume_raw,
       extract(epoch from (c.graduated_at_chain - c.created_at_chain))::bigint as duration_seconds
     from public.campaigns c
     left join stats s
       on s.chain_id=c.chain_id and s.campaign_address=c.campaign_address
     where c.chain_id=$1
       and c.created_at_chain is not null
       and c.graduated_at_chain is not null
       and ${periodFilterCampaign}
       ${extraWhere}
     order by duration_seconds asc nulls last, c.graduated_at_chain asc
     limit $2`,
    [chainId, limit]
  );

  return res.json({ chainId, category, period, items: r.rows });
}));

app.get("/api/token/:campaign/candles", wrap(async (req, res) => {
  const chainId = Number(req.query.chainId || ENV.DEFAULT_EVM_CHAIN_ID);
  const identity = await resolveMarketIdentityOrPassthrough(chainId, String(req.params.campaign || ""));
  const campaign = identity.campaignAddress;
  const tf = String(req.query.tf || req.query.resolution || "5s");
  const limit = Math.min(Number(req.query.limit || 200), 2000);

  const r = await pool.query(
    `select bucket_start, o,h,l,c,volume_bnb,trades_count,
            price_o,price_h,price_l,price_c,
            mcap_o,mcap_h,mcap_l,mcap_c
     from public.token_candles
     where chain_id=$1 and campaign_address=$2 and timeframe=$3
     order by bucket_start desc
     limit $4`,
    [chainId, campaign, tf, limit]
  );

  res.json(r.rows.reverse());
}));

// ---------------------------------------------
// Votes + Featured
// ---------------------------------------------

// /api/votes?chainId=97&campaignAddress=0x..&voter=0x..&limit=50
app.get("/api/votes", wrap(async (req, res) => {
  const chainId = Number(req.query.chainId || ENV.DEFAULT_EVM_CHAIN_ID);
  const campaign = String(req.query.campaignAddress || "").toLowerCase();
  const voter = String(req.query.voter || "").toLowerCase();
  const limit = Math.min(Number(req.query.limit || 50), 200);

  const where: string[] = ["chain_id=$1", "status='confirmed'"];
  const params: any[] = [chainId];
  let p = 2;

  if (campaign) {
    where.push(`campaign_address=$${p++}`);
    params.push(campaign);
  }
  if (voter) {
    where.push(`voter_address=$${p++}`);
    params.push(voter);
  }

  const r = await pool.query(
    `select
       chain_id,campaign_address,voter_address,asset_address,amount_raw,
       tx_hash,log_index,block_number,block_timestamp,meta
     from public.votes
     where ${where.join(" and ")}
     order by block_number desc, log_index desc
     limit $${p}`,
    [...params, limit]
  );

  res.json(r.rows);
}));

// /api/featured?chainId=97&sort=trending|24h|7d|all&limit=50
// Admin / web-dashboard: Topaz LP fee monitor (token/market authority lives here).
registerLpFeesRoutes(app);

app.get("/api/featured", wrap(async (req, res) => {
  const chainId = Number(req.query.chainId || ENV.DEFAULT_EVM_CHAIN_ID);
  const sort = String(req.query.sort || "trending");
  const limit = Math.min(Number(req.query.limit || 50), 200);

  const orderBy =
    sort === "24h" ? "votes_24h desc" :
    sort === "7d" ? "votes_7d desc" :
    sort === "all" ? "votes_all_time desc" :
    "trending_score desc";

  const r = await pool.query(
    `select
       chain_id,campaign_address,
       votes_1h,votes_24h,votes_7d,votes_all_time,
       trending_score,last_vote_at,updated_at
     from public.vote_aggregates
     where chain_id=$1
     order by ${orderBy}, campaign_address asc
     limit $2`,
    [chainId, limit]
  );

  res.json(r.rows);
}));
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error("API error:", err);
  res.status(500).json({ ok: false, error: err?.message || String(err) });
});
// Start server (Railway requires 0.0.0.0:PORT) :contentReference[oaicite:1]{index=1}
app.listen(ENV.PORT, "0.0.0.0", () => {
  console.log(`realtime-indexer listening on 0.0.0.0:${ENV.PORT}`);
});

// ---------------------------------------------------------------------------
// Telemetry snapshot (optional)
// ---------------------------------------------------------------------------
let lastIndexerRunAt = 0;
let lastIndexerErrorAt = 0;
let lastIndexerErrorMsg: string | null = null;

async function getLastIndexedBlock(chainId: number): Promise<number | null> {
  try {
    const r = await pool.query(
      `select cursor,last_indexed_block from public.indexer_state where chain_id=$1 and cursor in ('factory','votes')`,
      [chainId]
    );
    if (!r.rowCount) return null;
    // Conservative: take min of known cursors so lag isn't understated
    const vals = r.rows.map((x: any) => Number(x.last_indexed_block)).filter((n: any) => Number.isFinite(n));
    if (!vals.length) return null;
    return Math.min(...vals);
  } catch {
    return null;
  }
}

async function getRpcHeadBlock(): Promise<number | null> {
  const chainId = ENV.DEFAULT_EVM_CHAIN_ID === 97 ? 97 : 56;
  const urls = parseRpcList(chainId === 97 ? ENV.BSC_RPC_HTTP_97 : ENV.BSC_RPC_HTTP_56);
  for (const url of urls.slice(0, 3)) {
    const probe = await probeRpcUrl(url, chainId, 4_000);
    if (probe.ok && probe.headBlock != null) return probe.headBlock;
  }
  return null;
}

startTelemetryReporter(async () => {
  const ts = Math.floor(Date.now() / 1000);
  const defaultChainId = ENV.DEFAULT_EVM_CHAIN_ID === 97 ? 97 : 56;
  const head = await getRpcHeadBlock();
  const last = await getLastIndexedBlock(defaultChainId);
  const lag = head != null && last != null ? Math.max(0, head - last) : null;

  const snap: TelemetrySnapshot = {
    service: "realtime-indexer",
    ts,
    ok: true,
    rps_1m: reqCount1m / 60,
    errors_1m: errCount1m,
    head_block: head ?? undefined,
    last_indexed_block: last ?? undefined,
    lag_blocks: lag ?? undefined,
    last_indexer_run_ms_ago: lastIndexerRunAt ? Date.now() - lastIndexerRunAt : undefined,
    last_indexer_error_ms_ago: lastIndexerErrorAt ? Date.now() - lastIndexerErrorAt : undefined,
  };

  // If we have a recent error, mark ok=false but keep reporting.
  if (lastIndexerErrorAt && Date.now() - lastIndexerErrorAt < 5 * 60_000) {
    snap.ok = false;
  }

  return snap;
});

// Indexer loop
// NOTE: Keep this conservative for public RPCs. We also avoid overlap.
let running = false;
let runningStartedAt = 0;
const INTERVAL_MS = ENV.INDEXER_INTERVAL_MS;

async function runIndexerJob(
  mode: "normal" | "repair" | "discover" | "trades" | "campaigns",
  trigger: "loop" | "manual",
  opts: { campaignAddress?: string; fromBlock?: number; toBlock?: number } = {}
) {
  const allowConcurrentRecovery = mode === "discover" || mode === "trades" || mode === "campaigns";
  const runningForMs = runningStartedAt ? Date.now() - runningStartedAt : null;

  // Never start a second normal/repair pass while one is in flight. Cooperative
  // deadline inside runIndexerOnce ends wedged work; concurrent reclaim only
  // stacked RPC load and prevented cursor advances (TTA tip stuck for hours).
  if (running && !allowConcurrentRecovery) {
    if (runningForMs != null && runningForMs > ENV.INDEXER_STALE_AFTER_MS) {
      console.warn("[indexer] pass still running past stale budget; waiting for cooperative exit", {
        trigger,
        mode,
        runningForMs,
        staleAfterMs: ENV.INDEXER_STALE_AFTER_MS,
      });
    }
    return {
      ok: false,
      skipped: true,
      mode,
      trigger,
      runningForMs,
      staleAfterMs: ENV.INDEXER_STALE_AFTER_MS,
      error: "indexer already running"
    };
  }

  const startedAt = Date.now();
  if (!allowConcurrentRecovery) {
    running = true;
    runningStartedAt = startedAt;
  }
  try {
    lastIndexerRunAt = startedAt;
    if (mode === "discover") {
      await runDiscoveryOnce();
    } else if (mode === "trades" || mode === "campaigns") {
      await runTradeRepairOnce(opts.campaignAddress, { fromBlock: opts.fromBlock, toBlock: opts.toBlock });
    } else if (mode === "repair") {
      await runRepairOnce();
    } else {
      await runIndexerOnce();
    }
    return { ok: true, skipped: false, mode, trigger, durationMs: Date.now() - startedAt };
  } catch (e: any) {
    console.error(`${mode} indexer job error`, e);
    lastIndexerErrorAt = Date.now();
    lastIndexerErrorMsg = String(e?.message || e);
    return { ok: false, skipped: false, mode, trigger, durationMs: Date.now() - startedAt, error: lastIndexerErrorMsg };
  } finally {
    if (!allowConcurrentRecovery) {
      running = false;
      runningStartedAt = 0;
    }
  }
}

async function getRpcDiagnostics(chainId: number, campaign?: string | null) {
  if (chainId !== 97 && chainId !== 56) return null;
  const rpcList = parseRpcList(chainId === 56 ? ENV.BSC_RPC_HTTP_56 : ENV.BSC_RPC_HTTP_97);
  const factory =
    chainId === 56 ? ENV.FACTORY_ADDRESS_56 || "" : ENV.FACTORY_ADDRESS_97 || "";
  const factoryStartBlock =
    chainId === 56 ? ENV.FACTORY_START_BLOCK_56 || null : ENV.FACTORY_START_BLOCK_97 || null;

  if (!rpcList.length) {
    return {
      chainId: null,
      headBlock: null,
      factoryStartBlock,
      headBehindFactoryStart: false,
      factoryCodePresent: false,
      factoryCodeBytes: null,
      campaignCodePresent: campaign ? false : null,
      campaignCodeBytes: null,
      rpcConfigured: false,
      rpcWorkingUrl: null,
      rpcErrors: ["No BSC_RPC_HTTP configured"],
    };
  }

  const probes = await Promise.all(
    rpcList.slice(0, 4).map((url) => probeRpcUrl(url, chainId, 4_000)),
  );
  const working = probes.find((p) => p.ok);
  const rpcErrors = probes
    .filter((p) => !p.ok)
    .map((p) => `${maskRpcUrl(p.url)}: ${p.error || "failed"} (${p.durationMs}ms)`);

  let factoryCode: unknown = null;
  let campaignCode: unknown = null;
  if (working) {
    try {
      factoryCode = factory
        ? await rawRpcCall(working.url, "eth_getCode", [factory, "latest"], 4_000)
        : null;
      campaignCode = campaign
        ? await rawRpcCall(working.url, "eth_getCode", [campaign, "latest"], 4_000)
        : null;
    } catch {
      // leave codes null; head is still useful
    }
  }

  const headBlock = working?.headBlock ?? null;
  const rpcChainId = working?.chainId ?? null;

  return {
    chainId: rpcChainId,
    headBlock,
    factoryStartBlock,
    headBehindFactoryStart: Boolean(factoryStartBlock && headBlock != null && headBlock < factoryStartBlock),
    factoryCodePresent: typeof factoryCode === "string" && factoryCode !== "0x",
    factoryCodeBytes:
      typeof factoryCode === "string" && factoryCode.startsWith("0x")
        ? Math.max(0, (factoryCode.length - 2) / 2)
        : null,
    campaignCodePresent: campaign ? typeof campaignCode === "string" && campaignCode !== "0x" : null,
    campaignCodeBytes:
      campaign && typeof campaignCode === "string" && campaignCode.startsWith("0x")
        ? Math.max(0, (campaignCode.length - 2) / 2)
        : null,
    rpcConfigured: true,
    rpcWorkingUrl: working ? maskRpcUrl(working.url) : null,
    rpcErrors: working ? rpcErrors : rpcErrors.length ? rpcErrors : ["all RPC endpoints failed"],
  };
}

setInterval(async () => {
  await runIndexerJob("normal", "loop");
}, INTERVAL_MS);

// Fast tip-only loop: concurrent with history so live buys (TTA) never wait on
// multi-minute AWTT/WIC catch-up. Soft deadline inside runTipScanOnce.
let tipRunning = false;
const TIP_INTERVAL_MS = Math.max(8_000, Math.min(ENV.INDEXER_INTERVAL_MS, 15_000));
setInterval(async () => {
  if (tipRunning) return;
  tipRunning = true;
  try {
    await runTipScanOnce();
  } catch (e) {
    console.error("[indexer] tip-only loop error", e);
  } finally {
    tipRunning = false;
  }
}, TIP_INTERVAL_MS);
// Kick once shortly after boot so deploy verification is quick.
setTimeout(() => {
  if (tipRunning) return;
  tipRunning = true;
  void runTipScanOnce()
    .catch((e) => console.error("[indexer] tip-only boot error", e))
    .finally(() => {
      tipRunning = false;
    });
}, 3_000);
