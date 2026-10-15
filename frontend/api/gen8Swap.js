/**
 * Swap widget trades of EVM generation 8 coins (D9, founder 2026-10-11): the API builds the UniversalRouter V4_SWAP
 * call, exactly as it builds an import swap for the widget today, so the partner build fingerprint keeps working. When
 * the widget names a partner (import_fee_partners, active on the chain), the API records keccak256(to:data:value) of
 * what it built (api/lib/importSwapFingerprint.js); the gen-8 finance view links a landed swap to that partner by
 * computing the same fingerprint from the transaction (api/lib/financeGen8.js gen8PartnerSwaps).
 *
 * The fee itself is the hook's (2% bonding, 1% after graduation, half to the creator), taken on chain from every swap
 * in the pool whatever built it; the partner's 0.25% of a graduated swap is paid off chain from MemeWarzone's 0.50%.
 * The app builds its own gen-8 trades with the same encoder (shared/evmGen8Swap.mjs, src/lib/evmGen8Client.mjs).
 *
 * Routes (under /api/widget, open CORS without credentials, rate limited; api/importSwapWidget.js widgetCors):
 *   GET  /api/widget/swap/gen8/token?chainId&token          the coin (name, symbol, image, phase, fee now)
 *   GET  /api/widget/swap/gen8/balances?chainId&wallet&token native and coin balance (the widget needs no RPC)
 *   POST /api/widget/swap/gen8/quote                         V4Quoter quote, exact input, with the fee split
 *   POST /api/widget/swap/gen8/build                         router call { to, data, value }; a sell first answers
 *                                                            needsPermit with the approval and the Permit2 typed data
 *   GET  /api/widget/swap/gen8/status?chainId&txHash          receipt status of the wallet-sent swap
 * Configured per chain by the API's EVM_GEN8_* env (evmGen8Config.js) plus EVM_GEN8_UNIVERSAL_ROUTER_<id> /
 * EVM_GEN8_V4_QUOTER_<id> (defaults on 56 / 4663, shared/evmGen8Swap.mjs). Nothing here signs or holds money.
 */
import { ethers } from "ethers";
import { badMethod, json, readJson } from "../server/http.js";
import { GEN8_REVERTS, GEN8_TOTAL_SUPPLY, gen8FeeRate, gen8PoolId, gen8PoolKey, sqrtAtTick } from "../shared/evmGen8.mjs";
import {
  GEN8_REFERRER_WIDGET,
  GEN8_SWAP_DEADLINE_SECONDS,
  PERMIT2_ABI,
  PERMIT2_ADDRESS,
  V4_QUOTER_ABI,
  assertGen8NativeRefund,
  buildGen8RouterCall,
  decodeGen8RouterCall,
  gen8BuyFeeSplit,
  gen8CreatorShareWei,
  gen8HookData,
  gen8MinOut,
  gen8PermitTypedData,
  gen8PriceImpactBps,
  gen8QuoterFor,
  gen8ReferenceAmount,
  gen8RouterFor,
  gen8SellFeeSplit,
  gen8SizedSlippageBps,
  permitFromJson,
} from "../shared/evmGen8Swap.mjs";
import { gen8V4ConfigFor } from "./lib/evmGen8Config.js";
import { evmFingerprint } from "./lib/importSwapFingerprint.js";

const HOOK_ABI = [
  "function pools(bytes32) view returns (address creator, uint40 openAt, bool graduated, int24 tickGrad, int24 tickStart, uint128 liqA, uint128 liqB, uint160 sqrtGrad, tuple(uint16 bondingBps, uint16 postBps, uint16 creatorPostBps, uint16 sniperStartBps, uint16 creatorBondingBps) fees, uint40 graduatedAt)",
];
const LENS_ABI = [
  "function currentFeeBps(bytes32 id, address sender) view returns (uint256)",
  "function previewFill(bytes32 id, bool zeroForOne, int256 amountSpecified, uint160 limit) view returns (uint256)",
  "function tradingOpen(bytes32 id) view returns (bool open, uint256 openAt)",
  "function progress(bytes32 id) view returns (tuple(bool graduated, bool postPhase, uint40 graduatedAt, uint160 sqrtPriceX96, uint256 coinsSoldFromA, uint256 coinsInA, uint256 nativeInA, uint256 nativeTargetA))",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
];
const ERC20_IFACE = new ethers.Interface(["function approve(address spender, uint256 value) returns (bool)"]);
const NATIVE_SYMBOL = { 56: "BNB", 97: "tBNB", 4663: "ETH", 46630: "ETH", 31337: "ETH" };

