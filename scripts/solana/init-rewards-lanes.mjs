#!/usr/bin/env node
/**
 * Creates monthly/recruiter/squad/protocol vaults + route_state.
 * Operator fill cap is $10,000 USD. Test operator may be a normal wallet.
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
const DEFAULT_OPERATOR = requiredEnv("SOLANA_PROTOCOL_OPERATOR");
const SOL_USD_MICROS = BigInt(requiredEnv("SOL_USD_MICROS"));

function loadKeypair() {
  const file = requiredEnv("SOLANA_PROTOCOL_AUTHORITY_KEYPAIR");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

function u64le(value) {
  let n = BigInt(value);
  const out = Buffer.alloc(8);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

async function main() {
  const crypto = await import("node:crypto");
  const disc = crypto.createHash("sha256").update("global:initialize_lanes_v2_primary").digest().subarray(0, 8);
  const payer = loadKeypair();
  const connection = new Connection(RPC, "confirmed");
  const operator = new PublicKey(DEFAULT_OPERATOR);
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("rewards_config")], PROGRAM_ID);
  const [routeState] = PublicKey.findProgramAddressSync([Buffer.from("route_state")], PROGRAM_ID);
  const [monthly] = PublicKey.findProgramAddressSync([Buffer.from("monthly_league_vault")], PROGRAM_ID);
  const [recruiter] = PublicKey.findProgramAddressSync([Buffer.from("recruiter_vault")], PROGRAM_ID);
  const [squad] = PublicKey.findProgramAddressSync([Buffer.from("squad_vault")], PROGRAM_ID);
  const [protocol] = PublicKey.findProgramAddressSync([Buffer.from("protocol_vault")], PROGRAM_ID);

  console.log({
    authority: payer.publicKey.toBase58(),
    operator: operator.toBase58(),
    routeState: routeState.toBase58(),
    monthly: monthly.toBase58(),
    recruiter: recruiter.toBase58(),
    squad: squad.toBase58(),
    protocol: protocol.toBase58(),
  });

  const routeInfo = await connection.getAccountInfo(routeState);
  const recruiterInfo = await connection.getAccountInfo(recruiter);
  const squadInfo = await connection.getAccountInfo(squad);
  if (routeInfo && recruiterInfo && squadInfo) {
    console.log("lanes already initialized");
    return;
  }

  if (!routeInfo) {
    const data = Buffer.concat([disc, operator.toBuffer(), u64le(SOL_USD_MICROS)]);
    const primary = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: routeState, isSigner: false, isWritable: true },
        { pubkey: monthly, isSigner: false, isWritable: true },
        { pubkey: protocol, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    const sig = await sendServerV0(connection, payer, [primary], "Rewards lane primary initialization");
    console.log("initialize_lanes_v2_primary", sig);
  }

  if (!recruiterInfo || !squadInfo) {
    const secondaryDisc = crypto.createHash("sha256").update("global:initialize_lanes_v2_secondary").digest().subarray(0, 8);
    const secondary = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: routeState, isSigner: false, isWritable: false },
        { pubkey: recruiter, isSigner: false, isWritable: true },
        { pubkey: squad, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: secondaryDisc,
    });
    const sig = await sendServerV0(connection, payer, [secondary], "Rewards lane secondary initialization");
    console.log("initialize_lanes_v2_secondary", sig);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});