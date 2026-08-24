import { ethers } from "ethers";
import { pool } from "./db.js";
import { ENV } from "./env.js";
import { createWorkingProvider, parseRpcList } from "./rpcProvider.js";
import { TIMEFRAMES, bucketStart, type TF } from "./timeframes.js";
import { BNB_WAD, bnbCurveState } from "./bnbCurvePricing.js";
import { bondingCandleConflictSetSql } from "./canonicalCandleRebuild.js";

const LOOP_SYMBOL = Symbol.for("memewarzone.canonicalCandleMaterializerStarted");
const globalState = globalThis as any;
const VERSION = 4;
const WAD = BNB_WAD;
const LAMPORTS_PER_SOL = 1_000_000_000;
const DEFAULT_SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const DEFAULT_SOLANA_PROGRAM = "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt";

const BNB_CURVE_ABI = [
  "function basePrice() view returns (uint256)",
  "function priceSlope() view returns (uint256)",
  "function sold() view returns (uint256)",
];

type TradeRow = {
  chain_id: number;
  campaign_address: string;
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_time: Date | string;
  side: string;
  token_amount_raw: string;
  bnb_amount: string | number | null;
  sold_tokens_after_raw: string | number | null;
};

type CurveState = {
  soldRaw: bigint;
  spotNative: number;
  mcapNative: number;
};

type CanonicalBucket = {
  timeframe: TF;
  bucketStartSec: number;
  priceOpen: number;
  priceHigh: number;
  priceLow: number;
  priceClose: number;
  mcapOpen: number;
  mcapHigh: number;
  mcapLow: number;
  mcapClose: number;
  volumeNative: number;
  tradesCount: number;
  lastBlockNumber: number;
  lastLogIndex: number;
};

type SpotCalculator = (soldRaw: bigint) => CurveState;

type SpotModel = {
  calculate: SpotCalculator;
  currentSoldRaw: bigint | null;
};

function enabled(): boolean {
  return String(process.env.ENABLE_CANONICAL_CANDLE_MATERIALIZER ?? "1").trim() !== "0";
}

function pollMs(): number {
  const parsed = Number(process.env.CANONICAL_CANDLE_MATERIALIZER_POLL_MS || 2_000);
  return Number.isFinite(parsed) ? Math.max(500, Math.min(60_000, Math.trunc(parsed))) : 2_000;
}

function campaignBatchSize(): number {
  const parsed = Number(process.env.CANONICAL_CANDLE_MATERIALIZER_BATCH_SIZE || 8);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(50, Math.trunc(parsed))) : 8;
}

function toBigInt(value: unknown): bigint {
  try {
    return BigInt(String(value ?? "0"));
  } catch {
    return 0n;
  }
}

function toFiniteNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pow10(decimals: number): bigint {
  return 10n ** BigInt(Math.max(0, Math.trunc(decimals)));
}

function bigintRatio(value: bigint, denominator: bigint): number {
  if (denominator <= 0n) return 0;
  const whole = value / denominator;
  const remainder = value % denominator;
  return Number(whole) + Number(remainder) / Number(denominator);
}

function bscRpcUrls(chainId: number): string[] {
  return parseRpcList(chainId === 56 ? ENV.BSC_RPC_HTTP_56 : ENV.BSC_RPC_HTTP_97);
}

const bscProviders = new Map<number, ethers.JsonRpcProvider>();

async function bscProvider(chainId: number): Promise<ethers.JsonRpcProvider> {
  const current = bscProviders.get(chainId);
  if (current) return current;
  const { provider } = await createWorkingProvider(bscRpcUrls(chainId), chainId, {
    timeoutMs: 8_000,
    label: `canonical-candles-${chainId}`,
  });
  bscProviders.set(chainId, provider);
  return provider;
}

async function bnbSpotCalculator(chainId: number, campaign: string): Promise<SpotModel> {
  const provider = await bscProvider(chainId);
  const contract = new ethers.Contract(campaign, BNB_CURVE_ABI, provider) as any;
  const [basePriceRaw, priceSlopeRaw, currentSoldRaw] = await Promise.all([
    contract.basePrice() as Promise<bigint>,
    contract.priceSlope() as Promise<bigint>,
    contract.sold() as Promise<bigint>,
  ]);

  const calculate: SpotCalculator = (soldRaw: bigint) => {
    const state = bnbCurveState(basePriceRaw, priceSlopeRaw, soldRaw);
    return {
      soldRaw: state.soldRaw,
      spotNative: state.spotNative,
      mcapNative: state.mcapNative,
    };
  };

  return { calculate, currentSoldRaw };
}

