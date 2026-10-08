/**
 * EVM creator-choice operator (launch generation): one pass per chain over the coins whose creator chose
 * holders, split or buyback (spec docs/evm-launch/spec/C1-C6-fees.md, C6 / D19 / E10 / E15; the Solana twin is
 * src/dbc/dbcCreatorPayouts.ts). Per pass, in this order, and at most ONE transaction per chain in flight:
 *
 *   1. Resolve the job left 'sending' by an earlier pass (receipt; same raw bytes re-broadcast while the nonce is
 *      unused; 'dropped' once the nonce went elsewhere) and apply its effect on the holder batch it belongs to.
 *   2. Week secrets: publish sha256 of this and next week's secret, reveal every finished week's secret.
 *   3. Holder snapshot of every holders / split coin at this week's secret moment (first pass after it).
 *   4. Weekly (Monday >= 00:05 UTC) holder batch for the week just finished: pots = holderBalance on chain,
 *      pro rata by snapshot balance, remainder to the largest holder, wallets below the minimum payout roll over,
 *      scaled into the vault's weekly cap, root + total + leaf file built and PUBLISHED (evm_holder_batches and the
 *      Claim Center's reward_batches / reward_ledger), then proposeHolderBatch. After the Safe approves the exact
 *      root and total (approveHolderBatch + distributor authorizeBatch) and the 24 h veto window: executeHolderBatch.
 *   5. flushBuybackTokens once a buyback coin's token trades; syncLpFees for graduated coins whose locker paid
 *      (first sync binds the pool, so a buyback coin's pool buyback can start).
 *   6. Buyback coins at their secret moments: buybackCurve before graduation (route authority signature from the
 *      API, never a key here), buybackPool after (native pool), or for a quote-bound pool (E10) buybackPool with
 *      the quote balance, else convertBuybackNativeToQuote.
 *   7. Quote-bound holders / split coins at their secret moments: convertHolderQuote.
 *
 * Everything is simulated from the operator before it is signed, and recorded before it is broadcast. Dry run
 * unless send is true: decisions are reported, nothing is signed, no API signature is requested and no holder
 * batch is published. Week commitments and holder snapshots are data, not money, and are kept in a dry run too
 * (as on Solana), so switching to send mid-week loses nothing.
 */
import { ethers } from "ethers";
import {
  CHOICE,
  DEAD,
  DEFAULT_HOLDER_PROGRAM,
  allocateToHolders,
  buildLeafFile,
  buybackBudget,
  curveRoom,
  dueMomentKey,
  fitPotsToRoom,
  holderBatchId,
  impactBps,
  linearCurvePriceAfter,
  merklePlan,
  previousWeek,
  sizeWithinImpact,
  snapshotMoment,
  vaultWeek,
  weekCommitment,
  weekOf,
  weekSecret,
  weeklyRunDue,
  type LeafFile,
  type VaultLimits,
} from "./evmCreatorChoice.js";
import {
  callArgsJson,
  type Census,
  type ChoiceAction,
  type ChoiceChain,
  type ChoiceSender,
  type SimResult,
  type VaultCall,
} from "./evmCreatorChoiceChain.js";
import { gen7CurvePriceAfter, isEvmGen7CampaignGeneration } from "./evmGen7Curve.js";

export type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };

type PoolLike = Queryable & { connect?: () => Promise<Queryable & { release: () => void }> };

/** Runs fn in one transaction on ONE connection: a pg Pool would hand every query to any of its clients. */
async function withTx<T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const pool = db as PoolLike;
  const client = typeof pool.connect === "function" ? await pool.connect() : null;
  const tx: Queryable = client ?? db;
  try {
    await tx.query("begin");
    const out = await fn(tx);
    await tx.query("commit");
    return out;
  } catch (error) {
    await tx.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client?.release();
  }
}

export type PlatformCoin = {
  campaign: string; // lowercase
  token: string | null;
  creator: string | null;
  createdBlock: number;
  choice: number; // 2 holders, 3 split, 4 buyback
  stage: "trading" | "pending" | "graduated";
  pool: string | null;
  /** evm_campaign_gen5_state.campaign_generation; 6 = gen-7 (constant-product curve). Absent: gen-6 rules. */
  campaignGeneration?: number | null;
};

export type ChoiceConfig = {
  masterSecret: string;
  /** Buyback / conversion moments per coin per day (the vault's interval still applies). */
  perDay: number;
  /** Smallest native buyback worth a transaction. */
  minSpendWei: bigint;
  /** A wallet whose weekly total is below this gets nothing this week; its share rolls over. */
  minPayoutWei: bigint;
  claimWindowDays: number;
  /** Optional ceiling per weekly holder batch (the Safe's EVMGEN_HOLDER_BATCH_AUTH_MAX). */
  holderBatchMaxWei: bigint | null;
  /** Extra wallets that never count as holders (lowercase). */
  excluded: Set<string>;
  /** Periodic syncLpFees probe per graduated coin when no harvest event was seen. */
  syncEverySeconds: number;
  maxGas: bigint;
  /** Curve buyback: the sizing aims at this share of the vault's impact limit. */
  impactMarginBps: number;
  /** Curve buyback: minOut = quoted tokens less this. */
  slippageBps: number;
  maxSnapshotsPerPass: number;
  /** Publish the batch to the Claim Center tables (reward_batches / reward_ledger). */
  publishRewardBatches: boolean;
};

export const DEFAULT_CHOICE_CONFIG: Omit<ChoiceConfig, "masterSecret"> = {
  perDay: 4,
  minSpendWei: 10n ** 15n,
  minPayoutWei: 10n ** 15n,
  claimWindowDays: 60,
  holderBatchMaxWei: null,
  excluded: new Set(),
  syncEverySeconds: 6 * 3600,
  maxGas: 3_000_000n,
  impactMarginBps: 8_000,
  slippageBps: 100,
  maxSnapshotsPerPass: 5,
  publishRewardBatches: true,
};

/** Asks the API (internal endpoint, shared secret) for the route authority's buyback trade signature. */
export type BuybackAuthClient = (req: { chainId: number; campaign: string; vault: string; amountIn: bigint; minOut: bigint }) => Promise<{ signature: string; deadline: bigint }>;

export type StepReport = {
  kind: "holders" | "flush" | "sync" | "buyback" | "convert" | "snapshot" | "resolve";
  subject: string;
  decision: "send" | "sent" | "dry-run" | "skip" | "wait" | "blocked" | "queued";
  action?: ChoiceAction;
  reason?: string;
  txHash?: string;
  error?: string;
};

export type PassReport = { chainId: number; send: boolean; operatorOk: boolean; inFlight: boolean; steps: StepReport[] };

type Candidate = { report: StepReport; call: VaultCall; momentKey: string; intervalKey: string | null; amount: bigint | null; gas: bigint; onRecorded?: (jobId: number) => Promise<void> };

const lc = (a: string) => a.toLowerCase();

// ------------------------------------------------------------------------------------ database reads

export async function listPlatformCoins(db: Queryable, chainId: number, vault: string): Promise<PlatformCoin[]> {
  const { rows } = await db.query(
    `select s.campaign_address, s.graduation_stage, s.graduated_pool, s.fee_choice,
            c.token_address, c.creator_address, coalesce(c.created_block, 0)::bigint as created_block,
            s.campaign_generation
       from public.evm_campaign_gen5_state s
       left join public.campaigns c on c.chain_id = s.chain_id and lower(c.campaign_address) = s.campaign_address
      where s.chain_id = $1 and s.fee_choice in (2, 3, 4) and s.fee_vault = $2
      order by s.campaign_address`,
    [chainId, lc(vault)],
  );
  return rows.map((r: any) => ({
    campaign: lc(String(r.campaign_address)),
    token: r.token_address ? lc(String(r.token_address)) : null,
    creator: r.creator_address ? lc(String(r.creator_address)) : null,
    createdBlock: Number(r.created_block || 0),
    choice: Number(r.fee_choice),
    stage: (String(r.graduation_stage || "trading") as PlatformCoin["stage"]),
    pool: r.graduated_pool ? lc(String(r.graduated_pool)) : null,
    campaignGeneration: r.campaign_generation == null ? null : Number(r.campaign_generation),
  }));
}

