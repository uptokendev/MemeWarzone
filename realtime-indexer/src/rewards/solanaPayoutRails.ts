import { createPublicKey, randomBytes, verify as verifySignature } from "crypto";
import type { PoolClient, QueryResult } from "pg";
import { pool } from "../db.js";

const SOLANA_CHAIN_ID = 101;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const REWARD_PROGRAMS = ["recruiter", "airdrop_trader", "airdrop_creator", "squad"] as const;

export type SolanaRewardProgram = (typeof REWARD_PROGRAMS)[number];
export type SolanaPayoutStatus = "queued" | "submitted" | "confirmed" | "failed" | "cancelled";

type DbLike = {
  query: (queryTextOrConfig: string | { text: string; values?: any[]; simple?: boolean }, values?: any[]) => Promise<QueryResult<any>>;
};

function asNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function mustIso(value: unknown, label: string): string {
  const iso = toIso(value);
  if (!iso) throw new Error(`Missing ${label}`);
  return iso;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function bigintString(value: bigint): string {
  return value.toString();
}

function parseNumericBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  return BigInt(String(value ?? "0"));
}

function normalizeSolanaAddress(value: unknown): string {
  const address = String(value ?? "").trim();
  if (address.length < 32 || address.length > 44 || !SOLANA_ADDRESS_RE.test(address)) {
    throw new Error(`Invalid Solana wallet address: ${String(value ?? "")}`);
  }
  return address;
}

function normalizeProgram(value: unknown): SolanaRewardProgram {
  const program = String(value ?? "").trim() as SolanaRewardProgram;
  if (!(REWARD_PROGRAMS as readonly string[]).includes(program)) {
    throw new Error(`Invalid reward program: ${String(value ?? "")}`);
  }
  return program;
}

function normalizeSignature(value: unknown): string {
  const signature = String(value ?? "").trim();
  if (!signature) return "";
  if (signature.length >= 32 && signature.length <= 128 && SOLANA_ADDRESS_RE.test(signature)) return signature;
  if (/^[A-Za-z0-9+/=]+$/.test(signature)) return signature;
  throw new Error(`Invalid Solana signature: ${signature}`);
}

function base58Decode(value: string): Buffer {
  const bytes = [0];
  for (const char of value) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error("Invalid base58 character");
    let carry = idx;
    for (let i = 0; i < bytes.length; i++) {
      const n = bytes[i] * 58 + carry;
      bytes[i] = n & 0xff;
      carry = n >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (let i = 0; i < value.length && value[i] === "1"; i++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

function decodeSignature(value: string): Buffer {
  if (SOLANA_ADDRESS_RE.test(value)) return base58Decode(value);
  return Buffer.from(value, "base64");
}

function verifySolanaSignature(walletAddress: string, message: string, signature: string): boolean {
  const publicKeyBytes = base58Decode(walletAddress);
  const signatureBytes = decodeSignature(signature);
  if (publicKeyBytes.length !== 32 || signatureBytes.length !== 64) return false;

  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
    format: "der",
    type: "spki",
  });

  return verifySignature(null, Buffer.from(message, "utf8"), key, signatureBytes);
}

async function withTransaction<T>(fn: (client: PoolClient & DbLike) => Promise<T>): Promise<T> {
  const client = (await pool.connect()) as PoolClient & DbLike & { query: any };
  const origQuery = client.query.bind(client);

  client.query = (...args: any[]) => {
    if (typeof args[0] === "string") {
      return origQuery({ text: args[0], values: Array.isArray(args[1]) ? args[1] : undefined, simple: true });
    }
    if (args[0] && typeof args[0] === "object" && typeof args[0].text === "string") {
      return origQuery({ ...args[0], simple: true });
    }
    return origQuery.apply(client, args);
  };

  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // ignore rollback errors
    }
    throw error;
  } finally {
    // Drop the per-transaction query patch: a patched client returned to the pool drops
    // pool.query's callback and hangs the next caller forever (2026-09-25 pool starvation).
    delete (client as any).query;
    client.release();
  }
}

function mapClaimRow(row: any) {
  return {
    id: asNumber(row.id),
    walletAddress: String(row.wallet_address),
    epochId: asNumber(row.epoch_id),
    program: String(row.program),
    claimedAmount: String(row.claimed_amount ?? "0"),
    claimTxHash: row.claim_tx_hash ? String(row.claim_tx_hash) : null,
    claimedAt: mustIso(row.claimed_at, "claims.claimed_at"),
    status: String(row.status),
    metadata: asObject(row.metadata),
    createdAt: mustIso(row.created_at, "claims.created_at"),
    updatedAt: mustIso(row.updated_at, "claims.updated_at"),
  };
}

