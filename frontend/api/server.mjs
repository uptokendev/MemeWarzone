import express from "express";

import { pool } from "../server/db.js";
import { createRailwayProxyMiddleware } from "../server/railwayProxy.js";

import activityTrades from "./activity/trades.js";
import ablyToken from "./ably/token.js";
import bnbUsdPrice from "./price/bnb-usd.js";
import authNonce from "./auth/nonce.js";
import campaignsUpsert from "./campaigns/upsert.js";
import campaigns from "./campaigns.js";
import comments from "./comments.js";
import crypticpumpListings from "./crypticpump-listings.js";
import chatHistory from "./chat/history.js";
import chatJoin from "./chat/join.js";
import chatRealtimeToken from "./chat/realtime-token.js";
import chatSend from "./chat/send.js";
import diagnostics from "./diagnostics.js";
import epochPools from "./epochPools.js";
import featured from "./featured.js";
import followsCampaignList from "./follows/campaign-list.js";
import followsCampaign from "./follows/campaign.js";
import followsUserCounts from "./follows/user-counts.js";
import followsUserList from "./follows/user-list.js";
import followsUser from "./follows/user.js";
import league from "./leagueRouter.js";
import leagueSummary from "./leagueSummary.js";
import leaguePayouts from "./leaguePayouts.js";
import leagueRoot from "./leagueRoot.js";
import profile from "./profile.js";
import profileCabinet from "./profileCabinet.js";
import profilePortfolio from "./profile/portfolio.js";
import postgrad from "./postgrad.js";
import upload from "./upload.js";
import rewards from "./rewards.js";
import shareCard from "./shareCard.js";
import prepareShareCard from "./prepare-share-card.js";
import status from "./status.js";
import newsletter from "./newsletter.js";
import discordNotificationImage from "./discord-notification-image.js";
import tokenMetadata from "./token-metadata.js";
import topazTrades from "./topaz-trades.js";
import votes from "./votes.js";
import votesIngest from "./votes-ingest.js";
import voteCounts from "./vote_counts.js";
import { withAdminOrOps, withInternalAuth, getAuthEnforceSnapshot } from "./lib/apiAuth.js";
import { draftDeploy } from "./dev-fix/draft-deploy.js";
import { solanaDirectCreateV4 } from "./dev-fix/solana-direct-create.js";
import { solanaTradeAuthorizationV1, solanaTradeStatus } from "./dev-fix/solana-trade-authorization-v1.js";
import { solanaGraduationAuthorizationV1 } from "./dev-fix/solana-graduation-authorization-v1.js";
import { solanaGraduationHandoff } from "./dev-fix/solana-graduation-handoff.js";
import { solanaVoteIngest } from "./dev-fix/solana-vote-ingest.js";
import {
  followedDrafts,
  signedDraftCommentReaction,
  signedDraftComments,
  signedDraftFollow,
  signedDraftNotificationSubscription,
} from "./dev-fix/draft-engagement.js";
import { prepareNotifications } from "./dev-fix/prepare-notifications.js";
import { signedDraftById, signedPrepareBySlug } from "./dev-fix/draft-read.js";
import { tickerAvailability } from "./dev-fix/ticker-availability.js";
import { tickerReservationManagement } from "./dev-fix/ticker-reservations.js";
import { draftArchive, draftPromotion, drafts } from "./dev-fix/drafts.js";
import {
  attributionWallet,
  attributionWalletConnect,
  recruiterReferralCapture,
  recruiterSignupCodeAvailability,
  recruiterSignupNonce,
  recruiterSignupStatus,
  recruiterSignupSubmit,
  recruiterSummary,
  recruiterWalletSummary,
  recruiters,
} from "./dev-fix/attribution.js";
import {
  recruiterAuthNonce,
  recruiterAuthVerify,
  recruiterLogout,
  recruiterPortal,
} from "./dev-fix/recruiter-portal.js";
import {
  recruiterMeClaims,
  recruiterMePayouts,
  recruiterMeWalletLink,
} from "./dev-fix/recruiter-payouts.js";
import { routingCreateAuthorization, routingStatus, routingTradeAuthorization } from "./dev-fix/route-auth.js";
import {
  launchpadPreflightBuy,
  launchpadPreflightCreate,
  launchpadPreflightSell,
  securityAuditLog,
  securityClusters,
  securityClusterRestrict,
  securityContractAction,
  securityCreatorLaunchEligibility,
  securityCreatorManualReview,
  securityCreatorProfile,
  securityCreators,
  securityCreatorRestrict,
  securityCreatorTier,
  securityManualReview,
  securityMassDeployers,
  securityStatus,
  securityWalletRestrict,
} from "./dev-fix/security-current-time.js";
import securityRecruiterPayouts from "./dev-fix/security-recruiter-payouts.js";
import {
  adminRewardAlerts,
  adminRewardAuditLog,
  adminRewardBatchById,
  adminRewardBatches,
  adminRewardLedger,
  adminRewardOverview,
  airdropCurrent,
  airdropPreviousWinners,
  airdropWinners,
  internalAirdropDrawRun,
  internalAirdropDraws,
  internalRewardAdminActions,
  internalRewardAlerts,
  internalRewardClaimVault,
  internalRewardEpochStatus,
  internalRewardOps,
  internalRewardPublications,
  internalRewardRouting,
  recruiterReplacements,
  rewardsClaims,
  rewardsEligibility,
  rewardsHistory,
  rewardsMe,
} from "./dev-fix/stubs.js";
import airdropPreview from "./dev-fix/airdrop-preview.js";
import {
  squadMembers,
  squadSummary,
  squadsLeaderboard,
} from "./dev-fix/squads.js";
import {
  internalAirdropsCalculate,
  internalAirdropsPublish,
  internalRewardBatchClose,
  internalRewardBatchPause,
  internalRewardBatchPublish,
  internalRewardBatches,
} from "./dev-fix/reward-batch-ops.js";
import { rewardClaimConfig, rewardClaimIntent, rewardClaimRecord } from "./dev-fix/reward-claim-intent.js";
import dashboardLpFees from "./dashboard/lp-fees.js";
import analyticsIngest from "./analytics/ingest.js";
import analyticsAdmin from "./analytics/admin.js";
import prepareOg from "./prepare-og.js";
import adminAbuseMe from "./admin/abuse/me.js";
import adminAbuseReports from "./admin/abuse/reports.js";
import adminAbusePermissions from "./admin/abuse/permissions.js";
import adminAbuseStaff from "./admin/abuse/staff.js";
import abuseSession from "./abuse/session.js";
import abuseReports from "./abuse/reports.js";

