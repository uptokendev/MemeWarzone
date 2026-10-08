/**
 * Import swap fee 1%, half to the coin's creator (founder, 2026-10-08). Solana side.
 *
 * Every import swap pays the whole 1% in wrapped SOL to the collector's WSOL account (the API's
 * SOLANA_IMPORT_FEE_COLLECTOR). The finance cron reads each fee into finance_import_swap_fees with
 * its creator half (creator_raw) and an import_creator_fees accrual (frontend/api/lib/
 * financeImportSwapFees.js). This module moves the money afterwards, never inside a trader's tx:
 *
 *   expire    accruals past 90 days that were not paid -> 'expired' (they become the protocol's)
 *   sweep     the protocol's half of every fee plus the expired creator halves -> the protocol
 *             wallet's WSOL account (the old import fee account of operator 2AMfRaxS...)
 *   pay       verified import owners (arena_token_imports ownership_verified, claim >= 7 days old)
 *             whose waiting accruals sum to at least the minimum, in native SOL, within a per-payout
 *             and a daily cap. Above the daily cap the rest waits for the next UTC day by itself.
 *
 * Every movement: sign, store 'sending' + signature + lastValidBlockHeight (and mark the accruals
 * 'paying' in the same db transaction), send; the next pass resolves it. A send that may have
 * landed is never reset: only a 'failed' or 'expired' signature puts the accruals back to waiting.
 * While anything is 'sending', no new movement starts. The caps bound a stolen key, they do not
 * review claims (founder: fully automated at any size).
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  createInitializeAccount3Instruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { bs58Encode, resolveSignature } from "./dbc/dbcFeePending.js";

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };
type Pool = Queryable & { connect?: () => Promise<Queryable & { release?: () => void }> };

export const CHAIN_ID = 101;
const TOKEN_ACCOUNT_SIZE = 165;
const DAY_MS = 86_400_000;

export type ImportFeeSettings = {
  /** Owner of the protocol wallet's WSOL account that receives our half (operator 2AMfRaxS...). */
  protocolOwner: string;
  minPayoutLamports: bigint;
  maxPayoutLamports: bigint;
  dailyPayoutCapLamports: bigint;
  minSweepLamports: bigint;
  holdDays: number;
  payoutsPerPass: number;
};

function envBigint(env: Record<string, string | undefined>, name: string, fallback: bigint): bigint {
  const raw = String(env[name] ?? "").trim();
  return /^\d+$/.test(raw) ? BigInt(raw) : fallback;
}

export function importFeeSettings(env: Record<string, string | undefined> = process.env): ImportFeeSettings {
  return {
    protocolOwner: String(env.SOLANA_IMPORT_SWAP_FEE_OWNER || "2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB").trim(),
    // About $5 at ~$120/SOL; tune with the env as SOL moves.
    minPayoutLamports: envBigint(env, "IMPORT_CREATOR_MIN_PAYOUT_LAMPORTS", 40_000_000n),
    maxPayoutLamports: envBigint(env, "IMPORT_CREATOR_MAX_PAYOUT_LAMPORTS", 50_000_000_000n),
    dailyPayoutCapLamports: envBigint(env, "IMPORT_CREATOR_DAILY_CAP_LAMPORTS", 200_000_000_000n),
    minSweepLamports: envBigint(env, "IMPORT_FEE_MIN_SWEEP_LAMPORTS", 50_000_000n),
    holdDays: Math.max(0, Number(env.IMPORT_CREATOR_HOLD_DAYS ?? 7)),
    payoutsPerPass: Math.max(1, Math.min(20, Number(env.IMPORT_CREATOR_PAYOUTS_PER_PASS ?? 5))),
  };
}

export function wsolAccount(owner: string | PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(owner), true, TOKEN_PROGRAM_ID);
}

// ---------------------------------------------------------------- pure planning

export type WaitingAccrual = { feeId: string; creatorRaw: bigint };

/**
 * Oldest-first accruals of one coin that fit in `limit` (they are paid whole, so the amount is
 * exactly their sum). An accrual larger than the limit is never split: it waits for a cap raise.
 */
export function pickAccruals(waiting: WaitingAccrual[], limit: bigint): { picked: WaitingAccrual[]; amount: bigint } {
  const picked: WaitingAccrual[] = [];
  let amount = 0n;
  for (const accrual of waiting) {
    if (amount + accrual.creatorRaw > limit) break;
    picked.push(accrual);
    amount += accrual.creatorRaw;
  }
  return { picked, amount };
}

