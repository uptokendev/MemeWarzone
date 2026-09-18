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
    tryCall<bigint>(() => pair.reserve0() as Promise<bigint>),
    tryCall<bigint>(() => pair.reserve1() as Promise<bigint>),
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
  passHealth.lastCandidateCount = candidates.rowCount ?? candidates.rows.length;

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
      // Keep the real reason first. A database that rejects DEX_DEGRADED (an
      // older stage constraint) otherwise throws out of this handler and
      // replaces the discovery failure with its own, hiding the actual cause.
      passHealth.lastError = `discovery:${campaignAddress}:${message}`.slice(0, 300);
      console.warn("[robinhood-v3] pool discovery degraded", { chainId: config.chainId, campaignAddress, error: message });
      try {
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
      } catch (markError) {
        // Still record the discovery failure on the row we can write.
        const markMessage = String((markError as any)?.message || markError);
        console.error("[robinhood-v3] could not mark pool degraded", { chainId: config.chainId, campaignAddress, error: markMessage });
        try {
          await pool.query(
            `update public.campaign_market_state set last_error=$3, updated_at=now()
              where chain_id=$1 and campaign_address=$2`,
            [config.chainId, campaignAddress, `${message} :: degrade_write_failed:${markMessage}`.slice(0, 1000)],
          );
        } catch { /* diagnostics only */ }
      }
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

/**
 * Pool spot price after the swap, taken from the Swap event's own sqrtPriceX96.
 *
 * The execution price is what the trader actually paid, slippage included. On a
 * thin pool the two diverge by multiples, so charting fills drew candles far
 * above the market cap the page reports from spot. Fills stay on the trade row;
 * candles and last-price use spot. Mock pools emit no sqrtPriceX96 and fall back.
 */
function spotQuotePerBase(
  sqrtPriceX96: bigint,
  token0Address: string,
  baseTokenAddress: string,
  baseDecimals: number,
  quoteDecimals: number,
): string | null {
  if (sqrtPriceX96 <= 0n) return null;
  const Q96 = 1n << 96n;
  const PRECISION = 10n ** 36n;
  // token1 per token0, raw units, scaled by PRECISION.
  const raw1Per0 = (sqrtPriceX96 * sqrtPriceX96 * PRECISION) / (Q96 * Q96);
  if (raw1Per0 <= 0n) return null;

  const baseIsToken0 = token0Address.toLowerCase() === baseTokenAddress.toLowerCase();
  // A raw ratio carries the two tokens' decimal difference; undo it.
  const [fromDecimals, toDecimals] = baseIsToken0
    ? [baseDecimals, quoteDecimals]
    : [quoteDecimals, baseDecimals];

  let scaled = (raw1Per0 * 10n ** BigInt(fromDecimals)) / 10n ** BigInt(toDecimals);
  if (!baseIsToken0) {
    if (scaled <= 0n) return null;
    scaled = (PRECISION * PRECISION) / scaled;
  }
  if (scaled <= 0n) return null;
  return ethers.formatUnits(scaled, 36);
}

function valuationError(reference: RobinhoodQuoteUsdReference, valuation: { priceUsd: string | null; marketCapUsd: string | null; liquidityUsd: string | null }): string | null {
  if (!reference.healthy) return reference.error || "Quote USD reference is unhealthy.";
  if (!valuation.priceUsd) return "Normalized MEME/USD price could not be derived.";
  if (!valuation.marketCapUsd) return "Post-burn total supply is unavailable for market-cap valuation.";
  if (!valuation.liquidityUsd) return "Registered quote-side pool balance is unavailable for liquidity valuation.";
  return null;
}

/**
 * Post-burn total supply for a graduated campaign, cached per campaign.
 *
 * Token Details values market cap as spot x post-burn supply. Writing the same
 * basis onto the candle keeps chart, ATH and header on one number instead of
 * leaving mcap null and letting the chart fall back to trade fill prices.
 */
const postBurnSupplyCache = new Map<string, { supply: number; at: number }>();
const POST_BURN_SUPPLY_TTL_MS = 5 * 60 * 1000;

