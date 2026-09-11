import { execFileSync } from "node:child_process";

const legacy = String(100 + 2);
const pattern = `(^|[^0-9])${legacy}([^0-9]|$)`;

const CATEGORY = Object.freeze({
  CURRENT: "CURRENT AUTHORITY — FIXED",
  CLAIMS: "PR #290 CLAIMS — LEFT UNTOUCHED",
  HISTORY: "HISTORICAL COMPATIBILITY — RETAIN",
  DISPLAY: "DISPLAY / ADDRESS NORMALIZATION — RETAIN",
  FIXTURE: "MIGRATION / FIXTURE / TEST HISTORY — RETAIN",
  UNRELATED: "UNRELATED NUMERIC 102",
  OBSOLETE: "OBSOLETE — REMOVED",
});

const claimsOwned = new Set([
  ".github/workflows/agent5-claims-closeout.yml",
  "frontend/api/dev-fix/reward-claim-closeout-router.js",
  "frontend/api/dev-fix/reward-claim-intent.js",
  "frontend/api/leaguePayouts.js",
  "frontend/api/leagueRouter.js",
  "frontend/api/lib/agent5ClaimsCloseout.integration.test.mjs",
  "frontend/api/lib/agent5ClaimsCloseout.source.test.mjs",
  "frontend/api/lib/evmLeagueClaimVerification.js",
  "frontend/api/lib/evmRewardReconciliation.js",
  "frontend/api/lib/solanaClaimEnvironment.js",
  "frontend/api/lib/solanaLeagueClaimVerification.js",
  "frontend/api/rewards.js",
  "frontend/src/lib/rewardProgramsApi.ts",
]);

const currentAuthority = new Set([
  "frontend/api/admin/finance.js",
  "frontend/api/analytics/launchpad.js",
  "frontend/api/arenaBoosts.js",
  "frontend/api/arenaSolanaBoosts.js",
  "frontend/api/arenaTournamentBoosts.js",
  "frontend/api/dashboard/lp-fees.js",
  "frontend/api/dev-fix/draft-deploy.js",
  "frontend/api/dev-fix/drafts.js",
  "frontend/api/dev-fix/routeAuthorizationSigner.js",
  "frontend/api/dev-fix/solana-graduation-authorization-v2.js",
  "frontend/api/dev-fix/ticker-reservation-service.js",
  "frontend/api/dev-fix/ticker-reservation-service.test.mjs",
  "frontend/api/lib/solanaArenaMoneyV2Read.js",
  "frontend/api/lib/solanaArenaMoneyV2Runtime.mjs",
  "frontend/api/lib/solanaRewardLane.js",
  "frontend/docs/finance-activation-checklist.md",
  "frontend/docs/finance-custody-config.md",
  "frontend/scripts/weekly-airdrop/run-weekly-airdrop.mjs",
  "frontend/shared/solanaCurrentArenaAuthority.test.mjs",
  "frontend/shared/solanaCurrentAuthority.mjs",
  "frontend/shared/solanaCurrentAuthority.test.mjs",
  "frontend/src/components/arena/BattleBoostPanel.tsx",
  "frontend/src/components/token/UpvoteDialog.tsx",
  "frontend/src/features/launchpad/useLaunchpadAdapter.ts",
  "frontend/src/features/postgrad/identityRoutes.ts",
  "frontend/src/lib/arena/eventSponsorshipClient.ts",
  "frontend/src/lib/arena/solanaWarzoneEscrow.ts",
  "frontend/src/lib/chainConfig.ts",
  "frontend/src/lib/graduationTiers.ts",
  "frontend/src/lib/lpFeeHarvest.ts",
  "realtime-indexer/src/jobs/finalizeEpochWinners.ts",
  "realtime-indexer/src/lpFeesRoutes.ts",
  "realtime-indexer/src/marketIdentity.ts",
  "scripts/solana/arena-operator-worker.mjs",
]);

const historicalCompatibility = new Set([
  "frontend/api/admin/arenaImports.js",
  "frontend/api/campaigns-base.js",
  "frontend/api/campaigns.js",
  "frontend/api/dev-fix/airdrop-preview.js",
  "frontend/api/dev-fix/attribution.js",
  "frontend/api/dev-fix/draft-deploy-base.js",
  "frontend/api/dev-fix/drafts-base.js",
  "frontend/api/dev-fix/reward-batch-ops.js",
  "frontend/api/dev-fix/reward-claim-intent-generic.js",
  "frontend/api/dev-fix/route-auth.js",
  "frontend/api/dev-fix/stubs.js",
  "frontend/api/league.js",
  "frontend/api/leagueSummary.js",
  "frontend/api/lib/arenaImportScan.js",
  "frontend/api/lib/chainNative.js",
  "frontend/api/lib/finalizeLeagueEpoch.js",
  "frontend/src/lib/draftApi.ts",
  "frontend/src/lib/solanaArenaLayout.mjs",
  "frontend/src/lib/solanaRewardNetwork.ts",
  "frontend/src/pages/PrepareBase.tsx",
  "realtime-indexer/src/rewards/airdrops.ts",
]);

