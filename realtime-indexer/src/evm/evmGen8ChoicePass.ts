/**
 * Gen-8 creator-choice operator (MwzCreatorChoiceVault on BNB 56 and Robinhood 4663): one pass per chain over the coins
 * whose creator chose holders (2), split (3) or buyback (4). Per pass, in this order:
 *
 *   1. Operator gate: the key's address must be vault.operator() and the operator not paused, else nothing is sent
 *      (critical alert); checks and week commitments are still recorded.
 *   2. Week secrets: commitment of this and next week, reveal of every finished week (evm_creator_choice_weeks, shared
 *      with gen-6/7: one secret per chain and week).
 *   3. Resolve the job left 'sending' (receipt; same raw bytes re-broadcast while the nonce is unused; 'dropped' once
 *      the nonce went elsewhere) and apply its effect on the holder batch, in one database transaction.
 *   4. Hold-through checks (evmGen8ChoiceChecks.ts): data, also in a dry run.
 *   5. Monday (weeklyRunDue, the week just finished): pull every holders / split coin above the pull minimum and wait
 *      until those pulls landed; wait for the census to pass the week end; pots = vault.holderBalance of the coins whose
 *      required checks are all present (others roll over, alert); room = maxHolderBatchPerWeek minus what the vault
 *      already counts this vault week, capped by the distributor authorization when it exists; the Gen8LeafFileV2 is
 *      STORED (evm_holder_batches) and PUBLISHED (Claim Center rows, status funding_check) before proposeHolderBatch.
 *      Then executeHolderBatch once the Safe approved the exact root / total / deadline, the distributor authorization
 *      covers it and the veto window is over; then the Claim Center rows open. A vetoed batch is archived.
 *   6. Buyback coins at their secret moments (dayMoments, at most 4 a day): pull first when the hook holds enough, then
 *      buyback(id, amountIn) within the vault's caps (simulated; CurveState halves the amount).
 *   7. Daily pull of every choice coin above the pull minimum (at most once per coin per UTC day).
 *
 * Sending: at most ONE transaction per chain in flight (evm_gen8_choice_jobs_one_in_flight_idx), under the operator
 * key's process lock (shared with the gen-8 fee-routing worker, evmGen8OperatorLock.ts). Every call is simulated from
 * the operator right before it is signed; the signed bytes, nonce and hash are written (with the batch status change,
 * in one database transaction) BEFORE the broadcast; the pass then waits for the receipt and resolves the job. A crash
 * anywhere leaves either no job (nothing was broadcast) or a 'sending' job that the next pass resolves without
 * signing anything new. Live jobs are unique per vault, subject, action and moment, so nothing is sent twice.
 * Dry run unless send is true: decisions are reported, nothing is signed, no batch is stored or published.
 */
import { ethers } from "ethers";
import { CHOICE, buybackBudget, dueMomentKey, holderBatchId, merklePlan, previousWeek, vaultWeek, weeklyRunDue, type VaultLimits } from "./evmCreatorChoice.js";
import { ensureWeekSecrets } from "./evmCreatorChoicePass.js";
import { gen8RequiredChecks, type Gen8LeafFileV2 } from "./evmGen8HoldThrough.js";
import { GEN8_HOLDER_PROGRAM, gen8ProposeArgs, planGen8HolderWeekV2, type Gen8HolderPlanV2, type Gen8PoolWeek } from "./evmGen8HolderBatch.js";
import {
  gen8CallArgsJson,
  gen8HolderRoom,
  Gen8FeeCapError,
  type Gen8ChoiceAction,
  type Gen8ChoiceChain,
  type Gen8ChoiceSender,
  type Gen8VaultCall,
  type Gen8VaultInfo,
} from "./evmGen8ChoiceChain.js";
import {
  gen8WeekMoments,
  listGen8ChoiceCoins,
  readCensusAtCursor,
  takeGen8Checks,
  type Gen8ChoiceAlert,
  type Gen8ChoiceCoin,
  type Queryable,
} from "./evmGen8ChoiceChecks.js";
import { withOperatorLock } from "./evmGen8OperatorLock.js";

export type { Queryable, Gen8ChoiceAlert, Gen8ChoiceCoin };

export const GEN8_CHOICE_ALERT_TYPE = "gen8_choice";
export const GEN8_REWARD_SOURCE = "evm_gen8_choice_operator";
const MAX_BATCH_ATTEMPTS = 3;
const MIN_CLAIM_WINDOW_SEC = 7n * 86_400n;

export type Gen8ChoiceConfig = {
  masterSecret: string;
  /** Buyback moments per coin per day: min(EVM_BUYBACK_MAX_PER_DAY, 4). */
  perDay: number;
  /** EVM_BUYBACK_MIN_WEI: smallest buyback worth a transaction. */
  buybackMinWei: bigint;
  /** EVM_HOLDER_MIN_PAYOUT_WEI: a wallet whose weekly total is below this gets nothing this week (rolls over). */
  minPayoutWei: bigint;
  /** EVM_GEN8_PULL_MIN_WEI (default: minPayoutWei): smallest hook creator ledger worth a pull. */
  pullMinWei: bigint;
  claimWindowDays: number;
  /** EVM_GEN8_HOLDER_BATCH_MAX_WEI: cap per weekly batch while the distributor authorization is not there yet. */
  holderBatchMaxWei: bigint | null;
  /** EVM_HOLDER_EXCLUDED_WALLETS (lowercase): soft exclusions, with the risk-excluded wallets. */
  excluded: Set<string>;
  /** Gas limit cap per transaction. */
  maxGas: bigint;
  /** Network fee cap (wei per gas) the sender refuses to sign above; null: none. */
  maxFeePerGasWei: bigint | null;
  /** How long after the week end the Monday build waits for a census that is behind the week end. */
  censusWaitHours: number;
  /** How long a send waits for its receipt inside the key lock before the next pass takes over. */
  receiptWaitMs: number;
  /** A 'sending' job older than this raises an alert. */
  stuckAlertMinutes: number;
};

export const DEFAULT_GEN8_CHOICE_CONFIG: Omit<Gen8ChoiceConfig, "masterSecret"> = {
  perDay: 4,
  buybackMinWei: 10n ** 15n,
  minPayoutWei: 10n ** 15n,
  pullMinWei: 10n ** 15n,
  claimWindowDays: 60,
  holderBatchMaxWei: null,
  excluded: new Set(),
  maxGas: 3_000_000n,
  maxFeePerGasWei: null,
  censusWaitHours: 6,
  receiptWaitMs: 90_000,
  stuckAlertMinutes: 20,
};

export type Gen8StepReport = {
  kind: "check" | "pull" | "holders" | "buyback" | "resolve" | "operator";
  subject: string;
  decision: "send" | "sent" | "dry-run" | "skip" | "wait" | "blocked" | "queued";
  action?: Gen8ChoiceAction;
  reason?: string;
  txHash?: string;
  error?: string;
};

export type Gen8PassReport = {
  chainId: number;
  send: boolean;
  operatorOk: boolean;
  inFlight: boolean;
  steps: Gen8StepReport[];
  /** The transaction this pass sent, if any, and whether it already has a successful receipt. */
  sent: { hash: string; action: Gen8ChoiceAction; confirmed: boolean } | null;
  /** The week's plan when the Monday build ran in this pass (dry run included): the manual Safe fallback is in it. */
  plan?: Gen8HolderPlanV2 | null;
};

type Candidate = {
  report: Gen8StepReport;
  call: Gen8VaultCall;
  subject: string;
  momentKey: string;
  amount: bigint | null;
  /** Runs in the job insert's transaction (batch status). */
  onRecorded?: (tx: Queryable) => Promise<void>;
};

