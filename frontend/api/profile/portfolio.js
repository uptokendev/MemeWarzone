import { json, getQuery, isAddress, isSolanaAddress, isSolanaChain, normalizeAddress, badMethod } from "../../server/http.js";
import { pool } from "../../server/db.js";
import { derivePortfolioMetrics, calculateHoldingValueUsd } from "../lib/portfolioCalculations.js";
import { getServerReadProvider } from "../lib/getServerReadProvider.js";
import { resolveBnbUsdPrice } from "../lib/bnbUsdPrice.js";
import { resolveSolUsdPrice } from "../lib/solUsdPrice.js";
import { resolveEthUsdPrice } from "../lib/ethUsdPrice.js";
import { ethers } from "ethers";

const CACHE_MS = 60_000;
const cache = new Map();
const inflight = new Map();
const MAX_EVM_SCAN = 40;
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

function solanaRpcUrl() {
  return String(process.env.SOLANA_RPC_URL || process.env.SOLANA_MAINNET_RPC_URL || process.env.SOLANA_RPC_HTTP || "").trim();
}

async function solanaRpc(method, params) {
  const url = solanaRpcUrl();
  if (!url) throw new Error("Solana RPC is not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const jsonBody = await res.json().catch(() => null);
    if (!res.ok || jsonBody?.error) throw new Error(jsonBody?.error?.message || `Solana RPC ${method} failed`);
    return jsonBody?.result;
  } finally {
    clearTimeout(timer);
  }
}

async function loadWalletAge(address) {
  const { rows } = await pool.query(
    `select min(ts) as first_at
       from (
         select created_at as ts from public.user_profiles
          where address = $1 or lower(address) = lower($1)
         union all
         select created_at from public.campaign_drafts
          where creator_wallet = $1 or lower(creator_wallet) = lower($1)
         union all
         select coalesce(created_at_chain, created_at) from public.campaigns
          where creator_address = $1 or lower(creator_address) = lower($1)
         union all
         select block_time from public.curve_trades
          where wallet = $1 or lower(wallet) = lower($1)
       ) s`,
    [address],
  );
  return rows[0]?.first_at ? new Date(rows[0].first_at).toISOString() : null;
}

async function loadCampaignsByMints(chainId, mints) {
  const list = (mints || []).map((m) => String(m || "").trim()).filter(Boolean);
  if (!list.length) return [];
  const { rows } = await pool.query(
    // Prices live in market_stats on production (campaigns has no price columns; CO-22, 2026-10-03).
    `select c.chain_id, c.campaign_address, c.token_address, c.name, c.symbol, c.logo_uri,
            ms.market_cap_bnb as marketcap_bnb, ms.last_price_bnb, ms.last_price_usd,
            ms.market_cap_usd, ms.market_stage
       from public.campaigns c
       left join public.market_stats ms
         on ms.chain_id = c.chain_id and ms.campaign_address = c.campaign_address
      where c.chain_id = $1
        and (
          c.token_address = any($2::text[])
          or c.campaign_address = any($2::text[])
          or lower(c.token_address) = any($3::text[])
          or lower(c.campaign_address) = any($3::text[])
        )`,
    [chainId, list, list.map((m) => m.toLowerCase())],
  );
  return rows;
}

async function loadIndexedHoldings(chainId, address) {
  try {
    const { rows } = await pool.query(
      `select th.chain_id, th.token_address, th.balance_raw,
              c.campaign_address, c.name, c.symbol, c.logo_uri,
              ms.market_cap_bnb as marketcap_bnb, ms.last_price_bnb, ms.last_price_usd,
              ms.market_cap_usd, ms.market_stage
         from public.token_holder_balances th
         left join public.campaigns c
           on c.chain_id = th.chain_id
          and (
            lower(c.token_address) = lower(th.token_address)
            or c.token_address = th.token_address
          )
         left join public.market_stats ms
           on ms.chain_id = c.chain_id and ms.campaign_address = c.campaign_address
        where th.chain_id = $1
          and th.balance_raw > 0
          and (th.wallet = $2 or lower(th.wallet) = lower($2))
        order by th.balance_raw desc
        limit 80`,
      [chainId, address],
    );
    return rows;
  } catch (e) {
    if (e?.code === "42P01" || e?.code === "42703") return [];
    throw e;
  }
}

