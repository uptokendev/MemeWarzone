import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// v7 create_campaign, in program order. Anchor matches accounts positionally,
// so order is part of the contract, not just membership.
const expectedAccounts = [
  "creator",
  "globalConfig",
  "generationConfig",
  "creatorProfile",
  "riskProfile",
  "clusterProfile",
  "campaign",
  "mint",
  "tokenVault",
  "solVault",
  "tokenMetadata",
  "tokenMetadataProgram",
  "feeEscrow",
  "creatorFeeVault",
  "instructions",
  "tokenProgram",
  "systemProgram",
];

// Accounts the wallet must NOT be asked to write. globalConfig is read-only
// because the program only reads route_signer from it, and marking it writable
// made Phantom attach a 41-byte Lighthouse assertion -- the single most
// expensive item in a transaction that had 20 bytes to spare.
const expectedReadonly = [
  "globalConfig",
  "generationConfig",
  "riskProfile",
  "clusterProfile",
  "tokenMetadataProgram",
  "instructions",
  "tokenProgram",
  "systemProgram",
];

const expectedFields = [
  "campaignId",
  "metadataHash",
  "name",
  "symbol",
  "launchAt",
  "graduationTargetUsdMicros",
  "deadline",
];

function normalize(value) {
  return String(value || "").replace(/_/g, "").toLowerCase();
}

function fail(message) {
  throw new Error(`[solana-v4-idl] ${message}`);
}

function findByName(items, name) {
  return (items || []).find((item) => normalize(item?.name) === normalize(name));
}

function flattenAccounts(accounts, output = []) {
  for (const account of accounts || []) {
    if (Array.isArray(account?.accounts)) flattenAccounts(account.accounts, output);
    else output.push(account);
  }
  return output;
}

function readIdl(filePath) {
  const raw = fs.readFileSync(filePath);
  let idl;
  try {
    idl = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    fail(`IDL is not valid JSON: ${error.message}`);
  }
  return { raw, idl };
}

function validateCreateInstruction(idl) {
  const instruction = findByName(idl.instructions, "createCampaign");
  if (!instruction) fail("createCampaign instruction is missing");

  const accounts = flattenAccounts(instruction.accounts);
  const accountNames = accounts.map((account) => normalize(account?.name));
  for (const account of expectedAccounts) {
    if (!accountNames.includes(normalize(account))) fail(`createCampaign account ${account} is missing`);
  }
  // Exact, and in order. An extra account is not harmless: every account costs
  // 32 bytes of key, and every WRITABLE one costs another 17-41 bytes of wallet
  // rewrite on top. v5 carried 18 and Phantom warned on every launch.
  if (accountNames.length !== expectedAccounts.length) {
    fail(
      `createCampaign has ${accountNames.length} accounts; expected ${expectedAccounts.length} ` +
        `(extra: ${accountNames.filter((n) => !expectedAccounts.map(normalize).includes(n)).join(", ") || "none"})`,
    );
  }
  expectedAccounts.forEach((expected, index) => {
    if (accountNames[index] !== normalize(expected)) {
      fail(
        `createCampaign account ${index} is ${accountNames[index]}; expected ${normalize(expected)} ` +
          "(Anchor matches accounts positionally)",
      );
    }
  });
  for (const name of expectedReadonly) {
    const account = accounts.find((item) => normalize(item?.name) === normalize(name));
    if (account?.writable || account?.isMut) {
      fail(`createCampaign account ${name} is writable; it must be read-only`);
    }
  }
  const writableCount = accounts.filter((account) => account?.writable || account?.isMut).length;
  if (writableCount !== 9) {
    fail(`createCampaign writes ${writableCount} accounts; expected 9`);
  }

  const args = instruction.args || [];
  if (args.length !== 1 || normalize(args[0]?.name) !== "args") {
    fail("createCampaign must expose exactly one args parameter");
  }
  return instruction;
}

function validateCreateArgsType(idl) {
  const definition = findByName(idl.types, "CreateCampaignArgs");
  if (!definition) fail("CreateCampaignArgs type is missing");
  const fields = definition?.type?.fields || definition?.fields || [];
  const fieldNames = fields.map((field) => normalize(field?.name));
  if (fieldNames.length !== expectedFields.length) {
    fail(`CreateCampaignArgs has ${fieldNames.length} fields; expected ${expectedFields.length}`);
  }
  for (let index = 0; index < expectedFields.length; index += 1) {
    if (fieldNames[index] !== normalize(expectedFields[index])) {
      fail(`CreateCampaignArgs field ${index} is ${fields[index]?.name}; expected ${expectedFields[index]}`);
    }
  }
  return definition;
}

function validateGeneratedProgramAccounts(idl) {
  // Anchor 0.30.1's compile-time IDL only emits account/type definitions that are
  // reachable through typed instruction contexts. Campaign, CampaignSolVault and
  // CreateAuthorization are intentionally handler-managed UncheckedAccount PDAs to
  // keep CreateCampaign's BPF stack bounded, so they remain present in the
  // instruction account list but are not emitted as generated IDL account types.
  // Keep this check strict for the protocol accounts that Anchor can deterministically
  // emit, while validateCreateInstruction above still verifies the full V4 account ABI.
  for (const account of [
    "GlobalConfig",
    "GenerationConfig",
    "CreatorProfile",
    "RiskProfile",
    "ClusterProfile",
  ]) {
    const declared = findByName(idl.accounts, account) || findByName(idl.types, account);
    if (!declared) fail(`account/type ${account} is missing`);
  }
}

function main() {
  const idlPath = path.resolve(process.argv[2] || "target/idl/memewarzone_solana.json");
  const bindingPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
  const { raw, idl } = readIdl(idlPath);
  const instruction = validateCreateInstruction(idl);
  validateCreateArgsType(idl);
  validateGeneratedProgramAccounts(idl);

  const idlSha256 = crypto.createHash("sha256").update(raw).digest("hex");
  const binding = {
    schemaVersion: 7,
    domain: "MEMEWARZONE_SOLANA_CREATE_V7",
    signedMessageMode: "sha256_canonical_payload",
    signedMessageLengthBytes: 32,
    instructionName: instruction.name,
    accountNames: flattenAccounts(instruction.accounts).map((account) => account.name),
    argumentName: instruction.args[0].name,
    createCampaignArgsFields: expectedFields,
    idlSha256,
  };

  if (bindingPath) {
    fs.mkdirSync(path.dirname(bindingPath), { recursive: true });
    fs.writeFileSync(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
  }

  console.log(JSON.stringify(binding));
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\n### Solana V4 generated IDL\n\n- IDL SHA-256: \`${idlSha256}\`\n- Instruction: \`${instruction.name}\`\n- Accounts: ${binding.accountNames.length}\n- V4 fields: ${expectedFields.length}\n`,
    );
  }
}

main();