function readU64LE(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset);
}

function decodeSolanaCurve(data: Buffer): {
  economicsVersion: number;
  tokenDecimals: number;
  basePriceLamports: bigint;
  priceSlopeLamports: bigint;
} | null {
  if (data.length < 8 + 400) return null;
  let offset = 8;
  const skip = (bytes: number) => {
    offset += bytes;
  };

  skip(32 * 12);
  skip(8);
  skip(8);
  skip(8);
  skip(1);
  const economicsVersion = data.readUInt16LE(offset);
  offset += 2;
  skip(1);
  skip(8 * 4);
  const tokenDecimals = data.readUInt8(offset);
  offset += 1;
  skip(2);
  skip(2);
  const basePriceLamports = readU64LE(data, offset);
  offset += 8;
  const priceSlopeLamports = readU64LE(data, offset);

  return {
    economicsVersion,
    tokenDecimals,
    basePriceLamports,
    priceSlopeLamports,
  };
}

function solanaRpcUrls(): string[] {
  const configured = String(ENV.SOLANA_RPC_HTTP || process.env.SOLANA_RPC_URL || "").trim();
  return parseRpcList(configured || DEFAULT_SOLANA_RPC);
}

async function solanaRpc<T>(method: string, params: unknown[]): Promise<T> {
  let lastError: unknown;
  for (const url of solanaRpcUrls()) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`Solana RPC ${method} HTTP ${response.status}`);
      const body = await response.json() as { result?: T; error?: { message?: string } };
      if (body.error) throw new Error(body.error.message || `Solana RPC ${method} failed`);
      return body.result as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || `${method} failed`));
}

