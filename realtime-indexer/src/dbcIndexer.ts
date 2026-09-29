/**
 * DBC bonding-curve swaps into curve_trades. Events are Anchor emit_cpi inner
 * instructions (not log lines). There is no trader in EvtSwap2; take the swap
 * instruction's payer account.
 */
import { BorshCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { publishCandle, publishStats, publishTrade } from "./ably.js";
import { candleUpsertPayload } from "./candlePublish.js";
import { pool as defaultPool } from "./db.js";
import { ENV } from "./env.js";
import { createLeagueFeedPublisher } from "./leagueFeed.js";
import { notPublicHiddenSql } from "./publicHidden.js";
import { jupiterRawUnitUsd, solUsdPrice } from "./solanaMarketStats.js";
import { TIMEFRAMES, bucketStart, type TF } from "./timeframes.js";

const SOLANA_CHAIN_ID = 101;
const DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const EVENT_IX_TAG = Buffer.from("e445a52e51cb9a1d", "hex");
const SWAP2_DISC = Buffer.from([65, 75, 63, 76, 235, 91, 91, 136]);
const SWAP_DISC = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]);
const LAMPORTS_PER_SOL = 1_000_000_000;
const TOKEN_DECIMALS = 6;
const DEFAULT_SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const PAYER_ACCOUNT_INDEX = 9;

const idlPath = join(dirname(fileURLToPath(import.meta.url)), "dbc/dynamicBondingCurve.idl.json");
const dbcIdl = JSON.parse(readFileSync(idlPath, "utf8")) as Idl;
const eventCoder = new BorshCoder(dbcIdl);

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };

export type DbcPoolRow = {
  campaign: string;
  token: string;
  creator: string;
  migrated: boolean;
  quoteMint?: string;
  quoteDecimals?: number;
  /** "stock" for an xStock quote (7b): valued by its live USD price, not $1 per whole token. */
  quoteKind?: string;
};

export type FreshSolUsd = { micros: bigint; source: string };
export type FreshSolUsdReader = (fetchImpl?: typeof fetch) => Promise<FreshSolUsd | null>;

export type DecodedEvtSwap2 = {
  pool: string;
  config: string;
  tradeDirection: number;
  hasReferral: boolean;
  includedFeeInputAmount: bigint;
  excludedFeeInputAmount: bigint;
  outputAmount: bigint;
  tradingFee: bigint;
  protocolFee: bigint;
  referralFee: bigint;
  quoteReserveAmount: bigint;
  migrationThreshold: bigint;
  currentTimestamp: bigint;
};

export type DbcCurveTradeRow = {
  chain_id: number;
  campaign_address: string;
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_time: Date;
  side: "buy" | "sell";
  wallet: string;
  token_amount_raw: string;
  bnb_amount_raw: string;
  token_amount: number;
  bnb_amount: number;
  price_bnb: number | null;
  venue: "dbc";
  quote_mint?: string;
  quote_amount_raw?: string;
  sol_usd_micros?: string | null;
  sol_usd_source?: string | null;
  quote_usd_micros?: string | null;
  quote_usd_source?: string | null;
};

function parseRpcList(value: string): string[] {
  return String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
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
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || method));
}

function bigintValue(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string") return BigInt(value);
  if (value && typeof value === "object" && "toString" in value) return BigInt(String(value));
  return 0n;
}

function pubkeyValue(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof (value as { toBase58?: () => string }).toBase58 === "function") {
    return (value as { toBase58: () => string }).toBase58();
  }
  return String(value);
}

function bs58Decode(data: string): Buffer {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = 0n;
  for (const ch of data) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error("invalid base58");
    num = num * 58n + BigInt(idx);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const body = num === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  let leading = 0;
  while (leading < data.length && data[leading] === "1") leading += 1;
  return Buffer.concat([Buffer.alloc(leading), body]);
}

