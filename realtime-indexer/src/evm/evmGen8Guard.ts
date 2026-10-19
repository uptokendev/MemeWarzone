/**
 * Gen-8 coins have no campaign contract (campaign_address = the token). Paths that read a campaign contract or scan its
 * logs (trade backfill, cursor rewind, market-state upgrades, CMS heal) skip them: evm/evmGen8Pool.ts indexes them.
 */
type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };

export async function isGen8Campaign(db: Queryable, chainId: number, campaign: string): Promise<boolean> {
  try {
    const { rows } = await db.query(
      `select 1 from public.campaigns where chain_id = $1 and campaign_address = $2 and factory_generation = 8 limit 1`,
      [chainId, String(campaign || "").trim().toLowerCase()],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}
