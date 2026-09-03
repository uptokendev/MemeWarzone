import { ethers } from "ethers";
import { ablyRest, tokenChannel } from "./ably.js";
import { pool } from "./db.js";
import { ENV } from "./env.js";
import {
  deriveRobinhoodUsdValuation,
  resolveRobinhoodQuoteUsdReference,
  type RobinhoodQuoteUsdReference,
} from "./robinhoodMarketValuation.js";
import {
  formatPairExecution,
  normalizeCanonicalPairSwap,
  normalizeMockPairSwap,
  normalizePairDescriptor,
  type RobinhoodPairDescriptor,
} from "./robinhoodPairSemantics.js";
import { describeRobinhoodQuoteAsset } from "./robinhoodStockTokenRegistry.js";
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

const ERC20_METADATA_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
] as const;
const V3_FACTORY_ABI = ["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)"] as const;

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
  baseTokenAddress: string;
  quoteTokenAddress: string;
  quoteAssetType: "WRAPPED_NATIVE" | "STOCK_TOKEN" | "OTHER";
  baseDecimals: number;
  quoteDecimals: number;
  oracleFeedAddress: string | null;
  marketRole: string;
  routerAddress: string;
  factoryAddress: string;
  token0Address: string;
  token1Address: string;
  feePpm: number;
  graduationBlock: number;
  lastIndexedBlock: number | null;
};

type PairBalances = {
  reserveBaseRaw: bigint;
  reserveQuoteRaw: bigint;
};

type NormalizedSwap = {
  side: "buy" | "sell";
  sender: string | null;
  recipient: string | null;
  baseAmountRaw: bigint;
  quoteAmountRaw: bigint;
  // Compatibility aliases for older native-only tests/callers. For stock pairs,
  // nativeAmountRaw is deliberately null rather than pretending quote == native.
  tokenAmountRaw: bigint;
  nativeAmountRaw: bigint | null;
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
  return ENV.ENABLE_ROBINHOOD_V3_POOL_INDEXER;
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

function storedDecimals(value: unknown): number | null {
  if (value == null || value === "") return null;
  const decimals = Number(value);
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : null;
}

function rawBigInt(value: unknown): bigint | null {
  const raw = String(value ?? "").trim();
  return /^\d+$/.test(raw) ? BigInt(raw) : null;
}

async function tryCall<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch {
    return null;
  }
}

async function tokenDecimals(provider: ethers.Provider, tokenAddress: string): Promise<number> {
  try {
    const token = new ethers.Contract(tokenAddress, ERC20_METADATA_ABI, provider) as any;
    const value = Number(await token.decimals());
    return Number.isInteger(value) && value >= 0 && value <= 36 ? value : 18;
  } catch {
    return 18;
  }
}

async function tokenBalanceAt(
  provider: ethers.Provider,
  tokenAddress: string,
  account: string,
  blockTag?: number,
): Promise<bigint | null> {
  try {
    const token = new ethers.Contract(tokenAddress, ERC20_METADATA_ABI, provider) as any;
    const value = blockTag == null
      ? await token.balanceOf(account)
      : await token.balanceOf(account, { blockTag });
    return BigInt(value);
  } catch {
    if (blockTag == null) return null;
    try {
      const token = new ethers.Contract(tokenAddress, ERC20_METADATA_ABI, provider) as any;
      return BigInt(await token.balanceOf(account));
    } catch {
      return null;
    }
  }
}

async function readPairBalances(input: {
  provider: ethers.Provider;
  pairAddress: string;
  token0Address: string;
  token1Address: string;
  baseTokenAddress: string;
  quoteTokenAddress: string;
  blockTag?: number;
}): Promise<PairBalances> {
  const [token0Balance, token1Balance] = await Promise.all([
    tokenBalanceAt(input.provider, input.token0Address, input.pairAddress, input.blockTag),
    tokenBalanceAt(input.provider, input.token1Address, input.pairAddress, input.blockTag),
  ]);

  const pair = new ethers.Contract(input.pairAddress, MOCK_POOL_ABI, input.provider) as any;
  const [mock0, mock1] = await Promise.all([
    tryCall(() => pair.reserve0()),
    tryCall(() => pair.reserve1()),
  ]);
  const reserve0 = token0Balance != null && token0Balance > 0n ? token0Balance : BigInt(mock0 ?? 0n);
  const reserve1 = token1Balance != null && token1Balance > 0n ? token1Balance : BigInt(mock1 ?? 0n);
  const reserveBaseRaw = input.token0Address === input.baseTokenAddress ? reserve0 : reserve1;
  const reserveQuoteRaw = input.token0Address === input.quoteTokenAddress ? reserve0 : reserve1;
  return { reserveBaseRaw, reserveQuoteRaw };
}

function buildDescriptor(indexedPool: IndexedPool): RobinhoodPairDescriptor {
  return normalizePairDescriptor({
    campaignTokenAddress: indexedPool.baseTokenAddress,
    token0Address: indexedPool.token0Address,
    token1Address: indexedPool.token1Address,
    wrappedNativeAddress: indexedPool.quoteAssetType === "WRAPPED_NATIVE" ? indexedPool.quoteTokenAddress : indexedPool.wrappedNativeAddress,
    stockTokenAddresses: indexedPool.quoteAssetType === "STOCK_TOKEN" ? [indexedPool.quoteTokenAddress] : [],
    baseDecimals: indexedPool.baseDecimals,
    quoteDecimals: indexedPool.quoteDecimals,
  });
}

