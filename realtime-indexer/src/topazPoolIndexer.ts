import { ethers } from "ethers";
import { ablyRest, tokenChannel } from "./ably.js";
import { TOPAZ_POOL_ABI } from "./abis.js";
import { pool } from "./db.js";
import { ENV } from "./env.js";
import { createWorkingProvider, maskRpcUrl, parseRpcList } from "./rpcProvider.js";
import { isNativePairedPool, normalizeTopazSwap, pairedTokenOf, priceBnbFromRaw } from "./topazPoolCore.js";
import {
  quoteRawToNativeRawViaReserves,
  rawToDecimal,
} from "./evmQuoteNativeValuation.js";

type ChainConfig = {
  chainId: number;
  rpcUrls: string[];
};

type IndexedPool = {
  chainId: number;
  pairAddress: string;
  campaignAddress: string;
  tokenAddress: string;
  wrappedNativeAddress: string;
  token0Address: string;
  token1Address: string;
  factoryAddress: string;
  graduationBlock: number;
  lastIndexedBlock: number | null;
};

/**
 * The non-MEME leg of a pool that is not paired with the wrapped native (a quote-bound coin's
 * MEME/QUOTE pool, e.g. MEME/USDT). Its amounts are converted to native through the canonical
 * quote/WBNB Topaz pool, the one the quote graduation adapter acquires through.
 */
