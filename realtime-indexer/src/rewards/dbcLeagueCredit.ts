import { Connection, PublicKey } from "@solana/web3.js";

/**
 * DBC league money (founder 2026-10-04): the DBC fee router sends 37.5% of DBC trading fees to the
 * league vaults (dbc/dbcFeeSplit.ts, 30/70 weekly/monthly), but only when the collector claims and
 * routes. Settlement counted launchpad fees only, so that money sat in the vaults unpaid.
 *
 * An epoch is credited with the lamports the collector transferred into its vault while the epoch
 * was open (by block time). The money is in the vault by definition, every deposit belongs to
 * exactly one epoch, and a deposit after the epoch's end counts for the next one: never stranded,
 * never counted twice. Mirrored in frontend/api/lib/dbcLeagueCredit.js (league page).
 *
 * Deposits before DBC_LEAGUE_CREDIT_FROM were paid out by the one-time top-up of 2026-10-04
 * (league_rollovers reason vault_surplus_2026-10-04) and are never credited again.
 */
export const DBC_LEAGUE_CREDIT_FROM_MS = Date.parse("2026-10-04T15:28:33Z");
export const DBC_FEE_COLLECTOR_DEFAULT = "3NWtsXixUR3eJjPSNTSVJ62eVxTD4ExHyvdop6TURorY";
const TREASURY_PROGRAM_DEFAULT = "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX";
const SEED_BY_PERIOD: Record<string, string> = { weekly: "league_vault", monthly: "monthly_league_vault" };

export type CollectorTx = {
  blockTimeMs: number;
  failed: boolean;
  feePayer: string;
  accountKeys: string[];
  preBalances: number[];
  postBalances: number[];
};

/** Lamports the collector itself moved into `vault` inside [fromMs, toMs). Pure; unit-tested. */
export function sumCollectorDeposits(txs: CollectorTx[], vault: string, collector: string, fromMs: number, toMs: number): bigint {
  let total = 0n;
  for (const tx of txs) {
    if (tx.failed || tx.feePayer !== collector) continue;
    if (!(tx.blockTimeMs >= fromMs && tx.blockTimeMs < toMs)) continue;
    const index = tx.accountKeys.indexOf(vault);
    if (index < 0) continue;
    const delta = BigInt(tx.postBalances[index] ?? 0) - BigInt(tx.preBalances[index] ?? 0);
    if (delta > 0n) total += delta;
  }
  return total;
}

export function leagueVaultAddress(period: "weekly" | "monthly", programId = process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || TREASURY_PROGRAM_DEFAULT): string {
  return PublicKey.findProgramAddressSync([Buffer.from(SEED_BY_PERIOD[period])], new PublicKey(String(programId).trim()))[0].toBase58();
}

/**
 * DBC lamports credited to one epoch's vault. Throws when the chain cannot be read: settlement must
 * then wait and retry, never settle without it.
 */
export async function dbcLeagueCreditRaw(
  connection: Connection,
  period: "weekly" | "monthly",
  epochStartMs: number,
  epochEndMs: number,
  collector = String(process.env.DBC_FEE_COLLECTOR_ADDRESS || DBC_FEE_COLLECTOR_DEFAULT).trim(),
): Promise<bigint> {
  const fromMs = Math.max(epochStartMs, DBC_LEAGUE_CREDIT_FROM_MS);
  if (!(epochEndMs > fromMs)) return 0n;
  const vault = leagueVaultAddress(period);
  const owner = new PublicKey(collector);
  const txs: CollectorTx[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await connection.getSignaturesForAddress(owner, { before, limit: 1000 }, "confirmed");
    for (const sig of page) {
      const ms = Number(sig.blockTime ?? 0) * 1000;
      if (sig.err || !(ms >= fromMs && ms < epochEndMs)) continue;
      const tx = await connection.getTransaction(sig.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!tx?.meta) throw new Error(`DBC credit: transaction ${sig.signature} unreadable`);
      const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
      const accountKeys = [
        ...keys.staticAccountKeys,
        ...(keys.accountKeysFromLookups?.writable || []),
        ...(keys.accountKeysFromLookups?.readonly || []),
      ].map((k) => k.toBase58());
      txs.push({
        blockTimeMs: ms,
        failed: Boolean(tx.meta.err),
        feePayer: accountKeys[0],
        accountKeys,
        preBalances: tx.meta.preBalances,
        postBalances: tx.meta.postBalances,
      });
    }
    const oldest = page.at(-1);
    if (page.length < 1000 || !oldest || Number(oldest.blockTime ?? 0) * 1000 < fromMs) break;
    before = oldest.signature;
  }
  return sumCollectorDeposits(txs, vault, collector, fromMs, epochEndMs);
}
