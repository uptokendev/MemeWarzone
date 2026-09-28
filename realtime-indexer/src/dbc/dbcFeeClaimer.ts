/**
 * Claim partner trading fees from DBC pools into the collector.
 * Claimed lamports are the pool quote-vault outflow in that transaction.
 */
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import BN from "bn.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";


export const CLAIM_RECONCILE_TOLERANCE_LAMPORTS = 0n;

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };

export type ClaimResult = {
  pool: string;
  claimed: bigint;
  counterDrop: bigint;
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
      // fall through to the compiled lists
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
  for (let i = 0; i < 20; i += 1) {
    const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (tx) return tx;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  return null;
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
  const expectedRow = await input.db.query(
    `select coalesce(sum(collector_amount), 0)::text as expected
       from public.dbc_fee_accruals
      where pool = $1 and status = 'accrued'`,
    [input.pool],
  );
  const expected = BigInt(String(expectedRow.rows[0]?.expected || "0"));
  const min = input.minLamports ?? 1n;
  if (expected < min) {
    return { pool: input.pool, claimed: 0n, counterDrop: 0n, expected, signature: null, blocked: false, reason: "below-threshold" };
  }
  const client = input.client || new DynamicBondingCurveClient(input.connection, "confirmed");
  const poolPk = new PublicKey(input.pool);
  const wrap = await client.state.getPool(poolPk);
  const state = wrap?.poolState ?? wrap;
  if (!state) {
    return { pool: input.pool, claimed: 0n, counterDrop: 0n, expected, signature: null, blocked: true, reason: "pool-unreadable" };
  }
  const owed = big(state.partnerQuoteFee ?? state.partner_quote_fee);
  const quoteVault = String(state.quoteVault?.toBase58?.() || state.quote_vault || "");
  if (owed <= 0n) {
    if (expected > 0n) {
      await input.db.query(
        `update public.dbc_fee_accruals
            set status = 'blocked', blocked_reason = $2
          where pool = $1 and status = 'accrued'`,
        [input.pool, `partner-fee-zero expected ${expected.toString()}`],
      );
    }
    return { pool: input.pool, claimed: 0n, counterDrop: 0n, expected, signature: null, blocked: true, reason: "partner-fee-zero" };
  }
  if (!input.send) {
    return { pool: input.pool, claimed: 0n, counterDrop: 0n, expected, signature: null, blocked: false, reason: "dry-run" };
  }
  const tx = await client.partner.claimPartnerTradingFee({
    feeClaimer: input.collector.publicKey,
    payer: input.collector.publicKey,
    pool: poolPk,
    maxBaseAmount: new BN(0),
    maxQuoteAmount: new BN(owed.toString()),
  });
  tx.feePayer = input.collector.publicKey;
  const signature = await sendAndConfirmTransaction(input.connection, tx, [input.collector], { commitment: "confirmed" });
  const confirmed = await getTx(input.connection, signature);
  if (!confirmed) {
    return { pool: input.pool, claimed: 0n, counterDrop: 0n, expected, signature, blocked: true, reason: "claim-tx-unreadable" };
  }
  const claimed = quoteVaultOutflow(confirmed, quoteVault);
  let owedAfter = owed;
  for (let i = 0; i < 20; i += 1) {
    const afterWrap = await client.state.getPool(poolPk);
    const after = afterWrap?.poolState ?? afterWrap;
    if (!after) {
      await new Promise((r) => setTimeout(r, 1_500));
      continue;
    }
    owedAfter = big(after?.partnerQuoteFee ?? after?.partner_quote_fee);
    if (owedAfter !== owed || i === 19) break;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  const counterDrop = owed - owedAfter;
  const deltaExpected = claimed - expected;
  const deltaCounter = claimed - counterDrop;
  const blocked =
    (deltaExpected < 0n ? -deltaExpected : deltaExpected) > CLAIM_RECONCILE_TOLERANCE_LAMPORTS
    || (deltaCounter < 0n ? -deltaCounter : deltaCounter) > CLAIM_RECONCILE_TOLERANCE_LAMPORTS;
  if (blocked) {
    await input.db.query(
      `update public.dbc_fee_accruals
          set status = 'blocked', claim_signature = $2, blocked_reason = $3
        where pool = $1 and status = 'accrued'`,
      [input.pool, signature, `claim ${claimed.toString()} counter ${counterDrop.toString()} expected ${expected.toString()}`],
    );
    console.error("[dbc-fee] claim reconcile mismatch; routing stopped for pool", {
      pool: input.pool,
      claimed: claimed.toString(),
      counterDrop: counterDrop.toString(),
      expected: expected.toString(),
      signature,
    });
    return { pool: input.pool, claimed, counterDrop, expected, signature, blocked: true, reason: "reconcile-mismatch" };
  }
  await input.db.query(
    `update public.dbc_fee_accruals
        set status = 'claimed', claim_signature = $2
      where pool = $1 and status = 'accrued'`,
    [input.pool, signature],
  );
  return { pool: input.pool, claimed, counterDrop, expected, signature, blocked: false };
}

export async function claimDuePools(input: {
  db: Queryable;
  connection: Connection;
  collector: Keypair;
  send: boolean;
  minLamports?: bigint;
}): Promise<ClaimResult[]> {
  const due = await input.db.query(
    `select pool, coalesce(sum(collector_amount),0)::text as expected
       from public.dbc_fee_accruals
      where status = 'accrued'
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
    }));
  }
  return results;
}