async function postBurnSupplyWhole(chainId: number, campaignAddress: string, decimals: number): Promise<number> {
  const key = `${chainId}:${campaignAddress}`;
  const cached = postBurnSupplyCache.get(key);
  if (cached && Date.now() - cached.at < POST_BURN_SUPPLY_TTL_MS) return cached.supply;
  try {
    const result = await pool.query(
      `select post_burn_total_supply_raw from public.campaign_market_state
        where chain_id=$1 and campaign_address=$2 limit 1`,
      [chainId, campaignAddress],
    );
    const raw = String(result.rows[0]?.post_burn_total_supply_raw || "").trim();
    const supply = /^\d+$/.test(raw) ? Number(ethers.formatUnits(raw, decimals)) : 0;
    const safe = Number.isFinite(supply) && supply > 0 ? supply : 0;
    postBurnSupplyCache.set(key, { supply: safe, at: Date.now() });
    return safe;
  } catch {
    return 0;
  }
}

async function upsertCandle(input: {
  indexedPool: IndexedPool;
  blockTime: Date;
  blockNumber: number;
  logIndex: number;
  openQuote: string;
  priceQuote: string;
  quoteAmountRaw: bigint;
  priceUsd: string | null;
  volumeUsd: string | null;
  mcapNative: string | null;
  openMcapNative: string | null;
  reference: RobinhoodQuoteUsdReference;
}): Promise<void> {
  const quoteVolume = ethers.formatUnits(input.quoteAmountRaw, input.indexedPool.quoteDecimals);
  const nativeVolume = input.indexedPool.quoteAssetType === "WRAPPED_NATIVE" ? quoteVolume : "0";
  const written: Array<Record<string, unknown>> = [];
  for (const resolution of Object.keys(RESOLUTION_MS) as CandleResolution[]) {
    const upserted = await pool.query(
      `insert into public.token_candles(
         chain_id,campaign_address,timeframe,bucket_start,o,h,l,c,volume_bnb,trades_count,
         source_mask,bonding_trade_count,dex_trade_count,bonding_volume_bnb,dex_volume_bnb,
         last_block_number,last_log_index,quote_token_address,quote_asset_type,volume_quote,dex_volume_quote,
         o_usd,h_usd,l_usd,c_usd,volume_usd,reference_price_usd,reference_price_updated_at,valuation_source,valuation_healthy,
         price_o,price_h,price_l,price_c,mcap_o,mcap_h,mcap_l,mcap_c,canonical_updated_at,updated_at
       ) values($1,$2,$3,$4,$19,greatest($19::numeric,$5::numeric),least($19::numeric,$5::numeric),$5,$6,1,2,0,1,0,$6,$7,$8,$9,$10,$11,$11,
                $12,$12,$12,$12,coalesce($13::numeric,0),$14,$15,$16,$17,
                $19,greatest($19::numeric,$5::numeric),least($19::numeric,$5::numeric),$5,
                $20,greatest($20::numeric,$18::numeric),least($20::numeric,$18::numeric),$18,now(),now())
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
         price_h=case when excluded.price_h is null then public.token_candles.price_h when public.token_candles.price_h is null then excluded.price_h else greatest(public.token_candles.price_h,excluded.price_h) end,
         price_l=case when excluded.price_l is null then public.token_candles.price_l when public.token_candles.price_l is null then excluded.price_l else least(public.token_candles.price_l,excluded.price_l) end,
         price_c=case when excluded.price_c is null then public.token_candles.price_c
                      when coalesce(public.token_candles.last_block_number,-1) < excluded.last_block_number then excluded.price_c
                      when public.token_candles.last_block_number = excluded.last_block_number and coalesce(public.token_candles.last_log_index,-1) <= excluded.last_log_index then excluded.price_c
                      else public.token_candles.price_c end,
         price_o=coalesce(public.token_candles.price_o,excluded.price_o),
         mcap_h=case when excluded.mcap_h is null then public.token_candles.mcap_h when public.token_candles.mcap_h is null then excluded.mcap_h else greatest(public.token_candles.mcap_h,excluded.mcap_h) end,
         mcap_l=case when excluded.mcap_l is null then public.token_candles.mcap_l when public.token_candles.mcap_l is null then excluded.mcap_l else least(public.token_candles.mcap_l,excluded.mcap_l) end,
         mcap_c=case when excluded.mcap_c is null then public.token_candles.mcap_c
                     when coalesce(public.token_candles.last_block_number,-1) < excluded.last_block_number then excluded.mcap_c
                     when public.token_candles.last_block_number = excluded.last_block_number and coalesce(public.token_candles.last_log_index,-1) <= excluded.last_log_index then excluded.mcap_c
                     else public.token_candles.mcap_c end,
         mcap_o=coalesce(public.token_candles.mcap_o,excluded.mcap_o),
         canonical_updated_at=now(),
         last_block_number=greatest(coalesce(public.token_candles.last_block_number,-1),excluded.last_block_number),
         last_log_index=case when coalesce(public.token_candles.last_block_number,-1) < excluded.last_block_number then excluded.last_log_index
                             when public.token_candles.last_block_number = excluded.last_block_number then greatest(coalesce(public.token_candles.last_log_index,-1),excluded.last_log_index)
                             else public.token_candles.last_log_index end,updated_at=now()
       returning timeframe,bucket_start,o,h,l,c,volume_bnb,trades_count`,
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
        input.mcapNative,
        input.openQuote,
        input.openMcapNative,
      ],
    );
    const row = upserted.rows[0];
    if (row) written.push(row);
  }

  // The chart listens for market_candle_upsert. Only market_trade was ever
  // broadcast here, so a graduated Robinhood chart could not move until the
  // page was reloaded.
  for (const row of written) {
    await publishMarketEvent(input.indexedPool, "market_candle_upsert", {
      resolution: String(row.timeframe),
      tf: String(row.timeframe),
      bucket_start: new Date(row.bucket_start as any).toISOString(),
      open: String(row.o),
      high: String(row.h),
      low: String(row.l),
      close: String(row.c),
      volume_bnb: String(row.volume_bnb ?? "0"),
      trades_count: Number(row.trades_count ?? 0),
    });
  }
}

