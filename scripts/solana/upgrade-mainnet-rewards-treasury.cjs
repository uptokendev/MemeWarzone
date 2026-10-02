#!/usr/bin/env node
/**
 * Guarded same-ID mainnet upgrade executor for mwz_rewards_treasury.
 * Default mode is read-only live/candidate comparison.
 * --execute requires an exact candidate hash, exact live authority, explicit
 * confirmation, same ProgramData identity, post-upgrade dump verification,
 * and an immutable non-overwriting evidence file.
 */
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const SO_PATH = path.join(ROOT, "target/deploy/mwz_rewards_treasury.so");
const EXPECTED_PROGRAM = "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const EXECUTE_CONFIRM = "UPGRADE_MWZ_REWARDS_MAINNET";

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(name + " is required");
  return value;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function normalizeProgramId() {
  const configured = String(process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || EXPECTED_PROGRAM).trim();
  if (configured !== EXPECTED_PROGRAM) {
    throw new Error("Rewards program id mismatch: configured " + configured + ", expected " + EXPECTED_PROGRAM);
  }
  return configured;
}

function showProgram(rpc, programId) {
  const stdout = execFileSync(
    "solana",
    ["program", "show", programId, "--url", rpc, "--output", "json"],
    { encoding: "utf8" },
  );
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Could not parse solana program show JSON: " + stdout.slice(0, 500));
  }
  const authority = String(parsed.authority || "").trim();
  const programdataAddress = String(parsed.programdataAddress || "").trim();
  if (!authority) throw new Error("Rewards program has no upgrade authority");
  if (!programdataAddress) throw new Error("Rewards program ProgramData address is missing");
  return {
    programId: String(parsed.programId || programId),
    authority,
    programdataAddress,
    lastDeployedInSlot: parsed.lastDeployedInSlot ?? null,
    dataLen: parsed.dataLen ?? null,
  };
}

function dumpProgram(rpc, programId, destination) {
  execFileSync("solana", ["program", "dump", programId, destination, "--url", rpc], { stdio: "inherit" });
  if (!fs.existsSync(destination) || fs.statSync(destination).size === 0) {
    throw new Error("Program dump did not create " + destination);
  }
  return fs.readFileSync(destination);
}

function evidencePath(candidateSha256) {
  const configured = String(process.env.SOLANA_REWARDS_UPGRADE_EVIDENCE_FILE || "").trim();
  return configured
    ? path.resolve(configured)
    : path.join(ROOT, "reports", "solana", "rewards-upgrade-" + candidateSha256 + ".json");
}

function loadWeb3() {
  return require(path.resolve(ROOT, "tests/solana/node_modules/@solana/web3.js"));
}

