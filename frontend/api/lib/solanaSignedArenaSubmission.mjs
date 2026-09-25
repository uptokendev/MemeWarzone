/**
 * Proves an arena payment submission comes from the paying wallet without an extra signed message.
 *
 * Before broadcast the browser registers {quoteId, signature} so a dropped transaction can be
 * recovered. That registration binds a quote to one signature, so it must come from the wallet
 * that owns the quote -- otherwise anyone who reads a quote id from the public state route could
 * bind a bogus signature and strand the payer. It used to require a second wallet-signed message.
 *
 * The signed transaction itself is stronger proof: its first signature is the payer's ed25519
 * signature over the exact message, and that message must carry this quote's instruction (program
 * and data, which include the funding id and the lamports). Only the wallet can produce it, and it
 * binds the precise payment rather than an action label. Wallet-added instructions (ComputeBudget,
 * Lighthouse) are allowed around ours, as in the browser's own post-sign check.
 */
import crypto from "node:crypto";
import { VersionedTransaction } from "@solana/web3.js";
import { decodeBase58, encodeBase58 } from "../dev-fix/solana-v4-primitives.js";

// DER prefix for a raw 32-byte ed25519 public key (SubjectPublicKeyInfo, OID 1.3.101.112).
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAX_TRANSACTION_BYTES = 1232;

function ed25519Verify(message, signature, publicKeyBytes) {
  const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyBytes)]), format: "der", type: "spki" });
  return crypto.verify(null, Buffer.from(message), key, Buffer.from(signature));
}

/**
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifySignedArenaSubmission({ transactionBase64, signature, blockhash, wallet, programId, dataBase64 }) {
  let raw;
  try {
    raw = Buffer.from(String(transactionBase64 || ""), "base64");
  } catch {
    return { ok: false, reason: "transaction_not_base64" };
  }
  if (!raw.length || raw.length > MAX_TRANSACTION_BYTES) return { ok: false, reason: "transaction_size_invalid" };

  let tx;
  try {
    tx = VersionedTransaction.deserialize(raw);
  } catch {
    return { ok: false, reason: "transaction_not_decodable" };
  }
  const message = tx.message;
  const keys = message.staticAccountKeys || [];
  if (!keys.length || keys[0].toBase58() !== String(wallet || "")) return { ok: false, reason: "payer_mismatch" };
  if (Number(message.header?.numRequiredSignatures) !== 1) return { ok: false, reason: "signer_count_invalid" };
  if (String(message.recentBlockhash || "") !== String(blockhash || "")) return { ok: false, reason: "blockhash_mismatch" };

  const payerSignature = tx.signatures?.[0];
  if (!payerSignature || payerSignature.length !== 64) return { ok: false, reason: "signature_missing" };
  let claimed;
  try {
    claimed = decodeBase58(signature, "signature");
  } catch {
    return { ok: false, reason: "signature_not_base58" };
  }
  if (encodeBase58(payerSignature) !== String(signature) || !Buffer.from(payerSignature).equals(claimed)) {
    return { ok: false, reason: "signature_mismatch" };
  }
  let valid = false;
  try {
    valid = ed25519Verify(message.serialize(), payerSignature, keys[0].toBytes());
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "signature_invalid" };

  const expectedData = Buffer.from(String(dataBase64 || ""), "base64");
  const carriesInstruction = (message.compiledInstructions || []).some((ix) => {
    const program = keys[ix.programIdIndex];
    return Boolean(program) && program.toBase58() === String(programId || "") && Buffer.from(ix.data).equals(expectedData);
  });
  if (!carriesInstruction) return { ok: false, reason: "instruction_mismatch" };
  return { ok: true };
}
