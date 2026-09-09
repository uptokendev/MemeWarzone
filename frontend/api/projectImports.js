import { pool } from "../server/db.js";
import { getQuery, json, readJson } from "../server/http.js";
import { requireDashboardAdmin } from "./dashboard/_auth.js";
import {
  assertResolverIdentity,
  claimExistingProject,
  createProjectImport,
  listRecentProjectImports,
  listUserProjectImports,
  lookupProjectImport,
  normalizeProjectIdentity,
  patchProjectMetadata,
  publicProject,
  requestManualProjectClaim,
} from "./lib/projectImportCore.js";
import { registerDefaultProjectImportResolvers } from "./lib/projectImportResolverAdapters.js";
import { resolveProjectToken } from "./lib/projectImportResolvers.js";
import { scanProjectImportSecurity, securityAllowsAutomaticImport } from "./lib/projectImportRiskSecurity.js";
import {
  getProjectOwnershipAudit,
  getProjectOwnershipClaim,
  listProjectOwnershipClaims,
  projectOwnershipClaimItem,
  reviewProjectOwnership,
} from "./lib/projectOwnershipReview.js";
import {
  PROJECT_IMPORT_ACTIONS,
  requireProjectImportWalletAuth,
  sanitizeProjectImportMetadataPatch,
} from "./lib/projectImportSecurity.js";

registerDefaultProjectImportResolvers();

function enabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.ENABLE_PROJECT_IMPORTS || "").trim());
}

function routePath(req) {
  return new URL(req.url, "http://localhost").pathname.replace(/^\/project-imports\/?/, "/");
}

function errorStatus(code) {
  if ([
    "INVALID_CHAIN", "INVALID_TOKEN", "INVALID_WALLET", "UNSUPPORTED_CHAIN",
    "IMPORT_IDENTITY_INVALID", "IMPORT_METADATA_INVALID", "IMPORT_METADATA_FIELD_FORBIDDEN",
    "NO_METADATA_FIELDS", "SOLANA_MINT_INVALID", "NO_DEPLOYED_BYTECODE", "ERC20_READ_FAILED",
    "ERC20_DECIMALS_INVALID", "PROJECT_OWNERSHIP_REASON_REQUIRED",
    "PROJECT_OWNERSHIP_EXPECTED_STATE_REQUIRED", "PROJECT_OWNERSHIP_ACTION_INVALID",
  ].includes(code)) return 400;
  if (["PROJECT_NOT_FOUND", "IMPORT_NOT_FOUND"].includes(code)) return 404;
  if ([
    "OWNERSHIP_PROOF_REQUIRED", "PROJECT_OWNER_REQUIRED", "IMPORT_OWNER_NOT_VERIFIED",
    "IMPORT_OWNER_MISMATCH", "PROJECT_OWNERSHIP_ADMIN_REQUIRED", "PROJECT_IMPORT_SECURITY_REQUIRED",
  ].includes(code)) return 403;
  if ([
    "OWNERSHIP_SUSPENDED", "MANUAL_CLAIM_NOT_ALLOWED", "RESOLVER_IDENTITY_MISMATCH",
    "OWNERSHIP_CONFLICT", "PROJECT_OWNERSHIP_STATE_CONFLICT", "PROJECT_OWNERSHIP_IMAGE_REQUIRED",
  ].includes(code)) return 409;
  if (["PROJECT_IMPORT_RESOLVER_UNAVAILABLE", "PROJECT_IMPORT_RPC_UNAVAILABLE"].includes(code)) return 503;
  return 500;
}

function projectError(res, error) {
  const code = error?.code || "PROJECT_IMPORT_ERROR";
  return json(res, errorStatus(code), {
    error: String(error?.message || error),
    code,
    currentVersion: error?.currentVersion || undefined,
    currentOwnershipStatus: error?.currentOwnershipStatus || undefined,
  });
}

async function resolveForSigner(identity, signer) {
  const result = await resolveProjectToken({
    chainId: identity.chainId,
    tokenAddress: identity.tokenAddress,
    signedWallet: signer,
  });
  assertResolverIdentity(identity, result);
  return result;
}

function unresolvedEvidence(identity, error) {
  return {
    chainId: identity.chainId,
    tokenAddress: identity.tokenAddress,
    name: null,
    symbol: null,
    decimals: null,
    totalSupply: null,
    automaticOwnershipAvailable: false,
    currentAuthority: null,
    signedWalletMatchesAuthority: false,
    resolverError: String(error?.message || error || "ownership resolver unavailable"),
  };
}

