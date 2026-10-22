/**
 * Swap-widget partner share of graduated gen-8 coin swaps (founder, 2026-10-22; design D9). A partner earns 0.25% of
 * the volume of a post-graduation gen-8 swap that came through its widget, out of MemeWarzone's 0.50%. No share while
 * the coin is bonding. This module writes the ledger (public.gen8_partner_fees); the import payout worker
 * (importCreatorFeesEvm.ts) pays it from the chain's ImportFeeVault out of MemeWarzone's own import share.
 *
 * Attribution is the widget build fingerprint, exactly as for import swaps: the API builds the widget's gen-8 swaps
 * (frontend/api/gen8Swap.js) and records keccak256(to : data : value) of each partner build in
 * import_swap_fingerprints. Here, per chain:
 *   post-graduation trade accruals (evm_gen8_fee_accruals kind 'trade', phase 'post') of the configured hook whose
 *   hookData referrer is the widget tag (a pre-filter only: a forged tag cannot match a fingerprint the API did not
 *   record), after the cursor, oldest first, at most `batch` per run
 *   -> the landed transaction's to / input / value (RPC) -> the same fingerprint -> the partner id
 *   -> the partner must have an ACTIVE row on this chain (a partner switched off earns nothing on later swaps; what it
 *      earned before stays owed, as for imports)
 *   -> partner_raw = floor(curve_amount x 25 / 10000), never above the accrual's protocol slice.
 * A failed or empty RPC read stops the run at that transaction: the cursor stays before it and the next run retries
 * it. It is never recorded as "no partner". Rows are inserted ON CONFLICT DO NOTHING, so a re-run changes nothing.
 * The cursor only reads accruals older than `settleSeconds` so a money-lane transaction still open with a lower id
 * cannot be skipped.
 *
 * The share maths and the fingerprint are copies of frontend/api/lib/financeGen8.js (gen8PartnerShareRaw) and
 * frontend/api/lib/importSwapFingerprint.js (evmFingerprint); src/tests/gen8PartnerFees.test.ts pins both copies to
 * the same numbers.
 *
 *   GEN8_PARTNER_FEES_ENABLED=true          starts the attribution loop (evmGen8Worker.ts); off otherwise
 *   GEN8_PARTNER_FEES_BATCH                 accruals per run (200; 1..1000)
 *   GEN8_PARTNER_FEES_POLL_MS               interval (60000; floor 60000)
 */
import { ethers } from "ethers";

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };
type Pool = Queryable & { connect?: () => Promise<Queryable & { release?: () => void }> };

/** D9: partner 0.25% of volume, out of MemeWarzone's 0.50% (frontend/api/lib/financeGen8.js GEN8_PARTNER_BPS_OF_VOLUME). */
export const GEN8_PARTNER_BPS_OF_VOLUME = 25n;
/** The widget's hookData referrer (frontend/shared/evmGen8Swap.mjs GEN8_REFERRER_WIDGET), lower-cased. */
export const GEN8_REFERRER_WIDGET = "0x000000000000000000000000000000006d777a77";

/** Partner share of one post-graduation trade: floor(curve x 25 / 10000), never above the protocol share, never below 0. */
export function gen8PartnerShareRaw(input: { curveAmount: bigint | string | number; protocol: bigint | string | number }): bigint {
  const curve = BigInt(input.curveAmount);
  const cap = BigInt(input.protocol);
  if (curve <= 0n || cap <= 0n) return 0n;
  const share = (curve * GEN8_PARTNER_BPS_OF_VOLUME) / 10_000n;
  return share > cap ? cap : share;
}

/** keccak256(to : data : value) of a transaction, as the API records it for a partner build. */
export function evmFingerprint(to: unknown, data: unknown, value: unknown): string | null {
  if (!to || !data) return null;
  let amount: string;
  try {
    amount = BigInt((value as any) ?? 0).toString();
  } catch {
    return null;
  }
  return `evm:${ethers.keccak256(ethers.toUtf8Bytes(`${String(to).toLowerCase()}:${String(data).toLowerCase()}:${amount}`)).slice(2)}`;
}

export type Gen8PartnerAttributionResult = {
  chainId: number;
  skipped: string | null;
  cursorBefore: number;
  cursorAfter: number;
  scanned: number;
  attributed: number;
  inserted: number;
  /** Set when an RPC read failed: the run stopped there and retries it next time. */
  retry: { txHash: string; error: string } | null;
};

export type Gen8TxReader = { getTransaction(hash: string): Promise<{ to?: string | null; data?: string; input?: string; value?: bigint | string | number } | null> };

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

const errorText = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 300);

/** True once migration 20261022_000010_gen8_partner_fees.sql is applied. */
export async function gen8PartnerLedgerReady(db: Queryable): Promise<boolean> {
  const { rows } = await db.query(
    `select to_regclass('public.gen8_partner_fees') is not null and to_regclass('public.gen8_partner_fee_cursors') is not null as ready`,
  );
  return rows[0]?.ready === true;
}