const lc = (a: string) => String(a || "").toLowerCase();
const noAlert: Gen8ChoiceAlert = async () => undefined;

type PoolLike = Queryable & { connect?: () => Promise<Queryable & { release: () => void }> };

/** Runs fn in one transaction on ONE connection (a pg Pool would hand every query to any of its clients). */
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

function nativeSymbol(chainId: number) {
  return chainId === 4663 || chainId === 46630 ? "ETH" : "BNB";
}

// ------------------------------------------------------------------------------------ Claim Center rows

/**
 * Publishes the week's gen-8 holder batch as the weekly airdrop publishes its batches (same rows and claim fields as
 * gen-6/7 publishRewardBatch): one reward_batches row (program airdrop_holders_gen8, status funding_check) and one
 * reward_ledger + reward_batch_items row per leaf with its merkle proof and the holder distributor as claim contract.
 * Idempotent: an open batch of the same chain, week and program is returned as it is.
 */
export async function publishGen8RewardBatch(db: Queryable, file: Gen8LeafFileV2): Promise<string> {
  const entries = file.leaves.map((l) => ({ account: l.account, amount: BigInt(l.amount) }));
  const { leaves, proofs, root } = merklePlan(entries);
  if (lc(root) !== lc(file.root)) throw new Error(`leaf file root ${file.root} does not match its leaves (${root})`);
  return withTx(db, async (tx) => {
    const dup = await tx.query(
      `select id from public.reward_batches
        where reward_type='airdrop' and chain::text=$1 and metadata->>'epochId'=$2 and metadata->>'program'=$3
          and status<>'archived' limit 1 for update`,
      [String(file.chainId), file.weekId, file.program],
    );
    if (dup.rows[0]) return String(dup.rows[0].id);
    const metadata = {
      epochId: file.weekId,
      program: file.program,
      automated: true,
      source: GEN8_REWARD_SOURCE,
      claimMode: "reward_distributor_merkle",
      claimContract: "RewardDistributor",
      distributorAddress: file.holderDistributor,
      rewardDistributorAddress: file.holderDistributor,
      contractBatchId: file.batchId,
      merkleBatchId: file.batchId,
      merkleRoot: root,
      merkleRecipientCount: entries.length,
      merkleTotalAmount: file.total,
      merkleLeafEncoding: "keccak256(bytes.concat(keccak256(abi.encode(account, amount))))",
      merklePairSorting: "openzeppelins_commutative_hash",
      claimDeadline: file.claimDeadline,
      creatorVault: file.vault,
      holderRule: file.rule,
      holderPools: file.pools.map((p) => ({ poolId: p.poolId, token: p.token, amount: p.amount })),
    };
    const batch = (
      await tx.query(
        `insert into public.reward_batches
          (reward_type,chain,token_symbol,status,total_amount,recipient_count,claimable_count,claimed_count,failed_count,source,metadata)
         values ('airdrop',$1,$4,'funding_check',$2::numeric,$3,0,0,0,$6,$5::jsonb)
         returning id`,
        [String(file.chainId), file.total, entries.length, nativeSymbol(file.chainId), JSON.stringify(metadata), GEN8_REWARD_SOURCE],
      )
    ).rows[0];
    for (let i = 0; i < entries.length; i += 1) {
      const wallet = entries[i].account.toLowerCase();
      const meta = {
        role: "Holder", program: file.program, epochId: file.weekId, batchId: batch.id, batchIndex: i,
        claimMode: metadata.claimMode, claimContract: metadata.claimContract,
        distributorAddress: file.holderDistributor, rewardDistributorAddress: file.holderDistributor,
        contractBatchId: file.batchId, merkleBatchId: file.batchId, merkleRoot: root,
        merkleProof: proofs[i], merkleLeaf: leaves[i], claimAmount: entries[i].amount.toString(), claimDeadline: file.claimDeadline,
      };
      const ledger = (
        await tx.query(
          `insert into public.reward_ledger
            (reward_type,source_id,source_label,wallet_address,chain,token_symbol,amount,status,metadata)
           values ('airdrop',$1,$7,$2,$3,$6,$4::numeric,'approved',$5::jsonb)
           returning id`,
          [`${file.weekId}:${file.program}:${i + 1}`, wallet, String(file.chainId), entries[i].amount.toString(), JSON.stringify(meta), nativeSymbol(file.chainId), GEN8_REWARD_SOURCE],
        )
      ).rows[0];
      await tx.query(
        `insert into public.reward_batch_items (batch_id,reward_ledger_id,wallet_address,amount,status,metadata)
         values ($1,$2,$3,$4::numeric,'approved',$5::jsonb)`,
        [batch.id, ledger.id, wallet, entries[i].amount.toString(), JSON.stringify(meta)],
      );
    }
    return String(batch.id);
  });
}

/** Opens the Claim Center rows once executeHolderBatch funded the distributor. Caller's transaction. */
async function openGen8RewardBatch(tx: Queryable, rewardBatchId: string | null, txHash: string | null, block: number | null) {
  if (!rewardBatchId) return;
  const ledger = await tx.query(
    `update public.reward_ledger set status='claimable',claimable_at=coalesce(claimable_at,now()),claim_error=null,updated_at=now()
      where id in (select reward_ledger_id from public.reward_batch_items where batch_id=$1::uuid) and status='approved'
      returning id`,
    [rewardBatchId],
  );
  await tx.query(`update public.reward_batch_items set status='claimable' where batch_id=$1::uuid and status='approved'`, [rewardBatchId]);
  await tx.query(
    `update public.reward_batches set status='claim_open',claimable_count=$2,published_at=coalesce(published_at,now()),
            metadata=coalesce(metadata,'{}'::jsonb)||$3::jsonb,updated_at=now()
      where id=$1::uuid`,
    [rewardBatchId, ledger.rows.length, JSON.stringify({ onChainBatchCreated: true, onChainBatchTxHash: txHash, onChainBatchBlockNumber: block, onChainBatchVerifiedAt: new Date().toISOString() })],
  );
}

/** Cancels the Claim Center rows of a batch that will not be funded. Caller's transaction. */
async function archiveGen8RewardBatch(tx: Queryable, rewardBatchId: string | null, reason: string) {
  if (!rewardBatchId) return;
  await tx.query(
    `update public.reward_ledger set status='cancelled',claim_error=$2,updated_at=now()
      where id in (select reward_ledger_id from public.reward_batch_items where batch_id=$1::uuid) and status in ('approved','claimable')`,
    [rewardBatchId, reason],
  );
  await tx.query(`update public.reward_batch_items set status='cancelled' where batch_id=$1::uuid and status in ('approved','claimable')`, [rewardBatchId]);
  await tx.query(
    `update public.reward_batches set status='archived',metadata=coalesce(metadata,'{}'::jsonb)||$2::jsonb,updated_at=now() where id=$1::uuid`,
    [rewardBatchId, JSON.stringify({ archivedReason: reason })],
  );
}

// ------------------------------------------------------------------------------------ holder batch rows

async function batchRow(db: Queryable, chainId: number, vault: string, batchId: string, forUpdate = false) {
  const { rows } = await db.query(
    `select * from public.evm_holder_batches where chain_id = $1 and lower(vault_address) = $2 and lower(batch_id) = $3 ${forUpdate ? "for update" : ""}`,
    [chainId, lc(vault), lc(batchId)],
  );
  return rows[0] ?? null;
}