// ------------------------------------------------------------------------------------ week secrets

export async function ensureWeekSecrets(db: Queryable, chainId: number, masterSecret: string, now: Date) {
  const current = weekOf(now);
  const next = weekOf(new Date(current.end.getTime() + 1));
  for (const week of [current, next]) {
    await db.query(
      `insert into public.evm_creator_choice_weeks (chain_id, week_id, commitment) values ($1, $2, $3)
       on conflict (chain_id, week_id) do nothing`,
      [chainId, week.weekId, weekCommitment(weekSecret(masterSecret, chainId, week.weekId))],
    );
  }
  const { rows } = await db.query(`select week_id from public.evm_creator_choice_weeks where chain_id = $1 and secret is null`, [chainId]);
  for (const row of rows) {
    const week = weekOf(new Date(`${row.week_id}T00:00:00Z`));
    if (week.end.getTime() > now.getTime()) continue;
    const secret = weekSecret(masterSecret, chainId, week.weekId);
    // The commitment in the row must be this secret's: a changed master secret never reveals a wrong week.
    await db.query(
      `update public.evm_creator_choice_weeks set secret = $3, revealed_at = now()
        where chain_id = $1 and week_id = $2 and commitment = $4 and secret is null`,
      [chainId, week.weekId, secret, weekCommitment(secret)],
    );
  }
}

// ------------------------------------------------------------------------------------ jobs

export type ResolveResult = { confirmed: number; reverted: number; dropped: number; rebroadcast: number; waiting: number };

function isBenignBroadcastError(message: string): boolean {
  return /already known|known transaction|nonce too low|replacement transaction underpriced|already imported/i.test(message);
}

async function finishJob(db: Queryable, chain: ChoiceChain | null, chainId: number, row: any, status: "confirmed" | "reverted" | "dropped", block: number | null) {
  await db.query(
    `update public.evm_creator_choice_jobs set status = $2, receipt_block = $3, updated_at = now() where id = $1`,
    [row.id, status, block],
  );
  const action = String(row.action);
  if (!chain) {
    if (action === "propose_holder_batch" || action === "execute_holder_batch") {
      console.error("[evm-choice] holder batch job of a vault this worker does not operate: batch left for a person", { chainId, vault: row.vault_address, batchId: row.subject, status });
    }
    return;
  }
  if (action === "propose_holder_batch") {
    const batch = (await db.query(`select * from public.evm_holder_batches where chain_id = $1 and batch_id = $2`, [chainId, String(row.subject)])).rows[0];
    if (!batch) return;
    if (status === "confirmed") {
      const ev = await chain.proposedInReceipt(String(row.tx_hash));
      const matches = ev && lc(ev.root) === lc(String(batch.root)) && ev.total.toString() === String(batch.total_raw);
      if (!matches) {
        console.error("[evm-choice] proposed batch on chain does not match the published leaf file", { chainId, batchId: row.subject, event: ev && { root: ev.root, total: ev.total.toString() } });
        // Something other than the published file is on chain under this id: never rebuilt automatically (the id is
        // taken on chain); the Safe vetoes it and a person looks.
        await db.query(
          `update public.evm_holder_batches set status = 'failed', attempt = 1000, last_reason = $3, updated_at = now()
            where chain_id = $1 and week_id = $2 and vault_address = $4`,
          [chainId, batch.week_id, "the proposal on chain does not match the published leaf file: veto it", lc(String(batch.vault_address))],
        );
        await archiveRewardBatch(db, batch.reward_batch_id, "proposal on chain does not match the leaf file");
        return;
      }
      await db.query(
        `update public.evm_holder_batches set status = 'proposed', executable_at = to_timestamp($3), last_reason = null, updated_at = now()
          where chain_id = $1 and week_id = $2 and vault_address = $4`,
        [chainId, batch.week_id, Number(ev!.executableAt), lc(String(batch.vault_address))],
      );
    } else {
      await setBatch(db, chainId, String(batch.vault_address), batch.week_id, "failed", `propose ${status}`);
      await archiveRewardBatch(db, batch.reward_batch_id, `holder batch proposal ${status}`);
    }
  } else if (action === "execute_holder_batch") {
    const batch = (await db.query(`select * from public.evm_holder_batches where chain_id = $1 and batch_id = $2`, [chainId, String(row.subject)])).rows[0];
    if (!batch) return;
    if (status === "confirmed") {
      await setBatch(db, chainId, String(batch.vault_address), batch.week_id, "executed", null);
      await openRewardBatch(db, batch.reward_batch_id, String(row.tx_hash), block);
    } else {
      await setBatch(db, chainId, String(batch.vault_address), batch.week_id, "proposed", `execute ${status}`);
    }
  }
}

/**
 * Resolves every 'sending' job of the chain, whichever vault it was for: one operator key signs for every creator
 * vault of the chain (gen-6 and gen-7), so they share one nonce sequence and one transaction in flight per chain
 * (the evm_creator_choice_jobs_one_in_flight_idx unique index). A job's batch effects are read through its own
 * vault's chain (`chainFor`); a job for a vault this worker no longer operates gets its status only.
 */
export async function resolveSendingJobs(input: { db: Queryable; chainId: number; chain: ChoiceChain; sender: ChoiceSender; send: boolean; chainFor?: (vault: string) => ChoiceChain | null }): Promise<ResolveResult> {
  const out: ResolveResult = { confirmed: 0, reverted: 0, dropped: 0, rebroadcast: 0, waiting: 0 };
  const { rows } = await input.db.query(
    `select * from public.evm_creator_choice_jobs where chain_id = $1 and status = 'sending' order by id`,
    [input.chainId],
  );
  const chainOf = (vault: string): ChoiceChain | null => {
    if (lc(vault) === lc(input.chain.vault)) return input.chain;
    return input.chainFor ? input.chainFor(vault) : null;
  };
  for (const row of rows) {
    const jobChain = chainOf(String(row.vault_address));
    let receipt = await input.sender.getReceipt(String(row.tx_hash));
    if (!receipt && (await input.sender.getNonce("latest")) > Number(row.nonce)) {
      // Nonce used, no receipt yet for our hash: check once more before calling it dropped.
      receipt = await input.sender.getReceipt(String(row.tx_hash));
      if (!receipt) {
        await finishJob(input.db, jobChain, input.chainId, row, "dropped", null);
        await input.db.query(`update public.evm_creator_choice_jobs set last_error = 'nonce used by another transaction' where id = $1`, [row.id]);
        out.dropped += 1;
        continue;
      }
    }
    if (receipt) {
      const ok = Number(receipt.status) === 1;
      await finishJob(input.db, jobChain, input.chainId, row, ok ? "confirmed" : "reverted", receipt.blockNumber);
      if (ok) out.confirmed += 1;
      else out.reverted += 1;
      continue;
    }
    if (input.send && row.raw_tx) {
      try {
        await input.sender.broadcast(String(row.raw_tx));
        await input.db.query(`update public.evm_creator_choice_jobs set attempt = attempt + 1, updated_at = now() where id = $1`, [row.id]);
        out.rebroadcast += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isBenignBroadcastError(message)) {
          await input.db.query(`update public.evm_creator_choice_jobs set last_error = $2, updated_at = now() where id = $1`, [row.id, message.slice(0, 500)]);
        }
      }
    }
    out.waiting += 1;
  }
  return out;
}

