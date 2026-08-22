import { BorshCoder, EventParser, type Idl } from "@coral-xyz/anchor";
import { CpAmmIdl } from "@meteora-ag/cp-amm-sdk";
import { PublicKey } from "@solana/web3.js";

import { publishCandle, publishStats, publishTrade } from "./ably.js";
import { pool } from "./db.js";
import { ENV } from "./env.js";
import { createLeagueFeedPublisher } from "./leagueFeed.js";
import { TIMEFRAMES, bucketStart, type TF } from "./timeframes.js";

const SOLANA_CHAIN_ID = 101;
const leagueFeed = createLeagueFeedPublisher({ pool, flushMs: 500 });
leagueFeed.start();
const DEFAULT_SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const METEORA_CP_AMM_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const NATIVE_MINT = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL = 1_000_000_000;
const METEORA_POOL_TOKEN_A_MINT_OFFSET = 168;
const METEORA_POOL_TOKEN_B_MINT_OFFSET = 200;
const METEORA_POOL_MIN_LEN = 232;

const meteoraEventParser = new EventParser(
  METEORA_CP_AMM_PROGRAM_ID,
  new BorshCoder(CpAmmIdl as unknown as Idl),
);

type GraduatedMarket = {
  campaign: string;
  token: string;
  pool: string;
  graduationSlot: number;
};

type RpcSignature = {
  signature: string;
  slot: number;
  err: unknown;
  blockTime?: number | null;
};

type ParsedAccountKey = string | { pubkey?: string; signer?: boolean; writable?: boolean };

type RpcTransaction = {
  slot: number;
  blockTime?: number | null;
  meta?: { logMessages?: string[] | null } | null;
  transaction?: { message?: { accountKeys?: ParsedAccountKey[] | null } | null } | null;
} | null;

type MeteoraSwap = {
  tradeDirection: number;
  amountInRaw: bigint;
  amountOutRaw: bigint;
  protocolFeeRaw: bigint;
  claimingFeeRaw: bigint;
  compoundingFeeRaw: bigint;
  referralFeeRaw: bigint;
  currentTimestamp: bigint;
};

type PoolPair = { tokenA: string; tokenB: string; tokenDecimals: number };

function parseRpcList(value: string): string[] {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function solanaRpcUrls(): string[] {
  const configured = String(ENV.SOLANA_RPC_HTTP || process.env.SOLANA_RPC_URL || "").trim();
  return parseRpcList(configured || DEFAULT_SOLANA_RPC);
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  let lastError: unknown;
  for (const url of solanaRpcUrls()) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!response.ok) throw new Error(`Solana RPC ${method} HTTP ${response.status}`);
      const payload = (await response.json()) as { result?: T; error?: { message?: string } };
      if (payload.error) throw new Error(payload.error.message || `Solana RPC ${method} failed`);
      return payload.result as T;
    } catch (error) {
      lastError = error;
      console.warn("[meteora-indexer] RPC endpoint failed", {
        method,
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || `Solana RPC ${method} failed`));
}

function bigintValue(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string") return BigInt(value);
  if (value && typeof value === "object" && "toString" in value) return BigInt(String(value));
  return 0n;
}

function numberValue(value: unknown): number {
  const n = Number(value && typeof value === "object" && "toString" in value ? String(value) : value);
  return Number.isFinite(n) ? n : 0;
}

function timestampFrom(blockTime: number | null | undefined): Date {
  return new Date(Number(blockTime || Math.floor(Date.now() / 1000)) * 1000);
}

function txWallet(tx: RpcTransaction): string {
  const keys = tx?.transaction?.message?.accountKeys || [];
  for (const entry of keys) {
    if (typeof entry === "object" && entry?.signer && entry.pubkey) return String(entry.pubkey);
  }
  const first = keys[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && first.pubkey) return String(first.pubkey);
  return METEORA_CP_AMM_PROGRAM_ID.toBase58();
}