type QuoteLeg = {
  tokenAddress: string;
  decimals: number;
  /** quote/WBNB reserves at a block (falls back to the latest reserves when the RPC has no archive). */
  reservesAt: (blockNumber: number | null) => Promise<{ reserveQuoteRaw: bigint; reserveNativeRaw: bigint }>;
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

const LOOP_SYMBOL = Symbol.for("memewarzone.wtrTopazPoolIndexerStarted");
const globalState = globalThis as any;
const ERC20_METADATA_ABI = ["function decimals() view returns (uint8)"];
const TOPAZ_FACTORY_GET_POOL_ABI = ["function getPool(address tokenA,address tokenB,bool stable) view returns (address)"];
const ZERO_ADDRESS = ethers.ZeroAddress.toLowerCase();

const quoteDecimalsCache = new Map<string, number>();
const quoteNativePoolCache = new Map<string, string>();

async function buildQuoteLeg(provider: ethers.JsonRpcProvider, indexedPool: IndexedPool): Promise<QuoteLeg> {
  const quoteToken = pairedTokenOf(indexedPool);
  const decimalsKey = `${indexedPool.chainId}:${quoteToken}`;
  let decimals = quoteDecimalsCache.get(decimalsKey);
  if (decimals == null) {
    const value = Number(await (new ethers.Contract(quoteToken, ERC20_METADATA_ABI, provider) as any).decimals());
    if (!Number.isInteger(value) || value < 0 || value > 36) throw new Error(`Quote token ${quoteToken} decimals invalid: ${value}; quote/native rate unavailable`);
    decimals = value;
    quoteDecimalsCache.set(decimalsKey, decimals);
  }

  if (!ethers.isAddress(indexedPool.factoryAddress) || indexedPool.factoryAddress === ZERO_ADDRESS) {
    throw new Error("Topaz factory unknown; quote/native rate unavailable");
  }
  const poolKey = `${indexedPool.chainId}:${indexedPool.factoryAddress}:${quoteToken}:${indexedPool.wrappedNativeAddress}`;
  let ratePool = quoteNativePoolCache.get(poolKey);
  if (!ratePool) {
    const factory = new ethers.Contract(indexedPool.factoryAddress, TOPAZ_FACTORY_GET_POOL_ABI, provider) as any;
    const found = String(await factory.getPool(quoteToken, indexedPool.wrappedNativeAddress, false)).toLowerCase();
    if (!ethers.isAddress(found) || found === ZERO_ADDRESS) {
      throw new Error(`No Topaz volatile ${quoteToken}/WBNB pool; quote/native rate unavailable`);
    }
    ratePool = found;
    quoteNativePoolCache.set(poolKey, ratePool);
  }

  const pair = new ethers.Contract(ratePool, TOPAZ_POOL_ABI, provider) as any;
  const token0 = String(await pair.token0()).toLowerCase();
  const quoteIs0 = token0 === quoteToken;
  const cache = new Map<string, { reserveQuoteRaw: bigint; reserveNativeRaw: bigint }>();
  const split = (reserves: any) => {
    const r0 = BigInt(reserves[0]);
    const r1 = BigInt(reserves[1]);
    const result = { reserveQuoteRaw: quoteIs0 ? r0 : r1, reserveNativeRaw: quoteIs0 ? r1 : r0 };
    if (result.reserveQuoteRaw <= 0n || result.reserveNativeRaw <= 0n) {
      throw new Error(`Topaz ${quoteToken}/WBNB pool has no reserves; quote/native rate unavailable`);
    }
    return result;
  };
  return {
    tokenAddress: quoteToken,
    decimals,
    reservesAt: async (blockNumber) => {
      const key = blockNumber == null ? "latest" : String(blockNumber);
      const cached = cache.get(key);
      if (cached) return cached;
      let value: { reserveQuoteRaw: bigint; reserveNativeRaw: bigint } | null = null;
      if (blockNumber != null) {
        try {
          value = split(await pair.getReserves({ blockTag: blockNumber }));
        } catch {
          value = null; // no archive state on this RPC: the latest reserves are the best known rate
        }
      }
      if (!value) {
        const latest = cache.get("latest") ?? split(await pair.getReserves());
        cache.set("latest", latest);
        value = latest;
      }
      cache.set(key, value);
      return value;
    },
  };
}

function chainConfigs(): ChainConfig[] {
  const result: ChainConfig[] = [];
  const testnet = parseRpcList(ENV.BSC_RPC_HTTP_97);
  const mainnet = parseRpcList(ENV.BSC_RPC_HTTP_56);
  if (testnet.length) result.push({ chainId: 97, rpcUrls: testnet });
  if (mainnet.length) result.push({ chainId: 56, rpcUrls: mainnet });
  return result;
}

function bucketStart(blockTime: Date, resolution: CandleResolution): Date {
  const duration = RESOLUTION_MS[resolution];
  return new Date(Math.floor(blockTime.getTime() / duration) * duration);
}

async function listPools(chainId: number): Promise<IndexedPool[]> {
  const maxPools = Math.max(1, Number(process.env.TOPAZ_POOL_INDEXER_MAX_POOLS || 100));
  const result = await pool.query(
    `select
       dp.chain_id,
       dp.pair_address,
       dp.campaign_address,
       dp.token_address,
       dp.wrapped_native_address,
       dp.token0_address,
       dp.token1_address,
       dp.factory_address,
       dp.graduation_block,
       dp.last_indexed_block
     from public.dex_pools dp
     join public.campaign_market_state cms
       on cms.chain_id=dp.chain_id and cms.campaign_address=dp.campaign_address
     where dp.chain_id=$1
       and dp.support_enabled=true
       and dp.indexing_enabled=true
       and dp.stable=false
       and cms.pool_verified=true
       -- Include DEGRADED so recovery after RPC timeouts can resume indexing.
       and cms.market_stage in ('TOPAZ_ACTIVE','TOPAZ_DEGRADED','TOPAZ_PENDING')
     order by coalesce(dp.last_indexed_block,dp.graduation_block) asc
     limit $2`,
    [chainId, maxPools],
  );

  return result.rows.map((row: any) => ({
    chainId: Number(row.chain_id),
    pairAddress: String(row.pair_address).toLowerCase(),
    campaignAddress: String(row.campaign_address).toLowerCase(),
    tokenAddress: String(row.token_address).toLowerCase(),
    wrappedNativeAddress: String(row.wrapped_native_address).toLowerCase(),
    token0Address: String(row.token0_address).toLowerCase(),
    token1Address: String(row.token1_address).toLowerCase(),
    factoryAddress: String(row.factory_address || "").toLowerCase(),
    graduationBlock: Number(row.graduation_block),
    lastIndexedBlock: row.last_indexed_block == null ? null : Number(row.last_indexed_block),
  }));
}

async function getLogsAdaptive(
  provider: ethers.JsonRpcProvider,
  pairAddress: string,
  topics: string[],
  fromBlock: number,
  toBlock: number,
): Promise<ethers.Log[]> {
  if (fromBlock > toBlock) return [];
  const span = toBlock - fromBlock + 1;
  try {
    return await provider.getLogs({
      address: pairAddress,
      // Nested array = OR on topic0 (Swap or Sync).
      topics: [topics],
      fromBlock,
      toBlock,
    });
  } catch (error) {
    if (span <= Math.max(1, ENV.MIN_LOG_CHUNK_SIZE)) throw error;
    const mid = Math.floor((fromBlock + toBlock) / 2);
    const left = await getLogsAdaptive(provider, pairAddress, topics, fromBlock, mid);
    const right = await getLogsAdaptive(provider, pairAddress, topics, mid + 1, toBlock);
    return left.concat(right);
  }
}

/** Always walk the range in fixed chunks — free RPCs timeout on 20k–200k block eth_getLogs. */
async function getLogsChunked(
  provider: ethers.JsonRpcProvider,
  pairAddress: string,
  topics: string[],
  fromBlock: number,
  toBlock: number,
): Promise<{ logs: ethers.Log[]; scannedTo: number }> {
  if (fromBlock > toBlock) return { logs: [], scannedTo: toBlock };
  const chunk = Math.max(50, Number(ENV.LOG_CHUNK_SIZE || 500));
  const all: ethers.Log[] = [];
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const end = Math.min(toBlock, cursor + chunk - 1);
    const part = await getLogsAdaptive(provider, pairAddress, topics, cursor, end);
    all.push(...part);
    cursor = end + 1;
    if (ENV.INDEXER_LOG_CALL_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, ENV.INDEXER_LOG_CALL_DELAY_MS));
    }
  }
  return { logs: all, scannedTo: toBlock };
}

function isTransientRpcError(error: unknown): boolean {
  const msg = String((error as any)?.shortMessage || (error as any)?.message || error || "").toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("limit exceeded") ||
    // A quote pool whose native valuation cannot be read yet: retry next pass, never degrade trading.
    msg.includes("quote/native rate unavailable")
  );
}

