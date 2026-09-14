import { getVoteTreasuryAddress, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { confirmLaunchpadSignature } from "@/lib/solanaConfirmSignature";
import { getSolanaProvider } from "@/lib/solanaWallet";
import type { SolanaWeb3Module } from "@/lib/solanaWeb3";
import {
  assertSolanaUserV0Intent,
  compileSolanaUserV0WithLatestBlockhash,
  simulateSolanaUserV0OrThrow,
} from "@/lib/solanaUserV0Transaction";

const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export async function submitSolanaUpvoteV0(input: {
  web3: SolanaWeb3Module;
  connection: InstanceType<SolanaWeb3Module["Connection"]>;
  voterAddress: string;
  treasuryAddress: string;
  campaignAddress: string;
  lamports: number;
}): Promise<string> {
  const provider = getSolanaProvider();
  if (!provider?.publicKey || typeof provider.signTransaction !== "function") {
    throw new Error("Connect a Solana wallet that can sign this UP Vote.");
  }

  const connected = String(provider.publicKey.toString?.() || provider.publicKey || "").trim();
  if (!connected || connected !== String(input.voterAddress || "").trim()) {
    throw new Error("Connected Solana wallet changed before UP Vote submission.");
  }

  const canonicalTreasury = String(getVoteTreasuryAddress(SOLANA_CHAIN_ID) || "").trim();
  if (!canonicalTreasury || canonicalTreasury !== String(input.treasuryAddress || "").trim()) {
    throw new Error("Solana UP Vote treasury does not match the configured canonical treasury.");
  }
  if (!Number.isSafeInteger(input.lamports) || input.lamports <= 0) {
    throw new Error("Invalid Solana UP Vote lamport amount.");
  }

  const from = new input.web3.PublicKey(connected);
  const to = new input.web3.PublicKey(canonicalTreasury);
  const campaign = new input.web3.PublicKey(input.campaignAddress);
  void campaign; // constructor validation proves this is a canonical Solana address.

  const memoIx = new input.web3.TransactionInstruction({
    keys: [{ pubkey: from, isSigner: true, isWritable: false }],
    programId: new input.web3.PublicKey(MEMO_PROGRAM_ID),
    data: new TextEncoder().encode(`mwz-upvote:${input.campaignAddress}`),
  });
  const transferIx = input.web3.SystemProgram.transfer({
    fromPubkey: from,
    toPubkey: to,
    lamports: input.lamports,
  });
  const intent = {
    payer: connected,
    instructions: [memoIx, transferIx],
  };

  const simulated = await compileSolanaUserV0WithLatestBlockhash(input.web3, input.connection, intent);
  await simulateSolanaUserV0OrThrow(input.connection, simulated.transaction, "Solana UP Vote");

  // Recompile after simulation so the wallet receives a fresh blockhash.
  const final = await compileSolanaUserV0WithLatestBlockhash(input.web3, input.connection, intent);
  const signed = await provider.signTransaction(final.transaction);
  assertSolanaUserV0Intent(input.web3, signed, intent);

  const signature = await input.connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  const confirmation = await confirmLaunchpadSignature(input.connection, {
    signature,
    lastValidBlockHeight: final.latest.lastValidBlockHeight,
  });
  if (confirmation.err) {
    throw new Error(`Solana UP Vote failed: ${JSON.stringify(confirmation.err)}`);
  }
  return signature;
}