export class Gen8SwapError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function defaultProvider(chainId) {
  const { getRpcUrls, getServerReadProvider } = await import("./lib/getServerReadProvider.js");
  return getRpcUrls(chainId).length ? getServerReadProvider(chainId) : null;
}

async function defaultPartnerDeps() {
  const mod = await import("./importSwap.js");
  return { readPartner: mod.readPartner, rememberPartnerSwap: mod.rememberPartnerSwap };
}

/**
 * The chain's gen-8 swap setup for the API: hook, lens, router (+ layout), quoter. Throws when missing. V4 venue
 * only: the widget builds UniversalRouter / Permit2 calls, which a Barkswap chain (DogeOS) has no use for.
 */
export function gen8SwapSetup(chainId, env = process.env) {
  const cfg = gen8V4ConfigFor(chainId, env);
  if (!cfg) throw new Gen8SwapError(400, "GEN8_NOT_CONFIGURED", "Generation 8 coins are not set up on this chain.");
  const router = gen8RouterFor(chainId, env);
  const quoter = gen8QuoterFor(chainId, env);
  if (!router || !quoter) throw new Gen8SwapError(503, "GEN8_ROUTER_NOT_CONFIGURED", "No Uniswap router or quoter is configured for this chain.");
  return { ...cfg, router, quoter };
}

function parseChain(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Gen8SwapError(400, "BAD_CHAIN", "chainId is required");
  return id;
}

function parseAddress(value, label) {
  const raw = String(value || "").trim();
  if (!ethers.isAddress(raw) || /^0x0{40}$/i.test(raw)) throw new Gen8SwapError(400, "BAD_ADDRESS", `${label} must be an EVM address`);
  return ethers.getAddress(raw);
}

function parseAmount(value) {
  try {
    const n = BigInt(String(value ?? "").trim());
    if (n > 0n && n < 1n << 128n) return n;
  } catch {
    // fall through
  }
  throw new Gen8SwapError(400, "BAD_AMOUNT", "amountRaw must be a positive integer");
}

/** null = the chain's default: sized from the price impact on BNB Chain (F13), 1% elsewhere (gen8SizedSlippageBps). */
function parseSlippage(value) {
  if (value === undefined || value === null || value === "" || value === "auto") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 5000) throw new Gen8SwapError(400, "BAD_SLIPPAGE", "slippageBps must be an integer from 0 to 5000");
  return n;
}

function parseSide(value) {
  const side = String(value || "").toLowerCase();
  if (side !== "buy" && side !== "sell") throw new Gen8SwapError(400, "BAD_SIDE", "side must be buy or sell");
  return side;
}

/** The hook's record of the token's pool, or a 404 when the token is not a gen-8 coin of this hook. Decode by name. */
export async function readGen8SwapPool({ provider, setup, token }) {
  const poolId = gen8PoolId(token, setup.hook);
  const p = await new ethers.Contract(setup.hook, HOOK_ABI, provider).pools(poolId);
  const creator = p.creator;
  if (!creator || creator === ethers.ZeroAddress) throw new Gen8SwapError(404, "GEN8_NOT_A_COIN", "This token is not a MemeWarzone generation 8 coin on this chain.");
  const f = p.fees;
  const openAt = Number(p.openAt);
  return {
    poolId,
    poolKey: gen8PoolKey(token, setup.hook),
    openAt,
    launchTime: openAt,
    graduated: Boolean(p.graduated),
    tickStart: Number(p.tickStart),
    tickGrad: Number(p.tickGrad),
    fees: {
      bondingBps: Number(f.bondingBps ?? f[0]),
      postBps: Number(f.postBps ?? f[1]),
      creatorPostBps: Number(f.creatorPostBps ?? f[2]),
      sniperStartBps: Number(f.sniperStartBps ?? f[3]),
      creatorBondingBps: Number(f.creatorBondingBps ?? f[4]),
    },
  };
}

