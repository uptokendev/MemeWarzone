// The Major War League share ledger (db/migrations/20261002_000002_mwl_payouts.sql): one row per
// battle / tournament league share that reached an MWL vault. Payouts read it; see arenaMwlPayouts.js.
// No imports beyond node: the Solana resolve-due worker loads this file from the repo root.

export const MONTHLY_BPS = 6000n; // PostGradLeagueTreasuryV2.MONTHLY_BPS; Solana follows the same split.
const BPS = 10000n;

/** Exactly PostGradLeagueTreasuryV2.depositCompetitionShare's split. */
export function splitLeagueShare(grossRaw) {
  const gross = BigInt(grossRaw);
  if (gross <= 0n) throw new Error("LEAGUE_SHARE_NOT_POSITIVE");
  const monthly = (gross * MONTHLY_BPS) / BPS;
  return { gross, monthly, quarterly: gross - monthly };
}

/** "YYYY-MM" and "YYYY-Qn" of a UTC instant (the battle's settlement time). */
export function leagueShareKeys(at) {
  const date = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(date.getTime())) throw new Error("LEAGUE_SHARE_DATE_INVALID");
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return { monthKey: `${year}-${String(month).padStart(2, "0")}`, quarterKey: `${year}-Q${Math.floor((month - 1) / 3) + 1}` };
}

/** Records one share; a second record for the same subject is ignored. Returns true when inserted. */
export async function recordLeagueShare(db, { chainId, subjectKind = "battle", subjectId, grossRaw, settledAt, source, txHash = null }) {
  const { gross, monthly, quarterly } = splitLeagueShare(grossRaw);
  const { monthKey, quarterKey } = leagueShareKeys(settledAt);
  const result = await db.query(
    `insert into public.arena_league_share_ledger
       (chain_id, subject_kind, subject_id, gross_raw, monthly_raw, quarterly_raw, month_key, quarter_key, source, tx_hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (chain_id, subject_kind, subject_id) do nothing
     returning id`,
    [Number(chainId), subjectKind, String(subjectId), gross.toString(), monthly.toString(), quarterly.toString(), monthKey, quarterKey, String(source), txHash],
  );
  return Boolean(result.rows?.[0]);
}
