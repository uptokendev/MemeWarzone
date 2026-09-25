/**
 * Swaps for imported memecoins (founder, 2026-09-25). The API quotes and builds (it owns the 0.5%
 * fee terms -- api/importSwap.js); this module checks what came back and has the wallet sign it.
 * Solana: Jupiter. BNB: KyberSwap restricted to PancakeSwap pools. Our launchpad CREATE/BUY/SELL
 * never come through here.
 */
import { Contract, ethers, type JsonRpcSigner } from "ethers";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";

import { apiFetch } from "@/lib/apiBase";
import { confirmLaunchpadSignature, type LaunchpadConfirmConnection } from "@/lib/solanaConfirmSignature";
import { getSolanaReadConnection } from "@/lib/solanaReadConnection";
import { getSolanaProvider, getStoredSolanaWalletId } from "@/lib/solanaWallet";

export const IMPORT_SWAP_FEE_LABEL = "0.5%";
const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const KYBER_ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
// Programs a Jupiter swap may invoke at the top level; anything else is refused before signing.
const SOLANA_ALLOWED_PROGRAMS = new Set([
  JUPITER_PROGRAM,
  "ComputeBudget111111111111111111111111111111",
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
]);

export type ImportSwapSide = "buy" | "sell";

export type ImportSwapQuote = {
  chainId: number;
  provider: string;
  side: ImportSwapSide;
  amountIn: string;
  amountOut: string;
  minAmountOut: string | null;
  priceImpactPct: number | null;
  feeBps: number;
  feeNativeRaw: string | null;
  route: string[];
  quote: unknown;
};

async function readApi<T>(response: Response, label: string): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) {
    const error = new Error(String(body?.error || `${label} failed (${response.status})`)) as Error & { code?: string };
    error.code = body?.code || undefined;
    throw error;
  }
  return body as T;
}

export async function quoteImportSwap(input: { chainId: number; token: string; side: ImportSwapSide; amountRaw: bigint; slippageBps?: number; signal?: AbortSignal }) {
  const response = await apiFetch("/api/imports/swap/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId: input.chainId, token: input.token, side: input.side, amountRaw: input.amountRaw.toString(), slippageBps: input.slippageBps ?? 100 }),
    signal: input.signal,
    cache: "no-store",
  });
  return readApi<ImportSwapQuote>(response, "Swap quote");
}

async function buildImportSwap<T>(input: { chainId: number; token: string; side: ImportSwapSide; wallet: string; quote: unknown; slippageBps?: number }) {
  const response = await apiFetch("/api/imports/swap/build", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, slippageBps: input.slippageBps ?? 100 }),
    cache: "no-store",
  });
  return readApi<T>(response, "Swap build");
}

function decodeBase64(value: string) {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Refuses anything but the wallet's own Jupiter swap before the wallet is asked to sign. */
export function assertJupiterSwapForWallet(tx: VersionedTransaction, wallet: string, feeAccount: string) {
  const keys = tx.message.staticAccountKeys.map((key) => key.toBase58());
  if (keys[0] !== wallet) throw new Error("Swap fee payer is not your wallet.");
  if (Number(tx.message.header.numRequiredSignatures) !== 1) throw new Error("Swap asks for more than your signature.");
  const programs = tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]);
  if (!programs.includes(JUPITER_PROGRAM)) throw new Error("Swap does not route through Jupiter.");
  const unexpected = programs.find((program) => !SOLANA_ALLOWED_PROGRAMS.has(program));
  if (unexpected) throw new Error(`Swap calls an unexpected program (${unexpected.slice(0, 6)}…).`);
  if (!keys.includes(feeAccount)) throw new Error("Swap is missing the platform fee account.");
}

export async function executeSolanaImportSwap(input: { token: string; side: ImportSwapSide; wallet: string; quote: ImportSwapQuote; slippageBps?: number }) {
  const provider = getSolanaProvider(getStoredSolanaWalletId() || null);
  if (!provider?.publicKey || typeof provider.signTransaction !== "function") throw new Error("This Solana wallet cannot sign transactions.");
  if (String(provider.publicKey.toString()) !== input.wallet) throw new Error("Connected Solana wallet changed. Reconnect and retry.");
  const built = await buildImportSwap<{ transactionBase64: string; lastValidBlockHeight: number; feeAccount: string }>({
    chainId: 101,
    token: input.token,
    side: input.side,
    wallet: input.wallet,
    quote: input.quote.quote,
    slippageBps: input.slippageBps,
  });
  const tx = VersionedTransaction.deserialize(decodeBase64(built.transactionBase64));
  assertJupiterSwapForWallet(tx, input.wallet, built.feeAccount);
  const signed = (await provider.signTransaction(tx)) as VersionedTransaction;
  if (signed.message.staticAccountKeys[0]?.toBase58() !== input.wallet) throw new Error("Wallet returned a transaction for another payer.");
  const connection = getSolanaReadConnection();
  const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 5 });
  const confirmation = await confirmLaunchpadSignature(connection as unknown as LaunchpadConfirmConnection, { signature, lastValidBlockHeight: built.lastValidBlockHeight });
  if (confirmation.err) throw new Error(`Swap failed: ${JSON.stringify(confirmation.err)}`);
  return signature;
}

const ERC20_ABI = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
] as const;

export async function executeBscImportSwap(input: { token: string; side: ImportSwapSide; account: string; signer: JsonRpcSigner; quote: ImportSwapQuote; amountRaw: bigint; slippageBps?: number }) {
  if (input.side === "sell") {
    const erc20 = new Contract(input.token, ERC20_ABI, input.signer);
    const allowance = BigInt(await erc20.allowance(input.account, KYBER_ROUTER));
    // Exact approval for this sell only -- no standing unlimited allowance to the router.
    if (allowance < input.amountRaw) await (await erc20.approve(KYBER_ROUTER, input.amountRaw)).wait();
  }
  const built = await buildImportSwap<{ to: string; data: string; value: string }>({
    chainId: 56,
    token: input.token,
    side: input.side,
    wallet: input.account,
    quote: input.quote.quote,
    slippageBps: input.slippageBps,
  });
  if (String(built.to).toLowerCase() !== KYBER_ROUTER.toLowerCase()) throw new Error("Swap targets an unexpected router.");
  if (input.side === "sell" && BigInt(built.value || "0") !== 0n) throw new Error("A sell must not send BNB.");
  if (input.side === "buy" && BigInt(built.value || "0") !== input.amountRaw) throw new Error("Swap amount changed.");
  const tx = await input.signer.sendTransaction({ to: built.to, data: built.data, value: BigInt(built.value || "0") });
  const receipt = await tx.wait();
  if (receipt && Number(receipt.status) !== 1) throw new Error("Swap transaction reverted.");
  return tx.hash;
}

/** Token decimals from chain; the import record's scan often has none (pump.fun mints use 6). */
export async function readImportTokenDecimals(chainId: number, token: string, provider?: ethers.Provider | null): Promise<number | null> {
  try {
    if (chainId === 101) {
      const info = await getSolanaReadConnection().getParsedAccountInfo(new PublicKey(token));
      const decimals = (info.value?.data as { parsed?: { info?: { decimals?: number } } } | undefined)?.parsed?.info?.decimals;
      return Number.isInteger(decimals) ? Number(decimals) : null;
    }
    if (provider) {
      const decimals = await new Contract(token, ["function decimals() view returns (uint8)"], provider).decimals();
      return Number(decimals);
    }
  } catch {
    return null;
  }
  return null;
}
