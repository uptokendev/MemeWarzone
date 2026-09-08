import { pool } from "../server/db.js";
import { getQuery, json, readJson } from "../server/http.js";
import { requireProjectImportAuth } from "./lib/projectImportAuth.js";
import {
  assertResolverIdentity,
  claimExistingProject,
  createProjectImport,
  listUserProjectImports,
  lookupProjectImport,
  normalizeProjectIdentity,
  patchProjectMetadata,
  requestManualProjectClaim,
} from "./lib/projectImportCore.js";
import { resolveProjectToken } from "./lib/projectImportResolvers.js";

function enabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.ENABLE_PROJECT_IMPORTS || "").trim());
}

function routePath(req) {
  return new URL(req.url, "http://localhost").pathname.replace(/^\/project-imports\/?/, "/");
}

function errorStatus(code) {
  if (["INVALID_CHAIN", "INVALID_TOKEN", "INVALID_WALLET", "NO_METADATA_FIELDS"].includes(code)) return 400;
  if (["PROJECT_NOT_FOUND"].includes(code)) return 404;
  if (["OWNERSHIP_PROOF_REQUIRED", "PROJECT_OWNER_REQUIRED"].includes(code)) return 403;
  if (["OWNERSHIP_SUSPENDED", "MANUAL_CLAIM_NOT_ALLOWED", "RESOLVER_IDENTITY_MISMATCH"].includes(code)) return 409;
  if (code === "PROJECT_IMPORT_RESOLVER_UNAVAILABLE") return 501;
  return 500;
}

function projectError(res, error) {
  const code = error?.code || "PROJECT_IMPORT_ERROR";
  return json(res, errorStatus(code), { error: String(error?.message || error), code });
}

async function signedContext(req, res, body, action, identity) {
  return requireProjectImportAuth({
    res,
    pool,
    auth: body?.auth,
    chainId: identity.chainId,
    action,
    tokenAddress: identity.tokenAddress,
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

export default async function projectImports(req, res) {
  if (!enabled()) return json(res, 404, { error: "Project imports are disabled.", code: "PROJECT_IMPORTS_DISABLED" });
  if (!pool) return json(res, 503, { error: "Project imports require DATABASE_URL." });

  try {
    const path = routePath(req);

    if (req.method === "GET" && path === "/") {
      const q = getQuery(req);
      if (q.wallet) {
        const items = await listUserProjectImports(pool, { chainId: q.chainId, walletAddress: q.wallet });
        return json(res, 200, { items });
      }
      const project = await lookupProjectImport(pool, { chainId: q.chainId, tokenAddress: q.tokenAddress });
      if (!project) return json(res, 404, { error: "Imported project not found", code: "PROJECT_NOT_FOUND" });
      return json(res, 200, { project });
    }

    if (req.method === "POST" && path === "/resolve") {
      const body = await readJson(req);
      const identity = normalizeProjectIdentity(body.chainId, body.tokenAddress);
      const auth = await signedContext(req, res, body, "project-import-resolve", identity);
      if (!auth) return;
      const resolved = await resolveForSigner(identity, auth.walletAddress);
      return json(res, 200, { resolved });
    }

    if (req.method === "POST" && path === "/") {
      const body = await readJson(req);
      const identity = normalizeProjectIdentity(body.chainId, body.tokenAddress);
      const auth = await signedContext(req, res, body, "project-import-create", identity);
      if (!auth) return;
      const resolved = await resolveForSigner(identity, auth.walletAddress);
      const result = await createProjectImport(pool, { resolverResult: resolved, signedWallet: auth.walletAddress });
      return json(res, result.created ? 201 : 200, result);
    }

    if (req.method === "POST" && path === "/claim") {
      const body = await readJson(req);
      const identity = normalizeProjectIdentity(body.chainId, body.tokenAddress);
      const auth = await signedContext(req, res, body, "project-import-claim", identity);
      if (!auth) return;
      const resolved = await resolveForSigner(identity, auth.walletAddress);
      const project = await claimExistingProject(pool, { resolverResult: resolved, signedWallet: auth.walletAddress });
      return json(res, 200, { project });
    }

    if (req.method === "POST" && path === "/manual-claim") {
      const body = await readJson(req);
      const identity = normalizeProjectIdentity(body.chainId, body.tokenAddress);
      const auth = await signedContext(req, res, body, "project-import-manual-claim", identity);
      if (!auth) return;
      const project = await requestManualProjectClaim(pool, {
        ...identity,
        signedWallet: auth.walletAddress,
        note: body.note,
      });
      return json(res, 200, { project });
    }

    if (req.method === "PATCH" && path === "/") {
      const body = await readJson(req);
      const identity = normalizeProjectIdentity(body.chainId, body.tokenAddress);
      const auth = await signedContext(req, res, body, "project-import-metadata", identity);
      if (!auth) return;
      const project = await patchProjectMetadata(pool, {
        ...identity,
        signedWallet: auth.walletAddress,
        patch: body.metadata || body.patch || {},
      });
      return json(res, 200, { project });
    }

    return json(res, 405, { error: "Method or project-import operation not allowed" });
  } catch (error) {
    console.error("[api/projectImports]", error);
    return projectError(res, error);
  }
}
