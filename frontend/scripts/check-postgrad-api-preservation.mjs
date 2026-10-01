import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, "../api/server.mjs");
const server = fs.readFileSync(serverPath, "utf8");

const requiredRoutes = [
  ["/api/upload", "upload", "app.use"],
  ["/drafts", "drafts"],
  ["/drafts/followed", "followedDrafts"],
  ["/drafts/ticker-availability", "tickerAvailability"],
  ["/drafts/:draftId/deploy", "draftDeploy"],
  ["/drafts/:draftId/follow", "signedDraftFollow"],
  ["/drafts/:draftId/notifications", "signedDraftNotificationSubscription"],
  ["/drafts/:draftId/comments", "signedDraftComments"],
  ["/drafts/:draftId", "signedDraftById"],
  ["/prepare/:slug", "signedPrepareBySlug"],
  ["/prepare-notifications", "prepareNotifications"],
  ["/campaigns", "campaigns"],
  ["/activity/timeline", "activityTimeline"],
  ["/feed/posts", "feedPosts"],
  ["/comments", "comments"],
  ["/follows/campaign", "followsCampaign"],
  ["/follows/user", "followsUser"],
  ["/profile", "profile"],
  ["/profile/portfolio", "profilePortfolio"],
  ["/token-metadata", "tokenMetadata"],
  ["/votes", "votes"],
  ["/vote_counts", "voteCounts"],
  ["/routing/status", "routingStatus"],
  ["/routing/create-authorization", "routingCreateAuthorization"],
  ["/routing/trade-authorization", "routingTradeAuthorization"],
  ["/recruiters", "recruiters"],
  ["/recruiter-signup", "recruiterSignupSubmit"],
  ["/wm-x-oauth-start", "wmXOAuthStart"],
  ["/wm-x-oauth-callback", "wmXOAuthCallback"],
  ["/social-x-callback", "wmXOAuthCallback"],
  ["/wm-quiz-get", "wmQuizLoad"],
  ["/wm-quiz-load", "wmQuizLoad"],
  ["/wm-quiz-submit", "wmQuizSubmit"],
  ["/wm-referral-track", "wmReferralTrack"],
  ["/wm-referral-stats", "wmReferralStats"],
  ["/wm-admin-badge-award", "wmAdminBadgeAward"],
  ["/wm-admin-notifications-list", "wmAdminNotificationsList"],
  ["/wm-admin-recruiter-review", "wmAdminRecruiterReview"],
  ["/wm-admin-user-action", "wmAdminUserAction"],
  ["/wm-admin-quest-upsert", "wmAdminQuestUpsert"],
  ["/wm-admin-leaderboard-snapshot", "wmAdminLeaderboardSnapshot"],
  ["/wm-admin-prizes", "wmAdminPrizes"],
  ["/wm-daily-rollover", "wmDailyRollover"],
  ["/internal/rewards/publications", "internalRewardPublications"],
  ["/internal/rewards/airdrops/draws", "internalAirdropDraws"],
];

const failures = [];

if (server.includes("devpostgrad API gateway") || server.includes("devpostgrad does not host the live API")) {
  failures.push("devpostgrad must run the concrete API server, not the old gateway/proxy-only server");
}

if (!server.includes('app.get("/healthz"') || !server.includes('app.get("/health"')) {
  failures.push("health endpoints /healthz and /health must remain mounted");
}

if (!server.includes('express.json({ limit: process.env.API_JSON_LIMIT || "10mb" })')) {
  failures.push("API JSON payload limit must preserve the live 10mb default");
}

for (const [route, handler, mount = "router.all"] of requiredRoutes) {
  const expected = `${mount}("${route}", wrap(${handler}))`;
  if (!server.includes(expected)) failures.push(`${route} must remain wired to ${handler}`);
}

if (!server.includes("arena\\/ops\\/health") || !server.includes("wrap(postgrad)")) {
  failures.push("postgrad Arena/League/War Room/Sponsorship routes must be routed through postgrad handler");
}

if (server.includes("warMissionsProxy")) {
  failures.push("War Missions routes must not be replaced by warMissionsProxy");
}

if (failures.length) {
  console.error("Postgrad API preservation check failed.");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Postgrad API preservation check passed for ${requiredRoutes.length} concrete API routes.`);
