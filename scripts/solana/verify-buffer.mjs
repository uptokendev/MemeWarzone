#!/usr/bin/env node
/**
 * Prove an on-chain program buffer is byte-identical to a local .so.
 *
 * `solana program write-buffer` reports success when its last transaction
 * confirms, which is not the same as the buffer holding what you meant to
 * upload: a dropped write in the middle leaves a buffer that is the right
 * length and the wrong bytes, and the next thing that reads it is the loader,
 * during an upgrade nobody can take back.
 *
 * A buffer account is a 37-byte header -- 4-byte enum (1 = Buffer), a 1-byte
 * Option tag, and the 32-byte authority -- followed by the program itself.
 * Everything after byte 37 must hash to the same digest as the file.
 *
 * Usage:
 *   node scripts/solana/verify-buffer.mjs <bufferAddress> [path/to/program.so]
 *   SOLANA_RPC_URL must be set.
 */
import crypto from "node:crypto";
import fs from "node:fs";

const BUFFER_HEADER_BYTES = 37;

const address = String(process.argv[2] || "").trim();
const soPath = String(process.argv[3] || "target/deploy/memewarzone_solana.so");
const rpcUrl = String(process.env.SOLANA_RPC_URL || "").trim();

if (!address) {
  console.error("usage: verify-buffer.mjs <bufferAddress> [program.so]");
  process.exit(1);
}
if (!rpcUrl) {
  console.error("SOLANA_RPC_URL is required");
  process.exit(1);
}

async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload?.error) throw new Error(payload.error.message || "RPC error");
  return payload?.result;
}

const local = fs.readFileSync(soPath);
const localHash = crypto.createHash("sha256").update(local).digest("hex");

const account = await rpc("getAccountInfo", [address, { encoding: "base64" }]);
if (!account?.value) throw new Error(`buffer ${address} does not exist`);

const raw = Buffer.from(account.value.data[0], "base64");
const state = raw.readUInt32LE(0);
if (state !== 1) throw new Error(`account is not a program buffer (state=${state})`);
const hasAuthority = raw[4] === 1;
const bs58 = (await import("bs58")).default;

const onChain = raw.subarray(BUFFER_HEADER_BYTES, BUFFER_HEADER_BYTES + local.length);
const onChainHash = crypto.createHash("sha256").update(onChain).digest("hex");
const trailing = raw.subarray(BUFFER_HEADER_BYTES + local.length);

console.log(`buffer      : ${address}`);
console.log(`authority   : ${hasAuthority ? bs58.encode(raw.subarray(5, 37)) : "NONE"}`);
console.log(`account     : ${raw.length} bytes (${BUFFER_HEADER_BYTES} header + ${raw.length - BUFFER_HEADER_BYTES} payload)`);
console.log(`local file  : ${soPath} (${local.length} bytes)`);
console.log(`local  sha  : ${localHash}`);
console.log(`onchain sha : ${onChainHash}`);

if (trailing.length && trailing.some((byte) => byte !== 0)) {
  console.log(`\nFAIL: ${trailing.length} non-zero bytes past the end of the program`);
  process.exit(1);
}
if (onChainHash !== localHash) {
  console.log("\nFAIL: the buffer does not contain this program. Do not upgrade.");
  process.exit(1);
}
console.log("\nMATCH: the buffer is byte-identical to the local artifact.");