function decodeSwapEvents(logs: string[] | null | undefined): MeteoraSwap[] {
  if (!logs?.length) return [];
  const swaps: MeteoraSwap[] = [];
  try {
    for (const parsed of meteoraEventParser.parseLogs(logs)) {
      const normalized = String(parsed.name || "").replace(/_/g, "").toLowerCase();
      if (normalized !== "evtswap2") continue;
      const data = parsed.data as Record<string, any>;
      const result = (data.swapResult || data.swap_result || {}) as Record<string, any>;
      swaps.push({
        tradeDirection: numberValue(data.tradeDirection ?? data.trade_direction),
        amountInRaw: bigintValue(data.includedTransferFeeAmountIn ?? data.included_transfer_fee_amount_in),
        amountOutRaw: bigintValue(data.excludedTransferFeeAmountOut ?? data.excluded_transfer_fee_amount_out),
        protocolFeeRaw: bigintValue(result.protocolFee ?? result.protocol_fee),
        claimingFeeRaw: bigintValue(result.claimingFee ?? result.claiming_fee),
        compoundingFeeRaw: bigintValue(result.compoundingFee ?? result.compounding_fee),
        referralFeeRaw: bigintValue(result.referralFee ?? result.referral_fee),
        currentTimestamp: bigintValue(data.currentTimestamp ?? data.current_timestamp),
      });
    }
  } catch (error) {
    console.warn("[meteora-indexer] failed to parse DAMM v2 events", error instanceof Error ? error.message : String(error));
  }
  return swaps;
}

async function loadGraduatedMarkets(): Promise<GraduatedMarket[]> {
  const limit = Math.max(1, Math.min(250, Number(process.env.SOLANA_METEORA_POOL_LIMIT || 50)));
  const result = await pool.query(
    `select
       campaign_address,
       token_address,
       meta #>> '{solanaGraduation,pool}' as pool_address,
       coalesce(nullif(meta #>> '{solanaGraduation,slot}','')::bigint,0) as graduation_slot
     from public.campaigns
     where chain_id=$1
       and meta #>> '{solanaGraduation,dex}' = 'meteora-damm-v2'
       and coalesce(meta #>> '{solanaGraduation,pool}','') <> ''
       and coalesce(token_address,'') <> ''
     order by updated_at desc
     limit $2`,
    [SOLANA_CHAIN_ID, limit],
  );
  return result.rows.map((row) => ({
    campaign: String(row.campaign_address),
    token: String(row.token_address),
    pool: String(row.pool_address),
    graduationSlot: Number(row.graduation_slot || 0),
  }));
}

function cursorFor(poolAddress: string): string {
  return `solana:meteora:${poolAddress}`;
}

async function getState(poolAddress: string): Promise<number> {
  const result = await pool.query(
    `select last_indexed_block from public.indexer_state where chain_id=$1 and cursor=$2`,
    [SOLANA_CHAIN_ID, cursorFor(poolAddress)],
  );
  return result.rowCount ? Number(result.rows[0].last_indexed_block) : 0;
}

async function setState(poolAddress: string, nextSlot: number) {
  await pool.query(
    `insert into public.indexer_state(chain_id,cursor,last_indexed_block)
     values($1,$2,$3)
     on conflict (chain_id,cursor) do update
       set last_indexed_block=greatest(public.indexer_state.last_indexed_block,excluded.last_indexed_block),
           updated_at=now()`,
    [SOLANA_CHAIN_ID, cursorFor(poolAddress), nextSlot],
  );
}

async function getHeadSlot(): Promise<number> {
  return rpc<number>("getSlot", [{ commitment: "confirmed" }]);
}

async function getSignatures(address: string, fromSlot: number, currentState: number): Promise<RpcSignature[]> {
  const signatures: RpcSignature[] = [];
  let before: string | undefined;
  const limit = Math.max(1, Math.min(1000, Number(ENV.SOLANA_SIGNATURE_LIMIT || 500)));
  const maxPages = Math.max(1, Number(ENV.SOLANA_SIGNATURE_PAGE_LIMIT || 5));
  for (let page = 0; page < maxPages; page += 1) {
    const batch = await rpc<RpcSignature[]>("getSignaturesForAddress", [
      address,
      { limit, ...(before ? { before } : {}) },
    ]);
    if (!batch.length) break;
    for (const item of batch) {
      if (!item.err && item.slot > currentState && item.slot >= fromSlot) signatures.push(item);
    }
    const last = batch[batch.length - 1];
    if (!last || last.slot <= fromSlot || last.slot <= currentState) break;
    before = last.signature;
  }
  signatures.sort((a, b) => a.slot - b.slot || a.signature.localeCompare(b.signature));
  return signatures;
}

