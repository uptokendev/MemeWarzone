/**
 * The pre-sign check for import swaps (Jupiter on Solana), shared by the app (importSwap.ts) and the
 * embeddable swap widget (src/widget). The API already re-checks the fee terms; this runs in the
 * browser so the wallet is never asked to sign anything but the user's own Jupiter swap with our fee.
 */
import type { VersionedTransaction } from "@solana/web3.js";

export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
// Programs a Jupiter swap may invoke at the top level; anything else is refused before signing.
export const SOLANA_ALLOWED_PROGRAMS = new Set([
  JUPITER_PROGRAM,
  "ComputeBudget111111111111111111111111111111",
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
]);

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
