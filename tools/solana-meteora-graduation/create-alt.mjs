import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RPC = "https://api.devnet.solana.com";
const DEFAULT_OPERATOR = path.join(
  process.env.HOME || "",
  ".config/memewarzone/solana-devnet/deployer.json",
);
const PROGRAM_ID = new PublicKey("3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt");
const METEORA = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const ED25519 = new PublicKey("Ed25519SigVerify111111111111111111111111111");
const COMPUTE_BUDGET = new PublicKey("ComputeBudget111111111111111111111111111111");
const INSTRUCTIONS = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const GLOBAL = PublicKey.findProgramAddressSync([Buffer.from("global")], PROGRAM_ID)[0];

function loadKeypair(filePath) {
  const bytes = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

async function send(connection, payer, ixs) {
  const compile = async () => {
    const latest = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: ixs,
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([payer]);
    return { transaction, latest };
  };

  const simulated = await compile();
  const simulation = await connection.simulateTransaction(simulated.transaction, {
    commitment: "confirmed",
    sigVerify: true,
    replaceRecentBlockhash: false,
  });
  if (simulation.value.err) {
    const logs = simulation.value.logs?.slice(-12).join("\n") || "";
    throw new Error(`ALT update simulation failed: ${JSON.stringify(simulation.value.err)}${logs ? `\n${logs}` : ""}`);
  }

  const final = await compile();
  const sig = await connection.sendRawTransaction(final.transaction.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  const confirmation = await connection.confirmTransaction(
    { signature: sig, ...final.latest },
    "confirmed",
  );
  if (confirmation.value.err) throw new Error(JSON.stringify(confirmation.value.err));
  return sig;
}

async function main() {
  const rpc = process.env.SOLANA_RPC_URL || DEFAULT_RPC;
  const operator = loadKeypair(process.env.SOLANA_GRADUATION_OPERATOR_KEYPAIR || DEFAULT_OPERATOR);
  const connection = new Connection(rpc, "confirmed");
  const slot = await connection.getSlot("confirmed");
  const [createIx, lookupTable] = AddressLookupTableProgram.createLookupTable({
    authority: operator.publicKey,
    payer: operator.publicKey,
    recentSlot: slot - 1,
  });
  console.log("creating ALT", lookupTable.toBase58());
  await send(connection, operator, [createIx]);

  const extras = process.argv.slice(2).filter(Boolean).map((v) => new PublicKey(v));
  const addresses = [
    PROGRAM_ID,
    METEORA,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId,
    NATIVE_MINT,
    ED25519,
    COMPUTE_BUDGET,
    INSTRUCTIONS,
    GLOBAL,
    operator.publicKey,
    ...extras,
  ];
  for (let i = 0; i < addresses.length; i += 20) {
    const chunk = addresses.slice(i, i + 20);
    const ix = AddressLookupTableProgram.extendLookupTable({
      payer: operator.publicKey,
      authority: operator.publicKey,
      lookupTable,
      addresses: chunk,
    });
    console.log("extending ALT", i, "->", i + chunk.length);
    await send(connection, operator, [ix]);
  }
  console.log("SOLANA_GRADUATION_ALT_ADDRESS=" + lookupTable.toBase58());
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});