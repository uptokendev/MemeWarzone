import { type AccountInfo, type Connection, PublicKey } from "@solana/web3.js";

/** Escrow + campaign account of one fee-escrow row, in that order. */
export type EscrowAccountPair = [AccountInfo<Buffer> | null, AccountInfo<Buffer> | null];

/** getMultipleAccounts accepts at most 100 keys per call. */
export const PREFETCH_KEYS_PER_CALL = 100;

export function escrowPairKey(escrow: PublicKey, campaign: PublicKey): string {
  return `${escrow.toBase58()}:${campaign.toBase58()}`;
}

/**
 * Reads the escrow and campaign accounts of every row in batches of 100 keys
 * (50 rows per call) instead of one call per row. Returns null when any batch
 * fails, so the caller falls back to its per-row read and keeps its per-row
 * error handling.
 */
export async function prefetchEscrowAccounts(
  connection: Pick<Connection, "getMultipleAccountsInfo">,
  rows: Array<{ campaign_address: unknown; escrow_address: unknown }>,
  deriveEscrow: (campaign: string) => string,
): Promise<Map<string, EscrowAccountPair> | null> {
  try {
    const pairs = rows.map((row) => {
      const campaign = new PublicKey(String(row.campaign_address));
      const escrow = new PublicKey(String(row.escrow_address || deriveEscrow(campaign.toBase58())));
      return { escrow, campaign };
    });
    const keys = pairs.flatMap(({ escrow, campaign }) => [escrow, campaign]);
    const infos: Array<AccountInfo<Buffer> | null> = [];
    for (let i = 0; i < keys.length; i += PREFETCH_KEYS_PER_CALL) {
      const batch = keys.slice(i, i + PREFETCH_KEYS_PER_CALL);
      const result = await connection.getMultipleAccountsInfo(batch, "confirmed");
      if (!Array.isArray(result) || result.length !== batch.length) throw new Error("getMultipleAccounts length mismatch");
      infos.push(...result);
    }
    const out = new Map<string, EscrowAccountPair>();
    pairs.forEach(({ escrow, campaign }, index) => {
      out.set(escrowPairKey(escrow, campaign), [infos[index * 2] ?? null, infos[index * 2 + 1] ?? null]);
    });
    return out;
  } catch (error) {
    console.warn(
      "[solana-fee-escrow] batched account read failed; reading per row",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}
