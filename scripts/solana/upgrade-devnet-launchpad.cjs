#!/usr/bin/env node
/**
 * Upgrade the EXISTING Solana devnet launchpad in place to the certified
 * source-head candidate. This script is deliberately devnet-only.
 *
 * Dry-run comparison:
 *   SOLANA_RPC_URL=https://api.devnet.solana.com \
 *   SOLANA_DEVNET_CANDIDATE_SHA256=<certified sha256> \
 *   node scripts/solana/upgrade-devnet-launchpad.cjs
 *
 * Execute:
 *   SOLANA_RPC_URL=https://api.devnet.solana.com \
 *   SOLANA_OPERATOR_KEYPAIR=/secure/devnet/deployer.json \
 *   SOLANA_DEVNET_CANDIDATE_SHA256=<certified sha256> \
 *   node scripts/solana/upgrade-devnet-launchpad.cjs --execute
 */
"use strict";

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} = require(path.resolve(__dirname, "../../tests/solana/node_modules/@solana/web3.js"));

const ROOT = path.resolve(__dirname, "../..");
const SO_PATH = path.join(ROOT, "target/deploy/memewarzone_solana.so");
const EXPECTED_PROGRAM = "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const DEFAULT_RPC = "https://api.devnet.solana.com";
const DEFAULT_EVIDENCE = "/tmp/mwz-solana-devnet-upgrade.json";
const PROGRAMDATA_METADATA_BYTES = 45;
const TX_RESERVE_LAMPORTS = 200_000_000;

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function loadKeypair(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Operator keypair not found: ${filePath}`);
  const bytes = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new Error("SOLANA_OPERATOR_KEYPAIR must point to a 64-byte Solana JSON keypair");
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

function showProgram(rpc) {
  const stdout = execFileSync(
    "solana",
    ["program", "show", EXPECTED_PROGRAM, "--url", rpc, "--output", "json"],
    { encoding: "utf8" },
  );
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Could not parse solana program show JSON: ${stdout.slice(0, 500)}`);
  }
  const authority = String(parsed.authority || "").trim();
  if (!authority) {
    throw new Error("Devnet launchpad has no upgrade authority or program-show returned malformed data");
  }
  return {
    authority,
    programId: String(parsed.programId || EXPECTED_PROGRAM),
    programdataAddress: String(parsed.programdataAddress || ""),
    lastDeployedInSlot: parsed.lastDeployedInSlot ?? null,
    dataLen: parsed.dataLen ?? null,
  };
}

function dumpProgram(rpc, destination) {
  execFileSync(
    "solana",
    ["program", "dump", EXPECTED_PROGRAM, destination, "--url", rpc],
    { stdio: "inherit" },
  );
  if (!fs.existsSync(destination) || fs.statSync(destination).size === 0) {
    throw new Error(`Program dump did not create ${destination}`);
  }
  return fs.readFileSync(destination);
}

function writeEvidence(record) {
  const output = String(process.env.SOLANA_DEVNET_UPGRADE_EVIDENCE || DEFAULT_EVIDENCE).trim();
  fs.writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  console.log(`upgrade_evidence=${output}`);
}

