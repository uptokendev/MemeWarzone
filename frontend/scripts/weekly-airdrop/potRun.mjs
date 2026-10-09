/**
 * The per-pot weekly EVM draw (founder, 2026-10-08: two airdrop pots per chain). run-weekly-airdrop.mjs
 * is the entry point (env, lock, DB pool); this module holds the draw so it can be tested against a fake
 * client with no database and no chain. Every DB / chain call goes through `deps` (defaults: the real
 * functions), and with a single main pot runAllPots does exactly what the single-pot runner did.
 */
import { asBigInt, envBool, splitPool, weightedSample, winnerCount } from "./config.mjs";
import {
  batchComplete, creatorCandidates, exclusionSets, findEpochBatch, otherPotWallets,
  stageWinners, traderCandidates, writeRewardAlert,
} from "./candidates.mjs";
import {
  configuredVaultAddress, ensureOnChainBatch, keepFundingCheck, markClaimOpen,
  markFundingCheck, resolvePoolWei, emptyAirdropPoolReason,
} from "./chain.mjs";
import { materializeAirdropBatch } from "./materialize.mjs";
import { nativeUsdFor, thresholdsFor } from "./usdRules.mjs";
import { MAIN_POT, drawLabel, isMainPot, potMetadata } from "./pots.mjs";

async function realAudit(client, { batchId, action, oldValue = null, newValue = null, reason, txHash = null, metadata = {} }) {
  await client.query(
    `insert into public.reward_audit_logs
      (batch_id,actor_type,actor_id,action,old_value,new_value,reason,tx_hash,metadata)
     values ($1,'scheduler','weekly_airdrop_runner',$2,$3,$4,$5,$6,$7::jsonb)`,
    [batchId, action, oldValue, newValue, reason, txHash, JSON.stringify(metadata)],
  );
}

async function realResumeFunding(client, d, { batch, chainId, distributorAddress, program, epochId, pot = MAIN_POT, vaultAddress = configuredVaultAddress(chainId) }) {
  if (!batch || batchComplete(batch)) return batch;
  const metadata = batch.metadata || {};
  if (!metadata.contractBatchId || !metadata.merkleRoot || !metadata.merkleTotalAmount) {
    throw new Error(`Existing ${program} batch ${batch.id} is missing Merkle metadata`);
  }
  await d.markFundingCheck(client, batch.id);
  try {
    const funding = await d.ensureOnChainBatch({
      batchId: batch.id,
      chainId,
      distributorAddress,
      vaultAddress,
      poolSource: metadata.poolSource || "community_rewards_vault",
      batchMetadata: metadata,
      pot,
    });
    const opened = await d.markClaimOpen(client, batch.id, funding);
    await d.audit(client, {
      batchId: batch.id,
      action: "automatic_airdrop_funding_resumed",
      oldValue: batch.status,
      newValue: "claim_open",
      reason: `Automatic funding resumed for ${program}`,
      txHash: funding.txHash,
      metadata: { chainId, epochId, program, funding, ...potMetadata(pot) },
    });
    return opened;
  } catch (error) {
    await d.keepFundingCheck(client, batch.id, error);
    await d.writeRewardAlert(client, {
      severity: "critical",
      title: "Airdrop batch funding remains incomplete",
      message: error?.message || String(error),
      metadata: { chainId, epochId, program, batchId: batch.id, ...potMetadata(pot) },
      batchId: batch.id,
    });
    throw error;
  }
}

async function realBatchWallets(client, batch) {
  if (!batch?.id) return [];
  const { rows } = await client.query(
    `select distinct lower(wallet_address) as wallet_address
       from public.reward_batch_items
      where batch_id=$1::uuid`,
    [batch.id],
  );
  return rows.map((row) => row.wallet_address).filter(Boolean);
}

/**
 * One pot's weekly draw, exactly the single-pot run it replaced: resume an unfunded batch, skip an
 * empty pot, draw both programs, materialize, fund through this pot's vault into this pot's
 * distributor. `weekReserved` holds wallets already drawn this week in the other pots (always applied:
 * one pot per wallet per week); the main pot alone gets an empty set, so its draw is unchanged.
 */