function canFallbackToManual(error) {
  return ["PROJECT_IMPORT_RPC_UNAVAILABLE", "PROJECT_IMPORT_RESOLVER_UNAVAILABLE", "BYTECODE_CHECK_FAILED"].includes(String(error?.code || ""));
}

function requireResolvedOwner(resolved) {
  if (!resolved?.automaticOwnershipAvailable) {
    throw Object.assign(new Error("Current token ownership cannot be verified automatically"), { code: "OWNERSHIP_PROOF_REQUIRED" });
  }
  if (!resolved?.signedWalletMatchesAuthority) {
    throw Object.assign(new Error("Connected wallet is not the current token owner"), { code: "OWNERSHIP_PROOF_REQUIRED" });
  }
}

function requireSecurityPass(security) {
  if (!securityAllowsAutomaticImport(security)) {
    const critical = security?.criticalRisks?.map((risk) => risk.label).filter(Boolean) || [];
    const review = security?.reviewRisks?.map((risk) => risk.label).filter(Boolean) || [];
    const summary = [...critical, ...review].slice(0, 3).join("; ");
    throw Object.assign(new Error(summary ? `Token security check requires review: ${summary}` : "Token security check requires manual review"), { code: "PROJECT_IMPORT_SECURITY_REQUIRED" });
  }
}

async function strictAuth(res, body, { identity, action, projectId = null, intentBody = null }) {
  return requireProjectImportWalletAuth({
    res,
    pool,
    auth: body?.auth,
    expectedWallet: body?.auth?.walletAddress || body?.walletAddress || "",
    chainId: identity.chainId,
    token: identity.tokenAddress,
    action,
    projectId,
    body: intentBody,
    routeLabel: `project-imports/${action}`,
  });
}

export async function enrichExistingProjectIdentity(identity, resolved) {
  const name = String(resolved?.name || "").trim().slice(0, 256) || null;
  const symbol = String(resolved?.symbol || "").trim().slice(0, 64) || null;
  if (!name && !symbol) return null;
  const result = await pool.query(`
    UPDATE public.arena_token_imports
       SET name = CASE
                    WHEN (name IS NULL OR btrim(name) = '') AND $3::text IS NOT NULL THEN $3
                    ELSE name
                  END,
           symbol = CASE
                      WHEN (symbol IS NULL OR btrim(symbol) = '') AND $4::text IS NOT NULL THEN $4
                      ELSE symbol
                    END,
           metadata_updated_at = CASE
             WHEN ((name IS NULL OR btrim(name) = '') AND $3::text IS NOT NULL)
               OR ((symbol IS NULL OR btrim(symbol) = '') AND $4::text IS NOT NULL)
             THEN NOW()
             ELSE metadata_updated_at
           END,
           updated_at = CASE
             WHEN ((name IS NULL OR btrim(name) = '') AND $3::text IS NOT NULL)
               OR ((symbol IS NULL OR btrim(symbol) = '') AND $4::text IS NOT NULL)
             THEN NOW()
             ELSE updated_at
           END
     WHERE chain_id = $1
       AND token_address = $2
     RETURNING *
  `, [identity.chainId, identity.tokenAddress, name, symbol]);
  return result.rows?.[0] || null;
}

async function refreshVerifiedProjectIdentityBestEffort(project) {
  if (!project || project.ownership_status !== "ownership_verified" || !project.project_owner_wallet) return null;
  const identity = normalizeProjectIdentity(project.chain_id, project.token_address);
  try {
    const resolved = await resolveForSigner(identity, project.project_owner_wallet);
    return await enrichExistingProjectIdentity(identity, resolved);
  } catch (error) {
    console.warn("[api/projectImports] verified ownership identity refresh failed", {
      projectId: project.id,
      chainId: identity.chainId,
      tokenAddress: identity.tokenAddress,
      code: error?.code || null,
      error: String(error?.message || error),
    });
    return null;
  }
}