export function decodeEvtSwap2Data(raw: Buffer): DecodedEvtSwap2 | null {
  if (raw.length < 16) return null;
  let body = raw;
  if (body.subarray(0, 8).equals(EVENT_IX_TAG)) body = body.subarray(8);
  const decoded = eventCoder.events.decode(body.toString("base64"));
  if (!decoded || String(decoded.name).replace(/_/g, "").toLowerCase() !== "evtswap2") return null;
  const data = decoded.data as Record<string, any>;
  const result = (data.swapResult || data.swap_result || {}) as Record<string, any>;
  return {
    pool: pubkeyValue(data.pool),
    config: pubkeyValue(data.config),
    tradeDirection: Number(data.tradeDirection ?? data.trade_direction ?? 0),
    hasReferral: Boolean(data.hasReferral ?? data.has_referral),
    includedFeeInputAmount: bigintValue(result.includedFeeInputAmount ?? result.included_fee_input_amount),
    excludedFeeInputAmount: bigintValue(result.excludedFeeInputAmount ?? result.excluded_fee_input_amount),
    outputAmount: bigintValue(result.outputAmount ?? result.output_amount),
    tradingFee: bigintValue(result.tradingFee ?? result.trading_fee),
    protocolFee: bigintValue(result.protocolFee ?? result.protocol_fee),
    referralFee: bigintValue(result.referralFee ?? result.referral_fee),
    quoteReserveAmount: bigintValue(data.quoteReserveAmount ?? data.quote_reserve_amount),
    migrationThreshold: bigintValue(data.migrationThreshold ?? data.migration_threshold),
    currentTimestamp: bigintValue(data.currentTimestamp ?? data.current_timestamp),
  };
}

export function decodeEvtSwap2FromInnerIxData(base58Data: string): DecodedEvtSwap2 | null {
  try {
    return decodeEvtSwap2Data(bs58Decode(base58Data));
  } catch {
    return null;
  }
}

function accountKey(entry: any): string {
  if (!entry) return "";
  if (typeof entry === "string") return entry;
  if (typeof entry.toBase58 === "function") return entry.toBase58();
  return String(entry.pubkey || "");
}

function instructionProgramId(ix: any, keys: string[]): string {
  if (ix?.programId) return accountKey(ix.programId);
  if (typeof ix?.programIdIndex === "number" && keys[ix.programIdIndex]) return keys[ix.programIdIndex];
  return "";
}

function instructionData(ix: any): string {
  return String(ix?.data || "");
}

function instructionAccounts(ix: any, keys: string[]): string[] {
  if (Array.isArray(ix?.accounts) && ix.accounts.length && typeof ix.accounts[0] === "string") return ix.accounts.map(String);
  if (Array.isArray(ix?.accounts)) {
    return ix.accounts.map((entry: any) => {
      if (typeof entry === "number") return keys[entry] || "";
      return accountKey(entry);
    });
  }
  return [];
}

function messageKeys(tx: any): string[] {
  const message = tx?.transaction?.message;
  if (!message) return [];
  if (typeof message.getAccountKeys === "function") {
    try {
      const loaded = tx?.meta?.loadedAddresses;
      const keys = loaded
        ? message.getAccountKeys({ accountKeysFromLookups: loaded })
        : message.getAccountKeys();
      const list = typeof keys.keySegments === "function"
        ? keys.keySegments().flat()
        : [
          ...(keys.staticAccountKeys || []),
          ...(keys.accountKeysFromLookups?.writable || []),
          ...(keys.accountKeysFromLookups?.readonly || []),
        ];
      if (list.length) return list.map((entry: any) => accountKey(entry));
    } catch {
      // fall through
    }
  }
  const keys = message.accountKeys || message.staticAccountKeys || [];
  return keys.map((entry: any) => accountKey(entry));
}

function outerInstructions(tx: any): any[] {
  return tx?.transaction?.message?.instructions || [];
}

function innerInstructions(tx: any): any[] {
  const groups = tx?.meta?.innerInstructions || [];
  const out: any[] = [];
  for (const group of groups) {
    for (const ix of group.instructions || []) out.push(ix);
  }
  return out;
}

export function decodeEvtSwap2FromTransaction(tx: any): DecodedEvtSwap2[] {
  const keys = messageKeys(tx);
  const found: DecodedEvtSwap2[] = [];
  for (const ix of innerInstructions(tx)) {
    if (instructionProgramId(ix, keys) !== DBC_PROGRAM_ID) continue;
    const decoded = decodeEvtSwap2FromInnerIxData(instructionData(ix));
    if (decoded) found.push(decoded);
  }
  return found;
}

