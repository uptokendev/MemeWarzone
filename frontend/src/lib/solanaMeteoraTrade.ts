import BN from "bn.js";
import {
  CpAmm,
  deriveCustomizablePoolAddress,
} from "@meteora-ag/cp-amm-sdk";
import {
  Connection,
  PublicKey,
  type Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { confirmLaunchpadSignature } from "@/lib/solanaConfirmSignature";
import { getSolanaReadConnection } from "@/lib/solanaReadConnection";
import {
  getSolanaProvider,
  getStoredSolanaWallet,
  getStoredSolanaWalletId,
} from "@/lib/solanaWallet";
import { loadSolanaWeb3 } from "@/lib/solanaWeb3";
import {
  assertSolanaUserV0Intent,
  compileSolanaUserV0WithLatestBlockhash,
  simulateSolanaUserV0OrThrow,
} from "@/lib/solanaUserV0Transaction";

export const METEORA_CP_AMM_PROGRAM_ID = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";

const SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SOLANA_SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const SOLANA_COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";

const METEORA_ALLOWED_PROGRAM_IDS = new Set([
  METEORA_CP_AMM_PROGRAM_ID,
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
  SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID,
  SOLANA_SYSTEM_PROGRAM_ID,
  SOLANA_COMPUTE_BUDGET_PROGRAM_ID,
]);

export type SolanaMeteoraSide = "buy" | "sell";

export type SolanaMeteoraQuote = {
  side: SolanaMeteoraSide;
  pool: string;
  inputMint: string;
  outputMint: string;
  amountInRaw: bigint;
  amountOutRaw: bigint;
  minimumAmountOutRaw: bigint;
  feeRaw: bigint;
  priceImpactPct: number;
};

type LoadedMarket = {
  connection: Connection;
  cpAmm: CpAmm;
  pool: PublicKey;
  mint: PublicKey;
  poolState: Awaited<ReturnType<CpAmm["fetchPoolState"]>>;
  tokenADecimals: number;
  tokenBDecimals: number;
};

function toBigInt(value: BN | { toString(): string } | bigint | number | string): bigint {
  return typeof value === "bigint" ? value : BigInt(value.toString());
}

function toNumber(value: unknown): number {
  const n = Number(value instanceof Object && "toString" in value ? String(value) : value);
  return Number.isFinite(n) ? n : 0;
}

function assertPositiveRaw(value: bigint, label: string) {
  if (value <= 0n) throw new Error(`${label} must be greater than zero.`);
  if (value > 18_446_744_073_709_551_615n) throw new Error(`${label} exceeds u64.`);
}

function tokenDecimalsForMint(mint: PublicKey, launchMint: PublicKey, launchDecimals: number): number {
  if (mint.equals(launchMint)) return launchDecimals;
  if (mint.equals(NATIVE_MINT)) return 9;
  throw new Error(`Unexpected Meteora pool mint ${mint.toBase58()}.`);
}

async function loadVerifiedMarket(input: {
  mint: string;
  tokenDecimals: number;
  poolAddress?: string | null;
}): Promise<LoadedMarket> {
  const connection = getSolanaReadConnection();
  const mint = new PublicKey(input.mint);
  const expectedPool = deriveCustomizablePoolAddress(mint, NATIVE_MINT);
  if (input.poolAddress && !new PublicKey(input.poolAddress).equals(expectedPool)) {
    throw new Error("Indexed Meteora pool does not match the deterministic launch-token/SOL pool.");
  }

  const cpAmm = new CpAmm(connection);
  const poolState = await cpAmm.fetchPoolState(expectedPool);
  const pairOk =
    (poolState.tokenAMint.equals(mint) && poolState.tokenBMint.equals(NATIVE_MINT)) ||
    (poolState.tokenBMint.equals(mint) && poolState.tokenAMint.equals(NATIVE_MINT));
  if (!pairOk) throw new Error("Meteora pool token pair does not match this campaign.");

  return {
    connection,
    cpAmm,
    pool: expectedPool,
    mint,
    poolState,
    tokenADecimals: tokenDecimalsForMint(poolState.tokenAMint, mint, input.tokenDecimals),
    tokenBDecimals: tokenDecimalsForMint(poolState.tokenBMint, mint, input.tokenDecimals),
  };
}

async function exactInQuote(
  market: LoadedMarket,
  side: SolanaMeteoraSide,
  amountInRaw: bigint,
  slippagePct: number,
): Promise<SolanaMeteoraQuote> {
  assertPositiveRaw(amountInRaw, "Swap input");
  const inputMint = side === "buy" ? NATIVE_MINT : market.mint;
  const outputMint = side === "buy" ? market.mint : NATIVE_MINT;
  const currentSlot = await market.connection.getSlot("confirmed");
  const blockTime = (await market.connection.getBlockTime(currentSlot)) ?? Math.floor(Date.now() / 1000);
  const quote = await market.cpAmm.getQuote({
    inAmount: new BN(amountInRaw.toString()),
    inputTokenMint: inputMint,
    slippage: slippagePct,
    poolState: market.poolState,
    currentTime: blockTime,
    currentSlot,
    tokenADecimal: market.tokenADecimals,
    tokenBDecimal: market.tokenBDecimals,
    hasReferral: false,
  });
  return {
    side,
    pool: market.pool.toBase58(),
    inputMint: inputMint.toBase58(),
    outputMint: outputMint.toBase58(),
    amountInRaw,
    amountOutRaw: toBigInt(quote.swapOutAmount),
    minimumAmountOutRaw: toBigInt(quote.minSwapOutAmount),
    feeRaw: toBigInt(quote.totalFee),
    priceImpactPct: toNumber(quote.priceImpact),
  };
}

export type SolanaMeteoraPoolSnapshot = {
  pool: string;
  tokenVault: string;
  nativeVault: string;
  tokenReserveRaw: bigint;
  nativeReserveRaw: bigint;
  priceSol: number;
  liquiditySol: number;
};

/** Live DAMM v2 reserves → spot SOL/token and 2× SOL-side liquidity. */
export async function fetchSolanaMeteoraPoolSnapshot(input: {
  mint: string;
  tokenDecimals: number;
  poolAddress?: string | null;
}): Promise<SolanaMeteoraPoolSnapshot> {
  const market = await loadVerifiedMarket(input);
  const tokenIsA = market.poolState.tokenAMint.equals(market.mint);
  const tokenVault = tokenIsA ? market.poolState.tokenAVault : market.poolState.tokenBVault;
  const nativeVault = tokenIsA ? market.poolState.tokenBVault : market.poolState.tokenAVault;
  const [tokenBal, nativeBal] = await Promise.all([
    market.connection.getTokenAccountBalance(tokenVault),
    market.connection.getTokenAccountBalance(nativeVault),
  ]);
  const tokenReserveRaw = BigInt(tokenBal.value.amount || "0");
  const nativeReserveRaw = BigInt(nativeBal.value.amount || "0");
  const tokenWhole = Number(tokenBal.value.uiAmount ?? 0);
  const nativeWhole = Number(nativeBal.value.uiAmount ?? 0);
  const priceSol = tokenWhole > 0 ? nativeWhole / tokenWhole : 0;
  return {
    pool: market.pool.toBase58(),
    tokenVault: tokenVault.toBase58(),
    nativeVault: nativeVault.toBase58(),
    tokenReserveRaw,
    nativeReserveRaw,
    priceSol: Number.isFinite(priceSol) && priceSol > 0 ? priceSol : 0,
    liquiditySol: Number.isFinite(nativeWhole) && nativeWhole > 0 ? nativeWhole * 2 : 0,
  };
}

/**
 * Quote an exact-input DAMM v2 trade.
 * Buy input is SOL lamports; sell input is launch-token base units.
 */
export async function quoteSolanaMeteoraExactIn(input: {
  side: SolanaMeteoraSide;
  mint: string;
  tokenDecimals: number;
  amountInRaw: bigint;
  slippagePct: number;
  poolAddress?: string | null;
}): Promise<SolanaMeteoraQuote> {
  const market = await loadVerifiedMarket(input);
  return exactInQuote(market, input.side, input.amountInRaw, input.slippagePct);
}

/**
 * Quote the smallest exact-input amount whose expected output reaches the requested
 * output. We deliberately execute the resulting swap as exact-input so every wallet
 * follows the same SDK path and retains normal min-output slippage protection.
 */
export async function quoteSolanaMeteoraForDesiredOutput(input: {
  side: SolanaMeteoraSide;
  mint: string;
  tokenDecimals: number;
  desiredOutputRaw: bigint;
  slippagePct: number;
  poolAddress?: string | null;
}): Promise<SolanaMeteoraQuote> {
  assertPositiveRaw(input.desiredOutputRaw, "Desired output");
  const market = await loadVerifiedMarket(input);

  let low = 0n;
  let high = 1n;
  let highQuote: SolanaMeteoraQuote | null = null;
  for (let i = 0; i < 64; i += 1) {
    highQuote = await exactInQuote(market, input.side, high, input.slippagePct);
    if (highQuote.amountOutRaw >= input.desiredOutputRaw) break;
    high *= 2n;
    if (high > 18_446_744_073_709_551_615n) throw new Error("Requested Meteora output is too large.");
  }
  if (!highQuote || highQuote.amountOutRaw < input.desiredOutputRaw) {
    throw new Error("Meteora pool cannot satisfy the requested output amount.");
  }

  for (let i = 0; i < 64 && low + 1n < high; i += 1) {
    const mid = low + (high - low) / 2n;
    const quote = await exactInQuote(market, input.side, mid, input.slippagePct);
    if (quote.amountOutRaw >= input.desiredOutputRaw) {
      high = mid;
      highQuote = quote;
    } else {
      low = mid;
    }
  }
  if (!highQuote || highQuote.amountInRaw !== high) {
    highQuote = await exactInQuote(market, input.side, high, input.slippagePct);
  }
  return highQuote;
}

function assertMeteoraInstructionEnvelope(input: {
  instructions: TransactionInstruction[];
  wallet: PublicKey;
  pool: PublicKey;
  launchMint: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
}) {
  if (!input.instructions.length) throw new Error("Meteora SDK returned an empty transaction.");

  let meteoraInstructionCount = 0;
  let walletSignerSeen = false;
  const referenced = new Set<string>();

  for (const instruction of input.instructions) {
    const programId = instruction.programId.toBase58();
    if (!METEORA_ALLOWED_PROGRAM_IDS.has(programId)) {
      throw new Error(`Unexpected program in Meteora swap: ${programId}`);
    }
    if (programId === METEORA_CP_AMM_PROGRAM_ID) meteoraInstructionCount += 1;

    for (const key of instruction.keys) {
      const address = key.pubkey.toBase58();
      referenced.add(address);
      if (key.isSigner) {
        if (!key.pubkey.equals(input.wallet)) {
          throw new Error(`Unexpected signer in Meteora swap: ${address}`);
        }
        walletSignerSeen = true;
      }
    }
  }

  if (meteoraInstructionCount < 1) throw new Error("Meteora swap instruction is missing.");
  if (!walletSignerSeen) throw new Error("Connected wallet is not the signer of the Meteora swap.");

  for (const [label, key] of [
    ["pool", input.pool],
    ["launch mint", input.launchMint],
    ["input mint", input.inputMint],
    ["output mint", input.outputMint],
  ] as const) {
    if (!referenced.has(key.toBase58())) {
      throw new Error(`Meteora swap does not reference expected ${label} ${key.toBase58()}.`);
    }
  }
}

async function sendWalletV0Transaction(
  connection: Connection,
  legacyTransaction: Transaction,
  walletAddress: PublicKey,
  validation: {
    pool: PublicKey;
    launchMint: PublicKey;
    inputMint: PublicKey;
    outputMint: PublicKey;
  },
): Promise<string> {
  const walletId = getStoredSolanaWalletId();
  const provider = getSolanaProvider(walletId || null);
  if (!provider?.publicKey || typeof provider.signTransaction !== "function") {
    throw new Error("This Solana wallet cannot sign V0 transactions.");
  }
  const providerAddress = String(provider.publicKey?.toString?.() || "").trim();
  if (!providerAddress || providerAddress !== walletAddress.toBase58()) {
    throw new Error("Connected Solana wallet changed. Reconnect the selected wallet and retry.");
  }

  const instructions = Array.from(legacyTransaction.instructions || []);
  assertMeteoraInstructionEnvelope({
    instructions,
    wallet: walletAddress,
    ...validation,
  });

  const web3 = await loadSolanaWeb3();
  const intent = { payer: walletAddress.toBase58(), instructions };
  const simulated = await compileSolanaUserV0WithLatestBlockhash(web3, connection, intent);
  await simulateSolanaUserV0OrThrow(connection, simulated.transaction, "Meteora swap");

  // Recompile after simulation so wallet signing always uses a fresh blockhash.
  const final = await compileSolanaUserV0WithLatestBlockhash(web3, connection, intent);
  const signed = await provider.signTransaction(final.transaction);
  assertSolanaUserV0Intent(web3, signed, {
    ...intent,
    // Phantom may append wallet safety / priority instructions. The exact Meteora
    // SDK instruction sequence must remain contiguous and unchanged.
    allowAdditionalInstructions: true,
  });

  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 5,
  });
  const confirmation = await confirmLaunchpadSignature(connection, {
    signature,
    lastValidBlockHeight: final.latest.lastValidBlockHeight,
  });
  if (confirmation.err) throw new Error(`Meteora swap failed: ${JSON.stringify(confirmation.err)}`);
  return signature;
}

