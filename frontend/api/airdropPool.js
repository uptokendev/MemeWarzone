/**
 * GET /api/airdrops/pool?chainId=101|56|4663 -- the weekly airdrop pool as the Coolify runner sees
 * it, for the front-page strip. Read-only, 60 s cache.
 *   Solana: airdrop_vault rent-free balance minus what open batches may still pay.
 *   EVM:    CommunityRewardsVault.warzoneAirdropBalance().
 * Rules are the one USD set every chain uses (scripts/weekly-airdrop/usdRules.mjs).
 */
import { Contract } from "ethers";
import { badMethod, getQuery, json } from "../server/http.js";
import { getServerReadProvider } from "./lib/getServerReadProvider.js";
import { readSolanaAirdropPool } from "../scripts/weekly-airdrop/solanaAirdrop.mjs";
import { AIRDROP_USD_RULES, nativeUsdFor } from "../scripts/weekly-airdrop/usdRules.mjs";

const DEFAULT_VAULTS = {
  56: "0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e",
  4663: "0xdE9Ec7c679FD260D76A390eEC00FA8ab1E621D2a",
};
const SYMBOLS = { 56: "BNB", 101: "SOL", 4663: "ETH" };
const CACHE_MS = 60_000;
const cache = new Map();

/** The Coolify job runs Mondays 00:15 UTC; the next such moment after now. */
export function nextDrawAt(now = new Date()) {
  const next = new Date(now);
  next.setUTCHours(0, 15, 0, 0);
  while (next.getUTCDay() !== 1 || next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

async function readPool(chainId) {
  if (chainId === 101) {
    const pool = await readSolanaAirdropPool();
    return { poolRaw: pool.available, decimals: 9 };
  }
  const vault = String(process.env[`COMMUNITY_REWARDS_VAULT_ADDRESS_${chainId}`] || DEFAULT_VAULTS[chainId] || "").trim();
  if (!vault) throw new Error(`no community rewards vault for chain ${chainId}`);
  const provider = await getServerReadProvider(chainId);
  const balance = await new Contract(vault, ["function warzoneAirdropBalance() view returns (uint256)"], provider).warzoneAirdropBalance();
  return { poolRaw: BigInt(balance), decimals: 18 };
}

export default async function airdropPool(req, res) {
  if (req.method !== "GET") return badMethod(res);
  const chainId = Number(getQuery(req).chainId);
  if (!SYMBOLS[chainId]) return json(res, 400, { ok: false, error: "chainId must be 101, 56 or 4663" });
  const hit = cache.get(chainId);
  if (hit && Date.now() - hit.at < CACHE_MS) return json(res, 200, hit.body);
  try {
    const [{ poolRaw, decimals }, nativeUsd] = await Promise.all([readPool(chainId), nativeUsdFor(chainId).catch(() => null)]);
    const poolNative = Number(poolRaw) / 10 ** decimals;
    const body = {
      ok: true,
      chainId,
      symbol: SYMBOLS[chainId],
      poolRaw: poolRaw.toString(),
      poolNative,
      poolUsd: nativeUsd ? poolNative * nativeUsd : null,
      nextDrawAt: nextDrawAt(),
      rules: {
        traderMinUsd: AIRDROP_USD_RULES.traderMinUsd,
        traderMinTrades: 3,
        traderMinActiveDays: 2,
        creatorMinUsd: AIRDROP_USD_RULES.creatorMinBondingUsd,
        creatorMinUniqueBuyers: AIRDROP_USD_RULES.creatorMinUniqueBuyers,
      },
    };
    cache.set(chainId, { at: Date.now(), body });
    res.setHeader("cache-control", "public, max-age=60");
    return json(res, 200, body);
  } catch (error) {
    console.warn("[api/airdrops/pool]", chainId, error?.message || error);
    return json(res, 200, { ok: false, chainId, symbol: SYMBOLS[chainId], error: "pool unavailable" });
  }
}