export function swapPayerFromTransaction(tx: any): string {
  const keys = messageKeys(tx);
  const scan = (ix: any) => {
    if (instructionProgramId(ix, keys) !== DBC_PROGRAM_ID) return "";
    const data = instructionData(ix);
    let raw: Buffer;
    try { raw = bs58Decode(data); } catch { return ""; }
    if (raw.length < 8) return "";
    const disc = raw.subarray(0, 8);
    if (!disc.equals(SWAP2_DISC) && !disc.equals(SWAP_DISC)) return "";
    const accounts = instructionAccounts(ix, keys);
    return accounts[PAYER_ACCOUNT_INDEX] || "";
  };
  for (const ix of outerInstructions(tx)) {
    const payer = scan(ix);
    if (payer) return payer;
  }
  for (const ix of innerInstructions(tx)) {
    const payer = scan(ix);
    if (payer) return payer;
  }
  const first = keys[0];
  return first || "";
}

/**
 * Quote raw units to lamports. `quoteUsdMicros` is the USD value of 10^decimals raw units: $1 for
 * USDC/USDT; for an xStock its prescaled price (displayed price x multiplier).
 */
export function quoteRawToSolLamports(quoteRaw: bigint, quoteDecimals: number, solUsdMicros: bigint, quoteUsdMicros: bigint = 1_000_000n): bigint {
  const decimals = BigInt(quoteDecimals);
  const scale = 10n ** decimals;
  const micros = BigInt(solUsdMicros);
  if (micros <= 0n) throw new Error("SOL/USD micros must be positive");
  if (BigInt(quoteUsdMicros) <= 0n) throw new Error("quote USD micros must be positive");
  if (decimals === 9n) return BigInt(quoteRaw);
  return (BigInt(quoteRaw) * BigInt(quoteUsdMicros) * 1_000_000_000n) / (micros * scale);
}

export type FreshQuoteUsd = { micros: bigint; source: string };
export type FreshQuoteUsdReader = (mint: string, fetchImpl?: typeof fetch) => Promise<FreshQuoteUsd | null>;

/** A stock quote's USD per 10^decimals raw, only from Jupiter's prescaled price; null when there is none. */
export async function freshStockQuoteUsdMicros(mint: string, fetchImpl: typeof fetch = fetch): Promise<FreshQuoteUsd | null> {
  const price = await jupiterRawUnitUsd(mint, fetchImpl);
  if (!price?.prescaled) return null;
  const micros = BigInt(Math.round(price.value * 1_000_000));
  return micros > 0n ? { micros, source: "jupiter:price-v3-prescaled" } : null;
}

/** Non-native quotes (USDC/USDT are 6 decimals) convert to SOL via a live SOL/USD. */
export function boundQuoteNeedsSolUsd(quoteDecimals: number | undefined | null): boolean {
  return Number(quoteDecimals ?? 9) !== 9;
}

/**
 * SOL/USD used to value a bound DBC trade. Env pins are the operator's price;
 * otherwise CoinGecko, and only a fetch that succeeded (or is still inside the
 * 5-minute cache window). A stale CoinGecko cache after a failed fetch is not
 * a price — callers skip the trade until the next pass.
 */
export async function freshSolUsdMicros(fetchImpl: typeof fetch = fetch): Promise<FreshSolUsd | null> {
  const pinnedMicros = Number(process.env.SOLANA_GRADUATION_SOL_USD_MICROS || "");
  if (Number.isFinite(pinnedMicros) && pinnedMicros > 0) {
    return { micros: BigInt(Math.trunc(pinnedMicros)), source: "env:SOLANA_GRADUATION_SOL_USD_MICROS" };
  }
  const { price, source } = await solUsdPrice(fetchImpl, { requireFresh: true });
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  const micros = BigInt(Math.round(price * 1_000_000));
  if (micros <= 0n) return null;
  return { micros, source };
}