/** Execute a previously displayed quote against the verified deterministic DAMM v2 pool. */
export async function executeSolanaMeteoraSwap(input: {
  quote: SolanaMeteoraQuote;
  mint: string;
  tokenDecimals: number;
  walletAddress?: string | null;
  poolAddress?: string | null;
}): Promise<{ signature: string; quote: SolanaMeteoraQuote }> {
  const market = await loadVerifiedMarket({
    mint: input.mint,
    tokenDecimals: input.tokenDecimals,
    poolAddress: input.poolAddress || input.quote.pool,
  });
  if (market.pool.toBase58() !== input.quote.pool) throw new Error("Meteora quote pool changed.");

  const expectedInputMint = input.quote.side === "buy" ? NATIVE_MINT : market.mint;
  const expectedOutputMint = input.quote.side === "buy" ? market.mint : NATIVE_MINT;
  if (input.quote.inputMint !== expectedInputMint.toBase58()) throw new Error("Meteora quote input mint changed.");
  if (input.quote.outputMint !== expectedOutputMint.toBase58()) throw new Error("Meteora quote output mint changed.");
  assertPositiveRaw(input.quote.amountInRaw, "Swap input");
  assertPositiveRaw(input.quote.minimumAmountOutRaw, "Minimum swap output");
  if (input.quote.minimumAmountOutRaw > input.quote.amountOutRaw) {
    throw new Error("Meteora minimum output exceeds quoted output.");
  }

  const storedWallet = String(input.walletAddress || getStoredSolanaWallet() || "").trim();
  if (!storedWallet) throw new Error("Connect a Solana wallet first.");
  const wallet = new PublicKey(storedWallet);
  const inputMint = new PublicKey(input.quote.inputMint);
  const outputMint = new PublicKey(input.quote.outputMint);
  const built = await market.cpAmm.swap({
    payer: wallet,
    pool: market.pool,
    inputTokenMint: inputMint,
    outputTokenMint: outputMint,
    amountIn: new BN(input.quote.amountInRaw.toString()),
    minimumAmountOut: new BN(input.quote.minimumAmountOutRaw.toString()),
    tokenAVault: market.poolState.tokenAVault,
    tokenBVault: market.poolState.tokenBVault,
    tokenAMint: market.poolState.tokenAMint,
    tokenBMint: market.poolState.tokenBMint,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
    referralTokenAccount: null,
    poolState: market.poolState,
  });
  const builder = built as {
    transaction?: () => Promise<Transaction> | Transaction;
    build?: () => Promise<Transaction> | Transaction;
  };
  const transaction =
    typeof builder.transaction === "function"
      ? await builder.transaction()
      : typeof builder.build === "function"
        ? await builder.build()
        : (built as Transaction);
  const signature = await sendWalletV0Transaction(market.connection, transaction, wallet, {
    pool: market.pool,
    launchMint: market.mint,
    inputMint,
    outputMint,
  });
  return { signature, quote: input.quote };
}