async function handleOwnershipAdmin(req, res, path) {
  const admin = await requireDashboardAdmin(req, res);
  if (!admin) return true;

  if (req.method === "GET" && path === "/admin/ownership-claims") {
    const rows = await listProjectOwnershipClaims(pool);
    return json(res, 200, { items: rows.map(projectOwnershipClaimItem) });
  }

  const detailMatch = path.match(/^\/admin\/ownership-claims\/([0-9a-f-]+)$/i);
  if (req.method === "GET" && detailMatch) {
    const row = await getProjectOwnershipClaim(pool, detailMatch[1]);
    if (!row) return json(res, 404, { error: "Imported project not found", code: "PROJECT_NOT_FOUND" });
    const history = await getProjectOwnershipAudit(pool, detailMatch[1]);
    return json(res, 200, { item: projectOwnershipClaimItem(row), history });
  }

  const actionMatch = path.match(/^\/admin\/ownership-claims\/([0-9a-f-]+)\/(verify|reject)$/i);
  if (req.method === "POST" && actionMatch) {
    const body = await readJson(req);
    const action = actionMatch[2].toLowerCase() === "verify" ? "verify_owner" : "reject_claim";
    const updated = await reviewProjectOwnership(pool, {
      projectId: actionMatch[1],
      action,
      reason: body.reason,
      expectedVersion: body.expectedVersion,
      admin,
    });
    if (action === "verify_owner") await refreshVerifiedProjectIdentityBestEffort(updated);
    return json(res, 200, { item: projectOwnershipClaimItem(updated) });
  }

  return false;
}

function manualReviewNote({ resolved, security, note }) {
  const reasons = [];
  if (resolved?.resolverError) reasons.push(`resolver error: ${resolved.resolverError}`);
  else if (!resolved?.automaticOwnershipAvailable) reasons.push("automatic ownership unavailable");
  for (const risk of security?.criticalRisks || []) reasons.push(`security:${risk.code}`);
  for (const risk of security?.reviewRisks || []) reasons.push(`security:${risk.code}`);
  const userNote = String(note || "").trim();
  const prefix = reasons.length ? `System: ${reasons.join(", ")}.` : "System: manual verification requested.";
  return `${prefix}${userNote ? ` User: ${userNote}` : ""}`.slice(0, 1000);
}