async function setBatch(db: Queryable, chainId: number, vault: string, weekId: string, status: string, reason: string | null, extra: { attempt?: number; executableAt?: bigint } = {}) {
  await db.query(
    `update public.evm_holder_batches
        set status = $3, last_reason = $4,
            attempt = case when $6::int is not null then $6::int when $3 = 'failed' then attempt + 1 else attempt end,
            executable_at = coalesce(to_timestamp($7::double precision), executable_at),
            updated_at = now()
      where chain_id = $1 and week_id = $2 and lower(vault_address) = $5`,
    [chainId, weekId, status, reason, lc(vault), extra.attempt ?? null, extra.executableAt == null ? null : Number(extra.executableAt)],
  );
}

function onChainMatchesFile(onChain: { root: string; total: bigint; claimDeadline: bigint }, batch: any): boolean {
  return lc(onChain.root) === lc(String(batch.root)) && onChain.total.toString() === String(batch.total_raw) && onChain.claimDeadline.toString() === String(batch.claim_deadline);
}

// ------------------------------------------------------------------------------------ jobs

export type Gen8ResolveResult = { confirmed: number; reverted: number; dropped: number; rebroadcast: number; waiting: number; mismatch: number };

function isBenignBroadcastError(message: string): boolean {
  return /already known|known transaction|nonce too low|replacement transaction underpriced|already imported/i.test(message);
}

/** Final status of one job and its effect on the holder batch, in ONE database transaction. */
async function finishGen8Job(input: { db: Queryable; chain: Gen8ChoiceChain; chainId: number; row: any; status: "confirmed" | "reverted" | "dropped"; block: number | null; alert: Gen8ChoiceAlert }): Promise<{ mismatch: boolean; deferred: boolean }> {
  const { db, chain, chainId, row, status, block } = input;
  const action = String(row.action) as Gen8ChoiceAction;
  const batchAction = action === "propose_holder_batch" || action === "execute_holder_batch";
  const ev = status === "confirmed" && batchAction ? await chain.receiptEvents(String(row.tx_hash)) : null;
  // A receipt the RPC cannot return yet (lagging node) is not evidence of anything: the job stays 'sending' and the
  // next pass reads it again. Never the mismatch branch (no failed status, no archive, no alert).
  if (status === "confirmed" && batchAction && ev == null) return { mismatch: false, deferred: true };
  let mismatch = false;
  await withTx(db, async (tx) => {
    await tx.query(`update public.evm_gen8_choice_jobs set status = $2, receipt_block = $3, updated_at = now() where id = $1 and status = 'sending'`, [row.id, status, block]);
    if (action !== "propose_holder_batch" && action !== "execute_holder_batch") return;
    const batch = await batchRow(tx, chainId, String(row.vault_address), String(row.subject), true);
    if (!batch) return;
    if (action === "propose_holder_batch") {
      if (status === "confirmed") {
        const p = ev?.proposed;
        if (p && lc(p.batchId) === lc(String(batch.batch_id)) && onChainMatchesFile(p, batch)) {
          await setBatch(tx, chainId, String(batch.vault_address), batch.week_id, "proposed", null, { executableAt: p.executableAt });
        } else {
          // Something other than the published file is on chain under this id: never rebuilt (the id is taken on
          // chain); the Safe vetoes it and a person looks.
          mismatch = true;
          await setBatch(tx, chainId, String(batch.vault_address), batch.week_id, "failed", "the proposal on chain does not match the published leaf file: veto it", { attempt: 1000 });
          await archiveGen8RewardBatch(tx, batch.reward_batch_id, "proposal on chain does not match the leaf file");
        }
      } else {
        await setBatch(tx, chainId, String(batch.vault_address), batch.week_id, "failed", `propose ${status}`);
        await archiveGen8RewardBatch(tx, batch.reward_batch_id, `holder batch proposal ${status}`);
      }
    } else if (status === "confirmed" && ev?.executed && lc(ev.executed.batchId) === lc(String(batch.batch_id))) {
      await setBatch(tx, chainId, String(batch.vault_address), batch.week_id, "executed", null);
      await openGen8RewardBatch(tx, batch.reward_batch_id, String(row.tx_hash), block);
    } else {
      await setBatch(tx, chainId, String(batch.vault_address), batch.week_id, "proposed", `execute ${status}`);
    }
  });
  if (mismatch) {
    await input.alert({
      severity: "critical", kind: "gen8_choice_proposal_mismatch", chainId, subject: String(row.subject),
      title: `Gen-8 holder batch on chain ${chainId} does not match its leaf file`,
      message: `proposeHolderBatch ${row.tx_hash} for ${row.subject} landed with a root, total or claim deadline other than the published file. Veto it (vetoHolderBatch) before anything else.`,
    });
  }
  return { mismatch, deferred: false };
}

/** Resolves every 'sending' job of the chain: receipt, same bytes re-broadcast while the nonce is free, or dropped. */
export async function resolveGen8Jobs(input: { db: Queryable; chainId: number; chain: Gen8ChoiceChain; sender: Gen8ChoiceSender; send: boolean; cfg: Pick<Gen8ChoiceConfig, "stuckAlertMinutes">; alert?: Gen8ChoiceAlert }): Promise<Gen8ResolveResult> {
  const out: Gen8ResolveResult = { confirmed: 0, reverted: 0, dropped: 0, rebroadcast: 0, waiting: 0, mismatch: 0 };
  const alert = input.alert ?? noAlert;
  const { rows } = await input.db.query(
    `select *, extract(epoch from (now() - created_at))::float8 as age_sec from public.evm_gen8_choice_jobs where chain_id = $1 and status = 'sending' order by id`,
    [input.chainId],
  );
  for (const row of rows) {
    let receipt = await input.sender.getReceipt(String(row.tx_hash));
    if (!receipt && lc(String(row.operator_address)) === lc(input.sender.address) && (await input.sender.getNonce("latest")) > Number(row.nonce)) {
      // Nonce used, no receipt for our hash: check once more before calling it dropped.
      receipt = await input.sender.getReceipt(String(row.tx_hash));
      if (!receipt) {
        await finishGen8Job({ db: input.db, chain: input.chain, chainId: input.chainId, row, status: "dropped", block: null, alert });
        await input.db.query(`update public.evm_gen8_choice_jobs set last_error = 'nonce used by another transaction' where id = $1`, [row.id]);
        out.dropped += 1;
        continue;
      }
    }
    if (receipt) {
      const ok = Number(receipt.status) === 1;
      const r = await finishGen8Job({ db: input.db, chain: input.chain, chainId: input.chainId, row, status: ok ? "confirmed" : "reverted", block: receipt.blockNumber, alert });
      if (r.deferred) {
        out.waiting += 1;
        continue;
      }
      if (r.mismatch) out.mismatch += 1;
      if (ok) out.confirmed += 1;
      else out.reverted += 1;
      continue;
    }
    if (input.send && row.raw_tx && lc(String(row.operator_address)) === lc(input.sender.address)) {
      try {
        await input.sender.broadcast(String(row.raw_tx));
        await input.db.query(`update public.evm_gen8_choice_jobs set attempt = attempt + 1, updated_at = now() where id = $1`, [row.id]);
        out.rebroadcast += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isBenignBroadcastError(message)) {
          await input.db.query(`update public.evm_gen8_choice_jobs set last_error = $2, updated_at = now() where id = $1`, [row.id, message.slice(0, 500)]);
        }
      }
    }
    const ageMin = Number(row.age_sec ?? 0) / 60;
    if (ageMin > input.cfg.stuckAlertMinutes) {
      await alert({
        severity: "warning", kind: "gen8_choice_tx_stuck", chainId: input.chainId, subject: String(row.tx_hash),
        title: `Gen-8 operator transaction pending for ${Math.round(ageMin)} minutes on chain ${input.chainId}`,
        message: `${row.action} ${row.subject} (nonce ${row.nonce}, ${row.tx_hash}) has no receipt. Nothing else is sent until it resolves. Check the network fee.`,
      });
    }
    out.waiting += 1;
  }
  return out;
}

