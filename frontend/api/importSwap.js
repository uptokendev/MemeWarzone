/**
 * Swaps for imported memecoins (founder, 2026-09-25): coins that trade on outside DEXes, not on our
 * launchpad. Our launchpad CREATE / BUY / SELL are untouched -- this is a separate path.
 *
 * Solana (101): Jupiter Swap API -- routes Meteora, PumpSwap, pump.fun, Raydium, Orca, ...
 *   0.5% platform fee, always in SOL: a wrapped-SOL token account owned by the capped protocol
 *   operator (route_state.operator 2AMfRaxS..., read from chain 2026-09-25). Buy: SOL is the input
 *   mint, sell: SOL is the output mint, so one WSOL account collects both. Proven by simulation on
 *   mainnet: 0.01 SOL buy -> 50000 lamports to the fee account; a sell -> exactly quote.platformFee.
 * BNB (56): KyberSwap aggregator over the on-chain AMM pools of BNB Chain (PancakeSwap, Topaz,
 *   Uniswap, THENA, Biswap, BabyDogeSwap, ... see KYBER_BSC_POOL_SOURCES; founder 2026-10-08: an
 *   imported coin trades wherever its pool is). Until then it was PancakeSwap pools only. The
 *   fee is charged in BNB inside the swap (buy: from the input, sell: from the output). Until the
 *   ImportFeeVault switch it is 0.5% to the BNB ProtocolRevenueVault (the $10k operator cap,
 *   overflow to the Safe); from the switch (IMPORT_FEE_VAULT_56 set and IMPORT_SWAP_FEE_RECEIVER_56
 *   equal to it) it is 1% to the ImportFeeVault, half of it the coin creator's (CO-IMP CI2).
 *
 * The API owns the fee terms: build re-checks every fee field of the quote it is handed, so the
 * app cannot be talked into a fee-free or re-routed fee swap. (A user can still call Jupiter or
 * Kyber directly; this protects our UI, not the DEXes.)
 */
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { badMethod, json, readJson } from "../server/http.js";
import { evmFingerprint, recordFingerprint, solanaFingerprintFromBuilt } from "./lib/importSwapFingerprint.js";
import { gen8ConfigFor } from "./lib/evmGen8Config.js";
import { findGen8Coin } from "./lib/evmGen8Coins.js";
import { ethers } from "ethers";
import {
  ROBINHOOD_MAINNET_CHAIN_ID,
  UNIVERSAL_ROUTER_4663,
  WETH_4663,
  QUOTER_V2_4663,
  encodeImportBuy,
  encodeImportSell,
  importSwapFee,
  importSwapFeeTerms4663,
  quoteImportSwap4663,
} from "../src/lib/robinhoodImportSwap.mjs";
import { PERMIT2_ABI, PERMIT2_ADDRESS, gen8PriceImpactBps, gen8ReferenceAmount, gen8SellSetup } from "../shared/evmGen8Swap.mjs";

export const IMPORT_SWAP_FEE_BPS = Math.max(0, Math.min(200, Number(process.env.IMPORT_SWAP_FEE_BPS || 50)));

const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
// From the 1% switch (founder, 2026-10-08) the whole fee goes to the import fee collector, whose
// key only the indexer holds: it pays the coin creator's half and sweeps ours to the protocol
// wallet (realtime-indexer/src/importCreatorFeeWorker.ts). Setting SOLANA_IMPORT_FEE_COLLECTOR is
// the switch: it moves the fee account and the rate together, so 1% never lands in the old
// protocol-only account and the collector never takes the old 0.5%.
const SOLANA_IMPORT_FEE_COLLECTOR = String(process.env.SOLANA_IMPORT_FEE_COLLECTOR || "").trim();
const SOLANA_FEE_OWNER = SOLANA_IMPORT_FEE_COLLECTOR || String(process.env.SOLANA_IMPORT_SWAP_FEE_OWNER || "2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB").trim();