const displayNormalization = new Set([
  "frontend/api/arenaEventSponsorshipAuthority.js",
  "frontend/api/chat/_lib.js",
  "frontend/api/prepare-share-card.js",
  "frontend/api/upload.js",
  "frontend/server/http.js",
  "frontend/src/components/home/CampaignGrid.tsx",
  "frontend/src/components/home/CampaignTickerBar.tsx",
  "frontend/src/components/home/FeaturedCampaigns.tsx",
  "frontend/src/components/token/CrypticPumpListing.tsx",
  "frontend/src/components/token/TokenSafetyPanel.tsx",
  "frontend/src/components/token/TokenSafetyStatusButton.tsx",
  "frontend/src/components/token/UnifiedMarketChart.tsx",
  "frontend/src/hooks/profile/useEditableProfile.ts",
  "frontend/src/hooks/profile/useProfileRewards.ts",
  "frontend/src/hooks/useTokenRealtime.ts",
  "frontend/src/lib/arena/battleBoostPresentation.mjs",
  "frontend/src/lib/arena/battlePresentation.ts",
  "frontend/src/lib/arena/battleSharePresentation.mjs",
  "frontend/src/lib/arena/battleWallMorePresentation.mjs",
  "frontend/src/lib/arena/battleWallPresentation.mjs",
  "frontend/src/lib/arena/eventSponsorshipPresentation.mjs",
  "frontend/src/lib/arena/tournamentCommandPresentation.mjs",
  "frontend/src/lib/leagueCabinetApi.ts",
  "frontend/src/lib/liveMarketMerge.ts",
  "frontend/src/lib/profile/profileFormatters.ts",
  "frontend/src/lib/profileApi.ts",
  "frontend/src/lib/tokenDetailsPath.ts",
  "frontend/src/pages/Profile.tsx",
  "frontend/src/pages/command-center/CommandCenterSocial.tsx",
  "realtime-indexer/src/jobs/generateLaunchDigest.ts",
  "realtime-indexer/src/jobs/generateLeagueStandings.ts",
  "realtime-indexer/src/jobs/generateTrendingDigest.ts",
  "realtime-indexer/src/leagueFeed.ts",
  "realtime-indexer/src/milestones.ts",
]);

const unrelated = new Set([
  "config/solana/meteora-cp-amm.certification.json",
  "frontend/package-lock.json",
  "frontend/src/components/home/HomeAudienceCtas.tsx",
  "frontend/src/lib/arena/battleShareCardPresentation.mjs",
  "frontend/src/lib/solanaArenaMoneyV2Layout.mjs",
  "programs/memewarzone_solana/src/graduation.rs",
  "test/LaunchFactory.spec.ts",
]);

const retainedReasons = new Map([
  ["frontend/api/campaigns-base.js", "Historical Solana campaign rows still require case-sensitive/base58 handling; current create/deploy authority is guarded elsewhere."],
  ["frontend/api/campaigns.js", "Historical campaign lifecycle reads preserve legacy Solana address semantics; no current deployment authority is selected here."],
  ["frontend/api/dev-fix/draft-deploy-base.js", "Legacy base implementation is reached only through the guarded current wrapper/signer; current Solana deploy authority is chain 101 only."],
  ["frontend/api/dev-fix/drafts-base.js", "Historical draft reads remain compatible; the current POST wrapper rejects legacy identity and canonicalizes chain 101."],
  ["frontend/api/dev-fix/route-auth.js", "Legacy EVM route-auth source remains for old records/tests; routeAuthorizationSigner rejects both Solana IDs from EVM signing."],
  ["frontend/api/lib/chainNative.js", "Pure native-unit/address-family compatibility; it does not authorize a chain and upstream Arena admission is current-identity guarded."],
  ["frontend/api/lib/finalizeLeagueEpoch.js", "Preserves base58 recipient case for already-recorded legacy epochs; claim authority is owned by PR #290."],
  ["frontend/src/lib/solanaArenaLayout.mjs", "Legacy cluster/layout probing remains readable for historical diagnostics; current Arena Money RPC/payment selectors reject legacy identity."],
  ["frontend/src/lib/solanaRewardNetwork.ts", "Legacy reward-network display/compatibility remains while PR #290 owns current claim routing and canonical chain-101 claim authority."],
  ["frontend/src/pages/PrepareBase.tsx", "Historical draft UI can identify old Solana records, but current draft write/deploy/ticker authorization fails legacy identity closed."],
  ["realtime-indexer/src/rewards/airdrops.ts", "Snapshot/preview logic preserves old Solana wallet casing and labels; it does not open claims and explicitly reports preview/estimated state."],
  ["frontend/api/arenaEventSponsorshipAuthority.js", "Only selects case-sensitive Solana address comparison for historical records; payment quotation/execution now uses canonical chain 101."],
  ["frontend/server/http.js", "Generic address-family helper preserves Solana base58 case for historical/social records; it is not a runtime or financial authority selector."],
  ["frontend/src/components/token/UnifiedMarketChart.tsx", "Historical market rows can still render with Solana address/cluster semantics; current market identity and LP authority reject legacy chain identity."],
  ["realtime-indexer/src/milestones.ts", "Notification/progress presentation retains historical Solana labeling; no financial, deployment, or route authority is granted."],
  ["realtime-indexer/src/jobs/generateLeagueStandings.ts", "Leaderboard/digest read compatibility only; current League finalization filters legacy identity and PR #290 owns claim execution."],
]);

