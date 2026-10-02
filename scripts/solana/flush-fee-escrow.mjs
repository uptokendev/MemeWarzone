#!/usr/bin/env node
/**
 * Permissionless flush of one campaign FeeEscrow into canonical rewards vaults.
 * Payer covers tx fees only; destinations are derived.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { sendServerV0 } from "./send-server-v0.mjs";

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const PROGRAM_ID = new PublicKey(requiredEnv("SOLANA_LAUNCHPAD_PROGRAM_ID"));
const TREASURY = new PublicKey(
  process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX",
);
const RPC = requiredEnv("SOLANA_RPC");
const CAMPAIGN = new PublicKey(requiredEnv("SOLANA_FEE_ESCROW_CAMPAIGN"));
const FLUSH_DISC = createHash("sha256").update("global:flush_campaign_fees").digest().subarray(0, 8);

function loadKeypair() {
  const file = requiredEnv("SOLANA_FEE_ESCROW_PAYER_KEYPAIR");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function vault(seed) {
  return PublicKey.findProgramAddressSync([Buffer.from(seed)], TREASURY)[0];
}

async function main() {
  const payer = loadKeypair();
  const connection = new Connection(RPC, "confirmed");
  const [escrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee-escrow"), CAMPAIGN.toBuffer()],
    PROGRAM_ID,
  );
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: CAMPAIGN, isSigner: false, isWritable: false },
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: vault("league_vault"), isSigner: false, isWritable: true },
      { pubkey: vault("airdrop_vault"), isSigner: false, isWritable: true },
      { pubkey: vault("monthly_league_vault"), isSigner: false, isWritable: true },
      { pubkey: vault("recruiter_vault"), isSigner: false, isWritable: true },
      { pubkey: vault("squad_vault"), isSigner: false, isWritable: true },
      { pubkey: vault("protocol_vault"), isSigner: false, isWritable: true },
    ],
    data: FLUSH_DISC,
  });
  const sig = await sendServerV0(connection, payer, [ix], `FeeEscrow flush ${CAMPAIGN.toBase58()}`);
  console.log(`flushed ${CAMPAIGN.toBase58()} escrow=${escrow.toBase58()} sig=${sig}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});