import { createHash, randomUUID } from "crypto";
import fs from "node:fs";
import os from "node:os";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { pool } from "./db.js";
import { ENV } from "./env.js";
import { deriveFeeEscrowAddress } from "./solanaIndexer.js";
import { ACQUIRE_LEASE_SQL, CLAIM_FLUSH_SQL, CLAIM_INIT_SQL } from "./solanaFeeEscrowClaimSql.js";

const SOLANA_CHAIN_ID = 101;
const DEFAULT_PROGRAM_ID = "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt";
const DEFAULT_TREASURY = "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX";
const CAMPAIGN_CURVE_CLOSED_OFFSET = 714;
const FEE_ESCROW_PENDING_OFFSET = 8 + 32;
const FEE_ESCROW_PENDING_LANES = 6;
const WORKER_NAME = "solana-fee-escrow-worker";
const DEFAULT_FLUSH_THRESHOLD_LAMPORTS = 10_000_000n;
const LEASE_TTL_SECONDS = 60;
const OWNER_ID = `${os.hostname()}:${process.pid}:${randomUUID()}`;
const INIT_BACKOFF_SECONDS = [15, 30, 60, 120, 300];

let workerStarted = false;
let tickRunning = false;
let tickCount = 0;

const INIT_DISC = createHash("sha256").update("global:initialize_fee_escrow").digest().subarray(0, 8);
const FLUSH_DISC = createHash("sha256").update("global:flush_campaign_fees").digest().subarray(0, 8);
const CLOSE_TRADE_AUTH_DISC = createHash("sha256")
  .update("global:close_expired_trade_authorization")
  .digest()
  .subarray(0, 8);

function programId(): PublicKey {
  return new PublicKey(String(ENV.SOLANA_LAUNCHPAD_PROGRAM_ID || DEFAULT_PROGRAM_ID).trim());
}

function treasuryId(): PublicKey {
  return new PublicKey(
    String(process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || DEFAULT_TREASURY).trim(),
  );
}

function rpcUrl(): string {
  return String(ENV.SOLANA_RPC_HTTP || process.env.SOLANA_RPC_URL || process.env.SOLANA_RPC || "").trim();
}

function workerIntervalMs(): number {
  return Math.max(5_000, Number(process.env.SOLANA_FEE_ESCROW_WORKER_INTERVAL_MS || 15_000));
}

function flushThresholdLamports(): bigint {
  const raw = process.env.SOLANA_FEE_ESCROW_FLUSH_THRESHOLD_LAMPORTS;
  if (raw == null || raw === "") return DEFAULT_FLUSH_THRESHOLD_LAMPORTS;
  try {
    const parsed = BigInt(raw);
    return parsed > 0n ? parsed : DEFAULT_FLUSH_THRESHOLD_LAMPORTS;
  } catch {
    return DEFAULT_FLUSH_THRESHOLD_LAMPORTS;
  }
}

function initBackoffSeconds(attempts: number): number {
  const index = Math.max(0, Math.min(INIT_BACKOFF_SECONDS.length - 1, attempts - 1));
  return INIT_BACKOFF_SECONDS[index];
}

async function acquireLease(): Promise<boolean> {
  try {
    const result = await pool.query(ACQUIRE_LEASE_SQL, [WORKER_NAME, OWNER_ID, LEASE_TTL_SECONDS]);
    return String(result.rows[0]?.owner_id || "") === OWNER_ID;
  } catch (error) {
    console.warn(
      "[solana-fee-escrow] lease query failed",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

function flushMaxAgeMs(): number {
  return Math.max(1_000, Number(process.env.SOLANA_FEE_ESCROW_FLUSH_MAX_AGE_MS || 120_000));
}

function loadPayer(): Keypair | null {
  const file = String(process.env.SOLANA_FEE_ESCROW_PAYER_KEYPAIR || "").trim();
  if (file) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  }
  const secret = String(process.env.SOLANA_FEE_ESCROW_PAYER_SECRET || "").trim();
  if (!secret) return null;
  const parsed = JSON.parse(secret);
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

function vaultPda(seed: string): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(seed)], treasuryId())[0];
}

