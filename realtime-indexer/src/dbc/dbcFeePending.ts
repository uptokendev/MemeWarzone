/**
 * Sign-then-persist pending claim/route rows. Resolve with getSignatureStatuses
 * before starting a new send so a dropped RPC read cannot pay twice.
 */
import type { Connection } from "@solana/web3.js";

export type SigResolution = "landed" | "failed" | "expired" | "pending";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function bs58Encode(bytes: Uint8Array): string {
  if (!bytes.length) return "";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  return "1".repeat(zeros) + digits.reverse().map((d) => ALPHABET[d]).join("");
}

export function idsParam(ids: Array<number | string | bigint>): string[] {
  return ids.map((id) => String(id));
}

export async function resolveSignature(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
): Promise<SigResolution> {
  const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  const status = value[0];
  if (status?.err) return "failed";
  const confirmation = String(status?.confirmationStatus || "");
  if (status && (confirmation === "confirmed" || confirmation === "finalized")) return "landed";
  // lastValidBlockHeight is a block height, not a slot: skipped slots put the slot number far
  // ahead (~20M on mainnet), so comparing a slot would call every unseen transaction expired.
  const height = await connection.getBlockHeight("confirmed");
  if (!status && height > lastValidBlockHeight) return "expired";
  return "pending";
}
