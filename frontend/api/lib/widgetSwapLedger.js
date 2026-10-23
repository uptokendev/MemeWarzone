/**
 * Widget swap ledger (2026-10-23): every swap the API built for the swap widget (widget_swap_builds) and the link from
 * a landed import fee row to it (finance_import_swap_fees.swap_source = 'widget', widget_host, widget_build_id).
 *
 * The fingerprints are the partner attribution's (importSwapFingerprint.js). The fee scanner keeps, per fee row, the
 * fingerprint of the landed transaction (landed_fingerprint), but only when the row's wallet is the wallet that landed
 * the swap (EVM: tx.from; Solana: the fee payer), so a match is wallet-bound exactly like partnersForSwaps: same
 * fingerprint AND the build's wallet is that wallet. Marking is then one SQL statement over the last 7 days, run on
 * every scan: it also catches a build written after its swap was scanned (builds are flushed every 15 s) and a run
 * whose mark failed. Idempotent: a marked row is never touched again. The partner attribution,
 * import_swap_fingerprints and every amount column stay as they are.
 *
 * Retention (founder, 2026-10-23): a build that never matched a landed swap is deleted 30 days after it was made;
 * matched builds stay (their wallet is public on chain with the swap).
 *
 * Everything here is best effort: a missing table or column (42P01 / 42703, the SQL not applied yet) or any other
 * error means nothing is recorded or marked, never a failed build or a failed scan.
 */

function isSchemaMissing(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

export const WIDGET_MARK_DAYS = 7;
export const WIDGET_BUILD_RETENTION_DAYS = 30;

/**
 * Stores the queued widget builds in one statement (first writer wins per chain, fingerprint, wallet). Returns the
 * rows written, null when the table is missing, 0 on any other error (logged).
 */
export async function recordWidgetBuilds(db, records) {
  const rows = (records || []).filter((r) => r?.fingerprint && r?.wallet);
  if (!db || !rows.length) return 0;
  const col = (fn) => rows.map(fn);
  try {
    const result = await db.query(
      `insert into public.widget_swap_builds (fingerprint, chain_id, kind, wallet, token_address, side, partner_id, host, fee_bps, native_raw)
       select * from unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::int[], $10::numeric[])
       on conflict (chain_id, fingerprint, wallet) do nothing`,
      [
        col((r) => String(r.fingerprint)),
        col((r) => Number(r.chainId)),
        col((r) => (r.kind === "gen8" ? "gen8" : "import")),
        col((r) => String(r.wallet)),
        col((r) => r.token ?? null),
        col((r) => r.side ?? null),
        col((r) => r.partnerId || null),
        col((r) => String(r.host || "").slice(0, 120)),
        col((r) => r.feeBps ?? null),
        col((r) => r.nativeRaw ?? null),
      ],
    );
    return Number(result?.rowCount ?? 0);
  } catch (error) {
    if (isSchemaMissing(error)) {
      console.warn("[widget-ledger] widget_swap_builds is missing: apply database/prod_apply_widget_analytics.sql; widget builds are not recorded");
      return null;
    }
    console.warn("[widget-ledger] builds not recorded; dropped", { rows: rows.length, error: String(error?.message || error) });
    return 0;
  }
}

/**
 * Deletes, in one bounded statement, widget builds older than 30 days that never matched a landed swap (no fee row
 * links to them and, for gen-8, no partner ledger row carries their fingerprint). Returns the rows deleted, null when
 * the tables are missing, 0 on other errors.
 */
export async function deleteUnmatchedWidgetBuilds(db, { limit = 5000, days = WIDGET_BUILD_RETENTION_DAYS } = {}) {
  if (!db) return 0;
  try {
    const probe = await db.query(`select to_regclass('public.gen8_partner_fees') is not null as gen8`);
    const gen8 = probe.rows?.[0]?.gen8 === true;
    const result = await db.query(
      `with doomed as (
         select b.id from public.widget_swap_builds b
          where b.created_at < now() - make_interval(days => $2::int)
            and not exists (select 1 from public.finance_import_swap_fees f where f.widget_build_id = b.id)
            ${gen8 ? "and not exists (select 1 from public.gen8_partner_fees p where p.chain_id = b.chain_id and p.fingerprint = b.fingerprint)" : ""}
          order by b.id
          limit $1::int
       )
       delete from public.widget_swap_builds b using doomed d where b.id = d.id`,
      [Math.max(1, Number(limit) || 5000), Math.max(1, Number(days) || WIDGET_BUILD_RETENTION_DAYS)],
    );
    return Number(result?.rowCount ?? 0);
  } catch (error) {
    if (isSchemaMissing(error)) return null;
    console.warn("[widget-ledger] retention did not run", String(error?.message || error));
    return 0;
  }
}

/**
 * Keeps the landed fingerprint on the stored fee rows of these scanned rows (only rows not set yet, and only when the
 * row's wallet is the landed wallet). landedWallet(row): the scanner's rule (Solana row.wallet, EVM row.sender).
 * Returns the rows updated; 0 on any error (logged, the scan goes on).
 */
export async function storeLandedFingerprints(db, chainId, rows, landedWallet) {
  if (!db || !rows?.length) return 0;
  const evm = Number(chainId) !== 101 && Number(chainId) !== 102;
  const norm = (w) => (evm ? String(w ?? "").trim().toLowerCase() : String(w ?? "").trim());
  const hits = rows.filter((row) => row?.fingerprint && row?.txHash != null && norm(row.wallet) && norm(row.wallet) === norm(landedWallet(row)));
  if (!hits.length) return 0;
  try {
    const result = await db.query(
      `update public.finance_import_swap_fees f
          set landed_fingerprint = v.fingerprint
         from unnest($2::text[], $3::int[], $4::text[]) as v(tx_hash, log_index, fingerprint)
        where f.chain_id = $1 and f.tx_hash = v.tx_hash and f.log_index = v.log_index and f.landed_fingerprint is null`,
      [Number(chainId), hits.map((r) => String(r.txHash)), hits.map((r) => Number(r.logIndex ?? 0)), hits.map((r) => String(r.fingerprint))],
    );
    return Number(result?.rowCount ?? 0);
  } catch (error) {
    if (!isSchemaMissing(error)) console.warn("[widget-ledger] landed fingerprints not stored", { chainId, error: String(error?.message || error) });
    return 0;
  }
}

/**
 * Marks the chain's fee rows of the last `days` days whose landed fingerprint and wallet match a widget build:
 * swap_source 'widget', widget_host, widget_build_id. Unmarked rows only (idempotent). Returns the rows marked; 0 on
 * any error (logged).
 */
export async function markWidgetFeeRows(db, chainId, { days = WIDGET_MARK_DAYS } = {}) {
  if (!db) return 0;
  try {
    const result = await db.query(
      `update public.finance_import_swap_fees f
          set swap_source = 'widget', widget_host = b.host, widget_build_id = b.id
         from public.widget_swap_builds b
        where f.chain_id = $1 and f.swap_source is null and f.landed_fingerprint is not null
          and f.occurred_at > now() - make_interval(days => $2::int)
          and b.chain_id = f.chain_id and b.fingerprint = f.landed_fingerprint
          and b.wallet = (case when f.chain_id in (101, 102) then f.wallet else lower(f.wallet) end)`,
      [Number(chainId), Math.max(1, Number(days) || WIDGET_MARK_DAYS)],
    );
    return Number(result?.rowCount ?? 0);
  } catch (error) {
    if (!isSchemaMissing(error)) console.warn("[widget-ledger] widget fee rows not marked", { chainId, error: String(error?.message || error) });
    return 0;
  }
}
