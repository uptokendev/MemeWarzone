#!/usr/bin/env node
/**
 * Deploy-time initialize for mwz_rewards_treasury.
 * Creates config + league_vault + airdrop_vault PDAs.
 * Authority is the protocol deployer. SOL never sits in that key.
 */
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

const PROGRAM_ID = new PublicKey(requiredEnv("SOLANA_REWARDS_TREASURY_PROGRAM_ID"));
const RPC = requiredEnv("SOLANA_RPC");
const INIT_DISC = Buffer.from([0xaf, 0xaf, 0x6d, 0x1f, 0x0d, 0x98, 0x9b, 0xed]);

function loadKeypair() {
  const file = requiredEnv("SOLANA_PROTOCOL_AUTHORITY_KEYPAIR");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const payer = loadKeypair();
  const connection = new Connection(RPC, "confirmed");
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("rewards_config")], PROGRAM_ID);
  const [leagueVault] = PublicKey.findProgramAddressSync([Buffer.from("league_vault")], PROGRAM_ID);
  const [airdropVault] = PublicKey.findProgramAddressSync([Buffer.from("airdrop_vault")], PROGRAM_ID);

  console.log("authority", payer.publicKey.toBase58());
  console.log("program  ", PROGRAM_ID.toBase58());
  console.log("config   ", config.toBase58());
  console.log("league   ", leagueVault.toBase58());
  console.log("airdrop  ", airdropVault.toBase58());
  console.log("note: pots are program PDAs. Do not leave treasury SOL on the deployer key.");

  const existing = await connection.getAccountInfo(config);
  if (existing) {
    console.log("already initialized");
    return;
  }

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: leagueVault, isSigner: false, isWritable: true },
      { pubkey: airdropVault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: INIT_DISC,
  });

  const sig = await sendServerV0(connection, payer, [ix], "Rewards treasury initialization");
  console.log("initialize signature", sig);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});