async function liveMomentKeys(db: Queryable, chainId: number, subject: string, actions: ChoiceAction[]): Promise<Set<string>> {
  const { rows } = await db.query(
    `select moment_key from public.evm_creator_choice_jobs
      where chain_id = $1 and subject = $2 and action = any($3::text[]) and status in ('sending', 'confirmed')`,
    [chainId, subject, actions],
  );
  return new Set(rows.map((r: any) => String(r.moment_key)));
}

/** Chain time (unix seconds) of the last live (sending / confirmed) job for this key and actions, or null. */
async function lastConfirmedAt(db: Queryable, chainId: number, column: "subject" | "interval_key", key: string, actions: ChoiceAction[], vault?: string): Promise<number | null> {
  // `vault`: the vault's own interval (lastBuybackAt is per vault on chain); a route pool two vaults share does not
  // hold one vault back for the other's conversion.
  const { rows } = await db.query(
    `select chain_time as at from public.evm_creator_choice_jobs
      where chain_id = $1 and ${column} = $2 and action = any($3::text[]) and status in ('sending', 'confirmed')
        ${vault ? "and vault_address = $4" : ""}
      order by chain_time desc, id desc limit 1`,
    vault ? [chainId, key, actions, lc(vault)] : [chainId, key, actions],
  );
  return rows[0] ? Number(rows[0].at) : null;
}

// ------------------------------------------------------------------------------------ Claim Center tables

async function setBatch(db: Queryable, chainId: number, vault: string, weekId: string, status: string, reason: string | null) {
  await db.query(
    `update public.evm_holder_batches
        set status = $3, last_reason = $4, attempt = attempt + (case when $3 = 'failed' then 1 else 0 end), updated_at = now()
      where chain_id = $1 and week_id = $2 and vault_address = $5`,
    [chainId, weekId, status, reason, lc(vault)],
  );
}

function nativeSymbol(chainId: number) {
  return chainId === 4663 || chainId === 46630 ? "ETH" : "BNB";
}

/**
 * Publishes a holder batch the way the weekly airdrop publishes its batches (materialize.mjs): one
 * reward_batches row (program airdrop_holders, status funding_check) and one reward_ledger + reward_batch_items
 * row per leaf with its proof and the holder distributor as claim contract. The Claim Center opens them once
 * executeHolderBatch has funded the distributor.
 */
export async function publishRewardBatch(db: Queryable, file: LeafFile): Promise<string | null> {
  // gen-6 "airdrop_holders"; gen-7's vault "airdrop_holders_gen7": one Claim Center batch per vault and week (the
  // reward_batches unique index is chain + epochId + program).
  const program = file.program ?? DEFAULT_HOLDER_PROGRAM;
  const entries = file.leaves.map((l) => ({ account: l.account, amount: BigInt(l.amount) }));
  const { leaves, proofs, root } = merklePlan(entries);
  return withTx(db, async (db) => {
    const dup = await db.query(
      `select id from public.reward_batches
        where reward_type='airdrop' and chain::text=$1 and metadata->>'epochId'=$2 and metadata->>'program'=$3
          and status<>'archived' limit 1 for update`,
      [String(file.chainId), file.weekId, program],
    );
    if (dup.rows[0]) return String(dup.rows[0].id);
    const metadata = {
      epochId: file.weekId,
      program,
      automated: true,
      source: "evm_creator_choice_operator",
      claimMode: "reward_distributor_merkle",
      claimContract: "RewardDistributor",
      distributorAddress: file.holderDistributor,
      rewardDistributorAddress: file.holderDistributor,
      contractBatchId: file.batchId,
      merkleBatchId: file.batchId,
      merkleRoot: root,
      merkleRecipientCount: entries.length,
      merkleTotalAmount: file.total,
      merkleLeafEncoding: file.leafEncoding,
      merklePairSorting: file.pairSorting,
      claimDeadline: file.claimDeadline,
      creatorVault: file.vault,
      holderCampaigns: file.campaigns,
    };
    const batch = (
      await db.query(
        `insert into public.reward_batches
          (reward_type,chain,token_symbol,status,total_amount,recipient_count,claimable_count,claimed_count,failed_count,source,metadata)
         values ('airdrop',$1,$4,'funding_check',$2::numeric,$3,0,0,0,'evm_creator_choice_operator',$5::jsonb)
         returning id`,
        [String(file.chainId), file.total, entries.length, nativeSymbol(file.chainId), JSON.stringify(metadata)],
      )
    ).rows[0];
    for (let i = 0; i < entries.length; i += 1) {
      const wallet = entries[i].account.toLowerCase();
      const meta = {
        role: "Holder", program, epochId: file.weekId, batchId: batch.id, batchIndex: i,
        claimMode: metadata.claimMode, claimContract: metadata.claimContract,
        distributorAddress: file.holderDistributor, rewardDistributorAddress: file.holderDistributor,
        contractBatchId: file.batchId, merkleBatchId: file.batchId, merkleRoot: root,
        merkleProof: proofs[i], merkleLeaf: leaves[i], claimAmount: entries[i].amount.toString(), claimDeadline: file.claimDeadline,
      };
      const ledger = (
        await db.query(
          `insert into public.reward_ledger
            (reward_type,source_id,source_label,wallet_address,chain,token_symbol,amount,status,metadata)
           values ('airdrop',$1,'evm_creator_choice_operator',$2,$3,$6,$4::numeric,'approved',$5::jsonb)
           returning id`,
          [`${file.weekId}:${program}:${i + 1}`, wallet, String(file.chainId), entries[i].amount.toString(), JSON.stringify(meta), nativeSymbol(file.chainId)],
        )
      ).rows[0];
      await db.query(
        `insert into public.reward_batch_items (batch_id,reward_ledger_id,wallet_address,amount,status,metadata)
         values ($1,$2,$3,$4::numeric,'approved',$5::jsonb)`,
        [batch.id, ledger.id, wallet, entries[i].amount.toString(), JSON.stringify(meta)],
      );
    }
    return String(batch.id);
  });
}

async function openRewardBatch(db: Queryable, rewardBatchId: string | null, txHash: string, block: number | null) {
  if (!rewardBatchId) return;
  await withTx(db, async (db) => {
    const ledger = await db.query(
      `update public.reward_ledger set status='claimable',claimable_at=coalesce(claimable_at,now()),claim_error=null,updated_at=now()
        where id in (select reward_ledger_id from public.reward_batch_items where batch_id=$1::uuid) and status='approved'
        returning id`,
      [rewardBatchId],
    );
    await db.query(`update public.reward_batch_items set status='claimable' where batch_id=$1::uuid and status='approved'`, [rewardBatchId]);
    await db.query(
      `update public.reward_batches set status='claim_open',claimable_count=$2,published_at=coalesce(published_at,now()),
              metadata=coalesce(metadata,'{}'::jsonb)||$3::jsonb,updated_at=now()
        where id=$1::uuid`,
      [rewardBatchId, ledger.rows.length, JSON.stringify({ onChainBatchCreated: true, onChainBatchTxHash: txHash, onChainBatchBlockNumber: block, onChainBatchVerifiedAt: new Date().toISOString() })],
    );
  });
}

