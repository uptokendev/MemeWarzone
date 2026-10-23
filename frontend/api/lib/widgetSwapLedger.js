/**
 * Widget swap ledger (2026-10-23): every swap the API built for the swap widget (widget_swap_builds) and the link from
 * a landed import fee row to it (finance_import_swap_fees.swap_source = 'widget', widget_host, widget_build_id).
 *
 * The fingerprints are the partner attribution's (importSwapFingerprint.js), so a landed fee row matches its widget
 * build exactly the way partnersForSwaps matches a partner build: same fingerprint AND the wallet the build was made
 * for is the wallet that landed the swap (EVM: tx.from, case-insensitive; Solana: the fee payer, exact). The partner
 * attribution, import_swap_fingerprints and every amount column stay as they are; this only adds the marks.
 *
 * Everything here is best effort: a missing table or column (42P01 / 42703, the SQL not applied yet) or any other
 * error means nothing is recorded or marked, never a failed build or a failed scan.
 */
import { partnerSwapKey } from "./importSwapFingerprint.js";

function isSchemaMissing(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

let buildsOffUntil = 0;
const OFF_MS = 5 * 60_000;

export function resetWidgetLedgerState() {
  buildsOffUntil = 0;
}

/** Stores one widget build (first writer wins per chain, fingerprint, wallet). Returns true when written. Never throws. */
export async function recordWidgetBuild(db, record, { now = Date.now() } = {}) {
  if (!db || !record?.fingerprint || !record?.wallet) return false;
  if (now < buildsOffUntil) return false;
  try {
    await db.query(
      `insert into public.widget_swap_builds (fingerprint, chain_id, kind, wallet, token_address, side, partner_id, host, fee_bps, native_raw)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric)
       on conflict (chain_id, fingerprint, wallet) do nothing`,
      [
        record.fingerprint,
        Number(record.chainId),
        record.kind === "gen8" ? "gen8" : "import",
        String(record.wallet),
        record.token ?? null,
        record.side ?? null,
        record.partnerId || null,
        String(record.host || "").slice(0, 120),
        record.feeBps ?? null,
        record.nativeRaw ?? null,
      ],
    );
    return true;
  } catch (error) {
    if (isSchemaMissing(error)) {
      if (!buildsOffUntil) console.warn("[widget-ledger] widget_swap_builds is missing: apply database/prod_apply_widget_analytics.sql; widget builds are not recorded");
      buildsOffUntil = now + OFF_MS;
      return false;
    }
    console.warn("[widget-ledger] build not recorded", String(error?.message || error));
    return false;
  }
}

/**
 * Widget builds of landed swaps: partnerSwapKey(chainId, fingerprint, wallet) -> { id, host, partnerId }, only where
 * the wallet the build was recorded for is the landed wallet. swaps: [{ fingerprint, wallet }]. A missing table
 * answers an empty map; other errors throw (the caller logs them).
 */
export async function widgetBuildsForSwaps(db, chainId, swaps) {
  const wanted = (swaps || []).filter((swap) => swap?.fingerprint && String(swap?.wallet ?? "").trim());
  const list = [...new Set(wanted.map((swap) => String(swap.fingerprint)))];
  if (!db || !list.length) return new Map();
  let rows;
  try {
    ({ rows } = await db.query(
      `select id::text as id, fingerprint, wallet, host, partner_id from public.widget_swap_builds where chain_id = $1 and fingerprint = any($2::text[])`,
      [Number(chainId), list],
    ));
  } catch (error) {
    if (isSchemaMissing(error)) return new Map();
    throw error;
  }
  const asked = new Set(wanted.map((swap) => partnerSwapKey(chainId, swap.fingerprint, swap.wallet)));
  const out = new Map();
  for (const row of rows || []) {
    if (row.wallet == null || !String(row.wallet).trim()) continue;
    const key = partnerSwapKey(chainId, row.fingerprint, row.wallet);
    if (!asked.has(key) || out.has(key)) continue;
    out.set(key, { id: String(row.id), host: String(row.host || ""), partnerId: row.partner_id ? String(row.partner_id) : null });
  }
  return out;
}

/**
 * Marks the stored fee rows of these scanned rows that match a widget build: swap_source 'widget', widget_host,
 * widget_build_id. Only rows not marked yet; no amount column is touched. landedWallet(row) is the wallet that landed
 * the swap (the scanner's own rule: Solana row.wallet, EVM row.sender). Returns how many rows were marked; 0 on any
 * error (logged), so the scan goes on as before.
 */
export async function markWidgetFeeRows(db, chainId, rows, landedWallet) {
  if (!db || !rows?.length) return 0;
  try {
    const withFingerprint = rows.filter((row) => row?.fingerprint && row?.txHash != null);
    if (!withFingerprint.length) return 0;
    const builds = await widgetBuildsForSwaps(db, chainId, withFingerprint.map((row) => ({ fingerprint: row.fingerprint, wallet: landedWallet(row) })));
    if (!builds.size) return 0;
    const hits = [];
    for (const row of withFingerprint) {
      const wallet = landedWallet(row);
      if (!String(wallet ?? "").trim()) continue;
      const build = builds.get(partnerSwapKey(chainId, row.fingerprint, wallet));
      if (build) hits.push({ txHash: String(row.txHash), logIndex: Number(row.logIndex ?? 0), host: build.host, id: build.id });
    }
    if (!hits.length) return 0;
    const result = await db.query(
      `update public.finance_import_swap_fees f
          set swap_source = 'widget', widget_host = v.host, widget_build_id = v.build_id
         from unnest($2::text[], $3::int[], $4::text[], $5::bigint[]) as v(tx_hash, log_index, host, build_id)
        where f.chain_id = $1 and f.tx_hash = v.tx_hash and f.log_index = v.log_index and f.swap_source is null`,
      [Number(chainId), hits.map((h) => h.txHash), hits.map((h) => h.logIndex), hits.map((h) => h.host), hits.map((h) => h.id)],
    );
    return Number(result?.rowCount ?? 0);
  } catch (error) {
    if (!isSchemaMissing(error)) console.warn("[widget-ledger] widget fee rows not marked", { chainId, error: String(error?.message || error) });
    return 0;
  }
}
