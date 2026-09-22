#!/usr/bin/env node
/**
 * Upgrade the EXISTING mwz_rewards_treasury on Solana devnet in place to the
 * gate-certified candidate. Deliberately devnet-only.
 *
 * The treasury had a local gate and a Squads preflight but no devnet upgrader,
 * so a devnet treasury upgrade meant typing `solana program deploy` by hand --
 * a command that takes --url and will just as happily hit mainnet. This script
 * decides the cluster from the genesis hash the RPC reports, so it cannot.
 *
 * Dry-run comparison:
 *   SOLANA_RPC_URL=https://api.devnet.solana.com \
 *   SOLANA_OPERATOR_KEYPAIR=~/.config/memewarzone/solana-devnet/deployer.json \
 *   SOLANA_DEVNET_CANDIDATE_SHA256=<sha from run-local-treasury-gate.sh> \
 *   node scripts/solana/upgrade-devnet-treasury.cjs
 *
 * Execute: add --execute.
 */
"use strict";

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { deployedMatchesCandidate } = require(path.resolve(__dirname, "./program-upgrade-verify.cjs"));

const ROOT = path.resolve(__dirname, "../..");
const SO_PATH = path.join(ROOT, "target/deploy/mwz_rewards_treasury.so");
const EXPECTED_PROGRAM = "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const EVIDENCE = process.env.SOLANA_DEVNET_UPGRADE_EVIDENCE || "/tmp/mwz-solana-devnet-treasury-upgrade.json";