async function archiveRewardBatch(db: Queryable, rewardBatchId: string | null, reason: string) {
  if (!rewardBatchId) return;
  await db.query(
    `update public.reward_ledger set status='cancelled',claim_error=$2,updated_at=now()
      where id in (select reward_ledger_id from public.reward_batch_items where batch_id=$1::uuid) and status in ('approved','claimable')`,
    [rewardBatchId, reason],
  );
  await db.query(`update public.reward_batch_items set status='cancelled' where batch_id=$1::uuid and status in ('approved','claimable')`, [rewardBatchId]);
  await db.query(
    `update public.reward_batches set status='archived',metadata=coalesce(metadata,'{}'::jsonb)||$2::jsonb,updated_at=now() where id=$1::uuid`,
    [rewardBatchId, JSON.stringify({ archivedReason: reason })],
  );
}

// ------------------------------------------------------------------------------------ holder snapshot

/** Wallets the weekly airdrop refuses for security reasons (risk profile or cluster restricted / high / critical). */
export async function riskExcludedWallets(db: Queryable): Promise<Set<string>> {
  try {
    const { rows } = await db.query(
      `select lower(w.wallet_address) wallet
         from public.wallet_risk_profiles w left join public.wallet_clusters c on c.cluster_id=w.cluster_id
        where w.restricted or lower(coalesce(w.risk_level,'low')) in ('high','critical')
           or coalesce(c.restricted,false) or lower(coalesce(c.risk_level,'low')) in ('high','critical')`,
    );
    return new Set(rows.map((r: any) => String(r.wallet)));
  } catch {
    return new Set();
  }
}

/**
 * Holders of one coin: the census at the snapshot block, minus the creator, the coin's own contracts, the vault,
 * the operator, DEAD / zero, configured and risk-excluded wallets, and any address with contract code.
 */
export async function holderSnapshot(input: {
  chain: ChoiceChain;
  census: Census;
  coin: PlatformCoin;
  atBlock: number;
  excluded: Set<string>;
}): Promise<Array<{ wallet: string; amount: bigint }>> {
  const raw = await input.census({ campaign: input.coin.campaign, token: input.coin.token!, createdBlock: input.coin.createdBlock, atBlock: input.atBlock });
  const skip = new Set([...input.excluded, DEAD, lc(ethers.ZeroAddress), input.coin.campaign, lc(input.chain.vault)]);
  if (input.coin.creator) skip.add(input.coin.creator);
  if (input.coin.token) skip.add(input.coin.token);
  if (input.coin.pool) skip.add(input.coin.pool);
  const byWallet = new Map<string, bigint>();
  for (const r of raw) {
    const w = lc(r.wallet);
    if (r.amount <= 0n || skip.has(w)) continue;
    byWallet.set(w, (byWallet.get(w) || 0n) + r.amount);
  }
  const wallets = [...byWallet.keys()];
  const contract = new Set<string>();
  for (let i = 0; i < wallets.length; i += 8) {
    const slice = wallets.slice(i, i + 8);
    const flags = await Promise.all(slice.map((w) => input.chain.isContract(w)));
    slice.forEach((w, j) => flags[j] && contract.add(w));
  }
  return [...byWallet.entries()].filter(([w]) => !contract.has(w)).map(([wallet, amount]) => ({ wallet, amount }));
}

export async function takeDueSnapshots(input: {
  db: Queryable;
  chainId: number;
  chain: ChoiceChain;
  census: Census;
  coins: PlatformCoin[];
  cfg: ChoiceConfig;
  operator: string;
  now: Date;
  send: boolean;
}): Promise<StepReport[]> {
  const week = weekOf(input.now);
  const due = snapshotMoment(weekSecret(input.cfg.masterSecret, input.chainId, week.weekId), input.chainId, week.start);
  if (input.now.getTime() < due.getTime()) return [];
  const out: StepReport[] = [];
  let excluded: Set<string> | null = null;
  let taken = 0;
  for (const coin of input.coins.filter((c) => c.choice === CHOICE.holders || c.choice === CHOICE.split)) {
    if (taken >= input.cfg.maxSnapshotsPerPass) break;
    const done = await input.db.query(
      `select 1 from public.evm_holder_snapshot_runs where chain_id = $1 and week_id = $2 and campaign_address = $3`,
      [input.chainId, week.weekId, coin.campaign],
    );
    if ((done.rowCount ?? done.rows.length) > 0) continue;
    if (!coin.token) {
      out.push({ kind: "snapshot", subject: coin.campaign, decision: "skip", reason: "token address unknown" });
      continue;
    }
    excluded ??= new Set([...input.cfg.excluded, lc(input.operator), ...(await riskExcludedWallets(input.db))]);
    const block = await input.chain.latestBlock();
    const holders = await holderSnapshot({ chain: input.chain, census: input.census, coin, atBlock: block.number, excluded });
    await withTx(input.db, async (tx) => {
      for (const h of holders) {
        await tx.query(
          `insert into public.evm_holder_snapshots (chain_id, week_id, campaign_address, wallet, amount) values ($1,$2,$3,$4,$5)
           on conflict (chain_id, week_id, campaign_address, wallet) do nothing`,
          [input.chainId, week.weekId, coin.campaign, h.wallet, h.amount.toString()],
        );
      }
      await tx.query(
        `insert into public.evm_holder_snapshot_runs (chain_id, week_id, campaign_address, token_address, block_number, holders)
         values ($1,$2,$3,$4,$5,$6) on conflict (chain_id, week_id, campaign_address) do nothing`,
        [input.chainId, week.weekId, coin.campaign, coin.token, block.number, holders.length],
      );
    });
    taken += 1;
    out.push({ kind: "snapshot", subject: coin.campaign, decision: "sent", reason: `${holders.length} holders at block ${block.number}` });
  }
  return out;
}

// ------------------------------------------------------------------------------------ holder batch

/** Native already proposed by us in the vault's current week (vetoed batches of that week free their share). */
async function proposedInVaultWeek(db: Queryable, chainId: number, vault: string, blockTime: bigint): Promise<bigint> {
  const start = Number(vaultWeek(blockTime) * 604_800n);
  const { rows } = await db.query(
    `select coalesce(sum(j.amount_raw), 0)::text as total
       from public.evm_creator_choice_jobs j
       left join public.evm_holder_batches b on b.chain_id = j.chain_id and b.batch_id = j.subject
      where j.chain_id = $1 and j.vault_address = $2 and j.action = 'propose_holder_batch' and j.status in ('sending', 'confirmed')
        and j.chain_time >= $3 and coalesce(b.status, '') <> 'vetoed'`,
    [chainId, lc(vault), start],
  );
  return BigInt(String(rows[0]?.total ?? "0"));
}

