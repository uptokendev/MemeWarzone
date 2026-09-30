/**
 * League queries read the gen-5 trade columns (migration 20260930_000001_evm_gen5_indexing.sql) only
 * once they exist, so this build can run against a database the migration has not reached yet: until
 * then the SQL fragments are empty and every query behaves exactly as before.
 */
type Db = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export type CurveTradeGen5Columns = { leagueExcluded: boolean; feeRaw: boolean };

let cached: { at: number; value: CurveTradeGen5Columns } | null = null;
const TTL_MS = 10 * 60 * 1000;

export function resetCurveTradeGen5ColumnsCache() {
  cached = null;
}

export async function curveTradeGen5Columns(db: Db): Promise<CurveTradeGen5Columns> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  try {
    const { rows } = await db.query(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'curve_trades'
          and column_name in ('league_excluded', 'fee_raw')`,
    );
    const names = new Set(rows.map((r) => String(r.column_name)));
    const value = { leagueExcluded: names.has("league_excluded"), feeRaw: names.has("fee_raw") };
    cached = { at: Date.now(), value };
    return value;
  } catch {
    return { leagueExcluded: false, feeRaw: false };
  }
}

/** D13: `AND NOT <alias>.league_excluded` when the column exists, else "". */
export async function leagueExcludedFilter(db: Db, alias = "t"): Promise<string> {
  const cols = await curveTradeGen5Columns(db);
  return cols.leagueExcluded ? ` AND NOT coalesce(${alias}.league_excluded, false)` : "";
}