async function feeBpsNow({ provider, setup, pool }) {
  if (setup.lens) return Number(await new ethers.Contract(setup.lens, LENS_ABI, provider).currentFeeBps(pool.poolId, setup.router.address));
  const block = await provider.getBlock("latest");
  return gen8FeeRate({ graduated: pool.graduated, openAt: pool.openAt, nowTs: Number(block.timestamp), fees: pool.fees });
}

async function assertTradingOpen({ provider, setup, pool }) {
  if (setup.lens) {
    const open = await new ethers.Contract(setup.lens, LENS_ABI, provider).tradingOpen(pool.poolId);
    if (!open.open) throw new Gen8SwapError(400, "GEN8_TRADING_NOT_OPEN", GEN8_REVERTS["0xe09f0331"].message);
    return;
  }
  const now = Number((await provider.getBlock("latest")).timestamp);
  if (now < Number(pool.openAt || 0)) throw new Gen8SwapError(400, "GEN8_TRADING_NOT_OPEN", GEN8_REVERTS["0xe09f0331"].message);
}

async function maxSellableCoins({ provider, setup, pool }) {
  if (!setup.lens || pool.tickStart == null) return null;
  return BigInt(
    await new ethers.Contract(setup.lens, LENS_ABI, provider).previewFill(pool.poolId, false, -GEN8_TOTAL_SUPPLY, sqrtAtTick(Number(pool.tickStart))),
  );
}

/**
 * Exact-input quote through the V4Quoter (the same call the app makes), with the fee split and the price impact (a
 * second quote of 1/1000 of the amount in the same block; gen8PriceImpactBps). Without slippageBps the slippage is the
 * chain's default: sized from the price impact on BNB Chain (56, 97), 1% on Robinhood.
 */
export async function gen8SwapQuoteCore(input, deps = {}) {
  const env = deps.env || process.env;
  const chainId = parseChain(input.chainId);
  const setup = gen8SwapSetup(chainId, env);
  const token = parseAddress(input.token, "token");
  const side = parseSide(input.side);
  const amountIn = parseAmount(input.amountRaw);
  const slippageBps = parseSlippage(input.slippageBps);
  const provider = await (deps.getProvider || defaultProvider)(chainId);
  if (!provider) throw new Gen8SwapError(503, "RPC_NOT_CONFIGURED", `No RPC is configured for chain ${chainId}.`);
  const pool = await readGen8SwapPool({ provider, setup, token });
  await assertTradingOpen({ provider, setup, pool });
  if (side === "sell") {
    const max = await maxSellableCoins({ provider, setup, pool });
    if (max != null && amountIn > max) throw new Gen8SwapError(400, "GEN8_SELL_TOO_LARGE", GEN8_REVERTS["0x2fcb916e"].message);
  }
  const key = pool.poolKey;
  const keyTuple = [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks];
  const quoter = new ethers.Contract(setup.quoter, V4_QUOTER_ABI, provider);
  const refIn = gen8ReferenceAmount(amountIn);
  const [feeBps, quoted, refQuoted] = await Promise.all([
    feeBpsNow({ provider, setup, pool }),
    quoter.quoteExactInputSingle
      .staticCall([keyTuple, side === "buy", amountIn, gen8HookData(GEN8_REFERRER_WIDGET)])
      .catch((error) => {
        throw new Gen8SwapError(400, "GEN8_NO_QUOTE", `No quote for this amount (${String(error?.shortMessage || error?.reason || "the pool refused it")}).`);
      }),
    refIn == null ? null : quoter.quoteExactInputSingle.staticCall([keyTuple, side === "buy", refIn, gen8HookData(GEN8_REFERRER_WIDGET)]).catch(() => null),
  ]);
  const amountOut = BigInt(quoted[0] ?? quoted.amountOut);
  const refOut = refQuoted ? BigInt(refQuoted[0] ?? refQuoted.amountOut) : null;
  const priceImpactBps = gen8PriceImpactBps({ amountIn, amountOut, refIn, refOut });
  const slippageAuto = slippageBps == null;
  const slippage = slippageAuto ? gen8SizedSlippageBps({ chainId, priceImpactBps }) : slippageBps;
  const split = side === "buy" ? gen8BuyFeeSplit(amountIn, feeBps) : gen8SellFeeSplit(amountOut, feeBps);
  const creatorShare = gen8CreatorShareWei({ graduated: pool.graduated, curveWei: split.curveWei, feeWei: split.feeWei, creatorBondingBps: pool.fees.creatorBondingBps, creatorPostBps: pool.fees.creatorPostBps });
  return {
    chainId,
    provider: "gen8-v4-pool",
    side,
    token,
    amountIn: amountIn.toString(),
    amountOut: amountOut.toString(),
    minAmountOut: gen8MinOut(amountOut, slippage).toString(),
    slippageBps: slippage,
    slippageAuto,
    feeBps,
    feeNativeRaw: split.feeWei.toString(),
    creatorShareNativeRaw: creatorShare.toString(),
    // bps of volume to the creator (display; the exact amount is creatorShareNativeRaw): 0.5% after graduation,
    // 560 bps of the fee before it
    creatorShareBps: pool.graduated ? pool.fees.creatorPostBps : Math.round((feeBps * pool.fees.creatorBondingBps) / 10_000),
    graduated: pool.graduated,
    phase: pool.graduated ? "graduated" : "bonding",
    poolId: pool.poolId,
    router: setup.router.address,
    priceImpactBps,
    priceImpactPct: priceImpactBps == null ? null : priceImpactBps / 100,
  };
}

