import { keccak256 } from "ethers";
import { PublicKey } from "@solana/web3.js";

const LEAF_PREFIX = Buffer.from("MWZ_RECRUITER_LEAF");

function i64le(value: bigint | number | string): Buffer {
  let n = BigInt(value);
  if (n < 0n) n = (1n << 64n) + n;
  const out = Buffer.alloc(8);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function u64le(value: bigint | number | string): Buffer {
  let n = BigInt(value);
  const out = Buffer.alloc(8);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function hashPair(a: string, b: string): string {
  const aa = Buffer.from(String(a).replace(/^0x/, ""), "hex");
  const bb = Buffer.from(String(b).replace(/^0x/, ""), "hex");
  return keccak256(Buffer.concat(Buffer.compare(aa, bb) <= 0 ? [aa, bb] : [bb, aa]));
}

export function recruiterLaneLeaf(epochId: string | number, walletAddress: string, amountLamports: string): string {
  return keccak256(Buffer.concat([
    LEAF_PREFIX,
    i64le(epochId),
    new PublicKey(walletAddress).toBuffer(),
    u64le(amountLamports),
  ]));
}

export function buildRecruiterMerkle(epochId: string | number, recipients: Array<{ walletAddress: string; amountLamports: string }>) {
  const leaves = recipients.map((item) => recruiterLaneLeaf(epochId, item.walletAddress, item.amountLamports));
  const levels = [leaves];
  while (levels[levels.length - 1]!.length > 1) {
    const current = levels[levels.length - 1]!;
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) next.push(hashPair(current[i]!, current[i + 1] ?? current[i]!));
    levels.push(next);
  }
  const proofs = leaves.map((_leaf, leafIndex) => {
    const proof: string[] = [];
    let index = leafIndex;
    for (let level = 0; level < levels.length - 1; level += 1) {
      const pair = index ^ 1;
      proof.push(levels[level]![pair] ?? levels[level]![index]!);
      index = Math.floor(index / 2);
    }
    return proof;
  });
  return {
    leaves,
    proofs,
    root: levels[levels.length - 1]![0]!,
    totalLamports: recipients.reduce((sum, item) => sum + BigInt(item.amountLamports), 0n).toString(),
  };
}

export function i64leBytes(value: bigint | number | string): Buffer {
  return i64le(value);
}
