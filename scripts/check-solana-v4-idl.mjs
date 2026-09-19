import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

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
  "createAuthorization",
  "instructions",
  "tokenMetadata",
  "tokenMetadataProgram",
  "tokenProgram",
  "systemProgram",
];

const expectedFields = [
  "campaignId",
  "name",
  "symbol",
  "metadataHash",
  "clusterHash",
  "tickerHash",
  "reservationIdHash",
  "reservationVersion",
  "launchAt",
  "graduationTargetUsdMicros",
  "deadline",
  "nonce",
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
  const accountNames = new Set(accounts.map((account) => normalize(account?.name)));
  for (const account of expectedAccounts) {
    if (!accountNames.has(normalize(account))) fail(`createCampaign account ${account} is missing`);
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
    schemaVersion: 5,
    domain: "MEMEWARZONE_SOLANA_CREATE_V5",
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
