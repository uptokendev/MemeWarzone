import crypto from "node:crypto";
import { isSolanaAddress, isSolanaChain, json, normalizeAddress } from "../../server/http.js";
import { requireWalletActionAuth } from "./walletActionAuth.js";

export const PROJECT_IMPORT_ACTIONS = Object.freeze({
  resolve: "project_import_resolve",
  create: "project_import_create",
  claim: "project_import_claim",
  manualClaim: "project_import_manual_claim",
  metadata: "project_import_metadata",
  image: "project_import_image",
  registrationImage: "project_import_registration_image",
});

export const PROJECT_IMPORT_OWNERSHIP = Object.freeze({
  pending: "ownership_pending",
  manualReview: "ownership_manual_review",
  verified: "ownership_verified",
  suspended: "ownership_suspended",
});

const METADATA_FIELDS = new Set(["description", "website", "x_url", "telegram_url"]);
const FORBIDDEN_METADATA_KEYS = new Set([
  "id", "chain", "chainId", "chain_id", "token", "tokenId", "tokenAddress", "token_address",
  "contract", "contractAddress", "mint", "mintAddress", "ownerWallet", "owner_wallet",
  "projectOwnerWallet", "project_owner_wallet", "ownershipStatus", "ownership_status",
  "arenaStatus", "arena_status", "arenaEligible", "arena_eligible", "graduationEligible",
  "graduation_eligible", "campaignId", "campaign_id", "creatorEconomics", "creator_economics",
  "payout", "payoutAmount", "payout_amount", "rewards", "rewardAmount", "financial",
  "imageUrl", "image_url", "name", "symbol", "decimals", "verifiedAt", "verified_at",
  "ownershipVerifiedAt", "ownership_verified_at",
]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(stableValue(value ?? null));
}

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function normalizeProjectImportToken(chainId, rawToken) {
  const id = Number(chainId);
  const raw = String(rawToken || "").trim();
  if (!Number.isInteger(id) || id <= 0 || !raw) return "";
  if (isSolanaChain(id)) return isSolanaAddress(raw) ? raw : "";
  return normalizeAddress(raw, id);
}

export function canonicalProjectImportIdentity(chainId, rawToken) {
  const id = Number(chainId);
  const token = normalizeProjectImportToken(id, rawToken);
  if (!token) {
    throw Object.assign(new Error("Invalid project import chain/token identity"), {
      code: "IMPORT_IDENTITY_INVALID",
    });
  }
  return Object.freeze({ chainId: id, token, tokenAddress: token, key: `${id}:${token}` });
}

export function projectImportIntent({ action, chainId, token, projectId = null, body = null, imageDigest = null }) {
  if (!Object.values(PROJECT_IMPORT_ACTIONS).includes(action)) {
    throw Object.assign(new Error("Unsupported project import wallet action"), { code: "IMPORT_ACTION_INVALID" });
  }
  const identity = canonicalProjectImportIdentity(chainId, token);
  const intent = {
    action,
    chainId: identity.chainId,
    token: identity.token,
    projectId: projectId ? String(projectId) : null,
    body: body == null ? null : stableValue(body),
    imageDigest: imageDigest ? String(imageDigest).toLowerCase() : null,
  };
  const digest = sha256Hex(canonicalJson(intent));
  return Object.freeze({
    identity,
    digest,
    extraLines: [`Project token: ${identity.token}`, `Project import intent: ${digest}`],
  });
}

export async function requireProjectImportWalletAuth({
  res,
  pool,
  auth,
  expectedWallet,
  chainId,
  token,
  action,
  projectId = null,
  body = null,
  imageDigest = null,
  routeLabel = "project/import",
}) {
  const intent = projectImportIntent({ action, chainId, token, projectId, body, imageDigest });
  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth,
    expectedWallet,
    chainId: intent.identity.chainId,
    action,
    routeLabel,
    extraLines: intent.extraLines,
    strict: true,
  });
  if (!verified) return null;
  if (verified.legacy) {
    if (!res.headersSent) {
      json(res, 401, {
        ok: false,
        error: "Project import mutations always require nonce-backed wallet proof.",
        code: "PROJECT_IMPORT_STRICT_AUTH_REQUIRED",
      });
    }
    return null;
  }
  return { ...verified, intent };
}

function normalizeWalletForProject(chainId, wallet) {
  const raw = String(wallet || "").trim();
  if (!raw) return "";
  if (isSolanaChain(Number(chainId))) return isSolanaAddress(raw) ? raw : "";
  return normalizeAddress(raw, Number(chainId));
}

function ownershipStatus(project) {
  return String((project?.ownership_status ?? project?.ownershipStatus) || "");
}

function authoritativeProjectOwner(project) {
  // Deliberately never fall back to historical owner_wallet. That column may
  // contain the first importer from older Arena-import generations and is not
  // project-page ownership authority.
  return project?.project_owner_wallet ?? project?.projectOwnerWallet ?? "";
}

