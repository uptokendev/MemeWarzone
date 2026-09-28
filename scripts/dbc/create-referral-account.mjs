#!/usr/bin/env node
/**
 * Create the dedicated DBC referral WSOL token account (D2).
 * Dry run by default. --send creates it on the RPC cluster.
 *
 * The owner is a throwaway referral key that never claims. The SDK partner-fee
 * claim closes the claimer's WSOL account; this ATA must not be that account.
 *
 *   SOLANA_RPC_URL=... DBC_REFERRAL_OWNER_KEYPAIR=<json> node scripts/dbc/create-referral-account.mjs
 *   ... --send
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { SOLANA_GENESIS } from "../../frontend/src/lib/solanaArenaLayout.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { Connection, Keypair, PublicKey } = requireFromFrontend("@solana/web3.js");
const {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} = requireFromFrontend("@solana/spl-token");
const { Transaction, sendAndConfirmTransaction } = requireFromFrontend("@solana/web3.js");

const RPC = process.env.SOLANA_RPC_URL || process.env.SOLANA_DEVNET_RPC_URL || "https://api.devnet.solana.com";
const send = process.argv.includes("--send");

function loadKeypair(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const genesis = await conn.getGenesisHash();
  const cluster = genesis === SOLANA_GENESIS.devnet
    ? "devnet"
    : genesis === SOLANA_GENESIS["mainnet-beta"]
      ? "mainnet-beta"
      : "unknown";
  if (cluster === "unknown") throw new Error(`Refusing unknown genesis ${genesis}`);
  if (cluster === "mainnet-beta") {
    throw new Error("This script does not send on mainnet. Founder terminal only.");
  }

  const ownerPath = process.env.DBC_REFERRAL_OWNER_KEYPAIR;
  const payerPath = process.env.DBC_PROVE_FUNDER_KEYPAIR || ownerPath;
  if (!ownerPath) {
    console.log("Dry run: set DBC_REFERRAL_OWNER_KEYPAIR to a throwaway json keypair.");
    console.log("The owner must never call the DBC partner-fee claim.");
    process.exitCode = send ? 1 : 0;
    return;
  }
  const owner = loadKeypair(ownerPath);
  const payer = payerPath ? loadKeypair(payerPath) : owner;
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner.publicKey);
  const existing = await conn.getAccountInfo(ata, "confirmed");
  console.log(`cluster  ${cluster}`);
  console.log(`owner    ${owner.publicKey.toBase58()}`);
  console.log(`ata      ${ata.toBase58()}`);
  console.log(`exists   ${Boolean(existing)}`);
  if (existing) {
    const mint = new PublicKey(existing.data.slice(0, 32));
    console.log(`mint     ${mint.toBase58()} ${mint.equals(NATIVE_MINT) ? "(WSOL)" : "(NOT WSOL)"}`);
    console.log("Set DBC_REFERRAL_TOKEN_ACCOUNT and VITE_DBC_REFERRAL_TOKEN_ACCOUNT to the ata.");
    return;
  }
  if (!send) {
    console.log("Dry run. Pass --send to create the WSOL ATA.");
    return;
  }
  const ix = createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey,
    ata,
    owner.publicKey,
    NATIVE_MINT,
    TOKEN_PROGRAM_ID,
  );
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
  console.log(`created  ${sig}`);
  console.log("Set DBC_REFERRAL_TOKEN_ACCOUNT and VITE_DBC_REFERRAL_TOKEN_ACCOUNT to the ata.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
