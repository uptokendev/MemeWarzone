import { ethers } from "ethers";
import { ablyRest, tokenChannel } from "./ably.js";
import { pool } from "./db.js";
import { ENV } from "./env.js";
import { createWorkingProvider, maskRpcUrl, parseRpcList } from "./rpcProvider.js";

const MOCK_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function factory() view returns (address)",
  "function reserve0() view returns (uint256)",
  "function reserve1() view returns (uint256)",
  "event Swap(address indexed sender,address indexed tokenIn,address indexed tokenOut,uint256 amountIn,uint256 amountOut,uint256 feeAmount,address recipient)",
] as const;

const CANONICAL_V3_SWAP_ABI = [
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
] as const;

const V3_FACTORY_ABI = [
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)",
] as const;

const mockIface = new ethers.Interface(MOCK_POOL_ABI);
const canonicalIface = new ethers.Interface(CANONICAL_V3_SWAP_ABI);
const MOCK_SWAP_TOPIC = mockIface.getEvent("Swap")!.topicHash;
const CANONICAL_SWAP_TOPIC = canonicalIface.getEvent("Swap")!.topicHash;
const LOOP_SYMBOL = Symbol.for("memewarzone.robinhoodV3PoolIndexerStarted");
const globalState = globalThis as any;

type ChainConfig = {
  chainId: 4663 | 46630;
  rpcUrls: string[];
  swapRouterAddress: string;
};

type IndexedPool = {
  chainId: number;
  pairAddress: string;
  campaignAddress: string;
  tokenAddress: string;
  wrappedNativeAddress: string;
  routerAddress: string;
  factoryAddress: string;
  token0Address: string;
  token1Address: string;
  feePpm: number;
  graduationBlock: number;
  lastIndexedBlock: number | null;
};

type NormalizedSwap = {
  side: "buy" | "sell";
  sender: string | null;
  recipient: string | null;
  tokenAmountRaw: bigint;
  nativeAmountRaw: bigint;
};

type CandleResolution = "1s" | "5s" | "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";
const RESOLUTION_MS: Record<CandleResolution, number> = {
  "1s": 1_000,
  "5s": 5_000,
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

function enabled(): boolean {
  return String(process.env.ENABLE_ROBINHOOD_V3_POOL_INDEXER || "0").trim() === "1";
}

function chainConfigs(): ChainConfig[] {
  const active = new Set(ENV.EVM_INDEXER_CHAIN_IDS);
  const result: ChainConfig[] = [];
  const testnet = parseRpcList(ENV.ROBINHOOD_RPC_HTTP_46630);
  if (active.has(46630) && testnet.length) {
    result.push({
      chainId: 46630,
      rpcUrls: testnet,
      swapRouterAddress: String(ENV.ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_46630 || "").toLowerCase(),
    });
  }
  const mainnet = parseRpcList(ENV.ROBINHOOD_RPC_HTTP_4663);
  if (active.has(4663) && mainnet.length) {
    result.push({
      chainId: 4663,
      rpcUrls: mainnet,
      swapRouterAddress: String(ENV.ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_4663 || "").toLowerCase(),
    });
  }
  return result;
}

function bucketStart(blockTime: Date, resolution: CandleResolution): Date {
  const duration = RESOLUTION_MS[resolution];
  return new Date(Math.floor(blockTime.getTime() / duration) * duration);
}

function lowerAddress(value: unknown): string {
  const raw = String(value || "").trim();
  return ethers.isAddress(raw) ? ethers.getAddress(raw).toLowerCase() : "";
}

async function tryCall<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch {
    return null;
  }
}

