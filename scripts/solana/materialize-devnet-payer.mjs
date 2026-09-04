#!/usr/bin/env node
/**
 * Write the dedicated Solana devnet graduation operator keypair from a GitHub
 * Actions secret. This is intentionally separate from the production
 * FeeEscrow worker payer.
 *
 * Accepts a JSON byte array, base58, or 64-byte hex. Never prints the secret.
 */
import fs from "node:fs";
import path from "node:path";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function fail(message) {
  throw new Error(`[devnet-payer] ${message}`);
}

function decodeBase58(value) {
  let num = 0n;
  for (const char of value) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) fail("payer secret is not valid base58");
    num = num * 58n + BigInt(index);
  }
  const hex = num.toString(16).padStart(128, "0");
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  const leadingZeros = [...value].filter((char) => char === "1").length;
  return [...new Array(leadingZeros).fill(0), ...bytes.slice(-64)];
}

function parseSecret(raw) {
  const value = String(raw || "").trim();
  if (!value) fail("SOLANA_DEVNET_PAYER is empty");
  if (value.startsWith("[")) {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length < 64) fail("JSON keypair must contain at least 64 bytes");
    return parsed.slice(0, 64).map((item) => Number(item));
  }
  const hex = value.replace(/^0x/i, "");
  if (/^[0-9a-fA-F]+$/.test(hex) && hex.length === 128) {
    const bytes = [];
    for (let i = 0; i < hex.length; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
    return bytes;
  }
  if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return decodeBase58(value);
  fail("payer secret must be a JSON byte array, 64-byte hex, or base58 secret key");
}

function main() {
  const raw = process.env.SOLANA_DEVNET_PAYER || "";
  const dest =
    process.env.SOLANA_GRADUATION_OPERATOR_KEYPAIR ||
    path.join(process.env.RUNNER_TEMP || "/tmp", "mwz-solana-devnet-payer.json");
  const bytes = parseSecret(raw);
  if (bytes.some((item) => !Number.isInteger(item) || item < 0 || item > 255) || bytes.length !== 64) {
    fail("payer secret did not decode to a 64-byte keypair");
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(bytes), { mode: 0o600 });
  console.log("payer_keypair_path", dest);
  console.log("payer_keypair_bytes", bytes.length);
}

try {
  main();
} catch (error) {
  console.error(error?.message || error);
  process.exitCode = 1;
}
