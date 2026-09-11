import { isSolanaRewardChainId } from "@/lib/solanaRewardNetwork";
import { submitSolanaRewardV0Claim } from "@/lib/solanaRewardV0Claim";
import { loadSolanaWeb3 } from "@/lib/solanaWeb3";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

function hexToBytes(value: string): Uint8Array {
  const hex = String(value || "").trim().replace(/^0x/i, "");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  const n = value >>> 0;
  out[0] = n & 0xff;
  out[1] = (n >>> 8) & 0xff;
  out[2] = (n >>> 16) & 0xff;
  out[3] = (n >>> 24) & 0xff;
  return out;
}

function u64le(value: string | number | bigint): Uint8Array {
  let n = BigInt(value);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function i64le(value: string | number | bigint): Uint8Array {
  let n = BigInt(value);
  if (n < 0n) n = (1n << 64n) + n;
  return u64le(n);
}

/** Anchor sha256("global:claim_league")[0..8] */
function claimLeagueDiscriminator(): Uint8Array {
  return new Uint8Array([0x88, 0xcc, 0x21, 0xf3, 0xeb, 0x4f, 0xcb, 0xa6]);
}

export async function submitSolanaLeagueClaim(prepared: {
  chainId?: number;
  programId: string;
  vaultAddress: string;
  configAddress: string;
  epochAddress: string;
  claimReceiptAddress: string;
  periodCode: number;
  epochStartSec: number;
  categoryHash: string;
  rank: number;
  amountRaw: string;
  proof: string[];
  recipient: string;
}): Promise<string> {
  const chainId = Number(prepared.chainId || 101);
  if (!isSolanaRewardChainId(chainId)) throw new Error("Wrong Solana reward chain for league claim.");

  const categoryHash = hexToBytes(prepared.categoryHash);
  if (categoryHash.length !== 32) throw new Error("Invalid category hash");
  const proof = (prepared.proof || []).map((item) => hexToBytes(item));
  if (proof.some((item) => item.length !== 32)) throw new Error("Invalid merkle proof");

  const parts = [
    claimLeagueDiscriminator(),
    Uint8Array.from([Number(prepared.periodCode) & 0xff]),
    i64le(prepared.epochStartSec),
    categoryHash,
    Uint8Array.from([Number(prepared.rank) & 0xff]),
    u64le(prepared.amountRaw),
    u32le(proof.length),
    ...proof,
  ];
  let total = 0;
  for (const part of parts) total += part.length;
  const data = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }

  const web3 = await loadSolanaWeb3();
  const { PublicKey, TransactionInstruction, SystemProgram } = web3;
  const ix = new TransactionInstruction({
    programId: new PublicKey(prepared.programId),
    keys: [
      { pubkey: new PublicKey(prepared.recipient), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(prepared.configAddress), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(prepared.vaultAddress), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(prepared.epochAddress), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(prepared.claimReceiptAddress), isSigner: false, isWritable: true },
      { pubkey: SystemProgram?.programId || new PublicKey(SYSTEM_PROGRAM), isSigner: false, isWritable: false },
    ],
    data,
  });

  return submitSolanaRewardV0Claim({
    web3,
    chainId,
    addresses: {
      programId: prepared.programId,
      configAddress: prepared.configAddress,
      vaultAddress: prepared.vaultAddress,
      batchAddress: prepared.epochAddress,
      claimReceiptAddress: prepared.claimReceiptAddress,
      recipient: prepared.recipient,
    },
    canonical: {
      kind: "league",
      periodCode: prepared.periodCode,
      epochStartSec: prepared.epochStartSec,
      categoryHash,
      rank: prepared.rank,
    },
    instruction: ix,
    label: "Solana league claim",
  });
}
