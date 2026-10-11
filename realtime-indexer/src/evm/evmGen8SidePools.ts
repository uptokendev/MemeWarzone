/**
 * Side-pool watcher (design 6.8): pools of our gen-8 coins that do NOT use our hook. Nobody can prevent them (the coin
 * is a plain ERC20); they pay us nothing, so their volume is never counted anywhere (no curve_trades, dex_trades,
 * candles, stats, leagues). They are recorded in evm_gen8_side_pools / evm_gen8_side_pool_volume and raise alerts in
 * public.reward_alerts (reward_type 'gen8_side_pool').
 *
 * Sources per chain:
 *   - Uniswap V4 PoolManager Initialize with our coin as currency0 or currency1 and any key other than ours;
 *   - V2 PairCreated, V3 PoolCreated (Uniswap and PancakeSwap), Solidly-style PoolCreated (Topaz) on the factories in
 *     EVM_GEN8_SIDE_FACTORIES_<id> ("v2:0x..,v3:0x..,v3_pancake:0x..,solidly:0x.."), defaulting to the factories known
 *     on that chain (BSC: PancakeSwap V2/V3 and Uniswap V2/V3, plus TOPAZ_FACTORY_ADDRESS_56 when set; Robinhood 4663:
 *     Uniswap V3). Robinhood's Uniswap V2 and PancakeSwap factories are not known to this repo: set them by env.
 * Volume = coins moved (raw) per swap, summed per hour. Alerts: a new side pool (warning), and side volume over 24 h of
 * at least EVM_GEN8_SIDE_ALERT_SHARE_BPS of our pool's 24 h coin volume and at least EVM_GEN8_SIDE_ALERT_MIN_COINS.
 */
import { ethers } from "ethers";
import { intEnv, type Gen8ChainConfig } from "./evmGen8Config.js";
import { GEN8_TOPICS, V4_DYNAMIC_FEE_FLAG, V4_POOL_MANAGER_IFACE } from "./evmGen8Abi.js";
import type { Queryable } from "./evmGen8Store.js";

export const GEN8_SIDE_ALERT_TYPE = "gen8_side_pool";

export type SideVenue = "v2" | "v3" | "v3_pancake" | "solidly" | "v4";
export type SideFactory = { venue: Exclude<SideVenue, "v4">; address: string };

export const SIDE_IFACE = new ethers.Interface([
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)",
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
  "event PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint128 protocolFeesToken0, uint128 protocolFeesToken1)",
]);
const topicOf = (sig: string) => ethers.id(sig);
export const SIDE_TOPICS = {
  pairCreated: topicOf("PairCreated(address,address,address,uint256)"),
  v3PoolCreated: topicOf("PoolCreated(address,address,uint24,int24,address)"),
  solidlyPoolCreated: topicOf("PoolCreated(address,address,bool,address,uint256)"),
  v2Swap: topicOf("Swap(address,uint256,uint256,uint256,uint256,address)"),
  v3Swap: topicOf("Swap(address,address,int256,int256,uint160,uint128,int24)"),
  pancakeV3Swap: topicOf("Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)"),
};