/** One attribution run for one chain. Never sends anything; writes only the ledger and its cursor. */
export async function runGen8PartnerAttributionOnce(input: {
  db: Pool;
  chainId: number;
  hook: string;
  provider: Gen8TxReader;
  batch?: number;
  settleSeconds?: number;
}): Promise<Gen8PartnerAttributionResult> {
  const { db, chainId, provider } = input;
  const hook = String(input.hook).toLowerCase();
  const batch = Math.max(1, Math.min(1000, Math.trunc(Number(input.batch ?? 200)) || 200));
  const settleSeconds = Math.max(0, Math.trunc(Number(input.settleSeconds ?? 120)));
  const out: Gen8PartnerAttributionResult = { chainId, skipped: null, cursorBefore: 0, cursorAfter: 0, scanned: 0, attributed: 0, inserted: 0, retry: null };

  if (!(await gen8PartnerLedgerReady(db))) {
    out.skipped = "migration 20261022_000010_gen8_partner_fees.sql not applied";
    return out;
  }
  let active: Set<string>;
  try {
    const { rows } = await db.query(`select id from public.import_fee_partners where chain_id = $1 and active`, [chainId]);
    active = new Set(rows.map((row: any) => String(row.id)));
  } catch (error: any) {
    if (error?.code === "42P01") {
      out.skipped = "no import_fee_partners table";
      return out;
    }
    throw error;
  }
  if (!active.size) {
    out.skipped = `no active partner on chain ${chainId}`;
    return out;
  }

  const cursorRows = await db.query(`select last_accrual_id::text as last from public.gen8_partner_fee_cursors where chain_id = $1 and hook_address = $2`, [chainId, hook]);
  const cursor = Number(cursorRows.rows[0]?.last ?? 0);
  out.cursorBefore = cursor;
  out.cursorAfter = cursor;

  const { rows } = await db.query(
    `select id::text as id, tx_hash, log_index, token_address, curve_amount::text as curve_amount, protocol::text as protocol, block_time
       from public.evm_gen8_fee_accruals
      where chain_id = $1 and hook_address = $2 and kind = 'trade' and phase = 'post'
        and id > $3 and lower(coalesce(referrer, '')) = $4
        and created_at <= now() - make_interval(secs => $5::int)
      order by id
      limit $6`,
    [chainId, hook, cursor, GEN8_REFERRER_WIDGET, settleSeconds, batch],
  );
  if (!rows.length) return out;

  // Read each transaction once, in id order; stop at the first failed read (retried next run).
  const fpByTx = new Map<string, string | null>();
  let usable = rows.length;
  for (let i = 0; i < rows.length; i += 1) {
    const hash = String(rows[i].tx_hash).toLowerCase();
    if (fpByTx.has(hash)) continue;
    try {
      const tx = await provider.getTransaction(hash);
      if (!tx) throw new Error("transaction not found on this RPC");
      fpByTx.set(hash, evmFingerprint(tx.to, tx.data ?? tx.input, tx.value));
    } catch (error) {
      out.retry = { txHash: hash, error: errorText(error) };
      usable = i;
      break;
    }
  }
  const done = rows.slice(0, usable);
  out.scanned = done.length;
  if (!done.length) return out;

  const fingerprints = [...new Set([...fpByTx.values()].filter((fp): fp is string => Boolean(fp)))];
  const partnerByFp = new Map<string, string>();
  if (fingerprints.length) {
    const found = await db.query(`select fingerprint, partner_id from public.import_swap_fingerprints where chain_id = $1 and fingerprint = any($2::text[])`, [chainId, fingerprints]);
    for (const row of found.rows) partnerByFp.set(String(row.fingerprint), String(row.partner_id));
  }

  const ledger: Array<{ row: any; partnerId: string; fingerprint: string; share: bigint }> = [];
  for (const row of done) {
    const fingerprint = fpByTx.get(String(row.tx_hash).toLowerCase());
    if (!fingerprint) continue;
    const partnerId = partnerByFp.get(fingerprint);
    if (!partnerId || !active.has(partnerId)) continue;
    const share = gen8PartnerShareRaw({ curveAmount: row.curve_amount, protocol: row.protocol });
    if (share <= 0n) continue;
    ledger.push({ row, partnerId, fingerprint, share });
  }
  out.attributed = ledger.length;
  const last = Number(done[done.length - 1].id);

  out.inserted = await inTransaction(db, async (client) => {
    let inserted = 0;
    for (const { row, partnerId, fingerprint, share } of ledger) {
      const result = await client.query(
        `insert into public.gen8_partner_fees (chain_id, hook_address, accrual_id, tx_hash, log_index, token_address, partner_id, fingerprint, curve_amount, partner_raw, block_time)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict do nothing`,
        [chainId, hook, row.id, row.tx_hash, Number(row.log_index), String(row.token_address).toLowerCase(), partnerId, fingerprint, row.curve_amount, share.toString(), row.block_time],
      );
      inserted += result.rowCount ?? 0;
    }
    await client.query(
      `insert into public.gen8_partner_fee_cursors (chain_id, hook_address, last_accrual_id, updated_at) values ($1, $2, $3, now())
       on conflict (chain_id, hook_address) do update set last_accrual_id = greatest(public.gen8_partner_fee_cursors.last_accrual_id, excluded.last_accrual_id), updated_at = now()`,
      [chainId, hook, last],
    );
    return inserted;
  });
  out.cursorAfter = Math.max(cursor, last);
  return out;
}
