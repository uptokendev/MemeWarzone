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
async function logsForToken(provider, address, topic0, token, positions) {
  const latest = await provider.getBlockNumber();
  const topic = zeroPadValue(token, 32);
  const ranges = [];
  for (let to = latest; to >= 0; to -= LOG_SPAN + 1) ranges.push([Math.max(0, to - LOG_SPAN), to]);
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
  if (proofs.has(key)) return proofs.get(key);
  try {
    const supply = await read(provider, token, "totalSupply");
    if (!supply || supply <= 0n) return { proven: false, reason: "token_supply_unreadable" };
    const share = (amount) => (amount ?? 0n) * 10_000n / supply;
    // A launch contract (the token's deployer()/creator() contract: a bonding curve or auction) still holding supply.
    for (const method of ["deployer", "creator"]) {
      const launch = await read(provider, token, method);
      if (!launch || launch === ZeroAddress || getAddress(launch) === RH_TOKEN_LAUNCHER) continue;
      const code = await provider.getCode(launch);
      if (code === "0x" || /^0xef0100[0-9a-f]{40}$/i.test(code)) continue;
      if (await read(provider, launch, "getThreshold") !== null) continue; // a Safe, not a curve
      if (share(await read(provider, token, "balanceOf", [launch])) >= LAUNCH_BLOCK_MIN_BPS) return { proven: false, reason: "launch_contract_holds_supply", launchContract: getAddress(launch) };
    }
    // Uniswap v3: any pool of this token with liquidity that holds a real share of supply.
    for (const log of await logsForToken(provider, RH_V3_FACTORY, V3_POOL_CREATED, token, [1, 2])) {
      let pool;
      try { pool = V3_CREATED_EVENT.parseLog(log).args.pool; } catch { continue; }
      if ((await read(provider, pool, "liquidity") ?? 0n) > 0n && share(await read(provider, token, "balanceOf", [pool])) >= POOL_PROOF_MIN_BPS) {
        return remember(key, { proven: true, method: "robinhood_uniswap_v3", pool: getAddress(pool) });
      }
    }
    // Uniswap v4: a hook-less or known post-graduation pool with liquidity, and the PoolManager holding supply.
    const managerShare = share(await read(provider, token, "balanceOf", [RH_V4_POOL_MANAGER]));
    if (managerShare >= POOL_PROOF_MIN_BPS) {
      for (const log of await logsForToken(provider, RH_V4_POOL_MANAGER, V4_INITIALIZE, token, [2, 3])) {
        let event;
        try { event = V4_INIT_EVENT.parseLog(log); } catch { continue; }
        const hooks = getAddress(event.args.hooks);
        const venue = hooks === ZeroAddress ? "uniswap_v4" : RH_POST_GRADUATION_HOOKS[hooks];
        if (!venue) continue;
        const liquidity = BigInt((await read(provider, RH_V4_POOL_MANAGER, "extsload", [v4LiquiditySlot(event.args.id)])) ?? "0x0") & ((1n << 128n) - 1n);
        if (liquidity > 0n) return remember(key, { proven: true, method: "robinhood_uniswap_v4", pool: event.args.id, hooks, venue });
      }
    }
    return { proven: false, reason: "no_verified_dex_pool" };
  } catch (error) {
    if (error?.code === "PROJECT_IMPORT_RPC_UNAVAILABLE") throw error;
    throw rpcError("Robinhood market check is temporarily unavailable. Please retry.", error);
  }
}

function remember(key, proof) {
  if (proofs.size >= 2000) proofs.delete(proofs.keys().next().value);
  proofs.set(key, proof);
  return proof;
}

export function clearRobinhoodGraduationCacheForTest() { proofs.clear(); }