/** What the protocol is still owed from the collector: its half of every fee + expired creator halves - sweeps. */
export function protocolDue(input: { protocolHalves: bigint; expiredCreator: bigint; swept: bigint }): bigint {
  const due = input.protocolHalves + input.expiredCreator - input.swept;
  return due > 0n ? due : 0n;
}

export function utcDayStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
}

export function isValidWallet(address: string): boolean {
  try {
    const key = new PublicKey(address);
    return key.toBase58() === address && PublicKey.isOnCurve(key.toBytes());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- transactions

/** Pays `amount` lamports out of the collector's WSOL as native SOL: unwrap through a temporary account. */
export function creatorPayoutInstructions(input: { collector: PublicKey; temp: PublicKey; to: PublicKey; amount: bigint; rentLamports: number }): TransactionInstruction[] {
  const source = wsolAccount(input.collector);
  return [
    SystemProgram.createAccount({ fromPubkey: input.collector, newAccountPubkey: input.temp, lamports: input.rentLamports, space: TOKEN_ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeAccount3Instruction(input.temp, NATIVE_MINT, input.collector, TOKEN_PROGRAM_ID),
    createTransferCheckedInstruction(source, NATIVE_MINT, input.temp, input.collector, input.amount, 9, [], TOKEN_PROGRAM_ID),
    // Closing returns the rent and the unwrapped amount to the collector, which pays the owner.
    createCloseAccountInstruction(input.temp, input.collector, input.collector, [], TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: input.collector, toPubkey: input.to, lamports: input.amount }),
  ];
}

/** Moves the protocol's part as wrapped SOL into the protocol wallet's WSOL account. */
export function protocolSweepInstructions(input: { collector: PublicKey; protocolOwner: PublicKey; amount: bigint }): TransactionInstruction[] {
  return [createTransferCheckedInstruction(wsolAccount(input.collector), NATIVE_MINT, wsolAccount(input.protocolOwner), input.collector, input.amount, 9, [], TOKEN_PROGRAM_ID)];
}

async function signedTx(connection: Connection, payer: Keypair, instructions: TransactionInstruction[], extraSigners: Keypair[] = []) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(...instructions);
  tx.sign(payer, ...extraSigners);
  return { tx, signature: bs58Encode(tx.signature!), lastValidBlockHeight };
}

// ---------------------------------------------------------------- database

async function inTransaction<T>(db: Pool, fn: (client: Queryable) => Promise<T>): Promise<T> {
  const client = typeof db.connect === "function" ? await db.connect() : db;
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    if (client !== db) (client as { release?: () => void }).release?.();
  }
}

/** Resolves every 'sending' movement. Returns how many are still pending. */
export async function resolvePendingTransfers(db: Pool, connection: Connection): Promise<{ landed: number; reset: number; pending: number }> {
  const { rows } = await db.query(
    `select id, signature, last_valid_block_height from public.import_fee_transfers where chain_id = $1 and status = 'sending' order by id`,
    [CHAIN_ID],
  );
  let landed = 0;
  let reset = 0;
  let pending = 0;
  for (const row of rows) {
    const state = await resolveSignature(connection, String(row.signature), Number(row.last_valid_block_height));
    if (state === "pending") {
      pending += 1;
      continue;
    }
    await inTransaction(db, async (client) => {
      if (state === "landed") {
        await client.query(`update public.import_fee_transfers set status = 'landed', updated_at = now() where id = $1 and status = 'sending'`, [row.id]);
        await client.query(`update public.import_creator_fees set status = 'paid', updated_at = now() where transfer_id = $1 and status = 'paying'`, [row.id]);
      } else {
        await client.query(`update public.import_fee_transfers set status = 'failed', error = $2, updated_at = now() where id = $1 and status = 'sending'`, [row.id, `signature ${state}`]);
        await client.query(`update public.import_creator_fees set status = 'waiting', transfer_id = null, updated_at = now() where transfer_id = $1 and status = 'paying'`, [row.id]);
      }
    });
    if (state === "landed") landed += 1;
    else reset += 1;
  }
  return { landed, reset, pending };
}

export async function expireAccruals(db: Queryable, now: Date): Promise<number> {
  const result = await db.query(
    `update public.import_creator_fees set status = 'expired', expired_at = $2, updated_at = now()
      where chain_id = $1 and status = 'waiting' and expires_at <= $2`,
    [CHAIN_ID, now.toISOString()],
  );
  return result.rowCount ?? 0;
}

export async function readProtocolDue(db: Queryable, collectorAccount: string): Promise<bigint> {
  const { rows } = await db.query(
    `select
       (select coalesce(sum(fee_raw - creator_raw), 0) from public.finance_import_swap_fees
         where chain_id = $1 and fee_receiver = $2 and creator_raw > 0)::text as halves,
       (select coalesce(sum(c.creator_raw), 0) from public.import_creator_fees c
          join public.finance_import_swap_fees f on f.id = c.fee_id
         where c.chain_id = $1 and c.status = 'expired' and f.fee_receiver = $2)::text as expired,
       (select coalesce(sum(amount_raw), 0) from public.import_fee_transfers
         where chain_id = $1 and kind = 'protocol' and from_address = $2 and status in ('sending', 'landed'))::text as swept`,
    [CHAIN_ID, collectorAccount],
  );
  const row = rows[0] || {};
  return protocolDue({ protocolHalves: BigInt(row.halves || "0"), expiredCreator: BigInt(row.expired || "0"), swept: BigInt(row.swept || "0") });
}

export async function readPaidToday(db: Queryable, collectorAccount: string, now: Date): Promise<bigint> {
  const { rows } = await db.query(
    `select coalesce(sum(amount_raw), 0)::text as paid from public.import_fee_transfers
      where chain_id = $1 and kind = 'creator' and from_address = $2 and status in ('sending', 'landed') and created_at >= $3`,
    [CHAIN_ID, collectorAccount, utcDayStart(now).toISOString()],
  );
  return BigInt(rows[0]?.paid || "0");
}

export type PayableCoin = { token: string; owner: string; waiting: WaitingAccrual[]; total: bigint };

/** Verified imports whose claim is at least `holdDays` old and that have waiting accruals on this collector. */
export async function readPayableCoins(db: Queryable, collectorAccount: string, holdDays: number, now: Date): Promise<PayableCoin[]> {
  const { rows } = await db.query(
    `with owners as (
       select distinct on (i.token_address) i.token_address, i.project_owner_wallet
         from public.arena_token_imports i
        where i.chain_id = $1
          and i.ownership_status = 'ownership_verified'
          and i.project_owner_wallet is not null
          and i.ownership_verified_at is not null
          and i.ownership_verified_at <= $3::timestamptz - make_interval(days => $4::int)
        order by i.token_address, i.ownership_verified_at desc
     )
     select o.token_address, o.project_owner_wallet, c.fee_id::text as fee_id, c.creator_raw::text as creator_raw
       from owners o
       join public.import_creator_fees c on c.chain_id = $1 and c.token_address = o.token_address and c.status = 'waiting' and c.expires_at > $3
       join public.finance_import_swap_fees f on f.id = c.fee_id and f.fee_receiver = $2
      order by o.token_address, c.occurred_at, c.fee_id`,
    [CHAIN_ID, collectorAccount, now.toISOString(), holdDays],
  );
  const byToken = new Map<string, PayableCoin>();
  for (const row of rows) {
    const token = String(row.token_address);
    let coin = byToken.get(token);
    if (!coin) {
      coin = { token, owner: String(row.project_owner_wallet), waiting: [], total: 0n };
      byToken.set(token, coin);
    }
    const creatorRaw = BigInt(String(row.creator_raw));
    coin.waiting.push({ feeId: String(row.fee_id), creatorRaw });
    coin.total += creatorRaw;
  }
  return [...byToken.values()];
}

// ---------------------------------------------------------------- one pass

export type PassResult = {
  resolved: { landed: number; reset: number; pending: number } | null;
  expired: number;
  sweep: { amount: string; signature: string | null } | null;
  payouts: Array<{ token: string; owner: string; amount: string; signature: string | null }>;
  skipped: string[];
};

export async function runImportCreatorFeePass(input: {
  db: Pool;
  connection: Connection;
  collector: Keypair;
  send: boolean;
  settings?: ImportFeeSettings;
  now?: Date;
}): Promise<PassResult> {
  const { db, connection, collector, send } = input;
  const settings = input.settings || importFeeSettings();
  const now = input.now || new Date();
  const collectorAccount = wsolAccount(collector.publicKey).toBase58();
  const result: PassResult = { resolved: null, expired: 0, sweep: null, payouts: [], skipped: [] };

  if (send) {
    result.resolved = await resolvePendingTransfers(db, connection);
    if (result.resolved.pending > 0) return result; // never start a movement while one may still land
    result.expired = await expireAccruals(db, now);
  }

  let balance = 0n;
  try {
    balance = BigInt((await connection.getTokenAccountBalance(new PublicKey(collectorAccount), "confirmed")).value.amount);
  } catch {
    result.skipped.push(`collector WSOL account ${collectorAccount} unreadable`);
    return result;
  }

  // Creators first: their money is a liability; ours can wait for the next pass.
  let dailyLeft = settings.dailyPayoutCapLamports - (await readPaidToday(db, collectorAccount, now));
  const coins = await readPayableCoins(db, collectorAccount, settings.holdDays, now);
  for (const coin of coins) {
    if (result.payouts.length >= settings.payoutsPerPass) break;
    if (coin.total < settings.minPayoutLamports) continue;
    if (!isValidWallet(coin.owner)) {
      result.skipped.push(`${coin.token}: owner ${coin.owner} is not a wallet`);
      continue;
    }
    const limit = [settings.maxPayoutLamports, dailyLeft, balance].reduce((a, b) => (a < b ? a : b));
    const { picked, amount } = pickAccruals(coin.waiting, limit);
    if (!picked.length || amount < settings.minPayoutLamports) {
      if (dailyLeft < settings.minPayoutLamports) result.skipped.push("daily payout cap reached; the rest pays tomorrow");
      else result.skipped.push(`${coin.token}: oldest accrual above the per-payout cap or the collector balance`);
      continue;
    }
    if (!send) {
      result.payouts.push({ token: coin.token, owner: coin.owner, amount: amount.toString(), signature: null });
      dailyLeft -= amount;
      balance -= amount;
      continue;
    }
    const temp = Keypair.generate();
    const rentLamports = await connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE);
    const { tx, signature, lastValidBlockHeight } = await signedTx(
      connection,
      collector,
      creatorPayoutInstructions({ collector: collector.publicKey, temp: temp.publicKey, to: new PublicKey(coin.owner), amount, rentLamports }),
      [temp],
    );
    const stored = await inTransaction(db, async (client) => {
      const transfer = await client.query(
        `insert into public.import_fee_transfers (chain_id, kind, from_address, to_address, token_address, amount_raw, status, signature, last_valid_block_height)
         values ($1, 'creator', $2, $3, $4, $5, 'sending', $6, $7) returning id`,
        [CHAIN_ID, collectorAccount, coin.owner, coin.token, amount.toString(), signature, lastValidBlockHeight],
      );
      const id = transfer.rows[0].id;
      const marked = await client.query(
        `update public.import_creator_fees set status = 'paying', transfer_id = $1, updated_at = now()
          where fee_id = any($2::bigint[]) and status = 'waiting'`,
        [id, picked.map((a) => a.feeId)],
      );
      if ((marked.rowCount ?? 0) !== picked.length) throw new Error("accruals changed while preparing the payout");
      return id;
    }).catch((error) => {
      result.skipped.push(`${coin.token}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (stored == null) continue;
    try {
      await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    } catch (error) {
      // Stays 'sending': the next pass resolves the signature (expired -> accruals back to waiting).
      await db.query(`update public.import_fee_transfers set error = $2, updated_at = now() where id = $1`, [stored, String(error instanceof Error ? error.message : error).slice(0, 500)]);
    }
    result.payouts.push({ token: coin.token, owner: coin.owner, amount: amount.toString(), signature });
    dailyLeft -= amount;
    balance -= amount;
  }

  // Our half (and expired creator halves), only when no creator payout went out this pass.
  if (!result.payouts.length) {
    const due = await readProtocolDue(db, collectorAccount);
    const amount = due < balance ? due : balance;
    if (amount >= settings.minSweepLamports) {
      if (!send) {
        result.sweep = { amount: amount.toString(), signature: null };
      } else {
        const protocolOwner = new PublicKey(settings.protocolOwner);
        const { tx, signature, lastValidBlockHeight } = await signedTx(connection, collector, protocolSweepInstructions({ collector: collector.publicKey, protocolOwner, amount }));
        const stored = await db.query(
          `insert into public.import_fee_transfers (chain_id, kind, from_address, to_address, amount_raw, status, signature, last_valid_block_height)
           values ($1, 'protocol', $2, $3, $4, 'sending', $5, $6) returning id`,
          [CHAIN_ID, collectorAccount, wsolAccount(protocolOwner).toBase58(), amount.toString(), signature, lastValidBlockHeight],
        );
        try {
          await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
        } catch (error) {
          await db.query(`update public.import_fee_transfers set error = $2, updated_at = now() where id = $1`, [stored.rows[0].id, String(error instanceof Error ? error.message : error).slice(0, 500)]);
        }
        result.sweep = { amount: amount.toString(), signature };
      }
    }
  }
  return result;
}