async function discoverPools(provider: ethers.JsonRpcProvider, config: ChainConfig): Promise<void> {
  const candidates = await pool.query(
    `select chain_id,campaign_address,token_address,dex_pair_address,graduation_block
       from public.campaign_market_state
      where chain_id=$1
        and indexing_enabled=true
        and dex_pair_address is not null
        and dex_pair_address<>''
        and market_stage in ('GRADUATING','DEX_PENDING','DEX_ACTIVE','DEX_DEGRADED')
      order by graduation_block asc nulls last`,
    [config.chainId],
  );

  for (const row of candidates.rows) {
    const campaignAddress = lowerAddress(row.campaign_address);
    const tokenAddress = lowerAddress(row.token_address);
    const pairAddress = lowerAddress(row.dex_pair_address);
    if (!campaignAddress || !tokenAddress || !pairAddress) continue;

    try {
      const code = await provider.getCode(pairAddress);
      if (!code || code === "0x") throw new Error("V3 pool has no bytecode");

      const pair = new ethers.Contract(pairAddress, MOCK_POOL_ABI, provider) as any;
      const [token0Raw, token1Raw, feeRaw, factoryRaw] = await Promise.all([
        pair.token0(),
        pair.token1(),
        pair.fee(),
        pair.factory(),
      ]);
      const token0Address = lowerAddress(token0Raw);
      const token1Address = lowerAddress(token1Raw);
      const factoryAddress = lowerAddress(factoryRaw);
      const feePpm = Number(feeRaw);
      if (!token0Address || !token1Address || !factoryAddress) throw new Error("V3 pool metadata incomplete");
      if (token0Address !== tokenAddress && token1Address !== tokenAddress) throw new Error("V3 pool does not contain campaign token");
      if (!Number.isInteger(feePpm) || feePpm <= 0 || feePpm > 1_000_000) throw new Error(`Invalid V3 fee tier ${feePpm}`);

      const wrappedNativeAddress = token0Address === tokenAddress ? token1Address : token0Address;
      const factory = new ethers.Contract(factoryAddress, V3_FACTORY_ABI, provider) as any;
      const factoryPair = lowerAddress(await tryCall(() => factory.getPool(tokenAddress, wrappedNativeAddress, feePpm)));
      if (factoryPair && factoryPair !== pairAddress) throw new Error("V3 factory pool mismatch");

      const reserve0 = BigInt(String((await tryCall(() => pair.reserve0())) ?? 0n));
      const reserve1 = BigInt(String((await tryCall(() => pair.reserve1())) ?? 0n));
      const reserveTokenRaw = token0Address === tokenAddress ? reserve0 : reserve1;
      const reserveNativeRaw = token0Address === wrappedNativeAddress ? reserve0 : reserve1;
      const graduationBlock = Math.max(0, Number(row.graduation_block || 0));
      const routerAddress = config.swapRouterAddress || ethers.ZeroAddress.toLowerCase();
      const feeBps = Math.max(0, Math.round(feePpm / 100));

      await pool.query("begin");
      try {
        await pool.query(
          `insert into public.dex_pools(
             chain_id,pair_address,campaign_address,token_address,wrapped_native_address,
             router_address,factory_address,factory_generation,token0_address,token1_address,
             stable,fee_bps,graduation_block,support_enabled,indexing_enabled,
             reserve_token_raw,reserve_native_raw,updated_at
           ) values($1,$2,$3,$4,$5,$6,$7,'v3',$8,$9,false,$10,$11,true,true,$12,$13,now())
           on conflict(chain_id,pair_address) do update set
             campaign_address=excluded.campaign_address,
             token_address=excluded.token_address,
             wrapped_native_address=excluded.wrapped_native_address,
             router_address=excluded.router_address,
             factory_address=excluded.factory_address,
             token0_address=excluded.token0_address,
             token1_address=excluded.token1_address,
             stable=false,
             fee_bps=excluded.fee_bps,
             support_enabled=true,
             indexing_enabled=true,
             reserve_token_raw=excluded.reserve_token_raw,
             reserve_native_raw=excluded.reserve_native_raw,
             updated_at=now()`,
          [
            config.chainId,
            pairAddress,
            campaignAddress,
            tokenAddress,
            wrappedNativeAddress,
            routerAddress,
            factoryAddress,
            token0Address,
            token1Address,
            feeBps,
            graduationBlock,
            reserveTokenRaw.toString(),
            reserveNativeRaw.toString(),
          ],
        );

        await pool.query(
          `update public.campaign_market_state
              set market_stage='DEX_ACTIVE',
                  dex_router_address=$3,
                  dex_factory_address=$4,
                  wrapped_native_address=$5,
                  pool_stable=false,
                  pool_fee_bps=$6,
                  pool_verified=true,
                  indexing_enabled=true,
                  last_verified_at=now(),
                  last_error=null,
                  updated_at=now()
            where chain_id=$1 and campaign_address=$2`,
          [config.chainId, campaignAddress, routerAddress, factoryAddress, wrappedNativeAddress, feeBps],
        );
        await pool.query(
          `update public.campaigns
              set market_stage='DEX_ACTIVE',bonding_active=false,support_enabled=true,indexing_enabled=true,updated_at=now()
            where chain_id=$1 and campaign_address=$2`,
          [config.chainId, campaignAddress],
        );
        await pool.query("commit");
      } catch (error) {
        await pool.query("rollback");
        throw error;
      }
    } catch (error) {
      const message = String((error as any)?.shortMessage || (error as any)?.message || error);
      await pool.query(
        `update public.campaign_market_state
            set market_stage='DEX_DEGRADED',pool_verified=false,last_error=$3,updated_at=now()
          where chain_id=$1 and campaign_address=$2`,
        [config.chainId, campaignAddress, message.slice(0, 1000)],
      );
      await pool.query(
        `update public.campaigns set market_stage='DEX_DEGRADED',updated_at=now()
          where chain_id=$1 and campaign_address=$2`,
        [config.chainId, campaignAddress],
      );
      console.warn("[robinhood-v3] pool discovery degraded", { chainId: config.chainId, campaignAddress, error: message });
    }
  }
}

