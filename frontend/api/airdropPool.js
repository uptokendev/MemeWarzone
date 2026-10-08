/**
 * GET /api/airdrops/pool?chainId=101|56|4663 -- the weekly airdrop pool as the Coolify runner sees
 * it, for the front-page strip. Read-only, 60 s cache.
 *   Solana: airdrop_vault rent-free balance minus what open batches may still pay.
 *   EVM:    CommunityRewardsVault.warzoneAirdropBalance() of every pot: the main vault and, when
 *           COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_<chainId> is set, the gen-7 vault (founder 2026-10-08:
 *           two pots). poolRaw / poolNative / poolUsd are the sum; `pots` lists each one.
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

/** The EVM pots of a chain: main (env or the live default), then gen-7 when its vault env is set. */
export function evmPotVaults(chainId, env = process.env) {
  const main = String(env[`COMMUNITY_REWARDS_VAULT_ADDRESS_${chainId}`] || DEFAULT_VAULTS[chainId] || "").trim();
  if (!main) throw new Error(`no community rewards vault for chain ${chainId}`);
  const pots = [{ pot: "main", vaultAddress: main }];
  const gen7 = String(env[`COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_${chainId}`] || "").trim();
  if (gen7 && gen7.toLowerCase() !== main.toLowerCase()) pots.push({ pot: "gen7", vaultAddress: gen7 });
  return pots;
}

/** Sum of the pots that could be read; a pot that failed shows ok:false and is left out of the sum. */
export function sumPots(pots) {
  const readable = pots.filter((pot) => pot.ok);
  if (!readable.length) throw new Error(pots.map((pot) => pot.error).filter(Boolean).join("; ") || "no pot readable");
  return readable.reduce((sum, pot) => sum + BigInt(pot.poolRaw), 0n);
}

async function readPool(chainId, { readBalance = null } = {}) {
  if (chainId === 101) {
    const pool = await readSolanaAirdropPool();
    return { poolRaw: pool.available, decimals: 9, pots: null };
  }
  const vaults = evmPotVaults(chainId);
  const read = readBalance || (async (vaultAddress) => {
    const provider = await getServerReadProvider(chainId);
    return new Contract(vaultAddress, ["function warzoneAirdropBalance() view returns (uint256)"], provider).warzoneAirdropBalance();
  });
  const pots = await Promise.all(vaults.map(async (pot) => {
    try {
      return { ...pot, ok: true, poolRaw: BigInt(await read(pot.vaultAddress)) };
    } catch (error) {
      return { ...pot, ok: false, poolRaw: 0n, error: String(error?.message || error) };
    }
  }));
  return { poolRaw: sumPots(pots), decimals: 18, pots };
}

function potBody(pot, decimals, nativeUsd) {
  const native = Number(pot.poolRaw) / 10 ** decimals;
  return {
    pot: pot.pot,
    vaultAddress: pot.vaultAddress,
    ok: pot.ok,
    poolRaw: pot.poolRaw.toString(),
    poolNative: native,
    poolUsd: pot.ok && nativeUsd ? native * nativeUsd : null,
    ...(pot.ok ? {} : { error: "pot unavailable" }),
  };
}

export { readPool as readAirdropPool, potBody as airdropPotBody };

export default async function airdropPool(req, res) {
  if (req.method !== "GET") return badMethod(res);
  const chainId = Number(getQuery(req).chainId);
  if (!SYMBOLS[chainId]) return json(res, 400, { ok: false, error: "chainId must be 101, 56 or 4663" });
  const hit = cache.get(chainId);
  if (hit && Date.now() - hit.at < CACHE_MS) return json(res, 200, hit.body);
  try {
    const [{ poolRaw, decimals, pots }, nativeUsd] = await Promise.all([readPool(chainId), nativeUsdFor(chainId).catch(() => null)]);
    const poolNative = Number(poolRaw) / 10 ** decimals;
    const body = {
      ok: true,
      chainId,
      symbol: SYMBOLS[chainId],
      poolRaw: poolRaw.toString(),
      poolNative,
      poolUsd: nativeUsd ? poolNative * nativeUsd : null,
      ...(pots ? { pots: pots.map((pot) => potBody(pot, decimals, nativeUsd)) } : {}),
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