async function jobExists(db: Queryable, chainId: number, vault: string, subject: string, action: Gen8ChoiceAction, momentKey: string, statuses: string[]): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from public.evm_gen8_choice_jobs
      where chain_id = $1 and vault_address = $2 and subject = $3 and action = $4 and moment_key = $5 and status = any($6::text[]) limit 1`,
    [chainId, lc(vault), subject, action, momentKey, statuses],
  );
  return rows.length > 0;
}

async function liveMomentKeys(db: Queryable, chainId: number, vault: string, subject: string, action: Gen8ChoiceAction): Promise<Set<string>> {
  const { rows } = await db.query(
    `select moment_key from public.evm_gen8_choice_jobs
      where chain_id = $1 and vault_address = $2 and subject = $3 and action = $4 and status in ('sending', 'confirmed')`,
    [chainId, lc(vault), subject, action],
  );
  return new Set(rows.map((r: any) => String(r.moment_key)));
}

// ------------------------------------------------------------------------------------ pulls

/** A pull of `coin` if the hook holds at least the pull minimum and no job ran for this moment key (any outcome). */
async function pullCandidate(input: { db: Queryable; chainId: number; chain: Gen8ChoiceChain; cfg: Gen8ChoiceConfig; coin: Gen8ChoiceCoin; momentKey: string; why: string }): Promise<{ candidate?: Candidate; report?: Gen8StepReport }> {
  const { db, chainId, chain, coin } = input;
  if (await jobExists(db, chainId, chain.vault, coin.poolId, "pull", input.momentKey, ["sending", "confirmed", "reverted"])) return {};
  const owed = await chain.creatorOwed(coin.poolId);
  if (owed < input.cfg.pullMinWei || owed === 0n) return {};
  const call: Gen8VaultCall = { action: "pull", fn: "pull", args: [coin.poolId] };
  const sim = await chain.simulate(call);
  if (!sim.ok) return { report: { kind: "pull", subject: coin.poolId, decision: "blocked", action: "pull", reason: `${input.why}: ${sim.revert}` } };
  return {
    candidate: {
      report: { kind: "pull", subject: coin.poolId, decision: "send", action: "pull", reason: `${input.why}: ${owed} wei from the hook` },
      call, subject: coin.poolId, momentKey: input.momentKey, amount: owed,
    },
  };
}

// ------------------------------------------------------------------------------------ the weekly holder batch

type WeekBuild = { plan: Gen8HolderPlanV2 | null; wait?: string; reports: Gen8StepReport[] };

async function buildGen8Week(input: {
  db: Queryable;
  chainId: number;
  chain: Gen8ChoiceChain;
  cfg: Gen8ChoiceConfig;
  coins: Gen8ChoiceCoin[];
  info: Gen8VaultInfo;
  week: { weekId: string; start: Date; end: Date };
  blockTime: bigint;
  now: Date;
  alert: Gen8ChoiceAlert;
}): Promise<WeekBuild> {
  const { db, chainId, chain, cfg, week, alert } = input;
  const reports: Gen8StepReport[] = [];
  const weekEndSec = Math.floor(week.end.getTime() / 1000);
  const moments = gen8WeekMoments(cfg.masterSecret, chainId, week);
  const censusDeadline = week.end.getTime() + cfg.censusWaitHours * 3_600_000;
  const pools: Gen8PoolWeek[] = [];
  for (const coin of input.coins.filter((c) => (c.choice === CHOICE.holders || c.choice === CHOICE.split) && c.launchedAt < weekEndSec)) {
    const required = gen8RequiredChecks(moments, coin.launchedAt);
    if (!required.length) continue; // launched after the week's last check: its pot belongs to next week
    const runs = await db.query(
      `select check_index, block_number::text as block, block_time::text as block_time, supply::text as supply, holders, soft_excluded_wallets
         from public.evm_gen8_holder_check_runs where chain_id = $1 and week_id = $2 and pool_id = $3 order by check_index`,
      [chainId, week.weekId, coin.poolId],
    );
    const present = new Map<number, any>(runs.rows.map((r: any) => [Number(r.check_index), r]));
    const missing = required.filter((i) => !present.has(i));
    if (missing.length) {
      // A check can still be taken while the census is behind the window end: wait (bounded) before rolling over.
      const snap = await readCensusAtCursor(db, chainId, coin.token);
      const censusTime = snap.lastBlock == null ? 0 : await chain.blockTime(snap.lastBlock);
      if (censusTime < weekEndSec && input.now.getTime() < censusDeadline) {
        return { plan: null, wait: `the census of ${coin.token} (block ${snap.lastBlock}) is behind the week end; checks ${missing.join(",")} may still be taken`, reports };
      }
      reports.push({ kind: "holders", subject: coin.poolId, decision: "skip", reason: `checks ${missing.join(",")} of ${week.weekId} missing: the pot rolls over` });
      await alert({
        severity: "warning", kind: "gen8_choice_checks_missing", chainId, subject: `${week.weekId}:${coin.poolId}`,
        title: `Gen-8 holder pot of ${coin.token} rolls over on chain ${chainId}`,
        message: `Week ${week.weekId}: required checks ${required.join(",")}, missing ${missing.join(",")}. The coin is left out of this week's batch; its holder balance stays in the vault for next week.`,
      });
      continue;
    }
    const state = await chain.coin(coin.poolId);
    if (state.choice !== CHOICE.holders && state.choice !== CHOICE.split) {
      reports.push({ kind: "holders", subject: coin.poolId, decision: "blocked", reason: `vault choice is ${state.choice}, not holders / split` });
      continue;
    }
    if (state.holderBalance <= 0n) continue;
    const checks: Gen8PoolWeek["checks"] = [];
    for (const i of required) {
      const r = present.get(i);
      const w = await db.query(
        `select wallet, amount::text as amount from public.evm_gen8_holder_checks where chain_id = $1 and week_id = $2 and pool_id = $3 and check_index = $4`,
        [chainId, week.weekId, coin.poolId, i],
      );
      checks.push({
        index: i, block: Number(r.block), blockTime: Number(r.block_time), supply: String(r.supply), holders: Number(r.holders),
        softExcluded: (r.soft_excluded_wallets ?? []).map((w: string) => lc(w)).sort(),
        balances: w.rows.map((x: any) => ({ owner: lc(String(x.wallet)), amount: BigInt(String(x.amount)) })),
      });
    }
    pools.push({ poolId: coin.poolId, token: coin.token, launchedAt: coin.launchedAt, pot: state.holderBalance, checks });
  }
  const room = gen8HolderRoom(input.info, input.blockTime);
  if (room == null) {
    await alert({
      severity: "critical", kind: "gen8_choice_vault_layout", chainId, subject: chain.vault,
      title: `Gen-8 choice vault storage layout check failed on chain ${chainId}`,
      message: `The raw storage of ${chain.vault} at slots 7 / 13 / 18 does not equal maxHolderBatchPerWeek / totalLiabilities / holderProposedInWeek. The weekly holder room cannot be read; no batch is built.`,
    });
    return { plan: null, wait: "the vault's holder week cannot be read (storage layout check failed)", reports };
  }
  const batchId = holderBatchId(chainId, week.weekId, GEN8_HOLDER_PROGRAM);
  const auth = await chain.batchAuthorization(input.info.holderDistributor, batchId);
  const authCap = auth.authorized && !auth.consumed ? auth.maxAmount : cfg.holderBatchMaxWei;
  const plan = planGen8HolderWeekV2({
    chainId, vault: chain.vault, holderDistributor: input.info.holderDistributor, weekId: week.weekId, nowSec: Number(input.blockTime),
    holderBatchDelaySec: Number(input.info.holderBatchDelay), claimWindowDays: cfg.claimWindowDays, minPayoutWei: cfg.minPayoutWei,
    roomWei: room, authCapWei: authCap, pools,
  });
  return { plan, reports };
}

