/**
 * Claim partner trading fees from DBC pools into the collector.
 * Claims exactly the accrued sum. Sign, persist claiming + signature, then send.
 */
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { bs58Encode, resolveSignature } from "./dbcFeePending.js";

export const CLAIM_RECONCILE_TOLERANCE_LAMPORTS = 0n;

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };

export type ClaimResult = {
  pool: string;
  ids: string[];
  claimed: bigint;
  expected: bigint;
  signature: string | null;
  blocked: boolean;
  reason?: string;
};

function big(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (value && typeof value === "object" && "toString" in value) return BigInt(String(value));
  return BigInt(String(value ?? 0));
}

function accountKeysFromTx(tx: any): any[] {
  const message = tx?.transaction?.message;
  if (!message) return [];
  if (typeof message.getAccountKeys === "function") {
    try {
      const loaded = tx?.meta?.loadedAddresses;
      const keys = loaded
        ? message.getAccountKeys({ accountKeysFromLookups: loaded })
        : message.getAccountKeys();
      if (typeof keys.keySegments === "function") return keys.keySegments().flat();
      return [
        ...(keys.staticAccountKeys || []),
        ...(keys.accountKeysFromLookups?.writable || []),
        ...(keys.accountKeysFromLookups?.readonly || []),
      ];
    } catch {
      // fall through
    }
  }
  return message.staticAccountKeys || message.accountKeys || [];
}

function keyStr(entry: any): string {
  if (!entry) return "";
  if (typeof entry === "string") return entry;
  if (typeof entry.toBase58 === "function") return entry.toBase58();
  return String(entry.pubkey || "");
}

export function quoteVaultOutflow(tx: any, quoteVault: string): bigint {
  const keys = accountKeysFromTx(tx);
  const vaultIndex = keys.findIndex((entry: any) => keyStr(entry) === quoteVault);
  const pick = (list: any[]) => {
    const row = (list || []).find((item) => Number(item.accountIndex) === vaultIndex);
    return row ? BigInt(String(row.uiTokenAmount?.amount ?? 0)) : 0n;
  };
  if (vaultIndex < 0) return 0n;
  return pick(tx.meta?.preTokenBalances || []) - pick(tx.meta?.postTokenBalances || []);
}

async function getTx(connection: Connection, signature: string) {
  return connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
}

async function updateIds(
  db: Queryable,
  ids: string[],
  sql: string,
  params: unknown[] = [],
) {
  if (!ids.length) return;
  await db.query(sql, [ids, ...params]);
}

export async function resolvePendingClaims(input: {
  db: Queryable;
  connection: Connection;
  client?: DynamicBondingCurveClient;
}): Promise<{ resolved: number; waiting: number; blocked: number }> {
  const pending = await input.db.query(
    `select id, pool, collector_amount, claim_signature, last_valid_block_height
       from public.dbc_fee_accruals
      where status = 'claiming'
      order by pool, id`,
  );
  let resolved = 0;
  let waiting = 0;
  let blocked = 0;
  const bySig = new Map<string, { pool: string; ids: string[]; expected: bigint; lastValid: number }>();
  for (const row of pending.rows) {
    const signature = String(row.claim_signature || "");
    if (!signature) continue;
    const group = bySig.get(signature) || {
      pool: String(row.pool),
      ids: [],
      expected: 0n,
      lastValid: Number(row.last_valid_block_height || 0),
    };
    group.ids.push(String(row.id));
    group.expected += big(row.collector_amount);
    bySig.set(signature, group);
  }
  const client = input.client || new DynamicBondingCurveClient(input.connection, "confirmed");
  for (const [signature, group] of bySig) {
    const confirmed = await getTx(input.connection, signature);
    const outcome = confirmed
      ? (confirmed.meta?.err ? "failed" : "landed")
      : await resolveSignature(input.connection, signature, group.lastValid);
    if (outcome === "pending") {
      waiting += group.ids.length;
      continue;
    }
    if (outcome === "failed" || outcome === "expired") {
      await updateIds(
        input.db,
        group.ids,
        `update public.dbc_fee_accruals
            set status = 'accrued', claim_signature = null, last_valid_block_height = null
          where id = any($1::bigint[])`,
      );
      resolved += group.ids.length;
      continue;
    }
    if (!confirmed) {
      waiting += group.ids.length;
      continue;
    }
    const wrap = await client.state.getPool(new PublicKey(group.pool));
    const state = wrap?.poolState ?? wrap;
    const quoteVault = String(state?.quoteVault?.toBase58?.() || state?.quote_vault || "");
    const claimed = quoteVaultOutflow(confirmed, quoteVault);
    const delta = claimed - group.expected;
    const mismatch = (delta < 0n ? -delta : delta) > CLAIM_RECONCILE_TOLERANCE_LAMPORTS;
    if (mismatch) {
      await updateIds(
        input.db,
        group.ids,
        `update public.dbc_fee_accruals
            set status = 'blocked', blocked_reason = $2
          where id = any($1::bigint[])`,
        [`claim ${claimed.toString()} expected ${group.expected.toString()} ${signature}`],
      );
      console.error("[dbc-fee] claim reconcile mismatch; routing stopped for pool", {
        pool: group.pool,
        claimed: claimed.toString(),
        expected: group.expected.toString(),
        signature,
      });
      blocked += group.ids.length;
      continue;
    }
    await updateIds(
      input.db,
      group.ids,
      `update public.dbc_fee_accruals
          set status = 'claimed'
        where id = any($1::bigint[])`,
    );
    resolved += group.ids.length;
  }
  return { resolved, waiting, blocked };
}

