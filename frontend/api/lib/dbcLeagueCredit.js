import { Connection, PublicKey } from "@solana/web3.js";

/**
 * DBC league money credited to a Solana league epoch. Mirror of
 * realtime-indexer/src/rewards/dbcLeagueCredit.ts (settlement); the page must show what settlement pays.
 *
 * The DBC fee router sends the league share of DBC fees to the league vaults when the collector claims
 * and routes. An epoch is credited with the lamports the collector moved into its vault while the epoch
 * was open (by block time). Deposits before DBC_LEAGUE_CREDIT_FROM_MS were paid by the one-time top-up
 * of 2026-10-04 (league_rollovers reason vault_surplus_2026-10-04).
 */
export const DBC_LEAGUE_CREDIT_FROM_MS = Date.parse("2026-10-04T15:28:33Z");
export const DBC_FEE_COLLECTOR_DEFAULT = "3NWtsXixUR3eJjPSNTSVJ62eVxTD4ExHyvdop6TURorY";
const TREASURY_PROGRAM_DEFAULT = "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX";
const SEED_BY_PERIOD = { weekly: "league_vault", monthly: "monthly_league_vault" };
// Confirmed transactions never change: parse each once (the live page refreshes every 60 s).
const parsedBySignature = new Map();
const PARSED_CACHE_MAX = 5_000;

/** Lamports the collector itself moved into `vault` inside [fromMs, toMs). Pure; unit-tested. */
export function sumCollectorDeposits(txs, vault, collector, fromMs, toMs) {
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

export function leagueVaultAddress(period, programId = process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || TREASURY_PROGRAM_DEFAULT) {
  const seed = SEED_BY_PERIOD[period];
  return seed ? PublicKey.findProgramAddressSync([Buffer.from(seed)], new PublicKey(String(programId).trim()))[0].toBase58() : null;
}

/** @returns {Promise<bigint|null>} null when the chain cannot be read (the page then flags it). */
export async function dbcLeagueCreditRaw(period, epochStartMs, epochEndMs, { rpcUrl = process.env.SOLANA_RPC_URL, collector = process.env.DBC_FEE_COLLECTOR_ADDRESS || DBC_FEE_COLLECTOR_DEFAULT } = {}) {
  const fromMs = Math.max(epochStartMs, DBC_LEAGUE_CREDIT_FROM_MS);
  if (!(epochEndMs > fromMs)) return 0n;
  const vault = leagueVaultAddress(period);
  const url = String(rpcUrl || "").trim();
  if (!vault || !url) return null;
  try {
    const connection = new Connection(url, "confirmed");
    const owner = new PublicKey(String(collector).trim());
    const txs = [];
    let before;
    for (;;) {
      const page = await connection.getSignaturesForAddress(owner, { before, limit: 1000 }, "confirmed");
      for (const sig of page) {
        const ms = Number(sig.blockTime ?? 0) * 1000;
        if (sig.err || !(ms >= fromMs && ms < epochEndMs)) continue;
        let parsed = parsedBySignature.get(sig.signature);
        if (!parsed) {
          const tx = await connection.getTransaction(sig.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
          if (!tx?.meta) return null;
          const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
          const accountKeys = [
            ...keys.staticAccountKeys,
            ...(keys.accountKeysFromLookups?.writable || []),
            ...(keys.accountKeysFromLookups?.readonly || []),
          ].map((k) => k.toBase58());
          parsed = { blockTimeMs: ms, failed: Boolean(tx.meta.err), feePayer: accountKeys[0], accountKeys, preBalances: tx.meta.preBalances, postBalances: tx.meta.postBalances };
          if (parsedBySignature.size >= PARSED_CACHE_MAX) parsedBySignature.clear();
          parsedBySignature.set(sig.signature, parsed);
        }
        txs.push(parsed);
      }
      const oldest = page.at(-1);
      if (page.length < 1000 || !oldest || Number(oldest.blockTime ?? 0) * 1000 < fromMs) break;
      before = oldest.signature;
    }
    return sumCollectorDeposits(txs, vault, String(collector).trim(), fromMs, epochEndMs);
  } catch (error) {
    console.warn("[league] DBC credit read failed", period, error?.message || error);
    return null;
  }
}