function holdingValue(row, nativeUsd) {
  const formatted = String(row.balanceFormatted || "0");
  const balance = Number.parseFloat(formatted);
  if (!Number.isFinite(balance) || balance <= 0) return 0;
  // Indexed price per whole token first (market_stats), then the native price, then the old
  // market-cap / 1B estimate.
  const priceUsd = Number(row.last_price_usd || 0);
  if (Number.isFinite(priceUsd) && priceUsd > 0) return balance * priceUsd;
  const priceNative = Number(row.last_price_bnb || 0);
  if (Number.isFinite(priceNative) && priceNative > 0 && nativeUsd > 0) return balance * priceNative * nativeUsd;
  return calculateHoldingValueUsd(formatted, Number(row.marketcap_bnb || 0), nativeUsd);
}

// Imported coins (arena_token_imports) with their DEX price (arena_import_market_stats).
async function loadImportsByMints(chainId, mints) {
  if (!mints.length) return [];
  try {
    const { rows } = await pool.query(
      `select i.token_address, i.name, i.symbol, i.image_url, s.price_usd, s.market_cap_usd
         from public.arena_token_imports i
         left join public.arena_import_market_stats s
           on s.chain_id = i.chain_id and s.token_address = i.token_address
        where i.chain_id = $1 and i.token_address = any($2::text[])`,
      [chainId, mints],
    );
    return rows;
  } catch (e) {
    if (e?.code === "42P01" || e?.code === "42703") return [];
    throw e;
  }
}

// Name, logo and USD price for any Solana token Jupiter lists (founder, 2026-10-03: every coin in the
// wallet shows, not only ours). One request per 100 mints; a slow or failing Jupiter just leaves them bare.
async function loadJupiterTokens(mints) {
  const out = new Map();
  const key = String(process.env.JUPITER_API_KEY || "").trim();
  const base = key ? "https://api.jup.ag/tokens/v2" : "https://lite-api.jup.ag/tokens/v2";
  for (let i = 0; i < mints.length; i += 100) {
    const batch = mints.slice(i, i + 100);
    try {
      const res = await fetch(`${base}/search?query=${encodeURIComponent(batch.join(","))}`, {
        headers: key ? { "x-api-key": key } : {},
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) continue;
      const list = await res.json();
      for (const t of Array.isArray(list) ? list : []) if (t?.id) out.set(String(t.id), t);
    } catch {
      // leave these tokens without metadata
    }
  }
  return out;
}

// Native-coin wrappers and stablecoins, flagged so the owner can hide them from the list (founder,
// 2026-10-03). Mints/addresses first, symbols as the fallback for anything not listed here.
const WRAPPED_NATIVE = new Set([
  "So11111111111111111111111111111111111111112", // WSOL
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB (BNB Chain)
]);
const STABLE_ADDRESSES = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC (Solana)
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT (Solana)
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD (Solana)
  "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", // USD1 (Solana)
  "0x55d398326f99059ff775485246999027b3197955", // USDT (BNB Chain)
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC (BNB Chain)
  "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409", // FDUSD (BNB Chain)
  "0xe9e7cea3dedca5984780bafc599bd69add087d56", // BUSD (BNB Chain)
]);
const STABLE_SYMBOLS = new Set(["USDC", "USDT", "USD1", "PYUSD", "DAI", "FDUSD", "BUSD", "USDS", "USDE", "TUSD", "USDP", "USDG"]);
const WRAPPED_SYMBOLS = new Set(["WSOL", "WBNB", "WETH"]);
const addrKey = (a) => { const t = String(a || "").trim(); return t.startsWith("0x") ? t.toLowerCase() : t; };
function holdingFlags(mint, ticker) {
  const sym = String(ticker || "").toUpperCase();
  return {
    native: WRAPPED_NATIVE.has(addrKey(mint)) || WRAPPED_SYMBOLS.has(sym),
    stable: STABLE_ADDRESSES.has(addrKey(mint)) || STABLE_SYMBOLS.has(sym),
  };
}

