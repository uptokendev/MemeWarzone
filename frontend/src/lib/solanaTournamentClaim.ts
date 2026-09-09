import { confirmLaunchpadSignature } from "@/lib/solanaConfirmSignature";
import { getSolanaRewardRpcUrl, isSolanaRewardChainId } from "@/lib/solanaRewardNetwork";
import {
  assertSolanaUserV0Intent,
  compileSolanaUserV0WithLatestBlockhash,
  simulateSolanaUserV0OrThrow,
} from "@/lib/solanaUserV0Transaction";
import { getSolanaProvider } from "@/lib/solanaWallet";
import { loadSolanaWeb3 } from "@/lib/solanaWeb3";

const CANONICAL_PROGRAM = "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX";

export type SolanaTournamentClaimCall = {
  rewardLedgerId: string;
  chainId: number;
  tokenSymbol: string;
  mode: "solana_tournament";
  kind: "solana_tournament";
  enabled: boolean;
  reason: string | null;
  instruction: "claim_competition_winner_v2";
  programId: string;
  poolAddress: string;
  recipient: string;
  competitionId: string;
  amount: string;
};

function hex32(value: string): Uint8Array {
  const hex = String(value || "").trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("Invalid Tournament competition id.");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function discriminator(name: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${name}`));
  return new Uint8Array(digest).slice(0, 8);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

async function poolClaimed(connection: any, PublicKey: any, poolAddress: string): Promise<boolean> {
  const account = await connection.getAccountInfo(new PublicKey(poolAddress), "confirmed");
  return Boolean(account?.data && account.data.length > 335 && account.data[335] === 1);
}

export async function submitSolanaTournamentClaim(call: SolanaTournamentClaimCall): Promise<string> {
  if (!call.enabled) throw new Error(call.reason || "Solana Tournament claim is not ready.");
  if (!isSolanaRewardChainId(call.chainId)) throw new Error("Wrong Solana chain for Tournament claim.");
  if (call.programId !== CANONICAL_PROGRAM) throw new Error("Unexpected Solana Tournament rewards program.");

  const web3 = await loadSolanaWeb3();
  const { PublicKey, TransactionInstruction } = web3;
  const programId = new PublicKey(call.programId);
  const recipient = new PublicKey(call.recipient);
  const competition = hex32(call.competitionId);
  const [expectedPool] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("arena_competition_v2"), competition],
    programId,
  );
  if (expectedPool.toBase58() !== call.poolAddress) throw new Error("Solana Tournament pool PDA mismatch.");

  const provider = getSolanaProvider();
  if (!provider?.publicKey || typeof provider.signTransaction !== "function") {
    throw new Error("Connect a Solana wallet that can sign this Tournament claim.");
  }
  const connected = String(provider.publicKey.toString?.() || provider.publicKey);
  if (connected !== call.recipient) throw new Error("Connected Solana wallet does not own this Tournament reward.");

  const data = concat([await discriminator("claim_competition_winner_v2"), competition]);
  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: recipient, isSigner: true, isWritable: true },
      { pubkey: expectedPool, isSigner: false, isWritable: true },
    ],
    data,
  });
  const connection = new web3.Connection(getSolanaRewardRpcUrl(call.chainId), "confirmed");
  if (await poolClaimed(connection, PublicKey, call.poolAddress)) {
    throw new Error("This Tournament reward is already claimed on-chain. Refresh rewards before retrying.");
  }

  const intent = { payer: connected, instructions: [instruction] };
  const simulated = await compileSolanaUserV0WithLatestBlockhash(web3, connection, intent);
  await simulateSolanaUserV0OrThrow(connection, simulated.transaction, "Solana Tournament claim");
  const final = await compileSolanaUserV0WithLatestBlockhash(web3, connection, intent);
  const signed = await provider.signTransaction(final.transaction);
  assertSolanaUserV0Intent(web3, signed, intent);
  const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  const confirmation = await confirmLaunchpadSignature(connection, {
    signature,
    lastValidBlockHeight: final.latest.lastValidBlockHeight,
    recover: () => poolClaimed(connection, PublicKey, call.poolAddress),
  });
  if (confirmation.err) throw new Error(`Solana Tournament claim failed: ${JSON.stringify(confirmation.err)}`);
  return signature;
}
