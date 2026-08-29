import express from "express";
import serverless from "serverless-http";

import { createRailwayProxyMiddleware } from "../../server/railwayProxy.js";

import activityTrades from "../../api/activity/trades.js";
import ablyToken from "../../api/ably/token.js";
import authNonce from "../../api/auth/nonce.js";
import arenaBattles from "../../api/arenaBattles.js";
import arenaEvents from "../../api/arenaEvents.js";
import arenaImports from "../../api/arenaImports.js";
import arenaTournaments from "../../api/arenaTournaments.js";
import arenaLeague from "../../api/arenaLeague.js";
import arenaNotifications from "../../api/arenaNotifications.js";
import arenaVotes from "../../api/arenaVotes.js";
import arenaOps from "../../api/arenaOps.js";
import arenaWarPools from "../../api/arenaWarPools.js";
import adminArenaImports from "../../api/admin/arenaImports.js";
import campaignsUpsert from "../../api/campaigns/upsert.js";
import campaigns from "../../api/campaigns.js";
import comments from "../../api/comments.js";
import chatHistory from "../../api/chat/history.js";
import chatJoin from "../../api/chat/join.js";
import chatRealtimeToken from "../../api/chat/realtime-token.js";
import chatSend from "../../api/chat/send.js";
import diagnostics from "../../api/diagnostics.js";
import epochPools from "../../api/epochPools.js";
import featured from "../../api/featured.js";
import followsCampaignList from "../../api/follows/campaign-list.js";
import followsCampaign from "../../api/follows/campaign.js";
import followsUserCounts from "../../api/follows/user-counts.js";
import followsUserList from "../../api/follows/user-list.js";
import followsUser from "../../api/follows/user.js";
import league from "../../api/leagueRouter.js";
import leagueSummary from "../../api/leagueSummary.js";
import leaguePayouts from "../../api/leaguePayouts.js";
import leagueRoot from "../../api/leagueRoot.js";
import profile from "../../api/profile.js";
import profileCabinet from "../../api/profileCabinet.js";
import rewards from "../../api/rewards.js";
import shareCard from "../../api/shareCard.js";
import prepareShareCard from "../../api/prepare-share-card.js";
import sponsored from "../../api/sponsored.js";
import sponsorshipApplications from "../../api/sponsorship-applications.js";
import status from "../../api/status.js";
import tokenMetadata from "../../api/token-metadata.js";
import topazTrades from "../../api/topaz-trades.js";
import upload from "../../api/upload.js";
import votes from "../../api/votes.js";
import voteCounts from "../../api/vote_counts.js";
import warRoom from "../../api/warRoom.js";
import { draftDeploy } from "../../api/dev-fix/draft-deploy.js";
import {
  followedDrafts,
  signedDraftComments,
  signedDraftFollow,
  signedDraftNotificationSubscription,
} from "../../api/dev-fix/draft-engagement.js";
import { prepareNotifications } from "../../api/dev-fix/prepare-notifications.js";
import { signedDraftById, signedPrepareBySlug } from "../../api/dev-fix/draft-read.js";
import { tickerAvailability } from "../../api/dev-fix/ticker-availability.js";
import { draftArchive, draftPromotion, drafts } from "../../api/dev-fix/drafts.js";
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
} from "../../api/dev-fix/attribution.js";
import {
  recruiterAuthNonce,
  recruiterAuthVerify,
  recruiterLogout,
  recruiterPortal,
} from "../../api/dev-fix/recruiter-portal.js";
import {
  recruiterMeClaims,
  recruiterMePayouts,
  recruiterMeWalletLink,
} from "../../api/dev-fix/recruiter-payouts.js";
import { rewardClaimConfig, rewardClaimIntent, rewardClaimRecord } from "../../api/dev-fix/reward-claim-intent.js";
import { routingCreateAuthorization, routingStatus, routingTradeAuthorization } from "../../api/dev-fix/route-auth.js";
import {
  airdropWinners,
  internalAirdropDrawRun,
  internalAirdropDraws,
  internalRewardAdminActions,
  internalRewardAlerts,
  internalRewardClaimVault,
  internalRewardEpochStatus,
  internalRewardPublications,
  internalRewardRouting,
  recruiterReplacements,
  rewardsClaims,
  rewardsEligibility,
  rewardsHistory,
  rewardsMe,
} from "../../api/dev-fix/stubs.js";
import {
  squadMembers,
  squadSummary,
  squadsLeaderboard,
} from "../../api/dev-fix/squads.js";

