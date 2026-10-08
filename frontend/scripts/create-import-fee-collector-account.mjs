#!/usr/bin/env node
/**
 * Creates the import fee collector's wrapped-SOL account on Solana mainnet (runbook
 * docs/release/IMPORT_CREATOR_FEES_GO_LIVE.md, step 2). The collector pays the ~0.002 SOL rent itself,
 * so fund it first (send ~0.05 SOL to its address from any wallet).
 *
 *   node scripts/create-import-fee-collector-account.mjs            # read-only: shows what it would do
 *   node scripts/create-import-fee-collector-account.mjs --send     # creates the account (idempotent)
 *
 * Key: IMPORT_FEE_COLLECTOR_KEYFILE or ~/.config/memewarzone/mwz-sol-import-fee-collector.json.
 * RPC: SOLANA_RPC_URL or the public mainnet endpoint.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";

const send = process.argv.includes("--send");
const keyfile = process.env.IMPORT_FEE_COLLECTOR_KEYFILE || path.join(os.homedir(), ".config/memewarzone/mwz-sol-import-fee-collector.json");
const rpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
if (/devnet|testnet/i.test(rpc)) throw new Error(`SOLANA_RPC_URL points at a test cluster (${rpc}); this is for mainnet.`);

const collector = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyfile, "utf8"))));
const account = getAssociatedTokenAddressSync(NATIVE_MINT, collector.publicKey);
const connection = new Connection(rpc, "confirmed");
const [lamports, existing] = await Promise.all([connection.getBalance(collector.publicKey), connection.getAccountInfo(account)]);

console.log(`collector       ${collector.publicKey.toBase58()}`);
console.log(`balance         ${lamports / LAMPORTS_PER_SOL} SOL`);
console.log(`wrapped SOL     ${account.toBase58()} ${existing ? "(exists)" : "(missing)"}`);

if (existing) {
  console.log("Nothing to do: the account exists. The API can switch to the collector.");
  process.exit(0);
}
if (lamports < 0.005 * LAMPORTS_PER_SOL) {
  console.log(`Fund the collector first: send about 0.05 SOL to ${collector.publicKey.toBase58()}.`);
  process.exit(1);
}
if (!send) {
  console.log("Read-only run. Add --send to create the wrapped-SOL account (about 0.002 SOL rent, paid by the collector).");
  process.exit(0);
}
const tx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(collector.publicKey, account, collector.publicKey, NATIVE_MINT));
const signature = await sendAndConfirmTransaction(connection, tx, [collector], { commitment: "confirmed" });
console.log(`created         ${account.toBase58()}  tx ${signature}`);
