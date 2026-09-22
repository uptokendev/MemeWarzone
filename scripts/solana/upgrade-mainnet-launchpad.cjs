#!/usr/bin/env node
/**
 * Upgrade the EXISTING mainnet launchpad in place (same program id).
 * Does not migrate accounts or change PDAs.
 *
 * Binary comparison only (no private key required):
 *   SOLANA_RPC="https://mainnet.helius-rpc.com/?api-key=..." \
 *   node scripts/solana/upgrade-mainnet-launchpad.cjs
 *
 * Execute (fail-closed candidate pin + live authority verification):
 *   SOLANA_RPC="https://mainnet.helius-rpc.com/?api-key=..." \
 *   SOLANA_PROTOCOL_AUTHORITY_KEYPAIR=/secure/path/upgrade-authority.json \
 *   SOLANA_RELEASE_CANDIDATE_SHA256=<sha256 printed by the passing final gate> \
 *   node scripts/solana/upgrade-mainnet-launchpad.cjs --execute
 *
 * The execute path reads the current on-chain upgrade authority, requires the
 * supplied keypair to match it, deploys, dumps the deployed program back from
 * mainnet, and requires an exact byte-for-byte match with the candidate .so.
 */
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Connection, Keypair, PublicKey } = require(path.resolve(__dirname, "../../tests/solana/node_modules/@solana/web3.js"));

const ROOT = path.resolve(__dirname, "../..");
const SO_PATH = path.join(ROOT, "target/deploy/memewarzone_solana.so");
const EXPECTED_PROGRAM = "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
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
    throw new Error("Launchpad program has no upgrade authority (immutable or malformed program-show response)");
  }
  return {
    authority,
    programId: String(parsed.programId || EXPECTED_PROGRAM),
    programdataAddress: String(parsed.programdataAddress || ""),
    lastDeployedInSlot: parsed.lastDeployedInSlot ?? null,
    dataLen: parsed.dataLen ?? null,
  };
}

/**
 * A deployed program occupies the whole ProgramData allocation, which is only
 * as large as the binary when the two happen to match exactly. Normally the
 * allocation is larger and `solana program dump` returns the binary followed by
 * zero padding, so comparing the dump to the candidate byte-for-byte reports a
 * mismatch on a perfectly good upgrade.
 *
 * The real invariant is: the allocation starts with the candidate and every
 * remaining byte is zero. Anything else -- a short allocation, different code,
 * or non-zero bytes past the binary -- is a genuine failure.
 */