/** Fee in bps per chain: the collector's split rate on Solana once it is set, else the 0.5% rate. */
export function importSwapFeeBps(chainId, env = process.env) {
  const legacy = Math.max(0, Math.min(200, Number(env.IMPORT_SWAP_FEE_BPS || 50)));
  if (Number(chainId) === 101 && String(env.SOLANA_IMPORT_FEE_COLLECTOR || "").trim()) {
    return Math.max(0, Math.min(200, Number(env.IMPORT_SWAP_FEE_BPS_101 || 100)));
  }
  // BNB: same coupling as Solana. 1% only while the Kyber fee receiver IS the ImportFeeVault, so 1%
  // never goes to the old protocol-only vault and the ImportFeeVault never takes the old 0.5%.
  if (Number(chainId) === 56 && bscImportFeeVault(env)) {
    return Math.max(0, Math.min(200, Number(env.IMPORT_SWAP_FEE_BPS_56 || 100)));
  }
  return legacy;
}
const SOLANA_FEE_BPS = importSwapFeeBps(101);
const JUPITER_BASE = String(
  process.env.JUPITER_SWAP_API_BASE || (process.env.JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1"),
).replace(/\/+$/, "");

export const BSC_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const KYBER_ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
const KYBER_BASE = "https://aggregator-api.kyberswap.com/bsc/api/v1";
/**
 * KyberSwap liquidity sources an import swap may route through on BNB (Kyber dex ids, read from
 * ks-setting.kyberswap.com/api/v1/dexes?chain=bsc on 2026-10-08). Until 2026-10-08 this was the five
 * PancakeSwap ids only, so a coin whose only pool sat on Topaz, THENA, Biswap or Uniswap had no route.
 * The restriction's intent is kept: every hop is a public on-chain AMM pool (constant product,
 * concentrated liquidity, Solidly, Uniswap V4 / Pancake Infinity hook pools) whose price comes from
 * the pool's own reserves. Left out on purpose: RFQ and PMM market makers (bebop, hashflow, native,
 * pmm-*, dexalot, *-prop, metric/axima, obric, tessera, elfomofi, swaap, woofi, dodo), order books
 * and limit orders (hanji, kyberswap-limit-order-v2), lending-backed AMMs (euler, fluid), stable,
 * wrapper, staking and bridge sources (curve, ellipsis, wombat, nerve, synapse, aave, erc4626, wbeth,
 * lista-stake, ...), perps (ktx) and ids we could not identify. The fee does not depend on the
 * source (Kyber's router takes extraFee on the BNB side of the whole swap); assertBscRouteTerms
 * checks every hop against this list by exact id.
 */
export const KYBER_BSC_POOL_SOURCES = Object.freeze([
  // PancakeSwap
  "pancake", "pancake-v3", "pancake-legacy", "pancake-infinity-cl", "pancake-infinity-bin",
  "pancake-infinity-cl-alpha", "pancake-infinity-cl-brevis", "pancake-infinity-cl-dynamic", "pancake-infinity-cl-fairflow",
  "pancake-infinity-cl-geniusmeme", "pancake-infinity-cl-lo", "pancake-infinity-cl-tax", "pancake-infinity-bin-brevis",
  // Topaz (V2 Solidly + V3)
  "topazdex-v2", "topazdex-v3",
  // Uniswap on BNB
  "uniswap", "uniswapv3", "uniswap-v4", "uniswap-v4-alpha", "uniswap-v4-arrakis", "uniswap-v4-clanker", "uniswap-v4-doppler",
  "uniswap-v4-fairflow", "uniswap-v4-fee", "uniswap-v4-gluehook", "uniswap-v4-onetoken", "uniswap-v4-passthru",
  // THENA (V1 Solidly, Fusion, Integral)
  "thena", "thena-fusion", "thena-fusion-v3",
  // Other AMMs with their own pools
  "biswap", "babydogeswap", "babyswap", "bakeryswap", "apeswap", "mdex", "sushiswap", "sushiswap-v3", "squadswap", "squadswap-v2",
  "squadswap-v3", "nomiswap", "iziswap", "9mm-pro-v2", "9mm-pro-v3", "traderjoe-v21", "maverick-v1", "maverick-v2", "owlswap-v3",
  "sheepdex-v3", "lista-v3", "cone-v2", "dddxswap-v2", "veplus-v2", "fraxswap", "smardex", "kyberswap", "kyberswap-static", "jetswap",
  "pantherswap", "wault", "fstsswap", "oneswap",
  // Uniswap V2 forks
  "alitaswap-v2", "autoshark-v2", "boxswap-v2", "bscswap-v2", "busta-v2", "butterswap-v2", "cafeswap-v2", "cheeseswap-v2",
  "cobraswap-v2", "coinswap-v2", "daomakerswap-v2", "definix-v2", "digiswap-v2", "dooarswap-v2", "empiredex-v2", "fastswap-v2",
  "foodcourt-v2", "gibxswap-v2", "gravis-v2", "jswap-v2", "julswap-v2", "justmoney-v2", "knightswap-v2", "kokomoswap-v2",
  "kyotoswap-v2", "latte-v2", "marsswap-v2", "mochiswap-v2", "narwhalswap-v2", "ninjaswap-v2", "nyanswop-v2", "orbitalswap-v2",
  "padswap-v2", "pandaswap-v2", "paraluni-v2", "pinkswap-v2", "planetfinance-v2", "pls2e-v2", "pureswap-v2", "radioshack-v2",
  "safeswap-v2", "saitaswap-v2", "sakeswap-v2", "shibance-v2", "shibanova-v2", "swych-v2", "thugswap-v2", "twindex-v2",
  "w3swap-v2", "wardenswap-v2", "wineryswap-v2", "youswap-v2",
  // Launchpad bonding curves Kyber executes on chain
  "flap", "genius-fun", "loong-fun", "printr",
]);
const KYBER_BSC_POOL_SOURCE_SET = new Set(KYBER_BSC_POOL_SOURCES);
// 4011 "token not found": Kyber has not indexed the token (read 2026-10-09 for a coin whose only pool is new, e.g. a
// MemeWarzone coin right after graduation). It has no Kyber route, the same as 4008 / 40011.
const KYBER_NO_ROUTE_CODES = new Set([4008, 4011, 40011]);
const BSC_FEE_RECEIVER = String(process.env.IMPORT_SWAP_FEE_RECEIVER_56 || "0xc2d4E6f846446f3921a34A34e007295dbc19Bc4c").trim().toLowerCase();

/** The BNB ImportFeeVault while the switch is on (IMPORT_FEE_VAULT_56 set and the Kyber fee receiver equal to it), else "". */
export function bscImportFeeVault(env = process.env) {
  const vault = String(env.IMPORT_FEE_VAULT_56 || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(vault)) return "";
  return String(env.IMPORT_SWAP_FEE_RECEIVER_56 || "").trim().toLowerCase() === vault ? vault : "";
}
const BSC_FEE_BPS = importSwapFeeBps(56);
const BSC_IMPORT_FEE_VAULT = bscImportFeeVault();

const MAX_SLIPPAGE_BPS = 1500;

function isSolanaAddress(value) {
  try {
    return new PublicKey(String(value || "").trim()).toBase58() === String(value || "").trim();
  } catch {
    return false;
  }
}

function isEvmAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || "").trim());
}

function positiveRaw(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = BigInt(raw);
  return n > 0n ? n : null;
}

export function slippageBps(value) {
  const n = Math.round(Number(value ?? 100));
  if (!Number.isFinite(n) || n < 1) return 100;
  return Math.min(MAX_SLIPPAGE_BPS, n);
}

export function solanaFeeAccount(owner = SOLANA_FEE_OWNER) {
  const [ata] = PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(TOKEN_PROGRAM).toBuffer(), new PublicKey(WSOL).toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM),
  );
  return ata.toBase58();
}

function solanaConnection() {
  const url = String(process.env.SOLANA_RPC_URL || process.env.VITE_SOLANA_RPC_URL || process.env.SOLANA_RPC_HTTP || "").trim();
  if (!url) {
    const error = new Error("Solana RPC is not configured");
    error.status = 503;
    error.code = "SOLANA_RPC_UNAVAILABLE";
    throw error;
  }
  return new Connection(url, "confirmed");
}

