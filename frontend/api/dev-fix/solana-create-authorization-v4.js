import crypto from "node:crypto";

import { badMethod, isSolanaChain, json, readJson } from "../../server/http.js";
import { requireDraftActionAuth } from "./draft-auth.js";
import {
  TICKER_RESERVATION_STATUS,
  TickerReservationError,
  canonicalClusterForChain,
  loadTickerReservationByDraft,
  markTickerReservationDeployed,
  refreshExpiredTickerReservations,
  withTickerReservationTransaction,
} from "./ticker-reservation-service.js";
import { upsertCampaignFromDraft } from "./campaign-registry.js";
import { getSolanaChainUnixTime } from "./solana-chain-unix-time.js";
import {
  CREATE_AUTH_SCHEMA_VERSION,
  SYSVAR_INSTRUCTIONS_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  buildCreateAuthorizationPayload,
  bytes32,
  createAuthorizationDigest,
  createEd25519Signer,
  decodeClusterProfile,
  decodeCreatorProfile,
  decodeGenerationConfig,
  decodeGlobalConfig,
  decodeRiskProfile,
  encodeBase58,
  findProgramAddressSync,
  integerToBytes32,
  nonZeroBytes32,
  publicKeyBytes,
  publicKeyString,
  sha256,
  sha256Hex,
  toBigInt,
} from "./solana-v4-primitives.js";

const MIN_SCHEDULE_SECONDS = 5 * 60;
const MAX_SCHEDULE_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_AUTH_TTL_SECONDS = 10 * 60;
const MAX_AUTH_TTL_SECONDS = 60 * 60;
const EMPTY_BYTES_32 = Buffer.alloc(32);
const DEFAULT_NEW_CREATOR_TIER = 1;
const DEFAULT_NEW_CREATOR_TRUST_SCORE = 0;
const DEFAULT_NEW_CREATOR_MAX_LIVE_BONDING = 3;
const DEFAULT_NEW_CREATOR_COOLDOWN_SECONDS = 24 * 60 * 60;
const DEFAULT_NEW_CREATOR_BUY_LOCK_SECONDS = 24 * 60 * 60;
const DEFAULT_NEW_CREATOR_BUY_CAP_BPS = 1_000;
const PLACEHOLDER_PROGRAM_IDS = new Set([
  SYSTEM_PROGRAM_ID,
  "Fg6PaFpoGXkYsidMpWxTWqjRZ6LkZXoC3XgXvAqUixG",
]);
const ALLOWED_DRAFT_STATUSES = new Set([
  "promotion_published",
  "ready_to_launch",
  "scheduled",
]);
const TARGET_MASKS = new Map([
  [6_000_000n, 1 << 0],
  [15_000_000_000n, 1 << 1],
  [30_000_000_000n, 1 << 2],
  [50_000_000_000n, 1 << 3],
]);
const GENERATION_MANIFEST_ENV = "SOLANA_GENERATION_MANIFEST_HASH";

