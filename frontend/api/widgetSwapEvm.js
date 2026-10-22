/**
 * Swap widget on BNB Chain (56) and Robinhood Chain (4663) for every coin that is not a generation 8 coin (2026-10-22):
 * imported coins and graduated MemeWarzone coins trade through the import route, built by this API so the partner
 * build fingerprint exists (api/lib/importSwapFingerprint.js). Generation 8 coins keep their own pool path
 * (api/gen8Swap.js); this module only answers which kind a coin is.
 *
 *   GET  /api/widget/swap/evm/token?chainId&token           kind "gen8" (the gen-8 answer as is), "import" (an imported
 *                                                            coin, or a graduated MemeWarzone coin on a chain whose
 *                                                            import fee splits with the creator), or "memewarzone" (our
 *                                                            own coin the widget does not trade: link to its page)
 *   GET  /api/widget/swap/evm/balances?chainId&wallet&token native and token balance (the widget needs no RPC)
 *   GET  /api/widget/swap/evm/status?chainId&txHash         receipt status
 *   POST /api/widget/swap/quote|build with chainId 56 / 4663  (api/importSwapWidget.js routes them here)
 *
 * Fee: the import route's, from api/importSwap.js. The widget refuses a chain whose fee is not configured
 * (evmImportFeeReady): it never builds a swap without the fee. Partner split (0.25% partner / 0.25% MemeWarzone of
 * the 1%) happens after the swap, off chain, from the ImportFeeVault (realtime-indexer importCreatorFeesEvm.ts).
 */
import { ethers } from "ethers";
import { badMethod, json, readJson } from "../server/http.js";
import {
  assertBscRouteTerms,
  bscBuild,
  bscSellAllowanceStep,
  evmImportFeeReady,
  evmImportFeeTerms,
  gen8ImportRouteRefusal,
  importSwapFeeBps,
  importSwapQuote,
  readSwapInput,
  robinhoodBuildCore,
  slippageBps,
} from "./importSwap.js";
import { gen8ConfigFor } from "./lib/evmGen8Config.js";
import { findGen8Coin } from "./lib/evmGen8Coins.js";
import { gen8SwapStatusCore, gen8SwapTokenCore } from "./gen8Swap.js";

/** Chains the EVM widget box serves (gen-8 on all four; the import route on the two mainnets). */
export const WIDGET_EVM_CHAINS = Object.freeze([56, 97, 4663, 46630]);
export const WIDGET_IMPORT_CHAINS = Object.freeze([56, 4663]);
const NATIVE_SYMBOL = { 56: "BNB", 97: "tBNB", 4663: "ETH", 46630: "ETH" };
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
];
const NON_DEX_MARKET_STAGES = new Set(["BONDING", "LIVE", "ENDED"]);