const positive = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null);

// JSON-RPC method is getTokenAccountsByOwner with jsonParsed encoding (CO-22: the web3.js helper name
// getParsedTokenAccountsByOwner is not an RPC method, so every Solana wallet showed 0 coins).
async function scanSolana(address, nativeUsd) {
  const [lamports, classic, token2022] = await Promise.all([
    solanaRpc("getBalance", [address, { commitment: "confirmed" }]),
    solanaRpc("getTokenAccountsByOwner", [address, { programId: TOKEN_PROGRAM }, { encoding: "jsonParsed" }]).catch(() => ({ value: [] })),
    solanaRpc("getTokenAccountsByOwner", [address, { programId: TOKEN_2022_PROGRAM }, { encoding: "jsonParsed" }]).catch(() => ({ value: [] })),
  ]);
  const native = Number(lamports?.value ?? lamports ?? 0) / 1_000_000_000;
  const accounts = [...(classic?.value || []), ...(token2022?.value || [])];
  const owned = [];
  for (const item of accounts) {
    const info = item?.account?.data?.parsed?.info;
    const mint = String(info?.mint || "").trim();
    const ui = Number(info?.tokenAmount?.uiAmount ?? 0);
    if (!mint || !(ui > 0)) continue;
    owned.push({
      mint,
      ticker: mint.slice(0, 4),
      balanceFormatted: String(info?.tokenAmount?.uiAmountString || ui),
      valueUsd: 0,
    });
  }
  const campaigns = await loadCampaignsByMints(101, owned.map((h) => h.mint));
  const byMint = new Map();
  for (const row of campaigns) {
    if (row.token_address) byMint.set(row.token_address, row);
    if (row.campaign_address) byMint.set(row.campaign_address, row);
  }
  const notLaunched = owned.filter((h) => !byMint.get(h.mint)).map((h) => h.mint);
  const imports = new Map((await loadImportsByMints(101, notLaunched)).map((r) => [String(r.token_address), r]));
  const WSOL = "So11111111111111111111111111111111111111112";
  const jupiter = await loadJupiterTokens([...new Set([WSOL, ...owned.map((h) => h.mint).filter((m) => !byMint.get(m) || !positive(byMint.get(m)?.last_price_usd))])]);
  // Each holding says where it comes from (founder, 2026-10-03): launched here, imported here, or any other
  // token in the wallet. Launched and imported both count as MemeWarzone coins.
  const holdings = owned.map((h) => {
    const campaign = byMint.get(h.mint);
    const imported = campaign ? null : imports.get(h.mint);
    const jup = jupiter.get(h.mint);
    const balance = Number.parseFloat(h.balanceFormatted) || 0;
    let valueUsd;
    let priceUsd;
    if (campaign) {
      valueUsd = holdingValue({ ...campaign, balanceFormatted: h.balanceFormatted, marketcap_bnb: campaign?.marketcap_bnb }, nativeUsd);
      if (!(valueUsd > 0) && positive(jup?.usdPrice)) valueUsd = balance * Number(jup.usdPrice);
      priceUsd = balance > 0 && valueUsd > 0 ? valueUsd / balance : null;
    } else {
      priceUsd = positive(imported?.price_usd) ?? positive(jup?.usdPrice);
      valueUsd = priceUsd ? balance * priceUsd : 0;
    }
    return {
      ticker: campaign?.symbol || imported?.symbol || jup?.symbol || h.ticker,
      name: campaign?.name || imported?.name || jup?.name || null,
      image: campaign?.logo_uri || imported?.image_url || jup?.icon || null,
      mint: h.mint,
      campaignAddress: campaign?.campaign_address || null,
      kind: campaign ? "launched" : imported ? "imported" : "other",
      platform: Boolean(campaign || imported),
      marketCapUsd: positive(campaign?.market_cap_usd) ?? positive(imported?.market_cap_usd),
      marketStage: campaign?.market_stage || null,
      balanceFormatted: h.balanceFormatted,
      priceUsd,
      valueUsd,
    };
  });
  // SOL itself as a row in the list (founder: In wallet shows every coin, SOL too). Not part of the
  // holdings that feed the metrics, which already add the native balance.
  const nativeRow = native > 0
    ? { ticker: "SOL", name: "Solana", image: jupiter.get(WSOL)?.icon || null, mint: null, campaignAddress: null, kind: "native", platform: false, balanceFormatted: String(native), priceUsd: nativeUsd || null, valueUsd: native * (nativeUsd || 0) }
    : null;
  return { native, holdings, nativeRow };
}

