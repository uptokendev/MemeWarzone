/**
 * Weekly Solana airdrop on our own Coolify server (founder, 2026-09-25).
 *
 *   pool     = airdrop_vault rent-free balance - what still-open batches may pay, x distribution bps
 *   rules    = the same USD rules as every chain (usdRules.mjs), at this run's SOL price
 *   draw     = the runner's committed, HMAC-weighted draw (same as BNB), split 50/50 trader/creator
 *   tree     = ONE Merkle tree for both programs (the program keys a batch by epoch id; the leaf
 *              carries the program code: trader 0, creator 1 -- api/lib/solanaRewardClaim.js)
 *   post     = post_airdrop_batch_root with the narrow reward-poster key (never the authority)
 *   claims   = the existing Claim Center reads reward_ledger (solana_airdrop) and signs claim_airdrop
 *
 * Idempotent per week: a materialized-but-unposted week resumes from its stored root; a posted one
 * is only marked claim-open. A program with no eligible wallets keeps its half in the vault.
 */
import { pool } from "../../server/db.js";
import {
  DAY_MS,
  asBigInt,
  envBool,
  envInt,
  envText,
  epochWindow,
  requireEnv,
  seedCommitment,
  splitPool,
  weightedSample,
  winnerCount,
} from "./config.mjs";
import {
  assertAirdropSchema,
  batchComplete,
  creatorCandidates,
  exclusionSets,
  findEpochBatch,
  stageWinners,
  traderCandidates,
  writeRewardAlert,
} from "./candidates.mjs";
import { markClaimOpen } from "./chain.mjs";
import {
  SOLANA_AIRDROP_PROGRAM_CODES,
  airdropLeaf,
  loadPosterKeypair,
  merkleTree,
  postSolanaAirdropRoot,
  readRewardPoster,
  readSolanaAirdropPool,
  solanaConnection,
  verifyProof,
} from "./solanaAirdrop.mjs";
import { nativeUsdFor, thresholdsFor } from "./usdRules.mjs";

const PROGRAMS = ["airdrop_trader", "airdrop_creator"];
const hex = (buf) => `0x${Buffer.from(buf).toString("hex")}`;