function pendingFromEscrowData(data: Buffer): bigint {
  if (data.length < FEE_ESCROW_PENDING_OFFSET + FEE_ESCROW_PENDING_LANES * 8) return 0n;
  let total = 0n;
  for (let i = 0; i < FEE_ESCROW_PENDING_LANES; i += 1) {
    total += data.readBigUInt64LE(FEE_ESCROW_PENDING_OFFSET + i * 8);
  }
  return total;
}

function campaignCurveClosed(data: Buffer): boolean {
  return data.length > CAMPAIGN_CURVE_CLOSED_OFFSET && data[CAMPAIGN_CURVE_CLOSED_OFFSET] === 1;
}

async function markInit(
  campaign: string,
  status: "initialized" | "failed",
  signature?: string,
  error?: string,
  attempts = 0,
) {
  await pool.query(
    `update public.solana_fee_escrow_accruals
        set init_status=$3,
            init_signature=coalesce($4, init_signature),
            last_error=$5,
            init_attempts = $6,
            last_init_attempt_at = now(),
            next_init_attempt_at = case
              when $3 = 'failed' then now() + make_interval(secs => $7)
              else null
            end,
            updated_at=now()
      where chain_id=$1 and campaign_address=$2`,
    [
      SOLANA_CHAIN_ID,
      campaign,
      status,
      signature || null,
      error || null,
      attempts,
      status === "failed" ? initBackoffSeconds(attempts) : 0,
    ],
  );
}

async function markFlush(
  campaign: string,
  status: "submitted" | "confirmed" | "failed" | "queued",
  signature?: string,
  error?: string,
) {
  await pool.query(
    `update public.solana_fee_escrow_accruals
        set flush_status=$3,
            last_flush_signature=coalesce($4, last_flush_signature),
            flush_attempts = flush_attempts + case when $3 in ('submitted','failed') then 1 else 0 end,
            last_error=$5,
            updated_at=now()
      where chain_id=$1 and campaign_address=$2`,
    [SOLANA_CHAIN_ID, campaign, status, signature || null, error || null],
  );
}

async function initializeOne(
  connection: Connection,
  payer: Keypair,
  campaign: PublicKey,
): Promise<string> {
  const escrow = new PublicKey(deriveFeeEscrowAddress(campaign.toBase58(), programId().toBase58()));
  const ix = new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: campaign, isSigner: false, isWritable: false },
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: INIT_DISC,
  });
  return sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer], {
    commitment: "confirmed",
  });
}

async function flushOne(
  connection: Connection,
  payer: Keypair,
  campaign: PublicKey,
  escrow: PublicKey,
): Promise<string> {
  const ix = new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: campaign, isSigner: false, isWritable: false },
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: vaultPda("league_vault"), isSigner: false, isWritable: true },
      { pubkey: vaultPda("airdrop_vault"), isSigner: false, isWritable: true },
      { pubkey: vaultPda("monthly_league_vault"), isSigner: false, isWritable: true },
      { pubkey: vaultPda("recruiter_vault"), isSigner: false, isWritable: true },
      { pubkey: vaultPda("squad_vault"), isSigner: false, isWritable: true },
      { pubkey: vaultPda("protocol_vault"), isSigner: false, isWritable: true },
    ],
    data: FLUSH_DISC,
  });
  return sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer], {
    commitment: "confirmed",
  });
}

async function processInits(connection: Connection, payer: Keypair) {
  const rows = await pool.query(
    `select campaign_address, escrow_address
       from public.solana_fee_escrow_accruals
      where chain_id=$1
        and init_status in ('pending','failed')
        and (next_init_attempt_at is null or next_init_attempt_at <= now())
      order by updated_at asc
      limit 25`,
    [SOLANA_CHAIN_ID],
  );
  for (const row of rows.rows) {
    if (!(await acquireLease())) return;
    const claimed = await pool.query(CLAIM_INIT_SQL, [SOLANA_CHAIN_ID, row.campaign_address]);
    const claimedRow = claimed.rows[0];
    if (!claimedRow) continue;
    const campaign = new PublicKey(String(claimedRow.campaign_address));
    const escrowPk = new PublicKey(
      String(claimedRow.escrow_address || deriveFeeEscrowAddress(campaign.toBase58(), programId().toBase58())),
    );
    const nextAttempts = Number(claimedRow.init_attempts || 0);
    try {
      const existing = await connection.getAccountInfo(escrowPk, "confirmed");
      if (existing && existing.owner.equals(programId()) && existing.data.length >= 8) {
        await markInit(campaign.toBase58(), "initialized", undefined, undefined, nextAttempts);
        continue;
      }
      const sig = await initializeOne(connection, payer, campaign);
      await markInit(campaign.toBase58(), "initialized", sig, undefined, nextAttempts);
      console.info("[solana-fee-escrow] initialized", campaign.toBase58(), sig);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markInit(campaign.toBase58(), "failed", undefined, message, nextAttempts);
      console.warn("[solana-fee-escrow] init failed", campaign.toBase58(), message);
    }
  }
}