const execute = process.argv.includes("--execute");

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function expand(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function solana(args) {
  return execFileSync("solana", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function showProgram(rpc, keypairPath) {
  const out = solana(["program", "show", EXPECTED_PROGRAM, "--url", rpc, "--keypair", keypairPath]);
  const field = (label) => {
    const match = out.match(new RegExp(`^${label}:\\s*(.+)$`, "m"));
    return match ? match[1].trim() : "";
  };
  return {
    programId: field("Program Id"),
    owner: field("Owner"),
    programData: field("ProgramData Address"),
    authority: field("Authority"),
    dataLen: Number(String(field("Data Length")).replace(/[^0-9].*$/, "")),
  };
}

function dumpProgram(rpc, destination, keypairPath) {
  solana(["program", "dump", EXPECTED_PROGRAM, destination, "--url", rpc, "--keypair", keypairPath]);
  if (!fs.existsSync(destination)) throw new Error(`Program dump did not create ${destination}`);
  return fs.readFileSync(destination);
}

async function main() {
  const rpc = required("SOLANA_RPC_URL");
  const keypairPath = expand(required("SOLANA_OPERATOR_KEYPAIR"));
  const pinnedSha = required("SOLANA_DEVNET_CANDIDATE_SHA256").toLowerCase();

  if (!fs.existsSync(SO_PATH)) {
    throw new Error(`Missing ${SO_PATH}. Run scripts/solana/run-local-treasury-gate.sh first.`);
  }

  // Cluster identity comes from the chain, not the URL: a mainnet RPC behind a
  // devnet-looking hostname is refused here, before a key is read.
  const genesis = solana(["genesis-hash", "--url", rpc]).trim();
  if (genesis !== DEVNET_GENESIS) {
    throw new Error(`Refusing non-devnet genesis ${genesis}; this script only ever runs on devnet.`);
  }

  const candidate = fs.readFileSync(SO_PATH);
  const candidateSha = sha256(candidate);
  if (candidateSha !== pinnedSha) {
    throw new Error(`Candidate SHA mismatch: pinned=${pinnedSha} built=${candidateSha}`);
  }

  const before = showProgram(rpc, keypairPath);
  if (before.programId !== EXPECTED_PROGRAM) throw new Error(`Unexpected program ${before.programId}`);
  if (before.owner !== UPGRADEABLE_LOADER) throw new Error(`Program is not upgradeable; owner=${before.owner}`);
  if (!before.programData) throw new Error("ProgramData address could not be read");
  if (!Number.isFinite(before.dataLen) || before.dataLen <= 0) throw new Error(`Invalid dataLen=${before.dataLen}`);

  const livePath = path.join(os.tmpdir(), `mwz-devnet-treasury-live-${process.pid}.so`);
  let live;
  try {
    live = dumpProgram(rpc, livePath, keypairPath);
  } finally {
    try { fs.unlinkSync(livePath); } catch { /* ignore cleanup */ }
  }
  const alreadyCurrent = deployedMatchesCandidate(live, candidate).ok;

  const record = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    execute,
    cluster: "devnet",
    genesis,
    programId: EXPECTED_PROGRAM,
    programdataAddress: before.programData,
    onChainUpgradeAuthority: before.authority,
    allocatedProgramBytesBefore: before.dataLen,
    candidateSha256: candidateSha,
    candidateBytes: candidate.length,
    liveSha256Before: sha256(live),
    liveBytesBefore: live.length,
    extensionBytesRequired: Math.max(0, candidate.length - before.dataLen),
    alreadyCurrent,
  };
  console.log(JSON.stringify(record, null, 2));

  if (alreadyCurrent) {
    fs.writeFileSync(EVIDENCE, JSON.stringify({ ...record, result: "already-current" }, null, 2));
    console.log(`upgrade_evidence=${EVIDENCE}`);
    console.log("OK — devnet already runs the certified candidate; no transaction sent.");
    return;
  }
  if (record.extensionBytesRequired > 0) {
    throw new Error(
      `Candidate needs ${record.extensionBytesRequired} more bytes than the ProgramData allocation ` +
      `(${before.dataLen}); extend the program before upgrading.`,
    );
  }
  if (!execute) {
    fs.writeFileSync(EVIDENCE, JSON.stringify({ ...record, result: "dry-run" }, null, 2));
    console.log(`upgrade_evidence=${EVIDENCE}`);
    console.log("Dry-run only: devnet differs from the certified candidate.");
    return;
  }

  // A 1.2MB program is uploaded as hundreds of write transactions, and on a
  // busy public RPC enough of them drop that the deploy aborts -- stranding the
  // funded buffer. A priority fee and more signing attempts make them land;
  // both are tunable because the right value depends on the cluster's mood.
  const computeUnitPrice = String(process.env.SOLANA_DEPLOY_COMPUTE_UNIT_PRICE || "10000").trim();
  const maxSignAttempts = String(process.env.SOLANA_DEPLOY_MAX_SIGN_ATTEMPTS || "60").trim();
  const deployArgs = [
    "program", "deploy", SO_PATH,
    "--program-id", EXPECTED_PROGRAM,
    "--upgrade-authority", keypairPath,
    "--url", rpc,
    "--keypair", keypairPath,
    "--with-compute-unit-price", computeUnitPrice,
    "--max-sign-attempts", maxSignAttempts,
  ];
  // A resumable buffer keeps a failed upload's lamports recoverable by address
  // instead of only through the seed phrase the CLI prints once.
  const bufferKeypair = String(process.env.SOLANA_DEPLOY_BUFFER_KEYPAIR || "").trim();
  if (bufferKeypair) deployArgs.push("--buffer", expand(bufferKeypair));

  console.log(`[upgrade] deploying with computeUnitPrice=${computeUnitPrice} maxSignAttempts=${maxSignAttempts}`);
  try {
    execFileSync("solana", deployArgs, { stdio: "inherit" });
  } catch (error) {
    throw new Error(
      `solana program deploy failed: ${error?.message || error}\n` +
      `A funded buffer may be orphaned. List it with:\n` +
      `  solana program show --buffers --url ${rpc} --keypair ${keypairPath}\n` +
      `then resume with SOLANA_DEPLOY_BUFFER_KEYPAIR, or reclaim the lamports with ` +
      `\`solana program close <BUFFER_ADDRESS> --recipient ${before.authority}\`.`,
    );
  }

  const afterPath = path.join(os.tmpdir(), `mwz-devnet-treasury-deployed-${process.pid}.so`);
  let deployed;
  try {
    deployed = dumpProgram(rpc, afterPath, keypairPath);
  } finally {
    try { fs.unlinkSync(afterPath); } catch { /* ignore cleanup */ }
  }
  const match = deployedMatchesCandidate(deployed, candidate);
  const after = showProgram(rpc, keypairPath);

  if (!match.ok) {
    throw new Error(
      `DEPLOYMENT VERIFICATION FAILED (${match.reason}): candidate ${candidateSha}/${candidate.length}; ` +
      `deployed ${sha256(deployed)}/${deployed.length}`,
    );
  }
  if (after.authority !== before.authority) {
    throw new Error(`Upgrade authority changed unexpectedly: ${before.authority} -> ${after.authority}`);
  }

  const evidence = {
    ...record,
    result: "upgraded",
    deployedSha256: sha256(deployed),
    deployedBytes: deployed.length,
    paddingBytes: match.paddingBytes,
    upgradeAuthorityAfter: after.authority,
    allocatedProgramBytesAfter: after.dataLen,
  };
  fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  console.log(`upgrade_evidence=${EVIDENCE}`);
  console.log("OK — certified candidate is deployed on Solana devnet and byte-verified.");
}

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exit(1);
});