async function holderBatchFlow(input: {
  db: Queryable;
  chainId: number;
  chain: Gen8ChoiceChain;
  cfg: Gen8ChoiceConfig;
  coins: Gen8ChoiceCoin[];
  info: Gen8VaultInfo;
  blockTime: bigint;
  now: Date;
  send: boolean;
  keyedByVault: boolean;
  inFlightSubjects: Set<string>;
  alert: Gen8ChoiceAlert;
}): Promise<{ reports: Gen8StepReport[]; candidates: Candidate[]; plan?: Gen8HolderPlanV2 | null }> {
  const { db, chainId, chain, cfg, info, alert } = input;
  const reports: Gen8StepReport[] = [];
  const candidates: Candidate[] = [];
  let planOut: Gen8HolderPlanV2 | null | undefined;
  const vault = lc(chain.vault);

  if (weeklyRunDue(input.now)) {
    const week = previousWeek(input.now);
    const batchId = holderBatchId(chainId, week.weekId, GEN8_HOLDER_PROGRAM);
    const row = await batchRow(db, chainId, vault, batchId);
    const rebuild = row && row.status === "failed" && Number(row.attempt) < MAX_BATCH_ATTEMPTS;
    if (!row || rebuild) {
      // Pull every holders / split coin first (once per coin for this week), and wait until those pulls landed.
      const pulls: Candidate[] = [];
      for (const coin of input.coins.filter((c) => (c.choice === CHOICE.holders || c.choice === CHOICE.split) && c.launchedAt < Math.floor(week.end.getTime() / 1000))) {
        const r = await pullCandidate({ db, chainId, chain, cfg, coin, momentKey: `week:${week.weekId}`, why: `before the ${week.weekId} holder batch` });
        if (r.report) reports.push(r.report);
        if (r.candidate) pulls.push(r.candidate);
      }
      const pullsInFlight = input.coins.some((c) => input.inFlightSubjects.has(c.poolId));
      if (input.send && (pulls.length || pullsInFlight)) {
        reports.push({ kind: "holders", subject: week.weekId, decision: "wait", reason: `waiting for ${pulls.length} pull(s) before the batch` });
        return { reports, candidates: pulls };
      }
      if (!input.send) for (const p of pulls) reports.push({ ...p.report, decision: "dry-run" });
      const built = await buildGen8Week({ db, chainId, chain, cfg, coins: input.coins, info, week, blockTime: input.blockTime, now: input.now, alert });
      reports.push(...built.reports);
      planOut = built.plan;
      if (built.wait) {
        reports.push({ kind: "holders", subject: week.weekId, decision: "wait", reason: built.wait });
      } else if (!input.send) {
        const f = built.plan?.file;
        reports.push({ kind: "holders", subject: week.weekId, decision: "dry-run", reason: f ? `would store, publish and propose ${f.total} wei to ${f.leaves.length} holders (root ${f.root})` : built.plan?.reason ?? "nothing to build" });
      } else if (!input.keyedByVault) {
        reports.push({ kind: "holders", subject: week.weekId, decision: "blocked", reason: "evm_holder_batches is not keyed per vault (apply 20261008_000040)" });
        await alert({ severity: "critical", kind: "gen8_choice_batches_not_per_vault", chainId, subject: vault, title: "Gen-8 holder batch blocked", message: "public.evm_holder_batches is not keyed per vault yet: apply db/migrations/20261008_000040_evm_holder_batches_per_vault.sql." });
      } else {
        const f = built.plan?.file ?? null;
        await withTx(db, async (tx) => {
          const existing = await batchRow(tx, chainId, vault, batchId, true);
          if (existing && !(existing.status === "failed" && Number(existing.attempt) < MAX_BATCH_ATTEMPTS)) return;
          if (!f) {
            if (existing) {
              await tx.query(`update public.evm_holder_batches set status = 'empty', last_reason = $4, updated_at = now() where chain_id = $1 and week_id = $2 and lower(vault_address) = $3`, [chainId, week.weekId, vault, built.plan?.reason ?? "empty"]);
            } else {
              await tx.query(`insert into public.evm_holder_batches (chain_id, week_id, vault_address, batch_id, status, last_reason) values ($1,$2,$3,$4,'empty',$5)`, [chainId, week.weekId, vault, batchId, built.plan?.reason ?? "empty"]);
            }
          } else if (existing) {
            await tx.query(
              `update public.evm_holder_batches set root = $4, total_raw = $5, claim_deadline = $6, leaf_file = $7::jsonb, status = 'built',
                      reward_batch_id = null, last_reason = null, executable_at = null, updated_at = now()
                where chain_id = $1 and week_id = $2 and lower(vault_address) = $3`,
              [chainId, week.weekId, vault, f.root, f.total, f.claimDeadline, JSON.stringify(f)],
            );
          } else {
            await tx.query(
              `insert into public.evm_holder_batches (chain_id, week_id, vault_address, batch_id, root, total_raw, claim_deadline, leaf_file, status)
               values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'built')`,
              [chainId, week.weekId, vault, f.batchId, f.root, f.total, f.claimDeadline, JSON.stringify(f)],
            );
          }
        });
        reports.push({ kind: "holders", subject: week.weekId, decision: f ? "sent" : "skip", reason: f ? `stored ${f.total} wei to ${f.leaves.length} holders, root ${f.root}` : built.plan?.reason });
      }
    }
  }

  const open = await db.query(
    `select * from public.evm_holder_batches where chain_id = $1 and lower(vault_address) = $2 and status in ('built', 'proposing', 'proposed', 'executing') order by week_id`,
    [chainId, vault],
  );
  for (const batch of open.rows) {
    const subject = lc(String(batch.batch_id));
    if (input.inFlightSubjects.has(subject)) {
      reports.push({ kind: "holders", subject, decision: "wait", reason: `${batch.status}: its transaction is in flight` });
      continue;
    }
    const onChain = await chain.holderBatch(subject);
    const status = String(batch.status);
    if (status === "built" || status === "proposing") {
      if (onChain.status === 0) {
        if (!input.send) continue;
        if (status === "proposing") await setBatch(db, chainId, vault, batch.week_id, "built", "the proposal never landed");
        // The watchdog approves only last week's id, with a claim deadline about one claim window after executableAt:
        // a file that is no longer both is never proposed (rebuilt while it is still last week's, else rolled over).
        const stale = String(batch.week_id) !== previousWeek(input.now).weekId
          ? "its week is no longer the week just finished: the pots roll over"
          : BigInt(batch.claim_deadline) - (input.blockTime + info.holderBatchDelay) < BigInt((cfg.claimWindowDays - 1) * 86_400)
            ? "its claim deadline is more than a day old: rebuilt"
            : null;
        if (stale) {
          const final = stale.endsWith("roll over");
          await withTx(db, async (tx) => {
            await setBatch(tx, chainId, vault, batch.week_id, "failed", `not proposed: ${stale}`, final ? { attempt: 1000 } : {});
            await archiveGen8RewardBatch(tx, batch.reward_batch_id, `not proposed: ${stale}`);
          });
          reports.push({ kind: "holders", subject, decision: "blocked", action: "propose_holder_batch", reason: stale });
          await alert({ severity: "warning", kind: "gen8_choice_batch_stale", chainId, subject, title: `Gen-8 holder batch ${batch.week_id} not proposed on chain ${chainId}`, message: `The stored batch was not proposed in time: ${stale}.` });
          continue;
        }
        if (!batch.reward_batch_id) {
          // Published before it is proposed, also when an earlier pass stopped between the two.
          const rewardBatchId = await publishGen8RewardBatch(db, batch.leaf_file as Gen8LeafFileV2);
          await db.query(`update public.evm_holder_batches set reward_batch_id = $4 where chain_id = $1 and week_id = $2 and lower(vault_address) = $3`, [chainId, batch.week_id, vault, rewardBatchId]);
        }
        const file = batch.leaf_file as Gen8LeafFileV2;
        const call: Gen8VaultCall = { action: "propose_holder_batch", fn: "proposeHolderBatch", args: gen8ProposeArgs(file) };
        const sim = await chain.simulate(call);
        if (!sim.ok) {
          await withTx(db, async (tx) => {
            await setBatch(tx, chainId, vault, batch.week_id, "failed", `propose refused: ${sim.revert}`);
            const fresh = await batchRow(tx, chainId, vault, subject);
            await archiveGen8RewardBatch(tx, fresh?.reward_batch_id ?? null, `propose refused: ${sim.revert}`);
          });
          reports.push({ kind: "holders", subject, decision: "blocked", action: "propose_holder_batch", reason: sim.revert });
          await alert({ severity: "warning", kind: "gen8_choice_propose_refused", chainId, subject, title: `Gen-8 holder batch proposal refused on chain ${chainId}`, message: `proposeHolderBatch for ${batch.week_id} simulated with ${sim.revert}; rebuilt on a later pass (attempt ${Number(batch.attempt) + 1} of ${MAX_BATCH_ATTEMPTS}).` });
          continue;
        }
        candidates.push({
          report: { kind: "holders", subject, decision: "send", action: "propose_holder_batch", reason: `propose ${batch.total_raw} wei (${batch.week_id})` },
          call, subject, momentKey: `week:${batch.week_id}:${batch.attempt}`, amount: BigInt(String(batch.total_raw)),
          onRecorded: async (tx) => {
            await tx.query(`update public.evm_holder_batches set status = 'proposing', updated_at = now() where chain_id = $1 and week_id = $2 and lower(vault_address) = $3 and status = 'built'`, [chainId, batch.week_id, vault]);
          },
        });
        continue;
      }
      // On chain already (the job's effect was not applied): adopt it only when it is exactly the stored file.
      if (!onChainMatchesFile(onChain, batch)) {
        if (input.send) {
          await withTx(db, async (tx) => {
            await setBatch(tx, chainId, vault, batch.week_id, "failed", "the proposal on chain does not match the published leaf file: veto it", { attempt: 1000 });
            await archiveGen8RewardBatch(tx, batch.reward_batch_id, "proposal on chain does not match the leaf file");
          });
          await alert({ severity: "critical", kind: "gen8_choice_proposal_mismatch", chainId, subject, title: `Gen-8 holder batch on chain ${chainId} does not match its leaf file`, message: `Batch ${subject} (${batch.week_id}) on chain has root ${onChain.root} total ${onChain.total}; the stored file says ${batch.root} / ${batch.total_raw}. Veto it.` });
        }
        reports.push({ kind: "holders", subject, decision: "blocked", reason: "proposal on chain does not match the stored leaf file" });
        continue;
      }
      if (input.send) await setBatch(db, chainId, vault, batch.week_id, "proposed", null, { executableAt: onChain.executableAt });
    }
    // proposed / executing (or just adopted)
    if (onChain.status === 3) {
      if (input.send) {
        await withTx(db, async (tx) => {
          await setBatch(tx, chainId, vault, batch.week_id, "vetoed", "vetoed by the Safe; the amounts are back in the coins' holder balances");
          await archiveGen8RewardBatch(tx, batch.reward_batch_id, "holder batch vetoed by the Safe");
        });
      }
      reports.push({ kind: "holders", subject, decision: "skip", reason: "vetoed by the Safe" });
      continue;
    }
    if (onChain.status === 2) {
      if (input.send) {
        const job = await db.query(`select tx_hash, receipt_block from public.evm_gen8_choice_jobs where chain_id = $1 and subject = $2 and action = 'execute_holder_batch' and status = 'confirmed' order by id desc limit 1`, [chainId, subject]);
        await withTx(db, async (tx) => {
          await setBatch(tx, chainId, vault, batch.week_id, "executed", null);
          await openGen8RewardBatch(tx, batch.reward_batch_id, job.rows[0]?.tx_hash ?? null, job.rows[0]?.receipt_block == null ? null : Number(job.rows[0].receipt_block));
        });
      }
      reports.push({ kind: "holders", subject, decision: "skip", reason: "executed on chain" });
      continue;
    }
    if (onChain.status !== 1) {
      reports.push({ kind: "holders", subject, decision: "blocked", reason: `stored as ${status} but the vault has no such batch` });
      await alert({ severity: "critical", kind: "gen8_choice_batch_missing", chainId, subject, title: `Gen-8 holder batch missing on chain ${chainId}`, message: `evm_holder_batches says ${status} for ${subject} (${batch.week_id}); vault.holderBatches says status ${onChain.status}.` });
      continue;
    }
    if (status === "executing" && input.send) await setBatch(db, chainId, vault, batch.week_id, "proposed", "the execution never landed");
    const total = onChain.total;
    const waitFor = async (reason: string) => {
      if (input.send && batch.last_reason !== reason) await db.query(`update public.evm_holder_batches set last_reason = $4 where chain_id = $1 and week_id = $2 and lower(vault_address) = $3`, [chainId, batch.week_id, vault, reason]);
      reports.push({ kind: "holders", subject, decision: "wait", reason });
    };
    if (onChain.claimDeadline < input.blockTime + MIN_CLAIM_WINDOW_SEC) {
      reports.push({ kind: "holders", subject, decision: "blocked", reason: "the claim deadline leaves less than 7 days: veto and re-propose" });
      await alert({ severity: "critical", kind: "gen8_choice_deadline_short", chainId, subject, title: `Gen-8 holder batch can no longer execute on chain ${chainId}`, message: `Batch ${subject} (${batch.week_id}): claim deadline ${onChain.claimDeadline} is less than 7 days away. The Safe vetoes it; the amounts return to the coins and roll over.` });
      continue;
    }
    if (!onChain.approved) {
      await waitFor("waiting for the Safe to approve this root, total and claim deadline");
      continue;
    }
    if (input.blockTime < onChain.executableAt) {
      await waitFor("approved; waiting for the 24 h veto window");
      continue;
    }
    const auth = await chain.batchAuthorization(info.holderDistributor, subject);
    if (!auth.authorized || auth.consumed) {
      await waitFor("waiting for the Safe to authorize the batch on the holder distributor");
      continue;
    }
    if (input.blockTime < auth.publishAfter) {
      await waitFor(`the distributor authorization opens at ${auth.publishAfter}`);
      continue;
    }
    if (input.blockTime > auth.publishDeadline) {
      await waitFor("the distributor authorization expired: the Safe re-authorizes");
      await alert({ severity: "warning", kind: "gen8_choice_auth_expired", chainId, subject, title: `Gen-8 holder batch authorization expired on chain ${chainId}`, message: `Batch ${subject} (${batch.week_id}) is approved but its distributor authorization ended at ${auth.publishDeadline}.` });
      continue;
    }
    if (auth.maxAmount < total) {
      await waitFor(`the distributor authorization (${auth.maxAmount}) is below the batch total (${total})`);
      await alert({ severity: "warning", kind: "gen8_choice_auth_low", chainId, subject, title: `Gen-8 holder batch above its authorization on chain ${chainId}`, message: `Batch ${subject} (${batch.week_id}): total ${total}, authorized ${auth.maxAmount}. The Safe raises the authorization or vetoes the batch.` });
      continue;
    }
    const call: Gen8VaultCall = { action: "execute_holder_batch", fn: "executeHolderBatch", args: [subject] };
    const sim = await chain.simulate(call);
    if (!sim.ok) {
      reports.push({ kind: "holders", subject, decision: "blocked", action: "execute_holder_batch", reason: sim.revert });
      continue;
    }
    candidates.push({
      report: { kind: "holders", subject, decision: "send", action: "execute_holder_batch", reason: "approved by the Safe, authorized, veto window over" },
      call, subject, momentKey: `week:${batch.week_id}`, amount: total,
      onRecorded: async (tx) => {
        await tx.query(`update public.evm_holder_batches set status = 'executing', updated_at = now() where chain_id = $1 and week_id = $2 and lower(vault_address) = $3 and status = 'proposed'`, [chainId, batch.week_id, vault]);
      },
    });
  }
  return { reports, candidates, plan: planOut };
}