async function main() {
  const execute = process.argv.includes("--execute");
  const rpc = String(process.env.SOLANA_RPC_URL || DEFAULT_RPC).trim();
  const pinnedSha = required("SOLANA_DEVNET_CANDIDATE_SHA256").toLowerCase();
  const pinnedBytesRaw = String(process.env.SOLANA_DEVNET_CANDIDATE_BYTES || "").trim();
  const pinnedBytes = pinnedBytesRaw ? Number(pinnedBytesRaw) : null;

  if (!fs.existsSync(SO_PATH)) {
    throw new Error(`Missing ${SO_PATH}. Build the certified candidate before running this upgrader.`);
  }

  const connection = new Connection(rpc, "confirmed");
  const genesis = await connection.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) {
    throw new Error(`Refusing non-devnet genesis ${genesis}`);
  }

  const programId = new PublicKey(EXPECTED_PROGRAM);
  const programAccount = await connection.getAccountInfo(programId, "confirmed");
  if (!programAccount || !programAccount.executable) {
    throw new Error("Devnet launchpad program account is missing or not executable");
  }
  if (programAccount.owner.toBase58() !== UPGRADEABLE_LOADER) {
    throw new Error(`Devnet launchpad is not upgradeable; owner=${programAccount.owner.toBase58()}`);
  }

  const liveBefore = showProgram(rpc);
  if (liveBefore.programId !== EXPECTED_PROGRAM) {
    throw new Error(`Program-show returned unexpected program ${liveBefore.programId}`);
  }
  if (!liveBefore.programdataAddress) {
    throw new Error("Program-show did not return a ProgramData address");
  }
  if (!Number.isSafeInteger(Number(liveBefore.dataLen)) || Number(liveBefore.dataLen) <= 0) {
    throw new Error(`Program-show returned invalid dataLen=${liveBefore.dataLen}`);
  }

  const candidate = fs.readFileSync(SO_PATH);
  const candidateSha = sha256(candidate);
  if (candidateSha !== pinnedSha) {
    throw new Error(`Candidate SHA mismatch: pinned=${pinnedSha} built=${candidateSha}`);
  }
  if (pinnedBytes !== null && candidate.length !== pinnedBytes) {
    throw new Error(`Candidate byte-size mismatch: pinned=${pinnedBytes} built=${candidate.length}`);
  }

  const liveDumpPath = path.join(os.tmpdir(), `mwz-devnet-live-${process.pid}.so`);
  let liveBytes;
  try {
    liveBytes = dumpProgram(rpc, liveDumpPath);
  } finally {
    try { fs.unlinkSync(liveDumpPath); } catch { /* ignore cleanup */ }
  }
  const liveSha = sha256(liveBytes);
  const alreadyCurrent = liveBytes.equals(candidate);

  let operator = null;
  let operatorPath = null;
  if (execute) {
    operatorPath = required("SOLANA_OPERATOR_KEYPAIR");
    operator = loadKeypair(operatorPath);
    if (operator.publicKey.toBase58() !== liveBefore.authority) {
      throw new Error(
        `Refusing upgrade key ${operator.publicKey.toBase58()}; on-chain upgrade authority is ${liveBefore.authority}`,
      );
    }
  }

  const allocatedProgramBytesBefore = Number(liveBefore.dataLen);
  const extensionBytes = Math.max(0, candidate.length - allocatedProgramBytesBefore);
  const beforeRecord = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    execute,
    cluster: "devnet",
    genesis,
    rpc,
    programId: EXPECTED_PROGRAM,
    programdataAddress: liveBefore.programdataAddress,
    onChainUpgradeAuthority: liveBefore.authority,
    suppliedAuthority: operator?.publicKey.toBase58() || null,
    lastDeployedInSlotBefore: liveBefore.lastDeployedInSlot,
    allocatedProgramBytesBefore,
    candidateSha256: candidateSha,
    candidateBytes: candidate.length,
    liveSha256Before: liveSha,
    liveBytesBefore: liveBytes.length,
    extensionBytesRequired: extensionBytes,
    alreadyCurrent,
  };

  console.log(JSON.stringify(beforeRecord, null, 2));

  if (alreadyCurrent) {
    writeEvidence({ ...beforeRecord, upgraded: false, extended: false, verified: true, reason: "already-current" });
    console.log("OK — devnet already runs the certified candidate; no transaction sent.");
    return;
  }

  if (!execute) {
    writeEvidence({ ...beforeRecord, upgraded: false, extended: false, verified: false, reason: "dry-run-different" });
    console.log("Dry-run only: devnet differs from the certified candidate.");
    return;
  }

  const programdataKey = new PublicKey(liveBefore.programdataAddress);
  const programdataAccount = await connection.getAccountInfo(programdataKey, "confirmed");
  if (!programdataAccount) throw new Error("ProgramData account is missing");

  // Solana CLI 1.18.26 creates its temporary upgrade buffer using the rent
  // amount for ProgramData(candidate length), then sends a separate loader
  // Upgrade instruction. ProgramData growth is NOT part of that Upgrade path,
  // so we explicitly run `solana program extend` first when needed.
  const cliBufferFunding = await connection.getMinimumBalanceForRentExemption(
    candidate.length + PROGRAMDATA_METADATA_BYTES,
  );
  const requiredProgramdataAccountLen = candidate.length + PROGRAMDATA_METADATA_BYTES;
  const targetProgramdataRent = await connection.getMinimumBalanceForRentExemption(
    Math.max(programdataAccount.data.length, requiredProgramdataAccountLen),
  );
  const extensionTopup = Math.max(0, targetProgramdataRent - programdataAccount.lamports);
  const requiredLiquidLamports = cliBufferFunding + extensionTopup + TX_RESERVE_LAMPORTS;
  const operatorBalance = await connection.getBalance(operator.publicKey, "confirmed");

  console.log(JSON.stringify({
    operatorBalanceLamports: operatorBalance,
    operatorBalanceSol: operatorBalance / LAMPORTS_PER_SOL,
    estimatedCliBufferFundingLamports: cliBufferFunding,
    estimatedProgramdataExtensionTopupLamports: extensionTopup,
    transactionReserveLamports: TX_RESERVE_LAMPORTS,
    requiredLiquidLamports,
    requiredLiquidSol: requiredLiquidLamports / LAMPORTS_PER_SOL,
  }, null, 2));

  if (operatorBalance < requiredLiquidLamports) {
    throw new Error(
      `Devnet upgrade authority needs about ${(requiredLiquidLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL liquid ` +
      `for the temporary deploy buffer/extension; current balance is ${(operatorBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL.`,
    );
  }

  let extendOutput = null;
  let liveAfterExtend = liveBefore;
  if (extensionBytes > 0) {
    extendOutput = execFileSync(
      "solana",
      [
        "program",
        "extend",
        EXPECTED_PROGRAM,
        String(extensionBytes),
        "--url",
        rpc,
        "--keypair",
        operatorPath,
      ],
      { encoding: "utf8" },
    );
    process.stdout.write(extendOutput);
    liveAfterExtend = showProgram(rpc);
    if (liveAfterExtend.authority !== liveBefore.authority) {
      throw new Error(
        `Upgrade authority changed unexpectedly during extend: ${liveBefore.authority} -> ${liveAfterExtend.authority}`,
      );
    }
    if (Number(liveAfterExtend.dataLen) < candidate.length) {
      throw new Error(
        `ProgramData extension verification failed: allocated=${liveAfterExtend.dataLen}, candidate=${candidate.length}`,
      );
    }
    console.log(
      `OK — devnet ProgramData extended by ${extensionBytes} bytes; allocated=${liveAfterExtend.dataLen}.`,
    );
  }

  const deployOutput = execFileSync(
    "solana",
    [
      "program",
      "deploy",
      SO_PATH,
      "--program-id",
      EXPECTED_PROGRAM,
      "--upgrade-authority",
      operatorPath,
      "--url",
      rpc,
      "--keypair",
      operatorPath,
    ],
    { encoding: "utf8" },
  );
  process.stdout.write(deployOutput);
  const signatureMatch = deployOutput.match(/Signature:\s*([^\s]+)/i);
  const deploymentSignature = signatureMatch ? signatureMatch[1] : null;

  const deployedDumpPath = path.join(os.tmpdir(), `mwz-devnet-deployed-${process.pid}.so`);
  let deployed;
  try {
    deployed = dumpProgram(rpc, deployedDumpPath);
  } finally {
    try { fs.unlinkSync(deployedDumpPath); } catch { /* ignore cleanup */ }
  }
  const deployedSha = sha256(deployed);
  const byteIdentical = deployed.equals(candidate);
  const liveAfter = showProgram(rpc);

  if (!byteIdentical || deployedSha !== candidateSha) {
    throw new Error(
      `DEPLOYMENT VERIFICATION FAILED: candidate ${candidateSha}/${candidate.length}; ` +
      `deployed ${deployedSha}/${deployed.length}`,
    );
  }
  if (liveAfter.authority !== liveBefore.authority) {
    throw new Error(`Upgrade authority changed unexpectedly: ${liveBefore.authority} -> ${liveAfter.authority}`);
  }
  if (Number(liveAfter.dataLen) < candidate.length) {
    throw new Error(`Post-upgrade ProgramData allocation is too small: ${liveAfter.dataLen}`);
  }

  const evidence = {
    ...beforeRecord,
    upgraded: true,
    extended: extensionBytes > 0,
    extensionBytesApplied: extensionBytes,
    extendOutput: extendOutput ? extendOutput.trim() : null,
    allocatedProgramBytesAfterExtend: Number(liveAfterExtend.dataLen),
    verified: true,
    deploymentSignature,
    lastDeployedInSlotAfter: liveAfter.lastDeployedInSlot,
    allocatedProgramBytesAfter: Number(liveAfter.dataLen),
    deployedSha256: deployedSha,
    deployedBytes: deployed.length,
    byteIdentical: true,
    upgradeAuthorityAfter: liveAfter.authority,
  };
  writeEvidence(evidence);
  console.log(JSON.stringify(evidence, null, 2));
  console.log("OK — certified candidate is deployed on Solana devnet and byte-verified.");
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});