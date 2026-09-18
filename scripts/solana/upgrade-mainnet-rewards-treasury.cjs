#!/usr/bin/env node
/**
 * Guarded in-place mainnet upgrade executor for the existing MemeWarzone
 * rewards treasury program.
 *
 * Dry-run / comparison only:
 *   SOLANA_RPC_URL=<mainnet-rpc> \
 *   node scripts/solana/upgrade-mainnet-rewards-treasury.cjs
 *
 * Execute only after the candidate workflow is green:
 *   SOLANA_RPC_URL=<mainnet-rpc> \
 *   SOLANA_REWARDS_UPGRADE_AUTHORITY_KEYPAIR=/secure/upgrade-authority.json \
 *   SOLANA_REWARDS_RELEASE_CANDIDATE_SHA256=<certified .so sha256> \
 *   SOLANA_REWARDS_MAINNET_BROADCAST=UPGRADE_MWZ_REWARDS_MAINNET \
 *   node scripts/solana/upgrade-mainnet-rewards-treasury.cjs --execute
 *
 * The write path performs all read-only identity/hash/authority checks first,
 * upgrades the SAME program id, dumps the deployed binary, and requires exact
 * byte-for-byte equality with the certified candidate.
 */
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const PROGRAM_ID = "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const BROADCAST_TOKEN = "UPGRADE_MWZ_REWARDS_MAINNET";
const DEFAULT_SO = path.join(ROOT, "target/deploy/mwz_rewards_treasury.so");
const DEFAULT_IDL = path.join(ROOT, "target/idl/mwz_rewards_treasury.json");
const DEFAULT_HASH_MANIFEST = path.join(ROOT, "rewards-treasury-sha256.txt");
const PREFLIGHT = path.join(__dirname, "preflight-rewards-treasury-upgrade.sh");

function required(name, fallback = "") {
  const value = String(process.env[name] || fallback || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    ...options,
  });
}