// ------------------------------------------------------------------------------------ buybacks

/** The vault's weekly buyback counter for the coin: zero when its last buy was in an earlier vault week. */
export function gen8SpentThisVaultWeek(lastBuybackAt: bigint, counter: bigint, blockTime: bigint): bigint {
  if (lastBuybackAt === 0n) return 0n;
  return vaultWeek(lastBuybackAt) === vaultWeek(blockTime) ? counter : 0n;
}

async function buybackFlow(input: { db: Queryable; chainId: number; chain: Gen8ChoiceChain; cfg: Gen8ChoiceConfig; coins: Gen8ChoiceCoin[]; info: Gen8VaultInfo; blockTime: bigint; now: Date }) {
  const { db, chainId, chain, cfg, info } = input;
  const reports: Gen8StepReport[] = [];
  const candidates: Candidate[] = [];
  for (const coin of input.coins.filter((c) => c.choice === CHOICE.buyback)) {
    const used = await liveMomentKeys(db, chainId, chain.vault, coin.poolId, "buyback");
    const momentKey = dueMomentKey({ masterSecret: cfg.masterSecret, chainId, campaign: coin.poolId, now: input.now, perDay: cfg.perDay, kind: "buyback", used });
    if (!momentKey) continue;
    const state = await chain.coin(coin.poolId);
    if (state.choice !== CHOICE.buyback) {
      reports.push({ kind: "buyback", subject: coin.poolId, decision: "skip", reason: `vault choice is ${state.choice}, not buyback` });
      continue;
    }
    // Always pull before a buyback when the hook holds enough.
    const pull = await pullCandidate({ db, chainId, chain, cfg, coin, momentKey: `buyback:${momentKey}`, why: `before the buyback at ${momentKey}` });
    if (pull.report) reports.push(pull.report);
    if (pull.candidate) {
      candidates.push(pull.candidate);
      continue;
    }
    const pool = await chain.hookPool(coin.poolId);
    if (input.blockTime < pool.openAt + 60n) {
      reports.push({ kind: "buyback", subject: coin.poolId, decision: "wait", reason: "inside the 60 s launch window" });
      continue;
    }
    if (state.lastBuybackAt !== 0n && input.blockTime < state.lastBuybackAt + info.caps.minBuyInterval) {
      reports.push({ kind: "buyback", subject: coin.poolId, decision: "wait", reason: "the vault's minimum interval since the last buyback" });
      continue;
    }
    const limits: VaultLimits = {
      paused: info.operatorPaused, buyPerTx: info.caps.maxBuyPerTx, buybackPerCampaignWeek: info.caps.maxBuybackPerCoinWeek,
      buyInterval: info.caps.minBuyInterval, impactBps: info.caps.maxImpactBps, holderBatchPerWeek: info.caps.maxHolderBatchPerWeek,
    };
    let amount = buybackBudget({ balance: state.buybackBalance, limits, spentThisWeek: gen8SpentThisVaultWeek(state.lastBuybackAt, state.buybackSpentInWeek, input.blockTime) });
    if (amount < cfg.buybackMinWei || amount === 0n) {
      reports.push({ kind: "buyback", subject: coin.poolId, decision: "skip", reason: `nothing to buy within the caps (budget ${amount}, minimum ${cfg.buybackMinWei})` });
      continue;
    }
    let lastRevert = "";
    let chosen: Candidate | null = null;
    for (let attempt = 0; attempt < 5 && amount >= cfg.buybackMinWei && amount > 0n; attempt += 1) {
      const call: Gen8VaultCall = { action: "buyback", fn: "buyback", args: [coin.poolId, amount] };
      const sim = await chain.simulate(call);
      if (sim.ok) {
        chosen = { report: { kind: "buyback", subject: coin.poolId, decision: "send", action: "buyback", reason: `buyback ${amount} wei at ${momentKey}` }, call, subject: coin.poolId, momentKey, amount };
        break;
      }
      lastRevert = sim.revert;
      // Curve progress cap before graduation: try a smaller amount.
      if (sim.revert !== "CurveState") break;
      amount /= 2n;
    }
    if (chosen) candidates.push(chosen);
    else reports.push({ kind: "buyback", subject: coin.poolId, decision: lastRevert === "TooSoon" || lastRevert === "NothingSwapped" ? "wait" : "blocked", action: "buyback", reason: lastRevert || "below the minimum after halving" });
  }
  return { reports, candidates };
}

