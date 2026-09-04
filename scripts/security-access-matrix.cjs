#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const MATRIX = [
  ["LaunchFactory", "owner", "configuration before first campaign, live mode, pauses, route authority, registries", "factory locks mutable economics once campaigns exist"],
  ["LaunchFactory", "official campaigns", "notify graduation", "campaign address must be known by factory"],
  ["LaunchCampaign", "factory", "pause toggles and authorized-trading toggle", "campaign creator cannot bypass factory controls"],
  ["LaunchCampaign", "anyone", "graduateIfEligible when oracle USD threshold is met", "threshold, pause, oracle freshness, Topaz add-liquidity, and locker registration gate execution"],
  ["LaunchCampaign", "traders", "bonding buys/sells", "risk registry, route authorization, launch protection, slippage, solvency"],
  ["GraduationOracle", "none", "read-only price conversion", "immutable feed and max age; no manual price setter"],
  ["PermanentLpLocker", "factory/admin", "register official graduated pools", "Topaz factory, volatile flag, token pair, LP balance, single registration"],
  ["PermanentLpLocker", "anyone", "harvest registered pool fees", "balance-delta accounting, nonReentrant, no LP principal decrease"],
  ["PermanentLpLocker", "creator", "update own payout recipient", "creator identity is snapshotted; admin cannot redirect creator share"],
  ["PermanentLpLocker", "admin", "recover unrelated accidental assets", "registered LP and active fee assets are blocked"],
  ["TreasuryRouter", "admin", "set route vaults and LP locker", "admin should be production multisig"],
  ["TreasuryRouter", "PermanentLpLocker", "route LP native/ERC20 protocol share", "100% to ProtocolRevenueVault, no campaign/recruiter/airdrop split"],
  ["CreatorRegistry", "owner", "creator tier/restriction/rules", "owner should be production multisig"],
  ["CreatorRegistry", "launch recorder", "record launch/graduation counts", "LaunchFactory recorder only"],
  ["RiskRegistry", "owner", "wallet and cluster risk state", "owner should be production multisig"],
  ["TreasuryVaultV2", "multisig", "withdrawals, operator/root poster controls, epoch authorization", "rootPoster can only publish a Safe-authorized epoch inside the approved window and ceiling"],
  ["TreasuryVaultV2", "rootPoster", "publish authorized epoch Merkle roots", "cannot invent epochId/root/amount without Safe authorizeEpoch"],
  ["MonthlyLeagueTreasury", "multisig", "canonical month authorization and emergency withdraw", "months must follow YYYYMM sequence unless exceptional recovery is explicit"],
  ["MonthlyLeagueTreasury", "rootPoster", "seal authorized months", "cannot invent or skip months; winner total cannot exceed Safe ceiling"],
  ["RewardDistributor", "owner/Safe", "authorize and revoke Merkle batches", "batch operator cannot invent settlement scope or amount"],
  ["RewardDistributor", "batchOperator", "publish authorized batches", "must consume a Safe-approved budget/window"],
  ["CommunityRewardsVault", "airdropOperator", "fund authorized RewardDistributor batches", "RewardDistributor.authorizeBatch is required first"],
  ["TreasuryRouterV2/V3", "admin/Safe", "propose/accept money destinations after delay", "first vault set is immediate; replacements are delayed; locker disable is emergency-only"],
  ["CommunityRewardsVault", "TreasuryRouter", "airdrop/squad deposits", "router-only funding lanes"],
  ["RecruiterRewardsVault", "operator", "recruiter payouts", "caps and pause controls"],
];

const REQUIRED_PHASE15_CHECKS = [
  "npm run compile",
  "npm test",
  "npm run size",
  "npm run gas",
  "npm run coverage",
  "npm run security:matrix",
  "slither . --filter-paths node_modules,artifacts,cache",
  "manual audit: no registered LP withdrawal/approval/rescue path",
  "manual audit: creator + protocol payouts equal collected fees plus pending amounts",
  "manual audit: Topaz official interfaces/addresses confirmed before production",
];

function markdown() {
  const lines = [
    "# MemeWarzone Security Access Matrix",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Access Matrix",
    "",
    "| Contract | Actor | Permission | Guardrail |",
    "| --- | --- | --- | --- |",
    ...MATRIX.map((row) => `| ${row.map((cell) => String(cell).replace(/\|/g, "\\|")).join(" | ")} |`),
    "",
    "## Phase 15 Required Checks",
    "",
    ...REQUIRED_PHASE15_CHECKS.map((check) => `- [ ] ${check}`),
    "",
    "## Production Blockers To Close",
    "",
    "- [ ] Full Hardhat suite green on latest devpostgrad head.",
    "- [ ] Contract size gate green after locker/indexer/keeper additions.",
    "- [ ] Static review/Slither completed with no critical or high findings.",
    "- [ ] External audit completed and remediations merged.",
    "- [ ] Official Topaz router/factory/WBNB/pool behavior confirmed on BSC testnet.",
    "- [ ] Testnet soak covers graduation, post-grad swaps, claimable fees, harvest, and fallback payments.",
    "",
  ];
  return lines.join("\n");
}

function main() {
  const outFile = process.env.SECURITY_MATRIX_FILE || path.join(process.cwd(), "output", "security-access-matrix.md");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, markdown());
  console.log(`[security] wrote ${outFile}`);
}

module.exports = { MATRIX, REQUIRED_PHASE15_CHECKS, markdown };

if (require.main === module) main();
