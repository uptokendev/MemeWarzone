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
  ["src/components/token/UpvoteDialog.tsx", "submitSolanaUpvoteV0"],
]);

const failures = [];
for (const relative of targets) {
  const absolute = path.join(root, relative);
  const source = fs.readFileSync(absolute, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(source)) failures.push(`${relative}: forbidden Legacy Solana transaction pattern ${pattern}`);
  }
  const marker = required.get(relative);
  if (marker && !source.includes(marker)) failures.push(`${relative}: missing V0 marker ${marker}`);
}

const upvoteExecutor = fs.readFileSync(path.join(root, "src/lib/solanaUpvoteV0.ts"), "utf8");
for (const marker of [
  "compileSolanaUserV0WithLatestBlockhash",
  "simulateSolanaUserV0OrThrow",
  "assertSolanaUserV0Intent",
  "getVoteTreasuryAddress",
]) {
  if (!upvoteExecutor.includes(marker)) failures.push(`src/lib/solanaUpvoteV0.ts: missing ${marker}`);
}

if (failures.length) {
  console.error("Solana user V0 normalization gate failed:\n" + failures.map((x) => `- ${x}`).join("\n"));
  process.exit(1);
}
console.log(`Solana user V0 normalization gate passed for ${targets.length} live user transaction paths.`);