export async function runPot(client, ctx, potConfig, weekReserved, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const { chainId, epochId, start, end, claimDeadline, commitment, drawSecret, dryRun, distributionBps } = ctx;
  const { pot, distributorAddress } = potConfig;
  const main = isMainPot(pot);
  const tag = main ? "" : ` [${pot} pot]`;
  const vaultAddress = main ? configuredVaultAddress(chainId) : potConfig.vaultAddress;

  let traderBatch = await d.findEpochBatch(client, { chainId, epochId, program: "airdrop_trader", pot });
  let creatorBatch = await d.findEpochBatch(client, { chainId, epochId, program: "airdrop_creator", pot });
  if (!dryRun && traderBatch && !batchComplete(traderBatch)) {
    await d.resumeFunding(client, d, { batch: traderBatch, chainId, distributorAddress, program: "airdrop_trader", epochId, pot, vaultAddress });
    traderBatch = await d.findEpochBatch(client, { chainId, epochId, program: "airdrop_trader", pot });
  }
  if (!dryRun && creatorBatch && !batchComplete(creatorBatch)) {
    await d.resumeFunding(client, d, { batch: creatorBatch, chainId, distributorAddress, program: "airdrop_creator", epochId, pot, vaultAddress });
    creatorBatch = await d.findEpochBatch(client, { chainId, epochId, program: "airdrop_creator", pot });
  }
  if (batchComplete(traderBatch) && batchComplete(creatorBatch)) {
    return console.log(`[weekly-airdrop] ${epochId} already claim-open${tag}`);
  }

  const anchor = traderBatch?.metadata || creatorBatch?.metadata || null;
  const pool = anchor?.totalWeeklyPoolWei
    ? {
        availableWei: asBigInt(anchor.availablePoolWei || anchor.totalWeeklyPoolWei),
        source: anchor.poolSource || "community_rewards_vault",
        vaultAddress,
      }
    : await d.resolvePoolWei(chainId, potConfig);
  const totalPoolWei = anchor?.totalWeeklyPoolWei
    ? asBigInt(anchor.totalWeeklyPoolWei)
    : (pool.availableWei * BigInt(distributionBps)) / 10000n;
  const emptyReason = anchor ? null : emptyAirdropPoolReason(pool, totalPoolWei);
  if (emptyReason) {
    // Nothing to share this week: no batch, no funding, no alert. The next run checks again.
    return console.log(`[weekly-airdrop] chain ${chainId} ${epochId}${tag}: nothing to distribute, ${emptyReason}`);
  }
  if (totalPoolWei <= 0n) throw new Error("Calculated weekly airdrop pool is zero");

  // One USD rule set for every chain, converted at this run's spot price (usdRules.mjs).
  const thresholds = thresholdsFor(chainId, await d.nativeUsdFor(chainId));
  const traderPoolWei = totalPoolWei / 2n;
  const creatorPoolWei = totalPoolWei - traderPoolWei;
  const exclusions = await d.exclusionSets(client, { chainId, start, end });
  const [traders, creators] = await Promise.all([
    batchComplete(traderBatch) ? [] : d.traderCandidates(client, { chainId, start, end, exclusions, thresholds }),
    batchComplete(creatorBatch) ? [] : d.creatorCandidates(client, { chainId, start, end, exclusions, thresholds }),
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
      for (const wallet of await d.batchWallets(client, item.batch)) reservedWallets.add(wallet);
    }
  }

  const selections = [];
  for (const item of programs) {
    if (item.existing) continue;
    const notInOtherPot = item.candidates.filter((candidate) => !weekReserved.has(candidate.walletAddress.toLowerCase()));
    const eligibleCandidates = allowCrossProgramWinners
      ? notInOtherPot
      : notInOtherPot.filter((candidate) => !reservedWallets.has(candidate.walletAddress.toLowerCase()));
    if (!eligibleCandidates.length) {
      if (!main) {
        // Every eligible wallet already won in the main pot this week (or nobody qualified, which the
        // main pot has already alerted on). This pot's balance stays in its vault for next week.
        return console.log(`[weekly-airdrop] chain ${chainId} ${epochId}${tag}: no eligible ${item.program} wallet left after the other pots; the pot rolls over to next week`);
      }
      throw new Error(`No eligible candidates remain for ${item.program}; refusing to publish either program`);
    }
    const count = winnerCount(item.poolWei, eligibleCandidates.length, item.program, thresholds.targetPayoutRaw);
    const winners = weightedSample(eligibleCandidates, count, drawSecret, drawLabel(chainId, epochId, item.program, pot));
    const payouts = splitPool(item.poolWei, winners.length);
    if (!winners.length || payouts.some((value) => value <= 0n)) {
      throw new Error(`Invalid winners or payouts for ${item.program}`);
    }
    if (!allowCrossProgramWinners) {
      for (const winner of winners) reservedWallets.add(winner.walletAddress.toLowerCase());
    }
    selections.push({ ...item, candidates: eligibleCandidates, winners, payouts });
  }
  // The later pots must not draw these wallets again, even in a dry run (nothing is stored then).
  for (const item of selections) for (const winner of item.winners) weekReserved.add(winner.walletAddress.toLowerCase());

  for (const item of selections) {
    const { winners, payouts } = item;
    console.log(`[weekly-airdrop] ${item.program}${tag}: ${item.candidates.length} candidates -> ${winners.length} winners`);
    if (dryRun) {
      console.log(JSON.stringify({
        dryRun: true,
        chainId,
        epochId,
        ...(main ? {} : { pot }),
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
      await d.stageWinners(client, {
        chainId,
        epochId,
        program: item.program,
        winners,
        payouts,
        start,
        end,
        poolWei: item.poolWei,
        seedCommitment: commitment,
        pot,
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }

    const payload = await d.materializeAirdropBatch(client, {
      chainId,
      epochId,
      program: item.program,
      winners,
      payouts,
      claimDeadline,
      distributorAddress,
      pot,
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
      const funding = await d.ensureOnChainBatch({
        batchId: payload.batch.id,
        chainId,
        distributorAddress,
        vaultAddress: pool.vaultAddress,
        poolSource: pool.source,
        batchMetadata: payload.batch.metadata,
        pot,
      });
      await d.markClaimOpen(client, payload.batch.id, funding);
      await d.audit(client, {
        batchId: payload.batch.id,
        action: "automatic_airdrop_run_completed",
        newValue: "claim_open",
        reason: `Automatic weekly ${item.program} completed and funded`,
        txHash: funding.txHash,
        metadata: { chainId, epochId, program: item.program, commitment, funding, allowCrossProgramWinners, ...potMetadata(pot) },
      });
    } catch (error) {
      await d.keepFundingCheck(client, payload.batch.id, error);
      await d.writeRewardAlert(client, {
        severity: "critical",
        title: "Airdrop batch funding failed",
        message: error?.message || String(error),
        metadata: { chainId, epochId, program: item.program, batchId: payload.batch.id, ...potMetadata(pot) },
        batchId: payload.batch.id,
      });
      throw error;
    }
  }
}

export const DEFAULT_DEPS = Object.freeze({
  audit: realAudit,
  resumeFunding: realResumeFunding,
  batchWallets: realBatchWallets,
  findEpochBatch,
  otherPotWallets,
  resolvePoolWei,
  nativeUsdFor,
  exclusionSets,
  traderCandidates,
  creatorCandidates,
  stageWinners,
  materializeAirdropBatch,
  ensureOnChainBatch,
  markClaimOpen,
  keepFundingCheck,
  markFundingCheck,
  writeRewardAlert,
});

/**
 * Every pot of the chain, main first. A pot that fails never stops the next one; the run still throws
 * afterwards (one pot: its own error, unchanged; several: one error naming each failed pot).
 */
export async function runAllPots(client, ctx, pots, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const weekReserved = new Set();
  const failures = [];
  for (const potConfig of pots) {
    try {
      if (pots.length > 1) {
        for (const wallet of await d.otherPotWallets(client, { chainId: ctx.chainId, epochId: ctx.epochId, pot: potConfig.pot })) weekReserved.add(wallet);
      }
      await runPot(client, ctx, potConfig, weekReserved, d);
    } catch (error) {
      if (pots.length > 1) console.error(`[weekly-airdrop] ${potConfig.pot} pot failed`, error?.message || error);
      failures.push({ pot: potConfig.pot, error });
    }
  }
  if (failures.length === 1 && pots.length === 1) throw failures[0].error;
  if (failures.length) {
    const error = new Error(failures.map((item) => `${item.pot} pot: ${item.error?.message || item.error}`).join(" | "));
    error.pots = failures.map((item) => item.pot);
    throw error;
  }
  return weekReserved;
}