async function solanaSpotCalculator(campaign: string): Promise<SpotModel> {
  const info = await solanaRpc<{ value?: { data?: [string, string]; owner?: string } | null }>("getAccountInfo", [
    campaign,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  const encoded = info?.value?.data?.[0];
  if (!encoded) throw new Error(`Solana campaign account not found: ${campaign}`);
  const owner = String(info?.value?.owner || "");
  const expectedOwner = String(ENV.SOLANA_LAUNCHPAD_PROGRAM_ID || process.env.SOLANA_LAUNCHPAD_PROGRAM_ID || DEFAULT_SOLANA_PROGRAM).trim();
  if (owner && expectedOwner && owner !== expectedOwner) {
    throw new Error(`Unexpected Solana campaign owner for ${campaign}`);
  }

  const curve = decodeSolanaCurve(Buffer.from(encoded, "base64"));
  if (!curve) throw new Error(`Could not decode Solana curve parameters: ${campaign}`);
  const tokenUnits = pow10(curve.tokenDecimals);

  const calculate: SpotCalculator = (soldRaw: bigint) => {
    const safeSold = soldRaw > 0n ? soldRaw : 0n;
    const soldWhole = bigintRatio(safeSold, tokenUnits);
    const baseLamports = Number(curve.basePriceLamports);
    const slopeRaw = Number(curve.priceSlopeLamports);
    const slopeLamports = curve.economicsVersion >= 3
      ? (slopeRaw * soldWhole) / 1_000_000_000
      : slopeRaw * soldWhole;
    const spotNative = (baseLamports + slopeLamports) / LAMPORTS_PER_SOL;
    const safeSpotNative = Number.isFinite(spotNative) && spotNative > 0 ? spotNative : 0;
    return {
      soldRaw: safeSold,
      spotNative: safeSpotNative,
      mcapNative: safeSpotNative * soldWhole,
    };
  };

  return { calculate, currentSoldRaw: null };
}

async function spotCalculator(chainId: number, campaign: string): Promise<SpotModel> {
  if (chainId === 101) return solanaSpotCalculator(campaign);
  if (chainId === 56 || chainId === 97) return bnbSpotCalculator(chainId, campaign);
  throw new Error(`Unsupported canonical candle chain ${chainId}`);
}

function bucketKey(tf: TF, bucketStartSec: number): string {
  return `${tf}:${bucketStartSec}`;
}

function addTradeToBuckets(
  buckets: Map<string, CanonicalBucket>,
  trade: TradeRow,
  pre: CurveState,
  post: CurveState,
) {
  const timestampSec = Math.floor(new Date(trade.block_time).getTime() / 1000);
  if (!Number.isFinite(timestampSec) || timestampSec <= 0) return;
  const volumeNative = Math.max(0, toFiniteNumber(trade.bnb_amount));
  const blockNumber = Number(trade.block_number || 0);
  const logIndex = Number(trade.log_index || 0);

  for (const tf of TIMEFRAMES) {
    const start = bucketStart(timestampSec, tf);
    const key = bucketKey(tf, start);
    const current = buckets.get(key);
    if (!current) {
      buckets.set(key, {
        timeframe: tf,
        bucketStartSec: start,
        priceOpen: pre.spotNative,
        priceHigh: Math.max(pre.spotNative, post.spotNative),
        priceLow: Math.min(pre.spotNative, post.spotNative),
        priceClose: post.spotNative,
        mcapOpen: pre.mcapNative,
        mcapHigh: Math.max(pre.mcapNative, post.mcapNative),
        mcapLow: Math.min(pre.mcapNative, post.mcapNative),
        mcapClose: post.mcapNative,
        volumeNative,
        tradesCount: 1,
        lastBlockNumber: blockNumber,
        lastLogIndex: logIndex,
      });
      continue;
    }

    current.priceHigh = Math.max(current.priceHigh, pre.spotNative, post.spotNative);
    current.priceLow = Math.min(current.priceLow, pre.spotNative, post.spotNative);
    current.priceClose = post.spotNative;
    current.mcapHigh = Math.max(current.mcapHigh, pre.mcapNative, post.mcapNative);
    current.mcapLow = Math.min(current.mcapLow, pre.mcapNative, post.mcapNative);
    current.mcapClose = post.mcapNative;
    current.volumeNative += volumeNative;
    current.tradesCount += 1;
    current.lastBlockNumber = blockNumber;
    current.lastLogIndex = logIndex;
  }
}

async function campaignTrades(chainId: number, campaign: string): Promise<TradeRow[]> {
  const result = await pool.query(
    `select chain_id,campaign_address,tx_hash,log_index,block_number,block_time,side,
            token_amount_raw,bnb_amount,sold_tokens_after_raw
       from public.curve_trades
      where chain_id=$1 and campaign_address=$2
        and (chain_id <> 101 or sold_tokens_after_raw is not null)
      order by block_number asc, log_index asc`,
    [chainId, campaign],
  );
  return result.rows as TradeRow[];
}

function indexedNetSold(trades: TradeRow[]): bigint {
  let net = 0n;
  for (const trade of trades) {
    const amount = toBigInt(trade.token_amount_raw);
    net += String(trade.side || "").toLowerCase() === "sell" ? -amount : amount;
  }
  return net;
}

function deriveBuckets(
  chainId: number,
  trades: TradeRow[],
  calculate: SpotCalculator,
  currentSoldRaw: bigint | null = null,
): Map<string, CanonicalBucket> {
  const buckets = new Map<string, CanonicalBucket>();
  let reconstructedSold = 0n;

  // Older BNB campaigns can have valid trades before the durable trade mirror began.
  // Anchor the reconstructed history to the live contract sold() state so the latest
  // canonical close uses the exact same circulating-supply basis as TokenDetails.
  if ((chainId === 56 || chainId === 97) && currentSoldRaw != null && currentSoldRaw >= 0n) {
    const inferredOpeningSold = currentSoldRaw - indexedNetSold(trades);
    if (inferredOpeningSold > 0n) reconstructedSold = inferredOpeningSold;
  }

  for (const trade of trades) {
    const amount = toBigInt(trade.token_amount_raw);
    const side = String(trade.side || "").toLowerCase();
    let postSold: bigint;

    if (chainId === 101 && trade.sold_tokens_after_raw != null) {
      postSold = toBigInt(trade.sold_tokens_after_raw);
    } else if (side === "sell") {
      postSold = reconstructedSold > amount ? reconstructedSold - amount : 0n;
    } else {
      postSold = reconstructedSold + amount;
    }

    const preSold = side === "sell" ? postSold + amount : postSold > amount ? postSold - amount : 0n;
    const pre = calculate(preSold);
    const post = calculate(postSold);
    addTradeToBuckets(buckets, trade, pre, post);
    reconstructedSold = postSold;
  }

  return buckets;
}

async function writeBucket(chainId: number, campaign: string, candle: CanonicalBucket) {
  const bucketTime = new Date(candle.bucketStartSec * 1000);
  await pool.query(
    `insert into public.token_candles(
       chain_id,campaign_address,timeframe,bucket_start,
       o,h,l,c,volume_bnb,trades_count,
       source_mask,bonding_trade_count,dex_trade_count,bonding_volume_bnb,dex_volume_bnb,
       last_block_number,last_log_index,
       price_o,price_h,price_l,price_c,
       mcap_o,mcap_h,mcap_l,mcap_c,
       canonical_version,canonical_updated_at,updated_at
     ) values(
       $1,$2,$3,$4,
       $5,$6,$7,$8,$9,$10,
       1,$10,0,$9,0,
       $11,$12,
       $5,$6,$7,$8,
       $13,$14,$15,$16,
       $17,now(),now()
     )
     on conflict(chain_id,campaign_address,timeframe,bucket_start) do update set
       ${bondingCandleConflictSetSql()}
     where coalesce(public.token_candles.dex_trade_count,0)=0`,
    [
      chainId,
      campaign,
      candle.timeframe,
      bucketTime,
      candle.priceOpen,
      candle.priceHigh,
      candle.priceLow,
      candle.priceClose,
      candle.volumeNative,
      candle.tradesCount,
      candle.lastBlockNumber,
      candle.lastLogIndex,
      candle.mcapOpen,
      candle.mcapHigh,
      candle.mcapLow,
      candle.mcapClose,
      VERSION,
    ],
  );
}

export async function materializeCanonicalCandles(chainId: number, campaign: string) {
  const normalizedCampaign = chainId === 101 ? String(campaign).trim() : String(campaign).trim().toLowerCase();
  const trades = await campaignTrades(chainId, normalizedCampaign);
  if (!trades.length) return { chainId, campaign: normalizedCampaign, trades: 0, candles: 0 };

  const model = await spotCalculator(chainId, normalizedCampaign);
  const buckets = deriveBuckets(chainId, trades, model.calculate, model.currentSoldRaw);
  for (const candle of buckets.values()) {
    await writeBucket(chainId, normalizedCampaign, candle);
  }

  return {
    chainId,
    campaign: normalizedCampaign,
    trades: trades.length,
    candles: buckets.size,
  };
}

async function staleCampaigns() {
  return pool.query(
    `select t.chain_id,t.campaign_address,max(t.block_time) as last_trade_at,
            max(tc.canonical_updated_at) as last_canonical_at
       from public.curve_trades t
       left join public.token_candles tc
         on tc.chain_id=t.chain_id and tc.campaign_address=t.campaign_address
      where t.chain_id in (56,97,101)
        and (t.chain_id <> 101 or t.sold_tokens_after_raw is not null)
      group by t.chain_id,t.campaign_address
      having max(tc.canonical_updated_at) is null
          or max(tc.canonical_updated_at) < max(t.block_time)
          or bool_or(
            coalesce(tc.dex_trade_count,0)=0
            and coalesce(tc.canonical_version,0) < $2
          )
      order by max(t.block_time) asc
      limit $1`,
    [campaignBatchSize(), VERSION],
  );
}

export async function runCanonicalCandleMaterializerOnce() {
  const candidates = await staleCampaigns();
  const results: Array<Record<string, unknown>> = [];
  for (const row of candidates.rows) {
    try {
      results.push(await materializeCanonicalCandles(Number(row.chain_id), String(row.campaign_address)));
    } catch (error) {
      console.warn("[canonical-candles] materialization failed", {
        chainId: row.chain_id,
        campaign: row.campaign_address,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export function startCanonicalCandleMaterializerLoop() {
  if (!enabled()) {
    console.log("[canonical-candles] materializer disabled");
    return;
  }
  if (globalState[LOOP_SYMBOL]) return;
  globalState[LOOP_SYMBOL] = true;

  void (async () => {
    console.log("[canonical-candles] materializer started", { pollMs: pollMs(), version: VERSION });
    for (;;) {
      try {
        await runCanonicalCandleMaterializerOnce();
      } catch (error) {
        console.warn("[canonical-candles] materializer poll failed", error instanceof Error ? error.message : String(error));
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs()));
    }
  })().catch((error) => {
    globalState[LOOP_SYMBOL] = false;
    console.error("[canonical-candles] materializer stopped", error instanceof Error ? error.message : String(error));
  });
}
