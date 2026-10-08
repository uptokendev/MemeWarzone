// BNB / Robinhood: harvest the LP fees of every graduated coin's permanently locked position.
//
// PermanentLpLocker (BNB, Topaz) and PermanentV3PositionLocker (Robinhood, Uniswap V3) both expose a
// permissionless, nonReentrant harvest(pool): it collects the position's fees, pays 80% to the
// creator and routes 20% through TreasuryRouterV3 (routeLpToken). The principal never moves (both
// lockers revert if it does). Nothing called it automatically. A protocol share the router refused
// is parked as pendingProtocolToken and retried here too (retryPendingProtocolToken, permissionless).
//
// harvest() is simulated first; its return value is exactly what it would collect, which is more
// reliable than the claimable views on Minimal Topaz. A zero simulation sends nothing.
//
// Off unless EVM_LP_HARVEST is "dry" or "send". Key: ARENA_LEAGUE_CRANK_PK, else
// RECRUITER_PAYOUT_OPERATOR_PK (any funded key; it only pays gas). One instance only.
//
// Extra lockers (the built-in gen-6 mainnet lockers, then EVM_GEN7_LOCKER_<chainId>, comma-separated) are
// harvested after the locker above, each with its own skip and retry keys.
import { ethers } from "ethers";
import { evmGen7Lockers } from "./evmGen7Lockers.js";

export const LP_HARVEST_CHAIN_IDS = Object.freeze([56, 4663, 97, 46630]);

// Mainnet lockers of the current generation (deployments/*/mainnet.quote-generation.json).
export const LP_LOCKER_MAINNET_DEFAULTS = Object.freeze({
  56: "0xdd41E0d13c637657A28b60F860205048221F325A",
  4663: "0xe2B3449491E4d5BE73E7E73A4DF9498eD9f3064C",
});

// Lockers of earlier / later generations that also hold graduated pools, harvested after the locker above
// (each with its own skip and retry keys). Gen-6 (2026-10-01): BNB PermanentLpLocker, Robinhood
// PermanentV3PositionLocker; read on chain 2026-10-08: harvest, pendingProtocolToken, retryPendingProtocolToken.
export const LP_EXTRA_LOCKER_MAINNET_DEFAULTS = Object.freeze({
  56: Object.freeze(["0xEEEfa12B14ea922B21bAf05Ad4aa79B2643c8eA6"]),
  4663: Object.freeze(["0x615b1AbE348edA2e5a44eCe32fb50fbC45d2AF07"]),
});

/** The extra lockers for a chain: the built-in mainnet list, then EVM_GEN7_LOCKER_<chainId>; no duplicates. */
export function extraLockersFor(chainId, env = process.env) {
  const seen = new Set();
  const out = [];
  for (const locker of [...(LP_EXTRA_LOCKER_MAINNET_DEFAULTS[chainId] || []), ...evmGen7Lockers(chainId, env).lockers]) {
    const key = String(locker).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(locker);
  }
  return out;
}

export const LOCKER_ABI = [
  "function harvest(address pool) returns (uint256 collected0, uint256 collected1)",
  "function pendingProtocolToken(address token) view returns (uint256)",
  "function retryPendingProtocolToken(address token) returns (uint256 amount)",
  "error PoolNotRegistered()",
];
const POOL_ABI = ["function token0() view returns (address)", "function token1() view returns (address)"];

export function lpHarvestMode(env = process.env) {
  const raw = String(env.EVM_LP_HARVEST || "").trim().toLowerCase();
  return raw === "send" || raw === "dry" ? raw : "off";
}

export function lockerAddressFor(chainId, env = process.env) {
  const explicit = String(env[`LP_LOCKER_ADDRESS_${chainId}`] || "").trim();
  if (explicit) return explicit;
  return LP_LOCKER_MAINNET_DEFAULTS[chainId] || "";
}