/** Checks a Permit2 permit for this sell: our router, this token, exactly this amount, signed by `wallet`, not expired. */
export function assertGen8SellPermit(permit, { chainId, token, amountIn, router, wallet, nowSec }) {
  const p = permit.permitSingle;
  if (p.spender !== router) throw new Gen8SwapError(400, "GEN8_PERMIT_INVALID", "The permit is not for the swap router.");
  if (p.details.token !== token) throw new Gen8SwapError(400, "GEN8_PERMIT_INVALID", "The permit is for another token.");
  if (p.details.amount !== amountIn) throw new Gen8SwapError(400, "GEN8_PERMIT_INVALID", "The permit amount differs from the sell amount.");
  if (p.sigDeadline <= BigInt(nowSec) || p.details.expiration <= BigInt(nowSec)) throw new Gen8SwapError(400, "GEN8_PERMIT_EXPIRED", "The permit has expired. Sign again.");
  const typed = gen8PermitTypedData({ chainId, token, amount: amountIn, nonce: p.details.nonce, spender: router, nowSec: 0 });
  let signer;
  try {
    signer = ethers.verifyTypedData(typed.domain, typed.types, p, permit.signature);
  } catch {
    throw new Gen8SwapError(400, "GEN8_PERMIT_INVALID", "The permit signature is not valid.");
  }
  if (signer !== wallet) throw new Gen8SwapError(400, "GEN8_PERMIT_INVALID", "The permit was not signed by this wallet.");
}

/**
 * The widget's swap: re-quotes, builds the router call, records the partner fingerprint. A sell without a permit
 * answers { needsPermit, approval, permitTypedData } instead (approval = the exact ERC20 approval to Permit2 when the
 * current one is short); the widget sends the approval, signs the typed data and calls build again with the permit.
 */
