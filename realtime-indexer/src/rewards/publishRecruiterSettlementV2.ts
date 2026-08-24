import { PublicKey } from "@solana/web3.js";
import { pool } from "../db.js";
import { listRecruiterClaimableSettlements } from "./recruiterAdmin.js";
import { buildRecruiterMerkle, i64leBytes, mergeRecruiterEntitlements } from "./recruiterMerkle.js";

const CONFIG_SEED = Buffer.from("rewards_config");
const VAULT_SEED = Buffer.from("recruiter_vault");
const BATCH_SEED = Buffer.from("recruiter_batch");
const CLAIM_SEED = Buffer.from("recruiter_claim");
const CHAIN_ID = 101;
const BATCH_STATUS_PREPARED = "prepared";
const CLAIM_STATUS_PREPARED = "prepared";
const IMMUTABLE_BATCH_STATUSES = new Set(["published", "claim_open", "closed", "failed"]);

const NON_PAYOUT_SOLANA = new Set([
  "So11111111111111111111111111111111111111112", // wrapped SOL mint, never a user wallet
  "11111111111111111111111111111111", // system program
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // token program
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // associated token program
]);

function buildSha(): string {
  return String(
    process.env.SOURCE_COMMIT
      || process.env.COOLIFY_GIT_COMMIT_SHA
      || process.env.GIT_SHA
      || process.env.GIT_COMMIT
      || "unset",
  ).trim();
}

function rewardsProgramId(): PublicKey {
  const raw = String(process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || "").trim();
  if (!raw) throw new Error("SOLANA_REWARDS_TREASURY_PROGRAM_ID is required");
  return new PublicKey(raw);
}

function isUserSolanaPayoutWallet(value: string): boolean {
  const wallet = String(value || "").trim();
  if (!wallet || NON_PAYOUT_SOLANA.has(wallet)) return false;
  try {
    const key = new PublicKey(wallet);
    if (key.equals(rewardsProgramId())) return false;
    return true;
  } catch {
    return false;
  }
}

function laneAddresses(epochId: string | number, walletAddress?: string | null) {
  const pid = rewardsProgramId();
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
  return { start: new Date(thisMonday.getTime() - 7 * 86400_000), end: thisMonday };
}

async function ensureWeeklyEpoch(): Promise<{ id: number; startAt: Date; endAt: Date }> {
  const window = previousWeeklyWindow();
  const existing = await pool.query(
    `select id, start_at, end_at
       from public.epochs
      where chain_id=$1 and epoch_type='weekly' and start_at=$2::timestamptz
      limit 1`,
    [CHAIN_ID, window.start.toISOString()],
  );
  if (existing.rows[0]) {
    return {
      id: Number(existing.rows[0].id),
      startAt: new Date(existing.rows[0].start_at),
      endAt: new Date(existing.rows[0].end_at),
    };
  }
  const inserted = await pool.query(
    `insert into public.epochs (chain_id, epoch_type, start_at, end_at, status, finalized_at)
     values ($1, 'weekly', $2::timestamptz, $3::timestamptz, 'finalized', now())
     on conflict (chain_id, epoch_type, start_at)
     do update set status = public.epochs.status
     returning id, start_at, end_at`,
    [CHAIN_ID, window.start.toISOString(), window.end.toISOString()],
  );
  return {
    id: Number(inserted.rows[0].id),
    startAt: new Date(inserted.rows[0].start_at),
    endAt: new Date(inserted.rows[0].end_at),
  };
}

function claimDeadlineUnix(epochEnd: Date): number {
  return Math.floor(epochEnd.getTime() / 1000) + 90 * 86400;
}

type PortalPayout = {
  accountId: string;
  payoutWallet: string;
  amountRaw: string;
  ledgerIds: string[];
};

