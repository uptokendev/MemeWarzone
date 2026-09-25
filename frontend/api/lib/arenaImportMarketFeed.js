/**
 * Market data for imported tokens (arena_token_imports, status 'passed').
 *
 * The indexer only follows MemeWarzone's own pools, so an imported token had no market_stats row
 * and every metrics Battle involving one was unscorable. This feed fills
 * public.arena_import_market_stats, which getArenaMarketSnapshot reads for imports -- the same
 * snapshot matching, live scoring and settlement already use, so there is still one scoring path.
 *
 *   price / market cap / liquidity / 24h volume : DexScreener (deepest pair), else GeckoTerminal
 *   holders                                     : Solana -- Helius DAS getTokenAccounts (owners with a
 *                                                 balance), else GeckoTerminal; BNB / Robinhood --
 *                                                 GeckoTerminal token info
 * GeckoTerminal's free tier allows ~30 calls/min, so each pass spends at most GECKO_CALLS_PER_PASS
 * (COINGECKO_API_KEY switches to the paid on-chain API and a larger budget).
 *
 * Battle data is stale after 120 s (BATTLE_POINTS_CONFIG.staleSeconds), so a pass runs every 60 s;
 * holders are recounted every HOLDER_REFRESH_MS and carried forward in between.
 */

export const IMPORT_FEED_INTERVAL_MS = 60_000;
export const HOLDER_REFRESH_MS = 5 * 60_000;
const DEXSCREENER = "https://api.dexscreener.com/tokens/v1";
const DEXSCREENER_BATCH = 30;
const MAX_HOLDER_PAGES = 50; // 50k token accounts; beyond that the count is a floor

/** DexScreener chain slugs (verified 2026-09-25: solana, bsc, robinhood all list pairs). */
export function dexScreenerChainSlug(chainId, env = process.env) {
  const id = Number(chainId);
  const override = String(env[`DEXSCREENER_CHAIN_${id}`] || "").trim();
  if (override) return override;
  if (id === 101) return "solana";
  if (id === 56) return "bsc";
  if (id === 4663) return "robinhood";
  return null;
}

/** GeckoTerminal network ids (verified 2026-09-25 from /networks). */
export function geckoTerminalNetwork(chainId) {
  const id = Number(chainId);
  if (id === 101) return "solana";
  if (id === 56) return "bsc";
  if (id === 4663) return "robinhood";
  return null;
}

export const GECKO_CALLS_PER_PASS = 20;

