import { isSolanaRewardChainId } from "@/lib/solanaRewardNetwork";
import { submitSolanaRewardV0Claim } from "@/lib/solanaRewardV0Claim";
import { loadSolanaWeb3 } from "@/lib/solanaWeb3";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

export type SolanaRewardLaneClaim = {
  lane: "recruiter" | "squad";
  chainId: number;
  epochId: string;
  amount: string;
  proof: string[];
  programId: string;
  configAddress: string;
  vaultAddress: string;
  batchAddress: string;
  claimReceiptAddress: string;
  recipient: string;
  instruction: "claim_recruiter" | "claim_squad";
};

function hexBytes(value: string): Uint8Array {
  const hex = String(value || "").trim().replace(/^0x/i, "");
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("Invalid reward Merkle proof node");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  const n = value >>> 0;
  out[0] = n & 0xff; out[1] = (n >>> 8) & 0xff; out[2] = (n >>> 16) & 0xff; out[3] = (n >>> 24) & 0xff;
  return out;
}
function u64le(value: string | number | bigint): Uint8Array {
  let n = BigInt(value);
  if (n < 0n || n > (1n << 64n) - 1n) throw new Error("u64 overflow");
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i += 1) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}
function i64le(value: string | number | bigint): Uint8Array {
  let n = BigInt(value);
  if (n < -(1n << 63n) || n > (1n << 63n) - 1n) throw new Error("i64 overflow");
  if (n < 0n) n = (1n << 64n) + n;
  return u64le(n);
}
async function discriminator(name: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${name}`));
  return new Uint8Array(digest).slice(0, 8);
}
function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

export async function submitSolanaRewardLaneClaim(call: SolanaRewardLaneClaim): Promise<string> {
  if (!isSolanaRewardChainId(call.chainId)) throw new Error("Wrong Solana chain for reward claim");
  const expectedInstruction = call.lane === "recruiter" ? "claim_recruiter" : "claim_squad";
  if (call.instruction !== expectedInstruction) {
    throw new Error(`Solana ${call.lane} claim instruction mismatch`);
  }

  const proof = (call.proof || []).map(hexBytes);
  const data = concat([
    await discriminator(call.instruction),
    i64le(call.epochId),
    u64le(call.amount),
    u32le(proof.length),
    ...proof,
  ]);

  const web3 = await loadSolanaWeb3();
  const { PublicKey, TransactionInstruction, SystemProgram } = web3;
  const ix = new TransactionInstruction({
    programId: new PublicKey(call.programId),
    keys: [
      { pubkey: new PublicKey(call.recipient), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(call.configAddress), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(call.vaultAddress), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(call.batchAddress), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(call.claimReceiptAddress), isSigner: false, isWritable: true },
      { pubkey: SystemProgram?.programId || new PublicKey(SYSTEM_PROGRAM), isSigner: false, isWritable: false },
    ],
    data,
  });

  return submitSolanaRewardV0Claim({
    web3,
    chainId: call.chainId,
    addresses: {
      programId: call.programId,
      configAddress: call.configAddress,
      vaultAddress: call.vaultAddress,
      batchAddress: call.batchAddress,
      claimReceiptAddress: call.claimReceiptAddress,
      recipient: call.recipient,
    },
    canonical: {
      kind: call.lane,
      epochId: call.epochId,
    },
    instruction: ix,
    label: `Solana ${call.lane} claim`,
  });
}