async function buildWeekBatch(input: {
  db: Queryable;
  chainId: number;
  chain: ChoiceChain;
  coins: PlatformCoin[];
  cfg: ChoiceConfig;
  weekId: string;
  limits: VaultLimits;
  holderDistributor: string;
  holderBatchDelay: bigint;
  blockTime: bigint;
  program: string;
}): Promise<{ file: LeafFile | null; reason: string }> {
  const pots = new Map<string, bigint>();
  const runs = new Map<string, { token: string; block: number; holders: number }>();
  for (const coin of input.coins.filter((c) => c.choice === CHOICE.holders || c.choice === CHOICE.split)) {
    const run = (await input.db.query(
      `select token_address, block_number, holders from public.evm_holder_snapshot_runs where chain_id = $1 and week_id = $2 and campaign_address = $3`,
      [input.chainId, input.weekId, coin.campaign],
    )).rows[0];
    if (!run || Number(run.holders) === 0) continue; // no snapshot this week (launched after it): rolls over
    const cfg = await input.chain.cfg(coin.campaign);
    if (cfg.choice !== CHOICE.holders && cfg.choice !== CHOICE.split) continue;
    const bal = (await input.chain.balances(coin.campaign)).holder;
    if (bal <= 0n) continue;
    pots.set(coin.campaign, bal);
    runs.set(coin.campaign, { token: String(run.token_address), block: Number(run.block_number), holders: Number(run.holders) });
  }
  if (!pots.size) return { file: null, reason: "no holder balance with a snapshot this week" };
  // At most 200 campaigns per batch (MAX_BATCH_CAMPAIGNS): the largest pots first, the rest roll over.
  const top = new Map([...pots.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : a[0].localeCompare(b[0]))).slice(0, 200));
  let room = input.limits.holderBatchPerWeek - (await proposedInVaultWeek(input.db, input.chainId, input.chain.vault, input.blockTime));
  if (input.cfg.holderBatchMaxWei != null && input.cfg.holderBatchMaxWei < room) room = input.cfg.holderBatchMaxWei;
  if (room <= 0n) return { file: null, reason: "the vault's weekly holder cap is used up" };
  const fitted = fitPotsToRoom(top, room);
  const perCoin = new Map<string, Map<string, bigint>>();
  for (const [campaign, pot] of fitted) {
    const snap = await input.db.query(
      `select wallet, amount::text as amount from public.evm_holder_snapshots where chain_id = $1 and week_id = $2 and campaign_address = $3`,
      [input.chainId, input.weekId, campaign],
    );
    const balances = snap.rows.map((r: any) => ({ owner: lc(String(r.wallet)), amount: BigInt(String(r.amount)) }));
    perCoin.set(campaign, allocateToHolders(pot, balances));
  }
  const claimDeadline = Number(input.blockTime + input.holderBatchDelay) + input.cfg.claimWindowDays * 86_400;
  const file = buildLeafFile({
    chainId: input.chainId,
    vault: input.chain.vault,
    holderDistributor: input.holderDistributor,
    weekId: input.weekId,
    claimDeadline,
    weekCommitment: weekCommitment(weekSecret(input.cfg.masterSecret, input.chainId, input.weekId)),
    perCoin,
    minPayout: input.cfg.minPayoutWei,
    snapshots: [...fitted.entries()].map(([campaign, pot]) => ({ campaign, pot, ...runs.get(campaign)! })),
    program: input.program,
  });
  return { file, reason: file ? "built" : "every holder is below the minimum payout" };
}

function proposeCall(file: LeafFile): VaultCall {
  return {
    action: "propose_holder_batch",
    fn: "proposeHolderBatch",
    args: [file.batchId, file.root, BigInt(file.claimDeadline), file.campaigns.map((c) => c.campaign), file.campaigns.map((c) => BigInt(c.amount))],
  };
}

async function holderBatchCandidates(input: {
  db: Queryable;
  chainId: number;
  chain: ChoiceChain;
  coins: PlatformCoin[];
  cfg: ChoiceConfig;
  now: Date;
  send: boolean;
  limits: VaultLimits;
  holderDistributor: string;
  holderBatchDelay: bigint;
  blockTime: bigint;
  program: string;
}): Promise<{ reports: StepReport[]; candidates: Candidate[] }> {
  const reports: StepReport[] = [];
  const candidates: Candidate[] = [];
  const { db, chainId, chain } = input;

  // Build the week just finished, once the new week is five minutes old.
  if (weeklyRunDue(input.now)) {
    const week = previousWeek(input.now);
    // One batch per vault and week (a chain can have the gen-6 and the gen-7 vault).
    const row = (await db.query(`select * from public.evm_holder_batches where chain_id = $1 and week_id = $2 and vault_address = $3`, [chainId, week.weekId, lc(chain.vault)])).rows[0];
    const rebuild = row && row.status === "failed" && Number(row.attempt) < 3;
    if (!row || rebuild) {
      const built = await buildWeekBatch({ ...input, weekId: week.weekId });
      if (!input.send) {
        reports.push({ kind: "holders", subject: week.weekId, decision: "dry-run", reason: built.file ? `would publish and propose ${built.file.total} wei to ${built.file.leaves.length} holders (root ${built.file.root})` : built.reason });
      } else if (!built.file) {
        // Insert or update by (chain, vault, week) without an ON CONFLICT target, so it runs the same before and
        // after migration 20261008_000040 moves the primary key to (chain_id, vault_address, week_id).
        if (row) {
          await db.query(
            `update public.evm_holder_batches set status = 'empty', last_reason = $4, updated_at = now()
              where chain_id = $1 and week_id = $2 and vault_address = $3`,
            [chainId, week.weekId, lc(chain.vault), built.reason],
          );
        } else {
          await db.query(
            `insert into public.evm_holder_batches (chain_id, week_id, vault_address, batch_id, status, last_reason)
             values ($1,$2,$3,$4,'empty',$5)`,
            [chainId, week.weekId, lc(chain.vault), holderBatchId(chainId, week.weekId, input.program), built.reason],
          );
        }
        reports.push({ kind: "holders", subject: week.weekId, decision: "skip", reason: built.reason });
      } else {
        // Published before anything is sent: the leaf file is what the Safe signers check.
        const f = built.file;
        if (row) {
          await db.query(
            `update public.evm_holder_batches set root = $4, total_raw = $5, claim_deadline = $6, leaf_file = $7::jsonb, status = 'built',
                    reward_batch_id = null, last_reason = null, updated_at = now()
              where chain_id = $1 and week_id = $2 and vault_address = $3`,
            [chainId, week.weekId, lc(chain.vault), f.root, f.total, f.claimDeadline, JSON.stringify(f)],
          );
        } else {
          await db.query(
            `insert into public.evm_holder_batches (chain_id, week_id, vault_address, batch_id, root, total_raw, claim_deadline, leaf_file, status)
             values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'built')`,
            [chainId, week.weekId, lc(chain.vault), f.batchId, f.root, f.total, f.claimDeadline, JSON.stringify(f)],
          );
        }
        if (input.cfg.publishRewardBatches) {
          const rewardBatchId = await publishRewardBatch(db, f);
          await db.query(`update public.evm_holder_batches set reward_batch_id = $3 where chain_id = $1 and week_id = $2 and vault_address = $4`, [chainId, week.weekId, rewardBatchId, lc(chain.vault)]);
        }
        reports.push({ kind: "holders", subject: week.weekId, decision: "sent", reason: `published ${f.total} wei to ${f.leaves.length} holders, root ${f.root}` });
      }
    }
  }

  const open = await db.query(
    `select * from public.evm_holder_batches where chain_id = $1 and vault_address = $2 and status in ('built', 'proposed') order by week_id`,
    [chainId, lc(chain.vault)],
  );
  for (const batch of open.rows) {
    const subject = String(batch.batch_id);
    if (batch.status === "built") {
      if (input.send && input.cfg.publishRewardBatches && !batch.reward_batch_id) {
        // Published before it is proposed, also when an earlier pass stopped between the two.
        const rewardBatchId = await publishRewardBatch(db, batch.leaf_file as LeafFile);
        await db.query(`update public.evm_holder_batches set reward_batch_id = $3 where chain_id = $1 and week_id = $2 and vault_address = $4`, [chainId, batch.week_id, rewardBatchId, lc(chain.vault)]);
        batch.reward_batch_id = rewardBatchId;
      }
      const call = proposeCall(batch.leaf_file as LeafFile);
      const sim = await chain.simulate(call);
      if (!sim.ok) {
        // The vault refused the content (cap, balances): fail, rebuild on a later pass (up to 3 attempts).
        await setBatch(db, chainId, chain.vault, batch.week_id, "failed", `propose refused: ${sim.revert}`);
        await archiveRewardBatch(db, batch.reward_batch_id, `propose refused: ${sim.revert}`);
        reports.push({ kind: "holders", subject, decision: "blocked", action: "propose_holder_batch", reason: sim.revert });
        continue;
      }
      candidates.push({
        report: { kind: "holders", subject, decision: "send", action: "propose_holder_batch", reason: `propose ${batch.total_raw} wei` },
        call, momentKey: `week:${batch.week_id}:${batch.attempt}`, intervalKey: null, amount: BigInt(String(batch.total_raw)), gas: sim.gas,
        onRecorded: async () => {
          await db.query(`update public.evm_holder_batches set status = 'proposing', updated_at = now() where chain_id = $1 and week_id = $2 and vault_address = $3`, [chainId, batch.week_id, lc(chain.vault)]);
        },
      });
      continue;
    }
    // proposed: waiting for the Safe (approveHolderBatch + authorizeBatch) and the veto window.
    const call: VaultCall = { action: "execute_holder_batch", fn: "executeHolderBatch", args: [subject] };
    const sim = await chain.simulate(call);
    if (sim.ok) {
      candidates.push({
        report: { kind: "holders", subject, decision: "send", action: "execute_holder_batch", reason: "approved by the Safe, veto window over" },
        call, momentKey: `week:${batch.week_id}`, intervalKey: null, amount: BigInt(String(batch.total_raw)), gas: sim.gas,
        onRecorded: async () => {
          await db.query(`update public.evm_holder_batches set status = 'executing', updated_at = now() where chain_id = $1 and week_id = $2 and vault_address = $3`, [chainId, batch.week_id, lc(chain.vault)]);
        },
      });
      continue;
    }
    const waitReasons: Record<string, string> = {
      NotApproved: "waiting for the Safe to approve this root and total",
      TooSoon: "approved; waiting for the 24 h veto window",
      BatchNotAuthorized: "waiting for the Safe to authorize the batch on the holder distributor",
      BatchTooEarly: "the distributor authorization opens later",
    };
    if (waitReasons[sim.revert]) {
      if (batch.last_reason !== waitReasons[sim.revert] && input.send) await db.query(`update public.evm_holder_batches set last_reason = $3 where chain_id = $1 and week_id = $2 and vault_address = $4`, [chainId, batch.week_id, waitReasons[sim.revert], lc(chain.vault)]);
      reports.push({ kind: "holders", subject, decision: "wait", reason: waitReasons[sim.revert] });
    } else if (sim.revert === "BadBatch") {
      // Status on chain is no longer "proposed" and we never executed it: the Safe vetoed it.
      if (input.send) {
        await setBatch(db, chainId, chain.vault, batch.week_id, "vetoed", "vetoed by the Safe; the amounts are back in the coins' holder balances");
        await archiveRewardBatch(db, batch.reward_batch_id, "holder batch vetoed by the Safe");
      }
      reports.push({ kind: "holders", subject, decision: "skip", reason: "vetoed by the Safe" });
    } else {
      reports.push({ kind: "holders", subject, decision: "blocked", action: "execute_holder_batch", reason: sim.revert });
    }
  }
  return { reports, candidates };
}

