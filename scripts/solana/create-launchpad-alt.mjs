#!/usr/bin/env node
/**
 * Create a NEW launchpad Address Lookup Table and keep its authority.
 *
 * The original mainnet table (AoX2EzL4…) was created without an authority, so
 * it can never be extended. After the V5 upgrade CREATE needs four more
 * accounts than that table knows about, which pushed the transaction to 1139
 * bytes on-chain — 92% of the 1232-byte limit. Phantom cannot reliably
 * simulate a transaction that close to the ceiling and falls back to its
 * "this dApp could be malicious" warning.
 *
 * Note the budget this script targets is the UNSIGNED transaction, not the one
 * that lands on chain: Phantom appends its own ComputeBudget instructions
 * (~52 bytes) after we hand it the transaction. That is why the guard is 1000
 * rather than something closer to 1232.
 *
 * Every address here is global or shared across campaigns. Per-campaign PDAs
 * (campaign, mint, vaults, fee escrow, creator fee vault, token metadata) and
 * per-creator PDAs (creator profile, risk profile) cannot live in a static
 * table and stay in the static keys.
 *
 * Env:
 *   SOLANA_RPC_URL                 required
 *   SOLANA_ALT_AUTHORITY_KEYPAIR   required, path to the keypair that will own
 *                                  the table and pay for it (~0.002 SOL)
 *   SOLANA_LAUNCHPAD_PROGRAM_ID    optional, defaults to mainnet launchpad
 *   DRY_RUN=1                      print the plan and exit without writing
 */
import fs from "node:fs";
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

const LAUNCHPAD_PROGRAM_ID = String(
  process.env.SOLANA_LAUNCHPAD_PROGRAM_ID || "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt",
).trim();
const REWARDS_TREASURY_PROGRAM_ID = "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX";
const MPL_TOKEN_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

// Keep in sync with REWARD_VAULT_SEEDS in frontend/src/lib/solanaV0Transaction.ts.
const REWARD_VAULT_SEEDS = [
  ["weeklyLeagueVault", "league_vault"],
  ["airdropVault", "airdrop_vault"],
  ["monthlyLeagueVault", "monthly_league_vault"],
  ["recruiterVault", "recruiter_vault"],
  ["squadVault", "squad_vault"],
  ["protocolVault", "protocol_vault"],
];

// Offset of GlobalConfig.activeGenerationId, confirmed against mainnet by
// deriving the generation PDA that CREATE actually used.
const ACTIVE_GENERATION_ID_OFFSET = 264;

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loadKeypair(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}

