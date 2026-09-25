/**
 * Swaps for imported memecoins (founder, 2026-09-25): coins that trade on outside DEXes, not on our
 * launchpad. Our launchpad CREATE / BUY / SELL are untouched -- this is a separate path.
 *
 * Solana (101): Jupiter Swap API -- routes Meteora, PumpSwap, pump.fun, Raydium, Orca, ...
 *   0.5% platform fee, always in SOL: a wrapped-SOL token account owned by the capped protocol
 *   operator (route_state.operator 2AMfRaxS..., read from chain 2026-09-25). Buy: SOL is the input
 *   mint, sell: SOL is the output mint, so one WSOL account collects both. Proven by simulation on
 *   mainnet: 0.01 SOL buy -> 50000 lamports to the fee account; a sell -> exactly quote.platformFee.
 * BNB (56): KyberSwap aggregator restricted to PancakeSwap pools (v2, v3, Infinity, legacy). The
 *   0.5% is charged in BNB inside the swap (buy: from the input, sell: from the output) and paid to
 *   the BNB ProtocolRevenueVault, which enforces the $10k operator cap and overflows to the Safe.
 *
 * The API owns the fee terms: build re-checks every fee field of the quote it is handed, so the
 * app cannot be talked into a fee-free or re-routed fee swap. (A user can still call Jupiter or
 * Kyber directly; this protects our UI, not the DEXes.)
 */
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { badMethod, json, readJson } from "../server/http.js";

export const IMPORT_SWAP_FEE_BPS = Math.max(0, Math.min(200, Number(process.env.IMPORT_SWAP_FEE_BPS || 50)));

