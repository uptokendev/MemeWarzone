import type { TransactionInstruction } from "@solana/web3.js";

import {
  submitArenaUserV0,
  type ArenaInstructionBuild,
} from "@/lib/solanaArenaV0";
import { getSolanaReadConnection } from "@/lib/solanaReadConnection";
import { getSolanaProvider } from "@/lib/solanaWallet";
import { loadSolanaWeb3 } from "@/lib/solanaWeb3";

export async function runSolanaArenaUserAction(input: {
  walletAddress: string;
  label: string;
  recoveryReceipt?: string;
  build: (web3: Awaited<ReturnType<typeof loadSolanaWeb3>>) => Promise<
    ArenaInstructionBuild | { instruction?: TransactionInstruction; instructions?: TransactionInstruction[] }
  >;
}): Promise<string> {
  const provider = getSolanaProvider();
  const connected = String(provider?.publicKey?.toString?.() || "").trim();
  if (!connected || connected !== String(input.walletAddress || "").trim()) {
    throw new Error("Connect the Solana owner wallet for this Warzone action.");
  }
  const web3 = await loadSolanaWeb3();
  const built = await input.build(web3);
  return submitArenaUserV0({
    web3,
    connection: getSolanaReadConnection(),
    walletAddress: connected,
    instruction: "instruction" in built ? built.instruction : undefined,
    instructions: "instructions" in built ? built.instructions : undefined,
    label: input.label,
    recoveryReceipt: input.recoveryReceipt || ("receipt" in built ? built.receipt : undefined),
  });
}
