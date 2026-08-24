import { PublicKey } from "@solana/web3.js";
import { pool } from "../db.js";
import { listRecruiterClaimableSettlements } from "./recruiterAdmin.js";
import { buildRecruiterMerkle, canRebuildRecruiterBatch, i64leBytes, mergeRecruiterEntitlements } from "./recruiterMerkle.js";

const CONFIG_SEED = Buffer.from("rewards_config");
const VAULT_SEED = Buffer.from("recruiter_vault");
const BATCH_SEED = Buffer.from("recruiter_batch");
const CLAIM_SEED = Buffer.from("recruiter_claim");

function programId(): string {
  return String(process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || "").trim();
}

function laneAddresses(epochId: string | number, walletAddress?: string | null) {
  const pid = new PublicKey(programId() || "11111111111111111111111111111111");
  const [configAddress] = PublicKey.findProgramAddressSync([CONFIG_SEED], pid);
  const [vaultAddress] = PublicKey.findProgramAddressSync([VAULT_SEED], pid);
  const [batchAddress] = PublicKey.findProgramAddressSync([BATCH_SEED, i64leBytes(epochId)], pid);
  const claimReceiptAddress = walletAddress
    ? PublicKey.findProgramAddressSync([CLAIM_SEED, i64leBytes(epochId), new PublicKey(walletAddress).toBuffer()], pid)[0]
    : null;
  return {
    programId: pid.toBase58(),
    configAddress: configAddress.toBase58(),
    vaultAddress: vaultAddress.toBase58(),
    batchAddress: batchAddress.toBase58(),
    claimReceiptAddress: claimReceiptAddress?.toBase58() || null,
  };
}

function previousWeeklyWindow(now = new Date()) {
  const today0 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (today0.getUTCDay() + 6) % 7;
  const thisMonday = new Date(today0.getTime() - daysSinceMonday * 86400_000);
  const start = new Date(thisMonday.getTime() - 7 * 86400_000);
  return { start, end: thisMonday };
}

async function ensureWeeklyEpoch(chainId: number): Promise<{ id: number; startAt: Date; endAt: Date }> {
  const window = previousWeeklyWindow();
  const existing = await pool.query(
    `select id, start_at, end_at from public.epochs
      where chain_id=$1 and epoch_type='weekly' and start_at=$2::timestamptz
      limit 1`,
    [chainId, window.start.toISOString()],
  );
  if (existing.rows[0]) {
    return { id: Number(existing.rows[0].id), startAt: existing.rows[0].start_at, endAt: existing.rows[0].end_at };
  }
  const inserted = await pool.query(
    `insert into public.epochs (chain_id, epoch_type, start_at, end_at, status, finalized_at)
     values ($1, 'weekly', $2::timestamptz, $3::timestamptz, 'finalized', now())
     on conflict (chain_id, epoch_type, start_at)
     do update set status = public.epochs.status
     returning id, start_at, end_at`,
    [chainId, window.start.toISOString(), window.end.toISOString()],
  );
  return { id: Number(inserted.rows[0].id), startAt: inserted.rows[0].start_at, endAt: inserted.rows[0].end_at };
}

type PortalPayout = {
  accountId: string;
  recruiterId: number | null;
  code: string | null;
  payoutWallet: string;
  amountRaw: string;
  ledgerIds: string[];
};

async function loadPortalSolanaPayouts(): Promise<PortalPayout[]> {
  const { rows } = await pool.query(
    `select a.recruiter_id as account_id,
            r.id as recruiter_id,
            a.code,
            w.wallet_address as payout_wallet,
            coalesce(sum(l.amount_raw), 0)::numeric(78,0)::text as amount_raw,
            array_agg(l.id::text) as ledger_ids
       from public.recruiter_reward_ledger l
       join public.recruiter_accounts a on a.recruiter_id = l.recruiter_id
       join public.recruiter_payout_wallets w
         on w.recruiter_id = l.recruiter_id and w.chain='solana' and w.verified_at is not null
       left join public.recruiters r
         on r.code = a.code
         or r.wallet_address = a.signup_wallet
         or lower(r.wallet_address) = lower(a.signup_wallet)
      where l.chain='solana'
        and l.status in ('claimable','retriable')
        and l.claim_id is null
      group by a.recruiter_id, r.id, a.code, w.wallet_address
     having coalesce(sum(l.amount_raw), 0) > 0`,
  );
  return rows.map((row) => ({
    accountId: String(row.account_id),
    recruiterId: row.recruiter_id != null ? Number(row.recruiter_id) : null,
    code: row.code || null,
    payoutWallet: String(row.payout_wallet),
    amountRaw: String(row.amount_raw || "0"),
    ledgerIds: Array.isArray(row.ledger_ids) ? row.ledger_ids.map(String) : [],
  }));
}

