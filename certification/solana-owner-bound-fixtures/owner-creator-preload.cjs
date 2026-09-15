"use strict";

// Certification-only preload. Resolve @solana/web3.js from the exact
// tests/solana dependency tree instead of relying on this file's location or
// NODE_PATH. Replace only the first Keypair.generate() call originating from
// tests/solana/network-canary-101.cjs. No secret bytes are logged or persisted.
const path = require("node:path");
const { createRequire } = require("node:module");

const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
const testsPackageJson = path.join(workspace, "tests", "solana", "package.json");
const requireFromSolanaTests = createRequire(testsPackageJson);
const web3 = requireFromSolanaTests("@solana/web3.js");

function parseSecret(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("SOLANA_FIXTURE_CREATOR_SECRET_KEY is required");
  const bytes = text.startsWith("[")
    ? Uint8Array.from(JSON.parse(text))
    : Uint8Array.from(Buffer.from(text, "base64"));
  if (bytes.length !== 64) throw new Error("fixture creator secret must decode to 64 bytes");
  return bytes;
}

function creatorKeypair() {
  return web3.Keypair.fromSecretKey(
    parseSecret(process.env.SOLANA_FIXTURE_CREATOR_SECRET_KEY),
  );
}

const expectedPublicKey = String(
  process.env.SOLANA_FIXTURE_PRELOAD_EXPECTED_PUBLIC_KEY || "",
).trim();
if (expectedPublicKey) {
  const actualPublicKey = creatorKeypair().publicKey.toBase58();
  if (actualPublicKey !== expectedPublicKey) {
    throw new Error("fixture creator public key does not match runtime precheck expectation");
  }
}

const originalGenerate = web3.Keypair.generate.bind(web3.Keypair);
let injected = false;
web3.Keypair.generate = function ownerBoundGenerate() {
  const stack = String(new Error().stack || "");
  if (!injected && stack.includes("tests/solana/network-canary-101.cjs")) {
    injected = true;
    return creatorKeypair();
  }
  return originalGenerate();
};
