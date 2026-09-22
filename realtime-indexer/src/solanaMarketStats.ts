/**
 * Normalized market stats for Solana campaigns (chain 101).
 *
 * Arena scoring, Warzone Markets and Beat the Market all read one row per
 * campaign in public.market_stats: USD market cap, USD liquidity, USD 24h
 * volume, holders, the quote asset and a health verdict. BNB and Robinhood
 * indexers write that row; nothing wrote it for Solana, so every Solana
 * battle fell back to SOL-denominated token_stats (wrong for a USDC-quoted
 * pool) and had no holder count, which the settlement refuses.
 *
 * This module derives the row chain-neutrally, as docs/build_plans/
 * RHandbattlesupgrade-integrated.md section "Unified price model" requires:
 *
 *   MEME/USD = MEME/QUOTE x QUOTE/USD
 *
 * with QUOTE/USD = SOL/USD for SOL pools and bonding curves, the catalog's
 * fixed reference for stablecoin quotes, or CoinGecko for other quotes.
 * Holders come from the indexed trade ledger (curve trades + pool swaps):
 * a wallet with a positive net balance is a holder. Liquidity is read from
 * the pool vaults on-chain (post-graduation) or the bonding SOL vault.
 * Scoring code never sees a Solana branch; it reads the same columns.
 */
import { pool } from "./db.js";
import { ENV } from "./env.js";

const SOLANA_CHAIN_ID = 101;
const NATIVE_MINT = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL = 1e9;
const METEORA_POOL_TOKEN_A_MINT_OFFSET = 168;
const METEORA_POOL_TOKEN_B_MINT_OFFSET = 200;
const METEORA_POOL_TOKEN_A_VAULT_OFFSET = 232;
const METEORA_POOL_TOKEN_B_VAULT_OFFSET = 264;
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;
const PRICE_CACHE_MS = 5 * 60_000;

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };

export type SolanaMarketStatsInputs = {
  campaign: string;
  tokenAddress: string;
  graduated: boolean;
  quoteMint: string;
  quoteDecimals: number;
  /** Launch token price in quote units (SOL for native pools and bonding). */
  priceQuote: number | null;
  /** USD per whole quote unit. */
  quoteUsd: number | null;
  quoteUsdSource: string | null;
  quoteUsdUpdatedAt: Date | null;
  /** Circulating supply basis in whole tokens (bonding sold tokens, as token_stats uses). */
  supplyWhole: number;
  supplyBasis?: string;
  /** Pool or bonding reserves in whole units. */
  tokenReserveWhole: number | null;
  quoteReserveWhole: number | null;
  volumes: { m5: number; h1: number; h4: number; h24: number; buy24: number; sell24: number; bonding24: number; dex24: number; trades24: number; buys24: number; sells24: number };
  /** Same windows in USD, when every trade could be valued. */
  volumeUsd24h: number | null;
  holders: number;
  lastTradeAt: Date | null;
  lastTradeBlock: number | null;
  nowMs: number;
};

