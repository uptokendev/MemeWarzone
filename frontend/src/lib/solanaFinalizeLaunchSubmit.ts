/**
 * Sends finalize_campaign_launch from the creator's wallet.
 *
 * This is the second of the two transactions a Solana launch takes. create
 * mints the supply and opens the campaign; this writes the Metaplex metadata,
 * revokes the mint authority and creates the per-campaign fee accounts.
 *
 * They are separate because a single create carrying all of it needed four more
 * accounts and left Phantom too little of the 1232-byte packet limit to insert
 * its own Lighthouse assertions. Phantom responded by refusing to simulate and
 * warning every creator that the site might be malicious. This transaction is
 * small — roughly half the limit — so the wallet has ample room.
 *
 * The server does not send this and holds no funds. It only signs the
 * authorization that pins the name and symbol, because whoever chooses the name
 * chooses it permanently: the mint authority is revoked in the same instruction
 * that writes it. Without that signature anyone watching the chain could
 * finalize a fresh campaign under a name of their own.
 *
 * If the creator abandons the page between the two transactions the campaign is
 * inert rather than broken — it has no fee escrow, and every trade path already
 * requires one. Any funded wallet can finish it later with a fresh
 * authorization; the payer does not have to be the creator.
 */
import type { VersionedTransaction } from "@solana/web3.js";

import { apiFetch } from "@/lib/apiBase";
import { getPublicRpcUrl, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { getSolanaProvider } from "@/lib/solanaWallet";
import { loadSolanaWeb3 } from "@/lib/solanaWeb3";
import {
  buildFinalizeCampaignLaunchInstruction,
  buildLaunchpadEd25519Instruction,
  type FinalizeLaunchInstructionAccounts,
} from "@/lib/solanaLaunchpadInstructions";

export type SolanaFinalizeLaunchAuthorization = {
  schemaVersion: number;
  routeSigner: string;
  digestHex: string;
  signatureHex: string;
  args: { name: string; symbol: string; deadline: string };
  accounts: {
    campaign: string;
    mint: string;
    tokenMetadata: string;
    feeEscrow: string;
    creatorFeeVault: string;
    globalConfig: string;
  };
};

export const SOLANA_FINALIZE_LAUNCH_SCHEMA_VERSION = 1;

function hexToBytes(value: string, label: string): Uint8Array {
  const clean = String(value || "").trim();
  if (!/^[0-9a-f]*$/i.test(clean) || clean.length % 2 !== 0) {
    throw new Error(`${label} is not a hex string.`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function assertFinalizeAuthorization(
  authorization: SolanaFinalizeLaunchAuthorization | null | undefined,
): asserts authorization is SolanaFinalizeLaunchAuthorization {
  if (!authorization) {
    throw new Error("The server did not return a finalize authorization for this launch.");
  }
  if (authorization.schemaVersion !== SOLANA_FINALIZE_LAUNCH_SCHEMA_VERSION) {
    throw new Error(
      `Finalize authorization schema ${authorization.schemaVersion} is not ${SOLANA_FINALIZE_LAUNCH_SCHEMA_VERSION}. The API and this build disagree.`,
    );
  }
}

export async function submitSolanaFinalizeLaunch(input: {
  programId: string;
  authorization: SolanaFinalizeLaunchAuthorization | null | undefined;
}): Promise<{ signature: string }> {
  const { programId, authorization } = input;
  assertFinalizeAuthorization(authorization);

  const provider = getSolanaProvider();
  if (!provider?.publicKey || typeof provider.signTransaction !== "function") {
    throw new Error("Connect a Solana wallet to finish this launch.");
  }
  const payer = String(provider.publicKey.toString?.() || provider.publicKey || "");

  const web3 = await loadSolanaWeb3();
  const rpc = String(import.meta.env.VITE_SOLANA_RPC || "").trim() || getPublicRpcUrl(SOLANA_CHAIN_ID);
  if (!rpc) throw new Error("Solana RPC is not configured (VITE_SOLANA_RPC).");
  const connection = new web3.Connection(rpc, "confirmed");

  const digest = hexToBytes(authorization.digestHex, "finalize digest");
  if (digest.length !== 32) throw new Error("Finalize digest must be 32 bytes.");
  const signature = hexToBytes(authorization.signatureHex, "finalize signature");
  if (signature.length !== 64) throw new Error("Finalize signature must be 64 bytes.");

  const ed25519Instruction = buildLaunchpadEd25519Instruction(web3, {
    publicKey: authorization.routeSigner,
    message: digest,
    signature,
  });
  const accounts: FinalizeLaunchInstructionAccounts = {
    payer,
    globalConfig: authorization.accounts.globalConfig,
    campaign: authorization.accounts.campaign,
    mint: authorization.accounts.mint,
    tokenMetadata: authorization.accounts.tokenMetadata,
    feeEscrow: authorization.accounts.feeEscrow,
    creatorFeeVault: authorization.accounts.creatorFeeVault,
  };
  const programInstruction = buildFinalizeCampaignLaunchInstruction(web3, {
    programId,
    args: authorization.args,
    accounts,
  });

  const { TransactionMessage, VersionedTransaction: V0 } = web3;
  const latest = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: new web3.PublicKey(payer),
    recentBlockhash: latest.blockhash,
    // The program reads the ed25519 instruction back from the Instructions
    // sysvar at current_index - 1, so these must stay adjacent and in order.
    instructions: [ed25519Instruction, programInstruction],
  }).compileToV0Message();
  const transaction: VersionedTransaction = new V0(message);

  const signed = await provider.signTransaction(transaction);
  const raw = typeof signed?.serialize === "function" ? signed.serialize() : signed;
  const txSignature = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    maxRetries: 3,
  });
  await connection.confirmTransaction(
    {
      signature: txSignature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed",
  );
  return { signature: txSignature };
}

/**
 * Fetch a finalize authorization and send it.
 *
 * Every create path ends here — Direct Deploy, Draft Deploy and a scheduled
 * launch all produce the same half-finished campaign. Asking the server for the
 * authorization after the create has confirmed, rather than carrying one from
 * before it, keeps the deadline short and means a retry always gets a fresh
 * signature.
 *
 * Returns null when there was nothing to do, which is the normal answer for a
 * campaign somebody already finalized.
 */
export async function finalizeSolanaLaunch(input: {
  campaignAddress: string;
  programId: string;
}): Promise<{ signature: string } | null> {
  const response = (await apiFetch("/api/solana/finalize-authorize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaignAddress: input.campaignAddress }),
  })) as {
    ok?: boolean;
    alreadyFinalized?: boolean;
    authorization?: SolanaFinalizeLaunchAuthorization | null;
    error?: string;
  };
  if (!response?.ok) {
    throw new Error(response?.error || "Could not get a finalize authorization for this launch.");
  }
  if (response.alreadyFinalized || !response.authorization) return null;
  return submitSolanaFinalizeLaunch({
    programId: input.programId,
    authorization: response.authorization,
  });
}
