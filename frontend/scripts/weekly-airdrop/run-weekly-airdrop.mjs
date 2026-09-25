import { pool } from "../../server/db.js";
import {
  DAY_MS, asBigInt, envBool, envInt, envText, epochWindow, requireEnv,
  seedCommitment, splitPool, weightedSample, winnerCount,
} from "./config.mjs";
import {
  assertAirdropSchema, batchComplete, creatorCandidates, exclusionSets, findEpochBatch,
  stageWinners, traderCandidates, writeRewardAlert,
} from "./candidates.mjs";
import {
  configuredVaultAddress, ensureOnChainBatch, keepFundingCheck, markClaimOpen,
  markFundingCheck, resolvePoolWei,
} from "./chain.mjs";
import { materializeAirdropBatch } from "./materialize.mjs";
import { nativeUsdFor, thresholdsFor } from "./usdRules.mjs";

async function audit(client, { batchId, action, oldValue = null, newValue = null, reason, txHash = null, metadata = {} }) {
  await client.query(
    `insert into public.reward_audit_logs
      (batch_id,actor_type,actor_id,action,old_value,new_value,reason,tx_hash,metadata)
     values ($1,'scheduler','weekly_airdrop_runner',$2,$3,$4,$5,$6,$7::jsonb)`,
    [batchId, action, oldValue, newValue, reason, txHash, JSON.stringify(metadata)],
  );
}

async function resumeFunding(client, { batch, chainId, distributorAddress, program, epochId }) {
  if (!batch || batchComplete(batch)) return batch;
  const metadata = batch.metadata || {};
  if (!metadata.contractBatchId || !metadata.merkleRoot || !metadata.merkleTotalAmount) {
    throw new Error(`Existing ${program} batch ${batch.id} is missing Merkle metadata`);
  }
  await markFundingCheck(client, batch.id);
  try {
    const funding = await ensureOnChainBatch({
      batchId: batch.id,
      chainId,
      distributorAddress,
      vaultAddress: configuredVaultAddress(chainId),
      poolSource: metadata.poolSource || "community_rewards_vault",
      batchMetadata: metadata,
    });
    const opened = await markClaimOpen(client, batch.id, funding);
    await audit(client, {
      batchId: batch.id,
      action: "automatic_airdrop_funding_resumed",
      oldValue: batch.status,
      newValue: "claim_open",
      reason: `Automatic funding resumed for ${program}`,
      txHash: funding.txHash,
      metadata: { chainId, epochId, program, funding },
    });
    return opened;
  } catch (error) {
    await keepFundingCheck(client, batch.id, error);
    await writeRewardAlert(client, {
      severity: "critical",
      title: "Airdrop batch funding remains incomplete",
      message: error?.message || String(error),
      metadata: { chainId, epochId, program, batchId: batch.id },
      batchId: batch.id,
    });
    throw error;
  }
}

async function batchWallets(client, batch) {
  if (!batch?.id) return [];
  const { rows } = await client.query(
    `select distinct lower(wallet_address) as wallet_address
       from public.reward_batch_items
      where batch_id=$1::uuid`,
    [batch.id],
  );
  return rows.map((row) => row.wallet_address).filter(Boolean);
}