async function buildPlan(connection) {
  const programId = new PublicKey(LAUNCHPAD_PROGRAM_ID);
  const rewardsProgramId = new PublicKey(REWARDS_TREASURY_PROGRAM_ID);
  const [globalConfig] = PublicKey.findProgramAddressSync([Buffer.from("global")], programId);

  const globalInfo = await connection.getAccountInfo(globalConfig);
  if (!globalInfo) throw new Error(`GlobalConfig not found at ${globalConfig.toBase58()}`);
  const activeGenerationId = globalInfo.data.subarray(
    ACTIVE_GENERATION_ID_OFFSET,
    ACTIVE_GENERATION_ID_OFFSET + 32,
  );
  const [generationConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("generation"), activeGenerationId],
    programId,
  );
  // Risk cluster 0 is the default every campaign lands in.
  const [clusterProfile] = PublicKey.findProgramAddressSync(
    [Buffer.from("cluster"), Buffer.alloc(32)],
    programId,
  );

  return [
    // Present in the old table.
    { label: "memewarzoneProgram", address: programId },
    { label: "globalConfig", address: globalConfig },
    { label: "ed25519Program", address: new PublicKey("Ed25519SigVerify111111111111111111111111111") },
    { label: "computeBudgetProgram", address: new PublicKey("ComputeBudget111111111111111111111111111111") },
    { label: "instructionsSysvar", address: new PublicKey("Sysvar1nstructions1111111111111111111111111") },
    { label: "tokenProgram", address: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") },
    { label: "associatedTokenProgram", address: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL") },
    { label: "systemProgram", address: new PublicKey("11111111111111111111111111111111") },
    { label: "rewardsTreasuryProgram", address: rewardsProgramId },
    ...REWARD_VAULT_SEEDS.map(([label, seed]) => ({
      label,
      address: PublicKey.findProgramAddressSync([Buffer.from(seed)], rewardsProgramId)[0],
    })),
    // New: the three static keys CREATE gained in the V5 upgrade. 31 bytes each.
    { label: "tokenMetadataProgram", address: new PublicKey(MPL_TOKEN_METADATA_PROGRAM_ID) },
    { label: "generationConfig", address: generationConfig },
    { label: "clusterProfile", address: clusterProfile },
  ];
}

async function main() {
  const connection = new Connection(requiredEnv("SOLANA_RPC_URL"), "confirmed");
  const plan = await buildPlan(connection);

  const seen = new Set();
  for (const entry of plan) {
    const key = entry.address.toBase58();
    if (seen.has(key)) throw new Error(`duplicate ALT plan address: ${entry.label} ${key}`);
    seen.add(key);
  }

  console.log(`ALT plan (${plan.length} addresses):`);
  for (const [index, entry] of plan.entries()) {
    console.log(`  ${String(index).padStart(2)} ${entry.address.toBase58().padEnd(45)} ${entry.label}`);
  }

  if (String(process.env.DRY_RUN || "").trim() === "1") {
    console.log("\nDRY_RUN=1 — nothing written.");
    return;
  }

  const authority = loadKeypair(requiredEnv("SOLANA_ALT_AUTHORITY_KEYPAIR"));
  console.log(`\nauthority / payer : ${authority.publicKey.toBase58()}`);
  const balance = await connection.getBalance(authority.publicKey);
  console.log(`balance           : ${(balance / 1e9).toFixed(6)} SOL`);
  if (balance < 10_000_000) throw new Error("authority needs at least 0.01 SOL");

  const send = async (label, instructions) => {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
    const message = new TransactionMessage({
      payerKey: authority.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([authority]);
    const signature = await connection.sendTransaction(transaction, { skipPreflight: false });
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    console.log(`  ${label}: ${signature}`);
    return signature;
  };

  const slot = await connection.getSlot("finalized");
  const [createIx, tableAddress] = AddressLookupTableProgram.createLookupTable({
    authority: authority.publicKey,
    payer: authority.publicKey,
    recentSlot: slot,
  });
  console.log(`\ncreating table ${tableAddress.toBase58()}`);
  await send("create", [createIx]);

  // extendLookupTable is bounded by transaction size; 20 addresses per call is safe.
  for (let offset = 0; offset < plan.length; offset += 20) {
    const chunk = plan.slice(offset, offset + 20);
    await send(
      `extend[${offset}..${offset + chunk.length - 1}]`,
      [
        AddressLookupTableProgram.extendLookupTable({
          payer: authority.publicKey,
          authority: authority.publicKey,
          lookupTable: tableAddress,
          addresses: chunk.map((entry) => entry.address),
        }),
      ],
    );
  }

  // An RPC node can still serve a pre-extend view of the account for a moment
  // after the extend confirms, which reads back as an empty table. Poll until
  // the node catches up rather than reporting a failure that did not happen.
  let table = null;
  let missing = plan;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const verify = await connection.getAddressLookupTable(tableAddress, { commitment: "finalized" });
    table = verify.value;
    if (table) {
      const stored = new Set(table.state.addresses.map((address) => address.toBase58()));
      missing = plan.filter((entry) => !stored.has(entry.address.toBase58()));
      if (!missing.length) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!table) throw new Error("table not readable after creation");
  if (missing.length) {
    throw new Error(`table is missing ${missing.length} addresses: ${missing.map((m) => m.label).join(", ")}`);
  }

  console.log(`\nVERIFIED`);
  console.log(`  address   : ${tableAddress.toBase58()}`);
  console.log(`  addresses : ${table.state.addresses.length}`);
  console.log(`  authority : ${table.state.authority?.toBase58() || "NONE"}`);
  console.log(`\nSet in the frontend Coolify build env, then redeploy:`);
  console.log(`  VITE_SOLANA_LAUNCHPAD_ALT_ADDRESS=${tableAddress.toBase58()}`);
  console.log(`\nA new table cannot be used until the slot after it was extended.`);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
