import { Connection, PublicKey } from "@solana/web3.js";
import { pool } from "../../server/db.js";

/**
 * Spendable lamports in the Solana league vaults (rewards treasury PDAs): the real prize pools.
 * The league page used to estimate the pot from this epoch's trades only, so the weekly vault's
 * carried-over, never-paid prize money was invisible (vault 0.143 SOL vs 0.092 shown, 2026-09-25).
 * The vault is already net of payouts and includes every carry-over.
 *
 * It also still holds every posted prize nobody has claimed yet. That money belongs to earlier
 * winners, so it is subtracted (per posted root: total - claimed, read from the epoch account).
 * Without this the new week showed last week's unclaimed prizes as its own pot (2026-09-28).
 */
const TREASURY_PROGRAM = new PublicKey(String(process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX").trim());
const SEED_BY_PERIOD = { weekly: "league_vault", monthly: "monthly_league_vault" };
const CACHE_MS = 60_000;
const cache = new Map();

export function solanaLeagueVaultAddress(period) {
  const seed = SEED_BY_PERIOD[period];
  return seed ? PublicKey.findProgramAddressSync([Buffer.from(seed)], TREASURY_PROGRAM)[0].toBase58() : null;
}

/** LeagueEpoch account: 8 disc | u8 period | i64 epoch_start | [32] root | u64 total | u64 claimed. */
export function leagueEpochOutstanding(data) {
  const buf = Buffer.from(data || []);
  if (buf.length < 8 + 1 + 8 + 32 + 8 + 8) return 0n;
  const total = buf.readBigUInt64LE(8 + 1 + 8 + 32);
  const claimed = buf.readBigUInt64LE(8 + 1 + 8 + 32 + 8);
  return total > claimed ? total - claimed : 0n;
}

async function outstandingPostedPrizes(connection, period, db) {
  if (!db) return 0n;
  const { rows } = await db.query(
    `select epoch_address from public.league_epoch_roots
      where chain_id = 101 and period = $1 and epoch_address is not null`,
    [period],
  );
  const keys = rows.map((row) => new PublicKey(String(row.epoch_address)));
  let outstanding = 0n;
  for (let i = 0; i < keys.length; i += 100) {
    const infos = await connection.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed");
    for (const info of infos) if (info) outstanding += leagueEpochOutstanding(info.data);
  }
  return outstanding;
}

/** @returns {Promise<{ address: string, spendableRaw: bigint, outstandingRaw: bigint } | null>} null when unreadable. */
export async function readSolanaLeagueVaultSpendable(period, { rpcUrl = process.env.SOLANA_RPC_URL, db = pool } = {}) {
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
    const free = lamports > rent ? lamports - rent : 0n;
    const outstandingRaw = await outstandingPostedPrizes(connection, period, db);
    const value = { address, spendableRaw: free > outstandingRaw ? free - outstandingRaw : 0n, outstandingRaw };
    cache.set(address, { at: Date.now(), value });
    return value;
  } catch (error) {
    console.warn("[league] solana vault read failed", period, error?.message || error);
    return null;
  }
}
