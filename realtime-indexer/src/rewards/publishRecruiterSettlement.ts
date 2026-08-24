import { PublicKey } from "@solana/web3.js";
import { pool } from "../db.js";
import { listRecruiterClaimableSettlements } from "./recruiterAdmin.js";
import { buildRecruiterMerkle, i64leBytes } from "./recruiterMerkle.js";

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

  const byWallet = new Map<string, { walletAddress: string; amountLamports: string; portal?: PortalPayout }>();
  for (const row of viewRows) {
    if (Number(row.chainId) !== chainId) continue;
    if (BigInt(row.claimableAmount || "0") <= 0n) continue;
    byWallet.set(row.walletAddress, { walletAddress: row.walletAddress, amountLamports: String(row.claimableAmount) });
  }
  for (const row of portal) {
    const prev = byWallet.get(row.payoutWallet);
    const amount = prev
      ? (BigInt(prev.amountLamports) + BigInt(row.amountRaw)).toString()
      : row.amountRaw;
    byWallet.set(row.payoutWallet, { walletAddress: row.payoutWallet, amountLamports: amount, portal: row });
  }

  const recipients = [...byWallet.values()].filter((item) => BigInt(item.amountLamports) > 0n);
  if (!recipients.length) {
    return { computedAt: new Date().toISOString(), batches: [] };
  }

  const existing = await pool.query(
    `select id, status from public.solana_reward_lane_batches
      where chain_id=$1 and lane='recruiter' and epoch_id=$2
      limit 1`,
    [chainId, epoch.id],
  );
  if (existing.rows[0]) {
    return {
      computedAt: new Date().toISOString(),
      batches: [{
        chainId,
        epochId: epoch.id,
        status: existing.rows[0].status,
        alreadyExisted: true,
        recipientCount: recipients.length,
      }],
    };
  }

  const merkle = buildRecruiterMerkle(epoch.id, recipients);
  const addresses = laneAddresses(epoch.id);
  const deadline = Math.floor(new Date(epoch.endAt).getTime() / 1000) + 90 * 86400;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const batch = await client.query(
      `insert into public.solana_reward_lane_batches (
         chain_id, lane, epoch_id, program_id, vault_address, batch_address,
         merkle_root, total_lamports, deadline, status, metadata
       ) values (
         $1, 'recruiter', $2, $3, $4, $5, $6, $7::numeric, $8, 'ready', $9::jsonb
       )
       on conflict (chain_id, lane, epoch_id) do nothing
       returning id, status`,
      [
        chainId,
        epoch.id,
        addresses.programId,
        addresses.vaultAddress,
        addresses.batchAddress,
        merkle.root,
        merkle.totalLamports,
        deadline,
        JSON.stringify({ startAt: epoch.startAt, endAt: epoch.endAt }),
      ],
    );
    const batchId = batch.rows[0]?.id;
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
      if (recipient.portal?.accountId) {
        const claim = await client.query(
          `insert into public.recruiter_reward_claims (
             recruiter_id, chain, token, amount_raw, payout_wallet, status, metadata
           ) values ($1, 'solana', 'SOL', $2::numeric, $3, 'created', $4::jsonb)
           returning id`,
          [
            recipient.portal.accountId,
            recipient.amountLamports,
            recipient.walletAddress,
            JSON.stringify({ epochId: epoch.id, ledgerIds: recipient.portal.ledgerIds }),
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
          [recruiterClaimId, recipient.portal.accountId],
        );
      }
      await client.query(
        `insert into public.solana_reward_lane_claims (
           batch_id, lane, source_type, source_ref, wallet_address, amount_lamports,
           merkle_proof, claim_receipt_address, status, metadata
         ) values (
           $1, 'recruiter', $2, $3, $4, $5::numeric, $6::jsonb, $7, 'pending', $8::jsonb
         )
         on conflict (lane, source_type, source_ref) do nothing`,
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
        alreadyExisted: false,
        recipientCount: recipients.length,
        totalLamports: merkle.totalLamports,
        note: "DB settlement materialized. On-chain root publish is a separate operator step; claims stay pending until status=claim_open.",
      }],
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