const app = express();
app.disable("x-powered-by");

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "http://localhost:8888",
  "https://memewar.zone",
  "https://www.memewar.zone",
  "https://memewarzone.netlify.app",
  "https://command-center.memewar.zone",
];

const allowedOrigins = new Set(
  DEFAULT_ALLOWED_ORIGINS.concat(
    String(process.env.CORS_ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  )
);

const DEV_ALLOWED_IPS = new Set(
  String(process.env.DEV_ALLOWED_IPS || "185.184.192.242")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

/** When true, any browser Origin is reflected (migration / self-host debugging only). */
const CORS_RELAXED = /^(1|true|yes|on)$/i.test(String(process.env.CORS_RELAXED || "").trim());

console.log(`[api/server] DEV_ALLOWED_IPS for full dev access: ${Array.from(DEV_ALLOWED_IPS).join(", ") || "(none)"}`);
console.log(`[api/server] CORS_RELAXED=${CORS_RELAXED} extraOrigins=${Array.from(allowedOrigins).filter((o) => !DEFAULT_ALLOWED_ORIGINS.includes(o)).join(",") || "(none)"}`);

function isCoolifyOrSelfHostPreview(host) {
  // Coolify / Traefik temporary public hostnames (sslip/nip map DNS → server IP).
  if (host.endsWith(".sslip.io") || host.endsWith(".nip.io")) return true;
  // Optional Coolify app FQDN suffix, e.g. ".apps.example.com"
  const coolifySuffix = String(process.env.CORS_COOLIFY_HOST_SUFFIX || "").trim().toLowerCase();
  if (coolifySuffix) {
    const suffix = coolifySuffix.startsWith(".") ? coolifySuffix : `.${coolifySuffix}`;
    if (host === coolifySuffix.replace(/^\./, "") || host.endsWith(suffix)) return true;
  }
  return false;
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (CORS_RELAXED) return true;
  if (allowedOrigins.has(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    const host = hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
    if (host === "memewar.zone" || host === "www.memewar.zone" || host.endsWith(".memewar.zone")) return true;
    if (host === "memewarzone.netlify.app" || host.endsWith("--memewarzone.netlify.app")) return true;
    if (isCoolifyOrSelfHostPreview(host)) return true;
  } catch {}
  return false;
}

function isDevAllowedIP(req) {
  if (DEV_ALLOWED_IPS.size === 0) return false;
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || req.ip || req.socket?.remoteAddress || "";
  const clean = ip.replace(/^::ffff:/, ""); // IPv4-mapped
  return DEV_ALLOWED_IPS.has(ip) || DEV_ALLOWED_IPS.has(clean);
}

app.use((req, res, next) => {
  const origin = String(req.headers.origin || "");
  const devIp = isDevAllowedIP(req);

  if (devIp || isAllowedOrigin(origin)) {
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    } else if (devIp) {
      // For direct IP access from allowed dev IP (no origin or cross-origin tools), be permissive
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, x-diagnostics-token, x-rank-events-token, x-ops-key, x-analytics-key");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

function wrap(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };
}

function recruiterCodeAvailabilityPayload({ code, available, reason }) {
  const message =
    reason === "missing" ? "Enter a recruiter code." :
    reason === "invalid_characters" ? "Use lowercase letters, numbers, dashes, or underscores." :
    reason === "too_short" ? "Use at least 3 lowercase letters, numbers, dashes, or underscores." :
    reason === "too_long" ? "Use 24 characters or fewer." :
    reason === "taken" ? "This recruiter code is already taken." :
    reason === "schema_unavailable" ? "Canonical reward attribution schema has not been applied yet." :
    available ? "This recruiter code is available." : "This recruiter code is not available.";

  return {
    ok: true,
    code,
    available,
    reason,
    isAvailable: available,
    checkedVia: "signup-endpoint",
    message,
  };
}

async function recruiterSignupCodeAvailabilityAlias(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const params = new URL(req.url, "http://localhost").searchParams;
  const rawCode = String(params.get("code") || "").trim();
  const code = rawCode.toLowerCase();
  let reason = null;

  if (!code) reason = "missing";
  else if (!/^[a-z0-9_-]+$/.test(code)) reason = "invalid_characters";
  else if (code.length < 3) reason = "too_short";
  else if (code.length > 24) reason = "too_long";

  if (reason) {
    return res.status(200).json(recruiterCodeAvailabilityPayload({ code, available: false, reason }));
  }

  try {
    const { rows } = await pool.query(
      `select 1
         from public.recruiters
        where lower(code) = lower($1)
        limit 1`,
      [code]
    );
    const available = rows.length === 0;
    return res.status(200).json(recruiterCodeAvailabilityPayload({
      code,
      available,
      reason: available ? null : "taken",
    }));
  } catch (error) {
    console.error("[api/recruiters signup code availability]", error);
    if (error?.code === "42P01" || error?.code === "42703") {
      return res.status(200).json(recruiterCodeAvailabilityPayload({
        code,
        available: false,
        reason: "schema_unavailable",
      }));
    }
    return res.status(500).json({ error: "Server error" });
  }
}

// Upload route MUST be mounted BEFORE express.json, express.urlencoded, and
// the railwayProxyMiddleware. This guarantees that formidable receives the
// raw multipart/form-data request stream. Any body parser or proxy that
// touches the stream first commonly causes ERR_CONNECTION_RESET or
// "request aborted" on /api/upload (especially for logo uploads during
// draft creation, and when the railway proxy is enabled in local dev).
app.use("/api/upload", wrap(upload));

app.get("/", (_req, res) => res.json({ ok: true, service: "MemeWarzone API", healthz: "/healthz", api: "/api" }));
// Railway healthcheck: no DB, no RPC — must answer immediately after listen().
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true, service: "frontend-api" }));
app.get("/health", async (_req, res) => {
  // Prefer 200 for liveness; report DB separately so a slow pooler cannot fail deploys
  // if Railway is pointed at /health instead of /healthz.
  try {
    const r = await pool.query("select 1 as ok");
    res.status(200).json({ ok: true, service: "frontend-api", db: r.rows?.[0]?.ok ?? 1 });
  } catch (err) {
    console.error("[api/server] health db check failed", err);
    res.status(200).json({
      ok: true,
      service: "frontend-api",
      db: 0,
      warning: "DB health check failed",
      error: String(err?.message || err),
    });
  }
});

app.use(express.json({ limit: process.env.API_JSON_LIMIT || "10mb" }));
app.use(express.urlencoded({ extended: false, limit: process.env.API_FORM_LIMIT || "10mb" }));

// Handle payload too large errors from body-parser early (e.g. if a draft payload or other JSON
// exceeds the limit). This turns the raw PayloadTooLargeError into a clean 413 response instead
// of an unhandled error that becomes a generic 500.
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    console.error(`[api/server] Payload too large for ${req.path}: ${err.length} bytes > ${err.limit} limit`);
    if (!res.headersSent) {
      return res.status(413).json({
        error: "Payload too large",
        limit: err.limit,
        length: err.length
      });
    }
  }
  next(err);
});