export class WidgetEvmError extends Error {
  constructor(status, code, message, extra = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

async function defaultProvider(chainId) {
  const { getRpcUrls, getServerReadProvider } = await import("./lib/getServerReadProvider.js");
  return getRpcUrls(chainId).length ? getServerReadProvider(chainId) : null;
}

function parseChain(value, allowed = WIDGET_EVM_CHAINS) {
  const id = Number(value);
  if (!allowed.includes(id)) throw new WidgetEvmError(400, "BAD_CHAIN", `chainId must be one of ${allowed.join(", ")}`);
  return id;
}

function parseAddress(value, label) {
  const raw = String(value || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw) || /^0x0{40}$/i.test(raw)) throw new WidgetEvmError(400, "BAD_ADDRESS", `${label} must be an EVM address`);
  return ethers.getAddress(raw.toLowerCase());
}

async function providerFor(chainId, deps) {
  const provider = await (deps.getProvider || defaultProvider)(chainId);
  if (!provider) throw new WidgetEvmError(503, "RPC_NOT_CONFIGURED", `No RPC is configured for chain ${chainId}.`);
  return provider;
}

export function tokenPageUrl(address, chainId) {
  return `https://app.memewar.zone/token/${String(address).toLowerCase()}?chainId=${Number(chainId)}`;
}

/** The imported coin's MemeWarzone page with its claim dialog open (TokenDetailsEntry ?claim=prompt). */
export function evmImportClaimUrl(address, chainId) {
  return `${tokenPageUrl(address, chainId)}&claim=prompt`;
}

/** Graduated as /api/campaigns decides it for a pre-gen-8 EVM coin (campaigns-base.js DEX_TRADING_SQL, own columns). */
export function evmCampaignGraduated(row) {
  if (!row) return false;
  if (row.graduated_at_chain != null) return true;
  const stage = String(row.market_stage ?? "").trim().toUpperCase();
  return Boolean(stage) && !NON_DEX_MARKET_STAGES.has(stage);
}

/** Our own non-gen-8 coin (gen-6/7 and older) for this address (token or campaign), or null. Never throws. */
export async function memewarzoneEvmCampaign(db, chainId, address) {
  if (!db) return null;
  const { rows } = await db
    .query(
      `select campaign_address, token_address, name, symbol, logo_uri, graduated_at_chain, market_stage, factory_generation
         from public.campaigns
        where chain_id = $1 and (lower(token_address) = $2 or lower(campaign_address) = $2)
        order by created_at desc nulls last
        limit 1`,
      [Number(chainId), String(address).toLowerCase()],
    )
    .catch(() => ({ rows: [] }));
  return rows[0] || null;
}

async function importRow(db, chainId, address) {
  if (!db) return null;
  const { rows } = await db
    .query(
      `select name, symbol, image_url, ownership_status from public.arena_token_imports
        where chain_id = $1 and lower(token_address) = $2
        order by (ownership_status = 'ownership_verified') desc limit 1`,
      [Number(chainId), String(address).toLowerCase()],
    )
    .catch(() => ({ rows: [] }));
  return rows[0] || null;
}

async function erc20Facts(provider, token) {
  const erc20 = new ethers.Contract(token, ERC20_ABI, provider);
  let decimals;
  try {
    decimals = Number(await erc20.decimals());
  } catch {
    throw new WidgetEvmError(404, "NOT_A_TOKEN", "This address is not a token on this chain.");
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new WidgetEvmError(404, "NOT_A_TOKEN", "This token's decimals are not supported.");
  const [name, symbol] = await Promise.all([erc20.name().catch(() => null), erc20.symbol().catch(() => null)]);
  return { decimals, name: name ? String(name) : null, symbol: symbol ? String(symbol) : null };
}

/**
 * What the EVM widget box trades for this address. Order: gen-8 (DB row or the hook) first, so a gen-8 coin never
 * reaches the import route; then our own older coins (bonding: not here; graduated: the import route only when the
 * chain's import fee splits with the creator, as the app's graduatedEvmTradeRoute); then everything else as an import.
 */
export async function evmWidgetTokenCore(input, deps = {}) {
  const env = deps.env || process.env;
  const chainId = parseChain(input.chainId);
  const token = parseAddress(input.token, "token");
  const db = deps.db ?? null;
  const getProvider = async (id) => providerFor(id, deps);
  const nativeSymbol = NATIVE_SYMBOL[chainId] || "ETH";

  if ((deps.gen8Config || gen8ConfigFor)(chainId, env)) {
    const coin = await (deps.findGen8Coin || findGen8Coin)({ chainId, address: token, db, getProvider, env });
    if (coin) return { ...(await (deps.gen8TokenCore || gen8SwapTokenCore)({ chainId, token }, { db, getProvider, env })), kind: "gen8" };
  }

  const isImportChain = WIDGET_IMPORT_CHAINS.includes(chainId);
  const terms = evmImportFeeTerms(chainId, env);
  const feeReady = isImportChain && evmImportFeeReady(chainId, env);
  const campaign = await memewarzoneEvmCampaign(db, chainId, token);
  if (campaign) {
    const pageUrl = tokenPageUrl(campaign.campaign_address || token, chainId);
    const tradeToken = campaign.token_address ? parseAddress(campaign.token_address, "token") : token;
    const base = { chainId, token: tradeToken, name: campaign.name || null, symbol: campaign.symbol || null, imageUrl: campaign.logo_uri || null, nativeSymbol, pageUrl, claimUrl: null };
    const graduated = evmCampaignGraduated(campaign);
    // A graduated coin only trades on terms that carry the creator's half (assertGraduatedImportQuote in the app).
    if (!graduated || !feeReady || !(terms.creatorShareBps > 0)) {
      return { ...base, kind: "memewarzone", decimals: 18, graduated, tradable: false, reason: graduated ? "graduated" : "bonding", feeBps: null };
    }
    const facts = await erc20Facts(await getProvider(chainId), tradeToken);
    return { ...base, kind: "import", graduated: true, decimals: facts.decimals, tradable: true, reason: null, feeBps: terms.feeBps, creatorShareBps: terms.creatorShareBps };
  }

  const facts = await erc20Facts(await getProvider(chainId), token);
  const row = await importRow(db, chainId, token);
  return {
    chainId,
    token,
    kind: "import",
    decimals: facts.decimals,
    name: row?.name || facts.name,
    symbol: row?.symbol || facts.symbol,
    imageUrl: row?.image_url || null,
    nativeSymbol,
    // Unclaimed imported coin with a MemeWarzone page: one line under the box links to its claim dialog.
    claimUrl: row && row.ownership_status !== "ownership_verified" ? evmImportClaimUrl(token, chainId) : null,
    feeBps: feeReady ? terms.feeBps : null,
    creatorShareBps: feeReady ? terms.creatorShareBps : 0,
    tradable: feeReady,
    reason: feeReady ? null : isImportChain ? "fee" : "chain",
    pageUrl: tokenPageUrl(token, chainId),
  };
}

export async function evmWidgetBalancesCore(input, deps = {}) {
  const chainId = parseChain(input.chainId);
  const token = parseAddress(input.token, "token");
  const wallet = parseAddress(input.wallet, "wallet");
  const provider = await providerFor(chainId, deps);
  const [nativeRaw, tokenRaw] = await Promise.all([provider.getBalance(wallet), new ethers.Contract(token, ERC20_ABI, provider).balanceOf(wallet)]);
  return { chainId, nativeRaw: BigInt(nativeRaw).toString(), tokenRaw: BigInt(tokenRaw).toString() };
}

export async function evmWidgetStatusCore(input, deps = {}) {
  const chainId = parseChain(input.chainId);
  return gen8SwapStatusCore({ chainId, txHash: input.txHash }, { getProvider: async (id) => providerFor(id, deps) });
}

/**
 * The token endpoint's rule, repeated for quote and build: one of our own older coins goes through the import route
 * only when it has graduated and the chain's import terms carry the creator's share. Else a 409 with the page link.
 */
export async function assertWidgetImportRoute(input, deps = {}) {
  const env = deps.env || process.env;
  const db = deps.db === undefined ? await defaultDb() : deps.db;
  const campaign = await memewarzoneEvmCampaign(db, input.chainId, input.token);
  if (!campaign) return;
  const pageUrl = tokenPageUrl(campaign.campaign_address || input.token, input.chainId);
  if (!evmCampaignGraduated(campaign)) {
    throw new WidgetEvmError(409, "MEMEWARZONE_BONDING", "This coin is on its MemeWarzone bonding curve. Trade it on its MemeWarzone page.", { pageUrl });
  }
  if (!(evmImportFeeTerms(input.chainId, env).creatorShareBps > 0)) {
    throw new WidgetEvmError(409, "GRADUATED_IMPORT_FEE_OFF", "This coin is not tradable here yet. Trade it on its MemeWarzone page.", { pageUrl });
  }
}

async function defaultDb() {
  try {
    return (await import("../server/db.js")).pool || null;
  } catch {
    return null;
  }
}

/**
 * The widget's import build on 56 / 4663. Checked in this order before anything is built or recorded: the input
 * (chain, side, token), the chain's fee terms, the gen-8 refusal, the wallet. Then per chain:
 *   4663  robinhoodBuildCore (fee terms again, fresh quote, allowance check, build, self-check, fingerprint)
 *   56    the Kyber route's fee terms (assertBscRouteTerms), a sell's allowance to the Kyber router (exact amount,
 *         as the app), then bscBuild (terms again, Kyber build, fingerprint).
 * The allowance answers record no fingerprint.
 */
export async function evmWidgetBuildCore(body, deps = {}) {
  const env = deps.env || process.env;
  parseChain(body?.chainId, WIDGET_IMPORT_CHAINS);
  const input = readSwapInput(body);
  if (!evmImportFeeReady(input.chainId, env)) throw new WidgetEvmError(503, "IMPORT_SWAP_FEE_NOT_CONFIGURED", "Swaps for this coin are paused here: the fee route is not configured.");
  const refusal = await (deps.gen8Refusal || gen8ImportRouteRefusal)(input);
  if (refusal) throw new WidgetEvmError(409, refusal.code, refusal.error, refusal);
  await (deps.importRoute || assertWidgetImportRoute)(input, deps);
  const wallet = String(body.wallet || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new WidgetEvmError(400, "BAD_WALLET", "Invalid wallet");
  const slippage = slippageBps(body.slippageBps);
  if (input.chainId === 4663) {
    return (deps.robinhoodBuild || robinhoodBuildCore)({ ...input, wallet, amountRaw: body.amountRaw ?? body.quote?.amountIn, slippage, partner: body.partner || null }, deps);
  }
  assertBscRouteTerms(body.quote, { token: input.token, side: input.side });
  // Dust: a swap whose fee rounds to 0 wei is refused. Buy: the BNB in. Sell: Kyber's BNB out (after the fee, so a
  // little stricter than the gross).
  const bps = BigInt(importSwapFeeBps(56, env));
  const feeBase = String(input.side === "buy" ? body.quote?.amountIn ?? "" : body.quote?.amountOut ?? "");
  if (!/^\d+$/.test(feeBase) || (BigInt(feeBase) * bps) / 10_000n < 1n) throw new WidgetEvmError(400, "AMOUNT_TOO_SMALL", "Amount too small");
  if (input.side === "sell") {
    const raw = String(body.quote?.amountIn ?? "");
    if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) throw new WidgetEvmError(400, "BAD_AMOUNT", "The quote has no sell amount");
    const approval = await (deps.bscSellAllowanceStep || bscSellAllowanceStep)({ token: input.token, wallet, amountIn: BigInt(raw) }, deps);
    if (approval) return { chainId: 56, needsAllowance: true, approval, permit2Approval: null, quote: body.quote };
  }
  return (deps.bscBuild || bscBuild)({ ...input, wallet, quote: body.quote, slippage, partner: body.partner || null }, deps);
}

function query(req) {
  return req.query || Object.fromEntries(new URL(String(req.url || ""), "http://x").searchParams);
}

function sendError(res, error, label) {
  if (error instanceof WidgetEvmError) {
    const extra = error.extra && typeof error.extra === "object" ? { tradePath: error.extra.tradePath ?? undefined, pageUrl: error.extra.pageUrl ?? undefined } : {};
    return json(res, error.status, { ok: false, error: error.message, code: error.code, ...extra });
  }
  if (error?.status) return json(res, error.status, { ok: false, error: String(error.message || "Request failed"), code: error.code || null });
  console.error(`[api/widget/evm] ${label}`, error);
  return json(res, 502, { ok: false, error: "The swap service could not answer. Try again.", code: "WIDGET_EVM_FAILED" });
}

function getHandler(core, cache, label) {
  return async (req, res) => {
    if (req.method !== "GET") return badMethod(res);
    try {
      const db = core === evmWidgetTokenCore ? (await import("../server/db.js")).pool || null : null;
      const out = await core(query(req), { db });
      res.setHeader("cache-control", typeof cache === "function" ? cache(out) : cache);
      return json(res, 200, { ok: true, ...out });
    } catch (error) {
      return sendError(res, error, label);
    }
  };
}

/** A gen-8 coin's answer changes with its pool (phase, fee, opening): 15 s, as gen8SwapToken. Everything else 60 s. */
export function evmWidgetTokenCache(out) {
  return out?.kind === "gen8" ? "public, max-age=15" : "public, max-age=60";
}

export const evmWidgetToken = getHandler(evmWidgetTokenCore, evmWidgetTokenCache, "token");
export const evmWidgetBalances = getHandler(evmWidgetBalancesCore, "no-store", "balances");
export const evmWidgetStatus = getHandler(evmWidgetStatusCore, "no-store", "status");

/** POST /api/widget/swap/quote for 56 / 4663: the fee check, then the shared import quote (= /api/imports/swap/quote). */
export async function evmWidgetQuote(req, res) {
  const body = req.body && typeof req.body === "object" ? req.body : await readJson(req);
  if (!WIDGET_IMPORT_CHAINS.includes(Number(body?.chainId))) return json(res, 400, { ok: false, error: "chainId must be 56 or 4663", code: "BAD_CHAIN" });
  if (!evmImportFeeReady(Number(body.chainId))) {
    return json(res, 503, { ok: false, error: "Swaps for this coin are paused here: the fee route is not configured.", code: "IMPORT_SWAP_FEE_NOT_CONFIGURED" });
  }
  try {
    await assertWidgetImportRoute(readSwapInput(body));
  } catch (error) {
    // A bad input is the shared handler's to answer (same message as the app's route).
    if (error instanceof WidgetEvmError) return sendError(res, error, "quote");
  }
  req.body = body;
  return importSwapQuote(req, res);
}

/** POST /api/widget/swap/build for 56 / 4663 (evmWidgetBuildCore). */
export async function evmWidgetBuild(req, res) {
  if (req.method !== "POST") return badMethod(res);
  try {
    const body = req.body && typeof req.body === "object" ? req.body : await readJson(req);
    const out = await evmWidgetBuildCore(body || {});
    res.setHeader("cache-control", "no-store");
    return json(res, 200, { ok: true, ...out });
  } catch (error) {
    return sendError(res, error, "build");
  }
}