let feeAccountReady = { at: 0, ok: false };
async function assertSolanaFeeAccountReady() {
  if (feeAccountReady.ok && Date.now() - feeAccountReady.at < 10 * 60_000) return;
  const account = solanaFeeAccount();
  const info = await solanaConnection().getAccountInfo(new PublicKey(account));
  const ok = Boolean(info) && info.owner.toBase58() === TOKEN_PROGRAM && info.data.length >= 72 && new PublicKey(info.data.subarray(0, 32)).toBase58() === WSOL;
  feeAccountReady = { at: Date.now(), ok };
  if (!ok) {
    const error = new Error(`Import swap fee account ${account} (wrapped SOL of ${SOLANA_FEE_OWNER}) is not initialized`);
    error.status = 503;
    error.code = "IMPORT_SWAP_FEE_ACCOUNT_MISSING";
    throw error;
  }
}

function jupiterHeaders() {
  const headers = { accept: "application/json", "content-type": "application/json" };
  if (process.env.JUPITER_API_KEY) headers["x-api-key"] = process.env.JUPITER_API_KEY;
  return headers;
}

async function fetchJson(url, init = {}, label = "request") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`${label} failed (${response.status}): ${String(body?.error || body?.message || "").slice(0, 200)}`);
      error.status = response.status === 400 || response.status === 404 ? 422 : 502;
      error.upstreamCode = body?.code ?? null;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function solanaMints(token, side) {
  return side === "buy" ? { inputMint: WSOL, outputMint: token } : { inputMint: token, outputMint: WSOL };
}

/** Throws unless the quote is exactly the swap we fee: SOL<->token, ExactIn, our fee bps. */
export function assertSolanaQuoteTerms(quote, { token, side, feeBps = SOLANA_FEE_BPS }) {
  const expected = solanaMints(token, side);
  if (!quote || typeof quote !== "object") throw Object.assign(new Error("Missing Jupiter quote"), { status: 400 });
  if (quote.inputMint !== expected.inputMint || quote.outputMint !== expected.outputMint) throw Object.assign(new Error("Quote mints do not match this swap"), { status: 400 });
  if (String(quote.swapMode || "ExactIn") !== "ExactIn") throw Object.assign(new Error("Only exact-in swaps are supported"), { status: 400 });
  if (Number(quote.platformFee?.feeBps ?? 0) !== feeBps) throw Object.assign(new Error("Quote does not carry the platform fee"), { status: 400 });
  if (Number(quote.slippageBps) > MAX_SLIPPAGE_BPS) throw Object.assign(new Error("Slippage too high"), { status: 400 });
}

/** Throws unless the built transaction is the user's alone and carries our fee account. */
export function assertSolanaSwapTransaction(base64, { wallet, feeAccount }) {
  const tx = VersionedTransaction.deserialize(Buffer.from(String(base64 || ""), "base64"));
  const keys = tx.message.staticAccountKeys.map((key) => key.toBase58());
  if (keys[0] !== wallet) throw Object.assign(new Error("Swap fee payer is not the wallet"), { status: 502 });
  if (Number(tx.message.header.numRequiredSignatures) !== 1) throw Object.assign(new Error("Swap needs more than the wallet's signature"), { status: 502 });
  const programs = tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]);
  if (!programs.includes(JUPITER_PROGRAM)) throw Object.assign(new Error("Swap does not route through Jupiter"), { status: 502 });
  if (!keys.includes(feeAccount)) throw Object.assign(new Error("Swap does not pay the platform fee account"), { status: 502 });
  return tx;
}

async function solanaQuote({ token, side, amountRaw, slippage }) {
  const { inputMint, outputMint } = solanaMints(token, side);
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountRaw.toString(),
    slippageBps: String(slippage),
    platformFeeBps: String(SOLANA_FEE_BPS),
    swapMode: "ExactIn",
    // RouteV2. The V1 Route instruction refuses our WSOL fee account whenever the coin is a
    // Token-2022 mint (Jupiter 6014 IncorrectTokenProgramID): every buy of a new pump.fun coin
    // failed in the wallet. Simulated on mainnet 2026-10-13 over all 16 Solana imports: the 8
    // Token-2022 ones fail on V1 and pass on V2, the classic ones pass on both, fee unchanged.
    instructionVersion: "V2",
  });
  const quote = await fetchJson(`${JUPITER_BASE}/quote?${params}`, { headers: jupiterHeaders() }, "Jupiter quote");
  if (!quote?.outAmount) throw Object.assign(new Error("No Jupiter route for this token"), { status: 422, code: "IMPORT_SWAP_NO_ROUTE" });
  return {
    chainId: 101,
    provider: "jupiter",
    side,
    amountIn: String(quote.inAmount),
    amountOut: String(quote.outAmount),
    minAmountOut: String(quote.otherAmountThreshold),
    priceImpactPct: Number(quote.priceImpactPct || 0) * 100,
    feeBps: SOLANA_FEE_BPS,
    // Buy: the fee is taken from the SOL in; sell: from the SOL out (quote.platformFee.amount).
    feeNativeRaw: side === "buy" ? ((BigInt(quote.inAmount) * BigInt(SOLANA_FEE_BPS)) / 10_000n).toString() : String(quote.platformFee?.amount || "0"),
    creatorShareBps: SOLANA_IMPORT_FEE_COLLECTOR ? Math.floor(SOLANA_FEE_BPS / 2) : 0,
    route: (quote.routePlan || []).map((step) => step?.swapInfo?.label).filter(Boolean),
    quote,
  };
}

/**
 * Swap-widget partners (2026-10-09). A build for a widget with `partner` is attributed to that partner:
 * normally by a fingerprint of what we built (lib/importSwapFingerprint.js), recorded here and matched by
 * the fee ledger; the swap itself is the ordinary one. Fallback on Solana: a partner row with fee_account
 * uses that WSOL account (it must be owned by our collector, checked on chain). Unknown partner, split mode
 * off or any lookup error: an ordinary swap; a partner never blocks a swap.
 */