async function publishMarketEvent(indexedPool: IndexedPool, name: string, data: Record<string, unknown>): Promise<void> {
  try {
    const channel = ablyRest.channels.get(tokenChannel(indexedPool.chainId, indexedPool.campaignAddress));
    await channel.publish(name, { chainId: indexedPool.chainId, campaignAddress: indexedPool.campaignAddress, pairAddress: indexedPool.pairAddress, ...data });
    passHealth.lastPublishAt = new Date().toISOString();
    passHealth.lastPublishError = null;
  } catch (error: any) {
    passHealth.lastPublishError = `${name}:${String(error?.message || error)}`.slice(0, 200);
    console.warn("[robinhood-v3] realtime publish failed", name, error?.message || String(error));
  }
}

/** Mirrors the market_stats row the summary endpoint serves, so tiles patch live. */
/**
 * Mirrors topazPoolIndexer.refreshMarketStats for Robinhood.
 *
 * BNB works because Topaz publishes a complete market_stats row: market cap,
 * liquidity, the 5m/1h/4h/24h volumes and the supply basis. Robinhood only ever
 * wrote last price and 24h volume, so Token Details recomputed the rest from
 * trades and disagreed with itself between renders. Same fields, same basis,
 * only the venue differs.
 */
async function refreshRobinhoodMarketStats(
  provider: ethers.Provider,
  indexedPool: IndexedPool,
): Promise<void> {
  const aggregates = await pool.query(
    `select
       coalesce(sum(case when "blockTime">=now()-interval '5 minutes' then ("nativeAmountRaw"::numeric/1e18) else 0 end),0) as volume_5m_bnb,
       coalesce(sum(case when "blockTime">=now()-interval '1 hour' then ("nativeAmountRaw"::numeric/1e18) else 0 end),0) as volume_1h_bnb,
       coalesce(sum(case when "blockTime">=now()-interval '4 hours' then ("nativeAmountRaw"::numeric/1e18) else 0 end),0) as volume_4h_bnb,
       coalesce(sum(case when "blockTime">=now()-interval '24 hours' then ("nativeAmountRaw"::numeric/1e18) else 0 end),0) as volume_24h_bnb,
       coalesce(sum(case when source='bonding' and "blockTime">=now()-interval '24 hours' then ("nativeAmountRaw"::numeric/1e18) else 0 end),0) as bonding_volume_24h_bnb,
       coalesce(sum(case when source='robinhood_v3' and "blockTime">=now()-interval '24 hours' then ("nativeAmountRaw"::numeric/1e18) else 0 end),0) as dex_volume_24h_bnb,
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

  const stats = aggregates.rows[0] || {};
  const supplyRaw = marketState.rows[0]?.post_burn_total_supply_raw ?? null;

  // Read current pool spot rather than the newest fill. On a thin pool a fill
  // sits well above spot, and market cap derives from this number.
  let lastPrice: string | number | null = null;
  try {
    const slot0 = await new ethers.Contract(
      indexedPool.pairAddress,
      ["function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)"],
      provider,
    ).slot0();
    lastPrice = spotQuotePerBase(
      BigInt(slot0.sqrtPriceX96 ?? slot0[0]),
      indexedPool.token0Address,
      indexedPool.baseTokenAddress,
      indexedPool.baseDecimals,
      indexedPool.quoteDecimals,
    );
  } catch {
    lastPrice = null;
  }
  if (lastPrice == null) {
    const priceRow = await pool.query(
      `select last_price_bnb from public.market_stats where chain_id=$1 and campaign_address=$2 limit 1`,
      [indexedPool.chainId, indexedPool.campaignAddress],
    );
    lastPrice = priceRow.rows[0]?.last_price_bnb ?? latest.rows[0]?.priceBnb ?? null;
  }

  const balances = await readPairBalances({
    provider,
    pairAddress: indexedPool.pairAddress,
    token0Address: indexedPool.token0Address,
    token1Address: indexedPool.token1Address,
    baseTokenAddress: indexedPool.baseTokenAddress,
    quoteTokenAddress: indexedPool.quoteTokenAddress,
  });
  const nativeSide = Number(ethers.formatUnits(balances.reserveQuoteRaw, indexedPool.quoteDecimals));
  const tokenSide = Number(ethers.formatUnits(balances.reserveBaseRaw, indexedPool.baseDecimals));
  // Concentrated liquidity holds unequal value per side, so sum both rather
  // than doubling the quote side the way a V2 pool allows.
  const liquidityBnb =
    Number.isFinite(nativeSide) && Number.isFinite(tokenSide) && Number(lastPrice) > 0
      ? nativeSide + tokenSide * Number(lastPrice)
      : nativeSide;

  await pool.query(
    `update public.market_stats set
       last_price_bnb=coalesce($3::numeric,last_price_bnb),
       market_cap_bnb=case when $3::numeric is null or $4::text is null then market_cap_bnb
                           else $3::numeric*($4::numeric/1e18) end,
       liquidity_bnb=$5,
       volume_5m_bnb=$6,volume_1h_bnb=$7,volume_4h_bnb=$8,volume_24h_bnb=$9,
       bonding_volume_24h_bnb=$10,dex_volume_24h_bnb=$11,
       buy_volume_24h_bnb=$12,sell_volume_24h_bnb=$13,
       trades_24h=$14,buys_24h=$15,sells_24h=$16,
       post_burn_total_supply_raw=coalesce($4,post_burn_total_supply_raw),
       supply_basis='post_burn_total_supply',
       data_lag_seconds=0,
       updated_at=now()
     where chain_id=$1 and campaign_address=$2`,
    [
      indexedPool.chainId,
      indexedPool.campaignAddress,
      lastPrice,
      supplyRaw,
      liquidityBnb,
      stats.volume_5m_bnb ?? 0,
      stats.volume_1h_bnb ?? 0,
      stats.volume_4h_bnb ?? 0,
      stats.volume_24h_bnb ?? 0,
      stats.bonding_volume_24h_bnb ?? 0,
      stats.dex_volume_24h_bnb ?? 0,
      stats.buy_volume_24h_bnb ?? 0,
      stats.sell_volume_24h_bnb ?? 0,
      stats.trades_24h ?? 0,
      stats.buys_24h ?? 0,
      stats.sells_24h ?? 0,
    ],
  );
}

async function publishMarketStatsPatch(indexedPool: IndexedPool): Promise<void> {
  try {
    const result = await pool.query(
      `select last_price_bnb,last_price_quote,market_cap_bnb,liquidity_bnb,
              volume_5m_bnb,volume_1h_bnb,volume_4h_bnb,
              dex_volume_24h_bnb,volume_24h_bnb,
              trades_24h,buys_24h,sells_24h,last_trade_at,market_stage
         from public.market_stats
        where chain_id=$1 and campaign_address=$2
        limit 1`,
      [indexedPool.chainId, indexedPool.campaignAddress],
    );
    const row = result.rows[0];
    if (!row) return;
    await publishMarketEvent(indexedPool, "market_stats_patch", {
      last_price_bnb: row.last_price_bnb == null ? null : String(row.last_price_bnb),
      last_price_quote: row.last_price_quote == null ? null : String(row.last_price_quote),
      market_cap_bnb: row.market_cap_bnb == null ? null : String(row.market_cap_bnb),
      liquidity_bnb: row.liquidity_bnb == null ? null : String(row.liquidity_bnb),
      volume_5m_bnb: row.volume_5m_bnb == null ? null : String(row.volume_5m_bnb),
      volume_1h_bnb: row.volume_1h_bnb == null ? null : String(row.volume_1h_bnb),
      volume_4h_bnb: row.volume_4h_bnb == null ? null : String(row.volume_4h_bnb),
      dex_volume_24h_bnb: row.dex_volume_24h_bnb == null ? null : String(row.dex_volume_24h_bnb),
      vol_24h_bnb: row.volume_24h_bnb == null ? null : String(row.volume_24h_bnb),
      trades_24h: row.trades_24h == null ? null : Number(row.trades_24h),
      buys_24h: row.buys_24h == null ? null : Number(row.buys_24h),
      sells_24h: row.sells_24h == null ? null : Number(row.sells_24h),
      last_trade_at: row.last_trade_at ? new Date(row.last_trade_at).toISOString() : null,
      market_stage: row.market_stage == null ? null : String(row.market_stage),
    });
  } catch (error: any) {
    console.warn("[robinhood-v3] stats patch publish failed", error?.message || String(error));
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

async function refreshRobinhoodMarketStatsSafely(provider: ethers.Provider, indexedPool: IndexedPool): Promise<void> {
  try {
    await refreshRobinhoodMarketStats(provider, indexedPool);
    passHealth.lastStatsError = null;
    passHealth.lastStatsWriteAt = new Date().toISOString();
    passHealth.marketStatsRowPresent = true;
  } catch (error: any) {
    passHealth.lastStatsError = `refreshStats:${String(error?.message || error)}`.slice(0, 300);
    console.error("[robinhood-v3] market stats refresh failed", { chainId: indexedPool.chainId, campaign: indexedPool.campaignAddress, error: passHealth.lastStatsError });
  }
}

async function refreshNormalizedMarketValuation(provider: ethers.Provider, indexedPool: IndexedPool, blockTag?: number): Promise<void> {
  try {
    await refreshNormalizedMarketValuationInner(provider, indexedPool, blockTag);
    passHealth.lastStatsError = null;
    passHealth.lastStatsWriteAt = new Date().toISOString();
  } catch (error: any) {
    // This also writes market_stats. Unguarded it aborted the whole pool scan,
    // so lastPoolCount never advanced and the cause never reached /health.
    passHealth.lastStatsError = `valuation:${String(error?.message || error)}`.slice(0, 300);
    console.error("[robinhood-v3] market valuation write failed", { chainId: indexedPool.chainId, campaign: indexedPool.campaignAddress, error: passHealth.lastStatsError });
  }
}

async function refreshNormalizedMarketValuationInner(provider: ethers.Provider, indexedPool: IndexedPool, blockTag?: number): Promise<void> {
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

async function insertSwap(provider: ethers.JsonRpcProvider,indexedPool: IndexedPool,log: ethers.Log,parsed: ethers.LogDescription,normalized: NormalizedSwap): Promise<boolean> {
  if (normalized.baseAmountRaw <= 0n || normalized.quoteAmountRaw <= 0n) return false;
  const descriptor = buildDescriptor(indexedPool);
  const execution = formatPairExecution({
    descriptor,
    swap: { side: normalized.side, baseAmountRaw: normalized.baseAmountRaw, quoteAmountRaw: normalized.quoteAmountRaw },
  });
  const sqrtPriceX96 = (() => {
    try {
      const value = (parsed?.args as any)?.sqrtPriceX96;
      return value == null ? 0n : BigInt(value);
    } catch {
      return 0n;
    }
  })();
  const spotQuote =
    spotQuotePerBase(
      sqrtPriceX96,
      indexedPool.token0Address,
      indexedPool.baseTokenAddress,
      indexedPool.baseDecimals,
      indexedPool.quoteDecimals,
    ) || execution.priceQuote;

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

  // Price before this swap, so the candle has a body running from the previous
  // price to the new one. Writing one price into o/h/l/c drew flat ticks with no
  // body at all. dex_pools.price_quote still holds the previous swap's spot here,
  // because this row is only updated further down.
  const openQuote = await (async () => {
    try {
      const previous = await pool.query(
        `select dp.price_quote, cms.initial_dex_price_bnb
           from public.dex_pools dp
           left join public.campaign_market_state cms
             on cms.chain_id=dp.chain_id and lower(cms.campaign_address)=lower(dp.campaign_address)
          where dp.chain_id=$1 and dp.pair_address=$2
          limit 1`,
        [indexedPool.chainId, indexedPool.pairAddress],
      );
      const row = previous.rows[0] || {};
      for (const candidate of [row.price_quote, row.initial_dex_price_bnb]) {
        const value = Number(candidate);
        if (Number.isFinite(value) && value > 0) return String(candidate);
      }
    } catch {
      // fall through to a flat candle
    }
    // First swap with no prior price: open at the close so the bar is flat rather
    // than spanning from zero.
    return spotQuote;
  })();

  // Null mcap makes the chart fall back to fills, which on a thin pool sit far
  // above the market cap the header reports from spot.
  const supplyWhole = await postBurnSupplyWhole(indexedPool.chainId, indexedPool.campaignAddress, indexedPool.baseDecimals);
  const mcapNative = (() => {
    if (!(supplyWhole > 0)) return null;
    const spot = Number(spotQuote);
    if (!Number.isFinite(spot) || spot <= 0) return null;
    const value = spot * supplyWhole;
    return Number.isFinite(value) && value > 0 ? value.toFixed(18) : null;
  })();

  const openMcapNative = (() => {
    if (!(supplyWhole > 0)) return null;
    const open = Number(openQuote);
    if (!Number.isFinite(open) || open <= 0) return null;
    const value = open * supplyWhole;
    return Number.isFinite(value) && value > 0 ? value.toFixed(18) : null;
  })();

  await upsertCandle({
    indexedPool,
    openQuote,
    mcapNative,
    openMcapNative,
    blockTime,
    blockNumber: log.blockNumber,
    logIndex,
    priceQuote: spotQuote,
    quoteAmountRaw: normalized.quoteAmountRaw,
    priceUsd: tradeValuationHealthy ? tradeValuation.priceUsd : null,
    volumeUsd: tradeValuationHealthy ? tradeValuation.volumeUsd : null,
    reference,
  });
  try {
    await updateMarketStats(indexedPool, spotQuote, execution.quoteAmount, normalized.side, log.blockNumber, blockTime);
    passHealth.lastStatsError = null;
    passHealth.lastStatsWriteAt = new Date().toISOString();
  } catch (error: any) {
    // market_stats is what the header, market cap and timeframe tiles read. A
    // silent failure here leaves the page recomputing everything from trades.
    passHealth.lastStatsError = `updateMarketStats:${String(error?.message || error)}`.slice(0, 300);
    console.error("[robinhood-v3] market stats write failed", { chainId: indexedPool.chainId, campaign: indexedPool.campaignAddress, error: passHealth.lastStatsError });
  }
  try {
    const present = await pool.query(
      `select 1 from public.market_stats where chain_id=$1 and campaign_address=$2 limit 1`,
      [indexedPool.chainId, indexedPool.campaignAddress],
    );
    passHealth.marketStatsRowPresent = (present.rowCount ?? 0) > 0;
  } catch { /* diagnostics only */ }
  await pool.query(
    `update public.dex_pools
        set price_quote=$3,
            quote_volume_24h=(select coalesce(sum(quote_amount),0) from public.dex_trades where chain_id=$1 and pair_address=$2 and status='confirmed' and block_time>=now()-interval '24 hours'),
            updated_at=now()
      where chain_id=$1 and pair_address=$2`,
    [indexedPool.chainId,indexedPool.pairAddress,spotQuote],
  );

  try {
    await refreshRobinhoodMarketStats(provider, indexedPool);
  } catch (error: any) {
    console.warn("[robinhood-v3] market stats refresh failed", error?.message || String(error));
  }
  await publishMarketStatsPatch(indexedPool);
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
    spotPriceQuote:spotQuote,
    spotPriceBnb:isNativeQuote ? spotQuote : null,
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
    await refreshRobinhoodMarketStatsSafely(provider, indexedPool);
    return 0;
  }
  let inserted = 0;
  const maxChunk = Math.max(500, Number(ENV.ROBINHOOD_V3_LOG_CHUNK_SIZE || 50_000));
  const minChunk = Math.max(50, Number(ENV.LOG_CHUNK_SIZE || 500));
  let chunk = maxChunk;
  let cursor = from;
  let lastSwapAt: Date | null = null;
  while (cursor <= head) {
    let to = Math.min(head, cursor + chunk - 1);
    let logs: ethers.Log[];
    // Providers advertise different range limits. Narrow on rejection rather
    // than crawling every pool at the smallest window that any provider needs.
    for (;;) {
      try {
        logs = await provider.getLogs({ address: indexedPool.pairAddress, topics: [[MOCK_SWAP_TOPIC, CANONICAL_SWAP_TOPIC]], fromBlock: cursor, toBlock: to });
        break;
      } catch (error: any) {
        if (chunk <= minChunk) throw error;
        chunk = Math.max(minChunk, Math.floor(chunk / 4));
        to = Math.min(head, cursor + chunk - 1);
        console.warn("[robinhood-v3] narrowing log window", { chainId: indexedPool.chainId, chunk, error: String(error?.shortMessage || error?.message || error).slice(0, 120) });
      }
    }
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
  await refreshRobinhoodMarketStatsSafely(provider, indexedPool);
  return inserted;
}

type RobinhoodV3PassHealth = {
  loopStarted: boolean;
  lastPassAt: string | null;
  lastPassChainId: number | null;
  lastCandidateCount: number | null;
  lastPoolCount: number | null;
  lastError: string | null;
  lastPublishAt: string | null;
  lastPublishError: string | null;
  lastRebuiltCampaign: string | null;
  lastRebuildError: string | null;
  /** Sticky: cleared only by a successful write, never by the next pass. */
  lastStatsError: string | null;
  lastStatsWriteAt: string | null;
  marketStatsRowPresent: boolean | null;
  swapRouterConfigured: Record<number, boolean>;
};

const passHealth: RobinhoodV3PassHealth = {
  loopStarted: false,
  lastPassAt: null,
  lastPassChainId: null,
  lastCandidateCount: null,
  lastPoolCount: null,
  lastError: null,
  lastPublishAt: null,
  lastPublishError: null,
  lastRebuiltCampaign: null,
  lastRebuildError: null,
  lastStatsError: null,
  lastStatsWriteAt: null,
  marketStatsRowPresent: null,
  swapRouterConfigured: {},
};

/** Read-only pass state for /health: a silent loop must be tellable from a failing one. */
export function robinhoodV3PublicHealth(): RobinhoodV3PassHealth {
  return {
    ...passHealth,
    swapRouterConfigured: Object.fromEntries(
      chainConfigs().map((config) => [config.chainId, Boolean(config.swapRouterAddress)]),
    ),
  };
}


/**
 * One-shot rebuild of post-graduation candles.
 *
 * Candles written before the spot-price fix stored each swap's execution price,
 * which on a thin pool sits far above the pool price, so historical buckets keep
 * their spikes until the swaps are re-ingested. Clearing the indexed swaps and
 * rewinding the pool cursor makes the normal pass rewrite them from chain.
 *
 * Bonding buckets are left alone: only candles at or after graduation are dropped.
 */
async function rebuildPostGradCandles(chainId: number): Promise<void> {
  const requested = ENV.ROBINHOOD_V3_CANDLE_REBUILD;
  if (!requested) return;
  const all = requested.toLowerCase() === "all";
  const wanted = new Set(
    requested.split(",").map((value) => value.trim().toLowerCase()).filter((value) => /^0x[a-f0-9]{40}$/.test(value)),
  );
  if (!all && wanted.size === 0) return;

  const pools = await pool.query(
    `select dp.campaign_address, dp.pair_address, dp.graduation_block, cms.graduation_time
       from public.dex_pools dp
       left join public.campaign_market_state cms
         on cms.chain_id=dp.chain_id and lower(cms.campaign_address)=lower(dp.campaign_address)
      where dp.chain_id=$1`,
    [chainId],
  );

  for (const row of pools.rows) {
    const campaignAddress = lowerAddress(row.campaign_address);
    if (!campaignAddress) continue;
    if (!all && !wanted.has(campaignAddress)) continue;
    try {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(`delete from public.dex_trades where chain_id=$1 and campaign_address=$2`, [chainId, campaignAddress]);
        if (row.graduation_time) {
          await client.query(
            `delete from public.token_candles where chain_id=$1 and campaign_address=$2 and bucket_start>=$3`,
            [chainId, campaignAddress, row.graduation_time],
          );
        }
        const from = Math.max(0, Number(row.graduation_block || 0));
        await client.query(
          `update public.dex_pools set last_indexed_block=$3,last_finalized_block=$3,updated_at=now()
            where chain_id=$1 and pair_address=$2`,
          [chainId, lowerAddress(row.pair_address), from],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      console.log("[robinhood-v3] candle rebuild armed", { chainId, campaignAddress, fromBlock: Number(row.graduation_block || 0) });
      passHealth.lastRebuiltCampaign = campaignAddress;
    } catch (error: any) {
      console.error("[robinhood-v3] candle rebuild failed", { chainId, campaignAddress, error: error?.message || String(error) });
      passHealth.lastRebuildError = String(error?.message || error).slice(0, 200);
    }
  }
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
    passHealth.lastError = null;
    await discoverPools(provider, config);
    // discoverPools records per-pool failures; completing the pass must not
    // erase them or a degraded pool looks like a healthy one.
    const discoveryError = passHealth.lastError;
    const head = Math.max(0, selected.headBlock - Math.max(0, ENV.CONFIRMATIONS));
    const pools = await listPools(config.chainId);
    let swaps = 0;
    for (const indexedPool of pools) swaps += await scanPool(provider, indexedPool, head);
    passHealth.lastPassAt = new Date().toISOString();
    passHealth.lastPassChainId = config.chainId;
    passHealth.lastPoolCount = pools.length;
    passHealth.lastError = discoveryError;
    if (pools.length || swaps) console.log("[robinhood-v3] pass", { chainId: config.chainId, head, pools: pools.length, swaps, rpc: maskRpcUrl(selected.url) });
  } finally {
    provider.destroy();
  }
}

async function loop(): Promise<void> {
  const intervalMs = Math.max(2_000, ENV.ROBINHOOD_V3_POOL_INDEXER_INTERVAL_MS);
  let rebuilt = false;
  while (true) {
    const configs = chainConfigs();
    if (!rebuilt) {
      rebuilt = true;
      for (const config of configs) {
        try { await rebuildPostGradCandles(config.chainId); }
        catch (error: any) { console.error("[robinhood-v3] rebuild pass failed", { chainId: config.chainId, error: error?.message || String(error) }); }
      }
    }
    for (const config of configs) {
      try { await runChain(config); }
      catch (error: any) {
        passHealth.lastPassAt = new Date().toISOString();
        passHealth.lastPassChainId = config.chainId;
        passHealth.lastError = String(error?.shortMessage || error?.message || error).slice(0, 300);
        console.error("[robinhood-v3] pass failed", { chainId: config.chainId, rpcs: config.rpcUrls.map(maskRpcUrl), error: passHealth.lastError });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function startRobinhoodV3PoolIndexerLoop(): void {
  if (!enabled()) return;
  if (globalState[LOOP_SYMBOL]) return;
  globalState[LOOP_SYMBOL] = true;
  passHealth.loopStarted = true;
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
