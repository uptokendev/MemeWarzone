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
            ms.market_cap_bnb as marketcap_bnb, ms.last_price_bnb, ms.last_price_usd
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
              ms.market_cap_bnb as marketcap_bnb, ms.last_price_bnb, ms.last_price_usd
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
  const holdings = owned.map((h) => {
    const campaign = byMint.get(h.mint);
    const ticker = campaign?.symbol || h.ticker;
    const valued = {
      ticker,
      balanceFormatted: h.balanceFormatted,
      valueUsd: holdingValue(
        { ...campaign, balanceFormatted: h.balanceFormatted, marketcap_bnb: campaign?.marketcap_bnb },
        nativeUsd,
      ),
    };
    return valued;
  });
  return { native, holdings };
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
  return { metrics, createdAt };
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
          const body = { metrics: payload.metrics, warning: null };
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