async function main() {
  const execute = process.argv.includes("--execute");
  const rpc = required("SOLANA_RPC");
  if (/devnet|testnet|explorer\.solana/i.test(rpc)) {
    throw new Error("SOLANA_RPC must be a mainnet-beta HTTP endpoint");
  }
  const programId = normalizeProgramId();

  if (!fs.existsSync(SO_PATH) || fs.statSync(SO_PATH).size === 0) {
    throw new Error("Missing certified rewards candidate: " + SO_PATH);
  }
  const candidate = fs.readFileSync(SO_PATH);
  const candidateSha256 = sha256(candidate);
  const pinnedSha256 = required("SOLANA_REWARDS_RELEASE_CANDIDATE_SHA256").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pinnedSha256)) {
    throw new Error("SOLANA_REWARDS_RELEASE_CANDIDATE_SHA256 must be a 64-character lowercase SHA256");
  }
  if (pinnedSha256 !== candidateSha256) {
    throw new Error("Rewards candidate SHA mismatch: pinned " + pinnedSha256 + ", local " + candidateSha256);
  }

  const finalEvidencePath = evidencePath(candidateSha256);
  if (execute && fs.existsSync(finalEvidencePath)) {
    throw new Error("Rewards upgrade evidence already exists; refusing replay/overwrite: " + finalEvidencePath);
  }

  const { Connection, Keypair, PublicKey } = loadWeb3();
  const connection = new Connection(rpc, "confirmed");
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS) throw new Error("Refusing non-mainnet genesis " + genesis);

  const programKey = new PublicKey(programId);
  const info = await connection.getAccountInfo(programKey, "confirmed");
  if (!info || !info.executable) throw new Error("Rewards program account missing or not executable");
  if (info.owner.toBase58() !== UPGRADEABLE_LOADER) {
    throw new Error("Rewards program is not upgradeable; owner=" + info.owner.toBase58());
  }

  const before = showProgram(rpc, programId);
  if (before.programId && before.programId !== programId) {
    throw new Error("program show returned unexpected rewards program " + before.programId);
  }

  let authorityKeypairPath = null;
  let authority = null;
  const configuredKeypair = String(process.env.SOLANA_REWARDS_UPGRADE_AUTHORITY_KEYPAIR || "").trim();
  if (execute) authorityKeypairPath = required("SOLANA_REWARDS_UPGRADE_AUTHORITY_KEYPAIR");
  else if (configuredKeypair) authorityKeypairPath = configuredKeypair;

  if (authorityKeypairPath) {
    const secret = JSON.parse(fs.readFileSync(authorityKeypairPath, "utf8"));
    authority = Keypair.fromSecretKey(Uint8Array.from(secret));
    if (authority.publicKey.toBase58() !== before.authority) {
      throw new Error(
        "Refusing rewards upgrade key " + authority.publicKey.toBase58() +
        "; live authority is " + before.authority,
      );
    }
  }

  const liveDumpPath = path.join(os.tmpdir(), "mwz-rewards-before-" + process.pid + ".so");
  let beforeBytes;
  try {
    beforeBytes = dumpProgram(rpc, programId, liveDumpPath);
  } finally {
    try { fs.unlinkSync(liveDumpPath); } catch {}
  }
  const beforeSha256 = sha256(beforeBytes);
  const alreadyDeployed = candidate.equals(beforeBytes);

  const preflight = {
    execute,
    cluster: "mainnet-beta",
    genesis,
    programId,
    programdataAddress: before.programdataAddress,
    liveUpgradeAuthority: before.authority,
    suppliedAuthority: authority ? authority.publicKey.toBase58() : null,
    lastDeployedInSlot: before.lastDeployedInSlot,
    candidateSha256,
    candidateBytes: candidate.length,
    liveSha256: beforeSha256,
    liveBytes: beforeBytes.length,
    candidatePinned: true,
    byteIdenticalBefore: alreadyDeployed,
    immutableEvidenceFile: finalEvidencePath,
  };
  console.log(JSON.stringify(preflight, null, 2));

  if (!execute) {
    console.log("Dry-run only. Review the live/candidate comparison before --execute.");
    return;
  }
  if (String(process.env.SOLANA_REWARDS_UPGRADE_CONFIRM || "").trim() !== EXECUTE_CONFIRM) {
    throw new Error("Execute requires SOLANA_REWARDS_UPGRADE_CONFIRM=" + EXECUTE_CONFIRM);
  }
  if (!authorityKeypairPath || !authority) throw new Error("Rewards upgrade authority keypair was not loaded");
  if (alreadyDeployed) {
    throw new Error("Certified rewards candidate is already deployed; refusing unnecessary upgrade transaction");
  }

  const deployOutput = execFileSync(
    "solana",
    [
      "program", "deploy", SO_PATH,
      "--program-id", programId,
      "--upgrade-authority", authorityKeypairPath,
      "--url", rpc,
      "--keypair", authorityKeypairPath,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

  const after = showProgram(rpc, programId);
  if (after.programId && after.programId !== programId) throw new Error("Post-upgrade rewards program id changed");
  if (after.programdataAddress !== before.programdataAddress) {
    throw new Error(
      "Rewards ProgramData identity changed: before=" + before.programdataAddress +
      " after=" + after.programdataAddress,
    );
  }
  if (after.authority !== before.authority) {
    throw new Error("Rewards upgrade authority changed: before=" + before.authority + " after=" + after.authority);
  }

  const afterDumpPath = path.join(os.tmpdir(), "mwz-rewards-after-" + process.pid + ".so");
  let afterBytes;
  try {
    afterBytes = dumpProgram(rpc, programId, afterDumpPath);
  } finally {
    try { fs.unlinkSync(afterDumpPath); } catch {}
  }
  const deployedSha256 = sha256(afterBytes);
  const byteIdenticalAfter = candidate.equals(afterBytes);
  if (!byteIdenticalAfter || deployedSha256 !== candidateSha256) {
    throw new Error(
      "REWARDS UPGRADE VERIFICATION FAILED: candidate=" + candidateSha256 + "/" + candidate.length +
      " deployed=" + deployedSha256 + "/" + afterBytes.length,
    );
  }

  const evidence = {
    schema: "memewarzone.solana-rewards-upgrade.v1",
    createdAt: new Date().toISOString(),
    cluster: "mainnet-beta",
    genesis,
    programId,
    programdataAddress: after.programdataAddress,
    upgradeAuthority: after.authority,
    candidate: {
      path: path.relative(ROOT, SO_PATH),
      sha256: candidateSha256,
      bytes: candidate.length,
      pinnedByEnv: true,
    },
    before: {
      sha256: beforeSha256,
      bytes: beforeBytes.length,
      lastDeployedInSlot: before.lastDeployedInSlot,
    },
    after: {
      sha256: deployedSha256,
      bytes: afterBytes.length,
      lastDeployedInSlot: after.lastDeployedInSlot,
      byteIdenticalToCandidate: true,
    },
    deployCommandOutput: String(deployOutput || "").trim().slice(0, 4000),
  };

  fs.mkdirSync(path.dirname(finalEvidencePath), { recursive: true });
  fs.writeFileSync(finalEvidencePath, JSON.stringify(evidence, null, 2) + "\n", {
    encoding: "utf8",
    flag: "wx",
  });

  console.log(JSON.stringify({
    upgraded: true,
    verified: true,
    programId,
    programdataAddress: after.programdataAddress,
    candidateSha256,
    deployedSha256,
    evidenceFile: finalEvidencePath,
    next: [
      "Keep reward claims dark until end-to-end publication and claim canaries pass.",
      "Archive the immutable evidence file with the exact source SHA and release artifacts.",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
