"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  Connection,
  PublicKey,
} = require("@solana/web3.js");

const ROOT = path.resolve(__dirname, "../..");
const DEFAULT_RPC = "https://api.devnet.solana.com";
const DEFAULT_IDL = path.join(ROOT, "target/idl/memewarzone_solana.json");
const DEFAULT_PROGRAM_BINARY = path.join(ROOT, "target/deploy/memewarzone_solana.so");
const DEFAULT_PROGRAM_SOURCE = path.join(ROOT, "programs/memewarzone_solana/src/lib.rs");
const DEFAULT_ANCHOR_TOML = path.join(ROOT, "Anchor.toml");
const DEFAULT_OUTPUT = path.join(ROOT, "deployments/solana-devnet.deployment-identity.json");
const PROGRAM_STATE_TAG = 2;
const PROGRAM_DATA_STATE_TAG = 3;
const PROGRAM_ACCOUNT_METADATA_BYTES = 36;
const PROGRAM_DATA_METADATA_BYTES = 45;

function fail(message) {
  throw new Error(`[solana-devnet-identity] ${message}`);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function readText(filePath, label) {
  if (!fs.existsSync(filePath)) fail(`${label} not found: ${filePath}`);
  return fs.readFileSync(filePath, "utf8");
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readText(filePath, label));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseSourceProgramId(source) {
  const match = source.match(/declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/);
  if (!match) fail("declare_id! program ID is missing");
  return match[1];
}

function parseAnchorProgramId(anchorToml, network) {
  const pattern = new RegExp(`\\[programs\\.${network}\\][\\s\\S]*?memewarzone_solana\\s*=\\s*\"([1-9A-HJ-NP-Za-km-z]+)\"`);
  const match = anchorToml.match(pattern);
  if (!match) fail(`Anchor.toml ${network} program ID is missing`);
  return match[1];
}

function sameKey(actual, expected, label) {
  assert.ok(new PublicKey(actual).equals(new PublicKey(expected)), `${label} mismatch`);
}

function parseArgs(argv) {
  const options = {
    idl: DEFAULT_IDL,
    binary: DEFAULT_PROGRAM_BINARY,
    output: DEFAULT_OUTPUT,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--idl") options.idl = path.resolve(argv[++index]);
    else if (arg === "--binary") options.binary = path.resolve(argv[++index]);
    else if (arg === "--output") options.output = path.resolve(argv[++index]);
    else if (arg === "--rpc-url") options.rpcUrl = argv[++index];
    else if (arg === "--program-id") options.programId = argv[++index];
    else fail(`Unknown argument: ${arg}`);
  }
  return options;
}

function decodeUpgradeableProgramAccount(data) {
  const bytes = Buffer.from(data);
  if (bytes.length < PROGRAM_ACCOUNT_METADATA_BYTES) {
    fail(`program account data is too short (${bytes.length} bytes)`);
  }
  const stateTag = bytes.readUInt32LE(0);
  if (stateTag !== PROGRAM_STATE_TAG) {
    fail(`program account loader state is ${stateTag}, expected Program (${PROGRAM_STATE_TAG})`);
  }
  return {
    stateTag,
    programDataAddress: new PublicKey(bytes.subarray(4, PROGRAM_ACCOUNT_METADATA_BYTES)),
  };
}

function decodeUpgradeableProgramDataAccount(data) {
  const bytes = Buffer.from(data);
  if (bytes.length < PROGRAM_DATA_METADATA_BYTES) {
    fail(`ProgramData account data is too short (${bytes.length} bytes)`);
  }
  const stateTag = bytes.readUInt32LE(0);
  if (stateTag !== PROGRAM_DATA_STATE_TAG) {
    fail(`ProgramData loader state is ${stateTag}, expected ProgramData (${PROGRAM_DATA_STATE_TAG})`);
  }
  const deploymentSlot = bytes.readBigUInt64LE(4);
  const authorityOption = bytes.readUInt8(12);
  let upgradeAuthority = null;
  if (authorityOption === 1) {
    upgradeAuthority = new PublicKey(bytes.subarray(13, PROGRAM_DATA_METADATA_BYTES));
  } else if (authorityOption !== 0) {
    fail(`ProgramData upgrade-authority option is invalid: ${authorityOption}`);
  }
  return {
    stateTag,
    deploymentSlot,
    upgradeAuthority,
    programBytes: bytes.subarray(PROGRAM_DATA_METADATA_BYTES),
  };
}

function verifyDeployedBytes(programDataBytes, localBinary) {
  if (programDataBytes.length < localBinary.length) {
    fail(
      `deployed ProgramData payload is shorter than the local binary (${programDataBytes.length} < ${localBinary.length})`,
    );
  }
  const deployedBinary = programDataBytes.subarray(0, localBinary.length);
  const mismatch = Buffer.compare(deployedBinary, localBinary);
  if (mismatch !== 0) {
    let firstMismatch = -1;
    for (let index = 0; index < localBinary.length; index += 1) {
      if (deployedBinary[index] !== localBinary[index]) {
        firstMismatch = index;
        break;
      }
    }
    fail(`deployed program bytes differ from local artifact at byte ${firstMismatch}`);
  }
  const trailing = programDataBytes.subarray(localBinary.length);
  let trailingNonZeroBytes = 0;
  for (const byte of trailing) {
    if (byte !== 0) trailingNonZeroBytes += 1;
  }
  return {
    deployedBinary,
    programDataCapacityBytes: programDataBytes.length,
    trailingBytes: trailing.length,
    trailingNonZeroBytes,
  };
}

async function main() {
  const options = parseArgs(process.argv);
  const idl = readJson(options.idl, "generated IDL");
  const source = readText(DEFAULT_PROGRAM_SOURCE, "program source");
  const anchorToml = readText(DEFAULT_ANCHOR_TOML, "Anchor.toml");
  const declaredProgramId = parseSourceProgramId(source);
  const anchorLocalnetProgramId = parseAnchorProgramId(anchorToml, "localnet");
  const anchorDevnetProgramId = parseAnchorProgramId(anchorToml, "devnet");
  const configuredProgramId = new PublicKey(
    firstNonEmpty(options.programId, process.env.SOLANA_LAUNCHPAD_PROGRAM_ID, idl.address, declaredProgramId),
  );

  sameKey(declaredProgramId, configuredProgramId, "declare_id! program ID");
  sameKey(anchorLocalnetProgramId, configuredProgramId, "Anchor.toml localnet program ID");
  sameKey(anchorDevnetProgramId, configuredProgramId, "Anchor.toml devnet program ID");
  if (idl.address) sameKey(idl.address, configuredProgramId, "IDL metadata address");

  if (!fs.existsSync(options.binary)) {
    fail(`program binary not found: ${options.binary}. Build the exact artifact before verification.`);
  }
  const localBinary = fs.readFileSync(options.binary);
  const localProgramSha256 = sha256Hex(localBinary);
  const configuredProgramSha256 = firstNonEmpty(process.env.SOLANA_LAUNCHPAD_PROGRAM_SHA256).toLowerCase();
  if (configuredProgramSha256) {
    assert.equal(configuredProgramSha256, localProgramSha256, "configured program binary hash mismatch");
  }

  const rpcUrl = firstNonEmpty(options.rpcUrl, process.env.SOLANA_RPC_URL, DEFAULT_RPC);
  const connection = new Connection(rpcUrl, "confirmed");
  const rpcVersion = await connection.getVersion();
  const programInfo = await connection.getAccountInfo(configuredProgramId, "confirmed");
  if (!programInfo) fail(`program account ${configuredProgramId.toBase58()} is missing`);
  assert.equal(programInfo.executable, true, "program account must be executable");
  sameKey(programInfo.owner, BPF_LOADER_UPGRADEABLE_PROGRAM_ID, "program account owner");

  const decodedProgram = decodeUpgradeableProgramAccount(programInfo.data);
  const expectedProgramDataAddress = firstNonEmpty(process.env.SOLANA_PROGRAMDATA_ADDRESS);
  if (expectedProgramDataAddress) {
    sameKey(decodedProgram.programDataAddress, expectedProgramDataAddress, "ProgramData address");
  }

  const programDataInfo = await connection.getAccountInfo(decodedProgram.programDataAddress, "confirmed");
  if (!programDataInfo) fail(`ProgramData account ${decodedProgram.programDataAddress.toBase58()} is missing`);
  sameKey(programDataInfo.owner, BPF_LOADER_UPGRADEABLE_PROGRAM_ID, "ProgramData owner");

  const decodedProgramData = decodeUpgradeableProgramDataAccount(programDataInfo.data);
  const expectedSlot = firstNonEmpty(process.env.SOLANA_DEPLOYMENT_SLOT);
  if (expectedSlot) {
    assert.equal(decodedProgramData.deploymentSlot, BigInt(expectedSlot), "deployment slot mismatch");
  }

  const expectedUpgradeAuthority = firstNonEmpty(process.env.SOLANA_UPGRADE_AUTHORITY_PUBLIC_KEY);
  if (!expectedUpgradeAuthority) {
    fail("SOLANA_UPGRADE_AUTHORITY_PUBLIC_KEY is required for deterministic verification (use none only for an intentionally immutable program)");
  }
  if (expectedUpgradeAuthority.toLowerCase() === "none") {
    assert.equal(decodedProgramData.upgradeAuthority, null, "program is expected to be immutable");
  } else {
    if (!decodedProgramData.upgradeAuthority) fail("program is immutable but an upgrade authority is expected");
    sameKey(decodedProgramData.upgradeAuthority, expectedUpgradeAuthority, "upgrade authority");
  }

  const deployed = verifyDeployedBytes(decodedProgramData.programBytes, localBinary);
  const deployedProgramSha256 = sha256Hex(deployed.deployedBinary);
  assert.equal(deployedProgramSha256, localProgramSha256, "deployed program SHA-256 mismatch");
  if (configuredProgramSha256) {
    assert.equal(deployedProgramSha256, configuredProgramSha256, "deployed program/configured SHA-256 mismatch");
  }

  const evidence = {
    schemaVersion: 1,
    status: "verified",
    verifiedAt: new Date().toISOString(),
    cluster: "devnet",
    rpcUrl,
    rpcVersion,
    programId: configuredProgramId.toBase58(),
    programDataAddress: decodedProgram.programDataAddress.toBase58(),
    deploymentSlot: decodedProgramData.deploymentSlot.toString(),
    upgradeAuthority: decodedProgramData.upgradeAuthority?.toBase58() || null,
    loader: BPF_LOADER_UPGRADEABLE_PROGRAM_ID.toBase58(),
    executable: programInfo.executable,
    localProgramBytes: localBinary.length,
    programDataCapacityBytes: deployed.programDataCapacityBytes,
    programDataTrailingBytes: deployed.trailingBytes,
    programDataTrailingNonZeroBytes: deployed.trailingNonZeroBytes,
    localProgramSha256,
    deployedProgramSha256,
    configuredProgramSha256: configuredProgramSha256 || null,
    staticProgramIds: {
      declareId: declaredProgramId,
      anchorLocalnet: anchorLocalnetProgramId,
      anchorDevnet: anchorDevnetProgramId,
      idlAddress: firstNonEmpty(idl.address) || null,
    },
  };

  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`Solana devnet deployment identity verified: ${options.output}`);
  console.log(`Program: ${evidence.programId}`);
  console.log(`ProgramData: ${evidence.programDataAddress}`);
  console.log(`Deployment slot: ${evidence.deploymentSlot}`);
  console.log(`Upgrade authority: ${evidence.upgradeAuthority || "immutable"}`);
  console.log(`Deployed SHA-256: ${evidence.deployedProgramSha256}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

module.exports = {
  decodeUpgradeableProgramAccount,
  decodeUpgradeableProgramDataAccount,
  verifyDeployedBytes,
};