function mapPayoutIntentRow(row: any) {
  return {
    id: asNumber(row.id),
    chainId: asNumber(row.chain_id),
    walletAddress: String(row.wallet_address),
    epochId: asNumber(row.epoch_id),
    program: String(row.program),
    amountLamports: String(row.amount_lamports ?? "0"),
    status: String(row.status) as SolanaPayoutStatus,
    payoutSignature: row.payout_signature ? String(row.payout_signature) : null,
    attemptCount: asNumber(row.attempt_count),
    lastAttemptAt: toIso(row.last_attempt_at),
    submittedAt: toIso(row.submitted_at),
    confirmedAt: toIso(row.confirmed_at),
    failedAt: toIso(row.failed_at),
    errorMessage: row.error_message ? String(row.error_message) : null,
    metadata: asObject(row.metadata),
    createdAt: mustIso(row.created_at, "solana_reward_payout_intents.created_at"),
    updatedAt: mustIso(row.updated_at, "solana_reward_payout_intents.updated_at"),
  };
}

export async function createSolanaWalletVerificationChallenge(input: {
  walletAddress: string;
  ttlSeconds?: number;
}, db: DbLike = pool) {
  const walletAddress = normalizeSolanaAddress(input.walletAddress);
  const nonce = randomBytes(24).toString("hex");
  const ttlSeconds = Math.max(60, Math.min(3600, Math.trunc(input.ttlSeconds ?? 600) || 600));
  const message = [
    "MemeWarzone Solana wallet verification",
    `Wallet: ${walletAddress}`,
    `Nonce: ${nonce}`,
    "Only sign this message on memewar.zone or an authorized MemeWarzone admin surface.",
  ].join("\n");

  const result = await db.query(
    `insert into public.solana_wallet_verifications(
       wallet_address, nonce, message, status, signature, nonce_expires_at, verified_at, created_at, updated_at
     ) values (
       $1, $2, $3, 'pending', null, now() + ($4::text || ' seconds')::interval, null, now(), now()
     )
     on conflict (wallet_address) do update set
       nonce = excluded.nonce,
       message = excluded.message,
       status = 'pending',
       signature = null,
       nonce_expires_at = excluded.nonce_expires_at,
       verified_at = null,
       updated_at = now()
     returning wallet_address, nonce, message, status, nonce_expires_at, verified_at, created_at, updated_at`,
    [walletAddress, nonce, message, String(ttlSeconds)],
  );

  const row = result.rows[0];
  return {
    walletAddress: String(row.wallet_address),
    nonce: String(row.nonce),
    message: String(row.message),
    status: String(row.status),
    nonceExpiresAt: mustIso(row.nonce_expires_at, "solana_wallet_verifications.nonce_expires_at"),
    verifiedAt: toIso(row.verified_at),
    createdAt: mustIso(row.created_at, "solana_wallet_verifications.created_at"),
    updatedAt: mustIso(row.updated_at, "solana_wallet_verifications.updated_at"),
  };
}

export async function verifySolanaWalletChallenge(input: {
  walletAddress: string;
  signature: string;
  nonce?: string | null;
}, db: DbLike = pool) {
  const walletAddress = normalizeSolanaAddress(input.walletAddress);
  const signature = normalizeSignature(input.signature);

  const existing = await db.query(
    `select *
       from public.solana_wallet_verifications
      where wallet_address = $1
      limit 1`,
    [walletAddress],
  );

  const row = existing.rows[0];
  if (!row || String(row.status) !== "pending") throw new Error("No pending Solana wallet verification challenge");
  if (input.nonce && String(row.nonce) !== String(input.nonce)) throw new Error("Verification nonce mismatch");
  if (new Date(String(row.nonce_expires_at)).getTime() <= Date.now()) {
    await db.query(
      `update public.solana_wallet_verifications
          set status = 'expired', updated_at = now()
        where wallet_address = $1`,
      [walletAddress],
    );
    throw new Error("Solana wallet verification challenge expired");
  }

  if (!verifySolanaSignature(walletAddress, String(row.message), signature)) {
    throw new Error("Invalid Solana wallet signature");
  }

  const updated = await db.query(
    `update public.solana_wallet_verifications
        set status = 'verified', signature = $2, verified_at = now(), updated_at = now()
      where wallet_address = $1
      returning wallet_address, status, verified_at, updated_at`,
    [walletAddress, signature],
  );

  return {
    walletAddress: String(updated.rows[0].wallet_address),
    status: String(updated.rows[0].status),
    verifiedAt: mustIso(updated.rows[0].verified_at, "solana_wallet_verifications.verified_at"),
    updatedAt: mustIso(updated.rows[0].updated_at, "solana_wallet_verifications.updated_at"),
  };
}