async function upsertDexCandle(input: {
  indexedPool: IndexedPool;
  blockTime: Date;
  blockNumber: number;
  logIndex: number;
  priceBnb: string;
  nativeAmountRaw: bigint;
}) {
  const volumeBnb = ethers.formatUnits(input.nativeAmountRaw, 18);
  const resolutions = Object.keys(RESOLUTION_MS) as CandleResolution[];

  for (const resolution of resolutions) {
    await pool.query(
      `insert into public.token_candles(
         chain_id,campaign_address,timeframe,bucket_start,
         o,h,l,c,volume_bnb,trades_count,
         source_mask,bonding_trade_count,dex_trade_count,
         bonding_volume_bnb,dex_volume_bnb,last_block_number,last_log_index,updated_at
       ) values(
         $1,$2,$3,$4,$5,$5,$5,$5,$6,1,
         2,0,1,0,$6,$7,$8,now()
       )
       on conflict(chain_id,campaign_address,timeframe,bucket_start) do update set
         h=greatest(public.token_candles.h,excluded.h),
         l=least(public.token_candles.l,excluded.l),
         c=case
           when coalesce(public.token_candles.last_block_number,-1) < excluded.last_block_number then excluded.c
           when public.token_candles.last_block_number = excluded.last_block_number
            and coalesce(public.token_candles.last_log_index,-1) <= excluded.last_log_index then excluded.c
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
        input.priceBnb,
        volumeBnb,
        input.blockNumber,
        input.logIndex,
      ],
    );
  }
}

async function publishMarketEvent(
  indexedPool: IndexedPool,
  name: string,
  data: Record<string, unknown>,
) {
  try {
    const channel = ablyRest.channels.get(tokenChannel(indexedPool.chainId, indexedPool.campaignAddress));
    await channel.publish(name, {
      chainId: indexedPool.chainId,
      campaignAddress: indexedPool.campaignAddress,
      pairAddress: indexedPool.pairAddress,
      ...data,
    });
  } catch (error: any) {
    console.warn("[wtr] realtime publish failed", name, error?.message || String(error));
  }
}

async function insertSwap(input: {
  indexedPool: IndexedPool;
  log: ethers.Log;
  parsed: ethers.LogDescription;
  block: ethers.Block;
  transactionFrom: string | null;
  tokenDecimals: number;
  /** Set for a MEME/QUOTE pool; null for a MEME/WBNB pool (unchanged native path). */
  quote: QuoteLeg | null;
}): Promise<boolean> {
  const token0IsLaunchToken = input.indexedPool.token0Address === input.indexedPool.tokenAddress;
  const normalized = normalizeTopazSwap(token0IsLaunchToken, {
    amount0In: BigInt(input.parsed.args.amount0In ?? input.parsed.args[1]),
    amount1In: BigInt(input.parsed.args.amount1In ?? input.parsed.args[2]),
    amount0Out: BigInt(input.parsed.args.amount0Out ?? input.parsed.args[3]),
    amount1Out: BigInt(input.parsed.args.amount1Out ?? input.parsed.args[4]),
  });
  if (!normalized) return false;

  // normalizeTopazSwap names the paired leg "native". For a MEME/QUOTE pool it is the quote amount:
  // keep it as the quote leg and value it in native at the quote/WBNB rate of the trade's block.
  const pairedAmountRaw = normalized.nativeAmountRaw;
  let nativeAmountRaw = pairedAmountRaw;
  let priceQuote: string | null = null;
  if (input.quote) {
    const reserves = await input.quote.reservesAt(input.log.blockNumber);
    const converted = quoteRawToNativeRawViaReserves({ quoteAmountRaw: pairedAmountRaw, ...reserves });
    if (converted == null) return false; // dust below one wei of native
    nativeAmountRaw = converted;
    priceQuote = priceBnbFromRaw(normalized.tokenAmountRaw, pairedAmountRaw, input.tokenDecimals, input.quote.decimals);
  }

  const priceBnb = priceBnbFromRaw(
    normalized.tokenAmountRaw,
    nativeAmountRaw,
    input.tokenDecimals,
    18,
  );
  if (!priceBnb) return false;

  const txHash = input.log.transactionHash.toLowerCase();
  const intent = await pool.query(
    `select intent_id
       from public.trade_intents
      where chain_id=$1 and lower(transaction_hash)=lower($2)
      order by created_at desc
      limit 1`,
    [input.indexedPool.chainId, txHash],
  );
  const tradeIntentId = intent.rows[0]?.intent_id ?? null;
  const sender = String(input.parsed.args.sender ?? input.parsed.args[0] ?? "").toLowerCase() || null;
  const recipient = String(input.parsed.args.to ?? input.parsed.args[5] ?? "").toLowerCase() || null;
  const logIndex = Number(input.log.index);
  const blockTime = new Date(Number(input.block.timestamp) * 1000);

  const inserted = input.quote
    ? await pool.query(
        `insert into public.dex_trades(
           chain_id,campaign_address,token_address,pair_address,
           tx_hash,log_index,block_number,block_hash,block_time,status,side,
           sender_address,recipient_address,transaction_from,
           token_amount_raw,native_amount_raw,token_amount,native_amount,price_bnb,
           base_amount_raw,base_amount,quote_token_address,quote_amount_raw,quote_amount,price_quote,
           execution_source,origin,trade_intent_id,created_at,updated_at
         ) values(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed',$10,
           $11,$12,$13,$14,$15,
           ($14::numeric / power(10::numeric,$16)),($15::numeric / 1e18),$17,
           $14,($14::numeric / power(10::numeric,$16)),$20,$21,$22,$23,
           'topaz_v2',$18,$19,now(),now()
         )
         on conflict(chain_id,tx_hash,log_index) do nothing
         returning tx_hash`,
        [
          input.indexedPool.chainId,
          input.indexedPool.campaignAddress,
          input.indexedPool.tokenAddress,
          input.indexedPool.pairAddress,
          txHash,
          logIndex,
          input.log.blockNumber,
          input.block.hash,
          blockTime,
          normalized.side,
          sender,
          recipient,
          input.transactionFrom,
          normalized.tokenAmountRaw.toString(),
          nativeAmountRaw.toString(),
          input.tokenDecimals,
          priceBnb,
          tradeIntentId ? "memewarzone" : "topaz",
          tradeIntentId,
          input.quote.tokenAddress,
          pairedAmountRaw.toString(),
          rawToDecimal(pairedAmountRaw, input.quote.decimals),
          priceQuote,
        ],
      )
    : await pool.query(
    `insert into public.dex_trades(
       chain_id,campaign_address,token_address,pair_address,
       tx_hash,log_index,block_number,block_hash,block_time,status,side,
       sender_address,recipient_address,transaction_from,
       token_amount_raw,native_amount_raw,token_amount,native_amount,price_bnb,
       execution_source,origin,trade_intent_id,created_at,updated_at
     ) values(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed',$10,
       $11,$12,$13,$14,$15,
       ($14::numeric / power(10::numeric,$16)),($15::numeric / 1e18),$17,
       'topaz_v2',$18,$19,now(),now()
     )
     on conflict(chain_id,tx_hash,log_index) do nothing
     returning tx_hash`,
    [
      input.indexedPool.chainId,
      input.indexedPool.campaignAddress,
      input.indexedPool.tokenAddress,
      input.indexedPool.pairAddress,
      txHash,
      logIndex,
      input.log.blockNumber,
      input.block.hash,
      blockTime,
      normalized.side,
      sender,
      recipient,
      input.transactionFrom,
      normalized.tokenAmountRaw.toString(),
      normalized.nativeAmountRaw.toString(),
      input.tokenDecimals,
      priceBnb,
      tradeIntentId ? "memewarzone" : "topaz",
      tradeIntentId,
    ],
  );

  if (!inserted.rowCount) return false;

  await upsertDexCandle({
    indexedPool: input.indexedPool,
    blockTime,
    blockNumber: input.log.blockNumber,
    logIndex,
    priceBnb,
    nativeAmountRaw,
  });

  await publishMarketEvent(input.indexedPool, "market_trade", {
    eventId: `${input.indexedPool.chainId}:${txHash}:${logIndex}`,
    source: "topaz",
    origin: tradeIntentId ? "memewarzone" : "topaz",
    side: normalized.side,
    wallet: input.transactionFrom,
    recipient,
    tokenAmountRaw: normalized.tokenAmountRaw.toString(),
    nativeAmountRaw: nativeAmountRaw.toString(),
    priceBnb,
    ...(input.quote
      ? { quoteTokenAddress: input.quote.tokenAddress, quoteAmountRaw: pairedAmountRaw.toString(), priceQuote }
      : {}),
    txHash,
    logIndex,
    blockNumber: input.log.blockNumber,
    blockTime: blockTime.toISOString(),
    status: "confirmed",
  });

  for (const resolution of Object.keys(RESOLUTION_MS) as CandleResolution[]) {
    await publishMarketEvent(input.indexedPool, "market_candle_upsert", {
      eventId: `${input.indexedPool.chainId}:${input.indexedPool.campaignAddress}:${resolution}:${bucketStart(blockTime, resolution).toISOString()}:${input.log.blockNumber}:${logIndex}`,
      resolution,
      bucketStart: bucketStart(blockTime, resolution).toISOString(),
      priceBnb,
      nativeVolumeRaw: nativeAmountRaw.toString(),
      blockNumber: input.log.blockNumber,
      logIndex,
      sourceMask: 2,
    });
  }

  return true;
}

async function refreshMarketStats(
  indexedPool: IndexedPool,
  reserveTokenRaw: bigint,
  reserveNativeRaw: bigint,
) {
  const aggregates = await pool.query(
    `select
       coalesce(sum(case when "blockTime">=now()-interval '5 minutes' then ("nativeAmountRaw"::numeric/1e18) else 0 end),0) as volume_5m_bnb,
       coalesce(sum(case when "blockTime">=now()-interval '1 hour' then ("nativeAmountRaw"::numeric/1e18) else 0 end),0) as volume_1h_bnb,
       coalesce(sum(case when "blockTime">=now()-interval '4 hours' then ("nativeAmountRaw"::numeric/1e18) else 0 end),0) as volume_4h_bnb,
       coalesce(sum(case when "blockTime">=now()-interval '24 hours' then ("nativeAmountRaw"::numeric/1e18) else 0 end),0) as volume_24h_bnb,
       coalesce(sum(case when source='bonding' and "blockTime">=now()-interval '24 hours' then ("nativeAmountRaw"::numeric/1e18) else 0 end),0) as bonding_volume_24h_bnb,
       coalesce(sum(case when source='topaz' and "blockTime">=now()-interval '24 hours' then ("nativeAmountRaw"::numeric/1e18) else 0 end),0) as dex_volume_24h_bnb,
       coalesce(sum(case when side='buy' and "blockTime">=now()-interval '24 hours' then ("nativeAmountRaw"::numeric/1e18) else 0 end),0) as buy_volume_24h_bnb,
       coalesce(sum(case when side='sell' and "blockTime">=now()-interval '24 hours' then ("nativeAmountRaw"::numeric/1e18) else 0 end),0) as sell_volume_24h_bnb,
       count(*) filter(where "blockTime">=now()-interval '24 hours')::int as trades_24h,
       count(*) filter(where side='buy' and "blockTime">=now()-interval '24 hours')::int as buys_24h,
       count(*) filter(where side='sell' and "blockTime">=now()-interval '24 hours')::int as sells_24h
     from public.market_trades_v
     where "chainId"=$1 and "campaignAddress"=$2 and status='confirmed'`,
    [indexedPool.chainId, indexedPool.campaignAddress],
  );

  const latest = await pool.query(
    `select "priceBnb","blockNumber","blockTime"
       from public.market_trades_v
      where "chainId"=$1 and "campaignAddress"=$2 and status='confirmed'
      order by "blockNumber" desc,"logIndex" desc
      limit 1`,
    [indexedPool.chainId, indexedPool.campaignAddress],
  );
  const marketState = await pool.query(
    `select post_burn_total_supply_raw
       from public.campaign_market_state
      where chain_id=$1 and campaign_address=$2
      limit 1`,
    [indexedPool.chainId, indexedPool.campaignAddress],
  );

  const aggregate = aggregates.rows[0] || {};
  const latestTrade = latest.rows[0] || {};
  const lastPrice = latestTrade.priceBnb ?? null;
  const supplyRaw = marketState.rows[0]?.post_burn_total_supply_raw ?? null;
  const liquidityBnb = Number(ethers.formatUnits(reserveNativeRaw, 18)) * 2;

  await pool.query(
    `insert into public.market_stats(
       chain_id,campaign_address,market_stage,last_price_bnb,market_cap_bnb,
       liquidity_bnb,bonding_reserve_bnb,
       volume_5m_bnb,volume_1h_bnb,volume_4h_bnb,volume_24h_bnb,
       buy_volume_24h_bnb,sell_volume_24h_bnb,bonding_volume_24h_bnb,dex_volume_24h_bnb,
       trades_24h,buys_24h,sells_24h,post_burn_total_supply_raw,supply_basis,
       last_trade_block,last_trade_at,data_lag_seconds,updated_at
     ) values(
       $1,$2,'TOPAZ_ACTIVE',$3,
       case when $3::numeric is null or $4::numeric is null then null else $3::numeric*($4::numeric/1e18) end,
       $5,(select reserve_bnb from public.token_stats where chain_id=$1 and campaign_address=$2),
       $6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$4,'post_burn_total_supply',
       $17,$18,0,now()
     )
     on conflict(chain_id,campaign_address) do update set
       market_stage='TOPAZ_ACTIVE',
       last_price_bnb=excluded.last_price_bnb,
       market_cap_bnb=excluded.market_cap_bnb,
       liquidity_bnb=excluded.liquidity_bnb,
       bonding_reserve_bnb=excluded.bonding_reserve_bnb,
       volume_5m_bnb=excluded.volume_5m_bnb,
       volume_1h_bnb=excluded.volume_1h_bnb,
       volume_4h_bnb=excluded.volume_4h_bnb,
       volume_24h_bnb=excluded.volume_24h_bnb,
       buy_volume_24h_bnb=excluded.buy_volume_24h_bnb,
       sell_volume_24h_bnb=excluded.sell_volume_24h_bnb,
       bonding_volume_24h_bnb=excluded.bonding_volume_24h_bnb,
       dex_volume_24h_bnb=excluded.dex_volume_24h_bnb,
       trades_24h=excluded.trades_24h,
       buys_24h=excluded.buys_24h,
       sells_24h=excluded.sells_24h,
       post_burn_total_supply_raw=excluded.post_burn_total_supply_raw,
       supply_basis=excluded.supply_basis,
       last_trade_block=excluded.last_trade_block,
       last_trade_at=excluded.last_trade_at,
       data_lag_seconds=0,
       updated_at=now()`,
    [
      indexedPool.chainId,
      indexedPool.campaignAddress,
      lastPrice,
      supplyRaw,
      liquidityBnb,
      aggregate.volume_5m_bnb,
      aggregate.volume_1h_bnb,
      aggregate.volume_4h_bnb,
      aggregate.volume_24h_bnb,
      aggregate.buy_volume_24h_bnb,
      aggregate.sell_volume_24h_bnb,
      aggregate.bonding_volume_24h_bnb,
      aggregate.dex_volume_24h_bnb,
      aggregate.trades_24h,
      aggregate.buys_24h,
      aggregate.sells_24h,
      latestTrade.blockNumber ?? null,
      latestTrade.blockTime ?? null,
    ],
  );

  const summary = {
    marketStage: "TOPAZ_ACTIVE",
    lastPriceBnb: lastPrice,
    marketCapBnb: lastPrice && supplyRaw ? Number(lastPrice) * Number(ethers.formatUnits(supplyRaw, 18)) : null,
    liquidityBnb,
    volume5mBnb: aggregate.volume_5m_bnb,
    volume1hBnb: aggregate.volume_1h_bnb,
    volume4hBnb: aggregate.volume_4h_bnb,
    volume24hBnb: aggregate.volume_24h_bnb,
    bondingVolume24hBnb: aggregate.bonding_volume_24h_bnb,
    dexVolume24hBnb: aggregate.dex_volume_24h_bnb,
    trades24h: aggregate.trades_24h,
    buys24h: aggregate.buys_24h,
    sells24h: aggregate.sells_24h,
    lastTradeBlock: latestTrade.blockNumber ?? null,
    lastTradeAt: latestTrade.blockTime ?? null,
    dataLagSeconds: 0,
  };
  await publishMarketEvent(indexedPool, "market_stats_patch", summary);
  return summary;
}

/** Quote-side identity + last quote price for a MEME/QUOTE pool; native columns stay authoritative. */
async function refreshQuoteMarketStats(indexedPool: IndexedPool, quoteTokenAddress: string) {
  await pool.query(
    `update public.market_stats
        set quote_token_address=$3,
            last_price_quote=coalesce((
              select price_quote from public.dex_trades
               where chain_id=$1 and campaign_address=$2 and status='confirmed' and price_quote is not null
               order by block_number desc,log_index desc
               limit 1
            ),last_price_quote),
            dex_volume_24h_quote=(
              select coalesce(sum(quote_amount),0) from public.dex_trades
               where chain_id=$1 and campaign_address=$2 and status='confirmed'
                 and block_time>=now()-interval '24 hours'
            ),
            updated_at=now()
      where chain_id=$1 and campaign_address=$2`,
    [indexedPool.chainId, indexedPool.campaignAddress, quoteTokenAddress],
  );
}

async function scanPool(
  provider: ethers.JsonRpcProvider,
  indexedPool: IndexedPool,
  finalizedHead: number,
) {
  // Cap catch-up per tick so BlockPI free tiers don't timeout on huge first scans.
  // Keep passes small — BlockPI free tier times out and also starves the bonding tip scanner.
  const maxBlocksPerPass = Math.max(
    200,
    Number(process.env.TOPAZ_POOL_INDEXER_BLOCKS_PER_PASS || 1_500),
  );
  // If we never indexed, don't start from a bad/ancient graduation_block (e.g. 1).
  const maxLookback = Math.max(
    1_000,
    Number(process.env.TOPAZ_POOL_INDEXER_MAX_LOOKBACK_BLOCKS || 12_000),
  );
  const floorFromHead = Math.max(0, finalizedHead - maxLookback);
  const graduationFloor =
    Number.isFinite(indexedPool.graduationBlock) && indexedPool.graduationBlock > 1
      ? indexedPool.graduationBlock
      : floorFromHead;

  let startBlock: number;
  if (indexedPool.lastIndexedBlock == null) {
    startBlock = Math.max(graduationFloor, floorFromHead);
  } else {
    startBlock = Math.max(graduationFloor, indexedPool.lastIndexedBlock + 1);
  }
  const endBlock = Math.min(finalizedHead, startBlock + maxBlocksPerPass - 1);

  const pair = new ethers.Contract(indexedPool.pairAddress, TOPAZ_POOL_ABI, provider) as any;
  const token = new ethers.Contract(indexedPool.tokenAddress, ERC20_METADATA_ABI, provider) as any;
  const tokenDecimals = Number(await token.decimals());
  const iface = new ethers.Interface(TOPAZ_POOL_ABI);
  const swapEvent = iface.getEvent("Swap");
  const syncEvent = iface.getEvent("Sync");
  if (!swapEvent || !syncEvent) throw new Error("Topaz Swap/Sync ABI missing");

  let insertedTrades = 0;
  let lastSwapAt: Date | null = null;
  let lastSyncAt: Date | null = null;
  let scannedTo = Math.max(0, startBlock - 1);
  let scanError: string | null = null;

  // Always refresh reserves first so market-state stays useful even if logs time out.
  const reserves = await pair.getReserves();
  const reserve0 = BigInt(reserves[0]);
  const reserve1 = BigInt(reserves[1]);
  const token0IsLaunch = indexedPool.token0Address === indexedPool.tokenAddress;
  const reserveTokenRaw = token0IsLaunch ? reserve0 : reserve1;
  const reservePairedRaw = token0IsLaunch ? reserve1 : reserve0;

  // A quote-bound coin's pool pairs MEME with the quote, not WBNB. Value that leg in native so every
  // *_bnb reader (market_stats, candles, market_trades_v, the API's native x USD) stays in BNB.
  const quote = isNativePairedPool(indexedPool) ? null : await buildQuoteLeg(provider, indexedPool);
  let reserveNativeRaw = reservePairedRaw;
  if (quote) {
    const latest = await quote.reservesAt(null);
    reserveNativeRaw =
      quoteRawToNativeRawViaReserves({ quoteAmountRaw: reservePairedRaw, ...latest }) ?? 0n;
    await pool.query(
      `update public.dex_pools
          set last_sync_at=now(),
              reserve_token_raw=$3,
              reserve_native_raw=$4,
              base_token_address=coalesce(nullif(base_token_address,''),token_address),
              quote_token_address=$5,
              quote_decimals=$6,
              reserve_base_raw=$3,
              reserve_quote_raw=$7,
              updated_at=now()
        where chain_id=$1 and lower(pair_address)=lower($2)`,
      [
        indexedPool.chainId,
        indexedPool.pairAddress,
        reserveTokenRaw.toString(),
        reserveNativeRaw.toString(),
        quote.tokenAddress,
        quote.decimals,
        reservePairedRaw.toString(),
      ],
    );
  } else {
    await pool.query(
      `update public.dex_pools
          set last_sync_at=now(),
              reserve_token_raw=$3,
              reserve_native_raw=$4,
              updated_at=now()
        where chain_id=$1 and lower(pair_address)=lower($2)`,
      [indexedPool.chainId, indexedPool.pairAddress, reserveTokenRaw.toString(), reserveNativeRaw.toString()],
    );
  }

  if (startBlock <= endBlock) {
    const chunk = Math.max(50, Number(ENV.LOG_CHUNK_SIZE || 500));
    let cursor = startBlock;
    const blockCache = new Map<number, ethers.Block>();
    const txFromCache = new Map<string, string | null>();
    const topics = [swapEvent.topicHash, syncEvent.topicHash];

    while (cursor <= endBlock) {
      const chunkEnd = Math.min(endBlock, cursor + chunk - 1);
      try {
        const logs = await getLogsAdaptive(
          provider,
          indexedPool.pairAddress,
          topics,
          cursor,
          chunkEnd,
        );
        logs.sort((a, b) => a.blockNumber - b.blockNumber || Number(a.index) - Number(b.index));

        for (const log of logs) {
          const parsed = iface.parseLog(log);
          if (!parsed) continue;
          let block = blockCache.get(log.blockNumber);
          if (!block) {
            const fetched = await provider.getBlock(log.blockNumber);
            if (!fetched) throw new Error(`Missing block ${log.blockNumber}`);
            block = fetched;
            blockCache.set(log.blockNumber, block);
          }
          const eventTime = new Date(Number(block.timestamp) * 1000);

          if (parsed.name === "Sync") {
            lastSyncAt = eventTime;
            continue;
          }
          if (parsed.name !== "Swap") continue;

          const txHash = log.transactionHash.toLowerCase();
          let transactionFrom = txFromCache.get(txHash);
          if (transactionFrom === undefined) {
            const transaction = await provider.getTransaction(txHash);
            transactionFrom = transaction?.from?.toLowerCase() ?? null;
            txFromCache.set(txHash, transactionFrom);
          }

          if (
            await insertSwap({
              indexedPool,
              log,
              parsed,
              block,
              transactionFrom,
              tokenDecimals,
              quote,
            })
          ) {
            insertedTrades += 1;
          }
          lastSwapAt = eventTime;
        }

        scannedTo = chunkEnd;
        // Commit cursor after every successful chunk so a later timeout still keeps progress.
        await pool.query(
          `update public.dex_pools
              set last_indexed_block=$3,
                  last_finalized_block=$3,
                  last_swap_at=coalesce($4,last_swap_at),
                  last_sync_at=coalesce($5,now()),
                  updated_at=now()
            where chain_id=$1 and lower(pair_address)=lower($2)`,
          [indexedPool.chainId, indexedPool.pairAddress, scannedTo, lastSwapAt, lastSyncAt],
        );
      } catch (error: any) {
        scanError = error?.shortMessage || error?.message || String(error);
        console.warn("[wtr] Topaz pool chunk failed (keeping partial cursor)", {
          chainId: indexedPool.chainId,
          pair: indexedPool.pairAddress,
          from: cursor,
          to: chunkEnd,
          scannedTo,
          error: scanError,
        });
        // Stop this pass; next tick resumes from last committed cursor.
        break;
      }

      cursor = chunkEnd + 1;
      if (ENV.INDEXER_LOG_CALL_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, ENV.INDEXER_LOG_CALL_DELAY_MS));
      }
    }
  } else {
    // Already at/ past tip for this pass — still stamp a cursor so UI doesn't stay null forever.
    scannedTo = finalizedHead;
    await pool.query(
      `update public.dex_pools
          set last_indexed_block=greatest(coalesce(last_indexed_block,0), $3),
              last_finalized_block=greatest(coalesce(last_finalized_block,0), $3),
              last_sync_at=now(),
              updated_at=now()
        where chain_id=$1 and lower(pair_address)=lower($2)`,
      [indexedPool.chainId, indexedPool.pairAddress, scannedTo],
    );
  }

  // If we never got a chunk committed but also never scanned, seed cursor at start-1
  // so market-state shows a number and next pass continues cleanly.
  if (indexedPool.lastIndexedBlock == null && scannedTo < startBlock) {
    const seed = Math.max(0, startBlock - 1);
    await pool.query(
      `update public.dex_pools
          set last_indexed_block=coalesce(last_indexed_block, $3),
              last_finalized_block=coalesce(last_finalized_block, $3),
              last_sync_at=now(),
              updated_at=now()
        where chain_id=$1 and lower(pair_address)=lower($2)`,
      [indexedPool.chainId, indexedPool.pairAddress, seed],
    );
    scannedTo = seed;
  }

  if (scanError && insertedTrades === 0 && indexedPool.lastIndexedBlock == null && scannedTo < startBlock) {
    // Surface soft error without throwing (caller used to mark TOPAZ_DEGRADED).
    console.warn("[wtr] Topaz pool scan soft-fail", {
      pair: indexedPool.pairAddress,
      campaign: indexedPool.campaignAddress,
      startBlock,
      endBlock,
      error: scanError,
    });
  }

  const summary = await refreshMarketStats(indexedPool, reserveTokenRaw, reserveNativeRaw);
  if (quote) await refreshQuoteMarketStats(indexedPool, quote.tokenAddress);
  return {
    insertedTrades,
    startBlock,
    endBlock: scannedTo,
    finalizedHead,
    reserveTokenRaw,
    reserveNativeRaw,
    summary,
    scanError,
  };
}

export async function runTopazPoolIndexerOnce() {
  if (!ENV.ENABLE_TOPAZ_POOL_INDEXER) {
    return { enabled: false, pools: 0, insertedTrades: 0, errors: 0 };
  }

  let pools = 0;
  let insertedTrades = 0;
  let errors = 0;

  for (const config of chainConfigs()) {
    let provider: ethers.JsonRpcProvider | null = null;
    try {
      const working = await createWorkingProvider(config.rpcUrls, config.chainId, {
        label: `topaz-pool-indexer chain ${config.chainId}`,
        timeoutMs: ENV.RPC_REQUEST_TIMEOUT_MS,
      });
      provider = working.provider;
      const finalizedHead = Math.max(0, working.headBlock - Math.max(0, ENV.CONFIRMATIONS));
      const indexedPools = await listPools(config.chainId);
      for (const indexedPool of indexedPools) {
        pools += 1;
        try {
          const result = await scanPool(provider, indexedPool, finalizedHead);
          insertedTrades += result.insertedTrades;
          console.log("[wtr] Topaz pool pass", {
            chainId: config.chainId,
            pair: indexedPool.pairAddress,
            campaign: indexedPool.campaignAddress,
            insertedTrades: result.insertedTrades,
            from: result.startBlock,
            to: result.endBlock,
            tip: finalizedHead,
            scanError: result.scanError || null,
            rpc: maskRpcUrl(working.url),
          });
        } catch (error: any) {
          errors += 1;
          const message = error?.shortMessage || error?.message || String(error);
          // Transient RPC timeouts must NOT mark the market TOPAZ_DEGRADED — that breaks trading UX.
          if (!isTransientRpcError(error)) {
            await pool.query(
              `update public.campaign_market_state
                  set market_stage='TOPAZ_DEGRADED',
                      pool_verified=false,
                      last_error=$3,
                      updated_at=now()
                where chain_id=$1 and campaign_address=$2`,
              [config.chainId, indexedPool.campaignAddress, message],
            );
          } else {
            await pool.query(
              `update public.campaign_market_state
                  set last_error=$3,
                      updated_at=now()
                where chain_id=$1 and campaign_address=$2`,
              [config.chainId, indexedPool.campaignAddress, `pool_index_transient: ${message}`],
            );
          }
          console.error("[wtr] Topaz pool indexing failed", {
            chainId: config.chainId,
            pair: indexedPool.pairAddress,
            campaign: indexedPool.campaignAddress,
            transient: isTransientRpcError(error),
            error: message,
          });
        }
      }
    } catch (error: any) {
      errors += 1;
      console.error("[wtr] Topaz pool indexer RPC unavailable", {
        chainId: config.chainId,
        error: error?.shortMessage || error?.message || String(error),
      });
    } finally {
      provider?.destroy();
    }
  }

  return { enabled: true, pools, insertedTrades, errors };
}

export function startTopazPoolIndexerLoop() {
  if (!ENV.ENABLE_TOPAZ_POOL_INDEXER || globalState[LOOP_SYMBOL]) return;
  globalState[LOOP_SYMBOL] = true;

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runTopazPoolIndexerOnce();
      if (result.insertedTrades || result.errors) console.log("[wtr] Topaz indexer pass", result);
    } catch (error: any) {
      console.error("[wtr] Topaz indexer loop failed", error?.message || String(error));
    } finally {
      running = false;
    }
  };

  const initial = setTimeout(() => void tick(), 4_000);
  initial.unref?.();
  // Slower than bonding tip scan so free RPCs aren't double-saturated.
  const intervalMs = Math.max(10_000, Number(process.env.TOPAZ_POOL_INDEXER_INTERVAL_MS || 20_000));
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
}