// ------------------------------------------------------------------------------------ flush + sync

async function flushAndSyncCandidates(input: { db: Queryable; chainId: number; chain: ChoiceChain; coins: PlatformCoin[]; cfg: ChoiceConfig; blockTime: bigint }) {
  const reports: StepReport[] = [];
  const candidates: Candidate[] = [];
  for (const coin of input.coins) {
    if (coin.choice === CHOICE.buyback) {
      const bal = await input.chain.balances(coin.campaign);
      if (bal.heldTokens > 0n && coin.token && (await input.chain.tradingEnabled(coin.token))) {
        const call: VaultCall = { action: "flush", fn: "flushBuybackTokens", args: [ethers.getAddress(coin.campaign)] };
        const sim = await input.chain.simulate(call);
        if (sim.ok) {
          candidates.push({ report: { kind: "flush", subject: coin.campaign, decision: "send", action: "flush", reason: `${bal.heldTokens} held buyback tokens to DEAD` }, call, momentKey: `block:${input.blockTime}`, intervalKey: null, amount: bal.heldTokens, gas: sim.gas });
        } else {
          reports.push({ kind: "flush", subject: coin.campaign, decision: "blocked", action: "flush", reason: sim.revert });
        }
      }
    }
    if (coin.stage !== "graduated" || !coin.pool) continue;
    const cfg = await input.chain.cfg(coin.campaign);
    const bind = cfg.pool == null;
    if (!bind) {
      const last = await lastConfirmedAt(input.db, input.chainId, "subject", coin.pool, ["sync_lp"]);
      const harvested = await input.db.query(
        `select 1 from public.evm_campaign_events
          where chain_id = $1 and contract_kind = 'lp_locker' and event_name = 'FeesHarvested' and args->>'pool' = $2
            and coalesce((args->>'creatorPaid')::numeric, 0) > 0 and ($3::bigint is null or block_time > to_timestamp($3))
          limit 1`,
        [input.chainId, coin.pool, last],
      );
      const periodic = last == null || Number(input.blockTime) - last >= input.cfg.syncEverySeconds;
      if (!harvested.rows.length && !periodic) continue;
    }
    const call: VaultCall = { action: "sync_lp", fn: "syncLpFees", args: [ethers.getAddress(coin.pool)] };
    const sim = await input.chain.simulate(call);
    if (!sim.ok) {
      reports.push({ kind: "sync", subject: coin.pool, decision: "blocked", action: "sync_lp", reason: sim.revert });
      continue;
    }
    const delta = BigInt(sim.returnData.length >= 66 ? sim.returnData.slice(0, 66) : "0x0");
    if (!bind && delta === 0n) continue;
    candidates.push({
      report: { kind: "sync", subject: coin.pool, decision: "send", action: "sync_lp", reason: bind ? `binds the pool (delta ${delta})` : `delta ${delta}` },
      call, momentKey: `block:${input.blockTime}`, intervalKey: null, amount: delta, gas: sim.gas,
    });
  }
  return { reports, candidates };
}

// ------------------------------------------------------------------------------------ buyback + conversions

const BUY_ACTIONS: ChoiceAction[] = ["buyback_curve", "buyback_pool", "convert_buyback_quote"];
const NATIVE_CAP_ACTIONS: ChoiceAction[] = ["buyback_curve", "buyback_pool", "convert_buyback_quote"];

/** The vault's weekly buyback counter for the coin, zero when our last buy of it was in an earlier vault week. */
async function spentThisVaultWeek(db: Queryable, chainId: number, campaign: string, counter: bigint, blockTime: bigint): Promise<bigint> {
  const last = await lastConfirmedAt(db, chainId, "subject", campaign, NATIVE_CAP_ACTIONS);
  if (last == null) return 0n;
  return vaultWeek(last) === vaultWeek(blockTime) ? counter : 0n;
}

async function intervalOpen(db: Queryable, chainId: number, key: string, limits: VaultLimits, blockTime: bigint, vault: string): Promise<boolean> {
  const last = await lastConfirmedAt(db, chainId, "interval_key", key, [...BUY_ACTIONS, "convert_holder_quote"], vault);
  return last == null || BigInt(last) + limits.buyInterval <= blockTime;
}