const partnerCache = new Map();
export function isCollectorWsolAccount(info, collector) {
  return Boolean(info) && info.owner.toBase58() === TOKEN_PROGRAM && info.data.length >= 72
    && new PublicKey(info.data.subarray(0, 32)).toBase58() === WSOL
    && new PublicKey(info.data.subarray(32, 64)).toBase58() === collector;
}

async function dbPool() {
  const { pool } = await import("./../server/db.js");
  return pool;
}

/** { id, feeAccount } for an active partner on this chain (feeAccount only when it checks out), else null. */
export async function readPartner(partnerId, chainId) {
  const id = String(partnerId || "").trim().toLowerCase();
  if (!id || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) return null;
  if (chainId === 101 && !SOLANA_IMPORT_FEE_COLLECTOR) return null; // no split on Solana: nothing to share
  const key = `${chainId}:${id}`;
  const cached = partnerCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.partner;
  let partner = null;
  try {
    const pool = await dbPool();
    const { rows } = pool
      ? await pool.query("select id, fee_account from public.import_fee_partners where id = $1 and chain_id = $2 and active limit 1", [id, chainId])
      : { rows: [] };
    if (rows[0]) {
      partner = { id, feeAccount: null };
      const candidate = chainId === 101 && rows[0].fee_account ? String(rows[0].fee_account) : null;
      if (candidate) {
        const info = await solanaConnection().getAccountInfo(new PublicKey(candidate));
        if (isCollectorWsolAccount(info, SOLANA_IMPORT_FEE_COLLECTOR)) partner.feeAccount = candidate;
        else console.warn("[api/importSwap] partner fee account is not a collector WSOL account; attributing by fingerprint", { partner: id, candidate });
      }
    }
  } catch (error) {
    console.warn("[api/importSwap] partner lookup failed; ordinary swap", { partner: id, error: String(error?.message || error) });
  }
  partnerCache.set(key, { at: Date.now(), partner });
  return partner;
}

/** Best effort: a failed write only means the swap is not attributed to the partner. */
export async function rememberPartnerSwap(input) {
  try {
    await recordFingerprint(await dbPool(), input);
  } catch (error) {
    console.warn("[api/importSwap] partner fingerprint not stored", { partner: input.partnerId, error: String(error?.message || error) });
  }
}

async function solanaBuild({ token, side, wallet, quote, partner = null }) {
  assertSolanaQuoteTerms(quote, { token, side });
  const partnerRow = await readPartner(partner, 101);
  const partnerAccount = partnerRow?.feeAccount || null;
  if (!partnerAccount) await assertSolanaFeeAccountReady();
  const feeAccount = partnerAccount || solanaFeeAccount();
  const built = await fetchJson(
    `${JUPITER_BASE}/swap`,
    {
      method: "POST",
      headers: jupiterHeaders(),
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet,
        feeAccount,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: "high" } },
      }),
    },
    "Jupiter swap",
  );
  if (!built?.swapTransaction) throw Object.assign(new Error("Jupiter returned no transaction"), { status: 502 });
  assertSolanaSwapTransaction(built.swapTransaction, { wallet, feeAccount });
  if (partnerRow && !partnerAccount) {
    await rememberPartnerSwap({ fingerprint: solanaFingerprintFromBuilt(built.swapTransaction, wallet), chainId: 101, partnerId: partnerRow.id, wallet, token });
  }
  return { chainId: 101, provider: "jupiter", transactionBase64: built.swapTransaction, lastValidBlockHeight: Number(built.lastValidBlockHeight || 0), feeAccount };
}

function kyberHeaders() {
  return { "x-client-id": String(process.env.KYBER_CLIENT_ID || "memewarzone"), "content-type": "application/json", accept: "application/json" };
}

function bscPair(token, side) {
  return side === "buy" ? { tokenIn: BSC_NATIVE, tokenOut: token } : { tokenIn: token, tokenOut: BSC_NATIVE };
}

/** Throws unless the route is exactly the swap we fee: BNB<->token, our fee in BNB to the vault, every hop a pool source we allow. */
export function assertBscRouteTerms(summary, { token, side, feeBps = BSC_FEE_BPS, feeReceiver = BSC_FEE_RECEIVER }) {
  const expected = bscPair(token, side);
  if (!summary || typeof summary !== "object") throw Object.assign(new Error("Missing Kyber route"), { status: 400 });
  if (String(summary.tokenIn || "").toLowerCase() !== expected.tokenIn.toLowerCase() || String(summary.tokenOut || "").toLowerCase() !== expected.tokenOut.toLowerCase()) {
    throw Object.assign(new Error("Route tokens do not match this swap"), { status: 400 });
  }
  const fee = summary.extraFee || {};
  const chargeBy = side === "buy" ? "currency_in" : "currency_out";
  if (String(fee.feeAmount) !== String(feeBps) || fee.isInBps !== true || fee.chargeFeeBy !== chargeBy || String(fee.feeReceiver || "").toLowerCase() !== feeReceiver) {
    throw Object.assign(new Error("Route does not carry the platform fee"), { status: 400 });
  }
  const exchanges = (summary.route || []).flat().map((hop) => String(hop?.exchange || ""));
  if (!exchanges.length || exchanges.some((exchange) => !KYBER_BSC_POOL_SOURCE_SET.has(exchange))) {
    throw Object.assign(new Error("Route leaves the on-chain DEX pools"), { status: 400 });
  }
}

