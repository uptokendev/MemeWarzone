/**
 * Native vs bound quote mint. SOL is the default when a campaign has no quoteMint.
 */
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

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

const quoteProgramCache = new Map<string, PublicKey>();

/**
 * The token program that owns a quote mint (classic SPL for SOL/USDC/USDT, Token-2022 for the
 * xStocks). Read from the chain, not the registry; a mint never changes program, so it is cached.
 */
export async function quoteTokenProgram(
  connection: { getAccountInfo(key: PublicKey, commitment?: any): Promise<{ owner: PublicKey } | null> },
  mint: string | PublicKey,
): Promise<PublicKey> {
  const key = typeof mint === "string" ? mint : mint.toBase58();
  if (isNativeQuoteMint(key)) return TOKEN_PROGRAM_ID;
  const hit = quoteProgramCache.get(key);
  if (hit) return hit;
  const info = await connection.getAccountInfo(new PublicKey(key), "confirmed");
  if (!info) throw new Error(`quote mint ${key} is not on chain`);
  if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(`quote mint ${key} is owned by ${info.owner.toBase58()}, not a token program`);
  }
  quoteProgramCache.set(key, info.owner);
  return info.owner;
}
