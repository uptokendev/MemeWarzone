import type { TransactionInstruction } from "@solana/web3.js";

import { apiFetch } from "@/lib/apiBase";
import { getPublicRpcUrl, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { confirmLaunchpadSignature, type LaunchpadConfirmConnection } from "@/lib/solanaConfirmSignature";
import {
  SOLANA_WALLET_REWRITE_BUDGET_BYTES,
  assertSolanaUserV0Intent,
  compileSolanaUserV0WithLatestBlockhash,
  simulateSolanaUserV0OrThrow,
} from "@/lib/solanaUserV0Transaction";
import { SOLANA_LAUNCHPAD_PROGRAM_ID } from "@/lib/solanaV0Transaction";
import { getSolanaProvider } from "@/lib/solanaWallet";
import { loadSolanaWeb3, type SolanaWeb3Module } from "@/lib/solanaWeb3";

/** Anchor sha256("global:claim_creator_fees")[0..8] */
export const CLAIM_CREATOR_FEES_DISCRIMINATOR = new Uint8Array([0x00, 0x17, 0x7d, 0xea, 0x9c, 0x76, 0x86, 0x59]);

export type CreatorFeeItem = {
  chainId: number;
  campaignAddress: string;
  tokenAddress: string | null;
  name: string | null;
  symbol: string | null;
  logoUri: string | null;
  feeEscrow: string;
  creatorFeeVault: string;
  escrowInitialized: boolean;
  vaultInitialized: boolean;
  escrowSurplusLamports: string;
  vaultSurplusLamports: string;
  claimableLamports: string;
  claimableSol: string;
};

export async function fetchCreatorFees(creator: string): Promise<CreatorFeeItem[]> {
  const wallet = String(creator || "").trim();
  if (!wallet) return [];
  const res = await apiFetch(`/api/solana/creator-fees?creator=${encodeURIComponent(wallet)}`, { cache: "no-store" });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(String(payload?.error || `Creator fee lookup failed (${res.status})`));
  return Array.isArray(payload?.items) ? (payload.items as CreatorFeeItem[]) : [];
}

/**
 * claim_creator_fees: creator (signer, writable), campaign, creator_fee_vault
 * (writable), fee_escrow (writable). No arguments, no route authorization --
 * the program pays whoever the campaign names as creator, and only them.
 */
export function buildClaimCreatorFeesInstruction(
  web3: SolanaWeb3Module,
  input: { creator: string; campaignAddress: string; feeEscrow: string; creatorFeeVault: string; programId?: string },
): TransactionInstruction {
  const { PublicKey, TransactionInstruction: Instruction } = web3;
  return new Instruction({
    programId: new PublicKey(input.programId || SOLANA_LAUNCHPAD_PROGRAM_ID),
    keys: [
      { pubkey: new PublicKey(input.creator), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(input.campaignAddress), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(input.creatorFeeVault), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(input.feeEscrow), isSigner: false, isWritable: true },
    ],
    data: Buffer.from(CLAIM_CREATOR_FEES_DISCRIMINATOR),
  });
}

function launchpadRpcUrl(): string {
  return String(import.meta.env.VITE_SOLANA_RPC || "").trim() || getPublicRpcUrl(SOLANA_CHAIN_ID);
}

export async function submitSolanaCreatorFeeClaim(item: Pick<CreatorFeeItem, "campaignAddress" | "feeEscrow" | "creatorFeeVault">): Promise<string> {
  const provider = getSolanaProvider();
  if (!provider?.publicKey || typeof provider.signTransaction !== "function") {
    throw new Error("Connect a Solana wallet that can sign the creator fee claim.");
  }
  const creator = String(provider.publicKey.toString?.() || provider.publicKey);

  const web3 = await loadSolanaWeb3();
  const connection = new web3.Connection(launchpadRpcUrl(), "confirmed");
  const instruction = buildClaimCreatorFeesInstruction(web3, {
    creator,
    campaignAddress: item.campaignAddress,
    feeEscrow: item.feeEscrow,
    creatorFeeVault: item.creatorFeeVault,
  });

  // Same shape as the reward claims: simulate first so a wallet never sees a
  // transaction that fails, then rebuild on a fresh blockhash for signing.
  const intent = {
    payer: creator,
    instructions: [instruction],
    walletRewriteBudgetBytes: SOLANA_WALLET_REWRITE_BUDGET_BYTES,
  };
  const label = "Solana creator fee claim";
  const simulated = await compileSolanaUserV0WithLatestBlockhash(web3, connection, intent);
  await simulateSolanaUserV0OrThrow(connection, simulated.transaction, label);

  const final = await compileSolanaUserV0WithLatestBlockhash(web3, connection, intent);
  const signed = await provider.signTransaction(final.transaction);
  // Wallets may prepend compute-budget / safety instructions; the claim itself must be unchanged.
  assertSolanaUserV0Intent(web3, signed, { ...intent, allowAdditionalInstructions: true });

  const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  // web3's Connection satisfies the confirm helper at runtime; its generic
  // signature is just wider than the structural type declares.
  const confirmation = await confirmLaunchpadSignature(connection as unknown as LaunchpadConfirmConnection, {
    signature,
    lastValidBlockHeight: final.latest.lastValidBlockHeight,
    recover: async () => false,
  });
  if (confirmation.err) throw new Error(`${label} failed: ${JSON.stringify(confirmation.err)}`);
  return signature;
}