export function curveTradeFromSwap(input: {
  event: DecodedEvtSwap2;
  wallet: string;
  signature: string;
  eventIndex: number;
  slot: number;
  blockTime: Date;
  campaign: string;
  quoteMint?: string;
  quoteDecimals?: number;
  solUsdMicros?: bigint;
  priceSource?: string;
  quoteUsdMicros?: bigint;
  quoteUsdSource?: string;
}): DbcCurveTradeRow {
  const isBuy = input.event.tradeDirection === 1;
  const tokenRaw = isBuy ? input.event.outputAmount : input.event.excludedFeeInputAmount;
  const quoteRaw = isBuy ? input.event.includedFeeInputAmount : input.event.outputAmount;
  const quoteDecimals = Number(input.quoteDecimals ?? 9);
  const quoteMint = String(input.quoteMint || "So11111111111111111111111111111111111111112");
  let nativeRaw: bigint;
  let solUsdMicros: string | null = null;
  let solUsdSource: string | null = null;
  let quoteUsdMicros: string | null = null;
  let quoteUsdSource: string | null = null;
  if (!boundQuoteNeedsSolUsd(quoteDecimals)) {
    nativeRaw = quoteRaw;
  } else {
    const micros = input.solUsdMicros;
    const source = String(input.priceSource || "").trim();
    if (micros == null || micros <= 0n) {
      throw new Error("DBC bound trade needs a fresh SOL/USD price");
    }
    if (!source) {
      throw new Error("DBC bound trade needs a SOL/USD price source");
    }
    nativeRaw = quoteRawToSolLamports(quoteRaw, quoteDecimals, micros, input.quoteUsdMicros ?? 1_000_000n);
    solUsdMicros = micros.toString();
    solUsdSource = source;
    if (input.quoteUsdMicros != null) {
      quoteUsdMicros = input.quoteUsdMicros.toString();
      quoteUsdSource = String(input.quoteUsdSource || "");
    }
  }
  const tokenAmount = Number(tokenRaw) / 10 ** TOKEN_DECIMALS;
  const nativeAmount = Number(nativeRaw) / LAMPORTS_PER_SOL;
  const priceNative = tokenAmount > 0 ? nativeAmount / tokenAmount : null;
  const logIndex = input.eventIndex;
  if (logIndex >= 20_000) throw new Error("DBC bonding log_index must stay below 20000");
  return {
    chain_id: SOLANA_CHAIN_ID,
    campaign_address: input.campaign,
    tx_hash: input.signature,
    log_index: logIndex,
    block_number: input.slot,
    block_time: input.blockTime,
    side: isBuy ? "buy" : "sell",
    wallet: input.wallet,
    token_amount_raw: tokenRaw.toString(),
    bnb_amount_raw: nativeRaw.toString(),
    token_amount: tokenAmount,
    bnb_amount: nativeAmount,
    price_bnb: priceNative,
    venue: "dbc",
    quote_mint: quoteMint,
    quote_amount_raw: quoteRaw.toString(),
    sol_usd_micros: solUsdMicros,
    sol_usd_source: solUsdSource,
    quote_usd_micros: quoteUsdMicros,
    quote_usd_source: quoteUsdSource,
  };
}

export function dbcPriceFromSqrt(sqrtPrice: bigint, baseDecimals = 6, quoteDecimals = 9): number {
  const q64 = 2n ** 64n;
  if (sqrtPrice <= 0n) return 0;
  // 1e18 scale: a memecoin trades far below 1e-9 SOL per token, a 1e9 scale kept one or two digits.
  const scale = 10n ** 18n;
  const scaled = (sqrtPrice * sqrtPrice * (10n ** BigInt(baseDecimals)) * scale)
    / (q64 * q64 * (10n ** BigInt(quoteDecimals)));
  return Number(scaled) / 1e18;
}