async function discoverPools(provider: ethers.JsonRpcProvider, config: ChainConfig): Promise<void> {
  const candidates = await pool.query(
    `select cms.chain_id,cms.campaign_address,cms.token_address,cms.dex_pair_address,cms.graduation_block,
            cms.wrapped_native_address,
            mp.base_token_address as registered_base_token_address,
            mp.quote_token_address as registered_quote_token_address,
            mp.base_decimals as registered_base_decimals,
            mp.quote_decimals as registered_quote_decimals,
            mp.quote_asset_type as registered_quote_asset_type,
            mp.market_role as registered_market_role,
            mp.oracle_feed_address as registered_oracle_feed_address
       from public.campaign_market_state cms
       left join public.market_pairs mp
         on mp.chain_id=cms.chain_id and lower(mp.pool_address)=lower(cms.dex_pair_address)
      where cms.chain_id=$1
        and cms.indexing_enabled=true
        and cms.dex_pair_address is not null
        and cms.dex_pair_address<>''
        and cms.market_stage in ('GRADUATING','DEX_PENDING','DEX_ACTIVE','DEX_DEGRADED')
      order by cms.graduation_block asc nulls last`,
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

      const quoteTokenAddress = token0Address === tokenAddress ? token1Address : token0Address;
      const registeredQuoteTokenAddress = lowerAddress(row.registered_quote_token_address);
      if (registeredQuoteTokenAddress && registeredQuoteTokenAddress !== quoteTokenAddress) {
        throw new Error("V3 pool quote token does not match registered market pair");
      }

      const wrappedNativeAddress = lowerAddress(row.wrapped_native_address);
      const quoteDescriptor = describeRobinhoodQuoteAsset({
        chainId: config.chainId,
        quoteToken: quoteTokenAddress,
        wrappedNativeAddress,
      });
      const registeredType = String(row.registered_quote_asset_type || "").toUpperCase();
      const quoteAssetType =
        quoteDescriptor.quoteAssetType === "WRAPPED_NATIVE"
          ? "WRAPPED_NATIVE"
          : quoteDescriptor.quoteAssetType === "STOCK_TOKEN"
            ? "STOCK_TOKEN"
            : registeredType === "WRAPPED_NATIVE" || registeredType === "STOCK_TOKEN" || registeredType === "OTHER"
              ? registeredType
              : "OTHER";
      if (quoteAssetType === "OTHER") {
        throw new Error(`Robinhood quote token ${quoteTokenAddress} is not an approved wrapped-native or Stock Token quote asset`);
      }
      if (quoteAssetType === "WRAPPED_NATIVE" && !wrappedNativeAddress) {
        throw new Error("Wrapped-native Robinhood market is missing canonical wrapped native address");
      }

      const registeredBase = lowerAddress(row.registered_base_token_address);
      if (registeredBase && registeredBase !== tokenAddress) throw new Error("Registered market base token does not match campaign token");

      const registeredBaseDecimals = storedDecimals(row.registered_base_decimals);
      const registeredQuoteDecimals = storedDecimals(row.registered_quote_decimals);
      const baseDecimals = registeredBaseDecimals ?? await tokenDecimals(provider, tokenAddress);
      const quoteDecimals = registeredQuoteDecimals
        ?? (quoteDescriptor.stockToken?.decimals != null
          ? Number(quoteDescriptor.stockToken.decimals)
          : await tokenDecimals(provider, quoteTokenAddress));
      const descriptor = normalizePairDescriptor({
        campaignTokenAddress: tokenAddress,
        token0Address,
        token1Address,
        wrappedNativeAddress,
        stockTokenAddresses: quoteAssetType === "STOCK_TOKEN" ? [quoteTokenAddress] : [],
        baseDecimals,
        quoteDecimals,
      });
      if (descriptor.quoteAssetType !== quoteAssetType) throw new Error("Robinhood quote classification mismatch");

      const factory = new ethers.Contract(factoryAddress, V3_FACTORY_ABI, provider) as any;
      const factoryPair = lowerAddress(await tryCall(() => factory.getPool(tokenAddress, quoteTokenAddress, feePpm)));
      if (factoryPair && factoryPair !== pairAddress) throw new Error("V3 factory pool mismatch");

      const balances = await readPairBalances({
        provider,
        pairAddress,
        token0Address,
        token1Address,
        baseTokenAddress: tokenAddress,
        quoteTokenAddress,
      });
      const reserveBaseRaw = balances.reserveBaseRaw;
      const reserveQuoteRaw = balances.reserveQuoteRaw;
      const reserveNativeRaw = quoteAssetType === "WRAPPED_NATIVE" ? reserveQuoteRaw : null;
      const graduationBlock = Math.max(0, Number(row.graduation_block || 0));
      const routerAddress = config.swapRouterAddress || ethers.ZeroAddress.toLowerCase();
      const feeBps = Math.max(0, Math.round(feePpm / 100));
      const marketRole = String(row.registered_market_role || (quoteAssetType === "WRAPPED_NATIVE" ? "CANONICAL_NATIVE" : "CANONICAL_STOCK")).toUpperCase();
      const oracleFeedAddress = lowerAddress(row.registered_oracle_feed_address) || lowerAddress(quoteDescriptor.referenceOracle) || null;

      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(
          `insert into public.dex_pools(
             chain_id,pair_address,campaign_address,token_address,wrapped_native_address,
             router_address,factory_address,factory_generation,token0_address,token1_address,
             stable,fee_bps,graduation_block,support_enabled,indexing_enabled,
             reserve_token_raw,reserve_native_raw,
             base_token_address,quote_token_address,base_decimals,quote_decimals,quote_asset_type,market_role,
             reserve_base_raw,reserve_quote_raw,oracle_feed_address,updated_at
           ) values($1,$2,$3,$4,$5,$6,$7,'v3',$8,$9,false,$10,$11,true,true,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,now())
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
             base_token_address=excluded.base_token_address,
             quote_token_address=excluded.quote_token_address,
             base_decimals=excluded.base_decimals,
             quote_decimals=excluded.quote_decimals,
             quote_asset_type=excluded.quote_asset_type,
             market_role=excluded.market_role,
             reserve_base_raw=excluded.reserve_base_raw,
             reserve_quote_raw=excluded.reserve_quote_raw,
             oracle_feed_address=excluded.oracle_feed_address,
             updated_at=now()`,
          [
            config.chainId,
            pairAddress,
            campaignAddress,
            tokenAddress,
            wrappedNativeAddress || ethers.ZeroAddress.toLowerCase(),
            routerAddress,
            factoryAddress,
            token0Address,
            token1Address,
            feeBps,
            graduationBlock,
            reserveBaseRaw.toString(),
            reserveNativeRaw?.toString() ?? null,
            tokenAddress,
            quoteTokenAddress,
            baseDecimals,
            quoteDecimals,
            quoteAssetType,
            marketRole,
            reserveBaseRaw.toString(),
            reserveQuoteRaw.toString(),
            oracleFeedAddress,
          ],
        );
        await client.query(
          `insert into public.market_pairs(
             chain_id,campaign_address,pool_address,base_token_address,quote_token_address,
             base_decimals,quote_decimals,quote_asset_type,market_role,venue,fee_tier,
             router_address,factory_address,verified,trading_enabled,indexing_enabled,
             oracle_feed_address,reserve_base_raw,reserve_quote_raw,last_verified_at,updated_at
           ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'robinhood_v3',$10,$11,$12,true,true,true,$13,$14,$15,now(),now())
           on conflict(chain_id,lower(pool_address)) do update set
             campaign_address=excluded.campaign_address,
             base_token_address=excluded.base_token_address,
             quote_token_address=excluded.quote_token_address,
             base_decimals=excluded.base_decimals,
             quote_decimals=excluded.quote_decimals,
             quote_asset_type=excluded.quote_asset_type,
             market_role=excluded.market_role,
             fee_tier=excluded.fee_tier,
             router_address=excluded.router_address,
             factory_address=excluded.factory_address,
             verified=true,trading_enabled=true,indexing_enabled=true,
             oracle_feed_address=excluded.oracle_feed_address,
             reserve_base_raw=excluded.reserve_base_raw,
             reserve_quote_raw=excluded.reserve_quote_raw,
             last_verified_at=now(),updated_at=now()`,
          [config.chainId,campaignAddress,pairAddress,tokenAddress,quoteTokenAddress,baseDecimals,quoteDecimals,quoteAssetType,marketRole,feePpm,routerAddress,factoryAddress,oracleFeedAddress,reserveBaseRaw.toString(),reserveQuoteRaw.toString()],
        );
        await client.query(
          `update public.campaign_market_state
              set market_stage='DEX_ACTIVE',dex_router_address=$3,dex_factory_address=$4,
                  wrapped_native_address=coalesce(nullif($5,''),wrapped_native_address),pool_stable=false,pool_fee_bps=$6,pool_verified=true,
                  indexing_enabled=true,last_verified_at=now(),last_error=null,updated_at=now()
            where chain_id=$1 and campaign_address=$2`,
          [config.chainId, campaignAddress, routerAddress, factoryAddress, wrappedNativeAddress, feeBps],
        );
        await client.query(
          `update public.campaigns
              set market_stage='DEX_ACTIVE',bonding_active=false,support_enabled=true,indexing_enabled=true,updated_at=now()
            where chain_id=$1 and campaign_address=$2`,
          [config.chainId, campaignAddress],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
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
  const maxPools = Math.max(1, ENV.ROBINHOOD_V3_POOL_INDEXER_MAX_POOLS);
  const result = await pool.query(
    `select chain_id,pair_address,campaign_address,token_address,wrapped_native_address,
            base_token_address,quote_token_address,quote_asset_type,base_decimals,quote_decimals,
            oracle_feed_address,market_role,
            router_address,factory_address,token0_address,token1_address,fee_bps,
            graduation_block,last_indexed_block
       from public.dex_pools
      where chain_id=$1 and support_enabled=true and indexing_enabled=true
      order by coalesce(last_indexed_block,graduation_block) asc
      limit $2`,
    [chainId, maxPools],
  );
  return result.rows.map((row: any) => {
    const tokenAddress = lowerAddress(row.token_address);
    const quoteTokenAddress = lowerAddress(row.quote_token_address) || lowerAddress(row.wrapped_native_address);
    const quoteAssetType = String(row.quote_asset_type || "WRAPPED_NATIVE").toUpperCase() as IndexedPool["quoteAssetType"];
    return {
      chainId: Number(row.chain_id),
      pairAddress: lowerAddress(row.pair_address),
      campaignAddress: lowerAddress(row.campaign_address),
      tokenAddress,
      wrappedNativeAddress: lowerAddress(row.wrapped_native_address),
      baseTokenAddress: lowerAddress(row.base_token_address) || tokenAddress,
      quoteTokenAddress,
      quoteAssetType,
      baseDecimals: storedDecimals(row.base_decimals) ?? 18,
      quoteDecimals: storedDecimals(row.quote_decimals) ?? 18,
      oracleFeedAddress: lowerAddress(row.oracle_feed_address) || null,
      marketRole: String(row.market_role || (quoteAssetType === "STOCK_TOKEN" ? "CANONICAL_STOCK" : "CANONICAL_NATIVE")),
      routerAddress: lowerAddress(row.router_address),
      factoryAddress: lowerAddress(row.factory_address),
      token0Address: lowerAddress(row.token0_address),
      token1Address: lowerAddress(row.token1_address),
      feePpm: Number(row.fee_bps || 0) * 100,
      graduationBlock: Number(row.graduation_block || 0),
      lastIndexedBlock: row.last_indexed_block == null ? null : Number(row.last_indexed_block),
    };
  });
}

function withCompatibility(indexedPool: IndexedPool, swap: { side: "buy" | "sell"; baseAmountRaw: bigint; quoteAmountRaw: bigint }, sender: string | null, recipient: string | null): NormalizedSwap {
  return {
    side: swap.side,
    sender,
    recipient,
    baseAmountRaw: swap.baseAmountRaw,
    quoteAmountRaw: swap.quoteAmountRaw,
    tokenAmountRaw: swap.baseAmountRaw,
    nativeAmountRaw: indexedPool.quoteAssetType === "WRAPPED_NATIVE" ? swap.quoteAmountRaw : null,
  };
}

function normalizeMockSwap(indexedPool: IndexedPool, parsed: ethers.LogDescription): NormalizedSwap | null {
  const descriptor = buildDescriptor(indexedPool);
  const sender = lowerAddress(parsed.args.sender) || null;
  const recipient = lowerAddress(parsed.args.recipient) || null;
  const normalized = normalizeMockPairSwap({
    descriptor,
    tokenIn: lowerAddress(parsed.args.tokenIn),
    tokenOut: lowerAddress(parsed.args.tokenOut),
    amountIn: BigInt(parsed.args.amountIn),
    amountOut: BigInt(parsed.args.amountOut),
  });
  return normalized ? withCompatibility(indexedPool, normalized, sender, recipient) : null;
}

function normalizeCanonicalSwap(indexedPool: IndexedPool, parsed: ethers.LogDescription): NormalizedSwap | null {
  const descriptor = buildDescriptor(indexedPool);
  const sender = lowerAddress(parsed.args.sender) || null;
  const recipient = lowerAddress(parsed.args.recipient) || null;
  const normalized = normalizeCanonicalPairSwap({
    descriptor,
    token0Address: indexedPool.token0Address,
    amount0: BigInt(parsed.args.amount0),
    amount1: BigInt(parsed.args.amount1),
  });
  return normalized ? withCompatibility(indexedPool, normalized, sender, recipient) : null;
}

function valuationError(reference: RobinhoodQuoteUsdReference, valuation: { priceUsd: string | null; marketCapUsd: string | null; liquidityUsd: string | null }): string | null {
  if (!reference.healthy) return reference.error || "Quote USD reference is unhealthy.";
  if (!valuation.priceUsd) return "Normalized MEME/USD price could not be derived.";
  if (!valuation.marketCapUsd) return "Post-burn total supply is unavailable for market-cap valuation.";
  if (!valuation.liquidityUsd) return "Registered quote-side pool balance is unavailable for liquidity valuation.";
  return null;
}

async function upsertCandle(input: {
  indexedPool: IndexedPool;
  blockTime: Date;
  blockNumber: number;
  logIndex: number;
  priceQuote: string;
  quoteAmountRaw: bigint;
  priceUsd: string | null;
  volumeUsd: string | null;
  reference: RobinhoodQuoteUsdReference;
}): Promise<void> {
  const quoteVolume = ethers.formatUnits(input.quoteAmountRaw, input.indexedPool.quoteDecimals);
  const nativeVolume = input.indexedPool.quoteAssetType === "WRAPPED_NATIVE" ? quoteVolume : "0";
  for (const resolution of Object.keys(RESOLUTION_MS) as CandleResolution[]) {
    await pool.query(
      `insert into public.token_candles(
         chain_id,campaign_address,timeframe,bucket_start,o,h,l,c,volume_bnb,trades_count,
         source_mask,bonding_trade_count,dex_trade_count,bonding_volume_bnb,dex_volume_bnb,
         last_block_number,last_log_index,quote_token_address,quote_asset_type,volume_quote,dex_volume_quote,
         o_usd,h_usd,l_usd,c_usd,volume_usd,reference_price_usd,reference_price_updated_at,valuation_source,valuation_healthy,updated_at
       ) values($1,$2,$3,$4,$5,$5,$5,$5,$6,1,2,0,1,0,$6,$7,$8,$9,$10,$11,$11,
                $12,$12,$12,$12,coalesce($13::numeric,0),$14,$15,$16,$17,now())
       on conflict(chain_id,campaign_address,timeframe,bucket_start) do update set
         h=greatest(public.token_candles.h,excluded.h),l=least(public.token_candles.l,excluded.l),
         c=case when coalesce(public.token_candles.last_block_number,-1) < excluded.last_block_number then excluded.c
                when public.token_candles.last_block_number = excluded.last_block_number and coalesce(public.token_candles.last_log_index,-1) <= excluded.last_log_index then excluded.c
                else public.token_candles.c end,
         volume_bnb=public.token_candles.volume_bnb+excluded.volume_bnb,trades_count=public.token_candles.trades_count+1,
         source_mask=(public.token_candles.source_mask::int | 2)::smallint,dex_trade_count=public.token_candles.dex_trade_count+1,
         dex_volume_bnb=public.token_candles.dex_volume_bnb+excluded.dex_volume_bnb,
         quote_token_address=excluded.quote_token_address,quote_asset_type=excluded.quote_asset_type,
         volume_quote=public.token_candles.volume_quote+excluded.volume_quote,
         dex_volume_quote=public.token_candles.dex_volume_quote+excluded.dex_volume_quote,
         h_usd=case when excluded.h_usd is null then public.token_candles.h_usd when public.token_candles.h_usd is null then excluded.h_usd else greatest(public.token_candles.h_usd,excluded.h_usd) end,
         l_usd=case when excluded.l_usd is null then public.token_candles.l_usd when public.token_candles.l_usd is null then excluded.l_usd else least(public.token_candles.l_usd,excluded.l_usd) end,
         c_usd=case when excluded.c_usd is null then public.token_candles.c_usd
                    when coalesce(public.token_candles.last_block_number,-1) < excluded.last_block_number then excluded.c_usd
                    when public.token_candles.last_block_number = excluded.last_block_number and coalesce(public.token_candles.last_log_index,-1) <= excluded.last_log_index then excluded.c_usd
                    else public.token_candles.c_usd end,
         o_usd=coalesce(public.token_candles.o_usd,excluded.o_usd),
         volume_usd=public.token_candles.volume_usd+excluded.volume_usd,
         reference_price_usd=coalesce(excluded.reference_price_usd,public.token_candles.reference_price_usd),
         reference_price_updated_at=coalesce(excluded.reference_price_updated_at,public.token_candles.reference_price_updated_at),
         valuation_source=coalesce(excluded.valuation_source,public.token_candles.valuation_source),
         valuation_healthy=coalesce(public.token_candles.valuation_healthy,true) and coalesce(excluded.valuation_healthy,false),
         last_block_number=greatest(coalesce(public.token_candles.last_block_number,-1),excluded.last_block_number),
         last_log_index=case when coalesce(public.token_candles.last_block_number,-1) < excluded.last_block_number then excluded.last_log_index
                             when public.token_candles.last_block_number = excluded.last_block_number then greatest(coalesce(public.token_candles.last_log_index,-1),excluded.last_log_index)
                             else public.token_candles.last_log_index end,updated_at=now()`,
      [
        input.indexedPool.chainId,
        input.indexedPool.campaignAddress,
        resolution,
        bucketStart(input.blockTime, resolution),
        input.priceQuote,
        nativeVolume,
        input.blockNumber,
        input.logIndex,
        input.indexedPool.quoteTokenAddress,
        input.indexedPool.quoteAssetType,
        quoteVolume,
        input.priceUsd,
        input.volumeUsd,
        input.reference.priceUsd,
        input.reference.updatedAt,
        input.reference.source,
        input.reference.healthy && Boolean(input.priceUsd && input.volumeUsd),
      ],
    );
  }
}

async function publishMarketEvent(indexedPool: IndexedPool, name: string, data: Record<string, unknown>): Promise<void> {
  try {
    const channel = ablyRest.channels.get(tokenChannel(indexedPool.chainId, indexedPool.campaignAddress));
    await channel.publish(name, { chainId: indexedPool.chainId, campaignAddress: indexedPool.campaignAddress, pairAddress: indexedPool.pairAddress, ...data });
  } catch (error: any) {
    console.warn("[robinhood-v3] realtime publish failed", name, error?.message || String(error));
  }
}

async function updateMarketStats(indexedPool: IndexedPool, priceQuote: string, quoteAmount: string, side: "buy" | "sell", blockNumber: number, blockTime: Date): Promise<void> {
  await pool.query(
    `insert into public.market_stats(
       chain_id,campaign_address,market_stage,quote_token_address,quote_asset_type,last_price_quote,dex_volume_24h_quote,
       trades_24h,buys_24h,sells_24h,last_trade_block,last_trade_at,updated_at
     ) values($1,$2,'DEX_ACTIVE',$3,$4,$5,$6,1,$7,$8,$9,$10,now())
     on conflict(chain_id,campaign_address) do update set
       market_stage='DEX_ACTIVE',quote_token_address=excluded.quote_token_address,quote_asset_type=excluded.quote_asset_type,
       last_price_quote=excluded.last_price_quote,
       dex_volume_24h_quote=(select coalesce(sum(quote_amount),0) from public.dex_trades where chain_id=$1 and campaign_address=$2 and status='confirmed' and block_time>=now()-interval '24 hours'),
       trades_24h=(select count(*)::int from public.dex_trades where chain_id=$1 and campaign_address=$2 and status='confirmed' and block_time>=now()-interval '24 hours'),
       buys_24h=(select count(*)::int from public.dex_trades where chain_id=$1 and campaign_address=$2 and status='confirmed' and side='buy' and block_time>=now()-interval '24 hours'),
       sells_24h=(select count(*)::int from public.dex_trades where chain_id=$1 and campaign_address=$2 and status='confirmed' and side='sell' and block_time>=now()-interval '24 hours'),
       last_trade_block=excluded.last_trade_block,last_trade_at=excluded.last_trade_at,updated_at=now()`,
    [indexedPool.chainId,indexedPool.campaignAddress,indexedPool.quoteTokenAddress,indexedPool.quoteAssetType,priceQuote,quoteAmount,side === "buy" ? 1 : 0,side === "sell" ? 1 : 0,blockNumber,blockTime],
  );

  if (indexedPool.quoteAssetType !== "WRAPPED_NATIVE") return;
  await pool.query(
    `update public.market_stats
        set last_price_bnb=$3,
            dex_volume_24h_bnb=(select coalesce(sum(native_amount),0) from public.dex_trades where chain_id=$1 and campaign_address=$2 and status='confirmed' and block_time>=now()-interval '24 hours'),
            volume_24h_bnb=(select coalesce(sum("nativeAmountRaw"::numeric/1e18),0) from public.market_trades_v where "chainId"=$1 and "campaignAddress"=$2 and "blockTime">=now()-interval '24 hours'),
            updated_at=now()
      where chain_id=$1 and campaign_address=$2`,
    [indexedPool.chainId,indexedPool.campaignAddress,priceQuote],
  );
}

async function refreshNormalizedMarketValuation(provider: ethers.Provider, indexedPool: IndexedPool, blockTag?: number): Promise<void> {
  const [stats, state, balances, reference, volume] = await Promise.all([
    pool.query(
      `select last_price_quote,last_trade_at
         from public.market_stats
        where chain_id=$1 and campaign_address=$2
        limit 1`,
      [indexedPool.chainId, indexedPool.campaignAddress],
    ),
    pool.query(
      `select post_burn_total_supply_raw
         from public.campaign_market_state
        where chain_id=$1 and campaign_address=$2
        limit 1`,
      [indexedPool.chainId, indexedPool.campaignAddress],
    ),
    readPairBalances({
      provider,
      pairAddress: indexedPool.pairAddress,
      token0Address: indexedPool.token0Address,
      token1Address: indexedPool.token1Address,
      baseTokenAddress: indexedPool.baseTokenAddress,
      quoteTokenAddress: indexedPool.quoteTokenAddress,
      blockTag,
    }),
    resolveRobinhoodQuoteUsdReference({
      chainId: indexedPool.chainId,
      quoteTokenAddress: indexedPool.quoteTokenAddress,
      quoteAssetType: indexedPool.quoteAssetType,
    }),
    pool.query(
      `select coalesce(sum(volume_usd),0) as volume_24h_usd
         from public.dex_trades
        where chain_id=$1 and campaign_address=$2 and status='confirmed'
          and block_time>=now()-interval '24 hours'`,
      [indexedPool.chainId, indexedPool.campaignAddress],
    ),
  ]);

  const priceQuote = stats.rows[0]?.last_price_quote ?? null;
  const supplyRaw = state.rows[0]?.post_burn_total_supply_raw ?? null;
  const derived = reference.healthy && reference.priceUsd && priceQuote
    ? deriveRobinhoodUsdValuation({
        priceQuote,
        quotePriceUsd: reference.priceUsd,
        postBurnTotalSupplyRaw: supplyRaw,
        baseDecimals: indexedPool.baseDecimals,
        reserveQuoteRaw: balances.reserveQuoteRaw.toString(),
        quoteDecimals: indexedPool.quoteDecimals,
      })
    : { priceUsd: null, volumeUsd: null, marketCapUsd: null, liquidityUsd: null };
  const error = valuationError(reference, derived);
  const healthy = !error;
  const lastTradeAt = stats.rows[0]?.last_trade_at ?? null;
  const dataLagSeconds = lastTradeAt
    ? Math.max(0, Math.floor((Date.now() - new Date(lastTradeAt).getTime()) / 1000))
    : null;
  const volume24hUsd = volume.rows[0]?.volume_24h_usd ?? null;

  await pool.query(
    `update public.dex_pools
        set reserve_token_raw=$3,
            reserve_native_raw=case when $5='WRAPPED_NATIVE' then $4 else null end,
            reserve_base_raw=$3,
            reserve_quote_raw=$4,
            price_usd=$6,
            liquidity_usd=$7,
            volume_usd_24h=$8,
            reference_price_usd=$9,
            reference_price_updated_at=$10,
            valuation_source=$11,
            valuation_healthy=$12,
            valuation_error=$13,
            updated_at=now()
      where chain_id=$1 and pair_address=$2`,
    [
      indexedPool.chainId,
      indexedPool.pairAddress,
      balances.reserveBaseRaw.toString(),
      balances.reserveQuoteRaw.toString(),
      indexedPool.quoteAssetType,
      healthy ? derived.priceUsd : null,
      healthy ? derived.liquidityUsd : null,
      volume24hUsd,
      reference.priceUsd,
      reference.updatedAt,
      reference.source,
      healthy,
      error,
    ],
  );

  await pool.query(
    `update public.market_pairs
        set reserve_base_raw=$3,reserve_quote_raw=$4,updated_at=now()
      where chain_id=$1 and lower(pool_address)=lower($2)`,
    [indexedPool.chainId,indexedPool.pairAddress,balances.reserveBaseRaw.toString(),balances.reserveQuoteRaw.toString()],
  );

  await pool.query(
    `insert into public.market_stats(
       chain_id,campaign_address,market_stage,quote_token_address,quote_asset_type,
       last_price_usd,market_cap_usd,liquidity_usd,volume_24h_usd,
       reference_price_usd,reference_price_updated_at,valuation_source,valuation_healthy,valuation_error,
       post_burn_total_supply_raw,supply_basis,data_lag_seconds,updated_at
     ) values($1,$2,'DEX_ACTIVE',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'post_burn_total_supply',$15,now())
     on conflict(chain_id,campaign_address) do update set
       market_stage='DEX_ACTIVE',quote_token_address=excluded.quote_token_address,quote_asset_type=excluded.quote_asset_type,
       last_price_usd=excluded.last_price_usd,market_cap_usd=excluded.market_cap_usd,liquidity_usd=excluded.liquidity_usd,
       volume_24h_usd=excluded.volume_24h_usd,reference_price_usd=excluded.reference_price_usd,
       reference_price_updated_at=excluded.reference_price_updated_at,valuation_source=excluded.valuation_source,
       valuation_healthy=excluded.valuation_healthy,valuation_error=excluded.valuation_error,
       post_burn_total_supply_raw=excluded.post_burn_total_supply_raw,supply_basis=excluded.supply_basis,
       data_lag_seconds=excluded.data_lag_seconds,updated_at=now()`,
    [
      indexedPool.chainId,
      indexedPool.campaignAddress,
      indexedPool.quoteTokenAddress,
      indexedPool.quoteAssetType,
      healthy ? derived.priceUsd : null,
      healthy ? derived.marketCapUsd : null,
      healthy ? derived.liquidityUsd : null,
      volume24hUsd,
      reference.priceUsd,
      reference.updatedAt,
      reference.source,
      healthy,
      error,
      supplyRaw,
      dataLagSeconds,
    ],
  );
}

async function insertSwap(provider: ethers.JsonRpcProvider,indexedPool: IndexedPool,log: ethers.Log,_parsed: ethers.LogDescription,normalized: NormalizedSwap): Promise<boolean> {
  if (normalized.baseAmountRaw <= 0n || normalized.quoteAmountRaw <= 0n) return false;
  const descriptor = buildDescriptor(indexedPool);
  const execution = formatPairExecution({
    descriptor,
    swap: { side: normalized.side, baseAmountRaw: normalized.baseAmountRaw, quoteAmountRaw: normalized.quoteAmountRaw },
  });
  const block = await provider.getBlock(log.blockNumber);
  if (!block?.hash) return false;
  const tx = await provider.getTransaction(log.transactionHash).catch(() => null);
  const transactionFrom = tx?.from ? lowerAddress(tx.from) : null;
  const txHash = log.transactionHash.toLowerCase();
  const logIndex = Number(log.index);
  const blockTime = new Date(Number(block.timestamp) * 1000);
  const intent = await pool.query(`select intent_id from public.trade_intents where chain_id=$1 and lower(transaction_hash)=lower($2) order by created_at desc limit 1`,[indexedPool.chainId, txHash]);
  const tradeIntentId = intent.rows[0]?.intent_id ?? null;
  const origin = tradeIntentId ? "memewarzone" : "robinhood_v3";
  const isNativeQuote = indexedPool.quoteAssetType === "WRAPPED_NATIVE";
  const nativeAmountRaw = isNativeQuote ? normalized.quoteAmountRaw.toString() : null;
  const nativeAmount = isNativeQuote ? execution.quoteAmount : null;
  const priceBnb = isNativeQuote ? execution.priceQuote : null;
  const reference = await resolveRobinhoodQuoteUsdReference({
    chainId: indexedPool.chainId,
    quoteTokenAddress: indexedPool.quoteTokenAddress,
    quoteAssetType: indexedPool.quoteAssetType,
  });
  const tradeValuation = reference.healthy && reference.priceUsd
    ? deriveRobinhoodUsdValuation({
        priceQuote: execution.priceQuote,
        quotePriceUsd: reference.priceUsd,
        quoteTradeAmount: execution.quoteAmount,
      })
    : { priceUsd: null, volumeUsd: null, marketCapUsd: null, liquidityUsd: null };
  const tradeValuationHealthy = reference.healthy && Boolean(tradeValuation.priceUsd && tradeValuation.volumeUsd);
  const tradeValuationError = tradeValuationHealthy
    ? null
    : reference.error || "Trade USD valuation could not be derived.";

  const inserted = await pool.query(
    `insert into public.dex_trades(
       chain_id,campaign_address,token_address,pair_address,tx_hash,log_index,block_number,block_hash,block_time,status,side,
       sender_address,recipient_address,transaction_from,token_amount_raw,native_amount_raw,token_amount,native_amount,price_bnb,
       base_amount_raw,quote_amount_raw,base_amount,quote_amount,price_quote,quote_asset_type,quote_token_address,
       volume_usd,reference_price_usd,reference_price_updated_at,valuation_source,valuation_healthy,valuation_error,
       execution_source,origin,trade_intent_id,created_at,updated_at
     ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
              $28,$29,$30,$31,$32,$33,'robinhood_v3',$26,$27,now(),now())
     on conflict(chain_id,tx_hash,log_index) do nothing returning tx_hash`,
    [
      indexedPool.chainId,indexedPool.campaignAddress,indexedPool.tokenAddress,indexedPool.pairAddress,
      txHash,logIndex,log.blockNumber,block.hash,blockTime,normalized.side,normalized.sender,normalized.recipient,transactionFrom,
      normalized.baseAmountRaw.toString(),nativeAmountRaw,execution.baseAmount,nativeAmount,priceBnb,
      normalized.baseAmountRaw.toString(),normalized.quoteAmountRaw.toString(),execution.baseAmount,execution.quoteAmount,
      execution.priceQuote,indexedPool.quoteAssetType,indexedPool.quoteTokenAddress,origin,tradeIntentId,
      tradeValuationHealthy ? tradeValuation.volumeUsd : null,
      reference.priceUsd,reference.updatedAt,reference.source,tradeValuationHealthy,tradeValuationError,
    ],
  );
  if (!inserted.rowCount) return false;

  await upsertCandle({
    indexedPool,
    blockTime,
    blockNumber: log.blockNumber,
    logIndex,
    priceQuote: execution.priceQuote,
    quoteAmountRaw: normalized.quoteAmountRaw,
    priceUsd: tradeValuationHealthy ? tradeValuation.priceUsd : null,
    volumeUsd: tradeValuationHealthy ? tradeValuation.volumeUsd : null,
    reference,
  });
  await updateMarketStats(indexedPool, execution.priceQuote, execution.quoteAmount, normalized.side, log.blockNumber, blockTime);
  await pool.query(
    `update public.dex_pools
        set price_quote=$3,
            quote_volume_24h=(select coalesce(sum(quote_amount),0) from public.dex_trades where chain_id=$1 and pair_address=$2 and status='confirmed' and block_time>=now()-interval '24 hours'),
            updated_at=now()
      where chain_id=$1 and pair_address=$2`,
    [indexedPool.chainId,indexedPool.pairAddress,execution.priceQuote],
  );

  await publishMarketEvent(indexedPool, "market_trade", {
    eventId:`${indexedPool.chainId}:${txHash}:${logIndex}`,
    source:"robinhood_v3",
    origin,
    side:normalized.side,
    wallet:transactionFrom || normalized.sender,
    recipient:normalized.recipient,
    baseTokenAddress:indexedPool.baseTokenAddress,
    quoteTokenAddress:indexedPool.quoteTokenAddress,
    quoteAssetType:indexedPool.quoteAssetType,
    baseAmountRaw:normalized.baseAmountRaw.toString(),
    quoteAmountRaw:normalized.quoteAmountRaw.toString(),
    tokenAmountRaw:normalized.baseAmountRaw.toString(),
    nativeAmountRaw:isNativeQuote ? normalized.quoteAmountRaw.toString() : null,
    priceQuote:execution.priceQuote,
    priceBnb:isNativeQuote ? execution.priceQuote : null,
    priceUsd:tradeValuationHealthy ? tradeValuation.priceUsd : null,
    volumeUsd:tradeValuationHealthy ? tradeValuation.volumeUsd : null,
    referencePriceUsd:reference.priceUsd,
    referencePriceUpdatedAt:reference.updatedAt,
    valuationSource:reference.source,
    valuationHealthy:tradeValuationHealthy,
    txHash,logIndex,blockNumber:log.blockNumber,blockTime:blockTime.toISOString(),status:"confirmed",
  });
  return true;
}

async function scanPool(provider: ethers.JsonRpcProvider, indexedPool: IndexedPool, head: number): Promise<number> {
  const from = Math.max(indexedPool.graduationBlock, indexedPool.lastIndexedBlock ?? indexedPool.graduationBlock);
  if (from > head) {
    await refreshNormalizedMarketValuation(provider, indexedPool, head);
    return 0;
  }
  let inserted = 0;
  const chunk = Math.max(50, Number(ENV.LOG_CHUNK_SIZE || 500));
  let cursor = from;
  let lastSwapAt: Date | null = null;
  while (cursor <= head) {
    const to = Math.min(head, cursor + chunk - 1);
    const logs = await provider.getLogs({ address: indexedPool.pairAddress, topics: [[MOCK_SWAP_TOPIC, CANONICAL_SWAP_TOPIC]], fromBlock: cursor, toBlock: to });
    for (const log of logs) {
      const topic = String(log.topics[0] || "").toLowerCase();
      let parsed: ethers.LogDescription | null = null;
      let normalized: NormalizedSwap | null = null;
      if (topic === MOCK_SWAP_TOPIC.toLowerCase()) { parsed = mockIface.parseLog(log); if (parsed) normalized = normalizeMockSwap(indexedPool, parsed); }
      else if (topic === CANONICAL_SWAP_TOPIC.toLowerCase()) { parsed = canonicalIface.parseLog(log); if (parsed) normalized = normalizeCanonicalSwap(indexedPool, parsed); }
      if (!parsed || !normalized) continue;
      if (await insertSwap(provider, indexedPool, log, parsed, normalized)) {
        inserted += 1;
        const block = await provider.getBlock(log.blockNumber);
        if (block) lastSwapAt = new Date(Number(block.timestamp) * 1000);
      }
    }
    await pool.query(`update public.dex_pools set last_indexed_block=$3,last_finalized_block=$3,last_swap_at=coalesce($4,last_swap_at),updated_at=now() where chain_id=$1 and pair_address=$2`,[indexedPool.chainId,indexedPool.pairAddress,to + 1,lastSwapAt]);
    cursor = to + 1;
    if (ENV.INDEXER_LOG_CALL_DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, ENV.INDEXER_LOG_CALL_DELAY_MS));
  }
  await refreshNormalizedMarketValuation(provider, indexedPool, head);
  return inserted;
}

async function runChain(config: ChainConfig): Promise<void> {
  const selected = await createWorkingProvider(config.rpcUrls, config.chainId, {
    timeoutMs: ENV.RPC_REQUEST_TIMEOUT_MS,
    label: `robinhood-v3-${config.chainId}`,
  });
  const provider = selected.provider;
  try {
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== config.chainId) throw new Error(`RPC returned chain ${network.chainId}`);
    await discoverPools(provider, config);
    const head = Math.max(0, selected.headBlock - Math.max(0, ENV.CONFIRMATIONS));
    const pools = await listPools(config.chainId);
    let swaps = 0;
    for (const indexedPool of pools) swaps += await scanPool(provider, indexedPool, head);
    if (pools.length || swaps) console.log("[robinhood-v3] pass", { chainId: config.chainId, head, pools: pools.length, swaps, rpc: maskRpcUrl(selected.url) });
  } finally {
    provider.destroy();
  }
}

async function loop(): Promise<void> {
  const intervalMs = Math.max(2_000, ENV.ROBINHOOD_V3_POOL_INDEXER_INTERVAL_MS);
  while (true) {
    const configs = chainConfigs();
    for (const config of configs) {
      try { await runChain(config); }
      catch (error: any) { console.error("[robinhood-v3] pass failed", { chainId: config.chainId, rpcs: config.rpcUrls.map(maskRpcUrl), error: error?.shortMessage || error?.message || String(error) }); }
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
  storedDecimals,
  rawBigInt,
  readPairBalances,
  valuationError,
};