async function requireVerifiedSolanaWallet(db: DbLike, walletAddress: string) {
  const result = await db.query(
    `select verified_at
       from public.solana_wallet_verifications
      where wallet_address = $1
        and status = 'verified'
        and verified_at >= now() - interval '30 days'
      limit 1`,
    [walletAddress],
  );
  if (!result.rowCount) throw new Error("Solana wallet must be verified before recording a native reward claim");
}

export async function recordSolanaRewardClaim(input: {
  walletAddress: string;
  epochId: number;
  program: SolanaRewardProgram;
  payoutSignature?: string | null;
  claimedAt?: Date;
  metadata?: Record<string, unknown> | null;
  requireVerifiedWallet?: boolean;
}) {
  return withTransaction(async (db) => {
    const walletAddress = normalizeSolanaAddress(input.walletAddress);
    const program = normalizeProgram(input.program);
    const epochId = Number(input.epochId);
    const claimedAt = input.claimedAt ?? new Date();
    const payoutSignature = input.payoutSignature ? normalizeSignature(input.payoutSignature) : null;
    if (!Number.isFinite(epochId) || epochId <= 0) throw new Error("Invalid epochId");

    if (input.requireVerifiedWallet !== false) await requireVerifiedSolanaWallet(db, walletAddress);

    const epoch = await db.query(`select chain_id from public.epochs where id = $1 limit 1`, [epochId]);
    if (!epoch.rowCount || Number(epoch.rows[0].chain_id) !== SOLANA_CHAIN_ID) {
      throw new Error("Solana reward claims require a chainId=101 epoch");
    }

    const existingClaim = await db.query(
      `select *
         from public.claims
        where wallet_address = $1
          and epoch_id = $2
          and program = $3
          and status = 'recorded'
        order by claimed_at desc, id desc
        limit 1`,
      [walletAddress, epochId, program],
    );
    if (existingClaim.rowCount) throw new Error(`Reward already claimed for ${walletAddress} in epoch ${epochId} (${program})`);

    const ledgerRows = await db.query(
      `select *
         from public.reward_ledger_entries
        where epoch_id = $1
          and wallet_address = $2
          and program = $3
          and status = 'claimable'
          and (claim_deadline_at is null or claim_deadline_at > $4)
        order by id asc
        for update`,
      [epochId, walletAddress, program, claimedAt],
    );
    if (!ledgerRows.rowCount) throw new Error(`No claimable ${program} entries for ${walletAddress} in epoch ${epochId}`);

    let claimedAmount = 0n;
    const ledgerEntryIds: number[] = [];
    for (const row of ledgerRows.rows) {
      claimedAmount += parseNumericBigInt(row.net_amount);
      ledgerEntryIds.push(asNumber(row.id));
    }

    const intent = await db.query(
      `insert into public.solana_reward_payout_intents(
         chain_id, wallet_address, epoch_id, program, amount_lamports,
         status, payout_signature, attempt_count, last_attempt_at,
         submitted_at, confirmed_at, failed_at, error_message, metadata, created_at, updated_at
       ) values (
         $1, $2, $3, $4, $5,
         $6, $7, case when $7::text is null then 0 else 1 end, case when $7::text is null then null else $8 end,
         case when $7::text is null then null else $8 end,
         case when $7::text is null then null else $8 end,
         null, null, $9::jsonb, now(), now()
       )
       on conflict (chain_id, wallet_address, epoch_id, program) do update set
         amount_lamports = excluded.amount_lamports,
         status = case
           when public.solana_reward_payout_intents.status = 'confirmed' then 'confirmed'
           else excluded.status
         end,
         payout_signature = coalesce(excluded.payout_signature, public.solana_reward_payout_intents.payout_signature),
         attempt_count = greatest(public.solana_reward_payout_intents.attempt_count, excluded.attempt_count),
         last_attempt_at = coalesce(excluded.last_attempt_at, public.solana_reward_payout_intents.last_attempt_at),
         submitted_at = coalesce(excluded.submitted_at, public.solana_reward_payout_intents.submitted_at),
         confirmed_at = coalesce(excluded.confirmed_at, public.solana_reward_payout_intents.confirmed_at),
         metadata = public.solana_reward_payout_intents.metadata || excluded.metadata,
         updated_at = now()
       returning *`,
      [
        SOLANA_CHAIN_ID,
        walletAddress,
        epochId,
        program,
        bigintString(claimedAmount),
        payoutSignature ? "confirmed" : "queued",
        payoutSignature,
        claimedAt,
        JSON.stringify({ ...(input.metadata ?? {}), ledgerEntryIds, payoutRail: "solana_native" }),
      ],
    );

    if (!payoutSignature) {
      return {
        claim: null,
        payoutIntent: mapPayoutIntentRow(intent.rows[0]),
        ledgerEntryCount: ledgerEntryIds.length,
        claimedAmount: bigintString(claimedAmount),
        status: "queued",
      };
    }

    const claimInsert = await db.query(
      `insert into public.claims(
         wallet_address, epoch_id, program, claimed_amount,
         claim_tx_hash, claimed_at, status, metadata, created_at, updated_at
       ) values (
         $1, $2, $3, $4,
         $5, $6, 'recorded', $7::jsonb, now(), now()
       )
       returning *`,
      [
        walletAddress,
        epochId,
        program,
        bigintString(claimedAmount),
        payoutSignature,
        claimedAt,
        JSON.stringify({ ...(input.metadata ?? {}), ledgerEntryIds, partialClaimSupported: false, payoutRail: "solana_native" }),
      ],
    );

    const updated = await db.query(
      `update public.reward_ledger_entries
          set status = 'claimed',
              claimed_at = $2,
              updated_at = now()
        where id = any($1::bigint[])
          and status = 'claimable'`,
      [ledgerEntryIds, claimedAt],
    );
    if ((updated.rowCount ?? 0) !== ledgerEntryIds.length) {
      throw new Error(`Claim state changed while processing ${walletAddress} in epoch ${epochId} (${program})`);
    }

    return {
      claim: mapClaimRow(claimInsert.rows[0]),
      payoutIntent: mapPayoutIntentRow(intent.rows[0]),
      ledgerEntryCount: ledgerEntryIds.length,
      claimedAmount: bigintString(claimedAmount),
      status: "confirmed",
    };
  });
}