const PENDING_SQL = `(weekly_accrued - weekly_flushed)
          + (monthly_accrued - monthly_flushed)
          + (recruiter_accrued - recruiter_flushed)
          + (airdrop_accrued - airdrop_flushed)
          + (squad_accrued - squad_flushed)
          + (protocol_accrued - protocol_flushed)`;

async function processFlushes(connection: Connection, payer: Keypair, reconciling: boolean) {
  const threshold = flushThresholdLamports();
  const maxAgeMs = flushMaxAgeMs();
  const rows = await pool.query(
    reconciling
      ? `select campaign_address, escrow_address, last_accrued_at, graduation_requested,
                ${PENDING_SQL} as pending_total
           from public.solana_fee_escrow_accruals
          where chain_id=$1 and init_status='initialized'
          order by last_accrued_at asc nulls last
          limit 100`
      : `select campaign_address, escrow_address, last_accrued_at, graduation_requested,
                ${PENDING_SQL} as pending_total
           from public.solana_fee_escrow_accruals
          where chain_id=$1
            and init_status='initialized'
            and (
              ${PENDING_SQL} > 0
              or graduation_requested = true
              or flush_status in ('failed', 'submitted')
            )
          order by case when graduation_requested then 0 else 1 end,
                   last_accrued_at asc nulls last
          limit 25`,
    [SOLANA_CHAIN_ID],
  );
  const now = Date.now();
  for (const row of rows.rows) {
    if (!(await acquireLease())) return;
    const campaign = new PublicKey(String(row.campaign_address));
    const escrow = new PublicKey(
      String(row.escrow_address || deriveFeeEscrowAddress(campaign.toBase58(), programId().toBase58())),
    );
    try {
      const [escrowInfo, campaignInfo] = await connection.getMultipleAccountsInfo(
        [escrow, campaign],
        "confirmed",
      );
      const onChainPending = escrowInfo?.data ? pendingFromEscrowData(Buffer.from(escrowInfo.data)) : 0n;
      const closed = campaignInfo?.data ? campaignCurveClosed(Buffer.from(campaignInfo.data)) : false;
      const dbPending = BigInt(String(row.pending_total || "0"));
      const pending = onChainPending > 0n ? onChainPending : dbPending;
      const accruedAt = row.last_accrued_at ? new Date(row.last_accrued_at).getTime() : 0;
      const aged = accruedAt > 0 && now - accruedAt >= maxAgeMs;
      const forced = Boolean(row.graduation_requested) || closed;
      if (pending <= 0n) continue;
      if (!(pending >= threshold || aged || forced)) continue;

      const claimed = await pool.query(CLAIM_FLUSH_SQL, [SOLANA_CHAIN_ID, campaign.toBase58()]);
      if (!claimed.rows[0]) continue;

      const sig = await flushOne(connection, payer, campaign, escrow);
      await markFlush(campaign.toBase58(), "confirmed", sig);
      if (forced) {
        await pool.query(
          `update public.solana_fee_escrow_accruals
              set graduation_requested=false, updated_at=now()
            where chain_id=$1 and campaign_address=$2`,
          [SOLANA_CHAIN_ID, campaign.toBase58()],
        );
      }
      console.info("[solana-fee-escrow] flushed", campaign.toBase58(), sig);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markFlush(campaign.toBase58(), "failed", undefined, message);
      console.warn("[solana-fee-escrow] flush failed", campaign.toBase58(), message);
    }
  }
}