const app = express();
app.disable("x-powered-by");

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
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

const CORS_RELAXED = /^(1|true|yes|on)$/i.test(String(process.env.CORS_RELAXED || "").trim());

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
    // Coolify temporary public hostnames (sslip/nip)
    if (host.endsWith(".sslip.io") || host.endsWith(".nip.io")) return true;
  } catch {}
  return false;
}

app.use((req, res, next) => {
  const origin = String(req.headers.origin || "");
  if (isAllowedOrigin(origin)) {
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, x-diagnostics-token, x-rank-events-token");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.use((req, _res, next) => {
  const raw = String(req.url || "");
  req.url = raw
    .replace(/^\/\.netlify\/functions\/api(?=\/|$)/, "")
    .replace(/^\/api(?=\/|$)/, "") || "/";
  next();
});

app.use(express.json({ limit: process.env.API_JSON_LIMIT || "2mb" }));
app.use(express.urlencoded({ extended: false, limit: process.env.API_FORM_LIMIT || "2mb" }));
app.use(createRailwayProxyMiddleware({ prefixApiWhenMissing: true, serviceName: "netlify-api" }));

function wrap(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };
}

app.all("/activity/trades", wrap(activityTrades));
app.all("/ably/token", wrap(ablyToken));
app.all("/auth/nonce", wrap(authNonce));
app.all("/arena/ops/health", wrap(arenaOps));
app.all("/arena/battles/open", wrap(arenaBattles));
app.all("/arena/battles/challenge", wrap(arenaBattles));
app.all("/arena/battles/creator-status", wrap(arenaBattles));
app.all("/arena/battles/:battleId/accept", wrap(arenaBattles));
app.all("/arena/battles/:battleId/decline", wrap(arenaBattles));
app.all("/arena/battles/:battleId/counter", wrap(arenaBattles));
app.all("/arena/battles/:battleId/transition", wrap(arenaBattles));
app.all("/arena/battles/:battleId", wrap(arenaBattles));
app.all("/arena/battles", wrap(arenaBattles));
app.all("/arena/imports/lookup", wrap(arenaImports));
app.all("/arena/imports/:id/request-review", wrap(arenaImports));
app.all("/arena/imports", wrap(arenaImports));
app.all("/admin/arena/imports/:id/decide", wrap(adminArenaImports));
app.all("/admin/arena/imports", wrap(adminArenaImports));
app.all("/arena/tournaments/:id/opt-in", wrap(arenaTournaments));
app.all("/arena/tournaments/:id", wrap(arenaTournaments));
app.all("/arena/tournaments", wrap(arenaTournaments));
app.all("/admin/arena/tournaments/:id/start", wrap(arenaTournaments));
app.all("/admin/arena/tournaments", wrap(arenaTournaments));
app.all("/arena/notifications/email/verify", wrap(arenaNotifications));
app.all("/arena/notifications/email/status", wrap(arenaNotifications));
app.all("/arena/notifications/email", wrap(arenaNotifications));
app.all("/arena/votes/featured", wrap(arenaVotes));
app.all("/arena/votes/solana-ingest", wrap(arenaVotes));
app.all("/arena/votes/ingest", wrap(arenaVotes));
app.all("/arena/league/checkin", wrap(arenaLeague));
app.all("/arena/league/dispatch", wrap(arenaLeague));
app.all("/arena/league/quarter-finals", wrap(arenaLeague));
app.all("/arena/events/:eventId/advance-bracket", wrap(arenaEvents));
app.all("/arena/events/:eventId/transition", wrap(arenaEvents));
app.all("/arena/events/:eventId", wrap(arenaEvents));
app.all("/arena/events", wrap(arenaEvents));
app.all("/arena/league/advance-week", wrap(arenaLeague));
app.all("/arena/league/rebalance-divisions", wrap(arenaLeague));
app.all("/arena/league/cycle-season-state", wrap(arenaLeague));
app.all("/arena/league", wrap(arenaLeague));
app.all("/arena/war-pools/claimable", wrap(arenaWarPools));
app.all("/arena/war-pools/:battleId/stake-receipt", wrap(arenaWarPools));
app.all("/arena/war-pools/:battleId/stake", wrap(arenaWarPools));
app.all("/arena/war-pools/:battleId/claim-intent", wrap(arenaWarPools));
app.all("/arena/war-pools/:battleId/support-receipt", wrap(arenaWarPools));
app.all("/arena/war-pools/:battleId/support", wrap(arenaWarPools));
app.all("/arena/war-pools/:battleId/transition", wrap(arenaWarPools));
app.all("/arena/war-pools/:battleId", wrap(arenaWarPools));
app.all("/arena/war-pools", wrap(arenaWarPools));
app.all("/campaigns/upsert", wrap(campaignsUpsert));
app.all("/campaigns", wrap(campaigns));
app.all("/comments", wrap(comments));
app.all("/chat/history", wrap(chatHistory));
app.all("/chat/join", wrap(chatJoin));
app.all("/chat/realtime-token", wrap(chatRealtimeToken));
app.all("/chat/send", wrap(chatSend));
app.all("/diagnostics", wrap(diagnostics));
app.all("/epochPools", wrap(epochPools));
app.all("/featured", wrap(featured));
app.all("/follows/campaign-list", wrap(followsCampaignList));
app.all("/follows/campaign", wrap(followsCampaign));
app.all("/follows/user-counts", wrap(followsUserCounts));
app.all("/follows/user-list", wrap(followsUserList));
app.all("/follows/user", wrap(followsUser));
app.all("/league/summary", wrap(leagueSummary));
app.all("/league", wrap(league));
app.all("/leaguePayouts", wrap(leaguePayouts));
app.all("/leagueRoot", wrap(leagueRoot));
app.all("/profile", wrap(profile));
app.all("/profileCabinet", wrap(profileCabinet));
app.all("/shareCard", wrap(shareCard));
app.all("/prepare-share-card", wrap(prepareShareCard));
app.all("/sponsored", wrap(sponsored));
app.all("/sponsorship-applications", wrap(sponsorshipApplications));
app.all("/status", wrap(status));
app.all("/token-metadata/:chainId/:address", wrap(tokenMetadata));
app.all("/token-metadata", wrap(tokenMetadata));
app.all("/topaz-trades", wrap(topazTrades));
app.all("/token/:campaign/topaz-trades", wrap(topazTrades));
app.all("/upload", wrap(upload));
app.all("/votes", wrap(votes));
app.all("/vote_counts", wrap(voteCounts));
app.all("/war-room", wrap(warRoom));
app.all("/drafts", wrap(drafts));
app.all("/drafts/followed", wrap(followedDrafts));
app.all("/drafts/ticker-availability", wrap(tickerAvailability));
app.all("/drafts/:draftId/promotion", wrap(draftPromotion));
app.all("/drafts/:draftId/archive", wrap(draftArchive));
app.all("/drafts/:draftId/deploy", wrap(draftDeploy));
app.all("/drafts/:draftId/follow", wrap(signedDraftFollow));
app.all("/drafts/:draftId/notifications", wrap(signedDraftNotificationSubscription));
app.all("/drafts/:draftId/comments", wrap(signedDraftComments));
app.all("/drafts/:draftId", wrap(signedDraftById));
app.all("/prepare/:slug", wrap(signedPrepareBySlug));
app.all("/prepare-notifications", wrap(prepareNotifications));
app.all("/rewards/me", wrap(rewardsMe));
app.all("/rewards/me/history", wrap(rewardsHistory));
app.all("/rewards/me/claims", wrap(rewardsClaims));
app.all("/rewards/me/claim-intent", wrap(rewardClaimIntent));
app.all("/rewards/me/claim-record", wrap(rewardClaimRecord));
app.all("/rewards/me/eligibility", wrap(rewardsEligibility));
app.all("/rewards/claim-config", wrap(rewardClaimConfig));
app.all("/rewards", wrap(rewards));
app.all("/airdrops/winners", wrap(airdropWinners));
app.all("/squads", wrap(squadsLeaderboard));
app.all("/squads/members", wrap(squadMembers));
app.all("/squads/:code/summary", wrap(squadSummary));
app.all("/recruiters/signup/status", wrap(recruiterSignupStatus));
app.all("/recruiters/signup/code-availability", wrap(recruiterSignupCodeAvailability));
app.all("/recruiters/signup/nonce", wrap(recruiterSignupNonce));
app.all("/recruiters/signup", wrap(recruiterSignupSubmit));
app.all("/recruiters", wrap(recruiters));
app.all("/recruiters/wallet/:wallet/summary", wrap(recruiterWalletSummary));
app.all("/recruiters/:code/summary", wrap(recruiterSummary));
app.all("/recruiters/:code/replacements", wrap(recruiterReplacements));
app.all("/recruiters/:code/referral/capture", wrap(recruiterReferralCapture));
app.all("/recruiters/me/payouts", wrap(recruiterMePayouts));
app.all("/recruiters/me/wallets/link", wrap(recruiterMeWalletLink));
app.all("/recruiters/me/claims", wrap(recruiterMeClaims));
app.all("/attribution/wallet-connect", wrap(attributionWalletConnect));
app.all("/attribution/wallet/:wallet", wrap(attributionWallet));
app.all("/routing/status", wrap(routingStatus));
app.all("/routing/create-authorization", wrap(routingCreateAuthorization));
app.all("/routing/trade-authorization", wrap(routingTradeAuthorization));
app.all("/recruiter-routing/status", wrap(routingStatus));
app.all("/recruiter-routing/create-authorization", wrap(routingCreateAuthorization));
app.all("/recruiter-routing/trade-authorization", wrap(routingTradeAuthorization));
app.all("/recruiter-auth-nonce", wrap(recruiterAuthNonce));
app.all("/recruiter-auth-verify", wrap(recruiterAuthVerify));
app.all("/recruiter-portal", wrap(recruiterPortal));
app.all("/recruiter-logout", wrap(recruiterLogout));
app.all("/recruiter-signup/status", wrap(recruiterSignupStatus));
app.all("/recruiter-signup/code-availability", wrap(recruiterSignupCodeAvailability));
app.all("/recruiter-signup/nonce", wrap(recruiterSignupNonce));
app.all("/recruiter-signup", wrap(recruiterSignupSubmit));
app.all("/internal/rewards/publications", wrap(internalRewardPublications));
app.all("/internal/rewards/ops/routing", wrap(internalRewardRouting));
app.all("/internal/rewards/ops/claim-vault", wrap(internalRewardClaimVault));
app.all("/internal/rewards/ops/epoch-status", wrap(internalRewardEpochStatus));
app.all("/internal/rewards/ops/alerts", wrap(internalRewardAlerts));
app.all("/internal/rewards/ops/admin-actions", wrap(internalRewardAdminActions));
app.all("/internal/rewards/airdrops/draws", wrap(internalAirdropDraws));
app.all("/internal/rewards/airdrops/epochs/:epochId/draws/run", wrap(internalAirdropDrawRun));

app.use((req, res) => {
  res.status(404).json({ error: `Unknown API route: ${req.path}` });
});

app.use((err, _req, res, _next) => {
  console.error("[netlify/functions/api] unhandled", err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Server error" });
});

export const handler = serverless(app);