/** Daily pull of every choice coin above the pull minimum, at most once per coin per UTC day. */
async function dailyPulls(input: { db: Queryable; chainId: number; chain: Gen8ChoiceChain; cfg: Gen8ChoiceConfig; coins: Gen8ChoiceCoin[]; now: Date }) {
  const reports: Gen8StepReport[] = [];
  const candidates: Candidate[] = [];
  const day = input.now.toISOString().slice(0, 10);
  for (const coin of input.coins) {
    const r = await pullCandidate({ db: input.db, chainId: input.chainId, chain: input.chain, cfg: input.cfg, coin, momentKey: `day:${day}`, why: `daily pull ${day}` });
    if (r.report) reports.push(r.report);
    if (r.candidate) candidates.push(r.candidate);
  }
  return { reports, candidates };
}

// ------------------------------------------------------------------------------------ sending

async function sendCandidate(input: {
  db: Queryable;
  chainId: number;
  chain: Gen8ChoiceChain;
  sender: Gen8ChoiceSender;
  cfg: Gen8ChoiceConfig;
  c: Candidate;
  blockTime: bigint;
  alert: Gen8ChoiceAlert;
}): Promise<{ step: Gen8StepReport; sent: Gen8PassReport["sent"] }> {
  const { db, chainId, chain, sender, cfg, c } = input;
  return withOperatorLock(sender.address, async () => {
    const latest = await sender.getNonce("latest");
    const pending = await sender.getNonce("pending");
    if (pending > latest) return { step: { ...c.report, decision: "queued", reason: `${c.report.reason ?? ""}; another transaction from the operator key is pending` }, sent: null };
    // Simulated again right before signing (state may have moved since the plan).
    const sim = await chain.simulate(c.call);
    if (!sim.ok) return { step: { ...c.report, decision: "blocked", reason: `simulation before signing: ${sim.revert}` }, sent: null };
    const gasLimit = (sim.gas * 12n) / 10n + 25_000n;
    if (gasLimit > cfg.maxGas) return { step: { ...c.report, decision: "blocked", reason: `gas ${gasLimit} above the cap ${cfg.maxGas}` }, sent: null };
    let signed: { raw: string; hash: string };
    try {
      signed = await sender.sign(c.call, gasLimit, latest);
    } catch (error) {
      if (error instanceof Gen8FeeCapError) return { step: { ...c.report, decision: "wait", reason: error.message }, sent: null };
      throw error;
    }
    // Record (with the batch status change) before anything is broadcast.
    let jobId: number;
    try {
      jobId = await withTx(db, async (tx) => {
        const inserted = await tx.query(
          `insert into public.evm_gen8_choice_jobs(
              chain_id, vault_address, operator_address, subject, action, moment_key, call_args, amount_raw,
              nonce, gas_limit, tx_hash, raw_tx, status, reason, chain_time
           ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,'sending',$13,$14)
           returning id`,
          [
            chainId, lc(chain.vault), lc(sender.address), c.subject, c.call.action, c.momentKey, gen8CallArgsJson(c.call),
            c.amount == null ? null : c.amount.toString(), latest, gasLimit.toString(), lc(signed.hash), signed.raw,
            (c.report.reason ?? "").slice(0, 500), input.blockTime.toString(),
          ],
        );
        if (c.onRecorded) await c.onRecorded(tx);
        return Number(inserted.rows[0].id);
      });
    } catch (error) {
      // Unique index: another job is in flight or this moment already has a live job. Nothing was broadcast.
      const message = error instanceof Error ? error.message : String(error);
      return { step: { ...c.report, decision: "queued", reason: `not recorded, not sent: ${message.slice(0, 200)}` }, sent: null };
    }
    const step: Gen8StepReport = { ...c.report, decision: "sent", txHash: signed.hash };
    try {
      await sender.broadcast(signed.raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      step.error = message;
      // The job stays 'sending': the next pass decides by receipt and nonce whether it left (and re-broadcasts it).
      await db.query(`update public.evm_gen8_choice_jobs set last_error = $2, updated_at = now() where id = $1`, [jobId, message.slice(0, 500)]);
      return { step, sent: { hash: signed.hash, action: c.call.action, confirmed: false } };
    }
    const receipt = await sender.waitReceipt(signed.hash, cfg.receiptWaitMs);
    if (!receipt) return { step, sent: { hash: signed.hash, action: c.call.action, confirmed: false } };
    const row = (await db.query(`select * from public.evm_gen8_choice_jobs where id = $1`, [jobId])).rows[0];
    const ok = Number(receipt.status) === 1;
    const fin = await finishGen8Job({ db, chain, chainId, row, status: ok ? "confirmed" : "reverted", block: receipt.blockNumber, alert: input.alert });
    if (!ok) step.error = "reverted";
    return { step, sent: { hash: signed.hash, action: c.call.action, confirmed: ok && !fin.deferred } };
  });
}

// ------------------------------------------------------------------------------------ the pass

export async function runGen8ChoicePass(input: {
  db: Queryable;
  chainId: number;
  chain: Gen8ChoiceChain;
  sender: Gen8ChoiceSender;
  cfg: Gen8ChoiceConfig;
  send: boolean;
  now?: Date;
  coins?: Gen8ChoiceCoin[];
  alert?: Gen8ChoiceAlert;
  /** evm_holder_batches keyed per vault (evmCreatorChoiceLanes.holderBatchesKeyedByVault); required to store a batch. */
  keyedByVault?: boolean;
}): Promise<Gen8PassReport> {
  const { db, chainId, chain, sender, cfg } = input;
  if (!cfg.masterSecret) throw new Error("EVM_BUYBACK_SEED_SECRET is required");
  const alert = input.alert ?? noAlert;
  const now = input.now ?? new Date();
  const steps: Gen8StepReport[] = [];
  const info = await chain.vaultInfo();
  const operatorOk = lc(info.operator) === lc(sender.address) && !info.operatorPaused;
  const send = input.send && operatorOk;
  if (input.send && !operatorOk) {
    const reason = info.operatorPaused ? "the Safe paused the operator" : `vault operator is ${info.operator}, not the key ${sender.address}`;
    steps.push({ kind: "operator", subject: chain.vault, decision: "blocked", reason });
    await alert({ severity: "critical", kind: "gen8_choice_operator_refused", chainId, subject: chain.vault, title: `Gen-8 choice operator refuses to send on chain ${chainId}`, message: `${reason}. Nothing is sent; checks are still recorded.` });
  }

  await ensureWeekSecrets(db, chainId, cfg.masterSecret, now);
  const resolved = await resolveGen8Jobs({ db, chainId, chain, sender, send, cfg, alert });
  if (resolved.confirmed || resolved.reverted || resolved.dropped) steps.push({ kind: "resolve", subject: chain.vault, decision: "sent", reason: JSON.stringify(resolved) });
  const sendingRows = (await db.query(`select subject from public.evm_gen8_choice_jobs where chain_id = $1 and status = 'sending'`, [chainId])).rows;
  const inFlightSubjects = new Set<string>(sendingRows.map((r: any) => lc(String(r.subject))));
  const inFlight = sendingRows.length > 0;

  const block = await chain.latestBlock();
  const coins = input.coins ?? (await listGen8ChoiceCoins(db, chainId, chain.vault, chain));

  steps.push(...(await takeGen8Checks({ db, chainId, chain, coins, masterSecret: cfg.masterSecret, now, operator: info.operator, excluded: cfg.excluded, alert })));

  const holders = await holderBatchFlow({
    db, chainId, chain, cfg, coins, info, blockTime: block.timestamp, now, send, keyedByVault: input.keyedByVault ?? true, inFlightSubjects, alert,
  });
  const buys = await buybackFlow({ db, chainId, chain, cfg, coins, info, blockTime: block.timestamp, now });
  const pulls = await dailyPulls({ db, chainId, chain, cfg, coins, now });
  steps.push(...holders.reports, ...buys.reports, ...pulls.reports);

  // Priority: the holder batch (Monday pulls, propose, execute), then buybacks (and their pulls), then daily pulls.
  const seen = new Set<string>();
  const ordered = [...holders.candidates, ...buys.candidates, ...pulls.candidates].filter((c) => {
    const k = `${c.call.action}:${c.subject}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  let sent: Gen8PassReport["sent"] = null;
  for (const c of ordered) {
    if (!send) {
      steps.push({ ...c.report, decision: "dry-run" });
      continue;
    }
    if (inFlight || sent) {
      steps.push({ ...c.report, decision: "queued", reason: `${c.report.reason ?? ""}; one transaction in flight per chain` });
      continue;
    }
    const r = await sendCandidate({ db, chainId, chain, sender, cfg, c, blockTime: block.timestamp, alert });
    steps.push(r.step);
    if (r.sent) sent = r.sent;
  }
  return { chainId, send, operatorOk, inFlight, steps, sent, plan: holders.plan };
}
