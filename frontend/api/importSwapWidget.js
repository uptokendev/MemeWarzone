/**
 * API for the embeddable swap widget (frontend/src/widget, served as app.memewar.zone/widget/mwz-swap.js).
 * Any website can mount the widget for a Solana coin; its swaps run through the same quote/build as
 * the app (api/importSwap.js), so the 1% fee (half to the coin's creator) is enforced here, not in
 * the widget. A host that edits the widget script can only skip our route, never our fee on it.
 *
 * Routes under /api/widget/swap/ answer every origin, without cookies or credentials (the widget
 * never sends any), and are rate limited per IP. The rest of the API keeps its origin allow-list.
 *   GET  token?mint=          name, symbol, image (imported coins), decimals from chain, fee
 *   GET  balances?wallet&mint SOL and token balance (so the widget needs no RPC of its own)
 *   POST quote                = /api/imports/swap/quote, Solana only
 *   POST build                = /api/imports/swap/build, Solana only
 *   GET  status?signature=    confirmation of the wallet-sent swap
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { pool } from "../server/db.js";
import { badMethod, json, readJson } from "../server/http.js";
import { importSwapBuild, importSwapFeeBps, importSwapQuote } from "./importSwap.js";

const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
const WINDOW_MS = 60_000;
export const WIDGET_REQUESTS_PER_MINUTE = Math.max(10, Number(process.env.WIDGET_REQUESTS_PER_MINUTE || 120));

function solanaConnection() {
  const url = String(process.env.SOLANA_RPC_URL || process.env.VITE_SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com").trim();
  return new Connection(url, "confirmed");
}

function isSolanaAddress(value) {
  try {
    return new PublicKey(String(value || "").trim()).toBase58() === String(value || "").trim();
  } catch {
    return false;
  }
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return (forwarded || req.ip || req.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "");
}

/** Fixed one-minute window per IP. In memory: one API process; a restart forgives. */
export function widgetRateLimiter({ limit = WIDGET_REQUESTS_PER_MINUTE, now = () => Date.now() } = {}) {
  const hits = new Map();
  return function allow(ip) {
    const t = now();
    const entry = hits.get(ip);
    if (!entry || t - entry.start >= WINDOW_MS) {
      hits.set(ip, { start: t, count: 1 });
      if (hits.size > 50_000) for (const [key, value] of hits) if (t - value.start >= WINDOW_MS) hits.delete(key);
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

const allow = widgetRateLimiter();

/** Express middleware for /api/widget/*: open CORS without credentials, preflight, rate limit. */
export function widgetCors(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!allow(clientIp(req))) return json(res, 429, { ok: false, error: "Too many requests; try again in a minute." });
  return next();
}

function query(req) {
  return req.query || Object.fromEntries(new URL(String(req.url || ""), "http://x").searchParams);
}

export async function widgetToken(req, res) {
  if (req.method !== "GET") return badMethod(res);
  const mint = String(query(req).mint || "").trim();
  if (!isSolanaAddress(mint)) return json(res, 400, { ok: false, error: "mint must be a Solana token address" });
  try {
    const info = await solanaConnection().getParsedAccountInfo(new PublicKey(mint));
    const decimals = info.value?.data?.parsed?.info?.decimals;
    if (!Number.isInteger(decimals) || !TOKEN_PROGRAMS.includes(info.value.owner.toBase58())) return json(res, 404, { ok: false, error: "Not a token mint" });
    let project = null;
    if (pool) {
      const { rows } = await pool.query(
        `select name, symbol, image_url from public.arena_token_imports where chain_id = 101 and token_address = $1
          order by (ownership_status = 'ownership_verified') desc limit 1`,
        [mint],
      ).catch(() => ({ rows: [] }));
      project = rows[0] || null;
    }
    res.setHeader("cache-control", "public, max-age=300");
    return json(res, 200, {
      ok: true,
      chainId: 101,
      mint,
      decimals,
      name: project?.name || null,
      symbol: project?.symbol || null,
      imageUrl: project?.image_url || null,
      feeBps: importSwapFeeBps(101),
      pageUrl: `https://app.memewar.zone/token/${mint}?chainId=101`,
    });
  } catch (error) {
    console.error("[api/widget] token", error);
    return json(res, 502, { ok: false, error: "Token lookup failed" });
  }
}

export async function widgetBalances(req, res) {
  if (req.method !== "GET") return badMethod(res);
  const { wallet, mint } = query(req);
  if (!isSolanaAddress(wallet) || !isSolanaAddress(mint)) return json(res, 400, { ok: false, error: "wallet and mint are required" });
  try {
    const connection = solanaConnection();
    const owner = new PublicKey(String(wallet));
    const [lamports, accounts] = await Promise.all([
      connection.getBalance(owner, "confirmed"),
      connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(String(mint)) }, "confirmed"),
    ]);
    const tokenRaw = accounts.value.reduce((sum, account) => sum + BigInt(account.account.data?.parsed?.info?.tokenAmount?.amount || "0"), 0n);
    res.setHeader("cache-control", "no-store");
    return json(res, 200, { ok: true, lamports: String(lamports), tokenRaw: tokenRaw.toString() });
  } catch (error) {
    console.error("[api/widget] balances", error);
    return json(res, 502, { ok: false, error: "Balance lookup failed" });
  }
}

/** The widget only swaps Solana coins; the shared handlers do the rest (fee terms included). */
function solanaOnly(handler) {
  return async (req, res) => {
    if (req.method !== "POST") return badMethod(res);
    const body = await readJson(req).catch(() => null);
    if (!body || Number(body.chainId) !== 101) return json(res, 400, { ok: false, error: "The widget swaps Solana coins (chainId 101)" });
    // readJson consumed the stream; hand the parsed body to the shared handler.
    req.body = body;
    return handler(req, res);
  };
}

export const widgetQuote = solanaOnly(importSwapQuote);
export const widgetBuild = solanaOnly(importSwapBuild);

export async function widgetStatus(req, res) {
  if (req.method !== "GET") return badMethod(res);
  const signature = String(query(req).signature || "").trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) return json(res, 400, { ok: false, error: "signature required" });
  try {
    const { value } = await solanaConnection().getSignatureStatuses([signature], { searchTransactionHistory: false });
    const status = value[0];
    res.setHeader("cache-control", "no-store");
    return json(res, 200, { ok: true, confirmation: status?.confirmationStatus || null, err: status?.err || null });
  } catch (error) {
    console.error("[api/widget] status", error);
    return json(res, 502, { ok: false, error: "Status lookup failed" });
  }
}
