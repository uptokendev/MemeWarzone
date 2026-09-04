import { getPublicRpcUrl, type SupportedChainId } from "@/lib/chainConfig";
import { getSolanaProvider } from "@/lib/solanaWallet";
import { loadSolanaWeb3 } from "@/lib/solanaWeb3";
import {
  assertSolanaUserV0Intent,
  compileSolanaUserV0WithLatestBlockhash,
  simulateSolanaUserV0OrThrow,
} from "@/lib/solanaUserV0Transaction";

export type SolanaArenaInstructionAccount = {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
};

export type SolanaArenaInstructionEnvelope = {
  programId: string;
  instruction?: string | null;
  dataBase64: string;
  accounts: SolanaArenaInstructionAccount[];
  configPda?: string | null;
  poolPda?: string | null;
  receiptPda?: string | null;
  eventPda?: string | null;
  vaultPda?: string | null;
};

function decodeBase64(value: string): Uint8Array {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Solana Arena transaction data is missing.");
  const binary = globalThis.atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function assertEnvelope(value: SolanaArenaInstructionEnvelope) {
  if (!value?.programId || !value?.dataBase64 || !Array.isArray(value.accounts) || !value.accounts.length) {
    throw new Error("Solana Arena transaction envelope is incomplete.");
  }
  return value;
}

/**
 * Transport-only browser adapter for Agent 3's frozen Arena instruction envelope.
 * It constructs exactly the returned program/data/account metas. It does not
 * derive, decode, or decide authoritative PDA/receipt/account state.
 */
export async function sendSolanaArenaInstruction(input: {
  chainId: number;
  wallet: string;
  transaction: SolanaArenaInstructionEnvelope;
  label: string;
}): Promise<string> {
  const envelope = assertEnvelope(input.transaction);
  const provider = getSolanaProvider();
  if (!provider?.publicKey || typeof provider.signTransaction !== "function") {
    throw new Error(`Connect a Solana wallet that can sign this ${input.label}.`);
  }
  const connected = String(provider.publicKey.toString?.() || provider.publicKey).trim();
  if (!connected || connected !== String(input.wallet || "").trim()) {
    throw new Error("Connected Solana wallet does not match the Arena quote wallet.");
  }

  const web3 = await loadSolanaWeb3();
  const instruction = new web3.TransactionInstruction({
    programId: new web3.PublicKey(envelope.programId),
    keys: envelope.accounts.map((account) => ({
      pubkey: new web3.PublicKey(account.pubkey),
      isSigner: account.isSigner === true,
      isWritable: account.isWritable === true,
    })),
    data: decodeBase64(envelope.dataBase64),
  });
  const connection = new web3.Connection(getPublicRpcUrl(input.chainId as SupportedChainId), "confirmed");
  const intent = { payer: connected, instructions: [instruction] };

  const simulated = await compileSolanaUserV0WithLatestBlockhash(web3, connection, intent);
  await simulateSolanaUserV0OrThrow(connection, simulated.transaction, input.label);

  const final = await compileSolanaUserV0WithLatestBlockhash(web3, connection, intent);
  const signed = await provider.signTransaction(final.transaction);
  assertSolanaUserV0Intent(web3, signed, intent);
  const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  const confirmation = await connection.confirmTransaction({
    signature,
    blockhash: final.latest.blockhash,
    lastValidBlockHeight: final.latest.lastValidBlockHeight,
  }, "confirmed");
  if (confirmation.value.err) {
    throw new Error(`${input.label} failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  return signature;
}