export async function gen8SwapBuildCore(input, deps = {}) {
  const env = deps.env || process.env;
  const chainId = parseChain(input.chainId);
  const setup = gen8SwapSetup(chainId, env);
  const wallet = parseAddress(input.wallet, "wallet");
  const provider = await (deps.getProvider || defaultProvider)(chainId);
  if (!provider) throw new Gen8SwapError(503, "RPC_NOT_CONFIGURED", `No RPC is configured for chain ${chainId}.`);
  const quote = await gen8SwapQuoteCore(input, { ...deps, env, getProvider: async () => provider });
  const token = quote.token;
  const amountIn = BigInt(quote.amountIn);
  const router = setup.router.address;
  const block = await provider.getBlock("latest");
  const nowSec = Number(deps.nowSec ?? block.timestamp);

  let permit = null;
  if (quote.side === "sell") {
    if (!input.permit) {
      const coin = new ethers.Contract(token, ERC20_ABI, provider);
      const [allowance, p2] = await Promise.all([
        coin.allowance(wallet, PERMIT2_ADDRESS),
        new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider).allowance(wallet, token, router),
      ]);
      const typed = gen8PermitTypedData({ chainId, token, amount: amountIn, nonce: p2[2] ?? p2.nonce, spender: router, nowSec });
      return {
        chainId,
        needsPermit: true,
        approval: BigInt(allowance) < amountIn ? { to: token, data: ERC20_IFACE.encodeFunctionData("approve", [PERMIT2_ADDRESS, amountIn]), value: "0" } : null,
        permitTypedData: {
          domain: typed.domain,
          types: typed.types,
          primaryType: typed.primaryType,
          message: {
            details: { token: typed.message.details.token, amount: typed.message.details.amount.toString(), expiration: typed.message.details.expiration.toString(), nonce: typed.message.details.nonce.toString() },
            spender: typed.message.spender,
            sigDeadline: typed.message.sigDeadline.toString(),
          },
        },
        quote,
      };
    }
    try {
      permit = permitFromJson(input.permit);
    } catch {
      throw new Gen8SwapError(400, "GEN8_PERMIT_INVALID", "The permit is incomplete.");
    }
    assertGen8SellPermit(permit, { chainId, token, amountIn, router, wallet, nowSec });
  }

  const call = buildGen8RouterCall({
    router,
    layout: setup.router.layout,
    poolKey: gen8PoolKey(token, setup.hook),
    side: quote.side,
    exactIn: true,
    amount: amountIn,
    limit: BigInt(quote.minAmountOut),
    deadline: BigInt(nowSec + GEN8_SWAP_DEADLINE_SECONDS),
    hookData: gen8HookData(GEN8_REFERRER_WIDGET),
    permit,
  });
  // What leaves the API is exactly one swap in this coin's pool with the quoted bounds (a self-check of the encoder).
  const decoded = decodeGen8RouterCall(call.data, setup.router.layout);
  if (decoded.swap?.poolKey.currency1 !== token || decoded.swap.poolKey.hooks !== setup.hook || decoded.swap.amount !== amountIn) {
    throw new Gen8SwapError(500, "GEN8_BUILD_MISMATCH", "The swap could not be built.");
  }
  // F14: a native buy never leaves unspent native in the router (exact output ends with SWEEP to the payer).
  try {
    assertGen8NativeRefund(decoded);
  } catch {
    throw new Gen8SwapError(500, "GEN8_BUILD_MISMATCH", "The swap could not be built.");
  }

  let partnerId = null;
  if (input.partner) {
    const partnerDeps = deps.readPartner ? deps : await defaultPartnerDeps();
    const partner = await partnerDeps.readPartner(input.partner, chainId);
    if (partner) {
      partnerId = partner.id;
      await partnerDeps.rememberPartnerSwap({ fingerprint: evmFingerprint(call.to, call.data, call.value), chainId, partnerId, wallet, token: token.toLowerCase() });
    }
  }

  return {
    chainId,
    provider: "gen8-v4-pool",
    to: call.to,
    data: call.data,
    value: call.value.toString(),
    router,
    layout: setup.router.layout,
    deadline: call.deadline.toString(),
    partner: partnerId,
    quote,
  };
}

/** What the widget shows for a gen-8 coin (name, symbol, image from the campaigns row; else the token itself). */
export async function gen8SwapTokenCore(input, deps = {}) {
  const env = deps.env || process.env;
  const chainId = parseChain(input.chainId);
  const setup = gen8SwapSetup(chainId, env);
  const token = parseAddress(input.token, "token");
  const provider = await (deps.getProvider || defaultProvider)(chainId);
  if (!provider) throw new Gen8SwapError(503, "RPC_NOT_CONFIGURED", `No RPC is configured for chain ${chainId}.`);
  const pool = await readGen8SwapPool({ provider, setup, token });
  const block = await provider.getBlock("latest");
  const now = Number(block.timestamp);
  let tradingOpen = now >= Number(pool.openAt || 0);
  let postPhase = null;
  if (setup.lens) {
    const lens = new ethers.Contract(setup.lens, LENS_ABI, provider);
    const [openR, progR] = await Promise.all([lens.tradingOpen(pool.poolId).catch(() => null), lens.progress(pool.poolId).catch(() => null)]);
    if (openR) tradingOpen = Boolean(openR.open);
    if (progR) postPhase = Boolean(progR.postPhase);
  }
  const platformGraduated = Boolean(pool.graduated && postPhase === true);
  let row = null;
  if (deps.db) {
    const { rows } = await deps.db
      .query(`select name, symbol, logo_uri from public.campaigns where chain_id = $1 and (campaign_address = $2 or token_address = $2) limit 1`, [chainId, token.toLowerCase()])
      .catch(() => ({ rows: [] }));
    row = rows[0] || null;
  }
  const erc20 = new ethers.Contract(token, ERC20_ABI, provider);
  const [name, symbol, feeBps, maxSellable] = await Promise.all([
    row?.name ? row.name : erc20.name().catch(() => null),
    row?.symbol ? row.symbol : erc20.symbol().catch(() => null),
    feeBpsNow({ provider, setup, pool }),
    maxSellableCoins({ provider, setup, pool }).catch(() => null),
  ]);
  return {
    chainId,
    token,
    kind: "gen8",
    decimals: 18,
    totalSupply: GEN8_TOTAL_SUPPLY.toString(),
    name: name || null,
    symbol: symbol || null,
    imageUrl: row?.logo_uri || null,
    nativeSymbol: NATIVE_SYMBOL[chainId] || "ETH",
    tradable: tradingOpen,
    tradingOpen,
    openAt: Number(pool.openAt || 0),
    graduated: platformGraduated,
    phase: platformGraduated ? "graduated" : "bonding",
    feeBps,
    maxSellable: maxSellable != null ? maxSellable.toString() : null,
    router: setup.router.address,
    pageUrl: `https://app.memewar.zone/token/${token.toLowerCase()}?chainId=${chainId}`,
  };
}