async function bscQuote({ token, side, amountRaw }) {
  const { tokenIn, tokenOut } = bscPair(token, side);
  const params = new URLSearchParams({
    tokenIn,
    tokenOut,
    amountIn: amountRaw.toString(),
    includedSources: KYBER_BSC_POOL_SOURCES.join(","),
    feeAmount: String(BSC_FEE_BPS),
    chargeFeeBy: side === "buy" ? "currency_in" : "currency_out",
    isInBps: "true",
    feeReceiver: BSC_FEE_RECEIVER,
  });
  let body;
  try {
    body = await fetchJson(`${KYBER_BASE}/routes?${params}`, { headers: kyberHeaders() }, "Kyber route");
  } catch (error) {
    // Kyber answers "no route" with HTTP 400 and code 4008 (route not found), 40011 (no pool among the sources) or 4011 (token not indexed).
    // Tag it IMPORT_SWAP_NO_ROUTE so the app tries the coin's Topaz pool through the fee router (never fee-free).
    if (KYBER_NO_ROUTE_CODES.has(Number(error?.upstreamCode))) throw Object.assign(new Error("No DEX route for this token"), { status: 422, code: "IMPORT_SWAP_NO_ROUTE" });
    throw error;
  }
  const summary = body?.data?.routeSummary;
  if (!summary?.amountOut) throw Object.assign(new Error("No DEX route for this token"), { status: 422, code: "IMPORT_SWAP_NO_ROUTE" });
  assertBscRouteTerms(summary, { token, side });
  const amountIn = BigInt(summary.amountIn);
  return {
    chainId: 56,
    provider: "kyberswap",
    side,
    amountIn: summary.amountIn,
    amountOut: summary.amountOut,
    minAmountOut: null,
    priceImpactPct: null,
    feeBps: BSC_FEE_BPS,
    feeNativeRaw: side === "buy" ? ((amountIn * BigInt(BSC_FEE_BPS)) / 10_000n).toString() : null,
    creatorShareBps: BSC_IMPORT_FEE_VAULT ? Math.floor(BSC_FEE_BPS / 2) : 0,
    route: (summary.route || []).flat().map((hop) => hop?.exchange).filter(Boolean),
    quote: summary,
  };
}

async function bscBuild({ token, side, wallet, quote, slippage, partner = null }) {
  assertBscRouteTerms(quote, { token, side });
  const body = await fetchJson(
    `${KYBER_BASE}/route/build`,
    { method: "POST", headers: kyberHeaders(), body: JSON.stringify({ routeSummary: quote, sender: wallet, recipient: wallet, slippageTolerance: slippage }) },
    "Kyber build",
  );
  const data = body?.data;
  if (!data?.data || String(data.routerAddress || "").toLowerCase() !== KYBER_ROUTER.toLowerCase()) {
    throw Object.assign(new Error("Kyber returned an unexpected router"), { status: 502 });
  }
  const value = side === "buy" ? String(data.transactionValue ?? data.amountIn ?? "0") : "0";
  if (side === "buy" && String(value) !== String(quote.amountIn)) throw Object.assign(new Error("Kyber changed the swap amount"), { status: 502 });
  const partnerRow = await readPartner(partner, 56);
  if (partnerRow) await rememberPartnerSwap({ fingerprint: evmFingerprint(KYBER_ROUTER, data.data, value), chainId: 56, partnerId: partnerRow.id, wallet, token });
  return { chainId: 56, provider: "kyberswap", to: KYBER_ROUTER, data: data.data, value, amountOut: data.amountOut, spender: KYBER_ROUTER };
}

// ---------------------------------------------------------------- Robinhood Chain (4663), built by the API

/**
 * Robinhood imports built on the server (swap widget, 2026-10-22). The app keeps building its own in the browser
 * (src/lib/robinhoodImportSwap.mjs executeImportSwap4663, sell with a signed Permit2 permit inside the call). The API
 * builds with the same module's encoders (encodeImportBuy / encodeImportSell) and the same quote
 * (quoteImportSwap4663), so a buy is byte-for-byte the app's buy. A sell has no PERMIT2_PERMIT command: a permit the
 * user signs inside the calldata would change the data after we recorded its fingerprint. It spends a standing Permit2
 * allowance instead (one-time ERC20 approve(Permit2) + Permit2.approve(token, router), as gen-8 sells in the widget).
 *
 * Only in split mode: 1% (IMPORT_SWAP_FEE_BPS_4663) to the ImportFeeVault (IMPORT_FEE_VAULT_4663 =
 * IMPORT_SWAP_FEE_RECEIVER_4663), half of it the creator's, paid by the indexer from the vault. The API reads the plain
 * names, the same ones the finance scanner and the indexer read. Without split mode it refuses (503): it never builds
 * the old 0.5% protocol-only terms and never a swap without PAY_PORTION.
 */
const UNIVERSAL_ROUTER_IFACE = new ethers.Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const QUOTER_V2_ABI = ["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)"];
const ERC20_ALLOWANCE_ABI = ["function allowance(address owner, address spender) view returns (uint256)"];
const ERC20_APPROVE_IFACE = new ethers.Interface(["function approve(address spender, uint256 amount) returns (bool)"]);
const ROBINHOOD_DEADLINE_SECONDS = 20 * 60;
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const RH_CMD = Object.freeze({ V3_SWAP_EXACT_IN: 0x00, SWEEP: 0x04, PAY_PORTION: 0x06, PERMIT2_PERMIT: 0x0a, WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c });
const abi = ethers.AbiCoder.defaultAbiCoder();

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

async function defaultEvmProvider(chainId) {
  const { getRpcUrls, getServerReadProvider } = await import("./lib/getServerReadProvider.js");
  return getRpcUrls(chainId).length ? getServerReadProvider(chainId) : null;
}

async function evmProvider(chainId, deps) {
  const provider = await (deps.getProvider || defaultEvmProvider)(chainId);
  if (!provider) throw httpError(503, "RPC_NOT_CONFIGURED", `No RPC is configured for chain ${chainId}.`);
  return provider;
}

/** The 4663 fee terms the API builds with: split mode only, else a 503. Plain env names (as the scanner and indexer). */
export function robinhoodImportTerms(env = process.env) {
  const terms = importSwapFeeTerms4663({
    IMPORT_FEE_VAULT_4663: env.IMPORT_FEE_VAULT_4663,
    IMPORT_SWAP_FEE_RECEIVER_4663: env.IMPORT_SWAP_FEE_RECEIVER_4663,
    IMPORT_SWAP_FEE_BPS_4663: env.IMPORT_SWAP_FEE_BPS_4663,
  });
  if (!terms.split || !(terms.feeBps > 0) || /^0x0{40}$/i.test(terms.feeReceiver) || !(terms.creatorShareBps > 0)) {
    throw httpError(503, "IMPORT_SWAP_FEE_NOT_CONFIGURED", "Swaps on Robinhood Chain are paused here: the import fee vault is not configured.");
  }
  return terms;
}

