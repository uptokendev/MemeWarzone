import { queueCandleMessage } from "./ably.js";
import { pool } from "./db.js";

const LOOP_SYMBOL = Symbol.for("memewarzone.canonicalCandleRealtimeStarted");
const globalState = globalThis as any;
const DEFAULT_POLL_MS = 250;
const DEFAULT_BATCH_SIZE = 500;

type Cursor = {
  updatedAt: string;
  chainId: number;
  campaignAddress: string;
  timeframe: string;
  bucketStart: string;
};

function enabled(): boolean {
  // Launch-safe rollout: explicitly opt in after shadow/acceptance testing.
  return String(process.env.ENABLE_CANONICAL_CANDLE_REALTIME ?? "0").trim() === "1";
}

function pollMs(): number {
  const parsed = Number(process.env.CANONICAL_CANDLE_REALTIME_POLL_MS || DEFAULT_POLL_MS);
  return Number.isFinite(parsed) ? Math.max(100, Math.min(5_000, Math.trunc(parsed))) : DEFAULT_POLL_MS;
}

function batchSize(): number {
  const parsed = Number(process.env.CANONICAL_CANDLE_REALTIME_BATCH_SIZE || DEFAULT_BATCH_SIZE);
  return Number.isFinite(parsed) ? Math.max(10, Math.min(5_000, Math.trunc(parsed))) : DEFAULT_BATCH_SIZE;
}

function nextCursor(row: any): Cursor {
  return {
    updatedAt: new Date(row.effective_updated_at).toISOString(),
    chainId: Number(row.chain_id),
    campaignAddress: String(row.campaign_address || ""),
    timeframe: String(row.timeframe || ""),
    bucketStart: new Date(row.bucket_start).toISOString(),
  };
}

async function initialCursor(): Promise<Cursor> {
  const result = await pool.query(`select now() as updated_at`);
  const updatedAt = new Date(result.rows[0]?.updated_at || Date.now()).toISOString();
  return {
    updatedAt,
    chainId: 0,
    campaignAddress: "",
    timeframe: "",
    bucketStart: new Date(0).toISOString(),
  };
}

async function readChangedCandles(cursor: Cursor) {
  return pool.query(
    `select
       chain_id,
       campaign_address,
       timeframe,
       bucket_start,
       o,h,l,c,
       price_o,price_h,price_l,price_c,
       mcap_o,mcap_h,mcap_l,mcap_c,
       canonical_version,
       volume_bnb,
       trades_count,
       coalesce(source_mask, 1) as source_mask,
       coalesce(bonding_trade_count, trades_count, 0) as bonding_trade_count,
       coalesce(dex_trade_count, 0) as dex_trade_count,
       coalesce(bonding_volume_bnb, volume_bnb, 0) as bonding_volume_bnb,
       coalesce(dex_volume_bnb, 0) as dex_volume_bnb,
       last_block_number,
       last_log_index,
       greatest(updated_at,coalesce(canonical_updated_at,updated_at)) as effective_updated_at
     from public.token_candles
     where
       greatest(updated_at,coalesce(canonical_updated_at,updated_at)) > $1::timestamptz
       or (
         greatest(updated_at,coalesce(canonical_updated_at,updated_at)) = $1::timestamptz
         and (chain_id, campaign_address, timeframe, bucket_start) > ($2,$3,$4,$5::timestamptz)
       )
     order by effective_updated_at asc, chain_id asc, campaign_address asc, timeframe asc, bucket_start asc
     limit $6`,
    [
      cursor.updatedAt,
      cursor.chainId,
      cursor.campaignAddress,
      cursor.timeframe,
      cursor.bucketStart,
      batchSize(),
    ],
  );
}

async function publishRow(row: any) {
  const chainId = Number(row.chain_id);
  const campaignAddress = String(row.campaign_address || "");
  const resolution = String(row.timeframe || "");
  const bucketStart = new Date(row.bucket_start).toISOString();

  queueCandleMessage(chainId, campaignAddress, "market_candle_upsert", resolution, new Date(bucketStart).getTime(), {
    type: "market_candle_upsert",
    chainId,
    campaignAddress,
    resolution,
    bucketStart,
    open: String(row.o),
    high: String(row.h),
    low: String(row.l),
    close: String(row.c),
    priceOpen: row.price_o == null ? null : String(row.price_o),
    priceHigh: row.price_h == null ? null : String(row.price_h),
    priceLow: row.price_l == null ? null : String(row.price_l),
    priceClose: row.price_c == null ? null : String(row.price_c),
    marketCapOpen: row.mcap_o == null ? null : String(row.mcap_o),
    marketCapHigh: row.mcap_h == null ? null : String(row.mcap_h),
    marketCapLow: row.mcap_l == null ? null : String(row.mcap_l),
    marketCapClose: row.mcap_c == null ? null : String(row.mcap_c),
    canonicalVersion: row.canonical_version == null ? null : Number(row.canonical_version),
    volumeBnb: String(row.volume_bnb ?? 0),
    tradesCount: Number(row.trades_count || 0),
    sourceMask: Number(row.source_mask || 0),
    bondingTradeCount: Number(row.bonding_trade_count || 0),
    dexTradeCount: Number(row.dex_trade_count || 0),
    bondingVolumeBnb: String(row.bonding_volume_bnb ?? 0),
    dexVolumeBnb: String(row.dex_volume_bnb ?? 0),
    lastBlockNumber: row.last_block_number == null ? null : Number(row.last_block_number),
    lastLogIndex: row.last_log_index == null ? null : Number(row.last_log_index),
  });
}

export async function runCanonicalCandleRealtimeOnce(cursor: Cursor): Promise<Cursor> {
  const result = await readChangedCandles(cursor);
  let next = cursor;
  for (const row of result.rows) {
    next = nextCursor(row);
    try {
      await publishRow(row);
    } catch (error) {
      console.warn("[canonical-candles] realtime publish failed", {
        chainId: row.chain_id,
        campaign: row.campaign_address,
        timeframe: row.timeframe,
        bucketStart: row.bucket_start,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return next;
}

export function startCanonicalCandleRealtimeLoop() {
  if (!enabled()) {
    console.log("[canonical-candles] realtime publisher disabled; set ENABLE_CANONICAL_CANDLE_REALTIME=1 after acceptance");
    return;
  }
  if (globalState[LOOP_SYMBOL]) return;
  globalState[LOOP_SYMBOL] = true;

  void (async () => {
    let cursor = await initialCursor();
    console.log("[canonical-candles] full OHLC realtime publisher started", { pollMs: pollMs() });

    for (;;) {
      try {
        cursor = await runCanonicalCandleRealtimeOnce(cursor);
      } catch (error) {
        console.warn(
          "[canonical-candles] poll failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs()));
    }
  })().catch((error) => {
    globalState[LOOP_SYMBOL] = false;
    console.error(
      "[canonical-candles] realtime loop stopped",
      error instanceof Error ? error.message : String(error),
    );
  });
}
