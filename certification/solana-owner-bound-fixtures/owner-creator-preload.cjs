"use strict";

// Certification-only preload. Replace only the first Keypair.generate() call
// originating from tests/solana/network-canary-101.cjs. Other Node processes
// and other generate() calls remain untouched. No secret bytes are logged.
const web3 = require("@solana/web3.js");

function parseSecret(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("SOLANA_FIXTURE_CREATOR_SECRET_KEY is required");
  const bytes = text.startsWith("[")
    ? Uint8Array.from(JSON.parse(text))
    : Uint8Array.from(Buffer.from(text, "base64"));
  if (bytes.length !== 64) throw new Error("fixture creator secret must decode to 64 bytes");
  return bytes;
}

const originalGenerate = web3.Keypair.generate.bind(web3.Keypair);
let injected = false;
web3.Keypair.generate = function ownerBoundGenerate() {
  const stack = String(new Error().stack || "");
  if (!injected && stack.includes("tests/solana/network-canary-101.cjs")) {
    injected = true;
    return web3.Keypair.fromSecretKey(parseSecret(process.env.SOLANA_FIXTURE_CREATOR_SECRET_KEY));
  }
  return originalGenerate();
};
