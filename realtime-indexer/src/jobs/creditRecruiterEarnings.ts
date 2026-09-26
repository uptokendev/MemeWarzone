/**
 * Credits every on-chain recruiter slice to its recruiter (rewards/creditRecruiterEarnings.ts).
 *   node dist/jobs/creditRecruiterEarnings.js --dry-run    # reports, writes nothing
 *   node dist/jobs/creditRecruiterEarnings.js              # idempotent; run hourly (Coolify task)
 * Chains: RECRUITER_CREDIT_CHAINS (default 56,4663,101).
 */
import { pool } from "../db.js";
import { creditRecruiterEarnings } from "../rewards/creditRecruiterEarnings.js";

async function main() {
  const chainIds = String(process.env.RECRUITER_CREDIT_CHAINS || "56,4663,101").split(",").map((v) => Number(v.trim())).filter(Number.isFinite);
  const summary = await creditRecruiterEarnings({ chainIds, dryRun: process.argv.includes("--dry-run") });
  console.log(JSON.stringify({ chainIds, ...summary }, null, 2));
  if (summary.unattributed > 0) console.warn(`[creditRecruiterEarnings] ${summary.unattributed} recruiter slice(s) not attributable yet; they stay in the vault and are retried every run.`);
  await pool?.end();
}

main().catch((error) => {
  console.error("[creditRecruiterEarnings]", error);
  process.exit(1);
});