async function loadPortalPayouts(): Promise<{ payouts: PortalPayout[]; excluded: Array<{ wallet: string; amountRaw: string }> }> {
  const { rows } = await pool.query(
    `select l.recruiter_id::text as account_id,
            w.wallet_address as payout_wallet,
            coalesce(sum(l.amount_raw), 0)::numeric(78,0)::text as amount_raw,
            array_agg(l.id::text) as ledger_ids
       from public.recruiter_reward_ledger l
       join public.recruiter_payout_wallets w
         on w.recruiter_id = l.recruiter_id
        and w.chain = 'solana'
        and w.verified_at is not null
      where l.chain = 'solana'
        and l.status in ('claimable','retriable')
        and l.claim_id is null
      group by l.recruiter_id, w.wallet_address
     having coalesce(sum(l.amount_raw), 0) > 0`,
  );

  const payouts: PortalPayout[] = [];
  const excluded: Array<{ wallet: string; amountRaw: string }> = [];
  for (const row of rows) {
    const payout = {
      accountId: String(row.account_id),
      payoutWallet: String(row.payout_wallet || ""),
      amountRaw: String(row.amount_raw || "0"),
      ledgerIds: Array.isArray(row.ledger_ids) ? row.ledger_ids.map(String) : [],
    };
    if (!isUserSolanaPayoutWallet(payout.payoutWallet)) {
      excluded.push({ wallet: payout.payoutWallet, amountRaw: payout.amountRaw });
      continue;
    }
    payouts.push(payout);
  }
  return { payouts, excluded };
}

async function assertSchemaContract(client: { query: typeof pool.query }) {
  const batch = await client.query(
    `select pg_get_constraintdef(c.oid) as def
       from pg_constraint c
      where c.conrelid='public.solana_reward_lane_batches'::regclass
        and c.conname='solana_reward_lane_batches_status_check'`,
  );
  const claims = await client.query(
    `select pg_get_constraintdef(c.oid) as def
       from pg_constraint c
      where c.conrelid='public.solana_reward_lane_claims'::regclass
        and c.conname='solana_reward_lane_claims_status_check'`,
  );
  const recruiterClaimsCols = await client.query(
    `select column_name from information_schema.columns
      where table_schema='public' and table_name='recruiter_reward_claims'`,
  );
  const batchDef = String(batch.rows[0]?.def || "");
  const claimDef = String(claims.rows[0]?.def || "");
  const recruiterColumns = new Set(recruiterClaimsCols.rows.map((row) => String(row.column_name)));
  if (!batchDef.includes("'prepared'")) throw new Error(`Schema contract: batch status 'prepared' not allowed: ${batchDef}`);
  if (!claimDef.includes("'prepared'") || !claimDef.includes("'claimable'")) {
    throw new Error(`Schema contract: claim statuses prepared/claimable not allowed: ${claimDef}`);
  }
  if (recruiterColumns.has("metadata")) {
    console.warn("[exportRecruiterSettlementBatch] recruiter_reward_claims.metadata exists but exporter intentionally does not depend on it");
  }
}

async function clearPreparedBatch(client: { query: typeof pool.query }, batchId: string) {
  const refs = await client.query(
    `select source_ref
       from public.solana_reward_lane_claims
      where batch_id=$1
        and source_type='recruiter_reward_claim'`,
    [batchId],
  );
  const claimIds = refs.rows
    .map((row) => String(row.source_ref || ""))
    .filter((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));

  if (claimIds.length) {
    await client.query(
      `update public.recruiter_reward_ledger
          set claim_id=null, updated_at=now()
        where claim_id = any($1::uuid[])`,
      [claimIds],
    );
  }
  await client.query(`delete from public.solana_reward_lane_claims where batch_id=$1`, [batchId]);
  if (claimIds.length) {
    await client.query(
      `delete from public.recruiter_reward_claims
        where id = any($1::uuid[])
          and chain='solana'
          and status in ('created','retriable','failed')`,
      [claimIds],
    );
  }
}

