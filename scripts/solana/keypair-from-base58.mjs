#!/usr/bin/env node
/**
 * Turn a wallet-exported base58 secret key into the JSON keypair array the
 * Solana tooling and the resolve-due worker expect -- without the secret
 * touching shell history or the terminal.
 *
 *   node scripts/solana/keypair-from-base58.mjs --expect <pubkey> --out <file>
 *
 * Prompts for the secret with echo off, refuses unless the derived public key
 * equals --expect, writes the file 0600, prints only the public key. Also
 * accepts a JSON array on the prompt (already the right format) and just
 * verifies + writes it.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../tests/solana/package.json", import.meta.url));
const { Keypair, PublicKey } = require("@solana/web3.js");
const bs58 = require("bs58");

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? String(args[i + 1] || "") : ""; };
const expect = opt("--expect"); const out = opt("--out");
if (!expect || !out) { console.error("usage: --expect <pubkey> --out <file>"); process.exit(2); }
new PublicKey(expect);

function promptHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin; process.stdout.write(question);
    if (!stdin.isTTY) { let s = ""; stdin.setEncoding("utf8"); stdin.on("data", (d) => (s += d)); stdin.on("end", () => resolve(s.trim())); return; }
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8"); let s = "";
    stdin.on("data", (ch) => {
      if (ch === "\r" || ch === "\n") { stdin.setRawMode(false); stdin.pause(); process.stdout.write("\n"); resolve(s.trim()); }
      else if (ch === "\u0003") { process.stdout.write("\n"); process.exit(130); }
      else if (ch === "\u007f") { s = s.slice(0, -1); }
      else { s += ch; }
    });
  });
}

const raw = await promptHidden(`secret key for ${expect} (base58 from the wallet, or a JSON array; input is hidden): `);
let secret;
if (raw.startsWith("[")) secret = Uint8Array.from(JSON.parse(raw));
else secret = Uint8Array.from(bs58.decode(raw));
if (secret.length !== 64) { console.error(`refusing: decoded ${secret.length} bytes, expected 64`); process.exit(1); }
const kp = Keypair.fromSecretKey(secret);
if (kp.publicKey.toBase58() !== expect) { console.error(`refusing: this secret belongs to ${kp.publicKey.toBase58()}, not ${expect}`); process.exit(1); }
fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
fs.writeFileSync(out, JSON.stringify(Array.from(secret)), { mode: 0o600 });
console.log(`ok: ${kp.publicKey.toBase58()} -> ${out} (0600). For Coolify, ARENA_RESOLVER_KEYPAIR is the file's content (the JSON array).`);