export type SolanaMarketStatsRow = {
  chain_id: number;
  campaign_address: string;
  market_stage: "BONDING" | "DEX_ACTIVE";
  last_price_bnb: number | null;
  market_cap_bnb: number | null;
  liquidity_bnb: number | null;
  bonding_reserve_bnb: number | null;
  volume_5m_bnb: number; volume_1h_bnb: number; volume_4h_bnb: number; volume_24h_bnb: number;
  buy_volume_24h_bnb: number; sell_volume_24h_bnb: number; bonding_volume_24h_bnb: number; dex_volume_24h_bnb: number;
  trades_24h: number; buys_24h: number; sells_24h: number;
  holders: number;
  post_burn_total_supply_raw: null;
  supply_basis: string;
  last_trade_block: number | null;
  last_trade_at: Date | null;
  data_lag_seconds: number;
  quote_token_address: string;
  quote_asset_type: "WRAPPED_NATIVE" | "OTHER";
  last_price_quote: number | null;
  dex_volume_24h_quote: number;
  volume_24h_usd: number | null;
  market_cap_usd: number | null;
  liquidity_usd: number | null;
  last_price_usd: number | null;
  reference_price_usd: number | null;
  reference_price_updated_at: Date | null;
  valuation_source: string | null;
  valuation_healthy: boolean;
  valuation_error: string | null;
};

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Pure: turn gathered inputs into the market_stats row. */
export function computeSolanaMarketStats(input: SolanaMarketStatsInputs): SolanaMarketStatsRow {
  const nativeQuote = input.quoteMint === NATIVE_MINT;
  const priceQuote = finite(input.priceQuote);
  const quoteUsd = finite(input.quoteUsd);
  const priceUsd = priceQuote != null && quoteUsd != null && priceQuote > 0 && quoteUsd > 0 ? priceQuote * quoteUsd : null;
  const marketCapQuote = priceQuote != null && input.supplyWhole > 0 ? priceQuote * input.supplyWhole : null;
  const marketCapUsd = priceUsd != null && input.supplyWhole > 0 ? priceUsd * input.supplyWhole : null;
  const tokenReserve = finite(input.tokenReserveWhole);
  const quoteReserve = finite(input.quoteReserveWhole);
  const liquidityQuote = quoteReserve != null
    ? (input.graduated && tokenReserve != null && priceQuote != null ? quoteReserve + tokenReserve * priceQuote : quoteReserve * (input.graduated ? 2 : 1))
    : null;
  const liquidityUsd = liquidityQuote != null && quoteUsd != null ? liquidityQuote * quoteUsd : null;
  const errors: string[] = [];
  if (priceQuote == null) errors.push("no launch token price yet");
  if (quoteUsd == null) errors.push(nativeQuote ? "SOL/USD reference unavailable" : "quote USD reference unavailable");
  const lagSeconds = input.lastTradeAt ? Math.max(0, Math.round((input.nowMs - input.lastTradeAt.getTime()) / 1000)) : 0;
  return {
    chain_id: SOLANA_CHAIN_ID,
    campaign_address: input.campaign,
    market_stage: input.graduated ? "DEX_ACTIVE" : "BONDING",
    last_price_bnb: nativeQuote ? priceQuote : null,
    market_cap_bnb: nativeQuote ? marketCapQuote : null,
    liquidity_bnb: nativeQuote ? liquidityQuote : null,
    bonding_reserve_bnb: !input.graduated && nativeQuote ? quoteReserve : null,
    volume_5m_bnb: nativeQuote ? input.volumes.m5 : 0,
    volume_1h_bnb: nativeQuote ? input.volumes.h1 : 0,
    volume_4h_bnb: nativeQuote ? input.volumes.h4 : 0,
    volume_24h_bnb: nativeQuote ? input.volumes.h24 : 0,
    buy_volume_24h_bnb: nativeQuote ? input.volumes.buy24 : 0,
    sell_volume_24h_bnb: nativeQuote ? input.volumes.sell24 : 0,
    bonding_volume_24h_bnb: nativeQuote ? input.volumes.bonding24 : 0,
    dex_volume_24h_bnb: nativeQuote ? input.volumes.dex24 : 0,
    trades_24h: input.volumes.trades24,
    buys_24h: input.volumes.buys24,
    sells_24h: input.volumes.sells24,
    holders: input.holders,
    post_burn_total_supply_raw: null,
    supply_basis: input.supplyBasis || "bonding_sold_tokens",
    last_trade_block: input.lastTradeBlock,
    last_trade_at: input.lastTradeAt,
    data_lag_seconds: lagSeconds,
    quote_token_address: input.quoteMint,
    quote_asset_type: nativeQuote ? "WRAPPED_NATIVE" : "OTHER",
    last_price_quote: priceQuote,
    dex_volume_24h_quote: input.graduated ? input.volumes.dex24 : 0,
    volume_24h_usd: input.volumeUsd24h,
    market_cap_usd: marketCapUsd,
    liquidity_usd: liquidityUsd,
    last_price_usd: priceUsd,
    reference_price_usd: quoteUsd,
    reference_price_updated_at: input.quoteUsdUpdatedAt,
    valuation_source: input.quoteUsdSource,
    valuation_healthy: priceUsd != null && marketCapUsd != null,
    valuation_error: errors.length ? errors.join("; ") : null,
  };
}

/* ------------------------------------------------------------------ prices */

const priceCache = new Map<string, { value: number; at: number }>();