/** True when the API can build an import swap on this EVM chain with a fee (56: Kyber fee bps > 0; 4663: split mode). */
export function evmImportFeeReady(chainId, env = process.env) {
  if (Number(chainId) === 56) {
    const receiver = String(env.IMPORT_SWAP_FEE_RECEIVER_56 || "0xc2d4E6f846446f3921a34A34e007295dbc19Bc4c").trim().toLowerCase();
    return importSwapFeeBps(56, env) > 0 && /^0x[0-9a-f]{40}$/.test(receiver) && !/^0x0{40}$/.test(receiver);
  }
  if (Number(chainId) === ROBINHOOD_MAINNET_CHAIN_ID) {
    try {
      robinhoodImportTerms(env);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** The fee terms an EVM import on this chain is quoted with (display: the widget's token answer). */
export function evmImportFeeTerms(chainId, env = process.env) {
  if (Number(chainId) === 56) {
    const feeBps = importSwapFeeBps(56, env);
    return { feeBps, creatorShareBps: bscImportFeeVault(env) ? Math.floor(feeBps / 2) : 0, split: Boolean(bscImportFeeVault(env)) };
  }
  if (Number(chainId) === ROBINHOOD_MAINNET_CHAIN_ID) {
    const terms = importSwapFeeTerms4663({ IMPORT_FEE_VAULT_4663: env.IMPORT_FEE_VAULT_4663, IMPORT_SWAP_FEE_RECEIVER_4663: env.IMPORT_SWAP_FEE_RECEIVER_4663, IMPORT_SWAP_FEE_BPS_4663: env.IMPORT_SWAP_FEE_BPS_4663 });
    return { feeBps: terms.split ? terms.feeBps : 0, creatorShareBps: terms.split ? terms.creatorShareBps : 0, split: terms.split };
  }
  return { feeBps: 0, creatorShareBps: 0, split: false };
}

/**
 * Quote of a Robinhood import swap (quoteImportSwap4663 with the API's terms), in the shape of the other chains'
 * quotes. amountOut is what the wallet receives after the fee; minAmountOut too (a sell: the SWEEP minimum).
 * The price impact compares with a quote of 1/1000 of the amount in the same pool (as gen-8, gen8PriceImpactBps).
 */
export async function robinhoodQuoteCore({ token, side, amountRaw, slippage = 100 }, deps = {}) {
  const env = deps.env || process.env;
  const terms = robinhoodImportTerms(env);
  const provider = await evmProvider(ROBINHOOD_MAINNET_CHAIN_ID, deps);
  const address = ethers.getAddress(String(token).toLowerCase());
  let q;
  try {
    q = await quoteImportSwap4663({ provider, token: address, side, amountIn: BigInt(amountRaw), slippageBps: slippage, terms });
  } catch (error) {
    if (/No Uniswap V3 pool/.test(String(error?.message))) throw httpError(422, "IMPORT_SWAP_NO_ROUTE", "No Uniswap pool with ETH for this token on Robinhood Chain");
    if (error?.code === "CALL_EXCEPTION") throw httpError(422, "IMPORT_SWAP_NO_QUOTE", "No quote for this amount (the pool refused it)");
    console.warn("[api/importSwap] Robinhood quote failed", String(error?.shortMessage || error?.message || error));
    throw httpError(502, "RPC_FAILED", "Robinhood Chain could not be read. Try again.");
  }
  const swapIn = side === "buy" ? q.amountIn - q.feeWei : q.amountIn;
  const swapOut = side === "buy" ? q.amountOut : q.grossOut;
  const refIn = gen8ReferenceAmount(swapIn);
  let refOut = null;
  if (refIn != null) {
    const [tokenIn, tokenOut] = side === "buy" ? [WETH_4663, address] : [address, WETH_4663];
    refOut = await new ethers.Contract(QUOTER_V2_4663, QUOTER_V2_ABI, provider).quoteExactInputSingle
      .staticCall({ tokenIn, tokenOut, amountIn: refIn, fee: q.route.fee, sqrtPriceLimitX96: 0n })
      .then((out) => BigInt(out[0]))
      .catch(() => null);
  }
  const priceImpactBps = gen8PriceImpactBps({ amountIn: swapIn, amountOut: swapOut, refIn, refOut });
  const minAmountOut = side === "buy" ? q.minOut : q.minOut - importSwapFee(q.minOut, terms.feeBps);
  return {
    chainId: ROBINHOOD_MAINNET_CHAIN_ID,
    provider: "uniswap-v3",
    side,
    amountIn: q.amountIn.toString(),
    amountOut: q.amountOut.toString(),
    minAmountOut: minAmountOut.toString(),
    slippageBps: q.slippageBps,
    priceImpactBps,
    priceImpactPct: priceImpactBps == null ? null : priceImpactBps / 100,
    feeBps: terms.feeBps,
    feeNativeRaw: q.feeWei.toString(),
    creatorShareBps: terms.creatorShareBps,
    feeReceiver: terms.feeReceiver,
    route: [`uniswap-v3-${q.route.fee}`],
    quote: { pool: q.route.pool, poolFee: q.route.fee, side, amountIn: q.amountIn.toString(), minOut: q.minOut.toString(), feeBps: terms.feeBps, feeReceiver: terms.feeReceiver },
  };
}

/**
 * The Permit2 setup a Robinhood import sell needs before the swap can go alone, or null. Same transactions as a gen-8
 * sell (gen8SellSetup: approve(Permit2, max), Permit2.approve(token, router, max uint160, one year)); the ERC20 step is
 * skipped while the token's allowance to Permit2 already covers the sell (some tokens lower a max allowance).
 */
export function robinhoodSellSetup({ token, erc20Allowance, permit2Allowance, amountIn, nowSec }) {
  const covered = BigInt(erc20Allowance) >= BigInt(amountIn);
  return gen8SellSetup({ token, router: UNIVERSAL_ROUTER_4663, erc20Allowance: covered ? MAX_UINT256 : BigInt(erc20Allowance), permit2Allowance, amountIn, nowSec });
}

/**
 * Self-check of what leaves the API: one execute() on the Universal Router whose commands are exactly the fee-paying
 * sequence, with PAY_PORTION(ETH, the fee receiver, the fee bps), no PERMIT2_PERMIT, and the swap's token and amount.
 */
export function assertRobinhoodImportCall({ data, value, side, token, amountIn, terms }) {
  const fail = () => {
    throw httpError(500, "IMPORT_SWAP_BUILD_MISMATCH", "The swap could not be built.");
  };
  let decoded;
  try {
    decoded = UNIVERSAL_ROUTER_IFACE.decodeFunctionData("execute", data);
  } catch {
    fail();
  }
  const commands = Array.from(ethers.getBytes(decoded.commands));
  const inputs = decoded.inputs;
  const expected = side === "buy"
    ? [RH_CMD.PAY_PORTION, RH_CMD.WRAP_ETH, RH_CMD.V3_SWAP_EXACT_IN]
    : [RH_CMD.V3_SWAP_EXACT_IN, RH_CMD.UNWRAP_WETH, RH_CMD.PAY_PORTION, RH_CMD.SWEEP];
  if (commands.length !== expected.length || commands.some((c, i) => c !== expected[i]) || inputs.length !== expected.length) fail();
  const pay = abi.decode(["address", "address", "uint256"], inputs[expected.indexOf(RH_CMD.PAY_PORTION)]);
  if (pay[0] !== ethers.ZeroAddress || pay[1].toLowerCase() !== terms.feeReceiver.toLowerCase() || pay[2] !== BigInt(terms.feeBps) || !(pay[2] > 0n)) fail();
  const swap = abi.decode(["address", "uint256", "uint256", "bytes", "bool", "uint256[]"], inputs[expected.indexOf(RH_CMD.V3_SWAP_EXACT_IN)]);
  const path = ethers.getBytes(swap[3]);
  if (path.length !== 43) fail();
  const pathIn = ethers.getAddress(ethers.hexlify(path.slice(0, 20)));
  const pathOut = ethers.getAddress(ethers.hexlify(path.slice(23, 43)));
  const coin = ethers.getAddress(String(token).toLowerCase());
  if (side === "buy") {
    if (pathIn !== ethers.getAddress(WETH_4663) || pathOut !== coin || BigInt(value) !== BigInt(amountIn) || swap[4] !== false) fail();
  } else {
    if (pathIn !== coin || pathOut !== ethers.getAddress(WETH_4663) || swap[1] !== BigInt(amountIn) || BigInt(value) !== 0n || swap[4] !== true) fail();
  }
}

/**
 * Build of a Robinhood import swap: fee terms first, then a fresh quote (the client's quote is never trusted), then a
 * sell's allowance check, then the router call, its self-check, and last the partner fingerprint of exactly what is
 * returned. A sell without the standing allowance answers { needsAllowance, approval, permit2Approval, quote } and
 * records nothing.
 */
export async function robinhoodBuildCore({ token, side, wallet, amountRaw, slippage = 100, partner = null }, deps = {}) {
  const env = deps.env || process.env;
  const terms = robinhoodImportTerms(env);
  if (!isEvmAddress(wallet)) throw httpError(400, "BAD_WALLET", "Invalid wallet");
  const amount = positiveRaw(amountRaw);
  if (!amount || amount > MAX_UINT160) throw httpError(400, "BAD_AMOUNT", "amountRaw must be a positive integer");
  const provider = await evmProvider(ROBINHOOD_MAINNET_CHAIN_ID, deps);
  const quote = await robinhoodQuoteCore({ token, side, amountRaw: amount, slippage }, { ...deps, env, getProvider: async () => provider });
  const coin = ethers.getAddress(String(token).toLowerCase());
  const owner = ethers.getAddress(String(wallet).toLowerCase());
  const nowSec = Number(deps.nowSec ?? (await provider.getBlock("latest")).timestamp);

  if (side === "sell") {
    const [erc20Allowance, permit2Allowance] = await Promise.all([
      new ethers.Contract(coin, ERC20_ALLOWANCE_ABI, provider).allowance(owner, PERMIT2_ADDRESS),
      new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider).allowance(owner, coin, UNIVERSAL_ROUTER_4663),
    ]);
    const setup = robinhoodSellSetup({ token: coin, erc20Allowance, permit2Allowance, amountIn: amount, nowSec });
    if (setup) return { chainId: ROBINHOOD_MAINNET_CHAIN_ID, needsAllowance: true, approval: setup.approval, permit2Approval: setup.permit2Approval, quote };
  }

  const fee = Number(quote.quote.poolFee);
  const minOut = BigInt(quote.quote.minOut);
  const call = side === "buy"
    ? encodeImportBuy({ token: coin, fee, amountInWei: amount, minTokensOut: minOut, feeReceiver: terms.feeReceiver, feeBps: terms.feeBps })
    : encodeImportSell({ token: coin, fee, amountIn: amount, minGrossEthOut: minOut, permit: null, feeReceiver: terms.feeReceiver, feeBps: terms.feeBps });
  const deadline = BigInt(nowSec + ROBINHOOD_DEADLINE_SECONDS);
  const data = UNIVERSAL_ROUTER_IFACE.encodeFunctionData("execute", [call.commands, call.inputs, deadline]);
  const value = call.value.toString();
  assertRobinhoodImportCall({ data, value, side, token: coin, amountIn: amount, terms });

  let partnerId = null;
  if (partner) {
    const row = await (deps.readPartner || readPartner)(partner, ROBINHOOD_MAINNET_CHAIN_ID);
    if (row) {
      partnerId = row.id;
      await (deps.rememberPartnerSwap || rememberPartnerSwap)({ fingerprint: evmFingerprint(UNIVERSAL_ROUTER_4663, data, value), chainId: ROBINHOOD_MAINNET_CHAIN_ID, partnerId, wallet: owner.toLowerCase(), token: coin.toLowerCase() });
    }
  }
  return { chainId: ROBINHOOD_MAINNET_CHAIN_ID, provider: "uniswap-v3", to: UNIVERSAL_ROUTER_4663, data, value, deadline: deadline.toString(), spender: null, partner: partnerId, quote };
}

/**
 * The widget's BNB sell: Kyber's router pulls the coin with transferFrom, so a wallet without an allowance that covers
 * the sell first approves exactly the amount (as the app, src/lib/importSwap.ts). Returns that approval, or null.
 * Only the widget asks; the app approves on its own before it calls build.
 */
export async function bscSellAllowanceStep({ token, wallet, amountIn }, deps = {}) {
  const provider = await evmProvider(56, deps);
  const coin = ethers.getAddress(String(token).toLowerCase());
  const owner = ethers.getAddress(String(wallet).toLowerCase());
  const allowance = BigInt(await new ethers.Contract(coin, ERC20_ALLOWANCE_ABI, provider).allowance(owner, KYBER_ROUTER));
  if (allowance >= BigInt(amountIn)) return null;
  return { to: coin, data: ERC20_APPROVE_IFACE.encodeFunctionData("approve", [KYBER_ROUTER, BigInt(amountIn)]), value: "0" };
}

export { bscBuild };

export function readSwapInput(body) {
  const chainId = Number(body?.chainId);
  const side = String(body?.side || "").toLowerCase();
  const token = String(body?.token || body?.tokenAddress || "").trim();
  if (side !== "buy" && side !== "sell") throw Object.assign(new Error("side must be buy or sell"), { status: 400 });
  if (chainId === 101) {
    if (!isSolanaAddress(token) || token === WSOL) throw Object.assign(new Error("Invalid Solana token"), { status: 400 });
  } else if (chainId === 56) {
    if (!isEvmAddress(token)) throw Object.assign(new Error("Invalid BNB token"), { status: 400 });
  } else if (chainId === ROBINHOOD_MAINNET_CHAIN_ID) {
    if (!isEvmAddress(token) || token.toLowerCase() === WETH_4663.toLowerCase()) throw Object.assign(new Error("Invalid Robinhood Chain token"), { status: 400 });
  } else {
    throw Object.assign(new Error("Import swaps run on Solana, BNB Chain and Robinhood Chain"), { status: 400 });
  }
  return { chainId, side, token: chainId === 101 ? token : token.toLowerCase() };
}

/**
 * D9: a MemeWarzone generation 8 coin never takes the import route; it trades in its own Uniswap V4 pool before and
 * after graduation (1% hook fee, no import fee on top). Only asked where gen-8 is configured for the chain.
 * Returns the 409 body, or null.
 */
export async function gen8ImportRouteRefusal(input, deps = {}) {
  if (input.chainId === 101 || !(deps.gen8Config || gen8ConfigFor)(input.chainId)) return null;
  const coin = await (deps.findCoin || findGen8Coin)({ chainId: input.chainId, address: input.token, db: deps.db === undefined ? await dbPool().catch(() => null) : deps.db });
  if (!coin) return null;
  return {
    ok: false,
    error: "This coin trades in its own MemeWarzone pool, not through the import route.",
    code: "GEN8_POOL_ROUTE",
    tradePath: coin.tradePath,
    poolId: coin.poolId,
    poolKey: coin.poolKey,
  };
}

export async function importSwapQuote(req, res) {
  if (req.method !== "POST") return badMethod(res);
  try {
    const body = await readJson(req);
    const input = readSwapInput(body);
    const gen8Refusal = await gen8ImportRouteRefusal(input);
    if (gen8Refusal) return json(res, 409, gen8Refusal);
    const amountRaw = positiveRaw(body.amountRaw);
    if (!amountRaw) return json(res, 400, { ok: false, error: "amountRaw must be a positive integer" });
    const quote = input.chainId === 101
      ? await solanaQuote({ ...input, amountRaw, slippage: slippageBps(body.slippageBps) })
      : input.chainId === ROBINHOOD_MAINNET_CHAIN_ID
        ? await robinhoodQuoteCore({ ...input, amountRaw, slippage: slippageBps(body.slippageBps) })
        : await bscQuote({ ...input, amountRaw });
    res.setHeader("cache-control", "no-store");
    return json(res, 200, { ok: true, ...quote });
  } catch (error) {
    return json(res, error?.status || 500, { ok: false, error: String(error?.message || "Import swap quote failed"), code: error?.code || null });
  }
}

export async function importSwapBuild(req, res) {
  if (req.method !== "POST") return badMethod(res);
  try {
    const body = await readJson(req);
    const input = readSwapInput(body);
    const gen8Refusal = await gen8ImportRouteRefusal(input);
    if (gen8Refusal) return json(res, 409, gen8Refusal);
    const wallet = String(body.wallet || "").trim();
    if (input.chainId === 101 ? !isSolanaAddress(wallet) : !isEvmAddress(wallet)) return json(res, 400, { ok: false, error: "Invalid wallet" });
    const built = input.chainId === 101
      ? await solanaBuild({ ...input, wallet, quote: body.quote, partner: body.partner })
      : input.chainId === ROBINHOOD_MAINNET_CHAIN_ID
        ? await robinhoodBuildCore({ ...input, wallet, amountRaw: body.amountRaw ?? body.quote?.amountIn, slippage: slippageBps(body.slippageBps), partner: body.partner })
        : await bscBuild({ ...input, wallet, quote: body.quote, slippage: slippageBps(body.slippageBps), partner: body.partner });
    res.setHeader("cache-control", "no-store");
    return json(res, 200, { ok: true, ...built });
  } catch (error) {
    if (!error?.status) console.error("[api/importSwap] build failed", error);
    return json(res, error?.status || 500, { ok: false, error: String(error?.message || "Import swap build failed"), code: error?.code || null });
  }
}