async function curveBuybackCandidate(input: {
  chainId: number;
  chain: ChoiceChain;
  cfg: ChoiceConfig;
  coin: PlatformCoin;
  budget: bigint;
  limits: VaultLimits;
  send: boolean;
  api: BuybackAuthClient | null;
  momentKey: string;
}): Promise<{ report: StepReport; candidate?: Candidate }> {
  const { chain, coin } = input;
  const subject = coin.campaign;
  const curve = await chain.curve(coin.campaign);
  let budget = input.budget;
  const room = curveRoom(curve.netRaised, curve.nativeTarget);
  if (budget > room) budget = room;
  const target = (Number(input.limits.impactBps) * input.cfg.impactMarginBps) / 10_000;
  const estimate = async (amount: bigint) => {
    const q = await chain.quoteBuy(coin.campaign, amount);
    if (q.totalCost === 0n || q.fee * 10_000n > q.totalCost * 200n) return null; // anti-sniper window still on
    // Gen-7 coins sit on a constant-product curve; the linear midpoint estimate would understate the
    // impact there (the vault's on-chain check still decides). Gen-6 keeps the linear estimate.
    const after = isEvmGen7CampaignGeneration(coin.campaignGeneration)
      ? gen7CurvePriceAfter(curve.currentPrice, q.totalCost - q.fee, q.tokensOut)
      : linearCurvePriceAfter(curve.currentPrice, q.totalCost - q.fee, q.tokensOut);
    return impactBps(curve.currentPrice, after);
  };
  let amount = await sizeWithinImpact(budget, input.cfg.minSpendWei, target, estimate);
  if (amount == null) return { report: { kind: "buyback", subject, decision: "skip", action: "buyback_curve", reason: `nothing to buy within the caps (budget ${budget}, curve room ${room})` } };
  if (!input.send || !input.api) return { report: { kind: "buyback", subject, decision: "dry-run", action: "buyback_curve", reason: `would buy ${amount} wei on the curve at moment ${input.momentKey}` } };
  let lastRevert = "";
  for (let attempt = 0; attempt < 4 && amount >= input.cfg.minSpendWei; attempt += 1) {
    const q = await chain.quoteBuy(coin.campaign, amount);
    const minOut = (q.tokensOut * BigInt(10_000 - input.cfg.slippageBps)) / 10_000n;
    const auth = await input.api({ chainId: input.chainId, campaign: ethers.getAddress(coin.campaign), vault: chain.vault, amountIn: amount, minOut });
    const call: VaultCall = { action: "buyback_curve", fn: "buybackCurve", args: [ethers.getAddress(coin.campaign), amount, minOut, auth.deadline, auth.signature] };
    const sim = await chain.simulate(call);
    if (sim.ok) {
      return {
        report: { kind: "buyback", subject, decision: "send", action: "buyback_curve", reason: `curve buy ${amount} wei, min ${minOut} tokens` },
        candidate: { report: { kind: "buyback", subject, decision: "send", action: "buyback_curve", reason: `curve buy ${amount} wei` }, call, momentKey: input.momentKey, intervalKey: coin.campaign, amount, gas: sim.gas },
      };
    }
    lastRevert = sim.revert;
    if (sim.revert !== "ImpactTooHigh") break;
    amount /= 2n;
  }
  return { report: { kind: "buyback", subject, decision: "blocked", action: "buyback_curve", reason: lastRevert || "below the minimum after halving" } };
}

async function buybackCandidates(input: {
  db: Queryable;
  chainId: number;
  chain: ChoiceChain;
  coins: PlatformCoin[];
  cfg: ChoiceConfig;
  now: Date;
  send: boolean;
  limits: VaultLimits;
  blockTime: bigint;
  api: BuybackAuthClient | null;
}) {
  const reports: StepReport[] = [];
  const candidates: Candidate[] = [];
  for (const coin of input.coins.filter((c) => c.choice === CHOICE.buyback)) {
    const used = await liveMomentKeys(input.db, input.chainId, coin.campaign, BUY_ACTIONS);
    const momentKey = dueMomentKey({ masterSecret: input.cfg.masterSecret, chainId: input.chainId, campaign: coin.campaign, now: input.now, perDay: input.cfg.perDay, used });
    if (!momentKey) continue;
    const cfg = await input.chain.cfg(coin.campaign);
    if (cfg.choice !== CHOICE.buyback) {
      reports.push({ kind: "buyback", subject: coin.campaign, decision: "skip", reason: `vault choice is ${cfg.choice}, not buyback` });
      continue;
    }
    if (!(await intervalOpen(input.db, input.chainId, coin.campaign, input.limits, input.blockTime, input.chain.vault))) {
      reports.push({ kind: "buyback", subject: coin.campaign, decision: "wait", reason: "the vault's minimum interval since the last buyback" });
      continue;
    }
    const bal = await input.chain.balances(coin.campaign);
    const spent = await spentThisVaultWeek(input.db, input.chainId, coin.campaign, bal.spentInWeek, input.blockTime);
    const budget = buybackBudget({ balance: bal.buyback, limits: input.limits, spentThisWeek: spent });
    const curve = await input.chain.curve(coin.campaign);
    if (!curve.launched) {
      if (curve.graduationPending) {
        reports.push({ kind: "buyback", subject: coin.campaign, decision: "skip", reason: "graduation pending" });
        continue;
      }
      const r = await curveBuybackCandidate({ chainId: input.chainId, chain: input.chain, cfg: input.cfg, coin, budget, limits: input.limits, send: input.send, api: input.api, momentKey });
      reports.push(r.report);
      if (r.candidate) candidates.push(r.candidate);
      continue;
    }
    if (!cfg.pool) {
      reports.push({ kind: "buyback", subject: coin.campaign, decision: "wait", reason: "graduated; the pool binds with the first syncLpFees" });
      continue;
    }
    let call: VaultCall | null = null;
    let amount = 0n;
    let intervalKey: string | null = coin.campaign;
    if (!cfg.quote) {
      if (budget >= input.cfg.minSpendWei) {
        amount = budget;
        call = { action: "buyback_pool", fn: "buybackPool", args: [ethers.getAddress(coin.campaign), budget] };
      }
    } else if (bal.buybackQuote > 0n) {
      amount = bal.buybackQuote;
      call = { action: "buyback_pool", fn: "buybackPool", args: [ethers.getAddress(coin.campaign), bal.buybackQuote] };
    } else if (budget >= input.cfg.minSpendWei) {
      const route = await input.chain.quoteRoutePool(cfg.quote);
      if (!route) {
        reports.push({ kind: "buyback", subject: coin.campaign, decision: "blocked", reason: "no quote route pool set by the Safe (setQuoteRoute)" });
        continue;
      }
      if (!(await intervalOpen(input.db, input.chainId, lc(route), input.limits, input.blockTime, input.chain.vault))) {
        reports.push({ kind: "buyback", subject: coin.campaign, decision: "wait", reason: "the route pool's minimum interval" });
        continue;
      }
      amount = budget;
      intervalKey = lc(route);
      call = { action: "convert_buyback_quote", fn: "convertBuybackNativeToQuote", args: [ethers.getAddress(coin.campaign), budget] };
    }
    if (!call) {
      reports.push({ kind: "buyback", subject: coin.campaign, decision: "skip", reason: `nothing to spend (native budget ${budget})` });
      continue;
    }
    const sim = await input.chain.simulate(call);
    if (!sim.ok) {
      reports.push({ kind: "buyback", subject: coin.campaign, decision: sim.revert === "NothingSwapped" || sim.revert === "TooSoon" ? "wait" : "blocked", action: call.action, reason: sim.revert });
      continue;
    }
    candidates.push({ report: { kind: "buyback", subject: coin.campaign, decision: "send", action: call.action, reason: `${call.fn} ${amount}` }, call, momentKey, intervalKey, amount, gas: sim.gas });
  }
  return { reports, candidates };
}

