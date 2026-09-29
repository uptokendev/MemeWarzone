/**
 * User-facing Jupiter swap from SOL into the bound quote, as its own
 * transaction the user signs. Devnet has no Jupiter; callers pass a stub.
 */
import { PublicKey, Transaction } from "@solana/web3.js";
import { WSOL_MINT } from "../../shared/dbcQuotes.mjs";

// quote-api.jup.ag/v6 no longer answers (checked 2026-09-29). The browser uses the keyless lite API.
const JUPITER_SWAP_BASE = String((typeof import.meta !== "undefined" && import.meta.env?.VITE_JUPITER_SWAP_API_BASE) || "https://lite-api.jup.ag/swap/v1").replace(/\/+$/, "");

export async function quoteSolToBoundMint({
  quoteMint,
  solLamports,
  slippageBps = 50,
  fetchImpl = fetch,
  stub,
}) {
  if (stub) return stub;
  if (!quoteMint || quoteMint === WSOL_MINT) {
    return { inAmount: BigInt(solLamports), outAmount: BigInt(solLamports), impactBps: 0n, transaction: null };
  }
  const url = new URL(`${JUPITER_SWAP_BASE}/quote`);
  url.searchParams.set("inputMint", WSOL_MINT);
  url.searchParams.set("outputMint", String(quoteMint));
  url.searchParams.set("amount", String(solLamports));
  url.searchParams.set("slippageBps", String(slippageBps));
  const quoted = await fetchImpl(url).then((r) => r.json());
  return {
    inAmount: BigInt(quoted.inAmount || solLamports),
    outAmount: BigInt(quoted.outAmount || 0),
    impactBps: BigInt(Math.round(Number(quoted.priceImpactPct || 0) * 10_000)),
    raw: quoted,
  };
}

export async function buildSolToBoundMintTransaction({
  quoteMint,
  userPublicKey,
  quoteResponse,
  fetchImpl = fetch,
  stubTransaction,
}) {
  if (stubTransaction) return stubTransaction;
  const response = await fetchImpl(`${JUPITER_SWAP_BASE}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: String(userPublicKey),
      wrapAndUnwrapSol: true,
    }),
  }).then((r) => r.json());
  const buf = Buffer.from(String(response.swapTransaction || ""), "base64");
  return Transaction.from(buf);
}

void PublicKey;