export async function listSolanaRewardClaims(filters: {
  walletAddress?: string | null;
  epochId?: number | null;
  program?: SolanaRewardProgram | null;
  limit?: number;
}, db: DbLike = pool) {
  const clauses = ["1=1"];
  const values: any[] = [];

  if (filters.walletAddress) {
    values.push(normalizeSolanaAddress(filters.walletAddress));
    clauses.push(`wallet_address = $${values.length}`);
  }
  if (filters.epochId != null) {
    values.push(filters.epochId);
    clauses.push(`epoch_id = $${values.length}`);
  }
  if (filters.program) {
    values.push(normalizeProgram(filters.program));
    clauses.push(`program = $${values.length}`);
  }

  values.push(Math.max(1, Math.min(500, Math.trunc(filters.limit ?? 50) || 50)));
  const result = await db.query(
    `select c.*
       from public.claims c
       join public.epochs e on e.id = c.epoch_id
      where e.chain_id = 101
        and ${clauses.join(" and ")}
      order by c.claimed_at desc, c.id desc
      limit $${values.length}`,
    values,
  );
  return result.rows.map(mapClaimRow);
}

export async function listSolanaPayoutIntents(filters: {
  walletAddress?: string | null;
  epochId?: number | null;
  program?: SolanaRewardProgram | null;
  status?: SolanaPayoutStatus | null;
  limit?: number;
}, db: DbLike = pool) {
  const clauses = ["chain_id = 101"];
  const values: any[] = [];

  if (filters.walletAddress) {
    values.push(normalizeSolanaAddress(filters.walletAddress));
    clauses.push(`wallet_address = $${values.length}`);
  }
  if (filters.epochId != null) {
    values.push(filters.epochId);
    clauses.push(`epoch_id = $${values.length}`);
  }
  if (filters.program) {
    values.push(normalizeProgram(filters.program));
    clauses.push(`program = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    clauses.push(`status = $${values.length}`);
  }

  values.push(Math.max(1, Math.min(500, Math.trunc(filters.limit ?? 100) || 100)));
  const result = await db.query(
    `select *
       from public.solana_reward_payout_intents
      where ${clauses.join(" and ")}
      order by updated_at desc, id desc
      limit $${values.length}`,
    values,
  );
  return result.rows.map(mapPayoutIntentRow);
}

export async function updateSolanaPayoutIntentStatus(input: {
  payoutIntentId: number;
  status: SolanaPayoutStatus;
  payoutSignature?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown> | null;
}, db: DbLike = pool) {
  const id = Number(input.payoutIntentId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Invalid payoutIntentId");
  const signature = input.payoutSignature ? normalizeSignature(input.payoutSignature) : null;

  const result = await db.query(
    `update public.solana_reward_payout_intents
        set status = $2,
            payout_signature = coalesce($3, payout_signature),
            attempt_count = case when $2 in ('submitted', 'failed') then attempt_count + 1 else attempt_count end,
            last_attempt_at = case when $2 in ('submitted', 'failed') then now() else last_attempt_at end,
            submitted_at = case when $2 = 'submitted' then coalesce(submitted_at, now()) else submitted_at end,
            confirmed_at = case when $2 = 'confirmed' then coalesce(confirmed_at, now()) else confirmed_at end,
            failed_at = case when $2 = 'failed' then coalesce(failed_at, now()) else null end,
            error_message = $4,
            metadata = metadata || $5::jsonb,
            updated_at = now()
      where id = $1
      returning *`,
    [id, input.status, signature, input.errorMessage ?? null, JSON.stringify(input.metadata ?? {})],
  );

  if (!result.rowCount) throw new Error("Solana payout intent not found");
  return mapPayoutIntentRow(result.rows[0]);
}

export async function listSolanaRecruiterClaimableSettlements(filters: {
  epochId?: number | null;
  recruiterId?: number | null;
  recruiterCode?: string | null;
  walletAddress?: string | null;
  limit?: number;
}, db: DbLike = pool) {
  const clauses = ["chain_id = 101"];
  const values: any[] = [];

  if (filters.epochId != null) {
    values.push(filters.epochId);
    clauses.push(`epoch_id = $${values.length}`);
  }
  if (filters.recruiterId != null) {
    values.push(filters.recruiterId);
    clauses.push(`recruiter_id = $${values.length}`);
  }
  if (filters.recruiterCode) {
    values.push(String(filters.recruiterCode).trim().toLowerCase());
    clauses.push(`lower(recruiter_code) = $${values.length}`);
  }
  if (filters.walletAddress) {
    values.push(normalizeSolanaAddress(filters.walletAddress));
    clauses.push(`wallet_address = $${values.length}`);
  }

  values.push(Math.max(1, Math.min(500, Math.trunc(filters.limit ?? 100) || 100)));
  const result = await db.query(
    `select *
       from public.recruiter_claimable_settlements
      where ${clauses.join(" and ")}
      order by end_at desc, epoch_id desc, wallet_address asc
      limit $${values.length}`,
    values,
  );

  return result.rows.map((row: any) => ({
    epochId: asNumber(row.epoch_id),
    chainId: asNumber(row.chain_id),
    epochType: String(row.epoch_type),
    startAt: mustIso(row.start_at, "recruiter_claimable_settlements.start_at"),
    endAt: mustIso(row.end_at, "recruiter_claimable_settlements.end_at"),
    recruiterId: row.recruiter_id != null ? asNumber(row.recruiter_id) : null,
    recruiterWalletAddress: row.recruiter_wallet_address != null ? String(row.recruiter_wallet_address) : null,
    recruiterCode: row.recruiter_code != null ? String(row.recruiter_code) : null,
    recruiterDisplayName: row.recruiter_display_name != null ? String(row.recruiter_display_name) : null,
    recruiterIsOg: Boolean(row.recruiter_is_og),
    recruiterStatus: row.recruiter_status != null ? String(row.recruiter_status) : null,
    recruiterClosedAt: toIso(row.recruiter_closed_at),
    walletAddress: String(row.wallet_address),
    claimableEntryCount: asNumber(row.claimable_entry_count),
    claimableAmount: String(row.claimable_amount ?? "0"),
    firstClaimableAt: toIso(row.first_claimable_at),
    claimDeadlineAt: toIso(row.claim_deadline_at),
    ledgerEntryIds: Array.isArray(row.ledger_entry_ids) ? row.ledger_entry_ids.map((value: unknown) => asNumber(value)) : [],
    materializedAt: mustIso(row.materialized_at, "recruiter_claimable_settlements.materialized_at"),
  }));
}
