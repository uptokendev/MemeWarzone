#!/usr/bin/env node
/**
 * Create the wrapped-SOL token account that receives the 0.5% platform fee on imported-coin swaps.
 *
 * frontend/api/importSwap.js pays the Jupiter platform fee into the wSOL associated token account of
 * SOLANA_IMPORT_SWAP_FEE_OWNER (default: the capped operator wallet 2AMfRaxS..., route_state.operator).
 * That account did not exist on mainnet (2026-10-03), so every Solana import swap build answered 503
 * IMPORT_SWAP_FEE_ACCOUNT_MISSING. Creating it is permissionless (idempotent ATA create, ~0.00204 SOL
 * rent paid by the payer); the owner stays 2AMfRaxS, the payer gains no rights over it.
 *
 *   node scripts/solana/create-import-swap-fee-account.mjs                      # reads, plans
 *   node scripts/solana/create-import-swap-fee-account.mjs --send               # sends
 * Env: SOLANA_RPC_URL (mainnet), PAYER_KEYPAIR (path or JSON array; default the mainnet deployer key),
 *      SOLANA_IMPORT_SWAP_FEE_OWNER (default 2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../tests/solana/package.json", import.meta.url));
const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } = require("@solana/web3.js");
const { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } = require("@solana/spl-token");

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const send = process.argv.includes("--send");
const owner = new PublicKey(String(process.env.SOLANA_IMPORT_SWAP_FEE_OWNER || "2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB").trim());
const rpc = String(process.env.SOLANA_RPC_URL || "").trim();
if (!rpc) throw new Error("SOLANA_RPC_URL is required");
const connection = new Connection(rpc, "confirmed");
if ((await connection.getGenesisHash()) !== MAINNET_GENESIS) throw new Error("RPC is not Solana mainnet-beta");

const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID);
const existing = await connection.getAccountInfo(ata, "confirmed");
console.log({ owner: owner.toBase58(), feeAccount: ata.toBase58(), exists: Boolean(existing) });
if (existing) {
  console.log("Fee account already exists; nothing to do.");
  process.exit(0);
}
const keyInput = String(process.env.PAYER_KEYPAIR || path.join(os.homedir(), ".config/memewarzone/solana-mainnet-deployer.json")).trim();
const raw = keyInput.startsWith("[") ? JSON.parse(keyInput) : JSON.parse(fs.readFileSync(keyInput, "utf8"));
const payer = Keypair.fromSecretKey(Uint8Array.from(raw));
const rent = await connection.getMinimumBalanceForRentExemption(165);
console.log({ payer: payer.publicKey.toBase58(), payerSol: (await connection.getBalance(payer.publicKey)) / 1e9, rentSol: rent / 1e9 });
const tx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, owner, NATIVE_MINT, TOKEN_PROGRAM_ID));
if (!send) {
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const sim = await connection.simulateTransaction(tx, [payer]);
  console.log("dry run: simulation", sim.value.err ? `FAILED ${JSON.stringify(sim.value.err)}` : "ok", "-- add --send to create it");
  process.exit(sim.value.err ? 1 : 0);
}
const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
const after = await connection.getAccountInfo(ata, "confirmed");
console.log({ signature: sig, created: Boolean(after), tokenProgramOwner: after?.owner?.toBase58() });
