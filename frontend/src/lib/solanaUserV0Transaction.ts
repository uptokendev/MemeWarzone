import type { Connection, PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import type { SolanaWeb3Module } from "@/lib/solanaWeb3";

export const SOLANA_USER_V0_PACKET_LIMIT_BYTES = 1_232;

export type SolanaUserV0BuildInput = {
  payer: string | PublicKey;
  recentBlockhash: string;
  instructions: TransactionInstruction[];
};

export type SolanaUserV0Intent = {
  payer: string | PublicKey;
  instructions: TransactionInstruction[];
  maxRequiredSigners?: number;
  hardMaxBytes?: number;
  /**
   * Wallets such as Phantom may append safety / priority instructions after signing.
   * When enabled, the exact expected instruction sequence must still exist contiguously
   * and unchanged, but additional wallet instructions may appear before or after it.
   */
  allowAdditionalInstructions?: boolean;
};

export type SolanaUserV0Stats = {
  serializedBytes: number;
  requiredSigners: number;
  instructionCount: number;
};

function keyString(value: string | { toBase58?: () => string; toString?: () => string }): string {
  if (typeof value === "string") return value;
  if (typeof value?.toBase58 === "function") return value.toBase58();
  return String(value?.toString?.() || "");
}

function dataEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function instructionEqual(a: TransactionInstruction, b: TransactionInstruction): boolean {
  if (keyString(a.programId) !== keyString(b.programId)) return false;
  if (!dataEqual(a.data, b.data)) return false;
  if (a.keys.length !== b.keys.length) return false;
  for (let i = 0; i < a.keys.length; i += 1) {
    const left = a.keys[i];
    const right = b.keys[i];
    if (keyString(left.pubkey) !== keyString(right.pubkey)) return false;
    if (left.isSigner !== right.isSigner || left.isWritable !== right.isWritable) return false;
  }
  return true;
}

function findContiguousInstructionSequence(
  actual: TransactionInstruction[],
  expected: TransactionInstruction[],
): number {
  if (expected.length === 0) return 0;
  if (actual.length < expected.length) return -1;
  for (let start = 0; start <= actual.length - expected.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < expected.length; offset += 1) {
      if (!instructionEqual(actual[start + offset], expected[offset])) {
        matches = false;
        break;
      }
    }
    if (matches) return start;
  }
  return -1;
}

export function buildSolanaUserV0Transaction(
  web3: SolanaWeb3Module,
  input: SolanaUserV0BuildInput,
): VersionedTransaction {
  const payerKey = typeof input.payer === "string" ? new web3.PublicKey(input.payer) : input.payer;
  const message = new web3.TransactionMessage({
    payerKey,
    recentBlockhash: input.recentBlockhash,
    instructions: input.instructions,
  }).compileToV0Message();
  return new web3.VersionedTransaction(message);
}

export function assertSolanaUserV0Intent(
  web3: SolanaWeb3Module,
  transaction: VersionedTransaction,
  expectation: SolanaUserV0Intent,
): SolanaUserV0Stats {
  const serializedBytes = transaction.serialize().length;
  const requiredSigners = transaction.message.header.numRequiredSignatures;
  const hardMaxBytes = expectation.hardMaxBytes ?? SOLANA_USER_V0_PACKET_LIMIT_BYTES;
  const maxRequiredSigners = expectation.maxRequiredSigners ?? 1;

  if (requiredSigners !== maxRequiredSigners) {
    throw new Error(`Solana V0 requires exactly ${maxRequiredSigners} signer(s); got ${requiredSigners}`);
  }
  if (serializedBytes > hardMaxBytes) {
    throw new Error(`Solana V0 transaction is ${serializedBytes} bytes; hard max is ${hardMaxBytes}`);
  }

  const payer = transaction.message.staticAccountKeys[0];
  if (!payer || payer.toBase58() !== keyString(expectation.payer)) {
    throw new Error("Solana V0 fee payer changed before signing/submission");
  }

  const decompiled = web3.TransactionMessage.decompile(transaction.message);
  if (!expectation.allowAdditionalInstructions) {
    if (decompiled.instructions.length !== expectation.instructions.length) {
      throw new Error("Solana V0 instruction count changed before signing/submission");
    }
    for (let i = 0; i < expectation.instructions.length; i += 1) {
      if (!instructionEqual(decompiled.instructions[i], expectation.instructions[i])) {
        throw new Error(`Solana V0 instruction ${i} changed before signing/submission`);
      }
    }
  } else if (findContiguousInstructionSequence(decompiled.instructions, expectation.instructions) < 0) {
    throw new Error("Solana V0 expected instruction sequence changed before signing/submission");
  }

  return {
    serializedBytes,
    requiredSigners,
    instructionCount: decompiled.instructions.length,
  };
}

export async function compileSolanaUserV0WithLatestBlockhash(
  web3: SolanaWeb3Module,
  connection: Pick<Connection, "getLatestBlockhash">,
  input: Omit<SolanaUserV0BuildInput, "recentBlockhash">,
  expectation: Omit<SolanaUserV0Intent, "payer" | "instructions"> = {},
) {
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = buildSolanaUserV0Transaction(web3, {
    ...input,
    recentBlockhash: latest.blockhash,
  });
  const stats = assertSolanaUserV0Intent(web3, transaction, {
    payer: input.payer,
    instructions: input.instructions,
    ...expectation,
  });
  return { transaction, stats, latest };
}

export async function simulateSolanaUserV0OrThrow(
  connection: Connection,
  transaction: VersionedTransaction,
  label: string,
): Promise<void> {
  const result = await connection.simulateTransaction(transaction, {
    commitment: "confirmed",
    sigVerify: false,
    replaceRecentBlockhash: false,
  });
  if (result.value.err) {
    const logs = result.value.logs?.slice(-10).join("\n") || "";
    throw new Error(`${label} simulation failed: ${JSON.stringify(result.value.err)}${logs ? `\n${logs}` : ""}`);
  }
}
