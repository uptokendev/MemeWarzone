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

type BatchColumn = {
  column_name: string;
  is_nullable: string;
  column_default: string | null;
  data_type: string;
  udt_name: string;
};

async function listBatchColumns(client: { query: typeof pool.query }): Promise<BatchColumn[]> {
  const { rows } = await client.query(
    `select column_name, is_nullable, column_default, data_type, udt_name
       from information_schema.columns
      where table_schema = 'public' and table_name = 'solana_reward_lane_batches'`,
  );
  return rows as BatchColumn[];
}

function claimWindowEnd(epochEnd: Date): Date {
  return new Date(epochEnd.getTime() + 90 * 86400_000);
}

function batchColumnValues(input: {
  chainId: number;
  epoch: { id: number; startAt: Date; endAt: Date };
  addresses: ReturnType<typeof laneAddresses>;
  merkleRoot: string;
  totalLamports: string;
  status: string;
  metadata: Record<string, unknown>;
}): Record<string, unknown> {
  const endAt = new Date(input.epoch.endAt);
  const claimAt = claimWindowEnd(endAt);
  const unix = Math.floor(claimAt.getTime() / 1000);
  return {
    chain_id: input.chainId,
    lane: "recruiter",
    epoch_id: input.epoch.id,
    epoch_start: input.epoch.startAt,
    epoch_end: input.epoch.endAt,
    program_id: input.addresses.programId,
    vault_address: input.addresses.vaultAddress,
    batch_address: input.addresses.batchAddress,
    merkle_root: input.merkleRoot,
    total_lamports: input.totalLamports,
    deadline: unix,
    claim_deadline: claimAt.toISOString(),
    claim_deadline_at: claimAt.toISOString(),
    expires_at: claimAt.toISOString(),
    status: input.status,
    metadata: JSON.stringify(input.metadata),
  };
}

function typeNameOf(column: BatchColumn): string {
  return `${column.data_type} ${column.udt_name}`;
}

function fillRequiredBatchColumns(columns: BatchColumn[], values: Record<string, unknown>) {
  const claimAt = values.claim_deadline;
  const unix = values.deadline;
  for (const column of columns) {
    const name = column.column_name;
    const typeName = typeNameOf(column);
    if (values[name] !== undefined) {
      if (/(bigint|integer|numeric|double|real)/.test(typeName) && typeof values[name] === "string" && String(values[name]).includes("T")) {
        values[name] = unix;
      }
      continue;
    }
    if (column.column_default) continue;
    if (column.is_nullable === "YES") continue;
    if (name === "id" || name === "created_at" || name === "updated_at") continue;
    if (typeName.includes("timestamp")) values[name] = claimAt;
    else if (typeName.includes("json")) values[name] = "{}";
    else if (typeName.includes("bool")) values[name] = false;
    else if (/(bigint|integer|numeric|double|real)/.test(typeName)) values[name] = unix;
    else values[name] = "";
  }
}

async function upsertLaneBatch(
  client: { query: typeof pool.query },
  values: Record<string, unknown>,
): Promise<{ id: string; status: string } | null> {
  const columns = await listBatchColumns(client);
  fillRequiredBatchColumns(columns, values);
  const skip = new Set(["id", "created_at", "updated_at"]);
  const names = columns.map((column) => column.column_name).filter((name) => !skip.has(name) && values[name] !== undefined);
  if (!names.length) throw new Error("solana_reward_lane_batches has no writable columns");
  const params = names.map((name) => values[name]);
  const placeholders = names.map((_, index) => `$${index + 1}`);
  const updates = names
    .filter((name) => name !== "lane" && name !== "chain_id" && name !== "epoch_id")
    .map((name) => {
      if (name === "status") {
        return `status = case when public.solana_reward_lane_batches.status in ('claim_open','published') then public.solana_reward_lane_batches.status else excluded.status end`;
      }
      return `${name} = excluded.${name}`;
    });
  const hasConflictTarget = columns.some((column) => column.column_name === "epoch_id")
    && columns.some((column) => column.column_name === "chain_id")
    && columns.some((column) => column.column_name === "lane");
  const insertSql = `insert into public.solana_reward_lane_batches (${names.join(", ")})
       values (${placeholders.join(", ")})
       returning id, status`;
  const upsertSql = hasConflictTarget
    ? `insert into public.solana_reward_lane_batches (${names.join(", ")})
       values (${placeholders.join(", ")})
       on conflict (chain_id, lane, epoch_id) do update set ${updates.join(", ")}, updated_at = now()
       returning id, status`
    : insertSql;
  let inserted;
  try {
    inserted = await client.query(upsertSql, params);
  } catch (error: any) {
    if (String(error?.code) !== "42P10") throw error;
    inserted = await client.query(insertSql, params);
  }
  return inserted.rows[0] ? { id: String(inserted.rows[0].id), status: String(inserted.rows[0].status || "") } : null;
}

async function updateLaneBatch(
  client: { query: typeof pool.query },
  batchId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const columns = await listBatchColumns(client);
  fillRequiredBatchColumns(columns, values);
  const skip = new Set(["id", "created_at", "lane", "chain_id", "epoch_id"]);
  const names = columns.map((column) => column.column_name).filter((name) => !skip.has(name) && values[name] !== undefined);
  if (!names.length) return;
  const assignments = names.map((name, index) => `${name} = $${index + 2}`);
  await client.query(
    `update public.solana_reward_lane_batches
        set ${assignments.join(", ")}, updated_at = now()
      where id = $1`,
    [batchId, ...names.map((name) => values[name])],
  );
}

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
  const batchValues = batchColumnValues({
    chainId,
    epoch,
    addresses,
    merkleRoot: merkle.root,
    totalLamports: merkle.totalLamports,
    status: "ready",
    metadata: { startAt: epoch.startAt, endAt: epoch.endAt, deadline, rebuiltAt: new Date().toISOString() },
  });
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
      await updateLaneBatch(client, String(batchId), batchValues);
    } else {
      const batch = await upsertLaneBatch(client, { ...batchValues, status: "draft" });
      batchId = batch?.id || null;
      if (batch?.status && !canRebuildRecruiterBatch(String(batch.status))) {
        await client.query("rollback");
        return {
          computedAt: new Date().toISOString(),
          batches: [{ chainId, epochId: epoch.id, status: batch.status, immutable: true }],
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