async function coinGeckoUsd(id: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const cached = priceCache.get(id);
  if (cached && Date.now() - cached.at < PRICE_CACHE_MS) return cached.value;
  try {
    const key = String(process.env.COINGECKO_API_KEY || "").trim();
    const response = await fetchImpl(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`, {
      headers: { accept: "application/json", ...(key ? { "x-cg-demo-api-key": key } : {}) },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as Record<string, { usd?: number }>;
    const value = Number(body?.[id]?.usd);
    if (!Number.isFinite(value) || value <= 0) throw new Error("no price");
    priceCache.set(id, { value, at: Date.now() });
    return value;
  } catch (error) {
    console.warn("[solana-market-stats] CoinGecko price unavailable", { id, error: error instanceof Error ? error.message : String(error) });
    return cached?.value ?? null;
  }
}

/** SOL/USD: env pin for isolated devnet runs, otherwise CoinGecko (cached). */
export async function solUsdPrice(fetchImpl: typeof fetch = fetch): Promise<{ price: number | null; source: string }> {
  const micros = Number(process.env.SOLANA_GRADUATION_SOL_USD_MICROS || "");
  if (Number.isFinite(micros) && micros > 0) return { price: micros / 1_000_000, source: "env:SOLANA_GRADUATION_SOL_USD_MICROS" };
  const pinned = Number(process.env.SOLANA_USD_PRICE_OVERRIDE || "");
  if (Number.isFinite(pinned) && pinned > 0) return { price: pinned, source: "env:SOLANA_USD_PRICE_OVERRIDE" };
  const price = await coinGeckoUsd("solana", fetchImpl);
  return { price, source: "coingecko:solana" };
}

async function quoteUsdPrice(db: Queryable, quoteMint: string, quoteReferenceUsd: number | null, fetchImpl: typeof fetch): Promise<{ price: number | null; source: string }> {
  if (quoteMint === NATIVE_MINT) return solUsdPrice(fetchImpl);
  if (quoteReferenceUsd != null && quoteReferenceUsd > 0) return { price: quoteReferenceUsd, source: "catalog_reference_usd" };
  const policy = await db.query(
    `select pv.policy_config #>> '{solanaGraduation,coinGeckoId}' as coingecko_id,
            pv.policy_config #>> '{solanaGraduation,referenceUsdMicros}' as reference_usd_micros
       from public.quote_asset_policy_versions pv
       join public.quote_asset_deployments d on d.id = pv.deployment_id
      where d.chain_id = '101' and d.contract_address_or_mint = $1 and pv.policy_status = 'active'
      order by pv.created_at desc limit 1`,
    [quoteMint],
  ).catch(() => ({ rows: [] }));
  const row = policy.rows[0];
  const micros = Number(row?.reference_usd_micros);
  if (Number.isFinite(micros) && micros > 0) return { price: micros / 1_000_000, source: "catalog_reference_usd" };
  const id = String(row?.coingecko_id || "").trim();
  if (id) return { price: await coinGeckoUsd(id, fetchImpl), source: `coingecko:${id}` };
  return { price: null, source: "none" };
}

/* ------------------------------------------------------------------ chain reads */

function rpcUrl(cluster: "mainnet-beta" | "devnet"): string {
  const runtime = String(process.env.SOLANA_CLUSTER || "").trim().toLowerCase();
  if (cluster === "devnet") return String(process.env.SOLANA_DEVNET_RPC_URL || (runtime === "devnet" ? ENV.SOLANA_RPC_HTTP || process.env.SOLANA_RPC_URL : "") || "https://api.devnet.solana.com").split(",")[0].trim();
  return String(process.env.SOLANA_MAINNET_RPC_URL || (runtime !== "devnet" ? ENV.SOLANA_RPC_HTTP || process.env.SOLANA_RPC_URL : "") || "https://api.mainnet-beta.solana.com").split(",")[0].trim();
}

async function rpc<T>(url: string, method: string, params: unknown[], fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await response.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message || `${method} failed`);
  return body.result as T;
}

async function accountData(url: string, address: string, fetchImpl: typeof fetch): Promise<Buffer | null> {
  const result = await rpc<{ value?: { data?: [string, string] } | null }>(url, "getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }], fetchImpl);
  const encoded = result?.value?.data?.[0];
  return encoded ? Buffer.from(encoded, "base64") : null;
}

/** Pool vault reserves for a graduated campaign; null when the pool cannot be read. */
async function poolReserves(url: string, poolAddress: string, launchMint: string, fetchImpl: typeof fetch): Promise<{ tokenRaw: bigint; quoteRaw: bigint; quoteMint: string } | null> {
  const data = await accountData(url, poolAddress, fetchImpl);
  if (!data || data.length < METEORA_POOL_TOKEN_B_VAULT_OFFSET + 32) return null;
  const base58 = (await import("@solana/web3.js")).PublicKey;
  const mintA = new base58(data.subarray(METEORA_POOL_TOKEN_A_MINT_OFFSET, METEORA_POOL_TOKEN_A_MINT_OFFSET + 32)).toBase58();
  const mintB = new base58(data.subarray(METEORA_POOL_TOKEN_B_MINT_OFFSET, METEORA_POOL_TOKEN_B_MINT_OFFSET + 32)).toBase58();
  const vaultA = new base58(data.subarray(METEORA_POOL_TOKEN_A_VAULT_OFFSET, METEORA_POOL_TOKEN_A_VAULT_OFFSET + 32)).toBase58();
  const vaultB = new base58(data.subarray(METEORA_POOL_TOKEN_B_VAULT_OFFSET, METEORA_POOL_TOKEN_B_VAULT_OFFSET + 32)).toBase58();
  const launchIsA = mintA === launchMint;
  if (!launchIsA && mintB !== launchMint) return null;
  const [tokenVault, quoteVault] = await Promise.all([accountData(url, launchIsA ? vaultA : vaultB, fetchImpl), accountData(url, launchIsA ? vaultB : vaultA, fetchImpl)]);
  if (!tokenVault || !quoteVault || tokenVault.length < 72 || quoteVault.length < 72) return null;
  return {
    tokenRaw: tokenVault.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET),
    quoteRaw: quoteVault.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET),
    quoteMint: launchIsA ? mintB : mintA,
  };
}

/* ------------------------------------------------------------------ ledger reads */

export const HOLDER_COUNT_SQL = `
with ledger as (
  select wallet,
         sum(case when side = 'buy' then token_amount_raw::numeric else -token_amount_raw::numeric end) as balance
    from public.curve_trades
   where chain_id = $1 and campaign_address = $2
   group by wallet
  union all
  select coalesce(transaction_from, sender_address, recipient_address) as wallet,
         sum(case when side = 'buy' then token_amount_raw::numeric else -token_amount_raw::numeric end) as balance
    from public.dex_trades
   where chain_id = $1 and campaign_address = $2 and status = 'confirmed'
   group by 1
)
select count(*)::int as holders
  from (select wallet, sum(balance) as balance from ledger where wallet is not null and wallet <> '' group by wallet) t
 where balance > 0`;

async function holderCount(db: Queryable, campaign: string): Promise<number> {
  const result = await db.query(HOLDER_COUNT_SQL, [SOLANA_CHAIN_ID, campaign]);
  return Number(result.rows[0]?.holders || 0);
}

async function tradeWindows(db: Queryable, campaign: string, quoteDecimals: number, quoteUsd: number | null, solUsd: number | null) {
  const result = await db.query(
    `select t."nativeAmountRaw" as native_raw, t."quoteAmountRaw" as quote_raw, t."quoteAssetType" as quote_type, t."volumeUsd" as volume_usd,
            t.side, t.source, t."blockTime" as block_time, t."blockNumber" as block_number
       from public.market_trades_v t
      where t."chainId" = $1 and t."campaignAddress" = $2 and t.status = 'confirmed' and t."blockTime" >= now() - interval '24 hours'
      order by t."blockNumber" desc, t."logIndex" desc`,
    [SOLANA_CHAIN_ID, campaign],
  );
  const now = Date.now();
  const windows = { m5: 0, h1: 0, h4: 0, h24: 0, buy24: 0, sell24: 0, bonding24: 0, dex24: 0, trades24: 0, buys24: 0, sells24: 0 };
  let usd24 = 0;
  let usdComplete = true;
  for (const row of result.rows) {
    const nativeRow = String(row.quote_type || "WRAPPED_NATIVE").toUpperCase() === "WRAPPED_NATIVE";
    const amount = nativeRow ? Number(row.native_raw || 0) / LAMPORTS_PER_SOL : Number(row.quote_raw || 0) / 10 ** quoteDecimals;
    const age = now - new Date(row.block_time).getTime();
    if (age <= 5 * 60_000) windows.m5 += amount;
    if (age <= 60 * 60_000) windows.h1 += amount;
    if (age <= 4 * 60 * 60_000) windows.h4 += amount;
    windows.h24 += amount;
    windows.trades24 += 1;
    if (row.side === "buy") { windows.buy24 += amount; windows.buys24 += 1; } else { windows.sell24 += amount; windows.sells24 += 1; }
    if (row.source === "bonding") windows.bonding24 += amount; else windows.dex24 += amount;
    const usd = row.volume_usd != null ? Number(row.volume_usd) : nativeRow ? (solUsd != null ? amount * solUsd : null) : (quoteUsd != null ? amount * quoteUsd : null);
    if (usd == null) usdComplete = false; else usd24 += usd;
  }
  const latest = result.rows[0];
  return { windows, volumeUsd24h: usdComplete ? usd24 : null, lastTradeAt: latest ? new Date(latest.block_time) : null, lastTradeBlock: latest ? Number(latest.block_number) : null };
}

/* ------------------------------------------------------------------ refresh */

export async function refreshSolanaMarketStats(campaign: string, deps: { db?: Queryable; fetchImpl?: typeof fetch; nowMs?: number } = {}): Promise<SolanaMarketStatsRow | null> {
  const db = deps.db || pool;
  const fetchImpl = deps.fetchImpl || fetch;
  const nowMs = deps.nowMs ?? Date.now();
  const campaignRow = (await db.query(
    `select campaign_address, token_address, is_active, graduated_at_chain,
            meta #>> '{solanaGraduation,pool}' as pool_address,
            meta #>> '{solanaGraduation,quoteMint}' as quote_mint,
            meta #>> '{solanaGraduation,quoteDecimals}' as quote_decimals,
            meta #>> '{solanaGraduation,quoteReferenceUsd}' as quote_reference_usd,
            meta #>> '{solana,solVault}' as sol_vault
       from public.campaigns where chain_id = $1 and campaign_address = $2 limit 1`,
    [SOLANA_CHAIN_ID, campaign],
  )).rows[0];
  if (!campaignRow?.token_address) return null;

  const graduated = Boolean(campaignRow.graduated_at_chain || campaignRow.pool_address);
  const cluster: "mainnet-beta" | "devnet" = String(process.env.SOLANA_CLUSTER || "").trim().toLowerCase() === "devnet" ? "devnet" : "mainnet-beta";
  const url = rpcUrl(cluster);
  let quoteMint = graduated ? String(campaignRow.quote_mint || "").trim() || NATIVE_MINT : NATIVE_MINT;
  let quoteDecimals = quoteMint === NATIVE_MINT ? 9 : Number(campaignRow.quote_decimals || 6);

  let reserves: { tokenRaw: bigint; quoteRaw: bigint; quoteMint: string } | null = null;
  if (graduated && campaignRow.pool_address) {
    reserves = await poolReserves(url, String(campaignRow.pool_address), String(campaignRow.token_address), fetchImpl).catch(() => null);
    if (reserves && reserves.quoteMint !== quoteMint) {
      quoteMint = reserves.quoteMint;
      if (quoteMint === NATIVE_MINT) quoteDecimals = 9;
    }
  }
  let bondingReserveLamports: bigint | null = null;
  if (!graduated && campaignRow.sol_vault) {
    bondingReserveLamports = await rpc<{ value?: number }>(url, "getBalance", [String(campaignRow.sol_vault), { commitment: "confirmed" }], fetchImpl)
      .then((result) => (result && typeof result === "object" && result.value != null ? BigInt(result.value) : null))
      .catch(() => null);
  }

  const [{ price: solUsd }, quote] = await Promise.all([
    solUsdPrice(fetchImpl),
    quoteUsdPrice(db, quoteMint, campaignRow.quote_reference_usd != null ? Number(campaignRow.quote_reference_usd) : null, fetchImpl),
  ]);

  const tokenStats = (await db.query(`select last_price_bnb, sold_tokens from public.token_stats where chain_id = $1 and campaign_address = $2 limit 1`, [SOLANA_CHAIN_ID, campaign])).rows[0];
  const mintData = await accountData(url, String(campaignRow.token_address), fetchImpl).catch(() => null);
  const tokenDecimals = mintData && mintData.length > 44 ? mintData[44] : 6;
  const mintSupplyWhole = mintData && mintData.length >= 44 ? Number(mintData.readBigUInt64LE(36)) / 10 ** tokenDecimals : null;

  let priceQuote: number | null = null;
  if (quoteMint === NATIVE_MINT) {
    priceQuote = finite(tokenStats?.last_price_bnb);
    if (!(priceQuote != null && priceQuote > 0)) priceQuote = null;
  } else {
    const latest = (await db.query(`select price_quote from public.dex_trades where chain_id = $1 and campaign_address = $2 and status = 'confirmed' and price_quote is not null order by block_number desc, log_index desc limit 1`, [SOLANA_CHAIN_ID, campaign])).rows[0];
    priceQuote = finite(latest?.price_quote);
  }
  if (priceQuote == null && reserves && reserves.tokenRaw > 0n) {
    // No indexed swap yet: the pool's current ratio is the price (SOL or quote units).
    priceQuote = (Number(reserves.quoteRaw) / 10 ** quoteDecimals) / (Number(reserves.tokenRaw) / 10 ** tokenDecimals);
  }

  // Supply basis: bonding sales as token_stats records them; when a pool exists
  // but no sale was indexed (fixture campaigns, pre-decoder-fix graduations),
  // circulating supply is the mint supply outside the pool.
  let supplyWhole = Number(tokenStats?.sold_tokens || 0);
  let supplyBasis = "bonding_sold_tokens";
  if (!(supplyWhole > 0) && graduated && reserves && mintSupplyWhole != null) {
    supplyWhole = Math.max(0, mintSupplyWhole - Number(reserves.tokenRaw) / 10 ** tokenDecimals);
    supplyBasis = "mint_supply_minus_pool";
  }

  const trades = await tradeWindows(db, campaign, quoteDecimals, quote.price, solUsd);
  const holders = await holderCount(db, campaign);
  const row = computeSolanaMarketStats({
    campaign,
    tokenAddress: String(campaignRow.token_address),
    graduated,
    quoteMint,
    quoteDecimals,
    priceQuote,
    quoteUsd: quote.price,
    quoteUsdSource: quote.source,
    quoteUsdUpdatedAt: quote.price != null ? new Date(nowMs) : null,
    supplyWhole,
    supplyBasis,
    tokenReserveWhole: reserves ? Number(reserves.tokenRaw) / 10 ** tokenDecimals : null,
    quoteReserveWhole: reserves ? Number(reserves.quoteRaw) / 10 ** quoteDecimals : bondingReserveLamports != null ? Number(bondingReserveLamports) / LAMPORTS_PER_SOL : null,
    volumes: trades.windows,
    volumeUsd24h: trades.volumeUsd24h,
    holders,
    lastTradeAt: trades.lastTradeAt,
    lastTradeBlock: trades.lastTradeBlock,
    nowMs,
  });
  await upsertMarketStats(db, row);
  return row;
}

async function upsertMarketStats(db: Queryable, row: SolanaMarketStatsRow) {
  await db.query(
    `insert into public.market_stats(
       chain_id, campaign_address, market_stage, last_price_bnb, market_cap_bnb, liquidity_bnb, bonding_reserve_bnb,
       volume_5m_bnb, volume_1h_bnb, volume_4h_bnb, volume_24h_bnb, buy_volume_24h_bnb, sell_volume_24h_bnb, bonding_volume_24h_bnb, dex_volume_24h_bnb,
       trades_24h, buys_24h, sells_24h, holders, post_burn_total_supply_raw, supply_basis, last_trade_block, last_trade_at, data_lag_seconds, updated_at,
       quote_token_address, quote_asset_type, last_price_quote, dex_volume_24h_quote, volume_24h_usd, market_cap_usd, liquidity_usd, last_price_usd,
       reference_price_usd, reference_price_updated_at, valuation_source, valuation_healthy, valuation_error
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,now(),$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37)
     on conflict (chain_id, campaign_address) do update set
       market_stage = excluded.market_stage, last_price_bnb = excluded.last_price_bnb, market_cap_bnb = excluded.market_cap_bnb, liquidity_bnb = excluded.liquidity_bnb,
       bonding_reserve_bnb = excluded.bonding_reserve_bnb, volume_5m_bnb = excluded.volume_5m_bnb, volume_1h_bnb = excluded.volume_1h_bnb, volume_4h_bnb = excluded.volume_4h_bnb,
       volume_24h_bnb = excluded.volume_24h_bnb, buy_volume_24h_bnb = excluded.buy_volume_24h_bnb, sell_volume_24h_bnb = excluded.sell_volume_24h_bnb,
       bonding_volume_24h_bnb = excluded.bonding_volume_24h_bnb, dex_volume_24h_bnb = excluded.dex_volume_24h_bnb, trades_24h = excluded.trades_24h, buys_24h = excluded.buys_24h,
       sells_24h = excluded.sells_24h, holders = excluded.holders, post_burn_total_supply_raw = excluded.post_burn_total_supply_raw, supply_basis = excluded.supply_basis,
       last_trade_block = excluded.last_trade_block, last_trade_at = excluded.last_trade_at, data_lag_seconds = excluded.data_lag_seconds, updated_at = now(),
       quote_token_address = excluded.quote_token_address, quote_asset_type = excluded.quote_asset_type, last_price_quote = excluded.last_price_quote,
       dex_volume_24h_quote = excluded.dex_volume_24h_quote, volume_24h_usd = excluded.volume_24h_usd, market_cap_usd = excluded.market_cap_usd, liquidity_usd = excluded.liquidity_usd,
       last_price_usd = excluded.last_price_usd, reference_price_usd = excluded.reference_price_usd, reference_price_updated_at = excluded.reference_price_updated_at,
       valuation_source = excluded.valuation_source, valuation_healthy = excluded.valuation_healthy, valuation_error = excluded.valuation_error`,
    [
      row.chain_id, row.campaign_address, row.market_stage, row.last_price_bnb, row.market_cap_bnb, row.liquidity_bnb, row.bonding_reserve_bnb,
      row.volume_5m_bnb, row.volume_1h_bnb, row.volume_4h_bnb, row.volume_24h_bnb, row.buy_volume_24h_bnb, row.sell_volume_24h_bnb, row.bonding_volume_24h_bnb, row.dex_volume_24h_bnb,
      row.trades_24h, row.buys_24h, row.sells_24h, row.holders, row.post_burn_total_supply_raw, row.supply_basis, row.last_trade_block, row.last_trade_at, row.data_lag_seconds,
      row.quote_token_address, row.quote_asset_type, row.last_price_quote, row.dex_volume_24h_quote, row.volume_24h_usd, row.market_cap_usd, row.liquidity_usd, row.last_price_usd,
      row.reference_price_usd, row.reference_price_updated_at, row.valuation_source, row.valuation_healthy, row.valuation_error,
    ],
  );
}

/** Every Solana campaign that traded recently or is graduated, refreshed in turn. */
export async function refreshAllSolanaMarketStats(deps: { db?: Queryable; limit?: number; log?: (line: string) => void } = {}) {
  const db = deps.db || pool;
  const limit = Math.max(1, Math.min(500, deps.limit ?? 200));
  const candidates = await db.query(
    `select c.campaign_address
       from public.campaigns c
      where c.chain_id = $1 and c.campaign_address is not null
        and (c.graduated_at_chain is not null
             or c.meta #>> '{solanaGraduation,pool}' is not null
             or exists (select 1 from public.curve_trades t where t.chain_id = c.chain_id and t.campaign_address = c.campaign_address and t.block_time >= now() - interval '7 days'))
      order by c.updated_at desc nulls last
      limit $2`,
    [SOLANA_CHAIN_ID, limit],
  );
  let refreshed = 0;
  for (const row of candidates.rows) {
    try {
      await refreshSolanaMarketStats(String(row.campaign_address), { db });
      refreshed += 1;
    } catch (error) {
      deps.log?.(`[solana-market-stats] ${row.campaign_address} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { candidates: candidates.rows.length, refreshed };
}

let loopStarted = false;
export function startSolanaMarketStatsLoop() {
  if (loopStarted) return;
  loopStarted = true;
  const intervalMs = Math.max(15_000, Number(process.env.SOLANA_MARKET_STATS_INTERVAL_MS || 60_000));
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await refreshAllSolanaMarketStats({ log: (line) => console.warn(line) });
      if (result.candidates) console.log("[solana-market-stats] pass", result);
    } catch (error) {
      console.error("[solana-market-stats] loop failed", error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
    }
  };
  const initial = setTimeout(() => void tick(), 10_000);
  initial.unref?.();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  console.log("[solana-market-stats] enabled", { intervalMs });
}