function deployedMatchesCandidate(deployed, candidate) {
  if (deployed.length < candidate.length) {
    return { ok: false, reason: "allocation-smaller-than-candidate" };
  }
  if (!deployed.subarray(0, candidate.length).equals(candidate)) {
    return { ok: false, reason: "candidate-bytes-differ" };
  }
  const padding = deployed.subarray(candidate.length);
  if (padding.length && !padding.every((byte) => byte === 0)) {
    return { ok: false, reason: "trailing-bytes-not-zero" };
  }
  return { ok: true, reason: "byte-identical-with-zero-padding", paddingBytes: padding.length };
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

async function main() {
  const execute = process.argv.includes("--execute");
  const rpc = required("SOLANA_RPC");
  if (/devnet|testnet|explorer\.solana/i.test(rpc)) {
    throw new Error("SOLANA_RPC must be a mainnet-beta HTTP endpoint");
  }
  if (!fs.existsSync(SO_PATH)) {
    throw new Error(`Missing ${SO_PATH}. Run the final SBF gate; do not rebuild after it passes.`);
  }

  const connection = new Connection(rpc, "confirmed");
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS) throw new Error(`Refusing non-mainnet genesis ${genesis}`);

  const programId = new PublicKey(EXPECTED_PROGRAM);
  const info = await connection.getAccountInfo(programId, "confirmed");
  if (!info || !info.executable) throw new Error("Launchpad program account missing or not executable");
  if (info.owner.toBase58() !== "BPFLoaderUpgradeab1e11111111111111111111111") {
    throw new Error(`Program is not upgradeable (owner ${info.owner.toBase58()})`);
  }

  const liveProgram = showProgram(rpc);
  if (liveProgram.programId && liveProgram.programId !== EXPECTED_PROGRAM) {
    throw new Error(`Program-show returned unexpected program ${liveProgram.programId}`);
  }

  const candidate = fs.readFileSync(SO_PATH);
  const candidateSha256 = sha256(candidate);
  const pinnedCandidateSha256 = String(process.env.SOLANA_RELEASE_CANDIDATE_SHA256 || "").trim().toLowerCase();

  if (pinnedCandidateSha256 && pinnedCandidateSha256 !== candidateSha256) {
    throw new Error(
      `Release candidate SHA mismatch: pinned ${pinnedCandidateSha256}, local ${candidateSha256}. ` +
        "Do not deploy a rebuilt or different artifact.",
    );
  }
  if (execute && !pinnedCandidateSha256) {
    throw new Error(
      "SOLANA_RELEASE_CANDIDATE_SHA256 is required with --execute. " +
        "Set it to the SHA256 emitted by the exact passing final SBF gate.",
    );
  }

  let keypairPath = null;
  let payer = null;
  const configuredKeypair = String(process.env.SOLANA_PROTOCOL_AUTHORITY_KEYPAIR || "").trim();
  if (execute) {
    keypairPath = required("SOLANA_PROTOCOL_AUTHORITY_KEYPAIR");
  } else if (configuredKeypair) {
    keypairPath = configuredKeypair;
  }
  if (keypairPath) {
    payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8"))));
    if (payer.publicKey.toBase58() !== liveProgram.authority) {
      throw new Error(
        `Refusing upgrade key ${payer.publicKey.toBase58()}; current on-chain upgrade authority is ${liveProgram.authority}`,
      );
    }
  }

  console.log(JSON.stringify({
    execute,
    programId: EXPECTED_PROGRAM,
    onChainUpgradeAuthority: liveProgram.authority,
    suppliedAuthority: payer?.publicKey.toBase58() || null,
    programdataAddress: liveProgram.programdataAddress || null,
    lastDeployedInSlot: liveProgram.lastDeployedInSlot,
    deployedDataLen: liveProgram.dataLen,
    candidateBytes: candidate.length,
    candidateSha256,
    candidatePinned: Boolean(pinnedCandidateSha256),
    note: "Same program id = in-place upgrade. Global/generation/campaign PDAs stay put.",
  }, null, 2));

  if (!execute) {
    const liveDumpPath = path.join(os.tmpdir(), `mwz-mainnet-live-${process.pid}.so`);
    try {
      const deployed = dumpProgram(rpc, liveDumpPath);
      const deployedSha256 = sha256(deployed);
      console.log(JSON.stringify({
        dryRunLiveComparison: true,
        candidateSha256,
        candidateBytes: candidate.length,
        deployedSha256,
        deployedBytes: deployed.length,
        byteIdentical: deployedMatchesCandidate(deployed, candidate).ok,
      }, null, 2));
    } finally {
      try { fs.unlinkSync(liveDumpPath); } catch { /* ignore cleanup */ }
    }
    console.log("Dry-run only. Re-run with --execute and the pinned candidate SHA after reviewing the comparison.");
    return;
  }

  execFileSync(
    "solana",
    [
      "program",
      "deploy",
      SO_PATH,
      "--program-id",
      EXPECTED_PROGRAM,
      "--upgrade-authority",
      keypairPath,
      "--url",
      rpc,
      "--keypair",
      keypairPath,
    ],
    { stdio: "inherit" },
  );

  const deployedDumpPath = path.join(os.tmpdir(), `mwz-mainnet-deployed-${process.pid}.so`);
  try {
    const deployed = dumpProgram(rpc, deployedDumpPath);
    const deployedSha256 = sha256(deployed);
    const match = deployedMatchesCandidate(deployed, candidate);
    const byteIdentical = match.ok;

    console.log(JSON.stringify({
      deploymentVerification: true,
      programId: EXPECTED_PROGRAM,
      candidateSha256,
      candidateBytes: candidate.length,
      deployedSha256,
      deployedBytes: deployed.length,
      byteIdentical,
    }, null, 2));

    if (!match.ok) {
      throw new Error(
        `DEPLOYMENT VERIFICATION FAILED (${match.reason}): candidate ${candidateSha256}/${candidate.length} bytes; ` +
          `deployed ${deployedSha256}/${deployed.length} bytes. Keep trading closed.`,
      );
    }
  } finally {
    try { fs.unlinkSync(deployedDumpPath); } catch { /* ignore cleanup */ }
  }

  console.log(JSON.stringify({
    upgraded: true,
    verified: true,
    programId: EXPECTED_PROGRAM,
    candidateSha256,
    next: [
      "Set Coolify/Railway SOLANA_LAUNCHPAD_PROGRAM_SHA256 to this exact hash",
      "Do not rebuild the program after this verification",
      "Run CREATE, BUY and SELL mainnet canaries before opening public trading",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