app.use(createRailwayProxyMiddleware({ serviceName: "local-api-gateway" }));

const router = express.Router();

router.all("/activity/trades", wrap(activityTrades));
router.all("/ably/token", wrap(ablyToken));
router.get("/price/bnb-usd", wrap(bnbUsdPrice));
router.all("/auth/nonce", wrap(authNonce));
router.all("/campaigns/upsert", wrap(campaignsUpsert));
router.all("/campaigns", wrap(campaigns));
router.all("/dashboard/lp-fees", wrap(dashboardLpFees));
router.all("/analytics/ingest", wrap(analyticsIngest));
router.all(/^\/admin\/analytics(?:\/.*)?$/, wrap(analyticsAdmin));
router.all("/comments", wrap(comments));
router.all("/crypticpump-listings", wrap(crypticpumpListings));
router.all("/chat/history", wrap(chatHistory));
router.all("/chat/join", wrap(chatJoin));
router.all("/chat/realtime-token", wrap(chatRealtimeToken));
router.all("/chat/send", wrap(chatSend));
router.all("/diagnostics", wrap(diagnostics));
router.all("/epochPools", wrap(epochPools));
router.all("/featured", wrap(featured));
router.all("/follows/campaign-list", wrap(followsCampaignList));
router.all("/follows/campaign", wrap(followsCampaign));
router.all("/follows/user-counts", wrap(followsUserCounts));
router.all("/follows/user-list", wrap(followsUserList));
router.all("/follows/user", wrap(followsUser));
router.all("/league/summary", wrap(leagueSummary));
router.all("/league", wrap(league));
router.all("/leaguePayouts", wrap(leaguePayouts));
router.all("/leagueRoot", wrap(leagueRoot));
router.all("/profile", wrap(profile));
router.all("/profileCabinet", wrap(profileCabinet));
router.all("/profile/portfolio", wrap(profilePortfolio));
router.all("/shareCard", wrap(shareCard));
router.all("/discord-notification-image", wrap(discordNotificationImage));
router.all("/status", wrap(status));
router.all("/newsletter", wrap(newsletter));
router.all("/token-metadata/:chainId/:address", wrap(tokenMetadata));
router.all("/topaz-trades", wrap(topazTrades));
router.all("/token/:campaign/topaz-trades", wrap(topazTrades));
router.all("/token-metadata", wrap(tokenMetadata));
// Alias outside /votes/* so Railway proxy prefixes cannot steal this path.
router.all("/vote-ingest", wrap(votesIngest));
router.all("/votes/ingest", wrap(votesIngest));
router.all("/votes", wrap(votes));
router.all("/vote_counts", wrap(voteCounts));
router.all(/^\/(?:arena\/ops\/health|arena\/battles(?:\/.*)?|arena\/events(?:\/.*)?|arena\/league(?:\/.*)?|arena\/war-pools(?:\/.*)?|sponsored|sponsorship-applications|sponsorship-packages|sponsorship-settings|war-room(?:\/.*)?)$/, wrap(postgrad));
router.all("/drafts", wrap(drafts));
router.all("/drafts/followed", wrap(followedDrafts));
router.all("/drafts/ticker-availability", wrap(tickerAvailability));
router.all("/drafts/:draftId/promotion", wrap(draftPromotion));
router.all("/drafts/:draftId/ticker-reservation", wrap(tickerReservationManagement));
router.all("/drafts/:draftId/archive", wrap(draftArchive));
router.all("/drafts/:draftId/deploy", wrap(draftDeploy));
router.all("/solana/direct-create", wrap(solanaDirectCreateV4));
router.all("/solana/trade-authorize", wrap(solanaTradeAuthorizationV1));
router.all("/solana/graduation-authorize", wrap(solanaGraduationAuthorizationV1));
router.all("/solana/graduation-handoff", wrap(solanaGraduationHandoff));
router.all("/solana/trade-status", wrap(solanaTradeStatus));
router.all("/solana/vote-ingest", wrap(solanaVoteIngest));
router.all("/drafts/:draftId/follow", wrap(signedDraftFollow));
router.all("/drafts/:draftId/notifications", wrap(signedDraftNotificationSubscription));
router.all("/drafts/:draftId/comments/:commentId/reactions", wrap(signedDraftCommentReaction));
router.all("/drafts/:draftId/comments", wrap(signedDraftComments));
router.all("/drafts/:draftId", wrap(signedDraftById));
router.all("/prepare/:slug", wrap(signedPrepareBySlug));
router.get("/prepare-og/:slug", wrap(prepareOg));
router.get("/prepare-share-card", wrap(prepareShareCard));
router.all("/prepare-notifications", wrap(prepareNotifications));
router.all("/rewards/me", wrap(rewardsMe));
router.all("/rewards/me/history", wrap(rewardsHistory));
router.all("/rewards/me/claims", wrap(rewardsClaims));
router.all("/rewards/me/claim-intent", wrap(rewardClaimIntent));
router.all("/rewards/me/claim-record", wrap(rewardClaimRecord));
router.all("/rewards/me/eligibility", wrap(rewardsEligibility));
router.all("/rewards/claim-config", wrap(rewardClaimConfig));
router.all("/rewards", wrap(rewards));
router.all("/airdrops/current", wrap(airdropCurrent));
router.all("/airdrops/preview", wrap(airdropPreview));
router.all("/airdrops/previous-winners", wrap(airdropPreviousWinners));
router.all("/airdrops/winners", wrap(airdropWinners));
router.all("/admin/rewards/overview", wrap(withAdminOrOps(adminRewardOverview, "admin/rewards/overview")));
router.all("/admin/rewards/batches", wrap(withAdminOrOps(adminRewardBatches, "admin/rewards/batches")));
router.all("/admin/rewards/batches/:id", wrap(withAdminOrOps(adminRewardBatchById, "admin/rewards/batches/:id")));
router.all("/admin/rewards/ledger", wrap(withAdminOrOps(adminRewardLedger, "admin/rewards/ledger")));
router.all("/admin/rewards/alerts", wrap(withAdminOrOps(adminRewardAlerts, "admin/rewards/alerts")));
router.all("/admin/rewards/audit-log", wrap(withAdminOrOps(adminRewardAuditLog, "admin/rewards/audit-log")));
router.all("/admin/abuse/me", wrap(adminAbuseMe));
router.all("/admin/abuse/staff", wrap(adminAbuseStaff));
router.all("/admin/abuse/reports/:reportId/reply", wrap(adminAbuseReports));
router.all("/admin/abuse/reports/:reportId/internal-note", wrap(adminAbuseReports));
router.all("/admin/abuse/reports/:reportId/status", wrap(adminAbuseReports));
router.all("/admin/abuse/reports/:reportId/priority", wrap(adminAbuseReports));
router.all("/admin/abuse/reports/:reportId/assignment", wrap(adminAbuseReports));
router.all("/admin/abuse/reports/:reportId/evidence/:evidenceId", wrap(adminAbuseReports));
router.all("/admin/abuse/reports/:reportId", wrap(adminAbuseReports));
router.all("/admin/abuse/reports", wrap(adminAbuseReports));
router.all("/admin/abuse/permissions/revoke", wrap(adminAbusePermissions));
router.all("/admin/abuse/permissions", wrap(adminAbusePermissions));
router.all("/abuse/session", wrap(abuseSession));
router.all("/abuse/reports/:reportId/messages", wrap(abuseReports));
router.all("/abuse/reports/:reportId/evidence/:evidenceId", wrap(abuseReports));
router.all("/abuse/reports/:reportId/evidence", wrap(abuseReports));
router.all("/abuse/reports/:reportId", wrap(abuseReports));
router.all("/abuse/reports", wrap(abuseReports));
router.all("/squads", wrap(squadsLeaderboard));
router.all("/squads/members", wrap(squadMembers));
router.all("/squads/:code/summary", wrap(squadSummary));
router.all("/recruiters", wrap(recruiters));
router.all("/recruiters/signup/code-availability", wrap(recruiterSignupCodeAvailabilityAlias));
router.all("/recruiters/wallet/:wallet/summary", wrap(recruiterWalletSummary));
router.all("/recruiters/:code/summary", wrap(recruiterSummary));
router.all("/recruiters/:code/replacements", wrap(recruiterReplacements));
router.all("/recruiters/:code/referral/capture", wrap(recruiterReferralCapture));
router.all("/recruiters/me/payouts", wrap(recruiterMePayouts));
router.all("/recruiters/me/wallets/link", wrap(recruiterMeWalletLink));
router.all("/recruiters/me/claims", wrap(recruiterMeClaims));
router.all("/attribution/wallet-connect", wrap(attributionWalletConnect));
router.all("/attribution/wallet/:wallet", wrap(attributionWallet));
router.all("/routing/status", wrap(routingStatus));
router.all("/routing/create-authorization", wrap(routingCreateAuthorization));
router.all("/routing/trade-authorization", wrap(routingTradeAuthorization));
router.all("/recruiter-routing/status", wrap(routingStatus));
router.all("/recruiter-routing/create-authorization", wrap(routingCreateAuthorization));
router.all("/recruiter-routing/trade-authorization", wrap(routingTradeAuthorization));
router.all("/launchpad/preflight-create", wrap(launchpadPreflightCreate));
router.all("/launchpad/preflight-buy", wrap(launchpadPreflightBuy));
router.all("/launchpad/preflight-sell", wrap(launchpadPreflightSell));
router.all("/security/status", wrap(securityStatus));
router.all("/security/creators", wrap(withAdminOrOps(securityCreators, "security/creators")));
router.all("/security/clusters", wrap(withAdminOrOps(securityClusters, "security/clusters")));
router.all("/security/manual-review", wrap(withAdminOrOps(securityManualReview, "security/manual-review")));
router.all("/security/mass-deployers", wrap(withAdminOrOps(securityMassDeployers, "security/mass-deployers")));
router.all("/security/audit-log", wrap(withAdminOrOps(securityAuditLog, "security/audit-log")));
router.all("/security/recruiter-payouts", wrap(withAdminOrOps(securityRecruiterPayouts, "security/recruiter-payouts")));
router.all("/security/creator/:wallet/profile", wrap(securityCreatorProfile));
router.all("/security/creator/:wallet/launch-eligibility", wrap(securityCreatorLaunchEligibility));
router.all("/security/creator/:wallet/tier", wrap(withAdminOrOps(securityCreatorTier, "security/creator/tier")));
router.all("/security/creator/:wallet/restrict", wrap(withAdminOrOps(securityCreatorRestrict, "security/creator/restrict")));
router.all("/security/creator/:wallet/manual-review", wrap(withAdminOrOps(securityCreatorManualReview, "security/creator/manual-review")));
router.all("/security/cluster/:clusterId/restrict", wrap(withAdminOrOps(securityClusterRestrict, "security/cluster/restrict")));
router.all("/security/wallet/:wallet/restrict", wrap(withAdminOrOps(securityWalletRestrict, "security/wallet/restrict")));
router.all("/security/contracts/:action", wrap(withAdminOrOps(securityContractAction, "security/contracts")));
router.all("/security/solana/:action", wrap(withAdminOrOps(securityContractAction, "security/contracts")));
router.all("/recruiter-auth-nonce", wrap(recruiterAuthNonce));
router.all("/recruiter-auth-verify", wrap(recruiterAuthVerify));
router.all("/recruiter-portal", wrap(recruiterPortal));
router.all("/recruiter-logout", wrap(recruiterLogout));
router.all("/recruiter-signup/status", wrap(recruiterSignupStatus));
router.all("/recruiter-signup/code-availability", wrap(recruiterSignupCodeAvailability));
router.all("/recruiter-signup/nonce", wrap(recruiterSignupNonce));
router.all("/recruiter-signup", wrap(recruiterSignupSubmit));
router.all("/internal/airdrops/calculate", wrap(withInternalAuth(internalAirdropsCalculate, "internal/airdrops/calculate")));
router.all("/internal/airdrops/publish", wrap(withInternalAuth(internalAirdropsPublish, "internal/airdrops/publish")));
router.all("/internal/rewards/batches", wrap(withInternalAuth(internalRewardBatches, "internal/rewards/batches")));
router.all("/internal/rewards/batches/:id/publish", wrap(withInternalAuth(internalRewardBatchPublish, "internal/rewards/batches/:id/publish")));
router.all("/internal/rewards/batches/:id/pause", wrap(withInternalAuth(internalRewardBatchPause, "internal/rewards/batches/:id/pause")));
router.all("/internal/rewards/batches/:id/close", wrap(withInternalAuth(internalRewardBatchClose, "internal/rewards/batches/:id/close")));
router.all("/internal/rewards/ops", wrap(withInternalAuth(internalRewardOps, "internal/rewards/ops")));
router.all("/internal/rewards/publications", wrap(withInternalAuth(internalRewardPublications, "internal/rewards/publications")));
router.all("/internal/rewards/ops/routing", wrap(withInternalAuth(internalRewardRouting, "internal/rewards/ops/routing")));
router.all("/internal/rewards/ops/claim-vault", wrap(withInternalAuth(internalRewardClaimVault, "internal/rewards/ops/claim-vault")));
router.all("/internal/rewards/ops/epoch-status", wrap(withInternalAuth(internalRewardEpochStatus, "internal/rewards/ops/epoch-status")));
router.all("/internal/rewards/ops/alerts", wrap(withInternalAuth(internalRewardAlerts, "internal/rewards/ops/alerts")));
router.all("/internal/rewards/ops/admin-actions", wrap(withInternalAuth(internalRewardAdminActions, "internal/rewards/ops/admin-actions")));
router.all("/internal/rewards/airdrops/draws", wrap(withInternalAuth(internalAirdropDraws, "internal/rewards/airdrops/draws")));
router.all("/internal/rewards/airdrops/epochs/:epochId/draws/run", wrap(withInternalAuth(internalAirdropDrawRun, "internal/rewards/airdrops/epochs/:epochId/draws/run")));

app.use("/api", router);
app.use((req, res) => res.status(404).json({ error: `Unknown route: ${req.path}` }));
app.use((err, _req, res, _next) => {
  console.error("[api/server] unhandled", err);
  if (res.headersSent) return;
  // Surface a short message so Solana draft/create failures are debuggable in the browser Network tab.
  const message = String(err?.message || err || "Server error").slice(0, 300);
  res.status(500).json({
    error: "Server error",
    message,
    code: err?.code || undefined,
  });
});

const port = Number(process.env.PORT || process.env.API_PORT || 3001);
app.listen(port, "0.0.0.0", () => {
  console.log(`[api/server] listening on ${port}`);
  try {
    const snap = getAuthEnforceSnapshot();
    console.log("[api/auth] enforce snapshot", JSON.stringify(snap));
  } catch (error) {
    console.warn("[api/auth] enforce snapshot failed", error?.message || error);
  }
});
