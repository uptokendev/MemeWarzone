"use strict";

// Certification-only preload. It replaces only the first Keypair.generate() call
// made by the accepted chain-101 canary with the protected requested creator.
// No secret bytes are logged or persisted.
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

const creator = web3.Keypair.fromSecretKey(parseSecret(process.env.SOLANA_FIXTURE_CREATOR_SECRET_KEY));
const originalGenerate = web3.Keypair.generate.bind(web3.Keypair);
let injected = false;
web3.Keypair.generate = function ownerBoundGenerate() {
  if (!injected) {
    injected = true;
    return creator;
  }
  return originalGenerate();
};

process.on("exit", () => {
  if (!injected && process.exitCode !== 1) process.exitCode = 97;
});