async function main() {
  const chainId = envInt("AIRDROP_CHAIN_ID", 56, { min: 1, max: 1_000_000 });
  if (chainId === 101 || chainId === 102) {
    // Solana: one weekly Merkle tree over both programs, posted by the narrow reward-poster key.
    const { runSolanaWeeklyAirdrop } = await import("./run-solana-weekly-airdrop.mjs");
    return runSolanaWeeklyAirdrop({ chainId });
  }
  const drawSecret = requireEnv("AIRDROP_DRAW_SEED_SECRET");
  const distributorAddress = requireEnv(`REWARD_DISTRIBUTOR_ADDRESS_${chainId}`);
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

    let traderBatch = await findEpochBatch(client, { chainId, epochId, program: "airdrop_trader" });
    let creatorBatch = await findEpochBatch(client, { chainId, epochId, program: "airdrop_creator" });
    if (!dryRun && traderBatch && !batchComplete(traderBatch)) {
      await resumeFunding(client, { batch: traderBatch, chainId, distributorAddress, program: "airdrop_trader", epochId });
      traderBatch = await findEpochBatch(client, { chainId, epochId, program: "airdrop_trader" });
    }
    if (!dryRun && creatorBatch && !batchComplete(creatorBatch)) {
      await resumeFunding(client, { batch: creatorBatch, chainId, distributorAddress, program: "airdrop_creator", epochId });
      creatorBatch = await findEpochBatch(client, { chainId, epochId, program: "airdrop_creator" });
    }
    if (batchComplete(traderBatch) && batchComplete(creatorBatch)) {
      return console.log(`[weekly-airdrop] ${epochId} already claim-open`);
    }

    const anchor = traderBatch?.metadata || creatorBatch?.metadata || null;
    const pool = anchor?.totalWeeklyPoolWei
      ? {
          availableWei: asBigInt(anchor.availablePoolWei || anchor.totalWeeklyPoolWei),
          source: anchor.poolSource || "community_rewards_vault",
          vaultAddress: configuredVaultAddress(chainId),
        }
      : await resolvePoolWei(chainId);
    const totalPoolWei = anchor?.totalWeeklyPoolWei
      ? asBigInt(anchor.totalWeeklyPoolWei)
      : (pool.availableWei * BigInt(distributionBps)) / 10000n;
    if (totalPoolWei <= 0n) throw new Error("Calculated weekly airdrop pool is zero");

    // One USD rule set for every chain, converted at this run's spot price (usdRules.mjs).
    const thresholds = thresholdsFor(chainId, await nativeUsdFor(chainId));
    const traderPoolWei = totalPoolWei / 2n;
    const creatorPoolWei = totalPoolWei - traderPoolWei;
    const exclusions = await exclusionSets(client, { chainId, start, end });
    const [traders, creators] = await Promise.all([
      batchComplete(traderBatch) ? [] : traderCandidates(client, { chainId, start, end, exclusions, thresholds }),
      batchComplete(creatorBatch) ? [] : creatorCandidates(client, { chainId, start, end, exclusions, thresholds }),
    ]);
    const programs = [
      { program: "airdrop_trader", poolWei: traderPoolWei, candidates: traders, existing: batchComplete(traderBatch), batch: traderBatch },
      { program: "airdrop_creator", poolWei: creatorPoolWei, candidates: creators, existing: batchComplete(creatorBatch), batch: creatorBatch },
    ];
    const allowCrossProgramWinners = envBool("AIRDROP_ALLOW_CROSS_PROGRAM_WINNERS", false);
    const reservedWallets = new Set();
    if (!allowCrossProgramWinners) {
      for (const item of programs) {
        if (!item.existing) continue;
        for (const wallet of await batchWallets(client, item.batch)) reservedWallets.add(wallet);
      }
    }

    const selections = [];
    for (const item of programs) {
      if (item.existing) continue;
      const eligibleCandidates = allowCrossProgramWinners
        ? item.candidates
        : item.candidates.filter((candidate) => !reservedWallets.has(candidate.walletAddress.toLowerCase()));
      if (!eligibleCandidates.length) {
        throw new Error(`No eligible candidates remain for ${item.program}; refusing to publish either program`);
      }
      const count = winnerCount(item.poolWei, eligibleCandidates.length, item.program, thresholds.targetPayoutRaw);
      const winners = weightedSample(eligibleCandidates, count, drawSecret, `${chainId}:${epochId}:${item.program}`);
      const payouts = splitPool(item.poolWei, winners.length);
      if (!winners.length || payouts.some((value) => value <= 0n)) {
        throw new Error(`Invalid winners or payouts for ${item.program}`);
      }
      if (!allowCrossProgramWinners) {
        for (const winner of winners) reservedWallets.add(winner.walletAddress.toLowerCase());
      }
      selections.push({ ...item, candidates: eligibleCandidates, winners, payouts });
    }

    for (const item of selections) {
      const { winners, payouts } = item;
      console.log(`[weekly-airdrop] ${item.program}: ${item.candidates.length} candidates -> ${winners.length} winners`);
      if (dryRun) {
        console.log(JSON.stringify({
          dryRun: true,
          chainId,
          epochId,
          program: item.program,
          candidateCount: item.candidates.length,
          winnerCount: winners.length,
          programPoolWei: item.poolWei.toString(),
          allowCrossProgramWinners,
          winners: winners.map((winner, index) => ({
            walletAddress: winner.walletAddress,
            winnerRank: winner.winnerRank,
            finalWeight: winner.finalWeight,
            payoutAmount: payouts[index].toString(),
          })),
        }, null, 2));
        continue;
      }

      await client.query("begin");
      try {
        await stageWinners(client, {
          chainId,
          epochId,
          program: item.program,
          winners,
          payouts,
          start,
          end,
          poolWei: item.poolWei,
          seedCommitment: commitment,
        });
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }

      const payload = await materializeAirdropBatch(client, {
        chainId,
        epochId,
        program: item.program,
        winners,
        payouts,
        claimDeadline,
        distributorAddress,
        metadata: {
          automated: true,
          epochStart: start.toISOString(),
          epochEnd: end.toISOString(),
          candidateCount: item.candidates.length,
          winnerCount: winners.length,
          availablePoolWei: pool.availableWei.toString(),
          totalWeeklyPoolWei: totalPoolWei.toString(),
          programPoolWei: item.poolWei.toString(),
          poolSource: pool.source,
          distributionBps,
          nativeUsdAtDraw: thresholds.nativeUsd,
          drawSeedCommitment: commitment,
          securityExclusionCount: exclusions.totalCount,
          allowCrossProgramWinners,
        },
      });

      try {
        const funding = await ensureOnChainBatch({
          batchId: payload.batch.id,
          chainId,
          distributorAddress,
          vaultAddress: pool.vaultAddress,
          poolSource: pool.source,
          batchMetadata: payload.batch.metadata,
        });
        await markClaimOpen(client, payload.batch.id, funding);
        await audit(client, {
          batchId: payload.batch.id,
          action: "automatic_airdrop_run_completed",
          newValue: "claim_open",
          reason: `Automatic weekly ${item.program} completed and funded`,
          txHash: funding.txHash,
          metadata: { chainId, epochId, program: item.program, commitment, funding, allowCrossProgramWinners },
        });
      } catch (error) {
        await keepFundingCheck(client, payload.batch.id, error);
        await writeRewardAlert(client, {
          severity: "critical",
          title: "Airdrop batch funding failed",
          message: error?.message || String(error),
          metadata: { chainId, epochId, program: item.program, batchId: payload.batch.id },
          batchId: payload.batch.id,
        });
        throw error;
      }
    }
  } catch (error) {
    console.error("[weekly-airdrop] failed", error);
    await writeRewardAlert(client, {
      severity: "critical",
      title: "Weekly airdrop automation failed",
      message: error?.message || String(error),
      metadata: { chainId, epochId, start: start.toISOString(), end: end.toISOString() },
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
