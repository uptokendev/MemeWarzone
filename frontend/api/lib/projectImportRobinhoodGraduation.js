import { Interface, getAddress, id, keccak256, AbiCoder, toBeHex, zeroPadValue, ZeroAddress } from "ethers";
import { isRevertError } from "./projectImportEvmCreator.js";

// Robinhood (4663) graduation proof (founder 2026-10-29: no token in its bonding phase may be imported).
// Read on mainnet 2026-10-29:
// - Uniswap V3 factory 0x1f7d7550… (our import swap uses it) and v4 PoolManager 0x8366a39C… (from the
//   Universal Router's poolManager()).
// - The 0x6319 launchpad keeps a coin's supply in its per-coin contract (the token's deployer()) while
//   it bonds, then moves it into a v4 pool with hook 0xE5e70264… (two coins: pool 57-70 min after creation).
// - The 0x0000FffF launcher puts 99.8% of supply into a hook-less v4 pool in the creation tx (no bonding).
// A pool with an unknown v4 hook proves nothing: a hook can itself be a bonding curve.
export const RH_V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
export const RH_V4_POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
export const RH_POST_GRADUATION_HOOKS = Object.freeze({
  [getAddress("0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044")]: "robinhood_launchpad_0x6319",
});
const RH_TOKEN_LAUNCHER = getAddress("0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0");
// The other side of a v3 pool must hold at least this much (raw units): 0.05 WETH or 150 USDG (Global Dollar, 6 dp),
// read on mainnet 2026-10-29 (GOOD's pool 35.7 WETH, STASH's pool 828 USDG).
export const RH_V3_QUOTE_MINIMUMS = Object.freeze({
  [getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73")]: 50_000_000_000_000_000n,
  [getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168")]: 150_000_000n,
});
const TRANSFER = id("Transfer(address,address,uint256)");
const V3_POOL_CREATED = id("PoolCreated(address,address,uint24,int24,address)");
const V4_INITIALIZE = id("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");
const V4_INIT_EVENT = new Interface(["event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)"]);
const V3_CREATED_EVENT = new Interface(["event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"]);
const READS = new Interface([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function deployer() view returns (address)",
  "function creator() view returns (address)",
  "function liquidity() view returns (uint128)",
  "function extsload(bytes32) view returns (bytes32)",
  "function getThreshold() view returns (uint256)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
// v4-core StateLibrary: pools mapping at slot 6, Pool.State.liquidity at offset 3.
const V4_POOLS_SLOT = 6n;
const V4_LIQUIDITY_OFFSET = 3n;
const LOG_SPAN = 9_999_999;
const POOL_PROOF_MIN_BPS = 10n;
const LAUNCH_BLOCK_MIN_BPS = 100n;
const proofs = new Map();

function rpcError(message, cause) { return Object.assign(new Error(message), { code: "PROJECT_IMPORT_RPC_UNAVAILABLE", cause }); }

async function read(provider, to, fn, args = []) {
  try { return READS.decodeFunctionResult(fn, await provider.call({ to, data: READS.encodeFunctionData(fn, args) }))[0]; }
  catch (error) {
    if (isRevertError(error)) return null;
    throw rpcError("Robinhood market check is temporarily unavailable. Please retry.", error);
  }
}

// Indexed token positions: v3 PoolCreated(token0, token1, fee) -> topics 1-2; v4 Initialize(id, currency0, currency1) -> topics 2-3.
async function logsForToken(provider, address, topic0, token, positions, fromBlock = 0) {
  const latest = await provider.getBlockNumber();
  const topic = zeroPadValue(token, 32);
  const ranges = [];
  for (let to = latest; to >= fromBlock; to -= LOG_SPAN + 1) ranges.push([Math.max(fromBlock, to - LOG_SPAN), to]);
  const out = [];
  for (let i = 0; i < ranges.length; i += 4) {
    const batch = await Promise.all(ranges.slice(i, i + 4).flatMap(([fromBlock, toBlock]) => positions.map((position) => {
      const topics = [topic0, null, null, null].slice(0, position + 1);
      topics[position] = topic;
      return provider.getLogs({ address, topics, fromBlock, toBlock });
    })));
    for (const logs of batch) out.push(...logs);
  }
  return out;
}

function v4LiquiditySlot(poolId) {
  const state = BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [poolId, V4_POOLS_SLOT])));
  return toBeHex(state + V4_LIQUIDITY_OFFSET, 32);
}

/**
 * { proven: true, method, pool } when the token trades on Uniswap v3, or on v4 in a hook-less pool or
 * a known post-graduation hook pool, and no launch contract still holds its supply; otherwise
 * { proven: false, reason }. RPC failures throw PROJECT_IMPORT_RPC_UNAVAILABLE. Proofs are cached.
 */
export async function robinhoodGraduationProof({ provider, token }) {
  const key = token.toLowerCase();
  const hit = proofs.get(key);
  if (hit && (!hit.expiresAt || hit.expiresAt > Date.now())) return hit.proof;
  const refuse = (proof) => remember(key, proof, REFUSAL_TTL_MS);
  try {
    const supply = await read(provider, token, "totalSupply");
    if (!supply || supply <= 0n) return refuse({ proven: false, reason: "token_supply_unreadable" });
    const share = (amount) => (amount ?? 0n) * 10_000n / supply;
    const isContract = async (address) => { const code = await provider.getCode(address); return code !== "0x" && !/^0xef0100[0-9a-f]{40}$/i.test(code); };
    // A launch contract still holding supply: the token's deployer()/creator() contract, or a contract that
    // received the supply when it was minted (an unlisted launchpad's curve or auction). Safes, the
    // launcher and the v4 PoolManager are not launch contracts.
    const candidates = new Set();
    for (const method of ["deployer", "creator"]) {
      const launch = await read(provider, token, method);
      if (launch && launch !== ZeroAddress) candidates.add(getAddress(launch));
    }
    const mints = (await logsForToken(provider, token, TRANSFER, ZeroAddress, [1])).sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));
    // No pool can exist before the token: search pool events from its first mint on (one range for recent coins).
    const createdAt = mints.length ? Number(mints[0].blockNumber) : 0;
    for (const log of mints.slice(0, 10)) {
      const to = log.topics?.[2] ? getAddress(`0x${String(log.topics[2]).slice(26)}`) : null;
      if (to && to !== ZeroAddress) candidates.add(to);
    }
    for (const launch of candidates) {
      if (launch === RH_TOKEN_LAUNCHER || launch === getAddress(RH_V4_POOL_MANAGER) || !(await isContract(launch))) continue;
      if (await read(provider, launch, "getThreshold") !== null) continue; // a Safe, not a curve
      if (await read(provider, launch, "token0") !== null) continue; // a v2/v3 pool: market, checked below
      if (share(await read(provider, token, "balanceOf", [launch])) >= LAUNCH_BLOCK_MIN_BPS) return refuse({ proven: false, reason: "launch_contract_holds_supply", launchContract: launch });
    }
    // Uniswap v4: list every pool of this token. Any pool with an unknown hook that has liquidity refuses
    // (the hook may be a bonding curve, and a side pool must not outvote it).
    const managerShare = share(await read(provider, token, "balanceOf", [RH_V4_POOL_MANAGER]));
    const v4Pools = [];
    if (managerShare > 0n) {
      const events = (await logsForToken(provider, RH_V4_POOL_MANAGER, V4_INITIALIZE, token, [2, 3], createdAt))
        .map((log) => { try { return V4_INIT_EVENT.parseLog(log).args; } catch { return null; } }).filter(Boolean);
      // Liquidity of every pool, read in parallel batches of 8.
      const liquidities = [];
      for (let i = 0; i < events.length; i += 8) {
        liquidities.push(...await Promise.all(events.slice(i, i + 8).map(async (event) => BigInt((await read(provider, RH_V4_POOL_MANAGER, "extsload", [v4LiquiditySlot(event.id)])) ?? "0x0") & ((1n << 128n) - 1n))));
      }
      for (const [i, event] of events.entries()) {
        if (liquidities[i] === 0n) continue;
        const hooks = getAddress(event.hooks);
        const venue = hooks === ZeroAddress ? "uniswap_v4" : RH_POST_GRADUATION_HOOKS[hooks];
        if (!venue) return refuse({ proven: false, reason: "unknown_hook_pool_has_liquidity", pool: event.id, hooks });
        v4Pools.push({ pool: event.id, hooks, venue });
      }
    }
    // Uniswap v3: a pool with liquidity, a real share of supply, and a funded WETH/USDG side.
    for (const log of await logsForToken(provider, RH_V3_FACTORY, V3_POOL_CREATED, token, [1, 2], createdAt)) {
      let event;
      try { event = V3_CREATED_EVENT.parseLog(log).args; } catch { continue; }
      const quote = getAddress(event.token0) === getAddress(token) ? getAddress(event.token1) : getAddress(event.token0);
      const minimum = RH_V3_QUOTE_MINIMUMS[quote];
      if (minimum === undefined) continue;
      if ((await read(provider, event.pool, "liquidity") ?? 0n) > 0n
        && share(await read(provider, token, "balanceOf", [event.pool])) >= POOL_PROOF_MIN_BPS
        && (await read(provider, quote, "balanceOf", [event.pool]) ?? 0n) >= minimum) {
        return remember(key, { proven: true, method: "robinhood_uniswap_v3", pool: getAddress(event.pool), quote });
      }
    }
    // Uniswap v4: a hook-less or known post-graduation pool with liquidity, and the PoolManager holding supply.
    if (managerShare >= POOL_PROOF_MIN_BPS && v4Pools.length) return remember(key, { proven: true, method: "robinhood_uniswap_v4", ...v4Pools[0] });
    return refuse({ proven: false, reason: "no_verified_dex_pool" });
  } catch (error) {
    if (error?.code === "PROJECT_IMPORT_RPC_UNAVAILABLE") throw error;
    throw rpcError("Robinhood market check is temporarily unavailable. Please retry.", error);
  }
}

// Passes are kept for the process; refusals for 5 minutes so repeated requests do not repeat ~44 getLogs.
const REFUSAL_TTL_MS = 5 * 60 * 1000;
function remember(key, proof, ttlMs = 0) {
  if (proofs.size >= 2000) proofs.delete(proofs.keys().next().value);
  proofs.set(key, { proof, expiresAt: ttlMs ? Date.now() + ttlMs : 0 });
  return proof;
}

export function clearRobinhoodGraduationCacheForTest() { proofs.clear(); }
