/**
 * Major War League prize pool (UI redesign, founder request 2026-10-02). Read-only.
 *
 * Every battle sends 20% of the entry pot to the league. Where it lands:
 *   BNB / Robinhood  PostGradLeagueTreasuryV2 splits each deposit 60% monthly / 40% quarterly
 *                    into per-epoch buckets keyed id("YYYY-MM") and id("YYYY-Qn"), the keys the
 *                    claim plan in arenaWarPools.js hands to claimLeague. Money arrives there when
 *                    a pool's claimLeague is sent; a share still sitting in a war pool is not counted.
 *   Solana           one mwl_vault pays both the monthly round and the quarterly finals; nothing on
 *                    chain splits it, so the vault is reported as a combined figure. Prizes already
 *                    posted to winners and not yet claimed are subtracted.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { ethers } from "ethers";
import { pool } from "../../server/db.js";
import { getServerReadProvider } from "./getServerReadProvider.js";
import { warPoolTreasuryAddress, warPoolGeneration, WAR_POOL_GENERATION_V2 } from "./arenaWarPoolEscrow.js";
import { leagueEpochOutstanding } from "./solanaLeagueVaultBalance.js";

export const MWL_POT_CHAINS = new Set([56, 97, 101, 4663, 46630]);
const TREASURY_PROGRAM = new PublicKey(String(process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX").trim());
const DECIMALS = { 56: 18, 97: 18, 4663: 18, 46630: 18, 101: 9 };
const CACHE_MS = 60_000;
const cache = new Map();

const WAR_POOL_ABI = ["function postGradLeagueTreasury() view returns (address)"];
const LEAGUE_TREASURY_ABI = [
  "function pendingMonthlyByEpoch(bytes32) view returns (uint256)",
  "function pendingQuarterlyByEpoch(bytes32) view returns (uint256)",
];

/** "2026-10" -> keys for that month and its quarter. Falls back to the current UTC month. */
export function mwlEpochKeys(month, now = new Date()) {
  const m = String(month || "").match(/^(\d{4})-(\d{2})$/);
  const year = m ? Number(m[1]) : now.getUTCFullYear();
  const mon = m ? Number(m[2]) : now.getUTCMonth() + 1;
  if (mon < 1 || mon > 12) return mwlEpochKeys(null, now);
  const monthLabel = `${year}-${String(mon).padStart(2, "0")}`;
  const quarterLabel = `${year}-Q${Math.floor((mon - 1) / 3) + 1}`;
  return { month: monthLabel, quarter: quarterLabel, monthlyEpoch: ethers.id(monthLabel), quarterlyEpoch: ethers.id(quarterLabel) };
}

export function toNative(raw, chainId) {
  const value = BigInt(raw || 0);
  return Number(ethers.formatUnits(value, DECIMALS[Number(chainId)] ?? 18));
}

export function mwlVaultAddress() {
  return PublicKey.findProgramAddressSync([Buffer.from("mwl_vault")], TREASURY_PROGRAM)[0].toBase58();
}

async function readEvm(chainId, keys, { providerFor = getServerReadProvider, env = process.env } = {}) {
  if (warPoolGeneration(chainId, env) !== WAR_POOL_GENERATION_V2) return null;
  const warPool = warPoolTreasuryAddress(chainId, env);
  if (!warPool) return null;
  const provider = await providerFor(chainId);
  const treasury = await new ethers.Contract(warPool, WAR_POOL_ABI, provider).postGradLeagueTreasury();
  if (!treasury || treasury === ethers.ZeroAddress) return null;
  const league = new ethers.Contract(treasury, LEAGUE_TREASURY_ABI, provider);
  const [monthly, quarterly] = await Promise.all([league.pendingMonthlyByEpoch(keys.monthlyEpoch), league.pendingQuarterlyByEpoch(keys.quarterlyEpoch)]);
  return { source: "evm", address: treasury, monthlyRaw: BigInt(monthly), quarterlyRaw: BigInt(quarterly), combinedRaw: null };
}

async function readSolana({ rpcUrl = process.env.SOLANA_RPC_URL, db = pool } = {}) {
  const url = String(rpcUrl || "").trim();
  if (!url) return null;
  const connection = new Connection(url, "confirmed");
  const address = mwlVaultAddress();
  const info = await connection.getAccountInfo(new PublicKey(address));
  if (!info) return null;
  const rent = BigInt(await connection.getMinimumBalanceForRentExemption(info.data.length));
  const free = BigInt(info.lamports) > rent ? BigInt(info.lamports) - rent : 0n;
  let outstanding = 0n;
  try {
    const { rows } = await db.query(
      `select epoch_address from public.league_epoch_roots
        where chain_id = 101 and period in ('quarterly', 'mwl_monthly') and epoch_address is not null`,
    );
    const accounts = rows.map((row) => new PublicKey(String(row.epoch_address)));
    for (let i = 0; i < accounts.length; i += 100) {
      for (const acc of await connection.getMultipleAccountsInfo(accounts.slice(i, i + 100), "confirmed")) {
        if (acc) outstanding += leagueEpochOutstanding(acc.data);
      }
    }
  } catch (error) {
    if (error?.code !== "42P01") throw error;
  }
  return { source: "solana", address, monthlyRaw: null, quarterlyRaw: null, combinedRaw: free > outstanding ? free - outstanding : 0n };
}

/** @returns {Promise<object>} figures in native units; null fields mean "not split on this chain" or unreadable. */
export async function readMwlPrizePool(chainId, { month, readers = {} } = {}) {
  const id = Number(chainId);
  const keys = mwlEpochKeys(month);
  const cacheKey = `${id}:${keys.month}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const read = id === 101 ? await (readers.solana || readSolana)() : await (readers.evm || readEvm)(id, keys);
  const value = {
    chainId: id,
    month: keys.month,
    quarter: keys.quarter,
    available: Boolean(read),
    split: read ? read.source === "evm" : null,
    address: read?.address || null,
    monthlyNative: read?.monthlyRaw != null ? toNative(read.monthlyRaw, id) : null,
    quarterlyNative: read?.quarterlyRaw != null ? toNative(read.quarterlyRaw, id) : null,
    combinedNative: read?.combinedRaw != null ? toNative(read.combinedRaw, id) : null,
  };
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}
