"use strict";

/**
 * Rotate ONLY the Solana devnet GlobalConfig.route_signer.
 *
 * Safety properties:
 * - refuses non-devnet genesis;
 * - requires the current GlobalConfig admin signer;
 * - reads every current authority from chain;
 * - replaces only routeSigner;
 * - verifies all other authorities are unchanged after confirmation.
 *
 * Usage:
 *   export SOLANA_RPC_URL=https://api.devnet.solana.com
 *   export SOLANA_OPERATOR_KEYPAIR=$HOME/.config/memewarzone/solana-devnet/deployer.json
 *   export SOLANA_NEW_ROUTE_SIGNER_KEYPAIR=$HOME/.config/memewarzone/solana-devnet/route-signer.json
 *   npm --prefix tests/solana run devnet:rotate-route-signer
 */

const fs = require("node:fs");
const path = require("node:path");
const anchor = require("@coral-xyz/anchor");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");

const { AnchorProvider, Program, Wallet } = anchor;
const ROOT = path.resolve(__dirname, "../..");
const IDL_PATH = path.join(ROOT, "target/idl/memewarzone_solana.json");
const EXPECTED_PROGRAM_ID = "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt";
const EXPECTED_DEVNET_GENESIS = "GH7ome3EiwEr7tu9JuTh2dpYWBJK3z69Xm1ZE3MEE6JC";
const DEFAULT_RPC = "https://api.devnet.solana.com";

function fail(message) {
  throw new Error(`[devnet-route-signer-rotation] ${message}`);
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function loadKeypair(filePath, label) {
  if (!fs.existsSync(filePath)) fail(`${label} keypair not found: ${filePath}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${label} keypair is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) fail(`${label} keypair must be a Solana JSON byte array`);
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

function deriveGlobalConfig(programId) {
  return PublicKey.findProgramAddressSync([Buffer.from("global")], programId)[0];
}

function key(value) {
  return value instanceof PublicKey ? value : new PublicKey(value);
}

function authoritySnapshot(global) {
  return {
    admin: key(global.admin),
    pauser: key(global.pauser),
    tierAdmin: key(global.tierAdmin),
    riskAdmin: key(global.riskAdmin),
    routeSigner: key(global.routeSigner),
    rewardOperator: key(global.rewardOperator),
    treasuryOperator: key(global.treasuryOperator),
    generationOperator: key(global.generationOperator),
  };
}

function printAuthorities(label, authorities) {
  console.log(label);
  for (const [name, value] of Object.entries(authorities)) {
    console.log(`  ${name}: ${value.toBase58()}`);
  }
}

function assertSame(actual, expected, label) {
  if (!actual.equals(expected)) {
    fail(`${label} changed unexpectedly: ${actual.toBase58()} != ${expected.toBase58()}`);
  }
}

async function main() {
  const rpcUrl = String(process.env.SOLANA_RPC_URL || DEFAULT_RPC).trim();
  const operatorPath = requiredEnv("SOLANA_OPERATOR_KEYPAIR");
  const routeSignerPath = requiredEnv("SOLANA_NEW_ROUTE_SIGNER_KEYPAIR");
  if (!fs.existsSync(IDL_PATH)) fail(`IDL not found: ${IDL_PATH}. Build the current program IDL first.`);

  const operator = loadKeypair(operatorPath, "operator/admin");
  const newRouteSigner = loadKeypair(routeSignerPath, "new route signer");
  if (operator.publicKey.equals(newRouteSigner.publicKey)) {
    fail("new route signer must be distinct from the admin/operator key");
  }

  const connection = new Connection(rpcUrl, "confirmed");
  const genesis = await connection.getGenesisHash();
  if (genesis !== EXPECTED_DEVNET_GENESIS) {
    fail(`refusing rotation on non-devnet genesis ${genesis}`);
  }

  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  const provider = new AnchorProvider(connection, new Wallet(operator), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);
  const program = new Program(idl, provider);
  if (program.programId.toBase58() !== EXPECTED_PROGRAM_ID) {
    fail(`IDL program mismatch: ${program.programId.toBase58()} != ${EXPECTED_PROGRAM_ID}`);
  }

  const globalConfig = deriveGlobalConfig(program.programId);
  const beforeGlobal = await program.account.globalConfig.fetch(globalConfig);
  const before = authoritySnapshot(beforeGlobal);

  console.log(`RPC: ${rpcUrl}`);
  console.log(`Genesis: ${genesis}`);
  console.log(`Program: ${program.programId.toBase58()}`);
  console.log(`GlobalConfig: ${globalConfig.toBase58()}`);
  console.log(`Operator signer: ${operator.publicKey.toBase58()}`);
  console.log(`New route signer: ${newRouteSigner.publicKey.toBase58()}`);
  printAuthorities("Current authorities:", before);

  if (!before.admin.equals(operator.publicKey)) {
    fail(
      `operator is not GlobalConfig.admin. Current admin=${before.admin.toBase58()} operator=${operator.publicKey.toBase58()}`,
    );
  }
  if (before.routeSigner.equals(newRouteSigner.publicKey)) {
    console.log("Route signer is already set to the requested key; nothing to rotate.");
    return;
  }

  const next = {
    admin: before.admin,
    pauser: before.pauser,
    tierAdmin: before.tierAdmin,
    riskAdmin: before.riskAdmin,
    routeSigner: newRouteSigner.publicKey,
    rewardOperator: before.rewardOperator,
    treasuryOperator: before.treasuryOperator,
    generationOperator: before.generationOperator,
  };

  console.log("Submitting devnet-only route signer rotation...");
  const signature = await program.methods
    .updateGlobalAuthorities(next)
    .accountsStrict({ admin: operator.publicKey, globalConfig })
    .rpc({ commitment: "confirmed" });
  console.log(`Signature: ${signature}`);

  const afterGlobal = await program.account.globalConfig.fetch(globalConfig);
  const after = authoritySnapshot(afterGlobal);
  assertSame(after.admin, before.admin, "admin");
  assertSame(after.pauser, before.pauser, "pauser");
  assertSame(after.tierAdmin, before.tierAdmin, "tierAdmin");
  assertSame(after.riskAdmin, before.riskAdmin, "riskAdmin");
  assertSame(after.rewardOperator, before.rewardOperator, "rewardOperator");
  assertSame(after.treasuryOperator, before.treasuryOperator, "treasuryOperator");
  assertSame(after.generationOperator, before.generationOperator, "generationOperator");
  assertSame(after.routeSigner, newRouteSigner.publicKey, "routeSigner");

  printAuthorities("Verified authorities after rotation:", after);
  console.log("OK — devnet route signer rotated; all other GlobalConfig authorities are unchanged.");
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