export async function publishRecruiterSettlementBatches(): Promise<{
  computedAt: string;
  batches: Array<Record<string, unknown>>;
}> {
  const chainId = 101;
  const epoch = await ensureWeeklyEpoch(chainId);
  const viewRows = await listRecruiterClaimableSettlements({ chainId, limit: 1000 }).catch(() => []);
  const portal = await loadPortalSolanaPayouts().catch(() => [] as PortalPayout[]);
  const portalByWallet = new Map(portal.map((row) => [row.payoutWallet, row]));

  const recipients = mergeRecruiterEntitlements(
    viewRows
      .filter((row) => Number(row.chainId) === chainId)
      .map((row) => ({
        walletAddress: row.walletAddress,
        amountLamports: String(row.claimableAmount || "0"),
        source: "phase2" as const,
      })),
    portal.map((row) => ({
      walletAddress: row.payoutWallet,
      amountLamports: row.amountRaw,
      source: "portal" as const,
      accountId: row.accountId,
      ledgerIds: row.ledgerIds,
    })),
  );
  if (!recipients.length) {
    return { computedAt: new Date().toISOString(), batches: [] };
  }

  const existing = await pool.query(
    `select id, status from public.solana_reward_lane_batches
      where chain_id=$1 and lane='recruiter' and epoch_id=$2
      limit 1`,
    [chainId, epoch.id],
  );
  const existingStatus = existing.rows[0]?.status ? String(existing.rows[0].status) : null;
  if (existing.rows[0] && !canRebuildRecruiterBatch(existingStatus)) {
    return {
      computedAt: new Date().toISOString(),
      batches: [{
        chainId,
        epochId: epoch.id,
        status: existingStatus,
        immutable: true,
        recipientCount: recipients.length,
        note: "Batch is claim_open. Recipients are frozen.",
      }],
    };
  }

  const merkle = buildRecruiterMerkle(epoch.id, recipients);
  const addresses = laneAddresses(epoch.id);
  const deadline = Math.floor(new Date(epoch.endAt).getTime() / 1000) + 90 * 86400;
  const client = await pool.connect();
  try {
    await client.query("begin");
    let batchId = existing.rows[0]?.id || null;
    if (batchId) {
      await client.query(
        `update public.recruiter_reward_ledger l
            set claim_id = null, updated_at = now()
          from public.recruiter_reward_claims c
         where c.id = l.claim_id
           and c.chain = 'solana'
           and c.status in ('created','retriable')
           and c.metadata->>'epochId' = $1`,
        [String(epoch.id)],
      );
      await client.query(
        `delete from public.solana_reward_lane_claims where batch_id = $1`,
        [batchId],
      );
      await client.query(
        `delete from public.recruiter_reward_claims
          where chain = 'solana'
            and status in ('created','retriable')
            and metadata->>'epochId' = $1`,
        [String(epoch.id)],
      );
      await client.query(
        `update public.solana_reward_lane_batches
            set program_id=$2, vault_address=$3, batch_address=$4, merkle_root=$5,
                total_lamports=$6::numeric, status='ready',
                metadata=$7::jsonb, updated_at=now()
          where id=$1`,
        [
          batchId,
          addresses.programId,
          addresses.vaultAddress,
          addresses.batchAddress,
          merkle.root,
          merkle.totalLamports,
          JSON.stringify({ startAt: epoch.startAt, endAt: epoch.endAt, deadline, rebuiltAt: new Date().toISOString() }),
        ],
      );
    } else {
      const batch = await client.query(
        `insert into public.solana_reward_lane_batches (
           chain_id, lane, epoch_id, program_id, vault_address, batch_address,
           merkle_root, total_lamports, status, metadata
         ) values (
           $1, 'recruiter', $2, $3, $4, $5, $6, $7::numeric, 'draft', $8::jsonb
         )
         on conflict (chain_id, lane, epoch_id) do update
           set merkle_root = excluded.merkle_root,
               total_lamports = excluded.total_lamports,
               metadata = excluded.metadata,
               status = case
                 when public.solana_reward_lane_batches.status in ('claim_open','published')
                 then public.solana_reward_lane_batches.status
                 else 'ready'
               end,
               updated_at = now()
         returning id, status`,
        [
          chainId,
          epoch.id,
          addresses.programId,
          addresses.vaultAddress,
          addresses.batchAddress,
          merkle.root,
          merkle.totalLamports,
          JSON.stringify({ startAt: epoch.startAt, endAt: epoch.endAt, deadline }),
        ],
      );
      batchId = batch.rows[0]?.id;
      if (batch.rows[0]?.status && !canRebuildRecruiterBatch(String(batch.rows[0].status))) {
        await client.query("rollback");
        return {
          computedAt: new Date().toISOString(),
          batches: [{ chainId, epochId: epoch.id, status: batch.rows[0].status, immutable: true }],
        };
      }
      if (batchId) {
        await client.query(
          `update public.solana_reward_lane_batches set status='ready', updated_at=now() where id=$1 and status='draft'`,
          [batchId],
        );
      }
    }
    if (!batchId) {
      await client.query("rollback");
      return {
        computedAt: new Date().toISOString(),
        batches: [{ chainId, epochId: epoch.id, alreadyExisted: true }],
      };
    }

    for (let i = 0; i < recipients.length; i += 1) {
      const recipient = recipients[i]!;
      const receipt = laneAddresses(epoch.id, recipient.walletAddress).claimReceiptAddress;
      let recruiterClaimId: string | null = null;
      const portalRow = portalByWallet.get(recipient.walletAddress);
      if (portalRow?.accountId) {
        const claim = await client.query(
          `insert into public.recruiter_reward_claims (
             recruiter_id, chain, token, amount_raw, payout_wallet, status, metadata
           ) values ($1, 'solana', 'SOL', $2::numeric, $3, 'created', $4::jsonb)
           returning id`,
          [
            portalRow.accountId,
            recipient.amountLamports,
            recipient.walletAddress,
            JSON.stringify({ epochId: epoch.id, ledgerIds: portalRow.ledgerIds }),
          ],
        );
        recruiterClaimId = String(claim.rows[0].id);
        await client.query(
          `update public.recruiter_reward_ledger
              set claim_id = $1, updated_at = now()
            where recruiter_id = $2
              and chain = 'solana'
              and status in ('claimable','retriable')
              and claim_id is null`,
          [recruiterClaimId, portalRow.accountId],
        );
      }
      await client.query(
        `insert into public.solana_reward_lane_claims (
           batch_id, lane, source_type, source_ref, wallet_address, amount_lamports,
           merkle_proof, claim_receipt_address, status, metadata
         ) values (
           $1, 'recruiter', $2, $3, $4, $5::numeric, $6::jsonb, $7, 'pending', $8::jsonb
         )
         on conflict (lane, source_type, source_ref) do update
           set amount_lamports = excluded.amount_lamports,
               merkle_proof = excluded.merkle_proof,
               claim_receipt_address = excluded.claim_receipt_address,
               status = 'pending',
               updated_at = now()`,
        [
          batchId,
          recruiterClaimId ? "recruiter_reward_claim" : "recruiter_settlement",
          recruiterClaimId || `${epoch.id}:${recipient.walletAddress}`,
          recipient.walletAddress,
          recipient.amountLamports,
          JSON.stringify(merkle.proofs[i] || []),
          receipt,
          JSON.stringify({ epochId: epoch.id }),
        ],
      );
    }
    await client.query("commit");
    return {
      computedAt: new Date().toISOString(),
      batches: [{
        chainId,
        epochId: epoch.id,
        status: "ready",
        rebuilt: Boolean(existing.rows[0]),
        recipientCount: recipients.length,
        totalLamports: merkle.totalLamports,
        wallets: recipients.map((row) => row.walletAddress),
        note: "DB settlement is ready. Claims stay pending until cron:publish-recruiter-settlement-root marks claim_open.",
      }],
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