async function scanEvm(chainId, address, nativeUsd) {
  const provider = await getServerReadProvider(chainId);
  if (!provider) throw new Error("EVM RPC is not configured");
  const nativeWei = await provider.getBalance(address);
  const native = Number(ethers.formatUnits(nativeWei, 18));

  const indexed = await loadIndexedHoldings(chainId, address);
  if (indexed.length) {
    const holdings = indexed.map((row) => {
      const raw = BigInt(String(row.balance_raw || "0").split(".")[0] || "0");
      const formatted = Number(raw) / 1e18;
      const balanceFormatted = Number.isFinite(formatted) ? String(formatted) : "0";
      return {
        ticker: row.symbol || String(row.token_address || "?").slice(0, 6),
        name: row.name || null,
        image: row.logo_uri || null,
        mint: row.token_address || null,
        campaignAddress: row.campaign_address || null,
        kind: row.campaign_address ? "launched" : "other",
        platform: Boolean(row.campaign_address),
        marketCapUsd: positive(row.market_cap_usd),
        marketStage: row.market_stage || null,
        balanceFormatted,
        valueUsd: holdingValue({ ...row, balanceFormatted }, nativeUsd),
      };
    }).filter((h) => Number(h.balanceFormatted) > 0);
    return { native, holdings };
  }

  const { rows } = await pool.query(
    `select c.campaign_address, c.token_address, c.name, c.symbol, c.logo_uri,
            ms.market_cap_bnb as marketcap_bnb, ms.last_price_bnb, ms.last_price_usd
       from public.campaigns c
       left join public.market_stats ms
         on ms.chain_id = c.chain_id and ms.campaign_address = c.campaign_address
      where c.chain_id = $1
        and c.token_address is not null
      order by c.created_at_chain desc nulls last
      limit $2`,
    [chainId, MAX_EVM_SCAN],
  );
  const holdings = [];
  for (const row of rows) {
    const token = String(row.token_address || "").trim();
    if (!isAddress(token)) continue;
    try {
      const erc20 = new ethers.Contract(token, ERC20_ABI, provider);
      const rawBal = await erc20.balanceOf(address);
      if (typeof rawBal !== "bigint" || rawBal <= 0n) continue;
      const decimals = Number(await erc20.decimals().catch(() => 18));
      const symbol = String(await erc20.symbol().catch(() => row.symbol || "???"));
      const formatted = ethers.formatUnits(rawBal, Number.isFinite(decimals) ? decimals : 18);
      holdings.push({
        ticker: symbol || row.symbol || "???",
        name: row.name || null,
        image: row.logo_uri || null,
        mint: token,
        campaignAddress: row.campaign_address || null,
        kind: "launched",
        platform: true,
        balanceFormatted: formatted,
        valueUsd: holdingValue({ ...row, balanceFormatted: formatted }, nativeUsd),
      });
    } catch {
      // skip tokens that cannot be read
    }
  }
  return { native, holdings };
}

async function nativeUsdForChain(chainId) {
  if (isSolanaChain(chainId)) return (await resolveSolUsdPrice().catch(() => null))?.price || 0;
  if (Number(chainId) === 4663 || Number(chainId) === 46630) {
    return (await resolveEthUsdPrice().catch(() => null))?.price || 0;
  }
  return (await resolveBnbUsdPrice().catch(() => null))?.price || 0;
}