export async function dbcMarketStatsFromAccounts(
  rpcUrl: string,
  poolAddress: string,
  fetchImpl: typeof fetch = fetch,
  quoteDecimals = 9,
) {
  const read = async (address: string) => {
    const response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [address, { encoding: "base64", commitment: "confirmed" }],
      }),
    });
    const payload = await response.json() as { result?: { value?: { data?: [string, string] } | null } };
    const encoded = payload?.result?.value?.data?.[0];
    if (!encoded) throw new Error(`account ${address} missing`);
    return Buffer.from(encoded, "base64");
  };
  const poolData = await read(poolAddress);
  const poolDecoded = eventCoder.accounts.decode("VirtualPool", poolData) as any;
  const state = poolDecoded?.poolState || poolDecoded?.pool_state || poolDecoded;
  const configPk = pubkeyValue(state.config);
  const configData = await read(configPk);
  const config = eventCoder.accounts.decode("PoolConfig", configData) as any;
  const sqrtPrice = bigintValue(state.sqrtPrice ?? state.sqrt_price);
  const quoteReserve = bigintValue(state.quoteReserve ?? state.quote_reserve);
  const post = bigintValue(config.postMigrationTokenSupply ?? config.post_migration_token_supply);
  const threshold = bigintValue(config.migrationQuoteThreshold ?? config.migration_quote_threshold);
  const stats = dbcMarketStatsInputs({
    sqrtPrice,
    quoteReserve,
    postMigrationTokenSupply: post,
    migrationQuoteThreshold: threshold,
    quoteDecimals,
  });
  return { quoteReserve, ...stats, isMigrated: Boolean(state.isMigrated ?? state.is_migrated) };
}

export function dbcMarketStatsInputs(pool: {
  sqrtPrice: bigint;
  quoteReserve: bigint;
  postMigrationTokenSupply: bigint;
  migrationQuoteThreshold: bigint;
  tokenDecimals?: number;
  quoteDecimals?: number;
}) {
  const tokenDecimals = pool.tokenDecimals ?? TOKEN_DECIMALS;
  const quoteDecimals = pool.quoteDecimals ?? 9;
  const priceQuote = dbcPriceFromSqrt(pool.sqrtPrice, tokenDecimals, quoteDecimals);
  const supplyWhole = Number(pool.postMigrationTokenSupply) / 10 ** tokenDecimals;
  const quoteReserveWhole = Number(pool.quoteReserve) / 10 ** quoteDecimals;
  const threshold = Number(pool.migrationQuoteThreshold);
  const progress = threshold > 0 ? Number(pool.quoteReserve) / threshold : 0;
  return { priceQuote, supplyWhole, quoteReserveWhole, progress };
}

function cursorFor(poolAddress: string): string {
  return `solana:dbc:${poolAddress}`;
}

export async function loadDbcPools(db: Queryable): Promise<DbcPoolRow[]> {
  const limit = Math.max(1, Math.min(10_000, Number(process.env.SOLANA_DBC_POOL_LIMIT || 2_000)));
  const result = await db.query(
    `select campaign_address, token_address, creator_address,
            coalesce(meta #>> '{solanaGraduation,pool}','') as graduated_pool,
            coalesce(meta #>> '{dbc,migration,pool}','') as dbc_migrated_pool,
            coalesce(meta #>> '{dbc,quoteMint}','So11111111111111111111111111111111111111112') as quote_mint,
            coalesce(meta #>> '{dbc,quoteDecimals}','9') as quote_decimals,
            coalesce(meta #>> '{dbc,quoteKind}','') as quote_kind
       from public.campaigns
      where chain_id=$1
        and coalesce(launch_type,'launchpad') = 'dbc'
        and ${notPublicHiddenSql()}
      order by updated_at desc
      limit $2`,
    [SOLANA_CHAIN_ID, limit],
  );
  if (result.rows.length >= limit) {
    console.warn(`[dbcIndexer] pool limit ${limit} reached; raise SOLANA_DBC_POOL_LIMIT so no pool is skipped`);
  }
  return result.rows.map((row) => ({
    campaign: String(row.campaign_address),
    token: String(row.token_address || ""),
    creator: String(row.creator_address || ""),
    migrated: Boolean(row.graduated_pool || row.dbc_migrated_pool),
    quoteMint: String(row.quote_mint || "So11111111111111111111111111111111111111112"),
    quoteDecimals: Number(row.quote_decimals || 9),
    quoteKind: String(row.quote_kind || ""),
  }));
}

async function getState(db: Queryable, poolAddress: string): Promise<number> {
  const result = await db.query(
    `select last_indexed_block from public.indexer_state where chain_id=$1 and cursor=$2`,
    [SOLANA_CHAIN_ID, cursorFor(poolAddress)],
  );
  return result.rowCount ? Number(result.rows[0].last_indexed_block) : 0;
}