async function materializeSolanaWeek(client, { chainId, epochId, solanaEpochId, selections, claimDeadline, metadata }) {
  const entries = [];
  for (const item of selections) {
    item.winners.forEach((winner, index) => {
      entries.push({
        program: item.program,
        programCode: SOLANA_AIRDROP_PROGRAM_CODES[item.program],
        winner,
        walletAddress: winner.walletAddress,
        amount: BigInt(item.payouts[index]),
      });
    });
  }
  const leaves = entries.map((entry) => airdropLeaf({ epochId: solanaEpochId, programCode: entry.programCode, winner: entry.walletAddress, amount: entry.amount }));
  const { root, proofs } = merkleTree(leaves);
  leaves.forEach((leaf, i) => {
    if (!verifyProof(leaf, proofs[i], root)) throw new Error(`Proof self-check failed for leaf ${i}`);
  });
  const weekTotal = entries.reduce((sum, entry) => sum + entry.amount, 0n);

  await client.query("begin");
  try {
    const batches = {};
    for (const item of selections) {
      const programEntries = entries.filter((entry) => entry.program === item.program);
      const programTotal = programEntries.reduce((sum, entry) => sum + entry.amount, 0n);
      const claimMetadata = {
        ...metadata,
        epochId,
        program: item.program,
        programCode: SOLANA_AIRDROP_PROGRAM_CODES[item.program],
        automated: true,
        claimMode: "solana_airdrop",
        solanaEpochId: String(solanaEpochId),
        merkleRoot: hex(root),
        merkleWeekTotal: weekTotal.toString(),
        merkleTotalAmount: programTotal.toString(),
        merkleRecipientCount: programEntries.length,
        merkleLeafEncoding: "keccak(MWZ_AIRDROP_LEAF||i64le epoch||u8 program||winner32||u64le amount), sorted-pair keccak",
        claimDeadline,
        programPoolWei: item.poolWei.toString(),
        candidateCount: item.candidates.length,
        winnerCount: item.winners.length,
      };
      const { rows } = await client.query(
        `insert into public.reward_batches
          (reward_type,chain,token_symbol,status,total_amount,recipient_count,claimable_count,claimed_count,failed_count,source,metadata)
         values ('airdrop',$1,'SOL','funding_check',$2::numeric,$3,0,0,0,'weekly_airdrop_scheduler',$4::jsonb)
         returning *`,
        [String(chainId), programTotal.toString(), programEntries.length, JSON.stringify(claimMetadata)],
      );
      batches[item.program] = rows[0];
    }
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const batch = batches[entry.program];
      const winnerMetadata = {
        ...entry.winner,
        batchId: batch.id,
        program: entry.program,
        programCode: entry.programCode,
        solanaEpochId: String(solanaEpochId),
        claimMode: "solana_airdrop",
        merkleRoot: hex(root),
        merkleProof: proofs[index].map(hex),
        merkleLeaf: hex(leaves[index]),
        claimAmount: entry.amount.toString(),
        claimDeadline,
        chainId,
      };
      // Solana addresses are case-sensitive: stored exactly as drawn, never lowercased.
      const { rows } = await client.query(
        `insert into public.reward_ledger
          (reward_type,source_id,source_label,wallet_address,chain,token_symbol,amount,status,metadata)
         values ('airdrop',$1,'weekly_airdrop_scheduler',$2,$3,'SOL',$4::numeric,'approved',$5::jsonb)
         returning id`,
        [`${epochId}:${entry.program}:${entry.winner.winnerRank}`, entry.walletAddress, String(chainId), entry.amount.toString(), JSON.stringify(winnerMetadata)],
      );
      await client.query(
        `insert into public.reward_batch_items (batch_id,reward_ledger_id,wallet_address,amount,status,metadata)
         values ($1,$2,$3,$4::numeric,'approved',$5::jsonb)`,
        [batch.id, rows[0].id, entry.walletAddress, entry.amount.toString(), JSON.stringify(winnerMetadata)],
      );
    }
    await client.query("commit");
    return { batches, root, weekTotal };
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

/**
 * Founder rule: never pay out less than users are owed. A week above the poster cap is not shrunk;
 * it stays materialized (full list, full amounts) and this run stops with a critical alert. Raising
 * the cap and re-running posts exactly the stored list. At 70% of the cap we warn ahead of time.
 */
async function assertWithinPosterCap(client, { connection, poster, chainId, epochId, weekTotal }) {
  const state = await readRewardPoster(connection);
  if (!state) throw new Error("reward poster is not initialized on chain (scripts/solana/set-reward-poster.mjs)");
  if (state.poster !== poster.publicKey.toBase58()) {
    throw new Error(`SOLANA_REWARD_POSTER_SECRET is ${poster.publicKey.toBase58()}, but the on-chain reward poster is ${state.poster}`);
  }
  const cap = state.maxAirdropLamports;
  if (weekTotal > cap) {
    throw new Error(
      `Week ${epochId} owes ${weekTotal} lamports, above the poster cap ${cap}. Nothing was shrunk or skipped: ` +
      "raise the cap (node scripts/solana/set-reward-poster.mjs --airdrop-cap-sol <n> --execute) and re-run; the stored list is posted unchanged.",
    );
  }
  if (weekTotal * 10n >= cap * 7n) {
    await writeRewardAlert(client, {
      severity: "warning",
      title: "Solana airdrop is near the poster cap",
      message: `Week ${epochId} is ${weekTotal} lamports, ${Number((weekTotal * 100n) / cap)}% of the ${cap} cap. Raise the cap before it blocks a week.`,
      metadata: { chainId, epochId, weekTotal: weekTotal.toString(), cap: cap.toString() },
    });
  }
}

async function postAndOpen(client, { chainId, epochId, solanaEpochId, batches, root, weekTotal, claimDeadline, dryRun }) {
  if (dryRun) return console.log(`[weekly-airdrop:solana] dry run: would post root ${hex(root)} total ${weekTotal} for epoch ${solanaEpochId}`);
  const connection = solanaConnection();
  const poster = loadPosterKeypair();
  await assertWithinPosterCap(client, { connection, poster, chainId, epochId, weekTotal });
  const posted = await postSolanaAirdropRoot({
    connection,
    poster,
    epochId: solanaEpochId,
    root,
    totalLamports: weekTotal,
    deadline: claimDeadline,
  });
  for (const batch of Object.values(batches)) {
    if (!batch || batchComplete(batch)) continue;
    await markClaimOpen(client, batch.id, { txHash: posted.signature, blockNumber: null, requestId: null });
  }
  console.log(`[weekly-airdrop:solana] epoch ${epochId} claim-open`, { batch: posted.batchAddress, signature: posted.signature, alreadyPosted: posted.alreadyPosted });
}

export async function runSolanaWeeklyAirdrop({ chainId = 101 } = {}) {
  const drawSecret = requireEnv("AIRDROP_DRAW_SEED_SECRET");
  const dryRun = envBool("AIRDROP_DRY_RUN", false);
  if (!dryRun && !envBool("AIRDROP_AUTOMATION_ENABLED", false)) throw new Error("AIRDROP_AUTOMATION_ENABLED must be true for non-dry runs");
  const configuredBps = envText("AIRDROP_WEEKLY_DISTRIBUTION_BPS");
  if (!dryRun && !/^\d+$/.test(configuredBps)) throw new Error("AIRDROP_WEEKLY_DISTRIBUTION_BPS must be explicitly configured for live runs");
  const distributionBps = envInt("AIRDROP_WEEKLY_DISTRIBUTION_BPS", dryRun ? 1000 : 0, { min: 1, max: 10_000 });

  const { start, end, epochId } = epochWindow();
  const solanaEpochId = Math.floor(start.getTime() / 1000);
  const claimDeadline = Math.floor((end.getTime() + envInt("AIRDROP_CLAIM_WINDOW_DAYS", 7, { min: 1, max: 90 }) * DAY_MS) / 1000);
  const commitment = seedCommitment(drawSecret, chainId, epochId);
  const lockKey = `mwz-weekly-airdrop:${chainId}:${epochId}`;
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query("select pg_try_advisory_lock(hashtext($1)) locked", [lockKey]);
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) return console.log(`[weekly-airdrop:solana] another runner owns ${lockKey}`);
    await assertAirdropSchema(client);

    const existing = {};
    for (const program of PROGRAMS) existing[program] = await findEpochBatch(client, { chainId, epochId, program });
    const present = Object.values(existing).filter(Boolean);
    if (present.length && present.every(batchComplete)) return console.log(`[weekly-airdrop:solana] ${epochId} already claim-open`);
    if (present.length) {
      // Materialized earlier; resume by posting the stored root (read back from the ledger rows).
      const meta = present[0].metadata || {};
      const root = Buffer.from(String(meta.merkleRoot || "").replace(/^0x/, ""), "hex");
      if (root.length !== 32) throw new Error(`Stored Solana airdrop root for ${epochId} is invalid`);
      await postAndOpen(client, {
        chainId, epochId, solanaEpochId: Number(meta.solanaEpochId), batches: existing, root,
        weekTotal: asBigInt(meta.merkleWeekTotal), claimDeadline: Number(meta.claimDeadline), dryRun,
      });
      return;
    }

    const vault = await readSolanaAirdropPool();
    const totalPool = (vault.available * BigInt(distributionBps)) / 10_000n;
    if (totalPool <= 0n) {
      return console.log(`[weekly-airdrop:solana] nothing to distribute for ${epochId}`, { spendable: vault.spendable.toString(), outstanding: vault.outstanding.toString() });
    }
    const thresholds = thresholdsFor(chainId, await nativeUsdFor(chainId));
    const exclusions = await exclusionSets(client, { chainId, start, end });
    const [traders, creators] = await Promise.all([
      traderCandidates(client, { chainId, start, end, exclusions, thresholds }),
      creatorCandidates(client, { chainId, start, end, exclusions, thresholds }),
    ]);
    const halves = { airdrop_trader: totalPool / 2n, airdrop_creator: totalPool - totalPool / 2n };
    const candidatesBy = { airdrop_trader: traders, airdrop_creator: creators };
    const reserved = new Set();
    const selections = [];
    for (const program of PROGRAMS) {
      const eligible = candidatesBy[program].filter((candidate) => !reserved.has(candidate.walletAddress));
      if (!eligible.length) {
        console.log(`[weekly-airdrop:solana] ${program}: no eligible wallets; its half stays in the vault`);
        continue;
      }
      const poolWei = halves[program];
      const count = winnerCount(poolWei, eligible.length, program, thresholds.targetPayoutRaw);
      const winners = weightedSample(eligible, count, drawSecret, `${chainId}:${epochId}:${program}`);
      const payouts = splitPool(poolWei, winners.length);
      if (!winners.length || payouts.some((value) => value <= 0n)) throw new Error(`Invalid winners or payouts for ${program}`);
      for (const winner of winners) reserved.add(winner.walletAddress);
      selections.push({ program, poolWei, candidates: eligible, winners, payouts });
      console.log(`[weekly-airdrop:solana] ${program}: ${eligible.length} candidates -> ${winners.length} winners`);
    }
    if (!selections.length) return console.log(`[weekly-airdrop:solana] no eligible wallets in either program for ${epochId}; pool stays in the vault`);

    if (dryRun) {
      console.log(JSON.stringify({
        dryRun: true, chainId, epochId, solanaEpochId, nativeUsd: thresholds.nativeUsd,
        vault: { spendable: vault.spendable.toString(), outstanding: vault.outstanding.toString(), available: vault.available.toString() },
        totalPool: totalPool.toString(),
        programs: selections.map((item) => ({
          program: item.program, candidateCount: item.candidates.length,
          winners: item.winners.map((winner, i) => ({ walletAddress: winner.walletAddress, payoutLamports: item.payouts[i].toString() })),
        })),
      }, null, 2));
      return;
    }

    for (const item of selections) {
      await client.query("begin");
      try {
        await stageWinners(client, { chainId, epochId, program: item.program, winners: item.winners, payouts: item.payouts, start, end, poolWei: item.poolWei, seedCommitment: commitment, tokenSymbol: "SOL" });
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
    const materialized = await materializeSolanaWeek(client, {
      chainId, epochId, solanaEpochId, selections, claimDeadline,
      metadata: {
        epochStart: start.toISOString(), epochEnd: end.toISOString(), distributionBps,
        nativeUsdAtDraw: thresholds.nativeUsd, drawSeedCommitment: commitment,
        vaultSpendableLamports: vault.spendable.toString(), vaultOutstandingLamports: vault.outstanding.toString(),
        totalWeeklyPoolWei: totalPool.toString(), poolSource: "solana_airdrop_vault", securityExclusionCount: exclusions.totalCount,
      },
    });
    await postAndOpen(client, { chainId, epochId, solanaEpochId, ...materialized, claimDeadline, dryRun });
  } catch (error) {
    console.error("[weekly-airdrop:solana] failed", error);
    await writeRewardAlert(client, {
      severity: "critical",
      title: "Weekly Solana airdrop failed",
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