async function listPools(chainId: number): Promise<IndexedPool[]> {
  const maxPools = Math.max(1, Number(process.env.ROBINHOOD_V3_POOL_INDEXER_MAX_POOLS || 100));
  const result = await pool.query(
    `select chain_id,pair_address,campaign_address,token_address,wrapped_native_address,
            router_address,factory_address,token0_address,token1_address,fee_bps,
            graduation_block,last_indexed_block
       from public.dex_pools
      where chain_id=$1 and support_enabled=true and indexing_enabled=true
      order by coalesce(last_indexed_block,graduation_block) asc
      limit $2`,
    [chainId, maxPools],
  );
  return result.rows.map((row: any) => ({
    chainId: Number(row.chain_id),
    pairAddress: lowerAddress(row.pair_address),
    campaignAddress: lowerAddress(row.campaign_address),
    tokenAddress: lowerAddress(row.token_address),
    wrappedNativeAddress: lowerAddress(row.wrapped_native_address),
    routerAddress: lowerAddress(row.router_address),
    factoryAddress: lowerAddress(row.factory_address),
    token0Address: lowerAddress(row.token0_address),
    token1Address: lowerAddress(row.token1_address),
    feePpm: Number(row.fee_bps || 0) * 100,
    graduationBlock: Number(row.graduation_block || 0),
    lastIndexedBlock: row.last_indexed_block == null ? null : Number(row.last_indexed_block),
  }));
}

