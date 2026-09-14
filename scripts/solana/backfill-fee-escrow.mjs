#!/usr/bin/env node
/**
 * Initialize FeeEscrow PDAs for existing Solana campaigns.
 * Permissionless: payer only pays rent. Idempotent if already initialized.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { sendServerV0 } from "./send-server-v0.mjs";

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const PROGRAM_ID = new PublicKey(requiredEnv("SOLANA_LAUNCHPAD_PROGRAM_ID"));
const RPC = requiredEnv("SOLANA_RPC");
const INIT_DISC = createHash("sha256").update("global:initialize_fee_escrow").digest().subarray(0, 8);

function loadKeypair() {
  const file = requiredEnv("SOLANA_FEE_ESCROW_PAYER_KEYPAIR");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function campaignList() {
  const raw = String(process.env.SOLANA_FEE_ESCROW_CAMPAIGNS || "").trim();
  if (!raw) throw new Error("SOLANA_FEE_ESCROW_CAMPAIGNS is a comma-separated campaign PDA list");
  return raw.split(",").map((item) => new PublicKey(item.trim())).filter(Boolean);
}

async function main() {
  const payer = loadKeypair();
  const connection = new Connection(RPC, "confirmed");
  const campaigns = campaignList();
  for (const campaign of campaigns) {
    const [escrow] = PublicKey.findProgramAddressSync(
      [Buffer.from("fee-escrow"), campaign.toBuffer()],
      PROGRAM_ID,
    );
    const existing = await connection.getAccountInfo(escrow, "confirmed");
    if (existing && existing.owner.equals(PROGRAM_ID) && existing.data.length >= 8) {
      console.log(`already initialized ${campaign.toBase58()} -> ${escrow.toBase58()}`);
      continue;
    }
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: campaign, isSigner: false, isWritable: false },
        { pubkey: escrow, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: INIT_DISC,
    });
    const sig = await sendServerV0(connection, payer, [ix], `FeeEscrow initialize ${campaign.toBase58()}`);
    console.log(`initialized ${campaign.toBase58()} escrow=${escrow.toBase58()} sig=${sig}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});