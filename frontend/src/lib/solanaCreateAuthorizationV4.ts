import { apiFetch } from "@/lib/apiBase";
import type { DraftActionAuth } from "@/lib/draftAuth";

export const SOLANA_CREATE_AUTH_SCHEMA_VERSION = 5 as const;
export const SOLANA_CREATE_AUTH_DOMAIN = "MEMEWARZONE_SOLANA_CREATE_V5" as const;

export type SolanaCreateMode = "draft_deploy_now" | "countdown" | "direct_create";

export type SolanaV4CreateArgs = {
  campaignId: number[];
  metadataHash: number[];
  clusterHash: number[];
  tickerHash: number[];
  reservationIdHash: number[];
  reservationVersion: string;
  launchAt: string;
  graduationTargetUsdMicros: string;
  deadline: string;
  nonce: number[];
};

export type SolanaV4CreateAccounts = {
  creator: string;
  globalConfig: string;
  generationConfig: string;
  creatorProfile: string;
  riskProfile: string;
  clusterProfile: string;
  campaign: string;
  mint: string;
  tokenVault: string;
  solVault: string;
  createAuthorization: string;
  instructions: string;
  tokenProgram: string;
  systemProgram: string;
};

export type SolanaV4Generation = {
  generationIdHex: string;
  programId: string;
  configPda: string;
  startSlot: string;
  clusterKind: number;
  allowedGraduationTierMask: number;
  economicsVersion: number;
  curveKind: number;
  tokenTotalSupply: string;
  tokenDecimals: number;
  curveSupplyBps: number;
  liquidityTokenBps: number;
  basePriceLamports: string;
  priceSlopeLamports: string;
  buyFeeBps: number;
  sellFeeBps: number;
  finalizeFeeBps: number;
  creatorPostFinalizeBps: number;
  liquidityPostFinalizeBps: number;
  dexAdapter: number;
  tradeRouteProfileHex: string;
  finalizeRouteProfileHex: string;
  treasuryProfileHex: string;
  dexProfileHex: string;
  oracleProfileHex: string;
  manifestHashHex: string;
  routeAuthorizationRequired: boolean;
  authorizedTradingRequired: boolean;
};

export type SolanaV4CreateAuthorization = {
  signedMessageMode: "sha256_canonical_payload";
  signedMessageLengthBytes: 32;
  canonicalPayloadLengthBytes: number;
  digestHex: string;
  digestBase64: string;
  signatureBase64: string;
  routeSigner: string;
  deadline: string;
  validUntil: string;
  ed25519InstructionMustImmediatelyPrecedeCreate: true;
  railwayTransactionCosignerRequired: false;
};

export type SolanaV4CreateAuthorizationResponse = {
  schemaVersion: 4;
  mode: SolanaCreateMode;
  cluster: string;
  programId: string;
  /** Null when alreadyOnChain recovery — no create tx to build. */
  createArgs: SolanaV4CreateArgs | null;
  accounts: SolanaV4CreateAccounts;
  /** Null when alreadyOnChain recovery. */
  authorization: SolanaV4CreateAuthorization | null;
  generation: SolanaV4Generation;
  deploymentEvidence: {
    idlSha256: string;
    programBinarySha256: string;
    generationManifestHash: string;
  };
  metadata: {
    canonical: Record<string, unknown>;
    canonicalJsonSha256: string;
  };
  tickerReservation: Record<string, unknown>;
  preflight: Record<string, unknown>;
  transaction: null;
  transactionPolicy: string;
  /** Direct only: opaque short-lived token used for post-transaction registry finalization. */
  finalizeToken?: string;
  /** Set when deterministic campaign PDA already exists from a prior create. */
  alreadyOnChain?: boolean;
  /** Server already wrote campaign_address / reservation LIVE — client may skip mark-deploy. */
  draftFinalized?: boolean;
  /** campaigns table upsert succeeded during recovery. */
  registryUpserted?: boolean;
  registryError?: string | null;
  /** Preferred post-deploy route, e.g. /token/<mint>?chainId=101 */
  tokenPath?: string;
  existingDeployment?: {
    campaignAddress: string;
    mintAddress: string;
    recovered: boolean;
    draftStatus?: string;
    registryUpserted?: boolean;
    tokenPath?: string;
  };
};

export type SolanaV4AuthorizationRequest = {
  draftId: string;
  auth: DraftActionAuth;
  graduationTargetUsdMicros: string | number | bigint;
  launchAt?: string | number | bigint | null;
};

function byteArray(value: unknown, label: string, expectedLength: number) {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw new Error(`${label} must contain exactly ${expectedLength} bytes.`);
  }
  for (const byte of value) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new Error(`${label} contains a non-byte value.`);
    }
  }
}