export default async function projectImports(req, res) {
  if (!enabled()) return json(res, 404, { error: "Project imports are disabled.", code: "PROJECT_IMPORTS_DISABLED" });
  if (!pool) return json(res, 503, { error: "Project imports require DATABASE_URL." });

  try {
    const path = routePath(req);

    if (path.startsWith("/admin/ownership-claims")) {
      const handled = await handleOwnershipAdmin(req, res, path);
      if (handled !== false) return handled;
      return json(res, 405, { error: "Method or ownership review operation not allowed" });
    }

    if (req.method === "GET" && path === "/") {
      const q = getQuery(req);
      const tokenAddress = q.tokenAddress || q.token;
      if (q.wallet) {
        const items = await listUserProjectImports(pool, { chainId: q.chainId, walletAddress: q.wallet });
        return json(res, 200, { items: items.map(publicProject) });
      }
      if (tokenAddress) {
        const project = await lookupProjectImport(pool, { chainId: q.chainId, tokenAddress });
        if (!project) return json(res, 404, { error: "Imported project not found", code: "PROJECT_NOT_FOUND" });
        return json(res, 200, { project: publicProject(project) });
      }
      const items = await listRecentProjectImports(pool, { limit: q.limit || 24 });
      return json(res, 200, { items: items.map(publicProject) });
    }

    if (req.method === "POST" && path === "/resolve") {
      const body = await readJson(req);
      const identity = normalizeProjectIdentity(body.chainId, body.tokenAddress);
      const auth = await strictAuth(res, body, { identity, action: PROJECT_IMPORT_ACTIONS.resolve });
      if (!auth) return;
      let resolved;
      try { resolved = await resolveForSigner(identity, auth.walletAddress); }
      catch (error) {
        if (!canFallbackToManual(error)) throw error;
        resolved = unresolvedEvidence(identity, error);
      }
      const security = await scanProjectImportSecurity(identity);
      const project = await enrichExistingProjectIdentity(identity, resolved);
      return json(res, 200, { resolved: { ...resolved, security }, project: publicProject(project) });
    }

    if (req.method === "POST" && path === "/") {
      const body = await readJson(req);
      const identity = normalizeProjectIdentity(body.chainId, body.tokenAddress);
      const intentBody = { operation: "create" };
      const auth = await strictAuth(res, body, { identity, action: PROJECT_IMPORT_ACTIONS.create, intentBody });
      if (!auth) return;
      const resolved = await resolveForSigner(identity, auth.walletAddress);
      const security = await scanProjectImportSecurity(identity);
      requireResolvedOwner(resolved);
      requireSecurityPass(security);
      const result = await createProjectImport(pool, { resolverResult: resolved, signedWallet: auth.walletAddress });
      const project = result.created
        ? result.project
        : (await enrichExistingProjectIdentity(identity, resolved)) || result.project;
      return json(res, result.created ? 201 : 200, {
        created: result.created,
        project: publicProject(project),
        ownershipEvidence: {
          automaticOwnershipAvailable: resolved.automaticOwnershipAvailable,
          signedWalletMatchesAuthority: resolved.signedWalletMatchesAuthority,
          currentAuthority: resolved.currentAuthority,
          security,
        },
      });
    }

    if (req.method === "POST" && path === "/claim") {
      const body = await readJson(req);
      const identity = normalizeProjectIdentity(body.chainId, body.tokenAddress);
      const existing = await lookupProjectImport(pool, identity);
      if (!existing) throw Object.assign(new Error("Imported project not found"), { code: "PROJECT_NOT_FOUND" });
      const auth = await strictAuth(res, body, {
        identity,
        action: PROJECT_IMPORT_ACTIONS.claim,
        projectId: existing.id,
        intentBody: { operation: "claim" },
      });
      if (!auth) return;
      const resolved = await resolveForSigner(identity, auth.walletAddress);
      const security = await scanProjectImportSecurity(identity);
      requireSecurityPass(security);
      const project = await claimExistingProject(pool, { resolverResult: resolved, signedWallet: auth.walletAddress });
      await enrichExistingProjectIdentity(identity, resolved);
      return json(res, 200, { project: publicProject(project) });
    }

    if (req.method === "POST" && path === "/manual-claim") {
      const body = await readJson(req);
      const identity = normalizeProjectIdentity(body.chainId, body.tokenAddress);
      let existing = await lookupProjectImport(pool, identity);
      const note = body.note == null ? null : String(body.note).slice(0, 1000);
      const auth = await strictAuth(res, body, {
        identity,
        action: PROJECT_IMPORT_ACTIONS.manualClaim,
        projectId: existing?.id || null,
        intentBody: { note },
      });
      if (!auth) return;
      let resolved;
      try { resolved = await resolveForSigner(identity, auth.walletAddress); }
      catch (error) {
        if (!canFallbackToManual(error)) throw error;
        resolved = unresolvedEvidence(identity, error);
      }
      if (resolved.automaticOwnershipAvailable && !resolved.signedWalletMatchesAuthority) {
        throw Object.assign(new Error("Connected wallet is not the current token owner. Connect the owner wallet to continue."), { code: "OWNERSHIP_PROOF_REQUIRED" });
      }
      const security = await scanProjectImportSecurity(identity);
      const manualRequired = !resolved.automaticOwnershipAvailable || !securityAllowsAutomaticImport(security) || Boolean(resolved.resolverError);
      if (!manualRequired) {
        throw Object.assign(new Error("Automatic ownership and security checks pass; manual review is not required"), { code: "MANUAL_CLAIM_NOT_ALLOWED" });
      }
      if (!existing) {
        const pendingEvidence = { ...resolved, signedWalletMatchesAuthority: false };
        const created = await createProjectImport(pool, { resolverResult: pendingEvidence, signedWallet: auth.walletAddress });
        existing = created.project;
      }
      if (existing?.ownership_status === "ownership_verified") {
        throw Object.assign(new Error("Manual claim cannot overwrite a verified owner"), { code: "OWNERSHIP_CONFLICT" });
      }
      const project = await requestManualProjectClaim(pool, {
        ...identity,
        signedWallet: auth.walletAddress,
        note: manualReviewNote({ resolved, security, note }),
      });
      await enrichExistingProjectIdentity(identity, resolved);
      return json(res, 200, { project: publicProject(project), ownershipEvidence: { ...resolved, security } });
    }

    if (req.method === "PATCH" && path === "/") {
      const body = await readJson(req);
      const identity = normalizeProjectIdentity(body.chainId, body.tokenAddress);
      const existing = await lookupProjectImport(pool, identity);
      if (!existing) throw Object.assign(new Error("Imported project not found"), { code: "PROJECT_NOT_FOUND" });
      const metadata = sanitizeProjectImportMetadataPatch(body.metadata || body.patch || {});
      const auth = await strictAuth(res, body, {
        identity,
        action: PROJECT_IMPORT_ACTIONS.metadata,
        projectId: existing.id,
        intentBody: metadata,
      });
      if (!auth) return;
      const project = await patchProjectMetadata(pool, {
        ...identity,
        signedWallet: auth.walletAddress,
        patch: metadata,
      });
      return json(res, 200, { project: publicProject(project) });
    }

    return json(res, 405, { error: "Method or project-import operation not allowed" });
  } catch (error) {
    console.error("[api/projectImports]", error);
    return projectError(res, error);
  }
}