export async function claimPoolPartnerFees(input: {
  db: Queryable;
  connection: Connection;
  collector: Keypair;
  pool: string;
  send: boolean;
  minLamports?: bigint;
  client?: DynamicBondingCurveClient;
}): Promise<ClaimResult> {
  const inFlight = await input.db.query(
    `select id from public.dbc_fee_accruals where pool = $1 and status = 'claiming' limit 1`,
    [input.pool],
  );
  if ((inFlight.rowCount ?? inFlight.rows.length) > 0) {
    return { pool: input.pool, ids: [], claimed: 0n, expected: 0n, signature: null, blocked: false, reason: "claiming-in-flight" };
  }
  const accrued = await input.db.query(
    `select id, collector_amount
       from public.dbc_fee_accruals
      where pool = $1 and status = 'accrued'
      order by id`,
    [input.pool],
  );
  const ids = accrued.rows.map((row: { id: unknown }) => String(row.id));
  const expected = accrued.rows.reduce((sum: bigint, row: { collector_amount: unknown }) => sum + big(row.collector_amount), 0n);
  const min = input.minLamports ?? 1n;
  if (!ids.length || expected < min) {
    return { pool: input.pool, ids, claimed: 0n, expected, signature: null, blocked: false, reason: "below-threshold" };
  }
  const client = input.client || new DynamicBondingCurveClient(input.connection, "confirmed");
  const poolPk = new PublicKey(input.pool);
  const wrap = await client.state.getPool(poolPk);
  const state = wrap?.poolState ?? wrap;
  if (!state) {
    return { pool: input.pool, ids, claimed: 0n, expected, signature: null, blocked: false, reason: "pool-unreadable" };
  }
  const owed = big(state.partnerQuoteFee ?? state.partner_quote_fee);
  if (owed < expected) {
    await updateIds(
      input.db,
      ids,
      `update public.dbc_fee_accruals
          set status = 'blocked', blocked_reason = $2
        where id = any($1::bigint[])`,
      [`owed ${owed.toString()} expected ${expected.toString()}`],
    );
    return { pool: input.pool, ids, claimed: 0n, expected, signature: null, blocked: true, reason: "owed-below-expected" };
  }
  if (!input.send) {
    return { pool: input.pool, ids, claimed: 0n, expected, signature: null, blocked: false, reason: "dry-run" };
  }
  const tx: Transaction = await client.partner.claimPartnerTradingFee({
    feeClaimer: input.collector.publicKey,
    payer: input.collector.publicKey,
    pool: poolPk,
    maxBaseAmount: new BN(0),
    maxQuoteAmount: new BN(expected.toString()),
  });
  const latest = await input.connection.getLatestBlockhash("confirmed");
  tx.feePayer = input.collector.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.partialSign(input.collector);
  const serialized = tx.serialize();
  let signature = bs58Encode(serialized.subarray(1, 65));
  await updateIds(
    input.db,
    ids,
    `update public.dbc_fee_accruals
        set status = 'claiming', claim_signature = $2, last_valid_block_height = $3
      where id = any($1::bigint[])`,
    [signature, latest.lastValidBlockHeight],
  );
  try {
    const sent = await input.connection.sendRawTransaction(serialized, { skipPreflight: false, maxRetries: 8 });
    if (sent && sent !== signature) {
      await updateIds(
        input.db,
        ids,
        `update public.dbc_fee_accruals
            set claim_signature = $2
          where id = any($1::bigint[])`,
        [sent],
      );
      signature = sent;
    }
    const confirmation = await input.connection.confirmTransaction({
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }, "confirmed");
    if (confirmation.value.err) {
      await updateIds(
        input.db,
        ids,
        `update public.dbc_fee_accruals
            set status = 'accrued', claim_signature = null, last_valid_block_height = null
          where id = any($1::bigint[])`,
      );
      return { pool: input.pool, ids, claimed: 0n, expected, signature, blocked: false, reason: "claim-failed-on-chain" };
    }
  } catch (error) {
    const msg = String(error instanceof Error ? error.message : error);
    if (/timeout|not confirmed|was not confirmed/i.test(msg)) {
      return { pool: input.pool, ids, claimed: 0n, expected, signature, blocked: false, reason: "claiming" };
    }
    await updateIds(
      input.db,
      ids,
      `update public.dbc_fee_accruals
          set status = 'accrued', claim_signature = null, last_valid_block_height = null
        where id = any($1::bigint[])`,
    );
    throw error;
  }
  return { pool: input.pool, ids, claimed: 0n, expected, signature, blocked: false, reason: "claiming" };
}

export async function claimDuePools(input: {
  db: Queryable;
  connection: Connection;
  collector: Keypair;
  send: boolean;
  minLamports?: bigint;
  client?: DynamicBondingCurveClient;
}): Promise<ClaimResult[]> {
  await resolvePendingClaims({ db: input.db, connection: input.connection, client: input.client });
  const due = await input.db.query(
    `select pool, coalesce(sum(collector_amount),0)::text as expected
       from public.dbc_fee_accruals
      where status = 'accrued'
        and pool not in (select distinct pool from public.dbc_fee_accruals where status = 'claiming')
      group by pool
     having coalesce(sum(collector_amount),0) >= $1`,
    [(input.minLamports ?? 1n).toString()],
  );
  const results: ClaimResult[] = [];
  for (const row of due.rows) {
    results.push(await claimPoolPartnerFees({
      db: input.db,
      connection: input.connection,
      collector: input.collector,
      pool: String(row.pool),
      send: input.send,
      minLamports: input.minLamports,
      client: input.client,
    }));
  }
  return results;
}