function normalizeMockSwap(indexedPool: IndexedPool, parsed: ethers.LogDescription): NormalizedSwap | null {
  const tokenIn = lowerAddress(parsed.args.tokenIn);
  const tokenOut = lowerAddress(parsed.args.tokenOut);
  const amountIn = BigInt(parsed.args.amountIn);
  const amountOut = BigInt(parsed.args.amountOut);
  const sender = lowerAddress(parsed.args.sender) || null;
  const recipient = lowerAddress(parsed.args.recipient) || null;

  if (tokenIn === indexedPool.wrappedNativeAddress && tokenOut === indexedPool.tokenAddress) {
    return { side: "buy", sender, recipient, tokenAmountRaw: amountOut, nativeAmountRaw: amountIn };
  }
  if (tokenIn === indexedPool.tokenAddress && tokenOut === indexedPool.wrappedNativeAddress) {
    return { side: "sell", sender, recipient, tokenAmountRaw: amountIn, nativeAmountRaw: amountOut };
  }
  return null;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function normalizeCanonicalSwap(indexedPool: IndexedPool, parsed: ethers.LogDescription): NormalizedSwap | null {
  const amount0 = BigInt(parsed.args.amount0);
  const amount1 = BigInt(parsed.args.amount1);
  const sender = lowerAddress(parsed.args.sender) || null;
  const recipient = lowerAddress(parsed.args.recipient) || null;
  const token0IsLaunch = indexedPool.token0Address === indexedPool.tokenAddress;

  const tokenDelta = token0IsLaunch ? amount0 : amount1;
  const nativeDelta = token0IsLaunch ? amount1 : amount0;
  if (tokenDelta < 0n && nativeDelta > 0n) {
    return { side: "buy", sender, recipient, tokenAmountRaw: abs(tokenDelta), nativeAmountRaw: nativeDelta };
  }
  if (tokenDelta > 0n && nativeDelta < 0n) {
    return { side: "sell", sender, recipient, tokenAmountRaw: tokenDelta, nativeAmountRaw: abs(nativeDelta) };
  }
  return null;
}

async function tokenDecimals(provider: ethers.Provider, tokenAddress: string): Promise<number> {
  try {
    const token = new ethers.Contract(tokenAddress, ["function decimals() view returns (uint8)"], provider) as any;
    const value = Number(await token.decimals());
    return Number.isInteger(value) && value >= 0 && value <= 36 ? value : 18;
  } catch {
    return 18;
  }
}

async function upsertCandle(input: {
  indexedPool: IndexedPool;
  blockTime: Date;
  blockNumber: number;
  logIndex: number;
  priceNative: string;
  nativeAmountRaw: bigint;
}): Promise<void> {
  const volumeNative = ethers.formatUnits(input.nativeAmountRaw, 18);
  for (const resolution of Object.keys(RESOLUTION_MS) as CandleResolution[]) {
    await pool.query(
      `insert into public.token_candles(
         chain_id,campaign_address,timeframe,bucket_start,o,h,l,c,volume_bnb,trades_count,
         source_mask,bonding_trade_count,dex_trade_count,bonding_volume_bnb,dex_volume_bnb,
         last_block_number,last_log_index,updated_at
       ) values($1,$2,$3,$4,$5,$5,$5,$5,$6,1,2,0,1,0,$6,$7,$8,now())
       on conflict(chain_id,campaign_address,timeframe,bucket_start) do update set
         h=greatest(public.token_candles.h,excluded.h),
         l=least(public.token_candles.l,excluded.l),
         c=case
           when coalesce(public.token_candles.last_block_number,-1) < excluded.last_block_number then excluded.c
           when public.token_candles.last_block_number = excluded.last_block_number and coalesce(public.token_candles.last_log_index,-1) <= excluded.last_log_index then excluded.c
           else public.token_candles.c
         end,
         volume_bnb=public.token_candles.volume_bnb+excluded.volume_bnb,
         trades_count=public.token_candles.trades_count+1,
         source_mask=(public.token_candles.source_mask::int | 2)::smallint,
         dex_trade_count=public.token_candles.dex_trade_count+1,
         dex_volume_bnb=public.token_candles.dex_volume_bnb+excluded.dex_volume_bnb,
         last_block_number=greatest(coalesce(public.token_candles.last_block_number,-1),excluded.last_block_number),
         last_log_index=case
           when coalesce(public.token_candles.last_block_number,-1) < excluded.last_block_number then excluded.last_log_index
           when public.token_candles.last_block_number = excluded.last_block_number then greatest(coalesce(public.token_candles.last_log_index,-1),excluded.last_log_index)
           else public.token_candles.last_log_index
         end,
         updated_at=now()`,
      [
        input.indexedPool.chainId,
        input.indexedPool.campaignAddress,
        resolution,
        bucketStart(input.blockTime, resolution),
        input.priceNative,
        volumeNative,
        input.blockNumber,
        input.logIndex,
      ],
    );
  }
}

async function publishMarketEvent(indexedPool: IndexedPool, name: string, data: Record<string, unknown>): Promise<void> {
  try {
    const channel = ablyRest.channels.get(tokenChannel(indexedPool.chainId, indexedPool.campaignAddress));
    await channel.publish(name, {
      chainId: indexedPool.chainId,
      campaignAddress: indexedPool.campaignAddress,
      pairAddress: indexedPool.pairAddress,
      ...data,
    });
  } catch (error: any) {
    console.warn("[robinhood-v3] realtime publish failed", name, error?.message || String(error));
  }
}

async function insertSwap(
  provider: ethers.JsonRpcProvider,
  indexedPool: IndexedPool,
  log: ethers.Log,
  parsed: ethers.LogDescription,
  normalized: NormalizedSwap,
): Promise<boolean> {
  if (normalized.tokenAmountRaw <= 0n || normalized.nativeAmountRaw <= 0n) return false;
  const decimals = await tokenDecimals(provider, indexedPool.tokenAddress);
  const tokenAmount = ethers.formatUnits(normalized.tokenAmountRaw, decimals);
  const nativeAmount = ethers.formatUnits(normalized.nativeAmountRaw, 18);
  const tokenNumeric = Number(tokenAmount);
  const nativeNumeric = Number(nativeAmount);
  if (!(tokenNumeric > 0) || !(nativeNumeric > 0)) return false;
  const priceNative = (nativeNumeric / tokenNumeric).toString();
  const block = await provider.getBlock(log.blockNumber);
  if (!block?.hash) return false;
  const tx = await provider.getTransaction(log.transactionHash).catch(() => null);
  const transactionFrom = tx?.from ? lowerAddress(tx.from) : null;
  const txHash = log.transactionHash.toLowerCase();
  const logIndex = Number(log.index);
  const blockTime = new Date(Number(block.timestamp) * 1000);

  const intent = await pool.query(
    `select intent_id from public.trade_intents
      where chain_id=$1 and lower(transaction_hash)=lower($2)
      order by created_at desc limit 1`,
    [indexedPool.chainId, txHash],
  );
  const tradeIntentId = intent.rows[0]?.intent_id ?? null;
  const origin = tradeIntentId ? "memewarzone" : "robinhood_v3";

  const inserted = await pool.query(
    `insert into public.dex_trades(
       chain_id,campaign_address,token_address,pair_address,tx_hash,log_index,
       block_number,block_hash,block_time,status,side,sender_address,recipient_address,
       transaction_from,token_amount_raw,native_amount_raw,token_amount,native_amount,
       price_bnb,execution_source,origin,trade_intent_id,created_at,updated_at
     ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed',$10,$11,$12,$13,$14,$15,$16,$17,$18,'robinhood_v3',$19,$20,now(),now())
     on conflict(chain_id,tx_hash,log_index) do nothing
     returning tx_hash`,
    [
      indexedPool.chainId,
      indexedPool.campaignAddress,
      indexedPool.tokenAddress,
      indexedPool.pairAddress,
      txHash,
      logIndex,
      log.blockNumber,
      block.hash,
      blockTime,
      normalized.side,
      normalized.sender,
      normalized.recipient,
      transactionFrom,
      normalized.tokenAmountRaw.toString(),
      normalized.nativeAmountRaw.toString(),
      tokenAmount,
      nativeAmount,
      priceNative,
      origin,
      tradeIntentId,
    ],
  );
  if (!inserted.rowCount) return false;

  await upsertCandle({ indexedPool, blockTime, blockNumber: log.blockNumber, logIndex, priceNative, nativeAmountRaw: normalized.nativeAmountRaw });

  await pool.query(
    `insert into public.market_stats(
       chain_id,campaign_address,market_stage,last_price_bnb,dex_volume_24h_bnb,
       volume_24h_bnb,trades_24h,buys_24h,sells_24h,last_trade_block,last_trade_at,updated_at
     ) values($1,$2,'DEX_ACTIVE',$3,$4,$4,1,$5,$6,$7,$8,now())
     on conflict(chain_id,campaign_address) do update set
       market_stage='DEX_ACTIVE',
       last_price_bnb=excluded.last_price_bnb,
       dex_volume_24h_bnb=(select coalesce(sum(native_amount),0) from public.dex_trades where chain_id=$1 and campaign_address=$2 and status='confirmed' and block_time>=now()-interval '24 hours'),
       volume_24h_bnb=(select coalesce(sum("nativeAmountRaw"::numeric/1e18),0) from public.market_trades_v where "chainId"=$1 and "campaignAddress"=$2 and "blockTime">=now()-interval '24 hours'),
       trades_24h=(select count(*)::int from public.market_trades_v where "chainId"=$1 and "campaignAddress"=$2 and "blockTime">=now()-interval '24 hours'),
       buys_24h=(select count(*)::int from public.market_trades_v where "chainId"=$1 and "campaignAddress"=$2 and "side"='buy' and "blockTime">=now()-interval '24 hours'),
       sells_24h=(select count(*)::int from public.market_trades_v where "chainId"=$1 and "campaignAddress"=$2 and "side"='sell' and "blockTime">=now()-interval '24 hours'),
       last_trade_block=excluded.last_trade_block,
       last_trade_at=excluded.last_trade_at,
       updated_at=now()`,
    [
      indexedPool.chainId,
      indexedPool.campaignAddress,
      priceNative,
      nativeAmount,
      normalized.side === "buy" ? 1 : 0,
      normalized.side === "sell" ? 1 : 0,
      log.blockNumber,
      blockTime,
    ],
  );

  await publishMarketEvent(indexedPool, "market_trade", {
    eventId: `${indexedPool.chainId}:${txHash}:${logIndex}`,
    source: "robinhood_v3",
    origin,
    side: normalized.side,
    wallet: transactionFrom || normalized.sender,
    recipient: normalized.recipient,
    tokenAmountRaw: normalized.tokenAmountRaw.toString(),
    nativeAmountRaw: normalized.nativeAmountRaw.toString(),
    priceBnb: priceNative,
    txHash,
    logIndex,
    blockNumber: log.blockNumber,
    blockTime: blockTime.toISOString(),
    status: "confirmed",
  });

  return true;
}

async function scanPool(provider: ethers.JsonRpcProvider, indexedPool: IndexedPool, head: number): Promise<number> {
  const from = Math.max(indexedPool.graduationBlock, indexedPool.lastIndexedBlock ?? indexedPool.graduationBlock);
  if (from > head) return 0;
  let inserted = 0;
  const chunk = Math.max(50, Number(ENV.LOG_CHUNK_SIZE || 500));
  let cursor = from;
  let lastSwapAt: Date | null = null;

  while (cursor <= head) {
    const to = Math.min(head, cursor + chunk - 1);
    const logs = await provider.getLogs({
      address: indexedPool.pairAddress,
      topics: [[MOCK_SWAP_TOPIC, CANONICAL_SWAP_TOPIC]],
      fromBlock: cursor,
      toBlock: to,
    });
    for (const log of logs) {
      const topic = String(log.topics[0] || "").toLowerCase();
      let parsed: ethers.LogDescription | null = null;
      let normalized: NormalizedSwap | null = null;
      if (topic === MOCK_SWAP_TOPIC.toLowerCase()) {
        parsed = mockIface.parseLog(log);
        if (parsed) normalized = normalizeMockSwap(indexedPool, parsed);
      } else if (topic === CANONICAL_SWAP_TOPIC.toLowerCase()) {
        parsed = canonicalIface.parseLog(log);
        if (parsed) normalized = normalizeCanonicalSwap(indexedPool, parsed);
      }
      if (!parsed || !normalized) continue;
      if (await insertSwap(provider, indexedPool, log, parsed, normalized)) {
        inserted += 1;
        const block = await provider.getBlock(log.blockNumber);
        if (block) lastSwapAt = new Date(Number(block.timestamp) * 1000);
      }
    }
    await pool.query(
      `update public.dex_pools
          set last_indexed_block=$3,last_finalized_block=$3,last_swap_at=coalesce($4,last_swap_at),updated_at=now()
        where chain_id=$1 and pair_address=$2`,
      [indexedPool.chainId, indexedPool.pairAddress, to + 1, lastSwapAt],
    );
    cursor = to + 1;
    if (ENV.INDEXER_LOG_CALL_DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, ENV.INDEXER_LOG_CALL_DELAY_MS));
  }

  return inserted;
}