/** Factories known in this repo or in the canonical deployments (BSC: PancakeSwap docs, as projectImportBnbMarket.js). */
const DEFAULT_FACTORIES: Record<number, SideFactory[]> = {
  56: [
    { venue: "v2", address: "0xca143ce32fe78f1f7019d7d551a6402fc5350c73" }, // PancakeSwap V2
    { venue: "v3_pancake", address: "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865" }, // PancakeSwap V3
    { venue: "v2", address: "0x8909dc15e40173ff4699343b6eb8132c65e18ec6" }, // Uniswap V2 (BNB Chain)
    { venue: "v3", address: "0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7" }, // Uniswap V3 (BNB Chain)
  ],
  4663: [{ venue: "v3", address: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa" }], // Uniswap V3 (evmGraduationKeeper KNOWN_V3)
};

export function sideFactories(chainId: number, env: NodeJS.ProcessEnv = process.env): SideFactory[] {
  const raw = String(env[`EVM_GEN8_SIDE_FACTORIES_${chainId}`] || "").trim();
  const out: SideFactory[] = [];
  if (raw) {
    for (const part of raw.split(",")) {
      const [venue, address] = part.trim().split(":").map((s) => s.trim());
      if (["v2", "v3", "v3_pancake", "solidly"].includes(venue) && /^0x[0-9a-fA-F]{40}$/.test(address || "")) out.push({ venue: venue as SideFactory["venue"], address: address!.toLowerCase() });
    }
    return out;
  }
  out.push(...(DEFAULT_FACTORIES[chainId] || []));
  const topaz = String(env[`TOPAZ_FACTORY_ADDRESS_${chainId}`] || "").trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(topaz)) out.push({ venue: "solidly", address: topaz.toLowerCase() });
  return out;
}

export type SidePoolFound = { poolKey: string; token: string; venue: SideVenue; factory: string; other: string; fee: number | null; hooks: string | null; block: number; tx: string };

type L = { address: string; topics: readonly string[]; data: string; blockNumber: number; transactionHash: string };

/** Pure: side pools in creation logs (factories and PoolManager Initialize). Our own pools are skipped. */
export function findSidePools(logs: L[], input: { tokens: Set<string>; factories: SideFactory[]; poolManager: string; hook: string }): SidePoolFound[] {
  const byAddr = new Map(input.factories.map((f) => [f.address, f]));
  const out: SidePoolFound[] = [];
  for (const log of logs) {
    const address = String(log.address).toLowerCase();
    const t0 = String(log.topics[0]).toLowerCase();
    const base = { block: Number(log.blockNumber), tx: String(log.transactionHash).toLowerCase() };
    if (address === input.poolManager && t0 === GEN8_TOPICS.Initialize) {
      const a = V4_POOL_MANAGER_IFACE.parseLog({ topics: [...log.topics], data: log.data })!.args as any;
      const c0 = String(a.currency0).toLowerCase();
      const c1 = String(a.currency1).toLowerCase();
      const hooks = String(a.hooks).toLowerCase();
      const ours = hooks === input.hook && Number(a.fee) === V4_DYNAMIC_FEE_FLAG && c0 === ethers.ZeroAddress;
      const token = input.tokens.has(c0) ? c0 : input.tokens.has(c1) ? c1 : null;
      if (!token || ours) continue;
      out.push({ ...base, poolKey: String(a.id).toLowerCase(), token, venue: "v4", factory: input.poolManager, other: token === c0 ? c1 : c0, fee: Number(a.fee), hooks });
      continue;
    }
    const f = byAddr.get(address);
    if (!f) continue;
    const t1 = ethers.getAddress(ethers.dataSlice(log.topics[1]!, 12)).toLowerCase();
    const t2 = ethers.getAddress(ethers.dataSlice(log.topics[2]!, 12)).toLowerCase();
    const token = input.tokens.has(t1) ? t1 : input.tokens.has(t2) ? t2 : null;
    if (!token) continue;
    const other = token === t1 ? t2 : t1;
    if (t0 === SIDE_TOPICS.pairCreated && f.venue === "v2") {
      const [pair] = ethers.AbiCoder.defaultAbiCoder().decode(["address", "uint256"], log.data);
      out.push({ ...base, poolKey: String(pair).toLowerCase(), token, venue: "v2", factory: address, other, fee: null, hooks: null });
    } else if (t0 === SIDE_TOPICS.v3PoolCreated && (f.venue === "v3" || f.venue === "v3_pancake")) {
      const [, pool] = ethers.AbiCoder.defaultAbiCoder().decode(["int24", "address"], log.data);
      out.push({ ...base, poolKey: String(pool).toLowerCase(), token, venue: f.venue, factory: address, other, fee: Number(BigInt(log.topics[3]!)), hooks: null });
    } else if (t0 === SIDE_TOPICS.solidlyPoolCreated && f.venue === "solidly") {
      const [pool] = ethers.AbiCoder.defaultAbiCoder().decode(["address", "uint256"], log.data);
      out.push({ ...base, poolKey: String(pool).toLowerCase(), token, venue: "solidly", factory: address, other, fee: BigInt(log.topics[3]!) === 1n ? 1 : 0, hooks: null });
    }
  }
  return out;
}

/** Pure: coins moved by one side-pool swap (raw, positive), given which side of the pool is our coin. */
export function sideSwapCoinVolume(log: L, pool: { venue: SideVenue; coinIsToken0: boolean }): bigint {
  const t0 = String(log.topics[0]).toLowerCase();
  const abs = (v: bigint) => (v < 0n ? -v : v);
  if (pool.venue === "v4") {
    const a = V4_POOL_MANAGER_IFACE.parseLog({ topics: [...log.topics], data: log.data })!.args as any;
    return abs(BigInt(pool.coinIsToken0 ? a.amount0 : a.amount1));
  }
  if (t0 === SIDE_TOPICS.v2Swap) {
    const [a0In, a1In, a0Out, a1Out] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256", "uint256", "uint256", "uint256"], log.data).map((x) => BigInt(x));
    return pool.coinIsToken0 ? (a0In! > a0Out! ? a0In! : a0Out!) : (a1In! > a1Out! ? a1In! : a1Out!);
  }
  if (t0 === SIDE_TOPICS.v3Swap || t0 === SIDE_TOPICS.pancakeV3Swap) {
    const [a0, a1] = ethers.AbiCoder.defaultAbiCoder().decode(["int256", "int256"], ethers.dataSlice(log.data, 0, 64)).map((x) => BigInt(x));
    return abs(pool.coinIsToken0 ? a0! : a1!);
  }
  return 0n;
}

export type SideProvider = {
  getBlockNumber(): Promise<number>;
  getLogs(filter: { address?: string | string[]; topics?: Array<string | string[] | null>; fromBlock: number; toBlock: number }): Promise<L[]>;
  getBlock(n: number): Promise<{ timestamp: number | bigint } | null>;
};

export async function runGen8SidePoolWatcherOnce(opts: {
  db: Queryable; cfg: Gen8ChainConfig; provider: SideProvider; env?: NodeJS.ProcessEnv;
  alert: (a: { severity: "critical" | "warning" | "info"; kind: string; chainId: number; subject?: string; title: string; message: string; extra?: Record<string, unknown> }) => Promise<unknown>;
}): Promise<{ from: number; to: number; created: number; swaps: number } | null> {
  const { db, cfg, provider } = opts;
  const env = opts.env || process.env;
  const cursor = `gen8-side:${cfg.hook.address}`;
  const cur = await db.query(`select last_indexed_block from public.indexer_state where chain_id = $1 and cursor = $2`, [cfg.chainId, cursor]);
  const head = (await provider.getBlockNumber()) - intEnv(env.EVM_GEN8_CONFIRMATIONS, 1, 0, 64);
  const from = Math.max(Number(cur.rows[0]?.last_indexed_block || 0), cfg.startBlock);
  if (from > head) return null;
  const to = Math.min(head, from + intEnv(env.EVM_GEN8_SIDE_CHUNK, 2_000, 1, 50_000) - 1);
  const tokensRes = await db.query(`select token_address from public.evm_gen8_pools where chain_id = $1 and hook_address = $2`, [cfg.chainId, cfg.hook.address]);
  const tokens = new Set<string>(tokensRes.rows.map((r) => String(r.token_address)));
  const factories = sideFactories(cfg.chainId, env);
  let created = 0;
  let swaps = 0;
  if (tokens.size) {
    const creation: L[] = [];
    creation.push(...(await provider.getLogs({ address: cfg.poolManager, topics: [GEN8_TOPICS.Initialize], fromBlock: from, toBlock: to })));
    if (factories.length) {
      creation.push(...(await provider.getLogs({ address: factories.map((f) => f.address), topics: [[SIDE_TOPICS.pairCreated, SIDE_TOPICS.v3PoolCreated, SIDE_TOPICS.solidlyPoolCreated]], fromBlock: from, toBlock: to })));
    }
    for (const p of findSidePools(creation, { tokens, factories, poolManager: cfg.poolManager, hook: cfg.hook.address })) {
      const ins = await db.query(
        `insert into public.evm_gen8_side_pools(chain_id, pool_key, token_address, venue, factory_address, other_token, fee, hooks, created_block, created_tx)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (chain_id, pool_key) do nothing returning 1`,
        [cfg.chainId, p.poolKey, p.token, p.venue, p.factory, p.other, p.fee, p.hooks, p.block, p.tx],
      );
      if (ins.rows.length) {
        created += 1;
        await opts.alert({
          severity: "warning", kind: "gen8_side_pool_created", chainId: cfg.chainId, subject: p.poolKey,
          title: `Side pool for a gen-8 coin on chain ${cfg.chainId}`,
          message: `${p.venue} pool ${p.poolKey} (factory ${p.factory}) pairs ${p.token} with ${p.other}, created in ${p.tx}. Not our hook: no fee, not counted.`,
          extra: { token: p.token, venue: p.venue, other: p.other },
        });
      }
    }
    // Swaps of every known side pool in the range.
    const side = await db.query(`select pool_key, token_address, venue, other_token from public.evm_gen8_side_pools where chain_id = $1`, [cfg.chainId]);
    const pools = new Map<string, { venue: SideVenue; token: string; coinIsToken0: boolean }>();
    for (const r of side.rows) {
      const token = String(r.token_address);
      const other = String(r.other_token || "");
      pools.set(String(r.pool_key), { venue: r.venue as SideVenue, token, coinIsToken0: BigInt(token) < BigInt(other || "0x" + "f".repeat(40)) });
    }
    const swapLogs: Array<{ log: L; key: string }> = [];
    const addrPools = [...pools.entries()].filter(([, p]) => p.venue !== "v4").map(([k]) => k);
    for (let i = 0; i < addrPools.length; i += 100) {
      const chunk = addrPools.slice(i, i + 100);
      for (const log of await provider.getLogs({ address: chunk, topics: [[SIDE_TOPICS.v2Swap, SIDE_TOPICS.v3Swap, SIDE_TOPICS.pancakeV3Swap]], fromBlock: from, toBlock: to })) {
        swapLogs.push({ log, key: String(log.address).toLowerCase() });
      }
    }
    const v4Ids = [...pools.entries()].filter(([, p]) => p.venue === "v4").map(([k]) => k);
    for (let i = 0; i < v4Ids.length; i += 50) {
      for (const log of await provider.getLogs({ address: cfg.poolManager, topics: [GEN8_TOPICS.Swap, v4Ids.slice(i, i + 50)], fromBlock: from, toBlock: to })) {
        swapLogs.push({ log, key: String(log.topics[1]).toLowerCase() });
      }
    }
    const times = new Map<number, number>();
    for (const { log, key } of swapLogs) {
      const p = pools.get(key);
      if (!p) continue;
      const vol = sideSwapCoinVolume(log, p);
      let ts = times.get(log.blockNumber);
      if (ts === undefined) {
        ts = Number((await provider.getBlock(log.blockNumber))?.timestamp ?? 0);
        times.set(log.blockNumber, ts);
      }
      const hour = new Date(Math.floor(ts / 3600) * 3600 * 1000);
      await db.query(
        `insert into public.evm_gen8_side_pool_volume(chain_id, pool_key, hour, coin_volume_raw, swaps) values ($1,$2,$3,$4,1)
         on conflict (chain_id, pool_key, hour) do update set coin_volume_raw = public.evm_gen8_side_pool_volume.coin_volume_raw + excluded.coin_volume_raw, swaps = public.evm_gen8_side_pool_volume.swaps + 1`,
        [cfg.chainId, key, hour, vol.toString()],
      );
      await db.query(
        `update public.evm_gen8_side_pools set coin_volume_raw_total = coin_volume_raw_total + $3, swaps_total = swaps_total + 1,
                last_swap_block = greatest(coalesce(last_swap_block, 0), $4), last_swap_at = greatest(coalesce(last_swap_at, to_timestamp(0)), to_timestamp($5)), updated_at = now()
          where chain_id = $1 and pool_key = $2`,
        [cfg.chainId, key, vol.toString(), log.blockNumber, ts],
      );
      swaps += 1;
    }
    if (swaps) await checkSideVolumeAlerts(db, cfg, env, opts.alert);
  }
  await db.query(
    `insert into public.indexer_state(chain_id, cursor, last_indexed_block) values ($1,$2,$3)
     on conflict (chain_id, cursor) do update set last_indexed_block = greatest(public.indexer_state.last_indexed_block, excluded.last_indexed_block), updated_at = now()`,
    [cfg.chainId, cursor, to + 1],
  );
  return { from, to, created, swaps };
}

export async function checkSideVolumeAlerts(db: Queryable, cfg: Gen8ChainConfig, env: NodeJS.ProcessEnv, alert: (a: any) => Promise<unknown>) {
  const shareBps = BigInt(intEnv(env.EVM_GEN8_SIDE_ALERT_SHARE_BPS, 1_000, 1, 1_000_000));
  const minCoins = BigInt(intEnv(env.EVM_GEN8_SIDE_ALERT_MIN_COINS, 1_000_000, 0)) * 10n ** 18n;
  const r = await db.query(
    `with side as (
       select s.token_address, coalesce(sum(v.coin_volume_raw), 0) as vol
         from public.evm_gen8_side_pools s
         join public.evm_gen8_side_pool_volume v on v.chain_id = s.chain_id and v.pool_key = s.pool_key
        where s.chain_id = $1 and v.hour >= now() - interval '24 hours'
        group by s.token_address
     ), ours as (
       select campaign_address as token_address, sum(token_amount_raw::numeric) as vol from public.curve_trades
        where chain_id = $1 and venue = 'gen8' and block_time >= now() - interval '24 hours' group by campaign_address
       union all
       select campaign_address, sum(token_amount_raw::numeric) from public.dex_trades
        where chain_id = $1 and execution_source = 'gen8_v4' and status = 'confirmed' and block_time >= now() - interval '24 hours' group by campaign_address
     )
     select side.token_address, side.vol::text as side_vol, coalesce((select sum(o.vol) from ours o where o.token_address = side.token_address), 0)::text as our_vol
       from side`,
    [cfg.chainId],
  );
  for (const row of r.rows) {
    const sideVol = BigInt(String(row.side_vol).split(".")[0]);
    const ourVol = BigInt(String(row.our_vol).split(".")[0]);
    if (sideVol >= minCoins && sideVol * 10_000n >= ourVol * shareBps) {
      await alert({
        severity: "warning", kind: "gen8_side_pool_volume", chainId: cfg.chainId, subject: String(row.token_address),
        title: `Side-pool volume on a gen-8 coin, chain ${cfg.chainId}`,
        message: `24 h coin volume in side pools ${sideVol} vs ${ourVol} in our pool (threshold ${shareBps} bps). Not counted anywhere.`,
        extra: { token: row.token_address, sideVolRaw: sideVol.toString(), ourVolRaw: ourVol.toString() },
      });
    }
  }
}