async function closeExpiredTradeAuth(
  connection: Connection,
  payer: Keypair,
  trader: PublicKey,
  nonce: Buffer,
  pda: PublicKey,
): Promise<string> {
  const data = Buffer.concat([CLOSE_TRADE_AUTH_DISC, nonce]);
  const ix = new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: trader, isSigner: false, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
    ],
    data,
  });
  return sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer], {
    commitment: "confirmed",
  });
}

async function processTradeAuthCleanup(connection: Connection, payer: Keypair) {
  const rows = await pool.query(
    `select trader, nonce_hex, trade_auth_pda
       from public.solana_trade_authorizations
      where chain_id=$1
        and cleanup_status in ('pending', 'failed')
        and deadline < now()
      order by deadline asc
      limit 25`,
    [SOLANA_CHAIN_ID],
  );
  for (const row of rows.rows) {
    const pda = new PublicKey(String(row.trade_auth_pda));
    const trader = new PublicKey(String(row.trader));
    const nonceHex = String(row.nonce_hex || "").replace(/^0x/i, "");
    try {
      const info = await connection.getAccountInfo(pda, "confirmed");
      if (!info) {
        await pool.query(
          `update public.solana_trade_authorizations
              set cleanup_status='no_account', updated_at=now(), last_error=null
            where chain_id=$1 and trade_auth_pda=$2`,
          [SOLANA_CHAIN_ID, pda.toBase58()],
        );
        continue;
      }
      const nonce = Buffer.from(nonceHex, "hex");
      if (nonce.length !== 32) throw new Error("invalid nonce_hex");
      await pool.query(
        `update public.solana_trade_authorizations
            set cleanup_status='submitted', updated_at=now()
          where chain_id=$1 and trade_auth_pda=$2`,
        [SOLANA_CHAIN_ID, pda.toBase58()],
      );
      const sig = await closeExpiredTradeAuth(connection, payer, trader, nonce, pda);
      await pool.query(
        `update public.solana_trade_authorizations
            set cleanup_status='closed', cleanup_signature=$3, last_error=null, updated_at=now()
          where chain_id=$1 and trade_auth_pda=$2`,
        [SOLANA_CHAIN_ID, pda.toBase58(), sig],
      );
      console.info("[solana-fee-escrow] closed trade-auth", pda.toBase58(), sig);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await pool.query(
        `update public.solana_trade_authorizations
            set cleanup_status='failed', last_error=$3, updated_at=now()
          where chain_id=$1 and trade_auth_pda=$2`,
        [SOLANA_CHAIN_ID, pda.toBase58(), message],
      );
      console.warn("[solana-fee-escrow] trade-auth cleanup failed", pda.toBase58(), message);
    }
  }
}

async function runTick(connection: Connection, payer: Keypair): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const owned = await acquireLease();
    if (!owned) {
      console.info("[solana-fee-escrow] skip tick; another worker holds the lease");
      return;
    }
    await processInits(connection, payer);
    if (!(await acquireLease())) return;
    tickCount += 1;
    await processFlushes(connection, payer, tickCount % 10 === 0);
    if (!(await acquireLease())) return;
    await processTradeAuthCleanup(connection, payer);
    await acquireLease();
  } finally {
    tickRunning = false;
  }
}

export function startSolanaFeeEscrowWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  const payer = (() => {
    try {
      return loadPayer();
    } catch (error) {
      console.warn(
        "[solana-fee-escrow] payer key unreadable",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  })();
  const url = rpcUrl();
  if (!payer || !url) {
    console.warn("[solana-fee-escrow] worker disabled (set SOLANA_FEE_ESCROW_PAYER_KEYPAIR and SOLANA_RPC_HTTP)");
    return;
  }
  const connection = new Connection(url, "confirmed");
  const tick = () => runTick(connection, payer);
  void tick().catch((error) => {
    console.warn("[solana-fee-escrow] worker tick failed", error instanceof Error ? error.message : String(error));
  });
  setInterval(() => {
    void tick().catch((error) => {
      console.warn("[solana-fee-escrow] worker tick failed", error instanceof Error ? error.message : String(error));
    });
  }, workerIntervalMs());
}
