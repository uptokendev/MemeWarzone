#!/usr/bin/env node
/**
 * Creates a swap-widget partner's fee account on Solana mainnet: a wrapped-SOL token account owned by the
 * import fee collector (the same owner as the default fee account), so the partner's fees are ours to split
 * and the worker can pay them out. The collector pays the ~0.002 SOL rent.
 *
 *   node scripts/create-import-partner-fee-account.mjs --partner crypticpump --payout <partner wallet>          # read-only
 *   node scripts/create-import-partner-fee-account.mjs --partner crypticpump --payout <partner wallet> --send   # creates it
 *
 * Prints the SQL that registers the partner (run it in the Supabase SQL editor, production).
 * Key: IMPORT_FEE_COLLECTOR_KEYFILE or ~/.config/memewarzone/mwz-sol-import-fee-collector.json.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, createInitializeAccount3Instruction } from "@solana/spl-token";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? String(process.argv[i + 1] || "").trim() : "";
};
const partner = arg("partner").toLowerCase();
const payout = arg("payout");
const name = arg("name") || partner;
const send = process.argv.includes("--send");
if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(partner)) throw new Error("--partner <id> is required (lowercase letters, digits, dashes)");
try {
  if (new PublicKey(payout).toBase58() !== payout || !PublicKey.isOnCurve(new PublicKey(payout).toBytes())) throw new Error();
} catch {
  throw new Error("--payout <the partner's Solana wallet> is required");
}
const keyfile = process.env.IMPORT_FEE_COLLECTOR_KEYFILE || path.join(os.homedir(), ".config/memewarzone/mwz-sol-import-fee-collector.json");
const rpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
if (/devnet|testnet/i.test(rpc)) throw new Error(`SOLANA_RPC_URL points at a test cluster (${rpc}); this is for mainnet.`);

const collector = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyfile, "utf8"))));
const connection = new Connection(rpc, "confirmed");
const lamports = await connection.getBalance(collector.publicKey);
const rent = await connection.getMinimumBalanceForRentExemption(165);
console.log(`collector   ${collector.publicKey.toBase58()}  balance ${lamports / LAMPORTS_PER_SOL} SOL`);
console.log(`partner     ${partner} (${name}), payout wallet ${payout}`);
if (lamports < rent + 10_000) throw new Error(`The collector needs at least ${(rent + 10_000) / LAMPORTS_PER_SOL} SOL for the rent and fee.`);
if (!send) {
  console.log("Read-only run. Add --send to create the partner's wrapped-SOL fee account (about 0.002 SOL rent, paid by the collector).");
  process.exit(0);
}
const account = Keypair.generate(); // only signs its own creation; the collector owns it afterwards
const tx = new Transaction().add(
  SystemProgram.createAccount({ fromPubkey: collector.publicKey, newAccountPubkey: account.publicKey, lamports: rent, space: 165, programId: TOKEN_PROGRAM_ID }),
  createInitializeAccount3Instruction(account.publicKey, NATIVE_MINT, collector.publicKey, TOKEN_PROGRAM_ID),
);
const signature = await sendAndConfirmTransaction(connection, tx, [collector, account], { commitment: "confirmed" });
console.log(`created     ${account.publicKey.toBase58()}  tx ${signature}`);
console.log("\nRun in the Supabase SQL editor (production):\n");
console.log(`insert into public.import_fee_partners (id, chain_id, name, fee_account, payout_wallet, creator_bps, partner_bps)
values ('${partner}', 101, '${name.replace(/'/g, "''")}', '${account.publicKey.toBase58()}', '${payout}', 5000, 2500);`);