export async function gen8SwapBalancesCore(input, deps = {}) {
  const env = deps.env || process.env;
  const chainId = parseChain(input.chainId);
  gen8SwapSetup(chainId, env);
  const token = parseAddress(input.token, "token");
  const wallet = parseAddress(input.wallet, "wallet");
  const provider = await (deps.getProvider || defaultProvider)(chainId);
  if (!provider) throw new Gen8SwapError(503, "RPC_NOT_CONFIGURED", `No RPC is configured for chain ${chainId}.`);
  const [nativeRaw, tokenRaw] = await Promise.all([provider.getBalance(wallet), new ethers.Contract(token, ERC20_ABI, provider).balanceOf(wallet)]);
  return { chainId, nativeRaw: BigInt(nativeRaw).toString(), tokenRaw: BigInt(tokenRaw).toString() };
}

export async function gen8SwapStatusCore(input, deps = {}) {
  const chainId = parseChain(input.chainId);
  const hash = String(input.txHash || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Gen8SwapError(400, "BAD_TX", "txHash is required");
  const provider = await (deps.getProvider || defaultProvider)(chainId);
  if (!provider) throw new Gen8SwapError(503, "RPC_NOT_CONFIGURED", `No RPC is configured for chain ${chainId}.`);
  const receipt = await provider.getTransactionReceipt(hash);
  if (!receipt) return { chainId, status: "pending" };
  return { chainId, status: Number(receipt.status) === 1 ? "success" : "failed", blockNumber: Number(receipt.blockNumber) };
}

function query(req) {
  return req.query || Object.fromEntries(new URL(String(req.url || ""), "http://x").searchParams);
}

function handler(method, core, { body = false, cache = "no-store" } = {}) {
  return async (req, res) => {
    if (req.method !== method) return badMethod(res);
    try {
      const input = body ? (req.body && typeof req.body === "object" ? req.body : await readJson(req)) : query(req);
      let db = null;
      if (core === gen8SwapTokenCore) db = (await import("../server/db.js")).pool || null;
      const out = await core(input || {}, { db });
      res.setHeader("cache-control", cache);
      return json(res, 200, { ok: true, ...out });
    } catch (error) {
      if (error instanceof Gen8SwapError) return json(res, error.status, { ok: false, error: error.message, code: error.code });
      console.error("[api/gen8Swap] failed", error);
      return json(res, 502, { ok: false, error: "The swap service could not answer. Try again.", code: "GEN8_SWAP_FAILED" });
    }
  };
}

export const gen8SwapToken = handler("GET", gen8SwapTokenCore, { cache: "public, max-age=15" });
export const gen8SwapBalances = handler("GET", gen8SwapBalancesCore);
export const gen8SwapQuote = handler("POST", gen8SwapQuoteCore, { body: true });
export const gen8SwapBuild = handler("POST", gen8SwapBuildCore, { body: true });
export const gen8SwapStatus = handler("GET", gen8SwapStatusCore);
