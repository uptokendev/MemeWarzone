import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";

const SCHEDULED_CREATE_AUTH_TYPES = [
  "string",
  "uint256",
  "address",
  "address",
  "bytes32",
  "uint64",
  "bytes32",
  "bytes32",
  "bytes32",
  "uint64",
  "uint256",
  "uint32",
  "uint32",
  "uint8",
  "uint8",
  "uint64",
];

function textHash(value: unknown): string {
  return ethers.keccak256(ethers.toUtf8Bytes(String(value ?? "")));
}

function hashCampaignRequest(request: Record<string, unknown>): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint256"],
      [
        textHash(request.name),
        textHash(request.symbol),
        textHash(request.logoURI),
        textHash(request.xAccount),
        textHash(request.website),
        textHash(request.extraLink),
        BigInt((request.graduationTarget as bigint | number | string) ?? 0),
      ],
    ),
  );
}

export const BNB_TESTNET_CHAIN_ID = 97n;
export const LOCAL_HARDHAT_CHAIN_ID = 31337n;
export const LIVE_97_FACTORY = "0x77Af7634837643d4f93d1086b492571268b30B5F";
export const EXPECTED_FACTORY_GENERATION = 4;
export const EXPECTED_CAMPAIGN_GENERATION = 3;

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

export function sameAddress(a: string, b: string): boolean {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function repoRoot(): string {
  return path.resolve(__dirname, "../..");
}

export function loadBnb6cAllowedFactory(explicitManifest?: string): string {
  const envFile = String(process.env.BNB_6C_STAGE_DEPLOYMENT_FILE || "").trim();
  const accepted = path.join(repoRoot(), "deployments/bnb/testnet.accepted.json");
  const staged = path.join(repoRoot(), "deployments/bnb/testnet.staged.json");
  const local = path.join(repoRoot(), ".tmp/bnb-testnet-stage.local.json");
  const file = path.resolve(explicitManifest || envFile || (fs.existsSync(accepted) ? accepted : fs.existsSync(staged) ? staged : local));
  if (!fs.existsSync(file)) throw new Error(`6C acceptance factory manifest missing: ${file}`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const factory = String(raw.contracts?.launchFactory || raw.factory || "");
  if (!/^0x[a-fA-F0-9]{40}$/.test(factory)) throw new Error("6C manifest launchFactory is missing");
  if (sameAddress(factory, LIVE_97_FACTORY)) throw new Error("6C acceptance factory must not be live 0x77Af…");
  return ethers.getAddress(factory);
}

export function assertBnb6cAcceptanceSignerAllowed(chainId: bigint | number | string, factoryAddress: string) {
  if (!truthy(process.env.BNB_6C_ACCEPTANCE_SIGNER)) {
    throw new Error("6C scheduled 4/3 signing requires BNB_6C_ACCEPTANCE_SIGNER=true");
  }
  const id = BigInt(chainId);
  if (id !== BNB_TESTNET_CHAIN_ID && id !== LOCAL_HARDHAT_CHAIN_ID) {
    throw new Error(`6C acceptance signer refuses chain ${chainId}`);
  }
  if (sameAddress(String(factoryAddress), LIVE_97_FACTORY)) {
    throw new Error("6C acceptance signer refuses live 3/2 factory 0x77Af…");
  }
  const allowed = loadBnb6cAllowedFactory();
  if (!sameAddress(String(factoryAddress), allowed)) {
    throw new Error(`6C acceptance signer is factory-scoped to ${allowed}; got ${factoryAddress}`);
  }
  return { chainId: id, factory: allowed };
}

export function buildBnb6cScheduledCreateAuthorizationDigest(options: Record<string, unknown>) {
  const factoryAddress = String(options.factoryAddress || options.factory || "");
  const { chainId, factory } = assertBnb6cAcceptanceSignerAllowed(options.chainId as bigint | number | string, factoryAddress);
  const request = ((options.request as { campaign?: Record<string, unknown> })?.campaign || options.request) as Record<string, unknown>;
  const requestHash = hashCampaignRequest(request);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(
    coder.encode(SCHEDULED_CREATE_AUTH_TYPES, [
      "MWZ_CREATE_SCHEDULED_V2_AUTH",
      chainId,
      factory,
      ethers.getAddress(String(options.creator)),
      requestHash,
      BigInt(options.launchAt as bigint | number | string),
      options.draftReferenceHash,
      options.normalizedTickerHash,
      options.metadataHash,
      BigInt(options.reservationVersion as bigint | number | string),
      BigInt(options.authorizationNonce as bigint | number | string),
      EXPECTED_FACTORY_GENERATION,
      EXPECTED_CAMPAIGN_GENERATION,
      Number(options.tradeRouteProfileId ?? options.tradeRouteProfile),
      Number(options.finalizeRouteProfileId ?? options.finalizeRouteProfile),
      BigInt(options.deadline as bigint | number | string),
    ]),
  );
}

export async function signBnb6cScheduledCreateAuthorization(options: {
  signer: { signMessage(message: Uint8Array): Promise<string> };
  [key: string]: unknown;
}) {
  const digest = buildBnb6cScheduledCreateAuthorizationDigest(options);
  return options.signer.signMessage(ethers.getBytes(digest));
}