function rpcUrl(chainId, env) {
  const perChain = String(env[`ROBINHOOD_RPC_HTTP_${chainId}`] || env[`BSC_RPC_HTTP_${chainId}`] || env[`VITE_PUBLIC_RPC_${chainId}`] || "").trim();
  if (perChain) return perChain.split(",")[0].trim();
  if (chainId === 4663) return String(env.ROBINHOOD_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com").trim();
  if (chainId === 46630) return String(env.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com").trim();
  if (chainId === 56) return String(env.BSC_RPC_HTTP || "https://bsc-dataseed.binance.org").trim();
  return "";
}

function defaultChainFor(chainId, env, lockerOverride = "") {
  const locker = lockerOverride || lockerAddressFor(chainId, env);
  const url = rpcUrl(chainId, env);
  if (!locker || !url) return null;
  const network = ethers.Network.from(chainId);
  const provider = new ethers.JsonRpcProvider(url, network, { staticNetwork: network, batchMaxCount: 1 });
  const pk = String(env.ARENA_LEAGUE_CRANK_PK || env.RECRUITER_PAYOUT_OPERATOR_PK || "").trim();
  const wallet = pk ? new ethers.Wallet(pk, provider) : null;
  return {
    locker,
    provider,
    wallet,
    contract: new ethers.Contract(locker, LOCKER_ABI, wallet || provider),
    poolTokens: async (pool) => {
      const p = new ethers.Contract(pool, POOL_ABI, provider);
      return Promise.all([p.token0(), p.token1()]);
    },
  };
}

/** Graduated campaigns on the given chains that have a DEX pair recorded. */
export async function graduatedPools(db, chainIds) {
  const result = await db.query(
    `select c.chain_id, c.campaign_address, c.symbol, cms.dex_pair_address
       from public.campaigns c
       join public.campaign_market_state cms
         on cms.chain_id = c.chain_id
        and lower(cms.campaign_address) = lower(c.campaign_address)
      where c.chain_id = any($1::int[])
        and cms.dex_pair_address is not null
        and (c.graduated_at_chain is not null or c.graduated_block is not null)
      order by c.chain_id, c.graduated_at_chain asc nulls last`,
    [chainIds],
  );
  return (result.rows || []).filter((row) => /^0x[0-9a-fA-F]{40}$/.test(String(row.dex_pair_address || "")));
}

function revertName(error) {
  const text = `${error?.shortMessage || ""} ${error?.message || ""} ${error?.revert?.name || ""}`;
  if (/PoolNotRegistered/.test(text)) return "PoolNotRegistered";
  return (error?.shortMessage || error?.message || String(error)).slice(0, 200);
}

/** Sends one locker call after simulating it. Returns { status, txHash?, reason? }. */
async function sendChecked(c, method, args, mode) {
  if (mode !== "send") return { status: "dry-run" };
  if (!c.wallet) return { status: "no-key" };
  try {
    const balance = await c.provider.getBalance(c.wallet.address);
    if (balance === 0n) return { status: "no-gas", reason: c.wallet.address };
    await c.contract[method].staticCall(...args);
    const tx = await c.contract[method](...args);
    const receipt = await tx.wait();
    return { status: receipt?.status === 1 ? "sent" : "reverted", txHash: tx.hash };
  } catch (error) {
    return { status: "send-failed", reason: revertName(error) };
  }
}

/**
 * One pass. `skip` (Map key -> until ms) persists across passes: a pool the locker does not know
 * (an older generation's pool) is not simulated again for a day.
 */
export async function harvestLpFees({
  db,
  env = process.env,
  mode = lpHarvestMode(env),
  skip = new Map(),
  chainFor = (chainId) => defaultChainFor(chainId, env),
  gen7ChainFor = (chainId, locker) => defaultChainFor(chainId, env, locker),
  nowMs = Date.now(),
} = {}) {
  if (mode === "off") return [];
  // Per chain: the pinned (or LP_LOCKER_ADDRESS_<id>) locker first, then any gen-7 lockers.
  const chains = new Map();
  for (const chainId of LP_HARVEST_CHAIN_IDS) {
    const lockers = [];
    const c = chainFor(chainId);
    if (c) lockers.push({ c, prefix: "" });
    const base = String(c?.locker || "").toLowerCase();
    for (const locker of extraLockersFor(chainId, env)) {
      if (locker.toLowerCase() === base) continue;
      const g = gen7ChainFor(chainId, locker);
      if (g) lockers.push({ c: g, prefix: `${locker.toLowerCase()}:`, locker });
    }
    if (lockers.length) chains.set(chainId, lockers);
  }
  if (!chains.size) return [];
  const outcomes = [];
  const retried = new Set(); // pendingProtocolToken is per token, shared by every pool on the locker
  for (const row of await graduatedPools(db, [...chains.keys()])) {
    const chainId = Number(row.chain_id);
    for (const { c, prefix, locker } of chains.get(chainId)) {
      await harvestPoolOnLocker({ c, prefix, locker, row, chainId, mode, skip, nowMs, retried, outcomes });
    }
  }
  return outcomes;
}

/** One pool on one locker: simulate harvest, send if it collects, retry parked protocol shares. */
async function harvestPoolOnLocker({ c, prefix, locker, row, chainId, mode, skip, nowMs, retried, outcomes }) {
  const extra = locker ? { locker } : {};
  const pool = ethers.getAddress(row.dex_pair_address);
  const key = `${chainId}:${prefix}${pool}`;
  if ((skip.get(key) || 0) > nowMs) return;

  // 1. Fees: simulate harvest; send only when it would collect something.
  let collected;
  try {
    const from = c.wallet ? { from: c.wallet.address } : {};
    collected = await c.contract.harvest.staticCall(pool, from);
  } catch (error) {
    const reason = revertName(error);
    if (reason === "PoolNotRegistered") { skip.set(key, nowMs + 24 * 3600_000); return; }
    outcomes.push({ chainId, campaign: row.campaign_address, pool, step: "harvest", status: "sim-failed", reason, ...extra });
    return;
  }
  const [c0, c1] = [BigInt(collected[0] ?? collected.collected0 ?? 0), BigInt(collected[1] ?? collected.collected1 ?? 0)];
  if (c0 > 0n || c1 > 0n) {
    const sent = await sendChecked(c, "harvest", [pool], mode);
    outcomes.push({ chainId, campaign: row.campaign_address, symbol: row.symbol, pool, step: "harvest", amount0: c0.toString(), amount1: c1.toString(), ...sent, ...extra });
  }

  // 2. A protocol share the treasury router refused earlier: retry it (lands in the router's vaults).
  let tokens = [];
  try { tokens = await c.poolTokens(pool); } catch { tokens = []; }
  for (const token of tokens) {
    const tokenKey = `${chainId}:${prefix}${String(token).toLowerCase()}`;
    if (retried.has(tokenKey)) continue;
    retried.add(tokenKey);
    let pending = 0n;
    try { pending = BigInt(await c.contract.pendingProtocolToken(token)); } catch { pending = 0n; }
    if (pending === 0n) continue;
    const sent = await sendChecked(c, "retryPendingProtocolToken", [token], mode);
    outcomes.push({ chainId, campaign: row.campaign_address, pool, step: "retryPendingProtocolToken", token, amount: pending.toString(), ...sent, ...extra });
  }
}