async function conversionCandidates(input: { db: Queryable; chainId: number; chain: ChoiceChain; coins: PlatformCoin[]; cfg: ChoiceConfig; now: Date; limits: VaultLimits; blockTime: bigint }) {
  const reports: StepReport[] = [];
  const candidates: Candidate[] = [];
  for (const coin of input.coins.filter((c) => (c.choice === CHOICE.holders || c.choice === CHOICE.split) && c.stage === "graduated")) {
    const used = await liveMomentKeys(input.db, input.chainId, coin.campaign, ["convert_holder_quote"]);
    const momentKey = dueMomentKey({ masterSecret: input.cfg.masterSecret, chainId: input.chainId, campaign: coin.campaign, now: input.now, perDay: input.cfg.perDay, kind: "convert", used });
    if (!momentKey) continue;
    const cfg = await input.chain.cfg(coin.campaign);
    if (!cfg.quote) continue;
    const bal = await input.chain.balances(coin.campaign);
    if (bal.holderQuote <= 0n) continue;
    const route = await input.chain.quoteRoutePool(cfg.quote);
    if (!route) {
      reports.push({ kind: "convert", subject: coin.campaign, decision: "blocked", reason: "no quote route pool set by the Safe (setQuoteRoute)" });
      continue;
    }
    if (!(await intervalOpen(input.db, input.chainId, lc(route), input.limits, input.blockTime, input.chain.vault))) {
      reports.push({ kind: "convert", subject: coin.campaign, decision: "wait", reason: "the route pool's minimum interval" });
      continue;
    }
    const call: VaultCall = { action: "convert_holder_quote", fn: "convertHolderQuote", args: [ethers.getAddress(coin.campaign), bal.holderQuote] };
    const sim = await input.chain.simulate(call);
    if (!sim.ok) {
      reports.push({ kind: "convert", subject: coin.campaign, decision: "wait", action: call.action, reason: sim.revert });
      continue;
    }
    candidates.push({ report: { kind: "convert", subject: coin.campaign, decision: "send", action: call.action, reason: `convert ${bal.holderQuote} quote for holders` }, call, momentKey, intervalKey: lc(route), amount: bal.holderQuote, gas: sim.gas });
  }
  return { reports, candidates };
}

// ------------------------------------------------------------------------------------ the pass

export async function runEvmCreatorChoicePass(input: {
  db: Queryable;
  chainId: number;
  chain: ChoiceChain;
  sender: ChoiceSender;
  cfg: ChoiceConfig;
  send: boolean;
  census: Census;
  api: BuybackAuthClient | null;
  now?: Date;
  coins?: PlatformCoin[];
  /**
   * The vault's holder program: "airdrop_holders" (gen-6, default) or "airdrop_holders_gen7" (gen-7's own vault). The
   * holder batch id and the Claim Center batch are derived from it, so two vaults never collide.
   */
  program?: string;
  /** The other vaults this operator key signs for on the chain, to resolve their in-flight jobs (shared nonce). */
  chainFor?: (vault: string) => ChoiceChain | null;
}): Promise<PassReport> {
  const { db, chainId, chain, sender, cfg } = input;
  const program = input.program ?? DEFAULT_HOLDER_PROGRAM;
  const now = input.now ?? new Date();
  const steps: StepReport[] = [];
  const info = await chain.vaultInfo();
  // A factory without the getter (or a failed read) cannot be checked here; the API still signs only as the
  // factory's route authority, so this refusal is a second line, not the only one.
  const authority = await chain.routeAuthority(info.factory).catch(() => null);
  if (authority && lc(authority) === lc(sender.address)) {
    throw new Error("the operator key is the route authority: refused (the route authority key never runs on the indexer)");
  }
  const operatorOk = lc(info.operator) === lc(sender.address) && !info.limits.paused;
  const send = input.send && operatorOk;
  if (input.send && !operatorOk) {
    steps.push({ kind: "resolve", subject: chain.vault, decision: "blocked", reason: info.limits.paused ? "the Safe paused the operator" : `vault operator is ${info.operator}, not ${sender.address}` });
  }

  await ensureWeekSecrets(db, chainId, cfg.masterSecret, now);
  const resolved = await resolveSendingJobs({ db, chainId, chain, sender, send, chainFor: input.chainFor });
  const inFlight = resolved.waiting > 0;
  if (resolved.confirmed || resolved.reverted || resolved.dropped) {
    steps.push({ kind: "resolve", subject: chain.vault, decision: "sent", reason: JSON.stringify(resolved) });
  }
  const block = await chain.latestBlock();
  const coins = input.coins ?? (await listPlatformCoins(db, chainId, chain.vault));

  steps.push(...(await takeDueSnapshots({ db, chainId, chain, census: input.census, coins, cfg, operator: sender.address, now, send })));

  const holders = await holderBatchCandidates({
    db, chainId, chain, coins, cfg, now, send, limits: info.limits, holderDistributor: info.holderDistributor,
    holderBatchDelay: info.holderBatchDelay, blockTime: block.timestamp, program,
  });
  const fs = await flushAndSyncCandidates({ db, chainId, chain, coins, cfg, blockTime: block.timestamp });
  const buys = await buybackCandidates({ db, chainId, chain, coins, cfg, now, send, limits: info.limits, blockTime: block.timestamp, api: input.api });
  const convs = await conversionCandidates({ db, chainId, chain, coins, cfg, now, limits: info.limits, blockTime: block.timestamp });
  steps.push(...holders.reports, ...fs.reports, ...buys.reports.filter((r) => r.decision !== "send"), ...convs.reports);

  const ordered = [...holders.candidates, ...fs.candidates, ...buys.candidates, ...convs.candidates];
  let sent = false;
  for (const c of ordered) {
    if (!send) {
      steps.push({ ...c.report, decision: "dry-run" });
      continue;
    }
    if (inFlight || sent) {
      steps.push({ ...c.report, decision: "queued", reason: `${c.report.reason ?? ""}; one transaction in flight per chain` });
      continue;
    }
    if (c.gas > cfg.maxGas) {
      steps.push({ ...c.report, decision: "blocked", reason: `gas ${c.gas} above the cap ${cfg.maxGas}` });
      continue;
    }
    // Record, then send.
    const gasLimit = (c.gas * 12n) / 10n + 25_000n;
    const nonce = await sender.getNonce("pending");
    const signed = await sender.sign(c.call, gasLimit, nonce);
    const subject = c.call.action === "propose_holder_batch" || c.call.action === "execute_holder_batch" ? String(c.call.args[0]) : c.report.subject;
    const inserted = await db.query(
      `insert into public.evm_creator_choice_jobs(
          chain_id, vault_address, subject, action, moment_key, interval_key, call_args, amount_raw, operator_address,
          nonce, gas_limit, tx_hash, raw_tx, status, reason, chain_time
       ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,'sending',$14,$15)
       returning id`,
      [
        chainId, lc(chain.vault), subject, c.call.action, c.momentKey, c.intervalKey, callArgsJson(c.call),
        c.amount == null ? null : c.amount.toString(), lc(sender.address), nonce, gasLimit.toString(),
        signed.hash.toLowerCase(), signed.raw, (c.report.reason ?? "").slice(0, 500), block.timestamp.toString(),
      ],
    );
    const jobId = Number(inserted.rows[0]?.id);
    if (c.onRecorded) await c.onRecorded(jobId);
    sent = true;
    const step: StepReport = { ...c.report, decision: "sent", txHash: signed.hash };
    try {
      await sender.broadcast(signed.raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      step.error = message;
      // The job stays 'sending': the next pass decides by receipt and nonce whether it left.
      await db.query(`update public.evm_creator_choice_jobs set last_error = $2, updated_at = now() where id = $1`, [jobId, message.slice(0, 500)]);
    }
    steps.push(step);
  }
  return { chainId, send, operatorOk, inFlight, steps };
}

export type { SimResult };
