import { Connection, PublicKey } from "@solana/web3.js";

/**
 * Spendable lamports in the Solana league vaults (rewards treasury PDAs): the real prize pools.
 * The league page used to estimate the pot from this epoch's trades only, so the weekly vault's
 * carried-over, never-paid prize money was invisible (vault 0.143 SOL vs 0.092 shown, 2026-09-25).
 * The vault is already net of payouts and includes every carry-over.
 */
const TREASURY_PROGRAM = new PublicKey(String(process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX").trim());
const SEED_BY_PERIOD = { weekly: "league_vault", monthly: "monthly_league_vault" };
const CACHE_MS = 60_000;
const cache = new Map();

export function solanaLeagueVaultAddress(period) {
  const seed = SEED_BY_PERIOD[period];
  return seed ? PublicKey.findProgramAddressSync([Buffer.from(seed)], TREASURY_PROGRAM)[0].toBase58() : null;
}

/** @returns {Promise<{ address: string, spendableRaw: bigint } | null>} null when unreadable. */
export async function readSolanaLeagueVaultSpendable(period, { rpcUrl = process.env.SOLANA_RPC_URL } = {}) {
  const address = solanaLeagueVaultAddress(period);
  const url = String(rpcUrl || "").trim();
  if (!address || !url) return null;
  const hit = cache.get(address);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  try {
    const connection = new Connection(url, "confirmed");
    const info = await connection.getAccountInfo(new PublicKey(address));
    if (!info) return null;
    const rent = BigInt(await connection.getMinimumBalanceForRentExemption(info.data.length));
    const lamports = BigInt(info.lamports);
    const value = { address, spendableRaw: lamports > rent ? lamports - rent : 0n };
    cache.set(address, { at: Date.now(), value });
    return value;
  } catch (error) {
    console.warn("[league] solana vault read failed", period, error?.message || error);
    return null;
  }
}
