import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.cwd(), "frontend");
const targets = [
  "src/lib/solanaLeagueClaim.ts",
  "src/lib/solanaRewardClaim.ts",
  "src/lib/solanaRewardLaneClaim.ts",
  "src/lib/solanaTradeV1.ts",
  "src/lib/solanaMeteoraTrade.ts",
  "src/lib/solanaArenaV0.ts",
  "src/components/token/UpvoteDialog.tsx",
];

const forbidden = [
  /new\s+web3\.Transaction\s*\(/,
  /new\s+Transaction\s*\(/,
  /signAndSendTransaction\s*\(/,
  /sendAndConfirmTransaction\s*\(/,
];

const required = new Map([
  ["src/lib/solanaLeagueClaim.ts", "submitSolanaRewardV0Claim"],
  ["src/lib/solanaRewardClaim.ts", "submitSolanaRewardV0Claim"],
  ["src/lib/solanaRewardLaneClaim.ts", "submitSolanaRewardV0Claim"],
  ["src/lib/solanaTradeV1.ts", "compileLaunchpadV0WithLatestBlockhash"],
  ["src/lib/solanaMeteoraTrade.ts", "compileSolanaUserV0WithLatestBlockhash"],
  ["src/lib/solanaArenaV0.ts", "submitArenaUserV0"],
  ["src/components/token/UpvoteDialog.tsx", "submitSolanaUpvoteV0"],
]);

const failures = [];
for (const relative of targets) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) {
    failures.push(`${relative}: required normalized user transaction file is missing`);
    continue;
  }
  const source = fs.readFileSync(absolute, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(source)) failures.push(`${relative}: forbidden Legacy Solana transaction pattern ${pattern}`);
  }
  const marker = required.get(relative);
  if (marker && !source.includes(marker)) failures.push(`${relative}: missing V0 marker ${marker}`);
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}

// Arena must never grow a component/page-level Legacy Solana transaction again.
// This deliberately scans product surfaces in addition to the canonical helper.
const arenaSurfaceFiles = [
  ...walk(path.join(root, "src/components/arena")),
  ...walk(path.join(root, "src/lib/arena")),
  ...walk(path.join(root, "src/pages"))
    .filter((absolute) => /(?:Arena|BattleDetails|TournamentDetails).*\.(?:ts|tsx)$/.test(path.basename(absolute))),
].filter((absolute) => /\.(?:ts|tsx)$/.test(absolute));

const arenaForbidden = [
  /new\s+web3\.Transaction\s*\(/,
  /signAndSendTransaction\s*\(/,
  /sendAndConfirmTransaction\s*\(/,
];
for (const absolute of arenaSurfaceFiles) {
  const source = fs.readFileSync(absolute, "utf8");
  for (const pattern of arenaForbidden) {
    if (pattern.test(source)) {
      failures.push(`${path.relative(root, absolute)}: Arena surface contains forbidden Legacy Solana pattern ${pattern}`);
    }
  }
}

const upvoteExecutor = fs.readFileSync(path.join(root, "src/lib/solanaUpvoteV0.ts"), "utf8");
for (const marker of [
  "compileSolanaUserV0WithLatestBlockhash",
  "simulateSolanaUserV0OrThrow",
  "assertSolanaUserV0Intent",
  "getVoteTreasuryAddress",
  "mwz-arena-upvote",
]) {
  if (!upvoteExecutor.includes(marker)) failures.push(`src/lib/solanaUpvoteV0.ts: missing ${marker}`);
}

const arenaExecutor = fs.readFileSync(path.join(root, "src/lib/solanaArenaV0.ts"), "utf8");
for (const marker of [
  "REWARDS_TREASURY_PROGRAM_ID",
  "deriveArenaPdas",
  "buildArenaOpenBattleV0Instruction",
  "buildArenaDepositStakeV0Instruction",
  "buildArenaSupportV0Instruction",
  "buildArenaBuyInV0Instruction",
  "buildArenaWinnerClaimV0Instruction",
  "buildArenaStakeRefundV0Instruction",
  "buildArenaBuyInRefundV0Instruction",
  "buildArenaSettleExpiredV0Instruction",
  "compileSolanaUserV0WithLatestBlockhash",
  "simulateSolanaUserV0OrThrow",
  "assertSolanaUserV0Intent",
]) {
  if (!arenaExecutor.includes(marker)) failures.push(`src/lib/solanaArenaV0.ts: missing ${marker}`);
}

if (failures.length) {
  console.error("Solana user V0 normalization gate failed:\n" + failures.map((x) => `- ${x}`).join("\n"));
  process.exit(1);
}
console.log(
  `Solana user V0 normalization gate passed for ${targets.length} transaction paths and ${arenaSurfaceFiles.length} Arena source files.`,
);