export async function publishRecruiterSettlementBatchesV2(): Promise<{
  computedAt: string;
  BUILD_SHA: string;
  batches: Array<Record<string, unknown>>;
}> {
  const epoch = await ensureWeeklyEpoch();
  const { payouts: portal, excluded } = await loadPortalPayouts();

  let phase2: Awaited<ReturnType<typeof listRecruiterClaimableSettlements>> = [];
  try {
    phase2 = await listRecruiterClaimableSettlements({ chainId: CHAIN_ID, limit: 1000 });
  } catch (error: any) {
    if (String(error?.code) !== "42P01") throw error;
    console.warn(`[exportRecruiterSettlementBatch] phase2 view missing: ${error?.message || error}`);
  }

  const portalByWallet = new Map(portal.map((row) => [row.payoutWallet, row]));
  const recipients = mergeRecruiterEntitlements(
    phase2
      .filter((row) => Number(row.chainId) === CHAIN_ID && isUserSolanaPayoutWallet(row.walletAddress))
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

  const portalTotal = portal.reduce((sum, row) => sum + BigInt(row.amountRaw), 0n);
  const mergedTotal = recipients.reduce((sum, row) => sum + BigInt(row.amountLamports), 0n);
  const diag = {
    BUILD_SHA: buildSha(),
    chainId: CHAIN_ID,
    epochId: epoch.id,
    epochStart: epoch.startAt.toISOString(),
    epochEnd: epoch.endAt.toISOString(),
    phase2Rows: phase2.length,
    portalRows: portal.length,
    excludedPortalRows: excluded.length,
    excludedPortalWallets: excluded,
    portalTotalLamports: portalTotal.toString(),
    mergedRecipients: recipients.length,
    mergedTotalLamports: mergedTotal.toString(),
    rewardsProgramId: rewardsProgramId().toBase58(),
  };
  console.log("[exportRecruiterSettlementBatch] diag", JSON.stringify(diag));
  if (!recipients.length || mergedTotal <= 0n) {
    throw new Error(`No valid recruiter settlement recipients. ${JSON.stringify(diag)}`);
  }

  const merkle = buildRecruiterMerkle(epoch.id, recipients);
  const addresses = laneAddresses(epoch.id);
  const deadline = claimDeadlineUnix(epoch.endAt);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertSchemaContract(client);

    const existing = await client.query(
      `select id, status
         from public.solana_reward_lane_batches
        where lane='recruiter' and chain_id=$1 and epoch_id=$2
        for update`,
      [CHAIN_ID, epoch.id],
    );
    const existingRow = existing.rows[0];
    if (existingRow && IMMUTABLE_BATCH_STATUSES.has(String(existingRow.status))) {
      await client.query("rollback");
      return {
        computedAt: new Date().toISOString(),
        BUILD_SHA: buildSha(),
        batches: [{
          chainId: CHAIN_ID,
          epochId: epoch.id,
          status: String(existingRow.status),
          immutable: true,
          note: "Existing batch is already past prepared state; exporter will not mutate it.",
        }],
      };
    }

    let batchId: string;
    if (existingRow) {
      batchId = String(existingRow.id);
      await clearPreparedBatch(client, batchId);
      await client.query(
        `update public.solana_reward_lane_batches
            set epoch_start=$2::timestamptz,
                epoch_end=$3::timestamptz,
                merkle_root=$4,
                total_lamports=$5::numeric,
                claim_deadline=$6::bigint,
                deadline=$6::bigint,
                program_id=$7,
                vault_address=$8,
                batch_address=$9,
                status='prepared',
                metadata=$10::jsonb,
                updated_at=now()
          where id=$1`,
        [
          batchId,
          epoch.startAt,
          epoch.endAt,
          merkle.root,
          merkle.totalLamports,
          deadline,
          addresses.programId,
          addresses.vaultAddress,
          addresses.batchAddress,
          JSON.stringify({ startAt: epoch.startAt, endAt: epoch.endAt, deadline, rebuiltAt: new Date().toISOString() }),
        ],
      );
    } else {
      const inserted = await client.query(
        `insert into public.solana_reward_lane_batches (
           lane, chain_id, epoch_id, epoch_start, epoch_end, merkle_root, total_lamports,
           claim_deadline, program_id, vault_address, batch_address, status, metadata, deadline
         ) values (
           'recruiter', $1, $2, $3::timestamptz, $4::timestamptz, $5, $6::numeric,
           $7::bigint, $8, $9, $10, 'prepared', $11::jsonb, $7::bigint
         )
         returning id`,
        [
          CHAIN_ID,
          epoch.id,
          epoch.startAt,
          epoch.endAt,
          merkle.root,
          merkle.totalLamports,
          deadline,
          addresses.programId,
          addresses.vaultAddress,
          addresses.batchAddress,
          JSON.stringify({ startAt: epoch.startAt, endAt: epoch.endAt, deadline }),
        ],
      );
      batchId = String(inserted.rows[0].id);
    }

    for (let i = 0; i < recipients.length; i += 1) {
      const recipient = recipients[i]!;
      const receipt = laneAddresses(epoch.id, recipient.walletAddress).claimReceiptAddress;
      if (!receipt) throw new Error(`Could not derive claim receipt for ${recipient.walletAddress}`);

      let sourceType = "recruiter_settlement";
      let sourceRef = `${epoch.id}:${recipient.walletAddress}`;
      const portalRow = portalByWallet.get(recipient.walletAddress);
      if (portalRow) {
        const claim = await client.query(
          `insert into public.recruiter_reward_claims (
             recruiter_id, chain, token, amount_raw, payout_wallet, status
           ) values ($1::uuid, 'solana', 'SOL', $2::numeric, $3, 'created')
           returning id`,
          [portalRow.accountId, recipient.amountLamports, recipient.walletAddress],
        );
        sourceType = "recruiter_reward_claim";
        sourceRef = String(claim.rows[0].id);
        await client.query(
          `update public.recruiter_reward_ledger
              set claim_id=$1::uuid, updated_at=now()
            where id = any($2::uuid[])
              and claim_id is null
              and status in ('claimable','retriable')`,
          [sourceRef, portalRow.ledgerIds],
        );
      }

      await client.query(
        `insert into public.solana_reward_lane_claims (
           batch_id, lane, source_type, source_ref, wallet_address, amount_lamports,
           merkle_leaf, merkle_proof, claim_receipt_address, status, metadata
         ) values (
           $1::uuid, 'recruiter', $2, $3, $4, $5::numeric,
           $6, $7::jsonb, $8, 'prepared', $9::jsonb
         )`,
        [
          batchId,
          sourceType,
          sourceRef,
          recipient.walletAddress,
          recipient.amountLamports,
          merkle.leaves[i],
          JSON.stringify(merkle.proofs[i] || []),
          receipt,
          JSON.stringify({ epochId: epoch.id }),
        ],
      );
    }

    const check = await client.query(
      `select b.status,
              b.total_lamports::text as total_lamports,
              count(c.id)::int as claim_count,
              coalesce(sum(c.amount_lamports),0)::numeric(78,0)::text as claims_total
         from public.solana_reward_lane_batches b
         left join public.solana_reward_lane_claims c on c.batch_id=b.id
        where b.id=$1::uuid
        group by b.id`,
      [batchId],
    );
    const row = check.rows[0];
    if (
      String(row?.status) !== BATCH_STATUS_PREPARED
      || Number(row?.claim_count || 0) !== recipients.length
      || String(row?.total_lamports || "0") !== merkle.totalLamports
      || String(row?.claims_total || "0") !== merkle.totalLamports
    ) {
      throw new Error(`Prepared batch invariant failed: ${JSON.stringify(row || {})}`);
    }

    await client.query("commit");
    return {
      computedAt: new Date().toISOString(),
      BUILD_SHA: buildSha(),
      batches: [{
        batchId,
        chainId: CHAIN_ID,
        epochId: epoch.id,
        epochStart: epoch.startAt.toISOString(),
        epochEnd: epoch.endAt.toISOString(),
        status: BATCH_STATUS_PREPARED,
        claimStatus: CLAIM_STATUS_PREPARED,
        recipientCount: recipients.length,
        totalLamports: merkle.totalLamports,
        excludedPortalRows: excluded.length,
        wallets: recipients.map((row) => row.walletAddress),
        note: "Prepared DB batch is internally reconciled. Root publication is still a separate operator step.",
      }],
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