export function assertVerifiedProjectOwner(project, { wallet, chainId, token } = {}) {
  if (!project) throw Object.assign(new Error("Project import not found"), { code: "IMPORT_NOT_FOUND" });
  const projectIdentity = canonicalProjectImportIdentity(
    project.chain_id ?? project.chainId,
    project.token_address ?? project.tokenAddress ?? project.mint,
  );
  const requestedIdentity = canonicalProjectImportIdentity(
    chainId ?? projectIdentity.chainId,
    token ?? projectIdentity.token,
  );
  if (projectIdentity.key !== requestedIdentity.key) {
    throw Object.assign(new Error("Project import chain/token identity mismatch"), {
      code: "IMPORT_IDENTITY_MISMATCH",
    });
  }
  if (ownershipStatus(project) !== PROJECT_IMPORT_OWNERSHIP.verified) {
    throw Object.assign(new Error("Project ownership is not verified"), { code: "IMPORT_OWNER_NOT_VERIFIED" });
  }
  const expected = normalizeWalletForProject(projectIdentity.chainId, authoritativeProjectOwner(project));
  const actual = normalizeWalletForProject(projectIdentity.chainId, wallet);
  if (!expected || !actual || expected !== actual) {
    throw Object.assign(new Error("Connected wallet is not the verified project owner"), {
      code: "IMPORT_OWNER_MISMATCH",
    });
  }
  return { identity: projectIdentity, wallet: actual };
}

export function ownershipClaimDecision(project, { claimantWallet, currentOwnerProof, chainId, token } = {}) {
  if (!project) throw Object.assign(new Error("Project import not found"), { code: "IMPORT_NOT_FOUND" });
  const identity = canonicalProjectImportIdentity(
    project.chain_id ?? project.chainId,
    project.token_address ?? project.tokenAddress ?? project.mint,
  );
  const requested = canonicalProjectImportIdentity(chainId ?? identity.chainId, token ?? identity.token);
  if (identity.key !== requested.key) {
    throw Object.assign(new Error("Claim identity mismatch"), { code: "IMPORT_IDENTITY_MISMATCH" });
  }
  if (ownershipStatus(project) === PROJECT_IMPORT_OWNERSHIP.suspended) {
    throw Object.assign(new Error("Project ownership is suspended"), { code: "IMPORT_OWNER_SUSPENDED" });
  }

  const claimant = normalizeWalletForProject(identity.chainId, claimantWallet);
  const proven = normalizeWalletForProject(identity.chainId, currentOwnerProof);
  if (!claimant || claimant !== proven) {
    throw Object.assign(new Error("Current owner proof does not bind to claimant wallet"), {
      code: "IMPORT_OWNER_PROOF_MISMATCH",
    });
  }

  const existingOwner = normalizeWalletForProject(identity.chainId, authoritativeProjectOwner(project));
  const alreadyVerified = ownershipStatus(project) === PROJECT_IMPORT_OWNERSHIP.verified;
  if (alreadyVerified) {
    if (existingOwner === claimant) {
      return Object.freeze({ outcome: "already_verified", identity, ownerWallet: claimant });
    }
    throw Object.assign(new Error("A different verified project owner already controls this project"), {
      code: "IMPORT_VERIFIED_OWNER_CONFLICT",
    });
  }
  return Object.freeze({ outcome: "verify_owner", identity, ownerWallet: claimant });
}

export function sanitizeProjectImportMetadataPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw Object.assign(new Error("Metadata patch must be an object"), { code: "IMPORT_METADATA_INVALID" });
  }
  const output = {};
  for (const [key, value] of Object.entries(patch)) {
    if (FORBIDDEN_METADATA_KEYS.has(key) || !METADATA_FIELDS.has(key)) {
      throw Object.assign(new Error(`Metadata field is not editable: ${key}`), {
        code: "IMPORT_METADATA_FIELD_FORBIDDEN",
        field: key,
      });
    }
    output[key] = value == null ? null : String(value).trim();
  }
  return output;
}

export function assertNoImportSideEffectMutation(before, after) {
  const protectedFields = [
    "chain_id", "chainId", "token_address", "tokenAddress", "mint", "status",
    "arena_status", "arenaStatus", "arena_eligible", "arenaEligible", "campaign_id", "campaignId",
    "payout", "payout_amount", "rewards", "creator_economics", "creatorEconomics",
    "graduation_eligible", "graduationEligible",
  ];
  for (const field of protectedFields) {
    if (Object.prototype.hasOwnProperty.call(before || {}, field) || Object.prototype.hasOwnProperty.call(after || {}, field)) {
      if (canonicalJson(before?.[field]) !== canonicalJson(after?.[field])) {
        throw Object.assign(new Error(`Project import mutation changed protected field: ${field}`), {
          code: "IMPORT_SIDE_EFFECT_FORBIDDEN",
          field,
        });
      }
    }
  }
  return true;
}