function isFixtureOrHistory(path) {
  if (path === ".github/workflows/agent1-solana-102-closeout.yml") return true;
  if (/^\.github\/workflows\/(agent2-|solana-certification-pinned-runner)/.test(path)) return true;
  if (/^(db|frontend\/db|frontend\/supabase)\/migrations\//.test(path)) return true;
  if (path === "frontend/api/SUPABASE_SCHEMA_FIX.sql") return true;
  if (/^frontend\/api\/lib\/arena.*\.test\.mjs$/.test(path)) return true;
  if (path === "frontend/api/lib/arenaImportAuthority.test.mjs") return true;
  if (path === "frontend/scripts/t2-tournament-buyin-solana-real.mjs") return true;
  if (path === "realtime-indexer/src/tests/solanaLeaguePublish.test.ts") return true;
  if (/^tools\/solana-meteora-graduation\/check-/.test(path)) return true;
  return false;
}

function categoryFor(path) {
  if (claimsOwned.has(path)) return CATEGORY.CLAIMS;
  if (currentAuthority.has(path)) return CATEGORY.CURRENT;
  if (historicalCompatibility.has(path)) return CATEGORY.HISTORY;
  if (displayNormalization.has(path)) return CATEGORY.DISPLAY;
  if (unrelated.has(path)) return CATEGORY.UNRELATED;
  if (isFixtureOrHistory(path)) return CATEGORY.FIXTURE;
  return null;
}

const raw = execFileSync("git", ["grep", "-I", "-n", "-E", pattern, "--", "."], { encoding: "utf8" }).trim();
const lines = raw ? raw.split("\n") : [];
const counts = Object.fromEntries(Object.values(CATEGORY).map((name) => [name, 0]));
const filesByCategory = Object.fromEntries(Object.values(CATEGORY).map((name) => [name, new Set()]));
const unknown = [];
const occurrenceRegex = new RegExp(`(?<![0-9])${legacy}(?![0-9])`, "g");

for (const line of lines) {
  const first = line.indexOf(":");
  const second = line.indexOf(":", first + 1);
  const path = line.slice(0, first).replace(/^\.\//, "");
  const text = second >= 0 ? line.slice(second + 1) : "";
  const category = categoryFor(path);
  const hits = [...text.matchAll(occurrenceRegex)].length;
  if (!category) {
    unknown.push({ path, line: line.slice(first + 1, second), text });
    continue;
  }
  counts[category] += hits;
  filesByCategory[category].add(path);
}

if (unknown.length) {
  console.error("UNCLASSIFIED LEGACY SOLANA OCCURRENCES:");
  for (const item of unknown) console.error(`${item.path}:${item.line}:${item.text}`);
  process.exit(1);
}

const totalOccurrences = Object.values(counts).reduce((sum, value) => sum + value, 0);
const allFiles = new Set(Object.values(filesByCategory).flatMap((set) => [...set]));

console.log(`TOTAL_102_OCCURRENCES=${totalOccurrences}`);
console.log(`TOTAL_102_FILES=${allFiles.size}`);
for (const name of Object.values(CATEGORY)) {
  console.log(`CATEGORY ${name}: occurrences=${counts[name]} files=${filesByCategory[name].size}`);
}
for (const name of [CATEGORY.CURRENT, CATEGORY.CLAIMS]) {
  console.log(`FILES ${name}:`);
  for (const path of [...filesByCategory[name]].sort()) console.log(`  ${path}`);
}
console.log("RETAINED_LAUNCH_ADJACENT_REASONS:");
for (const [path, reason] of retainedReasons) {
  if (allFiles.has(path)) console.log(`  ${path} :: ${reason}`);
}

if (counts[CATEGORY.OBSOLETE] !== 0) {
  throw new Error("Current tracked files cannot contain an occurrence categorized as removed obsolete authority.");
}
