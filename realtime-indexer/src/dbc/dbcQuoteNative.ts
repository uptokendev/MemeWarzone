/**
 * Native vs bound quote mint. SOL is the default when a campaign has no quoteMint.
 */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };

export function isNativeQuoteMint(mint?: string | null): boolean {
  const raw = String(mint || "").trim();
  return !raw || raw === WSOL_MINT;
}

export function quoteMintFromMeta(meta: unknown): string {
  const row = meta && typeof meta === "object" ? (meta as Record<string, any>) : {};
  const mint = String(row?.dbc?.quoteMint || row?.solanaGraduation?.quoteMint || "").trim();
  return mint || WSOL_MINT;
}

export function quoteDecimalsFromMeta(meta: unknown, fallback = 9): number {
  const row = meta && typeof meta === "object" ? (meta as Record<string, any>) : {};
  const value = Number(row?.dbc?.quoteDecimals ?? row?.solanaGraduation?.quoteDecimals);
  if (Number.isFinite(value) && value >= 0 && value <= 18) return value;
  return fallback;
}

export async function quoteMintsForPools(db: Queryable, pools: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const pool of pools) map.set(pool, WSOL_MINT);
  if (!pools.length) return map;
  const { rows } = await db.query(
    `select campaign_address, meta
       from public.campaigns
      where chain_id = 101 and campaign_address = any($1::text[])`,
    [pools],
  );
  for (const row of rows) {
    map.set(String(row.campaign_address), quoteMintFromMeta(row.meta));
  }
  return map;
}
