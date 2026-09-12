import { processEndedWeeklyRewardEpochs } from "../rewards/ledger.js";
import { ENV } from "../env.js";
import { emitNotification } from "../notifications.js";
import { pool } from "../db.js";
import { normalizeChain } from "../notificationContract.js";

function parseChainIds(): number[] {
  const ids = String(process.env.REWARD_CHAIN_ID || process.env.REWARD_CHAINS || process.env.LEAGUE_CHAINS || "56,101")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  return [...new Set(ids)];
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

async function main() {
  if (!ENV.DATABASE_URL) throw new Error("DATABASE_URL missing");
  const chainIds = parseChainIds();
  const sha = process.env.SOURCE_COMMIT || process.env.COOLIFY_GIT_COMMIT_SHA || process.env.GIT_SHA || "unset";
  const epochLimit = Math.max(1, Math.min(52, Number(process.env.PROCESS_REWARD_EPOCH_LIMIT || "1") || 1));
  const startedAt = Date.now();
  console.log(`[processRewardEpoch] BUILD_SHA=${sha} chains=${chainIds.join(",")} limit=${epochLimit}`);

  const results = [];
  for (const chainId of chainIds) {
    const chainStartedAt = Date.now();
    console.log(`[processRewardEpoch] chainId=${chainId} stage=start`);
    const chainResults = await processEndedWeeklyRewardEpochs([chainId], new Date());
    results.push(...chainResults);
    console.log(`[processRewardEpoch] chainId=${chainId} stage=done processed=${chainResults.length} durationMs=${elapsedMs(chainStartedAt)}`);
  }

  console.log(`[processRewardEpoch] chains=${chainIds.join(",")} processed=${results.length} durationMs=${elapsedMs(startedAt)}`);
  for (const item of results) {
    console.log(`[processRewardEpoch] chainId=${item.chainId} epochId=${item.epochId} status=${item.status} materialized=${item.materializedCount} claimable=${item.claimableCount}`);
    if (item.status === "claimable") {
      const chain = normalizeChain(item.chainId);
      if (!chain) continue;
      if (chain === "robinhood" && !/^(1|true|yes|on)$/i.test(String(process.env.ENABLE_ROBINHOOD_AIRDROP_NOTIFY || ""))) {
        console.log("[processRewardEpoch] skipping Robinhood airdrop.claims_open until ETH settlement rail is live");
        continue;
      }
      await emitNotification(pool, {
        eventType: "airdrop.claims_open",
        chain,
        chainId: item.chainId,
        dedupKey: `airdrop-claims-open:${chain}:${item.epochId}`,
        payload: {
          epoch: item.epochId,
          epochId: item.epochId,
          claimableCount: item.claimableCount,
        },
      });
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("processRewardEpoch failed", e);
    process.exit(1);
  });