class SolanaCreateAuthorizationError extends Error {
  constructor(message, { code = "SOLANA_CREATE_AUTHORIZATION_ERROR", httpStatus = 409, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SolanaCreateAuthorizationError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function methodAllowed(req, res, allowed) {
  if (allowed.includes(req.method)) return true;
  badMethod(res);
  return false;
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new SolanaCreateAuthorizationError(`${name} is not configured.`, {
      code: "SOLANA_CREATE_CONFIGURATION_INCOMPLETE",
      httpStatus: 503,
    });
  }
  return value;
}

function hashEnv(name) {
  const value = requiredEnv(name).replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new SolanaCreateAuthorizationError(`${name} must be a lowercase 32-byte SHA-256 value.`, {
      code: "SOLANA_CREATE_CONFIGURATION_INVALID",
      httpStatus: 503,
    });
  }
  return value;
}

function parsePositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return Math.min(number, maximum);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function hex32(value) {
  return bytes32(value).toString("hex");
}

function bufferArray(value) {
  return Array.from(Buffer.from(value));
}

function samePublicKey(left, right) {
  try {
    return publicKeyBytes(left).equals(publicKeyBytes(right));
  } catch {
    return false;
  }
}

function sameBytes32(left, right) {
  try {
    return bytes32(left).equals(bytes32(right));
  } catch {
    return false;
  }
}

function defaultCreatorProfile(creator, bump) {
  return {
    wallet: publicKeyString(creator, "creator"),
    tier: DEFAULT_NEW_CREATOR_TIER,
    trustScore: DEFAULT_NEW_CREATOR_TRUST_SCORE,
    liveBondingCount: 0,
    lastLaunchTimestamp: 0n,
    totalLaunches: 0n,
    successfulGraduations: 0n,
    restricted: false,
    manualReviewRequired: false,
    creatorBuyCapBps: DEFAULT_NEW_CREATOR_BUY_CAP_BPS,
    maxLiveBondingCount: DEFAULT_NEW_CREATOR_MAX_LIVE_BONDING,
    cooldownSeconds: DEFAULT_NEW_CREATOR_COOLDOWN_SECONDS,
    creatorBuyLockSeconds: DEFAULT_NEW_CREATOR_BUY_LOCK_SECONDS,
    bump,
  };
}

function defaultRiskProfile(creator, bump) {
  return {
    wallet: publicKeyString(creator, "creator"),
    riskLevel: 0,
    restricted: false,
    clusterId: Buffer.from(EMPTY_BYTES_32),
    manualReviewRequired: false,
    bump,
  };
}

function normalizeDraftMetadata(row, reservation) {
  return {
    schemaVersion: 1,
    draftId: String(row.id),
    chainId: Number(row.chain_id),
    cluster: String(reservation.cluster),
    name: String(row.name || "").trim(),
    ticker: String(reservation.normalizedTicker || row.ticker || "").trim().toUpperCase(),
    description: String(row.description || "").trim(),
    logoUrl: String(row.logo_url || "").trim(),
    websiteUrl: String(row.website_url || "").trim(),
    xUrl: String(row.x_url || "").trim(),
    otherUrl: String(row.other_url || "").trim(),
  };
}

function deriveCampaignId({ draftId, reservationIdHash, generationId, programId }) {
  return sha256(
    Buffer.from("MEMEWARZONE_SOLANA_CAMPAIGN_ID_V1\0", "utf8"),
    Buffer.from(String(draftId), "utf8"),
    bytes32(reservationIdHash, "reservationIdHash"),
    bytes32(generationId, "generationId"),
    publicKeyBytes(programId, "programId"),
  );
}

function graduationTargetMask(target) {
  return TARGET_MASKS.get(target) || 0;
}

export function validateGraduationTarget(generation, target) {
  const mask = graduationTargetMask(target);
  if (!mask || (generation.allowedGraduationTierMask & mask) === 0) {
    throw new SolanaCreateAuthorizationError("Graduation target is not enabled by the active Solana generation.", {
      code: "SOLANA_GRADUATION_TARGET_NOT_ALLOWED",
      httpStatus: 400,
    });
  }

  if (generation.clusterKind === 1 && target !== 6_000_000n) {
    throw new SolanaCreateAuthorizationError("The active devnet generation only authorizes the 6 USD test target.", {
      code: "SOLANA_DEVNET_TARGET_REQUIRED",
      httpStatus: 400,
    });
  }
  if (generation.clusterKind === 2 && target === 6_000_000n) {
    throw new SolanaCreateAuthorizationError("The 6 USD test target is forbidden on mainnet-beta.", {
      code: "SOLANA_MAINNET_TEST_TARGET_FORBIDDEN",
      httpStatus: 400,
    });
  }
}

function expectedClusterKind(cluster) {
  if (cluster === "solana-devnet") return 1;
  if (cluster === "solana-mainnet-beta") return 2;
  throw new SolanaCreateAuthorizationError(`Solana cluster ${cluster} is not supported by the current program.`, {
    code: "SOLANA_CLUSTER_NOT_SUPPORTED",
    httpStatus: 503,
  });
}

function validateLaunchAt(launchAt, chainNow) {
  if (launchAt === 0n) return;
  const minimum = BigInt(chainNow + MIN_SCHEDULE_SECONDS);
  const maximum = BigInt(chainNow + MAX_SCHEDULE_SECONDS);
  if (launchAt < minimum || launchAt > maximum) {
    throw new SolanaCreateAuthorizationError("Scheduled Solana launch must be at least 5 minutes and no more than 30 days away.", {
      code: "SOLANA_INVALID_LAUNCH_TIME",
      httpStatus: 400,
    });
  }
}

async function getPool() {
  if (!String(process.env.DATABASE_URL || "").trim()) return null;
  try {
    const mod = await import("../../server/db.js");
    return mod.pool || null;
  } catch (error) {
    console.warn("[solana-v4-create] database unavailable", error?.message || error);
    return null;
  }
}

async function rpcCall(rpcUrl, method, params = []) {
  const timeoutMs = parsePositiveInteger(process.env.SOLANA_RPC_TIMEOUT_MS, 12_000, 30_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`RPC ${method} returned HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (payload?.error) {
      throw new Error(`RPC ${method} failed: ${payload.error.message || JSON.stringify(payload.error)}`);
    }
    return payload?.result;
  } catch (error) {
    throw new SolanaCreateAuthorizationError(`Solana RPC ${method} failed.`, {
      code: "SOLANA_RPC_UNAVAILABLE",
      httpStatus: 503,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function getChainUnixTime(rpcUrl) {
  try {
    return await getSolanaChainUnixTime(rpcUrl);
  } catch (error) {
    throw new SolanaCreateAuthorizationError(error instanceof Error ? error.message : String(error), {
      code: "SOLANA_CHAIN_TIME_UNAVAILABLE",
      httpStatus: 503,
      cause: error,
    });
  }
}

async function getMultipleAccounts(rpcUrl, addresses) {
  const result = await rpcCall(rpcUrl, "getMultipleAccounts", [
    addresses,
    { commitment: "confirmed", encoding: "base64" },
  ]);
  if (!result || !Array.isArray(result.value) || result.value.length !== addresses.length) {
    throw new SolanaCreateAuthorizationError("Solana RPC returned an invalid account response.", {
      code: "SOLANA_ACCOUNT_RESPONSE_INVALID",
      httpStatus: 503,
    });
  }
  return result.value;
}

function decodeOwnedAccount(info, address, programId, decoder, label) {
  if (!info) {
    throw new SolanaCreateAuthorizationError(`${label} account ${address} does not exist.`, {
      code: "SOLANA_REQUIRED_ACCOUNT_MISSING",
      httpStatus: 409,
    });
  }
  if (!samePublicKey(info.owner, programId)) {
    throw new SolanaCreateAuthorizationError(`${label} is not owned by the configured MemeWarzone program.`, {
      code: "SOLANA_ACCOUNT_OWNER_MISMATCH",
      httpStatus: 409,
    });
  }
  const encoded = Array.isArray(info.data) ? info.data[0] : null;
  if (!encoded) {
    throw new SolanaCreateAuthorizationError(`${label} has no base64 account data.`, {
      code: "SOLANA_ACCOUNT_DATA_INVALID",
      httpStatus: 409,
    });
  }
  try {
    return decoder(Buffer.from(encoded, "base64"));
  } catch (error) {
    throw new SolanaCreateAuthorizationError(`${label} account data could not be decoded.`, {
      code: "SOLANA_ACCOUNT_DATA_INVALID",
      httpStatus: 409,
      cause: error,
    });
  }
}

function validateProgramConfiguration(programId) {
  const canonical = publicKeyString(programId, "SOLANA_LAUNCHPAD_PROGRAM_ID");
  if (PLACEHOLDER_PROGRAM_IDS.has(canonical) && !isTruthy(process.env.SOLANA_ALLOW_PLACEHOLDER_PROGRAM_ID)) {
    throw new SolanaCreateAuthorizationError("The configured Solana program ID is a placeholder.", {
      code: "SOLANA_PROGRAM_NOT_DEPLOYED",
      httpStatus: 503,
    });
  }
  return canonical;
}

export function enforceCreatorLaunchLimits(creatorProfile, chainNow) {
  if (creatorProfile.restricted || creatorProfile.manualReviewRequired) {
    throw new SolanaCreateAuthorizationError("Creator is restricted or requires manual review on Solana.", {
      code: "SOLANA_CREATOR_RESTRICTED",
      httpStatus: 403,
    });
  }
  if (creatorProfile.liveBondingCount >= creatorProfile.maxLiveBondingCount) {
    throw new SolanaCreateAuthorizationError("Creator has reached the active Solana campaign limit.", {
      code: "SOLANA_CREATOR_LAUNCH_LIMIT",
      httpStatus: 403,
    });
  }
  if (creatorProfile.lastLaunchTimestamp > 0n) {
    const nextAllowed = creatorProfile.lastLaunchTimestamp + BigInt(creatorProfile.cooldownSeconds);
    if (BigInt(chainNow) < nextAllowed) {
      const remainingSec = Number(nextAllowed - BigInt(chainNow));
      const hours = Math.floor(remainingSec / 3600);
      const mins = Math.floor((remainingSec % 3600) / 60);
      const nextIso = new Date(Number(nextAllowed) * 1000).toISOString();
      throw new SolanaCreateAuthorizationError(
        `Creator Solana launch cooldown is still active (${hours}h ${mins}m left; next allowed ${nextIso}). ` +
          `If a previous create already landed on-chain for this draft, use recovery (alreadyOnChain) instead of creating again.`,
        {
          code: "SOLANA_CREATOR_COOLDOWN",
          httpStatus: 403,
        },
      );
    }
  }
}

function validateOnchainState({
  global,
  generation,
  generationConfig,
  creatorProfile,
  riskProfile,
  clusterProfile,
  creator,
  programId,
  cluster,
  signer,
  chainNow,
  skipCreatorLaunchLimits = false,
}) {
  if (global.paused || global.createPaused) {
    throw new SolanaCreateAuthorizationError("Solana campaign creation is paused on-chain.", {
      code: "SOLANA_CREATE_PAUSED",
      httpStatus: 503,
    });
  }
  if (!global.routeAuthorizationRequired || !global.authorizedTradingRequired || !global.securityDefaultsLocked) {
    throw new SolanaCreateAuthorizationError("Solana on-chain security defaults are not locked.", {
      code: "SOLANA_SECURITY_DEFAULTS_NOT_LOCKED",
      httpStatus: 503,
    });
  }
  if (!samePublicKey(global.routeSigner, signer.publicKey)) {
    throw new SolanaCreateAuthorizationError("Configured Railway route signer does not match GlobalConfig.route_signer.", {
      code: "SOLANA_ROUTE_SIGNER_MISMATCH",
      httpStatus: 503,
    });
  }
  if (!sameBytes32(global.activeGenerationId, generation.generationId)) {
    throw new SolanaCreateAuthorizationError("GenerationConfig is not the active creation generation.", {
      code: "SOLANA_GENERATION_INACTIVE",
      httpStatus: 503,
    });
  }
  if (!samePublicKey(generation.programId, programId) || !samePublicKey(generation.configPda, generationConfig)) {
    throw new SolanaCreateAuthorizationError("GenerationConfig program or self-address binding is invalid.", {
      code: "SOLANA_GENERATION_BINDING_INVALID",
      httpStatus: 503,
    });
  }
  if (!generation.activeCreation || !generation.supportEnabled) {
    throw new SolanaCreateAuthorizationError("The active Solana generation is not enabled for campaign creation.", {
      code: "SOLANA_GENERATION_INACTIVE",
      httpStatus: 503,
    });
  }
  if (!generation.routeAuthorizationRequired || !generation.authorizedTradingRequired) {
    throw new SolanaCreateAuthorizationError("Generation security commitments are weaker than required.", {
      code: "SOLANA_GENERATION_SECURITY_INVALID",
      httpStatus: 503,
    });
  }
  if (generation.clusterKind !== expectedClusterKind(cluster)) {
    throw new SolanaCreateAuthorizationError("Configured deployment cluster does not match the active generation.", {
      code: "SOLANA_GENERATION_CLUSTER_MISMATCH",
      httpStatus: 503,
    });
  }
  if (!samePublicKey(creatorProfile.wallet, creator)) {
    throw new SolanaCreateAuthorizationError("CreatorProfile is not bound to the draft creator.", {
      code: "SOLANA_CREATOR_PROFILE_INVALID",
    });
  }
  // Launch limits (cooldown / live count) are enforced later, after we know whether this
  // draft's deterministic campaign PDA already exists (recovery path skips them).
  if (!skipCreatorLaunchLimits) {
    enforceCreatorLaunchLimits(creatorProfile, chainNow);
  }
  if (!samePublicKey(riskProfile.wallet, creator)) {
    throw new SolanaCreateAuthorizationError("Creator RiskProfile is not bound to the draft creator.", {
      code: "SOLANA_RISK_PROFILE_INVALID",
      httpStatus: 403,
    });
  }
  if (riskProfile.restricted || riskProfile.manualReviewRequired) {
    throw new SolanaCreateAuthorizationError("Creator wallet is restricted or requires manual review on Solana.", {
      code: "SOLANA_WALLET_RESTRICTED",
      httpStatus: 403,
    });
  }
  const riskClusterId = bytes32(riskProfile.clusterId, "RiskProfile.clusterId");
  if (!riskClusterId.equals(EMPTY_BYTES_32)) {
    if (!clusterProfile || !sameBytes32(clusterProfile.clusterId, riskClusterId) || clusterProfile.restricted) {
      throw new SolanaCreateAuthorizationError("Creator risk cluster is invalid or restricted.", {
        code: "SOLANA_CLUSTER_RESTRICTED",
        httpStatus: 403,
      });
    }
  }
}

export async function loadOnchainPolicy({ rpcUrl, programId, creator, cluster, signer, skipCreatorLaunchLimits = false }) {
  const globalConfigPda = findProgramAddressSync([Buffer.from("global", "utf8")], programId);
  const [globalInfo] = await getMultipleAccounts(rpcUrl, [globalConfigPda.publicKey]);
  const global = decodeOwnedAccount(globalInfo, globalConfigPda.publicKey, programId, decodeGlobalConfig, "GlobalConfig");
  const activeGenerationId = nonZeroBytes32(global.activeGenerationId, "GlobalConfig.activeGenerationId");

  const generationConfigPda = findProgramAddressSync(
    [Buffer.from("generation", "utf8"), activeGenerationId],
    programId,
  );
  const creatorBytes = publicKeyBytes(creator, "creator");
  const creatorProfilePda = findProgramAddressSync([Buffer.from("creator", "utf8"), creatorBytes], programId);
  const riskProfilePda = findProgramAddressSync([Buffer.from("risk", "utf8"), creatorBytes], programId);
  const [generationInfo, creatorInfo, riskInfo] = await getMultipleAccounts(rpcUrl, [
    generationConfigPda.publicKey,
    creatorProfilePda.publicKey,
    riskProfilePda.publicKey,
  ]);
  const generation = decodeOwnedAccount(
    generationInfo,
    generationConfigPda.publicKey,
    programId,
    decodeGenerationConfig,
    "GenerationConfig",
  );

  // BNB parity: CreatorRegistry maps Unknown -> NewCreator and RiskRegistry permits an
  // unknown/unclustered wallet unless an explicit restriction exists. Use the same
  // conservative virtual defaults for authorization; the program materializes the
  // CreatorProfile atomically on the first successful create.
  const creatorProfileImplicitDefault = !creatorInfo;
  const riskProfileImplicitDefault = !riskInfo;
  const creatorProfile = creatorInfo
    ? decodeOwnedAccount(creatorInfo, creatorProfilePda.publicKey, programId, decodeCreatorProfile, "CreatorProfile")
    : defaultCreatorProfile(creator, creatorProfilePda.bump);
  const riskProfile = riskInfo
    ? decodeOwnedAccount(riskInfo, riskProfilePda.publicKey, programId, decodeRiskProfile, "RiskProfile")
    : defaultRiskProfile(creator, riskProfilePda.bump);

  const riskClusterId = bytes32(riskProfile.clusterId, "RiskProfile.clusterId");
  const clusterProfilePda = findProgramAddressSync(
    [Buffer.from("cluster", "utf8"), riskClusterId],
    programId,
  );
  let clusterProfile = null;
  if (!riskClusterId.equals(EMPTY_BYTES_32)) {
    const [clusterInfo] = await getMultipleAccounts(rpcUrl, [clusterProfilePda.publicKey]);
    clusterProfile = decodeOwnedAccount(
      clusterInfo,
      clusterProfilePda.publicKey,
      programId,
      decodeClusterProfile,
      "ClusterProfile",
    );
  }
  const chainNow = await getChainUnixTime(rpcUrl);

  validateOnchainState({
    global,
    generation,
    generationConfig: generationConfigPda.publicKey,
    creatorProfile,
    riskProfile,
    clusterProfile,
    creator,
    programId,
    cluster,
    signer,
    chainNow,
    skipCreatorLaunchLimits,
  });

  return {
    chainNow,
    global,
    generation,
    creatorProfile,
    riskProfile,
    clusterProfile,
    creatorProfileImplicitDefault,
    riskProfileImplicitDefault,
    accounts: {
      globalConfig: globalConfigPda.publicKey,
      generationConfig: generationConfigPda.publicKey,
      creatorProfile: creatorProfilePda.publicKey,
      riskProfile: riskProfilePda.publicKey,
      clusterProfile: clusterProfilePda.publicKey,
    },
  };
}

export function validateDeploymentEvidence(generation) {
  const idlSha256 = hashEnv("SOLANA_LAUNCHPAD_IDL_SHA256");
  const programBinarySha256 = hashEnv("SOLANA_LAUNCHPAD_PROGRAM_SHA256");
  const expectedManifest = String(process.env[GENERATION_MANIFEST_ENV] || "").trim();
  if (expectedManifest && !sameBytes32(expectedManifest, generation.manifestHash)) {
    const onChain = hex32(generation.manifestHash);
    const configured = String(expectedManifest || "").replace(/^0x/i, "").toLowerCase();
    throw new SolanaCreateAuthorizationError(
      `Active generation manifest hash does not match Railway configuration. Set SOLANA_GENERATION_MANIFEST_HASH=${onChain} (Railway has ${configured.slice(0, 12)}…). After changing generation on-chain, Railway must be updated.`,
      {
        code: "SOLANA_GENERATION_MANIFEST_MISMATCH",
        httpStatus: 503,
      },
    );
  }
  return {
    idlSha256,
    programBinarySha256,
    generationManifestHash: hex32(generation.manifestHash),
  };
}

async function loadDraft(pool, draftId) {
  const result = await pool.query(
    `select id, chain_id, creator_wallet, name, ticker, description, category, logo_url,
            website_url, x_url, other_url, slug, status, visibility, campaign_address,
            token_address, deploy_tx_hash, scheduled_launch_at, created_at, updated_at
       from public.campaign_drafts
      where id::text = $1
      limit 1`,
    [draftId],
  );
  return result.rows[0] || null;
}

function validateDraft(row) {
  if (!row) {
    throw new SolanaCreateAuthorizationError("Draft not found.", {
      code: "DRAFT_NOT_FOUND",
      httpStatus: 404,
    });
  }
  if (!isSolanaChain(row.chain_id)) {
    throw new SolanaCreateAuthorizationError("This endpoint only authorizes Solana drafts.", {
      code: "NOT_A_SOLANA_DRAFT",
      httpStatus: 400,
    });
  }
  // Already-linked drafts are recovered/finalized in the main handler (not a hard 409).
  const alreadyLinked = Boolean(row.campaign_address);
  if (!alreadyLinked && !ALLOWED_DRAFT_STATUSES.has(String(row.status))) {
    throw new SolanaCreateAuthorizationError("Publish the Prepare Mode promotion before authorizing Solana deployment.", {
      code: "SOLANA_DRAFT_NOT_READY",
    });
  }
  if (!alreadyLinked && !String(row.logo_url || "").trim()) {
    throw new SolanaCreateAuthorizationError("Draft requires a saved logo before Solana deployment.", {
      code: "SOLANA_DRAFT_LOGO_REQUIRED",
    });
  }
  publicKeyString(row.creator_wallet, "draft creator wallet");
}

function deriveCampaignAccounts({ draftId, reservationIdHash, generationId, programId, creator, nonce }) {
  const campaignId = deriveCampaignId({
    draftId,
    reservationIdHash,
    generationId,
    programId,
  });
  const campaign = findProgramAddressSync([Buffer.from("campaign", "utf8"), campaignId], programId);
  const mint = findProgramAddressSync([Buffer.from("campaign-mint", "utf8"), campaignId], programId);
  const tokenVault = findProgramAddressSync([Buffer.from("token-vault", "utf8"), campaignId], programId);
  const solVault = findProgramAddressSync([Buffer.from("sol-vault", "utf8"), campaignId], programId);
  const createAuthorization = findProgramAddressSync(
    [Buffer.from("create-auth", "utf8"), publicKeyBytes(creator), nonce || Buffer.alloc(32)],
    programId,
  );
  return { campaignId, campaign, mint, tokenVault, solVault, createAuthorization };
}

/**
 * When a prior create already landed, link draft + reservation and return recovery payload.
 * Never ask the wallet to createCampaign again (deterministic PDAs → InvalidCampaign).
 */
async function finalizeExistingOnChainDeployment({
  pool,
  draft,
  cluster,
  programId,
  onchain,
  deploymentEvidence,
  campaignAddress,
  mintAddress,
  reservation,
  launchAt = 0n,
  tokenVault: tokenVaultHint = null,
  solVault: solVaultHint = null,
  campaignId: campaignIdHint = null,
}) {
  const draftId = String(draft.id);
  const scheduledLaunchAt =
    launchAt && launchAt !== 0n ? Number(launchAt) : null;
  const isScheduled =
    Number.isInteger(scheduledLaunchAt) && scheduledLaunchAt > Math.floor(Date.now() / 1000);

  // Resolve vaults / campaignId before the DB transaction so we can persist them.
  let resolvedCampaignId = campaignIdHint ? Buffer.from(bytes32(campaignIdHint)) : null;
  let resolvedTokenVault = tokenVaultHint ? publicKeyString(tokenVaultHint) : null;
  let resolvedSolVault = solVaultHint ? publicKeyString(solVaultHint) : null;
  if (reservation?.reservationIdHash) {
    try {
      const pdas = deriveCampaignAccounts({
        draftId,
        reservationIdHash: nonZeroBytes32(reservation.reservationIdHash, "reservationIdHash"),
        generationId: onchain.generation.generationId,
        programId,
        creator: draft.creator_wallet,
      });
      if (!resolvedCampaignId) resolvedCampaignId = Buffer.from(pdas.campaignId);
      if (!resolvedTokenVault) resolvedTokenVault = pdas.tokenVault.publicKey;
      if (!resolvedSolVault) resolvedSolVault = pdas.solVault.publicKey;
    } catch {
      // keep hints / fallbacks
    }
  }

  const finalized = await withTickerReservationTransaction(pool, async (db) => {
    const updated = await db.query(
      `update public.campaign_drafts
          set status = case
                when $5::bigint is not null then 'scheduled'
                when status in ('deployed', 'scheduled', 'live') then status
                else 'deployed'
              end,
              visibility = 'public',
              campaign_address = $2,
              token_address = coalesce(nullif($3, ''), token_address, $3),
              deploy_tx_hash = coalesce(nullif(deploy_tx_hash, ''), $4),
              scheduled_launch_at = case
                when $5::bigint is not null then to_timestamp($5)
                else scheduled_launch_at
              end,
              deployed_at = coalesce(deployed_at, now()),
              updated_at = now()
        where id::text = $1
        returning id, status, campaign_address, token_address, deploy_tx_hash`,
      [
        draftId,
        campaignAddress,
        mintAddress || null,
        "already-on-chain",
        isScheduled ? scheduledLaunchAt : null,
      ],
    );
    let tickerReservation = reservation || null;
    try {
      tickerReservation = await markTickerReservationDeployed(db, {
        draftId,
        creatorWallet: draft.creator_wallet,
        campaignAddress,
        mint: mintAddress || null,
        deploymentSignature: "already-on-chain",
        scheduledLaunchAt: isScheduled ? scheduledLaunchAt : null,
        programId,
        generationId: hex32(onchain.generation.generationId),
      });
    } catch (error) {
      // Reservation may already be LIVE/ARMED, missing, or released — still finalize the draft.
      if (!(error instanceof TickerReservationError)) throw error;
      console.warn(
        "[solana-v4-create] recovery reservation mark:",
        error.code,
        error.message,
      );
      tickerReservation = await loadTickerReservationByDraft(db, draftId).catch(() => reservation || null);
    }
    const registry = await upsertCampaignFromDraft(db, {
      chainId: Number(draft.chain_id),
      campaignAddress,
      tokenAddress: mintAddress || null,
      creatorWallet: draft.creator_wallet,
      name: draft.name,
      symbol: draft.ticker,
      logoUrl: draft.logo_url,
      deployTxHash: "already-on-chain",
      factoryAddress: programId,
      programId,
      tokenVault: resolvedTokenVault,
      solVault: resolvedSolVault,
      campaignId: resolvedCampaignId,
    });
    if (!registry?.ok) {
      console.error("[solana-v4-create] campaigns registry upsert failed during recovery", registry);
    }
    return {
      draftRow: updated.rows[0] || null,
      tickerReservation,
      registry,
    };
  });

  const accounts = {
    creator: publicKeyString(draft.creator_wallet),
    globalConfig: onchain.accounts.globalConfig,
    generationConfig: onchain.accounts.generationConfig,
    creatorProfile: onchain.accounts.creatorProfile,
    riskProfile: onchain.accounts.riskProfile,
    clusterProfile: onchain.accounts.clusterProfile,
    campaign: campaignAddress,
    mint: mintAddress,
    tokenVault: resolvedTokenVault || campaignAddress,
    solVault: resolvedSolVault || campaignAddress,
    createAuthorization: onchain.accounts.creatorProfile,
    instructions: SYSVAR_INSTRUCTIONS_ID,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SYSTEM_PROGRAM_ID,
  };

  // Prefer accurate vault PDAs when we have reservation hashes.
  if (reservation?.reservationIdHash) {
    try {
      const pdas = deriveCampaignAccounts({
        draftId,
        reservationIdHash: nonZeroBytes32(reservation.reservationIdHash, "reservationIdHash"),
        generationId: onchain.generation.generationId,
        programId,
        creator: draft.creator_wallet,
      });
      accounts.tokenVault = pdas.tokenVault.publicKey;
      accounts.solVault = pdas.solVault.publicKey;
      accounts.createAuthorization = pdas.createAuthorization.publicKey;
      accounts.campaign = pdas.campaign.publicKey;
      accounts.mint = mintAddress || pdas.mint.publicKey;
      if (!resolvedCampaignId) resolvedCampaignId = Buffer.from(pdas.campaignId);
    } catch {
      // keep fallbacks above
    }
  }

  const metadata = normalizeDraftMetadata(draft, reservation || { normalizedTicker: draft.ticker });
  const mint = mintAddress || accounts.mint;
  const registryOk = Boolean(finalized.registry?.ok);
  const tokenPath = `/token/${encodeURIComponent(mint || campaignAddress)}?chainId=${Number(draft.chain_id) || 101}`;
  const campaignIdHex = resolvedCampaignId ? Buffer.from(resolvedCampaignId).toString("hex") : null;
  const campaignIdBytes = resolvedCampaignId ? bufferArray(resolvedCampaignId) : null;

  return {
    schemaVersion: CREATE_AUTH_SCHEMA_VERSION,
    mode: isScheduled ? "countdown" : "draft_deploy_now",
    alreadyOnChain: true,
    draftFinalized: true,
    registryUpserted: registryOk,
    registryError: registryOk ? null : finalized.registry?.error || null,
    registryAttempts: finalized.registry?.attempts || null,
    registryMetaMerged: Boolean(finalized.registry?.metaMerged),
    tokenPath,
    cluster,
    programId,
    createArgs: campaignIdBytes
      ? {
          // Partial createArgs so clients can pass campaignId into mark-deploy / trade-auth.
          campaignId: campaignIdBytes,
        }
      : null,
    accounts,
    authorization: null,
    generation: publicGeneration(onchain.generation),
    deploymentEvidence,
    metadata: {
      canonical: metadata,
      canonicalJsonSha256: sha256Hex(Buffer.from(canonicalJson(metadata), "utf8")),
    },
    existingDeployment: {
      campaignAddress,
      mintAddress: mint,
      recovered: true,
      draftStatus: finalized.draftRow?.status || "deployed",
      registryUpserted: registryOk,
      tokenPath,
      tokenVault: accounts.tokenVault,
      solVault: accounts.solVault,
      campaignIdHex,
    },
    tickerReservation: finalized.tickerReservation,
    preflight: {
      chainNow: onchain.chainNow,
      recovery: true,
      draftFinalized: true,
      registryUpserted: registryOk,
      globalSecurityDefaultsLocked: onchain.global.securityDefaultsLocked,
      creatorTier: onchain.creatorProfile.tier,
      creatorLiveBondingCount: onchain.creatorProfile.liveBondingCount,
      creatorMaxLiveBondingCount: onchain.creatorProfile.maxLiveBondingCount,
      creatorProfileImplicitDefault: Boolean(onchain.creatorProfileImplicitDefault),
      riskLevel: onchain.riskProfile.riskLevel,
      riskProfileImplicitDefault: Boolean(onchain.riskProfileImplicitDefault),
      riskClusterSize: onchain.clusterProfile?.size ?? 0,
    },
    transaction: null,
    transactionPolicy:
      "Campaign already exists on-chain. Railway finalized the draft and registered it for the feed; open the token page.",
  };
}

async function authorizeReservation(pool, {
  draft,
  cluster,
  launchAt,
  programId,
  generationId,
  buildAuthorization,
}) {
  return withTickerReservationTransaction(pool, async (db) => {
    await refreshExpiredTickerReservations(db, { draftId: String(draft.id) });
    const reservation = await loadTickerReservationByDraft(db, String(draft.id), { forUpdate: true });
    if (!reservation) {
      throw new TickerReservationError("Ticker reservation is missing, expired, or released.", {
        code: "RESERVATION_NOT_FOUND",
        httpStatus: 409,
      });
    }
    if (Number(reservation.chainId) !== Number(draft.chain_id) || reservation.cluster !== cluster) {
      throw new TickerReservationError("Ticker reservation chain or cluster does not match this Solana deployment.", {
        code: "RESERVATION_CLUSTER_MISMATCH",
      });
    }
    if (!samePublicKey(reservation.creatorWallet, draft.creator_wallet)) {
      throw new TickerReservationError("Ticker reservation creator does not match the draft owner.", {
        code: "RESERVATION_OWNER_MISMATCH",
      });
    }
    if (String(reservation.normalizedTicker) !== String(draft.ticker || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 12)) {
      throw new TickerReservationError("Ticker reservation no longer matches the draft ticker.", {
        code: "RESERVATION_TICKER_MISMATCH",
      });
    }

    // Already LIVE/ARMED: only recovery is allowed (buildAuthorization returns alreadyOnChain).
    if ([TICKER_RESERVATION_STATUS.ARMED_ONCHAIN, TICKER_RESERVATION_STATUS.LIVE].includes(reservation.status)) {
      const nonce = crypto.randomBytes(32);
      const result = await buildAuthorization(reservation, nonce);
      if (!result?.response?.alreadyOnChain && !result?.response?.existingDeployment) {
        throw new TickerReservationError("Ticker is already permanently armed on-chain or live.", {
          code: "RESERVATION_ALREADY_ARMED",
        });
      }
      return { reservation, ...result };
    }

    const nextVersion = BigInt(reservation.reservationVersion) + 1n;
    const nonce = crypto.randomBytes(32);
    const authorizationNonce = BigInt(`0x${nonce.toString("hex")}`).toString();
    const updated = await db.query(
      `update public.ticker_reservations
          set status = 'ARM_AUTHORIZED',
              scheduled_launch_at = case when $2::bigint = 0 then null else to_timestamp($2) end,
              arm_authorized_at = now(),
              authorization_nonce = $3,
              reservation_version = $4,
              program_id = $5,
              generation_id = $6,
              failure_reason = null,
              metadata = metadata || $7::jsonb,
              updated_at = now()
        where id = $1
        returning *`,
      [
        reservation.id,
        launchAt.toString(),
        authorizationNonce,
        nextVersion.toString(),
        programId,
        hex32(generationId),
        JSON.stringify({
          solanaAuthorizationSchemaVersion: CREATE_AUTH_SCHEMA_VERSION,
          solanaCluster: cluster,
        }),
      ],
    );
    const authorized = await loadTickerReservationByDraft(db, String(draft.id), { forUpdate: true });
    if (!updated.rows[0] || !authorized) {
      throw new TickerReservationError("Ticker reservation authorization update failed.", {
        code: "RESERVATION_AUTHORIZATION_FAILED",
      });
    }

    const result = await buildAuthorization(authorized, nonce);
    await db.query(
      `insert into public.ticker_reservation_events
         (reservation_id, event_type, from_status, to_status, actor_type, actor_wallet, reason, metadata)
       values ($1,$2,$3,$4,'route_signer',$5,$6,$7::jsonb)`,
      [
        authorized.id,
        "solana_v4_create_authorized",
        reservation.status,
        authorized.status,
        draft.creator_wallet,
        launchAt === 0n
          ? "Solana V4 immediate create authorization issued."
          : "Solana V4 scheduled create authorization issued.",
        JSON.stringify(result.auditMetadata),
      ],
    );
    return { reservation: authorized, ...result };
  });
}

export function publicGeneration(generation) {
  return {
    generationIdHex: hex32(generation.generationId),
    programId: generation.programId,
    configPda: generation.configPda,
    startSlot: generation.startSlot.toString(),
    clusterKind: generation.clusterKind,
    allowedGraduationTierMask: generation.allowedGraduationTierMask,
    economicsVersion: generation.economicsVersion,
    curveKind: generation.curveKind,
    tokenTotalSupply: generation.tokenTotalSupply.toString(),
    tokenDecimals: generation.tokenDecimals,
    curveSupplyBps: generation.curveSupplyBps,
    liquidityTokenBps: generation.liquidityTokenBps,
    basePriceLamports: generation.basePriceLamports.toString(),
    priceSlopeLamports: generation.priceSlopeLamports.toString(),
    buyFeeBps: generation.buyFeeBps,
    sellFeeBps: generation.sellFeeBps,
    finalizeFeeBps: generation.finalizeFeeBps,
    creatorPostFinalizeBps: generation.creatorPostFinalizeBps,
    liquidityPostFinalizeBps: generation.liquidityPostFinalizeBps,
    dexAdapter: generation.dexAdapter,
    tradeRouteProfileHex: hex32(generation.tradeRouteProfile),
    finalizeRouteProfileHex: hex32(generation.finalizeRouteProfile),
    treasuryProfileHex: hex32(generation.treasuryProfile),
    dexProfileHex: hex32(generation.dexProfile),
    oracleProfileHex: hex32(generation.oracleProfile),
    manifestHashHex: hex32(generation.manifestHash),
    routeAuthorizationRequired: generation.routeAuthorizationRequired,
    authorizedTradingRequired: generation.authorizedTradingRequired,
  };
}

export async function solanaCreateAuthorizationV4(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;

  try {
    if (!isTruthy(process.env.SOLANA_CREATE_AUTH_ENABLED)) {
      throw new SolanaCreateAuthorizationError("Solana create authorization is disabled by the Railway launch gate.", {
        code: "SOLANA_CREATE_AUTH_DISABLED",
        httpStatus: 503,
      });
    }

    const body = await readJson(req);
    const draftId = String(req.params?.draftId || body.draftId || "").trim();
    if (!draftId) {
      throw new SolanaCreateAuthorizationError("draftId is required.", {
        code: "DRAFT_ID_REQUIRED",
        httpStatus: 400,
      });
    }
    if (String(body.mode || "").toLowerCase() === "direct_create") {
      throw new SolanaCreateAuthorizationError("Direct Create remains closed until its canonical draft-and-reservation preflight is wired.", {
        code: "SOLANA_DIRECT_CREATE_NOT_READY",
        httpStatus: 409,
      });
    }

    const pool = await getPool();
    if (!pool) {
      throw new SolanaCreateAuthorizationError("Solana create authorization requires DATABASE_URL.", {
        code: "DATABASE_NOT_CONFIGURED",
        httpStatus: 503,
      });
    }
    const draft = await loadDraft(pool, draftId);
    validateDraft(draft);

    const ownerOk = await requireDraftActionAuth({
      res,
      pool,
      auth: body.auth,
      expectedWallet: draft.creator_wallet,
      chainId: Number(draft.chain_id),
      action: "deploy_draft",
      draftId,
    });
    if (!ownerOk) return;

    const configuredCluster = requiredEnv("SOLANA_CLUSTER");
    const cluster = canonicalClusterForChain(Number(draft.chain_id), configuredCluster);
    const expectedDraftCluster = canonicalClusterForChain(Number(draft.chain_id));
    if (cluster !== expectedDraftCluster) {
      throw new SolanaCreateAuthorizationError("Draft chain ID and configured Solana cluster do not match.", {
        code: "SOLANA_DRAFT_CLUSTER_MISMATCH",
        httpStatus: 503,
      });
    }

    const rpcUrl = requiredEnv("SOLANA_RPC_URL");
    const programId = validateProgramConfiguration(requiredEnv("SOLANA_LAUNCHPAD_PROGRAM_ID"));
    const routeSecret = requiredEnv("SOLANA_ROUTE_SIGNER_SECRET_KEY");
    const expectedRouteSigner = publicKeyString(requiredEnv("SOLANA_ROUTE_SIGNER_PUBLIC_KEY"), "SOLANA_ROUTE_SIGNER_PUBLIC_KEY");
    const signer = createEd25519Signer(routeSecret);
    if (!samePublicKey(signer.publicKey, expectedRouteSigner)) {
      throw new SolanaCreateAuthorizationError("Railway Solana route signer secret does not match SOLANA_ROUTE_SIGNER_PUBLIC_KEY.", {
        code: "SOLANA_ROUTE_SIGNER_CONFIGURATION_MISMATCH",
        httpStatus: 503,
      });
    }

    // Skip launch limits until we know whether this draft already has an on-chain campaign.
    // Deterministic campaign PDA means re-create after a successful create + failed mark is impossible.
    const onchain = await loadOnchainPolicy({
      rpcUrl,
      programId,
      creator: draft.creator_wallet,
      cluster,
      signer,
      skipCreatorLaunchLimits: true,
    });
    const deploymentEvidence = validateDeploymentEvidence(onchain.generation);
    const graduationTarget = toBigInt(body.graduationTargetUsdMicros, "graduationTargetUsdMicros");
    validateGraduationTarget(onchain.generation, graduationTarget);
    const launchAt = body.launchAt == null || body.launchAt === "" ? 0n : toBigInt(body.launchAt, "launchAt");
    // Recovery may skip schedule window checks; only enforce for true fresh creates.
    if (!draft.campaign_address) {
      validateLaunchAt(launchAt, onchain.chainNow);
    }

    // ── Early recovery (before reservation arming / cooldown) ──────────────
    // Covers: create succeeded + mark failed, draft already linked, reservation LIVE/ARMED.
    const peekReservation = await loadTickerReservationByDraft(pool, draftId);
    const recoveryCandidates = [];
    if (draft.campaign_address) {
      recoveryCandidates.push({
        campaignAddress: String(draft.campaign_address).trim(),
        mintAddress: String(draft.token_address || "").trim() || null,
        source: "draft_row",
      });
    }
    if (peekReservation?.campaignPda) {
      recoveryCandidates.push({
        campaignAddress: String(peekReservation.campaignPda).trim(),
        mintAddress: String(peekReservation.mint || "").trim() || null,
        source: "reservation_row",
      });
    }
    if (peekReservation?.reservationIdHash) {
      try {
        const pdas = deriveCampaignAccounts({
          draftId,
          reservationIdHash: nonZeroBytes32(peekReservation.reservationIdHash, "reservationIdHash"),
          generationId: onchain.generation.generationId,
          programId,
          creator: draft.creator_wallet,
        });
        recoveryCandidates.push({
          campaignAddress: pdas.campaign.publicKey,
          mintAddress: pdas.mint.publicKey,
          source: "derived_pda",
          pdas,
        });
      } catch (error) {
        console.warn("[solana-v4-create] PDA derive for recovery failed", error?.message || error);
      }
    }

    // Deduplicate by campaign address.
    const seenCampaign = new Set();
    for (const candidate of recoveryCandidates) {
      const key = candidate.campaignAddress;
      if (!key || seenCampaign.has(key)) continue;
      seenCampaign.add(key);

      let campaignInfo = null;
      let mintInfo = null;
      try {
        const addresses = [candidate.campaignAddress];
        if (candidate.mintAddress) addresses.push(candidate.mintAddress);
        const infos = await getMultipleAccounts(rpcUrl, addresses);
        campaignInfo = infos[0];
        mintInfo = infos[1] || null;
      } catch (error) {
        console.warn("[solana-v4-create] recovery account lookup failed", error?.message || error);
        continue;
      }

      const campaignOwned = campaignInfo && samePublicKey(campaignInfo.owner, programId);
      const mintOwned =
        candidate.mintAddress && mintInfo && samePublicKey(mintInfo.owner, TOKEN_PROGRAM_ID);

      // Mint-only partial create (create failed mid-instruction) — cannot re-create or recover cleanly.
      if (!campaignOwned && mintOwned) {
        throw new SolanaCreateAuthorizationError(
          `Solana mint PDA ${candidate.mintAddress} already exists but campaign PDA ${candidate.campaignAddress} does not. ` +
            `A prior create partially landed; operator must reclaim/close the mint PDA or use a new draft/reservation.`,
          { code: "SOLANA_PARTIAL_CREATE_ORPHAN", httpStatus: 409 },
        );
      }

      if (campaignOwned) {
        const mintAddress =
          mintOwned && candidate.mintAddress
            ? candidate.mintAddress
            : candidate.mintAddress || candidate.pdas?.mint?.publicKey || draft.token_address || candidate.campaignAddress;
        const recovery = await finalizeExistingOnChainDeployment({
          pool,
          draft,
          cluster,
          programId,
          onchain,
          deploymentEvidence,
          campaignAddress: candidate.campaignAddress,
          mintAddress,
          reservation: peekReservation,
          launchAt,
          tokenVault: candidate.pdas?.tokenVault?.publicKey || null,
          solVault: candidate.pdas?.solVault?.publicKey || null,
          campaignId: candidate.pdas?.campaignId || null,
        });
        return json(res, 200, recovery);
      }
    }

    // Fresh create requires a free campaign PDA and a non-deployed draft status.
    if (draft.campaign_address) {
      // Candidate checks above should have recovered; if not, chain account is missing.
      throw new SolanaCreateAuthorizationError(
        `Draft is linked to campaign ${draft.campaign_address} but that account is not program-owned on RPC. Check SOLANA_RPC_URL / program id.`,
        { code: "SOLANA_DRAFT_CAMPAIGN_MISSING_ONCHAIN", httpStatus: 409 },
      );
    }
    if (!ALLOWED_DRAFT_STATUSES.has(String(draft.status))) {
      throw new SolanaCreateAuthorizationError("Publish the Prepare Mode promotion before authorizing Solana deployment.", {
        code: "SOLANA_DRAFT_NOT_READY",
      });
    }

    const ttlSeconds = parsePositiveInteger(
      process.env.SOLANA_CREATE_AUTH_TTL_SECONDS,
      DEFAULT_AUTH_TTL_SECONDS,
      MAX_AUTH_TTL_SECONDS,
    );
    const deadline = BigInt(onchain.chainNow + ttlSeconds);
    const clusterHash = nonZeroBytes32(hashEnv("SOLANA_CLUSTER_HASH_HEX"), "SOLANA_CLUSTER_HASH_HEX");

    const authorized = await authorizeReservation(pool, {
      draft,
      cluster,
      launchAt,
      programId,
      generationId: onchain.generation.generationId,
      buildAuthorization: async (reservation, nonce) => {
        const reservationIdHash = nonZeroBytes32(reservation.reservationIdHash, "reservationIdHash");
        const tickerHash = nonZeroBytes32(reservation.tickerHash, "tickerHash");
        const metadata = normalizeDraftMetadata(draft, reservation);
        const metadataHash = sha256(Buffer.from(canonicalJson(metadata), "utf8"));
        const { campaignId, campaign, mint, tokenVault, solVault, createAuthorization } = deriveCampaignAccounts({
          draftId,
          reservationIdHash,
          generationId: onchain.generation.generationId,
          programId,
          creator: draft.creator_wallet,
          nonce,
        });

        // Double-check inside the arming transaction (race with another tab).
        const [campaignInfo, mintInfo] = await getMultipleAccounts(rpcUrl, [
          campaign.publicKey,
          mint.publicKey,
        ]);
        if (campaignInfo && samePublicKey(campaignInfo.owner, programId)) {
          const mintAddress =
            mintInfo && samePublicKey(mintInfo.owner, TOKEN_PROGRAM_ID)
              ? mint.publicKey
              : mint.publicKey;
          // Signal recovery; outer handler finalizes after authorizeReservation returns.
          return {
            auditMetadata: {
              schemaVersion: CREATE_AUTH_SCHEMA_VERSION,
              recovery: true,
              programId,
              cluster,
              campaign: campaign.publicKey,
              mint: mintAddress,
              reservationVersion: reservation.reservationVersion,
            },
            response: {
              schemaVersion: CREATE_AUTH_SCHEMA_VERSION,
              mode: launchAt === 0n ? "draft_deploy_now" : "countdown",
              alreadyOnChain: true,
              draftFinalized: false,
              cluster,
              programId,
              createArgs: null,
              accounts: {
                creator: publicKeyString(draft.creator_wallet),
                globalConfig: onchain.accounts.globalConfig,
                generationConfig: onchain.accounts.generationConfig,
                creatorProfile: onchain.accounts.creatorProfile,
                riskProfile: onchain.accounts.riskProfile,
                clusterProfile: onchain.accounts.clusterProfile,
                campaign: campaign.publicKey,
                mint: mintAddress,
                tokenVault: tokenVault.publicKey,
                solVault: solVault.publicKey,
                createAuthorization: createAuthorization.publicKey,
                instructions: SYSVAR_INSTRUCTIONS_ID,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SYSTEM_PROGRAM_ID,
              },
              authorization: null,
              generation: publicGeneration(onchain.generation),
              deploymentEvidence,
              metadata: {
                canonical: metadata,
                canonicalJsonSha256: sha256Hex(Buffer.from(canonicalJson(metadata), "utf8")),
              },
              existingDeployment: {
                campaignAddress: campaign.publicKey,
                mintAddress,
                recovered: true,
              },
            },
          };
        }
        if (mintInfo && samePublicKey(mintInfo.owner, TOKEN_PROGRAM_ID) && !campaignInfo) {
          throw new SolanaCreateAuthorizationError(
            `Solana mint PDA ${mint.publicKey} already exists but campaign is empty (partial create). Cannot re-create; operator must reclaim the mint or use a new draft.`,
            { code: "SOLANA_PARTIAL_CREATE_ORPHAN", httpStatus: 409 },
          );
        }

        // Fresh create: enforce cooldown / live-count now that we know PDAs are free.
        enforceCreatorLaunchLimits(onchain.creatorProfile, onchain.chainNow);
        const args = {
          campaignId,
          metadataHash,
          clusterHash,
          tickerHash,
          reservationIdHash,
          reservationVersion: BigInt(reservation.reservationVersion),
          launchAt,
          graduationTargetUsdMicros: graduationTarget,
          deadline,
          nonce,
        };
        const authorizationInput = {
          programId,
          generationConfigKey: onchain.accounts.generationConfig,
          generation: onchain.generation,
          creator: draft.creator_wallet,
          riskClusterId: onchain.riskProfile.clusterId,
          creatorBuyLockSeconds: onchain.creatorProfile.creatorBuyLockSeconds,
          creatorBuyCapBps: onchain.creatorProfile.creatorBuyCapBps,
          campaign: campaign.publicKey,
          mint: mint.publicKey,
          tokenVault: tokenVault.publicKey,
          solVault: solVault.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          args,
        };
        const canonicalPayload = buildCreateAuthorizationPayload(authorizationInput);
        const digest = createAuthorizationDigest(authorizationInput);
        const signature = signer.sign(digest);
        if (!signer.verify(digest, signature)) {
          throw new SolanaCreateAuthorizationError("Railway failed to verify its own Solana V4 signature.", {
            code: "SOLANA_ROUTE_SIGNATURE_INVALID",
            httpStatus: 503,
          });
        }

        const accountSet = {
          creator: publicKeyString(draft.creator_wallet),
          globalConfig: onchain.accounts.globalConfig,
          generationConfig: onchain.accounts.generationConfig,
          creatorProfile: onchain.accounts.creatorProfile,
          riskProfile: onchain.accounts.riskProfile,
          clusterProfile: onchain.accounts.clusterProfile,
          campaign: campaign.publicKey,
          mint: mint.publicKey,
          tokenVault: tokenVault.publicKey,
          solVault: solVault.publicKey,
          createAuthorization: createAuthorization.publicKey,
          instructions: SYSVAR_INSTRUCTIONS_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SYSTEM_PROGRAM_ID,
        };
        const createArgs = {
          campaignId: bufferArray(args.campaignId),
          metadataHash: bufferArray(args.metadataHash),
          clusterHash: bufferArray(args.clusterHash),
          tickerHash: bufferArray(args.tickerHash),
          reservationIdHash: bufferArray(args.reservationIdHash),
          reservationVersion: args.reservationVersion.toString(),
          launchAt: args.launchAt.toString(),
          graduationTargetUsdMicros: args.graduationTargetUsdMicros.toString(),
          deadline: args.deadline.toString(),
          nonce: bufferArray(args.nonce),
        };
        const auditMetadata = {
          schemaVersion: CREATE_AUTH_SCHEMA_VERSION,
          programId,
          cluster,
          generationIdHex: hex32(onchain.generation.generationId),
          generationConfig: onchain.accounts.generationConfig,
          campaign: campaign.publicKey,
          mint: mint.publicKey,
          reservationVersion: reservation.reservationVersion,
          launchAt: launchAt.toString(),
          deadline: deadline.toString(),
          digestHex: digest.toString("hex"),
          canonicalPayloadLength: canonicalPayload.length,
          creatorProfileImplicitDefault: Boolean(onchain.creatorProfileImplicitDefault),
          riskProfileImplicitDefault: Boolean(onchain.riskProfileImplicitDefault),
          idlSha256: deploymentEvidence.idlSha256,
          programBinarySha256: deploymentEvidence.programBinarySha256,
        };

        return {
          auditMetadata,
          response: {
            schemaVersion: CREATE_AUTH_SCHEMA_VERSION,
            mode: launchAt === 0n ? "draft_deploy_now" : "countdown",
            cluster,
            programId,
            createArgs,
            accounts: accountSet,
            authorization: {
              signedMessageMode: "sha256_canonical_payload",
              signedMessageLengthBytes: digest.length,
              canonicalPayloadLengthBytes: canonicalPayload.length,
              digestHex: digest.toString("hex"),
              digestBase64: digest.toString("base64"),
              signatureBase64: signature.toString("base64"),
              routeSigner: signer.publicKeyBase58,
              deadline: deadline.toString(),
              validUntil: new Date(Number(deadline) * 1000).toISOString(),
              ed25519InstructionMustImmediatelyPrecedeCreate: true,
              railwayTransactionCosignerRequired: false,
            },
            generation: publicGeneration(onchain.generation),
            deploymentEvidence,
            metadata: {
              canonical: metadata,
              canonicalJsonSha256: sha256Hex(Buffer.from(canonicalJson(metadata), "utf8")),
            },
          },
        };
      },
    });

    // Race recovery: authorizeReservation saw the campaign PDA after early check missed it.
    if (authorized.response?.alreadyOnChain || authorized.response?.existingDeployment) {
      const campaignAddress =
        authorized.response.existingDeployment?.campaignAddress ||
        authorized.response.accounts?.campaign;
      const mintAddress =
        authorized.response.existingDeployment?.mintAddress ||
        authorized.response.accounts?.mint;
      if (campaignAddress) {
        const recovery = await finalizeExistingOnChainDeployment({
          pool,
          draft,
          cluster,
          programId,
          onchain,
          deploymentEvidence,
          campaignAddress,
          mintAddress,
          reservation: authorized.reservation || peekReservation,
          launchAt,
          tokenVault: authorized.response?.accounts?.tokenVault || null,
          solVault: authorized.response?.accounts?.solVault || null,
          campaignId: authorized.response?.createArgs?.campaignId || null,
        });
        return json(res, 200, recovery);
      }
    }

    return json(res, 200, {
      ...authorized.response,
      tickerReservation: authorized.reservation,
      preflight: {
        chainNow: onchain.chainNow,
        globalSecurityDefaultsLocked: onchain.global.securityDefaultsLocked,
        creatorTier: onchain.creatorProfile.tier,
        creatorLiveBondingCount: onchain.creatorProfile.liveBondingCount,
        creatorMaxLiveBondingCount: onchain.creatorProfile.maxLiveBondingCount,
        creatorProfileImplicitDefault: Boolean(onchain.creatorProfileImplicitDefault),
        riskLevel: onchain.riskProfile.riskLevel,
        riskProfileImplicitDefault: Boolean(onchain.riskProfileImplicitDefault),
        riskClusterSize: onchain.clusterProfile?.size ?? 0,
      },
      transaction: null,
      transactionPolicy: "Creator wallet constructs and signs the transaction. Railway signs only the 32-byte V4 digest.",
    });
  } catch (error) {
    if (error instanceof SolanaCreateAuthorizationError || error instanceof TickerReservationError) {
      return json(res, error.httpStatus || 409, { error: error.message, code: error.code });
    }
    console.error("[solana-v4-create] authorization failed", error);
    return json(res, 500, {
      error: "Solana V4 create authorization failed.",
      code: "SOLANA_CREATE_AUTHORIZATION_INTERNAL_ERROR",
    });
  }
}