async function setState(db: Queryable, poolAddress: string, nextSlot: number) {
  await db.query(
    `insert into public.indexer_state(chain_id,cursor,last_indexed_block)
     values($1,$2,$3)
     on conflict (chain_id,cursor) do update
       set last_indexed_block=greatest(public.indexer_state.last_indexed_block,excluded.last_indexed_block),
           updated_at=now()`,
    [SOLANA_CHAIN_ID, cursorFor(poolAddress), nextSlot],
  );
}

async function getSignatures(address: string, fromSlot: number, currentState: number) {
  const signatures: Array<{ signature: string; slot: number; err: unknown; blockTime?: number | null }> = [];
  let before: string | undefined;
  const limit = Math.max(1, Math.min(1000, Number(ENV.SOLANA_SIGNATURE_LIMIT || 500)));
  // Page back until the cursor is reached. A page cap would leave the oldest signatures of a
  // large backlog unfetched while the cursor moved past them: trades lost without a trace.
  for (;;) {
    const batch = await rpc<typeof signatures>(
      "getSignaturesForAddress",
      [address, { limit, ...(before ? { before } : {}) }],
    );
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

async function getTransaction(signature: string) {
  return rpc<any>("getTransaction", [
    signature,
    { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ]);
}

let leagueFeed: ReturnType<typeof createLeagueFeedPublisher> | null = null;
function feed() {
  if (!leagueFeed) leagueFeed = createLeagueFeedPublisher({ pool: defaultPool, flushMs: 500 });
  return leagueFeed;
}

async function insertActivity(db: Queryable, row: DbcCurveTradeRow, event: DecodedEvtSwap2) {
  await db.query(
    `insert into public.activity_events(
       chain_id,event_type,tx_hash,log_index,block_number,block_time,
       actor_address,campaign_address,token_address,
       amount_in_wei,amount_out_wei,cost_wei,payout_wei,meta
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (chain_id,tx_hash,log_index) do nothing`,
    [
      SOLANA_CHAIN_ID,
      row.side === "buy" ? "BUY" : "SELL",
      row.tx_hash,
      row.log_index,
      row.block_number,
      row.block_time,
      row.wallet,
      row.campaign_address,
      null,
      row.side === "buy" ? row.bnb_amount_raw : row.token_amount_raw,
      row.side === "buy" ? row.token_amount_raw : row.bnb_amount_raw,
      row.side === "buy" ? row.bnb_amount_raw : null,
      row.side === "buy" ? null : row.bnb_amount_raw,
      JSON.stringify({
        venue: "dbc",
        trading_fee: event.tradingFee.toString(),
        protocol_fee: event.protocolFee.toString(),
        referral_fee: event.referralFee.toString(),
        priceSol: row.price_bnb,
        quoteMint: row.quote_mint || null,
        quoteAmountRaw: row.quote_amount_raw || null,
        quoteSol: row.sol_usd_source
          ? {
              micros: row.sol_usd_micros,
              source: row.sol_usd_source,
              at: row.block_time,
            }
          : undefined,
        quoteUsd: row.quote_usd_source
          ? { micros: row.quote_usd_micros, source: row.quote_usd_source, at: row.block_time }
          : undefined,
      }),
    ],
  ).catch((error: unknown) => {
    console.warn("[dbcIndexer] activity insert failed", error instanceof Error ? error.message : String(error));
  });
}

async function upsertCandle(db: Queryable, campaign: string, tf: TF, bucketSec: number, priceSol: number, volumeSol: number) {
  const written = await db.query(
    `insert into public.token_candles(
       chain_id,campaign_address,timeframe,bucket_start,o,h,l,c,volume_bnb,trades_count
     ) values($1,$2,$3,$4,$5,$5,$5,$5,$6,1)
     on conflict (chain_id,campaign_address,timeframe,bucket_start) do update set
       h=greatest(public.token_candles.h, excluded.h),
       l=least(public.token_candles.l, excluded.l),
       c=excluded.c,
       volume_bnb=public.token_candles.volume_bnb + excluded.volume_bnb,
       trades_count=public.token_candles.trades_count + 1,
       updated_at=now()
     returning o,h,l,c,volume_bnb,trades_count`,
    [SOLANA_CHAIN_ID, campaign, tf, new Date(bucketSec * 1000), priceSol, volumeSol],
  );
  const row = written.rows[0] || { o: priceSol, h: priceSol, l: priceSol, c: priceSol, volume_bnb: volumeSol, trades_count: 1 };
  void publishCandle(SOLANA_CHAIN_ID, campaign, candleUpsertPayload(tf, bucketSec, row)).catch(() => undefined);
}

async function patchStats(db: Queryable, campaign: string) {
  const latest = await db.query(
    `select price_bnb from public.curve_trades
      where chain_id=$1 and campaign_address=$2
      order by block_number desc, log_index desc limit 1`,
    [SOLANA_CHAIN_ID, campaign],
  );
  const vol = await db.query(
    `select coalesce(sum(bnb_amount),0) as vol24h from public.curve_trades
      where chain_id=$1 and campaign_address=$2 and block_time >= now() - interval '24 hours'`,
    [SOLANA_CHAIN_ID, campaign],
  );
  const lastPrice = latest.rows[0]?.price_bnb != null ? Number(latest.rows[0].price_bnb) : null;
  const vol24h = Number(vol.rows[0]?.vol24h ?? 0);
  await db.query(
    `insert into public.token_stats(chain_id,campaign_address,last_price_bnb,vol24h_bnb,updated_at)
     values ($1,$2,$3,$4,now())
     on conflict (chain_id,campaign_address) do update set
       last_price_bnb=excluded.last_price_bnb, vol24h_bnb=excluded.vol24h_bnb, updated_at=now()`,
    [SOLANA_CHAIN_ID, campaign, lastPrice, vol24h],
  ).catch(() => undefined);
  void publishStats(SOLANA_CHAIN_ID, campaign, {
    type: "stats_patch",
    lastPriceBnb: lastPrice !== null ? String(lastPrice) : null,
    vol24hBnb: String(vol24h),
  }).catch(() => undefined);
}

export async function insertDbcSwap(
  db: Queryable,
  row: DbcCurveTradeRow,
  event: DecodedEvtSwap2,
) {
  const inserted = await db.query(
    `insert into public.curve_trades(
       chain_id,campaign_address,tx_hash,log_index,block_number,block_time,
       side,wallet,token_amount_raw,bnb_amount_raw,token_amount,bnb_amount,price_bnb,venue,
       quote_mint,quote_amount_raw
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     on conflict (chain_id,tx_hash,log_index) do nothing
     returning tx_hash`,
    [
      row.chain_id, row.campaign_address, row.tx_hash, row.log_index, row.block_number, row.block_time,
      row.side, row.wallet, row.token_amount_raw, row.bnb_amount_raw, row.token_amount, row.bnb_amount,
      row.price_bnb, row.venue,
      row.quote_mint || "So11111111111111111111111111111111111111112",
      row.quote_amount_raw || row.bnb_amount_raw,
    ],
  );
  if ((inserted.rowCount ?? 0) === 0) return false;
  void publishTrade(SOLANA_CHAIN_ID, row.campaign_address, row).catch(() => undefined);
  await insertActivity(db, row, event);
  feed().queueActivity(SOLANA_CHAIN_ID, row.campaign_address, Math.floor(row.block_time.getTime() / 1000));
  if (row.price_bnb && row.price_bnb > 0) {
    const tsSec = Math.floor(row.block_time.getTime() / 1000);
    for (const tf of TIMEFRAMES) {
      await upsertCandle(db, row.campaign_address, tf, bucketStart(tsSec, tf), row.price_bnb, row.bnb_amount);
    }
  }
  await patchStats(db, row.campaign_address);
  return true;
}

export async function indexDbcPool(
  db: Queryable,
  row: DbcPoolRow,
  rpcGetTransaction = getTransaction,
  rpcGetSignatures: typeof getSignatures = getSignatures,
  deps: { readSolUsd?: FreshSolUsdReader; readQuoteUsd?: FreshQuoteUsdReader } = {},
) {
  if (row.migrated) return { scanned: 0, ingested: 0, skippedMigrated: true, skippedNoPrice: false };
  const quoteDecimals = Number(row.quoteDecimals ?? 9);
  let solUsd: FreshSolUsd | null = null;
  if (boundQuoteNeedsSolUsd(quoteDecimals)) {
    const readSolUsd = deps.readSolUsd || freshSolUsdMicros;
    solUsd = await readSolUsd();
    if (!solUsd) {
      console.warn("[dbcIndexer] no fresh SOL/USD; leaving bound trades for the next pass", { pool: row.campaign });
      return { scanned: 0, ingested: 0, skippedMigrated: false, skippedNoPrice: true };
    }
  }
  let quoteUsd: FreshQuoteUsd | null = null;
  if (row.quoteKind === "stock") {
    // Never $1 per whole token for a stock: without a live price the trades wait for the next pass.
    quoteUsd = await (deps.readQuoteUsd || freshStockQuoteUsdMicros)(String(row.quoteMint));
    if (!quoteUsd) {
      console.warn("[dbcIndexer] no stock quote price; leaving trades for the next pass", { pool: row.campaign });
      return { scanned: 0, ingested: 0, skippedMigrated: false, skippedNoPrice: true };
    }
  }
  const currentState = await getState(db, row.campaign);
  const signatures = await rpcGetSignatures(row.campaign, 0, currentState);
  let ingested = 0;
  let maxSlot = currentState;
  let stoppedAtSlot: number | null = null;
  for (const item of signatures) {
    const tx = await rpcGetTransaction(item.signature);
    // A lagging RPC node can return null for a confirmed signature. Stop here and keep the cursor
    // below this slot so the next pass retries it; skipping would move the cursor past the trade.
    if (!tx) {
      console.warn("[dbcIndexer] transaction not readable yet; retrying next pass", { pool: row.campaign, signature: item.signature });
      stoppedAtSlot = item.slot;
      break;
    }
    const events = decodeEvtSwap2FromTransaction(tx);
    const wallet = swapPayerFromTransaction(tx);
    const blockTime = new Date(Number(item.blockTime || tx.blockTime || Math.floor(Date.now() / 1000)) * 1000);
    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      const event = events[eventIndex];
      const trade = curveTradeFromSwap({
        event,
        wallet,
        signature: item.signature,
        eventIndex,
        slot: item.slot,
        blockTime,
        campaign: row.campaign,
        quoteMint: row.quoteMint,
        quoteDecimals: row.quoteDecimals,
        ...(solUsd ? { solUsdMicros: solUsd.micros, priceSource: solUsd.source } : {}),
        ...(quoteUsd ? { quoteUsdMicros: quoteUsd.micros, quoteUsdSource: quoteUsd.source } : {}),
      });
      if (await insertDbcSwap(db, trade, event)) ingested += 1;
    }
    maxSlot = Math.max(maxSlot, item.slot);
  }
  if (stoppedAtSlot != null) maxSlot = Math.min(maxSlot, stoppedAtSlot - 1);
  if (maxSlot > currentState) await setState(db, row.campaign, maxSlot);
  return { scanned: signatures.length, ingested, skippedMigrated: false, skippedNoPrice: false };
}

export async function runDbcIndexerOnce(db: Queryable = defaultPool) {
  const pools = await loadDbcPools(db);
  const results = [];
  for (const row of pools) {
    try {
      results.push({ pool: row.campaign, ...(await indexDbcPool(db, row)) });
    } catch (error) {
      console.error("[dbcIndexer] pool failed", {
        pool: row.campaign,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

let started = false;
let running = false;

export function startDbcIndexerLoop() {
  if (started) return;
  started = true;
  feed().start();
  const intervalMs = Math.max(4_000, Number(ENV.SOLANA_INDEXER_INTERVAL_MS || 8_000));
  console.log("[dbcIndexer] enabled", { chainId: SOLANA_CHAIN_ID, programId: DBC_PROGRAM_ID, intervalMs });
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDbcIndexerOnce();
    } catch (error) {
      console.error("[dbcIndexer] loop error", error);
    } finally {
      running = false;
    }
  };
  const initial = setTimeout(() => void tick(), 8_000);
  initial.unref?.();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
}

export { DBC_PROGRAM_ID, EVENT_IX_TAG, SWAP2_DISC };