async function getTransaction(signature: string): Promise<RpcTransaction> {
  return rpc<RpcTransaction>("getTransaction", [
    signature,
    { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ]);
}

async function getAccountData(address: string): Promise<Buffer> {
  const result = await rpc<{ value?: { data?: [string, string] | null } | null }>("getAccountInfo", [
    address,
    { commitment: "confirmed", encoding: "base64" },
  ]);
  const encoded = result?.value?.data?.[0];
  if (!encoded) throw new Error(`account ${address} is unavailable`);
  return Buffer.from(encoded, "base64");
}

async function loadPoolPair(market: GraduatedMarket): Promise<PoolPair> {
  const data = await getAccountData(market.pool);
  if (data.length < METEORA_POOL_MIN_LEN) throw new Error(`Meteora pool ${market.pool} is too short`);
  const tokenA = new PublicKey(data.subarray(METEORA_POOL_TOKEN_A_MINT_OFFSET, METEORA_POOL_TOKEN_A_MINT_OFFSET + 32)).toBase58();
  const tokenB = new PublicKey(data.subarray(METEORA_POOL_TOKEN_B_MINT_OFFSET, METEORA_POOL_TOKEN_B_MINT_OFFSET + 32)).toBase58();
  const pairOk =
    (tokenA === market.token && tokenB === NATIVE_MINT) ||
    (tokenB === market.token && tokenA === NATIVE_MINT);
  if (!pairOk) throw new Error(`Meteora pool ${market.pool} does not contain ${market.token}/WSOL`);

  const mintData = await getAccountData(market.token);
  if (mintData.length <= 44) throw new Error(`launch mint ${market.token} is too short`);
  return { tokenA, tokenB, tokenDecimals: mintData[44] };
}

async function fixedBondingSupplyWhole(campaign: string, tokenDecimals: number): Promise<number> {
  const latest = await pool.query(
    `select sold_tokens_after_raw
       from public.curve_trades
      where chain_id=$1 and campaign_address=$2 and sold_tokens_after_raw is not null
      order by block_number desc,log_index desc
      limit 1`,
    [SOLANA_CHAIN_ID, campaign],
  );
  const raw = bigintValue(latest.rows[0]?.sold_tokens_after_raw ?? 0);
  if (raw > 0n) {
    const whole = Number(raw) / 10 ** tokenDecimals;
    if (Number.isFinite(whole) && whole > 0) return whole;
  }

  const fallback = await pool.query(
    `select sold_tokens from public.token_stats where chain_id=$1 and campaign_address=$2 limit 1`,
    [SOLANA_CHAIN_ID, campaign],
  );
  const whole = Number(fallback.rows[0]?.sold_tokens ?? 0);
  return Number.isFinite(whole) && whole > 0 ? whole : 0;
}

async function touchCampaignActivity(campaign: string, at: Date) {
  await pool.query(
    `insert into public.campaign_activity(chain_id,campaign_address,last_activity_at,updated_at)
     values($1,$2,$3,now())
     on conflict (chain_id,campaign_address) do update set
       last_activity_at=greatest(excluded.last_activity_at,coalesce(public.campaign_activity.last_activity_at,to_timestamp(0))),
       updated_at=now()`,
    [SOLANA_CHAIN_ID, campaign, at],
  ).catch((error) => {
    const msg = String(error?.message || error);
    if (!msg.includes("campaign_activity")) console.warn("[meteora-indexer] campaign activity touch failed", msg);
  });
}

async function insertActivityEvent(row: {
  eventType: "BUY" | "SELL";
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTime: Date;
  actor: string;
  campaign: string;
  token: string;
  tokenRaw: bigint;
  nativeRaw: bigint;
  meta: Record<string, unknown>;
}) {
  const isBuy = row.eventType === "BUY";
  await pool.query(
    `insert into public.activity_events(
       chain_id,event_type,tx_hash,log_index,block_number,block_time,
       actor_address,campaign_address,token_address,
       amount_in_wei,amount_out_wei,cost_wei,payout_wei,meta
     ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (chain_id,tx_hash,log_index) do nothing`,
    [
      SOLANA_CHAIN_ID,
      row.eventType,
      row.txHash,
      row.logIndex,
      row.blockNumber,
      row.blockTime,
      row.actor,
      row.campaign,
      row.token,
      (isBuy ? row.nativeRaw : row.tokenRaw).toString(),
      (isBuy ? row.tokenRaw : row.nativeRaw).toString(),
      isBuy ? row.nativeRaw.toString() : null,
      isBuy ? null : row.nativeRaw.toString(),
      JSON.stringify(row.meta),
    ],
  ).catch((error) => {
    const msg = String(error?.message || error);
    if (!msg.includes("activity_events")) console.warn("[meteora-indexer] activity insert failed", msg);
  });
}

async function upsertCandle(
  campaign: string,
  tf: TF,
  bucketSec: number,
  priceSol: number,
  volumeSol: number,
  fixedSupplyWhole: number,
  blockNumber: number,
  logIndex: number,
) {
  const mcapSol = Number.isFinite(fixedSupplyWhole) && fixedSupplyWhole > 0
    ? priceSol * fixedSupplyWhole
    : null;
  await pool.query(
    `insert into public.token_candles(
       chain_id,campaign_address,timeframe,bucket_start,o,h,l,c,volume_bnb,trades_count,
       source_mask,bonding_trade_count,dex_trade_count,bonding_volume_bnb,dex_volume_bnb,
       last_block_number,last_log_index,
       price_o,price_h,price_l,price_c,mcap_o,mcap_h,mcap_l,mcap_c,
       canonical_version,canonical_updated_at
     ) values(
       $1,$2,$3,$4,$5,$5,$5,$5,$6,1,
       2,0,1,0,$6,
       $7,$8,
       $5,$5,$5,$5,$9,$9,$9,$9,
       3,now()
     )
     on conflict (chain_id,campaign_address,timeframe,bucket_start) do update set
       h=greatest(public.token_candles.h,excluded.h),
       l=least(public.token_candles.l,excluded.l),
       c=excluded.c,
       volume_bnb=public.token_candles.volume_bnb+excluded.volume_bnb,
       trades_count=public.token_candles.trades_count+1,
       source_mask=((coalesce(public.token_candles.source_mask,0)::int | 2)::smallint),
       bonding_trade_count=coalesce(public.token_candles.bonding_trade_count,0),
       dex_trade_count=coalesce(public.token_candles.dex_trade_count,0)+1,
       bonding_volume_bnb=coalesce(public.token_candles.bonding_volume_bnb,0),
       dex_volume_bnb=coalesce(public.token_candles.dex_volume_bnb,0)+excluded.dex_volume_bnb,
       last_block_number=excluded.last_block_number,
       last_log_index=excluded.last_log_index,
       price_o=coalesce(public.token_candles.price_o,excluded.price_o),
       price_h=greatest(coalesce(public.token_candles.price_h,excluded.price_h),excluded.price_h),
       price_l=least(coalesce(public.token_candles.price_l,excluded.price_l),excluded.price_l),
       price_c=excluded.price_c,
       mcap_o=coalesce(public.token_candles.mcap_o,excluded.mcap_o),
       mcap_h=case
         when excluded.mcap_h is null then public.token_candles.mcap_h
         else greatest(coalesce(public.token_candles.mcap_h,excluded.mcap_h),excluded.mcap_h)
       end,
       mcap_l=case
         when excluded.mcap_l is null then public.token_candles.mcap_l
         else least(coalesce(public.token_candles.mcap_l,excluded.mcap_l),excluded.mcap_l)
       end,
       mcap_c=coalesce(excluded.mcap_c,public.token_candles.mcap_c),
       canonical_version=greatest(coalesce(public.token_candles.canonical_version,0),excluded.canonical_version),
       canonical_updated_at=now(),
       updated_at=now()`,
    [
      SOLANA_CHAIN_ID,
      campaign,
      tf,
      new Date(bucketSec * 1000),
      priceSol,
      volumeSol,
      blockNumber,
      logIndex,
      mcapSol,
    ],
  );
  await publishCandle(SOLANA_CHAIN_ID, campaign, {
    type: "candle_upsert",
    tf,
    bucket: bucketSec,
    c: String(priceSol),
    v: String(volumeSol),
  });
}

async function patchStats(campaign: string) {
  const latest = await pool.query(
    `with t as (
       select price_bnb from public.curve_trades
       where chain_id=$1 and campaign_address=$2
       order by block_number desc,log_index desc limit 1
     ), v as (
       select coalesce(sum(bnb_amount),0) as vol24h from public.curve_trades
       where chain_id=$1 and campaign_address=$2 and block_time>=now()-interval '24 hours'
     )
     select (select price_bnb from t) as last_price_bnb,(select vol24h from v) as vol24h_bnb`,
    [SOLANA_CHAIN_ID, campaign],
  );
  const sold = await pool.query(
    `select
       coalesce(sum(case when side='buy' then token_amount else 0 end),0)-
       coalesce(sum(case when side='sell' then token_amount else 0 end),0) as sold
     from public.curve_trades
     where chain_id=$1 and campaign_address=$2 and sold_tokens_after_raw is not null`,
    [SOLANA_CHAIN_ID, campaign],
  );
  const lastPrice = latest.rows[0]?.last_price_bnb ?? null;
  const soldTokens = Number(sold.rows[0]?.sold ?? 0);
  const vol24h = Number(latest.rows[0]?.vol24h_bnb ?? 0);
  const marketcap = lastPrice !== null ? Number(lastPrice) * soldTokens : null;
  await pool.query(
    `insert into public.token_stats(
       chain_id,campaign_address,last_price_bnb,sold_tokens,marketcap_bnb,vol_24h_bnb,updated_at
     ) values($1,$2,$3,$4,$5,$6,now())
     on conflict (chain_id,campaign_address) do update set
       last_price_bnb=excluded.last_price_bnb,
       sold_tokens=excluded.sold_tokens,
       marketcap_bnb=excluded.marketcap_bnb,
       vol_24h_bnb=excluded.vol_24h_bnb,
       updated_at=now()`,
    [SOLANA_CHAIN_ID, campaign, lastPrice, soldTokens, marketcap, vol24h],
  );
  await publishStats(SOLANA_CHAIN_ID, campaign, {
    type: "stats_patch",
    lastPriceBnb: lastPrice !== null ? String(lastPrice) : null,
    marketcapBnb: marketcap !== null ? String(marketcap) : null,
    vol24hBnb: String(vol24h),
    graduated: true,
    dex: "meteora-damm-v2",
  });

  leagueFeed.queueStats(SOLANA_CHAIN_ID, campaign, {
    lastPriceBnb: lastPrice !== null ? String(lastPrice) : null,
    marketcapBnb: marketcap !== null ? String(marketcap) : null,
    vol24hBnb: String(vol24h),
  });
}

async function insertSwap(input: {
  market: GraduatedMarket;
  pair: PoolPair;
  fixedSupplyWhole: number;
  swap: MeteoraSwap;
  wallet: string;
  signature: string;
  eventIndex: number;
  slot: number;
  blockTime: Date;
}) {
  const inputMint = input.swap.tradeDirection === 0 ? input.pair.tokenA : input.pair.tokenB;
  const outputMint = input.swap.tradeDirection === 0 ? input.pair.tokenB : input.pair.tokenA;
  const isBuy = inputMint === NATIVE_MINT && outputMint === input.market.token;
  const isSell = inputMint === input.market.token && outputMint === NATIVE_MINT;
  if (!isBuy && !isSell) return;

  const tokenRaw = isBuy ? input.swap.amountOutRaw : input.swap.amountInRaw;
  const nativeRaw = isBuy ? input.swap.amountInRaw : input.swap.amountOutRaw;
  if (tokenRaw <= 0n || nativeRaw <= 0n) return;
  const tokenAmount = Number(tokenRaw) / 10 ** input.pair.tokenDecimals;
  const nativeAmount = Number(nativeRaw) / LAMPORTS_PER_SOL;
  const priceNative = tokenAmount > 0 ? nativeAmount / tokenAmount : null;
  const logIndex = 20_000 + input.eventIndex;

  const inserted = await pool.query(
    `insert into public.curve_trades(
       chain_id,campaign_address,tx_hash,log_index,block_number,block_time,
       side,wallet,token_amount_raw,bnb_amount_raw,token_amount,bnb_amount,price_bnb
     ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (chain_id,tx_hash,log_index) do nothing returning tx_hash`,
    [
      SOLANA_CHAIN_ID,
      input.market.campaign,
      input.signature,
      logIndex,
      input.slot,
      input.blockTime,
      isBuy ? "buy" : "sell",
      input.wallet,
      tokenRaw.toString(),
      nativeRaw.toString(),
      tokenAmount,
      nativeAmount,
      priceNative,
    ],
  );
  if ((inserted.rowCount ?? 0) === 0) return;

  const feeRaw =
    input.swap.protocolFeeRaw +
    input.swap.claimingFeeRaw +
    input.swap.compoundingFeeRaw +
    input.swap.referralFeeRaw;
  await touchCampaignActivity(input.market.campaign, input.blockTime);
  await insertActivityEvent({
    eventType: isBuy ? "BUY" : "SELL",
    txHash: input.signature,
    logIndex,
    blockNumber: input.slot,
    blockTime: input.blockTime,
    actor: input.wallet,
    campaign: input.market.campaign,
    token: input.market.token,
    tokenRaw,
    nativeRaw,
    meta: {
      venue: "meteora-damm-v2",
      pool: input.market.pool,
      tradeDirection: input.swap.tradeDirection,
      priceSol: priceNative,
      meteoraFeeRaw: feeRaw.toString(),
      protocolFeeRaw: input.swap.protocolFeeRaw.toString(),
      claimingFeeRaw: input.swap.claimingFeeRaw.toString(),
      compoundingFeeRaw: input.swap.compoundingFeeRaw.toString(),
      referralFeeRaw: input.swap.referralFeeRaw.toString(),
      eventTimestamp: input.swap.currentTimestamp.toString(),
    },
  });

  const realtimeRow = {
    tx_hash: input.signature,
    log_index: logIndex,
    block_number: input.slot,
    block_time: input.blockTime.toISOString(),
    side: isBuy ? "buy" : "sell",
    wallet: input.wallet,
    token_amount_raw: tokenRaw.toString(),
    bnb_amount_raw: nativeRaw.toString(),
    token_amount: tokenAmount,
    bnb_amount: nativeAmount,
    price_bnb: priceNative,
    venue: "meteora-damm-v2",
  };
  await publishTrade(SOLANA_CHAIN_ID, input.market.campaign, realtimeRow);
  // DEX fills update list rank/mcap/vol. Do not treat swap size as bonding raised.
  leagueFeed.queueActivity(SOLANA_CHAIN_ID, input.market.campaign, Math.floor(input.blockTime.getTime() / 1000));
  if (priceNative !== null && priceNative > 0) {
    const tsSec = Math.floor(input.blockTime.getTime() / 1000);
    for (const tf of TIMEFRAMES) {
      await upsertCandle(
        input.market.campaign,
        tf,
        bucketStart(tsSec, tf),
        priceNative,
        nativeAmount,
        input.fixedSupplyWhole,
        input.slot,
        logIndex,
      );
    }
  }
  await patchStats(input.market.campaign);
}

async function indexMarket(market: GraduatedMarket, head: number) {
  const currentState = await getState(market.pool);
  const fallbackLookback = Math.max(1, Number(ENV.SOLANA_LOOKBACK_SLOTS || 50_000));
  const startSlot = market.graduationSlot > 0 ? market.graduationSlot : Math.max(0, head - fallbackLookback);
  const fromSlot = currentState > 0 ? currentState : startSlot;
  const signatures = await getSignatures(market.pool, fromSlot, currentState);
  const pair = await loadPoolPair(market);
  const fixedSupplyWhole = await fixedBondingSupplyWhole(market.campaign, pair.tokenDecimals);
  let maxSlot = currentState;

  for (const item of signatures) {
    const tx = await getTransaction(item.signature);
    const swaps = decodeSwapEvents(tx?.meta?.logMessages);
    if (!swaps.length) {
      maxSlot = Math.max(maxSlot, item.slot);
      continue;
    }
    const wallet = txWallet(tx);
    const blockTime = timestampFrom(tx?.blockTime ?? item.blockTime);
    for (let eventIndex = 0; eventIndex < swaps.length; eventIndex += 1) {
      await insertSwap({
        market,
        pair,
        fixedSupplyWhole,
        swap: swaps[eventIndex],
        wallet,
        signature: item.signature,
        eventIndex,
        slot: item.slot,
        blockTime,
      });
    }
    maxSlot = Math.max(maxSlot, item.slot);
  }

  if (maxSlot > currentState) await setState(market.pool, maxSlot);
  else if (currentState === 0) await setState(market.pool, fromSlot);
}

export async function runMeteoraSwapIndexerOnce() {
  const markets = await loadGraduatedMarkets();
  if (!markets.length) return;
  const head = await getHeadSlot();
  for (const market of markets) {
    try {
      await indexMarket(market, head);
    } catch (error) {
      console.error("[meteora-indexer] market failed", {
        campaign: market.campaign,
        pool: market.pool,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

let running = false;
let started = false;

export function startMeteoraSwapIndexerLoop() {
  if (started) return;
  started = true;
  console.log("[meteora-indexer] enabled", {
    chainId: SOLANA_CHAIN_ID,
    programId: METEORA_CP_AMM_PROGRAM_ID.toBase58(),
    intervalMs: ENV.SOLANA_INDEXER_INTERVAL_MS,
  });

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runMeteoraSwapIndexerOnce();
    } catch (error) {
      console.error("[meteora-indexer] loop error", error);
    } finally {
      running = false;
    }
  };

  setTimeout(() => { void tick(); }, 4_000);
  setInterval(() => { void tick(); }, Math.max(2_000, ENV.SOLANA_INDEXER_INTERVAL_MS || 10_000));
}
