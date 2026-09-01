"use strict";

/**
 * Open/restore ONLY the Solana devnet graduation pause flag for real-network
 * Meteora acceptance. All other pause flags are preserved byte-for-byte.
 *
 * Safety:
 * - refuses non-devnet genesis;
 * - requires current admin or pauser authority;
 * - snapshots the complete pause state before opening;
 * - restore reapplies the exact snapshot;
 * - verifies chain state after every mutation.
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
const DEFAULT_SNAPSHOT = "/tmp/mwz-solana-devnet-pause-snapshot.json";

function fail(message) {
  throw new Error(`[devnet-graduation-window] ${message}`);
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function loadKeypair(filePath) {
  if (!fs.existsSync(filePath)) fail(`operator keypair not found: ${filePath}`);
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(parsed)) fail("operator keypair must be a Solana JSON byte array");
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

function globalPda(programId) {
  return PublicKey.findProgramAddressSync([Buffer.from("global")], programId)[0];
}

function pauseState(global) {
  return {
    paused: Boolean(global.paused),
    createPaused: Boolean(global.createPaused),
    buyPaused: Boolean(global.buyPaused),
    sellPaused: Boolean(global.sellPaused),
    graduationPaused: Boolean(global.graduationPaused),
    claimsPaused: Boolean(global.claimsPaused),
  };
}

function samePause(a, b) {
  return (
    a.paused === b.paused &&
    a.createPaused === b.createPaused &&
    a.buyPaused === b.buyPaused &&
    a.sellPaused === b.sellPaused &&
    a.graduationPaused === b.graduationPaused &&
    a.claimsPaused === b.claimsPaused
  );
}

async function setPause(program, globalConfig, operator, flags, label) {
  const before = pauseState(await program.account.globalConfig.fetch(globalConfig));
  if (samePause(before, flags)) {
    console.log(`${label}: already in requested state; no transaction sent.`);
    return null;
  }
  const signature = await program.methods
    .setPauseFlags(flags)
    .accountsStrict({ globalConfig, authority: operator.publicKey })
    .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });
  const after = pauseState(await program.account.globalConfig.fetch(globalConfig));
  if (!samePause(after, flags)) fail(`${label}: post-transaction pause state mismatch`);
  console.log(`${label}: ${signature}`);
  return signature;
}

async function main() {
  const mode = String(process.argv[2] || "").trim().toLowerCase();
  if (!new Set(["open", "restore"]).has(mode)) fail("usage: devnet-graduation-window.cjs <open|restore>");

  const operatorPath = requiredEnv("SOLANA_OPERATOR_KEYPAIR");
  const snapshotPath = String(process.env.SOLANA_GRADUATION_PAUSE_SNAPSHOT || DEFAULT_SNAPSHOT).trim();
  const rpcUrl = String(process.env.SOLANA_RPC_URL || DEFAULT_RPC).trim();
  if (!fs.existsSync(IDL_PATH)) fail(`IDL not found: ${IDL_PATH}`);

  const operator = loadKeypair(operatorPath);
  const connection = new Connection(rpcUrl, "confirmed");
  const genesis = await connection.getGenesisHash();
  if (genesis !== EXPECTED_DEVNET_GENESIS) fail(`refusing non-devnet genesis ${genesis}`);

  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  const provider = new AnchorProvider(connection, new Wallet(operator), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);
  const program = new Program(idl, provider);
  if (program.programId.toBase58() !== EXPECTED_PROGRAM_ID) {
    fail(`program mismatch ${program.programId.toBase58()} != ${EXPECTED_PROGRAM_ID}`);
  }

  const globalConfig = globalPda(program.programId);
  const global = await program.account.globalConfig.fetch(globalConfig);
  const isAdmin = global.admin.equals(operator.publicKey);
  const isPauser = global.pauser.equals(operator.publicKey);
  if (!isAdmin && !isPauser) {
    fail(`operator ${operator.publicKey.toBase58()} is neither GlobalConfig.admin nor pauser`);
  }

  if (mode === "open") {
    const before = pauseState(global);
    fs.writeFileSync(
      snapshotPath,
      `${JSON.stringify({
        schemaVersion: 1,
        cluster: "devnet",
        genesis,
        programId: program.programId.toBase58(),
        globalConfig: globalConfig.toBase58(),
        operator: operator.publicKey.toBase58(),
        flags: before,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(`pause snapshot: ${snapshotPath}`);
    await setPause(
      program,
      globalConfig,
      operator,
      { ...before, graduationPaused: false },
      "graduation window open",
    );
    return;
  }

  if (!fs.existsSync(snapshotPath)) {
    console.log(`restore: no snapshot at ${snapshotPath}; nothing to restore.`);
    return;
  }
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  if (snapshot.cluster !== "devnet" || snapshot.genesis !== EXPECTED_DEVNET_GENESIS) {
    fail("restore snapshot is not devnet evidence");
  }
  if (snapshot.programId !== program.programId.toBase58()) fail("restore snapshot program mismatch");
  if (snapshot.globalConfig !== globalConfig.toBase58()) fail("restore snapshot GlobalConfig mismatch");
  await setPause(program, globalConfig, operator, snapshot.flags, "graduation window restore");
  console.log("OK — original devnet pause state restored.");
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