const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const SOLANA_FEE_OWNER = String(process.env.SOLANA_IMPORT_SWAP_FEE_OWNER || "2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB").trim();
const JUPITER_BASE = String(
  process.env.JUPITER_SWAP_API_BASE || (process.env.JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1"),
).replace(/\/+$/, "");

export const BSC_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const KYBER_ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
const KYBER_BASE = "https://aggregator-api.kyberswap.com/bsc/api/v1";
const KYBER_PANCAKE_SOURCES = "pancake,pancake-v3,pancake-infinity-cl,pancake-infinity-bin,pancake-legacy";
const BSC_FEE_RECEIVER = String(process.env.IMPORT_SWAP_FEE_RECEIVER_56 || "0xc2d4E6f846446f3921a34A34e007295dbc19Bc4c").trim().toLowerCase();

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

function slippageBps(value) {
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
  const url = String(process.env.SOLANA_RPC_URL || process.env.VITE_SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com").trim();
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
export function assertSolanaQuoteTerms(quote, { token, side, feeBps = IMPORT_SWAP_FEE_BPS }) {
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
    platformFeeBps: String(IMPORT_SWAP_FEE_BPS),
    swapMode: "ExactIn",
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
    feeBps: IMPORT_SWAP_FEE_BPS,
    // Buy: the fee is 0.5% of the SOL in; sell: of the SOL out (quote.platformFee.amount).
    feeNativeRaw: side === "buy" ? ((BigInt(quote.inAmount) * BigInt(IMPORT_SWAP_FEE_BPS)) / 10_000n).toString() : String(quote.platformFee?.amount || "0"),
    route: (quote.routePlan || []).map((step) => step?.swapInfo?.label).filter(Boolean),
    quote,
  };
}

async function solanaBuild({ token, side, wallet, quote }) {
  assertSolanaQuoteTerms(quote, { token, side });
  await assertSolanaFeeAccountReady();
  const feeAccount = solanaFeeAccount();
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
  return { chainId: 101, provider: "jupiter", transactionBase64: built.swapTransaction, lastValidBlockHeight: Number(built.lastValidBlockHeight || 0), feeAccount };
}

function kyberHeaders() {
  return { "x-client-id": String(process.env.KYBER_CLIENT_ID || "memewarzone"), "content-type": "application/json", accept: "application/json" };
}

function bscPair(token, side) {
  return side === "buy" ? { tokenIn: BSC_NATIVE, tokenOut: token } : { tokenIn: token, tokenOut: BSC_NATIVE };
}

/** Throws unless the route is exactly the swap we fee: BNB<->token, our fee in BNB to the vault. */
export function assertBscRouteTerms(summary, { token, side, feeBps = IMPORT_SWAP_FEE_BPS, feeReceiver = BSC_FEE_RECEIVER }) {
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
  if (!exchanges.length || exchanges.some((exchange) => !exchange.startsWith("pancake"))) {
    throw Object.assign(new Error("Route leaves PancakeSwap pools"), { status: 400 });
  }
}

async function bscQuote({ token, side, amountRaw }) {
  const { tokenIn, tokenOut } = bscPair(token, side);
  const params = new URLSearchParams({
    tokenIn,
    tokenOut,
    amountIn: amountRaw.toString(),
    includedSources: KYBER_PANCAKE_SOURCES,
    feeAmount: String(IMPORT_SWAP_FEE_BPS),
    chargeFeeBy: side === "buy" ? "currency_in" : "currency_out",
    isInBps: "true",
    feeReceiver: BSC_FEE_RECEIVER,
  });
  const body = await fetchJson(`${KYBER_BASE}/routes?${params}`, { headers: kyberHeaders() }, "Kyber route");
  const summary = body?.data?.routeSummary;
  if (!summary?.amountOut) throw Object.assign(new Error("No PancakeSwap route for this token"), { status: 422, code: "IMPORT_SWAP_NO_ROUTE" });
  assertBscRouteTerms(summary, { token, side });
  const amountIn = BigInt(summary.amountIn);
  return {
    chainId: 56,
    provider: "kyberswap-pancakeswap",
    side,
    amountIn: summary.amountIn,
    amountOut: summary.amountOut,
    minAmountOut: null,
    priceImpactPct: null,
    feeBps: IMPORT_SWAP_FEE_BPS,
    feeNativeRaw: side === "buy" ? ((amountIn * BigInt(IMPORT_SWAP_FEE_BPS)) / 10_000n).toString() : null,
    route: (summary.route || []).flat().map((hop) => hop?.exchange).filter(Boolean),
    quote: summary,
  };
}

async function bscBuild({ token, side, wallet, quote, slippage }) {
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
  return { chainId: 56, provider: "kyberswap-pancakeswap", to: KYBER_ROUTER, data: data.data, value, amountOut: data.amountOut, spender: KYBER_ROUTER };
}

function readSwapInput(body) {
  const chainId = Number(body?.chainId);
  const side = String(body?.side || "").toLowerCase();
  const token = String(body?.token || body?.tokenAddress || "").trim();
  if (side !== "buy" && side !== "sell") throw Object.assign(new Error("side must be buy or sell"), { status: 400 });
  if (chainId === 101) {
    if (!isSolanaAddress(token) || token === WSOL) throw Object.assign(new Error("Invalid Solana token"), { status: 400 });
  } else if (chainId === 56) {
    if (!isEvmAddress(token)) throw Object.assign(new Error("Invalid BNB token"), { status: 400 });
  } else {
    throw Object.assign(new Error("Import swaps run on Solana and BNB Chain"), { status: 400 });
  }
  return { chainId, side, token: chainId === 56 ? token.toLowerCase() : token };
}

export async function importSwapQuote(req, res) {
  if (req.method !== "POST") return badMethod(res);
  try {
    const body = await readJson(req);
    const input = readSwapInput(body);
    const amountRaw = positiveRaw(body.amountRaw);
    if (!amountRaw) return json(res, 400, { ok: false, error: "amountRaw must be a positive integer" });
    const quote = input.chainId === 101
      ? await solanaQuote({ ...input, amountRaw, slippage: slippageBps(body.slippageBps) })
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
    const wallet = String(body.wallet || "").trim();
    if (input.chainId === 101 ? !isSolanaAddress(wallet) : !isEvmAddress(wallet)) return json(res, 400, { ok: false, error: "Invalid wallet" });
    const built = input.chainId === 101
      ? await solanaBuild({ ...input, wallet, quote: body.quote })
      : await bscBuild({ ...input, wallet, quote: body.quote, slippage: slippageBps(body.slippageBps) });
    res.setHeader("cache-control", "no-store");
    return json(res, 200, { ok: true, ...built });
  } catch (error) {
    if (!error?.status) console.error("[api/importSwap] build failed", error);
    return json(res, error?.status || 500, { ok: false, error: String(error?.message || "Import swap build failed"), code: error?.code || null });
  }
}