async function runChain(config: ChainConfig): Promise<void> {
  const provider = await createWorkingProvider(config.rpcUrls, config.chainId, {
    timeoutMs: ENV.RPC_REQUEST_TIMEOUT_MS,
    label: `robinhood-v3-${config.chainId}`,
  });
  try {
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== config.chainId) throw new Error(`RPC returned chain ${network.chainId}`);
    await discoverPools(provider, config);
    const head = Math.max(0, (await provider.getBlockNumber()) - Math.max(0, ENV.CONFIRMATIONS));
    const pools = await listPools(config.chainId);
    let swaps = 0;
    for (const indexedPool of pools) swaps += await scanPool(provider, indexedPool, head);
    if (pools.length || swaps) console.log("[robinhood-v3] pass", { chainId: config.chainId, head, pools: pools.length, swaps });
  } finally {
    provider.destroy();
  }
}

async function loop(): Promise<void> {
  const intervalMs = Math.max(2_000, Number(process.env.ROBINHOOD_V3_POOL_INDEXER_INTERVAL_MS || 5_000));
  while (true) {
    const configs = chainConfigs();
    for (const config of configs) {
      try {
        await runChain(config);
      } catch (error: any) {
        console.error("[robinhood-v3] pass failed", {
          chainId: config.chainId,
          rpcs: config.rpcUrls.map(maskRpcUrl),
          error: error?.shortMessage || error?.message || String(error),
        });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function startRobinhoodV3PoolIndexerLoop(): void {
  if (!enabled()) return;
  if (globalState[LOOP_SYMBOL]) return;
  globalState[LOOP_SYMBOL] = true;
  console.log("[robinhood-v3] indexer enabled", { chains: chainConfigs().map((config) => config.chainId) });
  void loop();
}

export const robinhoodV3Internals = {
  normalizeMockSwap,
  normalizeCanonicalSwap,
  MOCK_SWAP_TOPIC,
  CANONICAL_SWAP_TOPIC,
};