function decodeBase64Length(value: unknown, label: string, expectedLength: number) {
  const encoded = String(value || "");
  if (!encoded) throw new Error(`${label} is missing.`);
  try {
    const binary = atob(encoded);
    if (binary.length !== expectedLength) {
      throw new Error(`${label} must decode to ${expectedLength} bytes.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("must decode")) throw error;
    throw new Error(`${label} is not valid base64.`);
  }
}

export function assertSolanaV4AuthorizationResponse(value: unknown): asserts value is SolanaV4CreateAuthorizationResponse {
  const response = value as Partial<SolanaV4CreateAuthorizationResponse> | null;
  if (!response || response.schemaVersion !== SOLANA_CREATE_AUTH_SCHEMA_VERSION) {
    throw new Error("Railway returned an unsupported Solana create-authorization schema.");
  }
  if (response.transaction !== null) {
    throw new Error("Railway must never return or co-sign a Solana creator transaction.");
  }
  if (!response.authorization || response.authorization.signedMessageMode !== "sha256_canonical_payload") {
    throw new Error("Railway returned an unsupported Solana signed-message mode.");
  }
  if (response.authorization.signedMessageLengthBytes !== 32) {
    throw new Error("Solana V4 authorization must sign exactly 32 digest bytes.");
  }
  if (response.authorization.railwayTransactionCosignerRequired !== false) {
    throw new Error("Railway transaction co-signing is forbidden.");
  }
  if (response.authorization.ed25519InstructionMustImmediatelyPrecedeCreate !== true) {
    throw new Error("Solana V4 authorization must require adjacent Ed25519 verification.");
  }
  if (!/^[0-9a-f]{64}$/.test(String(response.authorization.digestHex || ""))) {
    throw new Error("Solana V4 authorization digest must be 32-byte lowercase hexadecimal.");
  }
  decodeBase64Length(response.authorization.digestBase64, "authorization.digestBase64", 32);
  decodeBase64Length(response.authorization.signatureBase64, "authorization.signatureBase64", 64);

  const args = response.createArgs;
  if (!args) throw new Error("Solana V4 create arguments are missing.");
  byteArray(args.campaignId, "createArgs.campaignId", 32);
  byteArray(args.metadataHash, "createArgs.metadataHash", 32);
  byteArray(args.clusterHash, "createArgs.clusterHash", 32);
  byteArray(args.tickerHash, "createArgs.tickerHash", 32);
  byteArray(args.reservationIdHash, "createArgs.reservationIdHash", 32);
  byteArray(args.nonce, "createArgs.nonce", 32);

  const accounts = response.accounts;
  if (!accounts) throw new Error("Solana V4 account map is missing.");
  for (const [name, address] of Object.entries(accounts)) {
    if (!String(address || "").trim()) throw new Error(`Solana V4 account ${name} is missing.`);
  }
}

export async function requestSolanaCreateAuthorizationV4(
  input: SolanaV4AuthorizationRequest,
): Promise<SolanaV4CreateAuthorizationResponse> {
  const draftId = String(input.draftId || "").trim();
  if (!draftId) throw new Error("Draft id is required for Solana deployment authorization.");

  const launchAt = input.launchAt == null || input.launchAt === "" ? "0" : String(input.launchAt);
  const response = await apiFetch(`/api/drafts/${encodeURIComponent(draftId)}/deploy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operation: "authorize_solana_v4",
      auth: input.auth,
      graduationTargetUsdMicros: String(input.graduationTargetUsdMicros),
      launchAt,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = String(payload?.error || payload?.message || `Solana authorization failed (${response.status}).`);
    const code = payload?.code ? String(payload.code) : "";
    const err = new Error(code ? `${message} [${code}]` : message) as Error & { code?: string; status?: number };
    err.code = code || undefined;
    err.status = response.status;
    throw err;
  }
  // Recovery responses skip createArgs/authorization — assert only when creating.
  if (payload?.alreadyOnChain || payload?.existingDeployment) {
    if (!payload?.accounts?.campaign || !payload?.accounts?.mint) {
      throw new Error("Solana recovery response is missing campaign/mint accounts.");
    }
    return payload as SolanaV4CreateAuthorizationResponse;
  }
  assertSolanaV4AuthorizationResponse(payload);
  return payload;
}

function normalizeIdlName(value: unknown) {
  return String(value || "").replace(/_/g, "").toLowerCase();
}

export function assertGeneratedSolanaV4Idl(idl: unknown) {
  const document = idl as {
    instructions?: Array<{ name?: string; accounts?: Array<{ name?: string }>; args?: Array<{ name?: string }> }>;
  } | null;
  const instruction = document?.instructions?.find(
    (item) => normalizeIdlName(item.name) === "createcampaign",
  );
  if (!instruction) throw new Error("Generated Anchor IDL does not contain createCampaign.");

  const accountNames = new Set((instruction.accounts || []).map((item) => normalizeIdlName(item.name)));
  const requiredAccounts = [
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
    "tokenProgram",
    "systemProgram",
  ];
  for (const account of requiredAccounts) {
    if (!accountNames.has(normalizeIdlName(account))) {
      throw new Error(`Generated Anchor IDL createCampaign is missing account ${account}.`);
    }
  }

  const args = new Set((instruction.args || []).map((item) => normalizeIdlName(item.name)));
  if (!args.has("args")) {
    throw new Error("Generated Anchor IDL createCampaign must expose the V4 args struct.");
  }
  return instruction;
}