function showProgram(rpc) {
  const raw = run("solana", ["program", "show", PROGRAM_ID, "--url", rpc, "--output", "json"]);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Could not parse solana program show JSON: ${String(raw).slice(0, 500)}`);
  }
  const authority = String(parsed.authority || "").trim();
  const programId = String(parsed.programId || PROGRAM_ID).trim();
  const programdataAddress = String(parsed.programdataAddress || "").trim();
  if (programId !== PROGRAM_ID) throw new Error(`Program-show returned unexpected program ${programId}`);
  if (!authority) throw new Error("Rewards treasury has no readable upgrade authority");
  if (!programdataAddress) throw new Error("Rewards treasury ProgramData address is missing");
  return {
    authority,
    programId,
    programdataAddress,
    lastDeployedInSlot: parsed.lastDeployedInSlot ?? null,
    dataLen: parsed.dataLen ?? null,
  };
}

function dumpProgram(rpc, destination) {
  run("solana", ["program", "dump", PROGRAM_ID, destination, "--url", rpc], { stdio: "inherit" });
  if (!fs.existsSync(destination) || fs.statSync(destination).size === 0) {
    throw new Error(`Program dump did not create ${destination}`);
  }
  return fs.readFileSync(destination);
}

function keypairPubkey(keypairPath) {
  return String(run("solana-keygen", ["pubkey", keypairPath])).trim();
}

function requireCandidateFiles(soPath, idlPath, hashManifest) {
  for (const [label, file] of [["candidate program", soPath], ["candidate IDL", idlPath], ["hash manifest", hashManifest]]) {
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      throw new Error(`Missing ${label}: ${file}`);
    }
  }
}

function verifyIdl(idlPath) {
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const address = String(idl.address || idl.metadata?.address || "").trim();
  if (address && address !== PROGRAM_ID) {
    throw new Error(`IDL program ID mismatch: ${address} != ${PROGRAM_ID}`);
  }
  const names = new Set((idl.instructions || []).map((ix) => String(ix.name)));
  const requiredInstructions = [
    ["initialize_arena", "initializeArena"],
    ["set_arena_resolver", "setArenaResolver"],
    ["set_arena_receivers", "setArenaReceivers"],
    ["set_arena_pause", "setArenaPause"],
    ["open_battle_pool_v2", "openBattlePoolV2"],
    ["open_tournament_pool_v2", "openTournamentPoolV2"],
    ["resolve_pool_v2", "resolvePoolV2"],
    ["claim_winner", "claimWinner"],
    ["claim_protocol", "claimProtocol"],
    ["claim_mwl", "claimMwl"],
    ["set_recruiter_batch_root", "setRecruiterBatchRoot"],
    ["claim_recruiter", "claimRecruiter"],
    ["set_squad_batch_root", "setSquadBatchRoot"],
    ["claim_squad", "claimSquad"],
  ];
  for (const aliases of requiredInstructions) {
    if (!aliases.some((name) => names.has(name))) throw new Error(`IDL missing ${aliases[0]}`);
  }
}

async function main() {
  const execute = process.argv.includes("--execute");
  const rpc = required("SOLANA_RPC_URL", process.env.SOLANA_RPC);
  if (/devnet|testnet/i.test(rpc)) throw new Error("Rewards mainnet upgrade refuses devnet/testnet RPC");

  const soPath = path.resolve(process.env.SOLANA_REWARDS_CANDIDATE_SO || DEFAULT_SO);
  const idlPath = path.resolve(process.env.SOLANA_REWARDS_CANDIDATE_IDL || DEFAULT_IDL);
  const hashManifest = path.resolve(process.env.SOLANA_REWARDS_HASH_MANIFEST || DEFAULT_HASH_MANIFEST);
  requireCandidateFiles(soPath, idlPath, hashManifest);
  verifyIdl(idlPath);

  const genesis = String(run("solana", ["genesis-hash", "--url", rpc])).trim();
  if (genesis !== MAINNET_GENESIS) throw new Error(`Refusing non-mainnet genesis ${genesis}`);

  // Existing read-only preflight verifies certified hashes, live program identity,
  // ProgramData/authority readability, IDL boundary and captures live/candidate hashes.
  run("bash", [PREFLIGHT, soPath, idlPath, hashManifest], {
    stdio: "inherit",
    env: {
      ...process.env,
      SOLANA_RPC_URL: rpc,
      SOLANA_REWARDS_TREASURY_PROGRAM_ID: PROGRAM_ID,
    },
  });

  const live = showProgram(rpc);
  const candidate = fs.readFileSync(soPath);
  const candidateSha256 = sha256(candidate);
  const pinnedSha = String(process.env.SOLANA_REWARDS_RELEASE_CANDIDATE_SHA256 || "").trim().toLowerCase();

  if (pinnedSha && pinnedSha !== candidateSha256) {
    throw new Error(`Certified candidate SHA mismatch: pinned ${pinnedSha}, local ${candidateSha256}`);
  }
  if (execute && !pinnedSha) {
    throw new Error("SOLANA_REWARDS_RELEASE_CANDIDATE_SHA256 is required with --execute");
  }

  const liveDumpPath = path.join(os.tmpdir(), `mwz-rewards-live-${process.pid}.so`);
  let liveBinary;
  try {
    liveBinary = dumpProgram(rpc, liveDumpPath);
  } finally {
    try { fs.unlinkSync(liveDumpPath); } catch { /* cleanup only */ }
  }
  const liveSha256 = sha256(liveBinary);

  let authorityKeypair = null;
  let suppliedAuthority = null;
  if (execute) {
    authorityKeypair = required("SOLANA_REWARDS_UPGRADE_AUTHORITY_KEYPAIR");
    if (!fs.existsSync(authorityKeypair)) throw new Error(`Upgrade authority keypair not found: ${authorityKeypair}`);
    suppliedAuthority = keypairPubkey(authorityKeypair);
    if (suppliedAuthority !== live.authority) {
      throw new Error(`Refusing upgrade key ${suppliedAuthority}; on-chain authority is ${live.authority}`);
    }
    if (String(process.env.SOLANA_REWARDS_MAINNET_BROADCAST || "").trim() !== BROADCAST_TOKEN) {
      throw new Error(`SOLANA_REWARDS_MAINNET_BROADCAST must equal ${BROADCAST_TOKEN} with --execute`);
    }
  }

  console.log(JSON.stringify({
    execute,
    programId: PROGRAM_ID,
    genesis,
    programdataAddress: live.programdataAddress,
    onChainUpgradeAuthority: live.authority,
    suppliedAuthority,
    candidateSha256,
    candidateBytes: candidate.length,
    liveSha256,
    liveBytes: liveBinary.length,
    byteIdenticalBeforeUpgrade: candidate.equals(liveBinary),
    candidatePinned: Boolean(pinnedSha),
  }, null, 2));

  if (!execute) {
    console.log("Dry-run only. No transaction sent.");
    return;
  }

  if (candidate.equals(liveBinary)) {
    throw new Error("Certified rewards candidate is already deployed; refusing unnecessary upgrade transaction");
  }

  // FIRST WRITE occurs only after every zero-write check above has passed.
  run(
    "solana",
    [
      "program", "deploy", soPath,
      "--program-id", PROGRAM_ID,
      "--upgrade-authority", authorityKeypair,
      "--keypair", authorityKeypair,
      "--url", rpc,
    ],
    { stdio: "inherit" },
  );

  const deployedDumpPath = path.join(os.tmpdir(), `mwz-rewards-deployed-${process.pid}.so`);
  try {
    const deployed = dumpProgram(rpc, deployedDumpPath);
    const deployedSha256 = sha256(deployed);
    const byteIdentical = candidate.equals(deployed);
    console.log(JSON.stringify({
      deploymentVerification: true,
      programId: PROGRAM_ID,
      candidateSha256,
      deployedSha256,
      candidateBytes: candidate.length,
      deployedBytes: deployed.length,
      byteIdentical,
    }, null, 2));
    if (!byteIdentical || deployedSha256 !== candidateSha256) {
      throw new Error(
        `DEPLOYMENT VERIFICATION FAILED: candidate ${candidateSha256}/${candidate.length}; deployed ${deployedSha256}/${deployed.length}. Keep rewards/Arena claims paused.`,
      );
    }
  } finally {
    try { fs.unlinkSync(deployedDumpPath); } catch { /* cleanup only */ }
  }

  console.log(JSON.stringify({
    upgraded: true,
    verified: true,
    programId: PROGRAM_ID,
    candidateSha256,
    next: [
      "Record this exact source SHA and candidate hash in release evidence",
      "Initialize/verify production rewards and Arena Money V2 accounts",
      "Keep public claims dark until claim funding and reconciliation canaries pass",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