function geckoClient(env = process.env, fetchImpl = fetch) {
  const key = String(env.COINGECKO_API_KEY || "").trim();
  const base = key ? "https://pro-api.coingecko.com/api/v3/onchain" : "https://api.geckoterminal.com/api/v2";
  let budget = Number(env.ARENA_IMPORT_FEED_GECKO_CALLS_PER_PASS) || (key ? 200 : GECKO_CALLS_PER_PASS);
  return {
    remaining: () => budget,
    async get(path) {
      if (budget <= 0) return null;
      budget -= 1;
      const res = await fetchImpl(`${base}${path}`, {
        headers: { accept: "application/json", ...(key ? { "x-cg-pro-api-key": key } : {}) },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      return res.json();
    },
  };
}

/** GeckoTerminal token attributes as the feed's market shape (fallback when DexScreener has no pair). */
export function geckoMarket(attributes) {
  const a = attributes || {};
  const marketCapUsd = (num(a.market_cap_usd) || null) ?? num(a.fdv_usd);
  if (!(marketCapUsd > 0)) return null;
  return {
    priceUsd: num(a.price_usd),
    marketCapUsd,
    liquidityUsd: num(a.total_reserve_in_usd),
    volume24hUsd: num(a.volume_usd?.h24) ?? 0,
    pairAddress: null,
    dexId: "geckoterminal",
  };
}

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sameToken(chainId, a, b) {
  const x = String(a || "").trim();
  const y = String(b || "").trim();
  return Number(chainId) === 101 ? x === y : x.toLowerCase() === y.toLowerCase();
}

/** The deepest pair where the token is the base asset; its USD figures are the token's. */
export function pickDeepestPair(chainId, tokenAddress, pairs) {
  let best = null;
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    if (!sameToken(chainId, pair?.baseToken?.address, tokenAddress)) continue;
    const liquidity = num(pair?.liquidity?.usd) || 0;
    if (!best || liquidity > (num(best?.liquidity?.usd) || 0)) best = pair;
  }
  if (!best) return null;
  return {
    priceUsd: num(best.priceUsd),
    marketCapUsd: (num(best.marketCap) || null) ?? num(best.fdv),
    liquidityUsd: num(best.liquidity?.usd),
    volume24hUsd: num(best.volume?.h24) ?? 0,
    pairAddress: String(best.pairAddress || "") || null,
    dexId: String(best.dexId || "") || null,
  };
}

export async function fetchDexScreenerPairs(slug, addresses, fetchImpl = fetch) {
  const out = [];
  for (let i = 0; i < addresses.length; i += DEXSCREENER_BATCH) {
    const batch = addresses.slice(i, i + DEXSCREENER_BATCH);
    const res = await fetchImpl(`${DEXSCREENER}/${slug}/${batch.map(encodeURIComponent).join(",")}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`DexScreener ${slug} HTTP ${res.status}`);
    const json = await res.json();
    if (Array.isArray(json)) out.push(...json);
  }
  return out;
}

/** Owners holding a positive balance of a Solana mint (SPL or Token-2022), via Helius DAS. */
export async function countSolanaHolders(rpcUrl, mint, fetchImpl = fetch, { excludeOwners = [] } = {}) {
  if (!rpcUrl) return null;
  const excluded = new Set(excludeOwners.map((owner) => String(owner || "").trim()).filter(Boolean));
  const owners = new Set();
  for (let page = 1; page <= MAX_HOLDER_PAGES; page++) {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "mwz-holders", method: "getTokenAccounts", params: { mint, limit: 1000, page } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json?.error) return null; // not a DAS endpoint
    const accounts = json?.result?.token_accounts || [];
    for (const account of accounts) {
      try {
        if (BigInt(String(account?.amount ?? 0)) > 0n && account?.owner && !excluded.has(String(account.owner))) owners.add(String(account.owner));
      } catch {
        // ignore malformed amounts
      }
    }
    if (accounts.length < 1000) break;
  }
  return owners.size;
}

function solanaRpc(env = process.env) {
  return String(env.SOLANA_RPC_URL || env.SOLANA_MAINNET_RPC_URL || env.SOLANA_RPC_HTTP || "").trim();
}

/**
 * One pass: every passed import on a chain DexScreener covers. A token the source does not list is
 * skipped, not zeroed -- a missing row reads as "no market data", a zero row would read as a crash.
 */
export async function refreshImportMarketStats({ pool, env = process.env, fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const imports = await pool.query(
    `select i.chain_id, i.token_address, s.holders, s.holders_updated_at
       from public.arena_token_imports i
       left join public.arena_import_market_stats s on s.chain_id = i.chain_id and s.token_address = i.token_address
      where i.status = 'passed'
      order by s.holders_updated_at asc nulls first`,
  );
  const gecko = geckoClient(env, fetchImpl);
  const byChain = new Map();
  for (const row of imports.rows) {
    const slug = dexScreenerChainSlug(row.chain_id, env);
    const network = geckoTerminalNetwork(row.chain_id);
    if (!slug && !network) continue;
    if (!byChain.has(row.chain_id)) byChain.set(row.chain_id, { slug, network, rows: [] });
    byChain.get(row.chain_id).rows.push(row);
  }
  const summary = { updated: 0, unlisted: 0, errors: [] };
  for (const [chainId, { slug, network, rows }] of byChain) {
    let pairs = [];
    if (slug) {
      try {
        pairs = await fetchDexScreenerPairs(slug, rows.map((r) => r.token_address), fetchImpl);
      } catch (error) {
        summary.errors.push(`${chainId}: ${error?.message || error}`);
      }
    }
    for (const row of rows) {
      let market = pickDeepestPair(chainId, row.token_address, pairs);
      let source = "dexscreener";
      if ((!market || !(market.marketCapUsd > 0)) && network) {
        const json = await gecko.get(`/networks/${network}/tokens/${encodeURIComponent(row.token_address)}`).catch(() => null);
        market = geckoMarket(json?.data?.attributes);
        source = "geckoterminal";
      }
      if (!market || !(market.marketCapUsd > 0)) {
        summary.unlisted += 1;
        continue;
      }
      let holders = row.holders == null ? null : Number(row.holders);
      let holdersAt = row.holders_updated_at || null;
      const holdersDue = holders == null || !holdersAt || nowMs - Date.parse(holdersAt) >= HOLDER_REFRESH_MS;
      if (holdersDue) {
        let counted = null;
        if (Number(chainId) === 101) counted = await countSolanaHolders(solanaRpc(env), row.token_address, fetchImpl).catch(() => null);
        if (counted == null && network) {
          const info = await gecko.get(`/networks/${network}/tokens/${encodeURIComponent(row.token_address)}/info`).catch(() => null);
          const n = num(info?.data?.attributes?.holders?.count);
          if (n != null && n >= 0) counted = Math.floor(n);
        }
        if (counted != null) {
          holders = counted;
          holdersAt = new Date(nowMs).toISOString();
        }
      }
      await pool.query(
        `insert into public.arena_import_market_stats
           (chain_id, token_address, price_usd, market_cap_usd, liquidity_usd, volume_24h_usd, holders, holders_updated_at, pair_address, dex_id, source, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, to_timestamp($12 / 1000.0))
         on conflict (chain_id, token_address) do update set
           price_usd = excluded.price_usd, market_cap_usd = excluded.market_cap_usd,
           liquidity_usd = excluded.liquidity_usd, volume_24h_usd = excluded.volume_24h_usd,
           holders = excluded.holders, holders_updated_at = excluded.holders_updated_at,
           pair_address = excluded.pair_address, dex_id = excluded.dex_id,
           source = excluded.source, updated_at = excluded.updated_at`,
        [chainId, row.token_address, market.priceUsd, market.marketCapUsd, market.liquidityUsd, market.volume24hUsd, holders, holdersAt, market.pairAddress, market.dexId, source, nowMs],
      );
      summary.updated += 1;
    }
  }
  return summary;
}
