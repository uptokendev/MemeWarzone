import crypto from "node:crypto";
import { Connection } from "@solana/web3.js";

const originalSendRawTransaction = Connection.prototype.sendRawTransaction;
const successfulPackets = new Map();

Connection.prototype.sendRawTransaction = async function patchedSendRawTransaction(rawTransaction, options) {
  const raw = Buffer.from(rawTransaction);
  const packetKey = crypto.createHash("sha256").update(raw).digest("hex");
  try {
    const signature = await originalSendRawTransaction.call(this, rawTransaction, options);
    const priorSignature = successfulPackets.get(packetKey);
    if (priorSignature && priorSignature !== signature) {
      throw new Error(`identical packet returned a different signature: ${signature} != ${priorSignature}`);
    }
    successfulPackets.set(packetKey, signature);
    return signature;
  } catch (error) {
    const priorSignature = successfulPackets.get(packetKey);
    if (priorSignature && /already been processed/i.test(String(error?.message || error))) {
      return priorSignature;
    }
    throw error;
  }
};

await import("./certify-postgrad-101.mjs");
