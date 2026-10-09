// First: the same env setup the API server boots with (Supabase pooler TLS), before server/db.js reads it.
import "../../api/load-local-env.mjs";
import { pool } from "../../server/db.js";
import { DAY_MS, envBool, envInt, envText, epochWindow, requireEnv, seedCommitment } from "./config.mjs";
import { assertAirdropSchema, writeRewardAlert } from "./candidates.mjs";
import { providerFor } from "./chain.mjs";
import { airdropPots, isMainPot } from "./pots.mjs";
import { checkAirdropRunway } from "./authorizationHorizon.mjs";
// The per-pot draw (resume, empty-pot skip -> "nothing to distribute", candidates, materialize, fund)
// lives in potRun.mjs so it can be tested without a database.
import { runAllPots } from "./potRun.mjs";

async function main() {
  const chainId = envInt("AIRDROP_CHAIN_ID", 56, { min: 1, max: 1_000_000 });
  if (chainId === 101 || chainId === 102) {
    // Solana: one weekly Merkle tree over both programs, posted by the narrow reward-poster key.
    const { runSolanaWeeklyAirdrop } = await import("./run-solana-weekly-airdrop.mjs");
    return runSolanaWeeklyAirdrop({ chainId });
  }
  const drawSecret = requireEnv("AIRDROP_DRAW_SEED_SECRET");
  const distributorAddress = requireEnv(`REWARD_DISTRIBUTOR_ADDRESS_${chainId}`);
  // Main pot first (today's vault + distributor), then the gen-7 pot when both of its env vars are set.
  const pots = airdropPots(chainId).map((potConfig) => (isMainPot(potConfig.pot) ? { ...potConfig, distributorAddress } : potConfig));
  const dryRun = envBool("AIRDROP_DRY_RUN", false);
  const enabled = envBool("AIRDROP_AUTOMATION_ENABLED", false);
  if (!dryRun && !enabled) {
    throw new Error("AIRDROP_AUTOMATION_ENABLED must be true for non-dry runs");
  }
  const configuredDistributionBps = envText("AIRDROP_WEEKLY_DISTRIBUTION_BPS");
  if (!dryRun && !/^\d+$/.test(configuredDistributionBps)) {
    throw new Error("AIRDROP_WEEKLY_DISTRIBUTION_BPS must be explicitly configured for live runs");
  }
  const distributionBps = envInt("AIRDROP_WEEKLY_DISTRIBUTION_BPS", dryRun ? 1000 : 0, { min: 1, max: 10_000 });
  if (!dryRun && distributionBps === 10_000 && !envBool("AIRDROP_ALLOW_FULL_VAULT_DISTRIBUTION", false)) {
    throw new Error("100% vault distribution requires AIRDROP_ALLOW_FULL_VAULT_DISTRIBUTION=true");
  }
  const { start, end, epochId } = epochWindow();
  const claimDeadline = Math.floor((end.getTime() + envInt("AIRDROP_CLAIM_WINDOW_DAYS", 7, { min: 1, max: 90 }) * DAY_MS) / 1000);
  const commitment = seedCommitment(drawSecret, chainId, epochId);
  const lockKey = `mwz-weekly-airdrop:${chainId}:${epochId}`;
  const client = await pool.connect();
  let locked = false;

  try {
    const lock = await client.query("select pg_try_advisory_lock(hashtext($1)) locked", [lockKey]);
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) return console.log(`[weekly-airdrop] another runner owns ${lockKey}`);
    await assertAirdropSchema(client);

    // Every run checks the Safe pre-authorization runway of every pot and alerts below
    // AIRDROP_AUTH_ALERT_WEEKS (default 3); this week unauthorized is critical. Never blocks the draw.
    await checkAirdropRunway(client, { chainId, pots, currentEnd: end, writeAlert: writeRewardAlert, providerFor, dryRun });

    const ctx = { chainId, epochId, start, end, claimDeadline, commitment, drawSecret, dryRun, distributionBps };
    await runAllPots(client, ctx, pots);
  } catch (error) {
    console.error("[weekly-airdrop] failed", error);
    await writeRewardAlert(client, {
      severity: "critical",
      title: "Weekly airdrop automation failed",
      message: error?.message || String(error),
      metadata: { chainId, epochId, start: start.toISOString(), end: end.toISOString(), ...(error?.pots ? { pots: error.pots } : {}) },
      batchId: null,
    });
    process.exitCode = 1;
  } finally {
    if (locked) await client.query("select pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => {});
    client.release();
    await pool.end().catch(() => {});
  }
}

await main();