async function computePortfolio(chainId, address) {
  const [createdAt, nativeUsd] = await Promise.all([
    loadWalletAge(address),
    nativeUsdForChain(chainId),
  ]);
  const scan = isSolanaChain(chainId) || isSolanaAddress(address)
    ? await scanSolana(address, nativeUsd)
    : await scanEvm(chainId, address, nativeUsd);

  const positiveBalanceCount = scan.holdings.filter((h) => Number.parseFloat(h.balanceFormatted || "0") > 0).length;
  const metrics = derivePortfolioMetrics({
    nativeBnb: scan.native,
    tokenHoldingsWithValues: scan.holdings,
    bnbUsd: nativeUsd,
    createdAt,
    holdingsCount: positiveBalanceCount,
  });
  // Founder 2026-10-03: split held coins into MemeWarzone coins and other tokens (coinsCount stays the total).
  const held = scan.holdings.filter((h) => Number.parseFloat(h.balanceFormatted || "0") > 0);
  const platformCoinsCount = held.filter((h) => h.platform).length;
  // EVM native coin row (Solana builds its own with the SOL icon).
  const evmSymbol = Number(chainId) === 4663 || Number(chainId) === 46630 ? "ETH" : "BNB";
  const nativeRow = scan.nativeRow !== undefined
    ? scan.nativeRow
    : scan.native > 0
      ? { ticker: evmSymbol, name: evmSymbol === "ETH" ? "Ether" : "BNB", image: null, mint: null, campaignAddress: null, kind: "native", platform: false, balanceFormatted: String(scan.native), priceUsd: nativeUsd || null, valueUsd: scan.native * (nativeUsd || 0) }
      : null;
  return {
    metrics: metrics ? { ...metrics, platformCoinsCount, otherTokensCount: held.length - platformCoinsCount } : metrics,
    // The list behind the numbers, highest value first (Command Center Top holdings, profile Coins tab).
    holdings: [...(nativeRow ? [nativeRow] : []), ...held]
      .map((h) => ({
        mint: h.mint || null,
        campaignAddress: h.campaignAddress || null,
        kind: h.kind || (h.platform ? "launched" : "other"),
        platform: Boolean(h.platform),
        ticker: h.ticker || null,
        name: h.name || null,
        image: h.image || null,
        balanceFormatted: h.balanceFormatted,
        priceUsd: h.priceUsd ?? null,
        valueUsd: Number(h.valueUsd) || 0,
        marketCapUsd: h.marketCapUsd ?? null,
        marketStage: h.marketStage || null,
        native: h.kind === "native" || holdingFlags(h.mint, h.ticker).native,
        stable: h.kind !== "native" && holdingFlags(h.mint, h.ticker).stable,
      }))
      .sort((a, b) => b.valueUsd - a.valueUsd)
      .slice(0, 50),
    createdAt,
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);

  try {
    const q = getQuery(req);
    const chainId = Number(q.chainId);
    const raw = String(q.address ?? "").trim();
    const forceRefresh = ["1", "true", "yes"].includes(String(q.forceRefresh || "").toLowerCase());

    if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });

    const addr = normalizeAddress(raw, chainId) || (isSolanaAddress(raw) ? raw : "");
    if (!addr) return json(res, 400, { error: "Invalid address" });
    if (!isSolanaChain(chainId) && !isSolanaAddress(addr) && !isAddress(addr)) {
      return json(res, 400, { error: "Invalid address" });
    }

    const key = `${chainId}:${addr}`;
    if (!forceRefresh) {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_MS) {
        return json(res, 200, { ...hit.payload, cached: true });
      }
    }

    let pending = inflight.get(key);
    if (!pending) {
      pending = computePortfolio(chainId, addr)
        .then((payload) => {
          const body = { metrics: payload.metrics, holdings: payload.holdings || [], warning: null };
          cache.set(key, { at: Date.now(), payload: body });
          if (cache.size > 2_000) cache.delete(cache.keys().next().value);
          return body;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }

    const payload = await pending;
    return json(res, 200, payload);
  } catch (e) {
    console.error("[api/profile/portfolio]", e);
    return json(res, 200, {
      metrics: null,
      warning: "portfolio scan failed",
    });
  }
}
