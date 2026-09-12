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
import { scanProjectImportSecurity } from "./lib/projectImportRiskSecurity.js";
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

import { assessProjectImport, assertAutomaticImport, assertNewImportMarket, importProofReceipt, isPumpFunImportToken, isRetainedImportPage } from "./lib/projectImportAssessment.js";
import { withImportTransaction, appendImportEvidence, latestImportEvidence, importEvidenceHistory } from "./lib/projectImportEvidenceStore.js";
import { applyVerifiedPumpChallenge, createPumpOwnershipChallenge, latestPumpOwnershipChallenge, pumpChallengeConnection, pumpChallengePublic, verifyPumpOwnershipChallenge } from "./lib/projectImportPumpChallenge.js";

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
  if (["PROJECT_NOT_FOUND", "IMPORT_NOT_FOUND", "PROJECT_IMPORT_CHAIN_DISABLED"].includes(code)) return 404;
  if ([
    "OWNERSHIP_PROOF_REQUIRED", "PROJECT_OWNER_REQUIRED", "IMPORT_OWNER_NOT_VERIFIED",
    "IMPORT_OWNER_MISMATCH", "PROJECT_OWNERSHIP_ADMIN_REQUIRED", "PROJECT_IMPORT_SECURITY_REQUIRED",
  ].includes(code)) return 403;
  if ([
    "OWNERSHIP_SUSPENDED", "MANUAL_CLAIM_NOT_ALLOWED", "RESOLVER_IDENTITY_MISMATCH",
    "OWNERSHIP_CONFLICT", "PROJECT_OWNERSHIP_STATE_CONFLICT", "PROJECT_OWNERSHIP_IMAGE_REQUIRED",
  ].includes(code)) return 409;
  if (String(code).startsWith("PROJECT_IMPORT_EVIDENCE") || ["PROJECT_IMPORT_SIGNED_CLAIM_REQUIRED","PROJECT_IMPORT_TECHNICAL_REVIEW","PROJECT_IMPORT_REVIEW_PROOF_REQUIRED", "PROJECT_IMPORT_MARKET_PROOF_REQUIRED","PROJECT_IMPORT_STILL_BONDING","PROJECT_IMPORT_REVIEW_REQUIRED"].includes(code)) return 409;
  if (["PROJECT_IMPORT_RESOLVER_UNAVAILABLE", "PROJECT_IMPORT_RPC_UNAVAILABLE", "PROJECT_IMPORT_CHAIN_MISMATCH"].includes(code)) return 503;
  return 500;
}

function projectError(res, error) {
  const code = error?.code || "PROJECT_IMPORT_ERROR";
  return json(res, errorStatus(code), {
    error: String(error?.message || error),
    code,
    currentAuthority: error?.currentAuthority || undefined,
    currentVersion: error?.currentVersion || undefined,
    currentOwnershipStatus: error?.currentOwnershipStatus || undefined,
  });
}

async function resolveForSigner(identity, signer, options = {}) {
  const result = await resolveProjectToken({
    chainId: identity.chainId,
    tokenAddress: identity.tokenAddress,
    signedWallet: signer,
    ...options,
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
    const address = String(resolved.currentAuthority || "");
    const masked = address.length > 8 ? `${address.slice(0, 4)}...${address.slice(-4)}` : address;
    throw Object.assign(new Error(`The connected wallet does not match the recorded creator wallet ${masked}. Connect that wallet to continue.`), { code: "OWNERSHIP_PROOF_REQUIRED", currentAuthority: address });
  }
}

function requireSecurityPass(security) {
  if (security?.status === "blocked") {
    const critical = security?.criticalRisks?.map((risk) => risk.label).filter(Boolean) || [];
    throw Object.assign(new Error(critical.length ? `Token security check blocked automatic import: ${critical.slice(0, 3).join("; ")}` : "Token security check blocked automatic import"), { code: "PROJECT_IMPORT_SECURITY_REQUIRED" });
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
       AND (((name IS NULL OR btrim(name) = '') AND $3::text IS NOT NULL)
         OR ((symbol IS NULL OR btrim(symbol) = '') AND $4::text IS NOT NULL))
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

async function attachAdminEvidence(row) {
  if (!row) return row;
  const evidence = await latestImportEvidence(pool, row);
  return { ...row, import_evidence: evidence?.snapshot || null, import_evidence_id: evidence?.id || null };
}
async function buildImportChecks(identity, signer, authPayload, fallback = false, { registrationOnly = false } = {}) {
  let resolved;
  try { resolved = await resolveForSigner(identity, signer, { registrationOnly }); }
  catch (error) { if (!fallback || !canFallbackToManual(error)) throw error; resolved = unresolvedEvidence(identity, error); }
  if (!registrationOnly) resolved = await applyVerifiedPumpChallenge(pool, identity, signer, resolved);
  const security = await scanProjectImportSecurity({ ...identity, market: resolved.market, custody: resolved.custody });
  const proof = authPayload ? importProofReceipt({ ...authPayload, walletAddress: signer }) : null;
  const assessment = assessProjectImport({ resolved, security, claimantWallet: signer, proof });
  return { resolved, security, assessment };
}

async function handleOwnershipAdmin(req, res, path) {
  const admin = await requireDashboardAdmin(req, res);
  if (!admin) return true;

  if (req.method === "GET" && path === "/admin/ownership-claims") {
    const rows = await listProjectOwnershipClaims(pool);
    return json(res, 200, { items: (await Promise.all(rows.map(attachAdminEvidence))).map(projectOwnershipClaimItem) });
  }

  const detailMatch = path.match(/^\/admin\/ownership-claims\/([0-9a-f-]+)$/i);
  if (req.method === "GET" && detailMatch) {
    const row = await getProjectOwnershipClaim(pool, detailMatch[1]);
    if (!row) return json(res, 404, { error: "Imported project not found", code: "PROJECT_NOT_FOUND" });
    const history = await getProjectOwnershipAudit(pool, detailMatch[1]);
    return json(res, 200, { item: projectOwnershipClaimItem(await attachAdminEvidence(row)), history, evidenceHistory: await importEvidenceHistory(pool, row.id) });
  }

  const followupMatch = path.match(/^\/admin\/ownership-claims\/([0-9a-f-]+)\/(request-info|escalate)$/i);
  if (req.method === "POST" && followupMatch) {
    const body=await readJson(req),reason=String(body.reason||"").trim().slice(0,1000);
    if(reason.length<3)return json(res,400,{error:"An operator reason is required",code:"PROJECT_OWNERSHIP_REASON_REQUIRED"});
    await withImportTransaction(pool,async client=>{
      const found=await client.query("SELECT *,xmin::text AS state_version FROM public.arena_token_imports WHERE id=$1 FOR UPDATE",[followupMatch[1]]);
      const current=found.rows[0];
      if(!current||current.state_version!==String(body.expectedVersion||""))throw Object.assign(new Error("Claim changed; reload before recording follow-up"),{code:"PROJECT_OWNERSHIP_STATE_CONFLICT"});
      const before=projectOwnershipClaimItem(current);
      await client.query("UPDATE public.arena_token_imports SET updated_at=NOW() WHERE id=$1",[current.id]);
      await client.query("INSERT INTO public.wm_admin_audit_log(admin_user_id,action,target_type,target_id,before,after) VALUES(NULL,$1,'project_ownership_claim',$2,$3::jsonb,$4::jsonb)",[followupMatch[2],current.id,JSON.stringify(before),JSON.stringify({...before,operatorAuthUserId:admin.id,operatorEmail:admin.email||null,operatorReason:reason})]);
    });
    return json(res,200,{recorded:true,notificationSent:false});
  }

  const recheckMatch = path.match(/^\/admin\/ownership-claims\/([0-9a-f-]+)\/recheck$/i);
  if (req.method === "POST" && recheckMatch) {
    const body = await readJson(req);
    const current = await getProjectOwnershipClaim(pool, recheckMatch[1]);
    if (!current) return json(res,404,{error:"Imported project not found",code:"PROJECT_NOT_FOUND"});
    if (!body.expectedVersion || String(body.expectedVersion) !== current.state_version || String(body.reason||"").trim().length < 3) return json(res,409,{error:"Reload the claim and supply an operator reason",code:"PROJECT_OWNERSHIP_STATE_CONFLICT"});
    const claimant = current.manual_claim_wallet || current.project_owner_wallet;
    if (!claimant) return json(res,409,{error:"No current claimant to recheck",code:"MANUAL_CLAIM_NOT_ALLOWED"});
    const previous = await latestImportEvidence(pool,current);
    const checks = await buildImportChecks(normalizeProjectIdentity(current.chain_id,current.token_address),claimant,null,true);
    checks.assessment.proof = previous?.snapshot?.proof || null;
    await withImportTransaction(pool,async client=>{
      const locked = await client.query("SELECT *, xmin::text AS state_version FROM public.arena_token_imports WHERE id=$1 FOR UPDATE",[current.id]);
      if (locked.rows[0]?.state_version !== String(body.expectedVersion)) throw Object.assign(new Error("Claim changed during recheck"),{code:"PROJECT_OWNERSHIP_STATE_CONFLICT"});
      const saved=await appendImportEvidence(client,{project:locked.rows[0],assessment:checks.assessment,source:"admin_recheck"});
      await client.query("UPDATE public.arena_token_imports SET updated_at=NOW() WHERE id=$1",[current.id]);
      await client.query("INSERT INTO public.wm_admin_audit_log(admin_user_id,action,target_type,target_id,before,after) VALUES(NULL,'recheck','project_ownership_claim',$1,$2::jsonb,$3::jsonb)",[current.id,JSON.stringify({evidenceId:previous?.id||null}),JSON.stringify({evidenceId:saved.id,operatorAuthUserId:admin.id,operatorEmail:admin.email||null,operatorReason:String(body.reason).slice(0,1000)})]);
    });
    const row=await getProjectOwnershipClaim(pool,current.id);
    return json(res,200,{item:projectOwnershipClaimItem(await attachAdminEvidence(row))});
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
      expectedEvidenceId: body.expectedEvidenceId,
      reviewProof: body.reviewProof,
      admin,
    });
    if (action === "verify_owner") await refreshVerifiedProjectIdentityBestEffort(updated);
    return json(res, 200, { item: projectOwnershipClaimItem(await attachAdminEvidence(updated)) });
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
        return json(res, 200, { found: Boolean(project), project: publicProject(project) });
      }
      const items = await listRecentProjectImports(pool, { limit: q.limit || 24 });
      return json(res, 200, { items: items.map(publicProject) });
    }

    if (req.method === "POST" && path === "/pump-challenge") {
      const body = await readJson(req);
      const identity = normalizeProjectIdentity(body.chainId, body.tokenAddress);
      if (identity.chainId !== 101) throw Object.assign(new Error("Pump.fun wallet verification is only available on Solana."), { code: "INVALID_CHAIN" });
      const auth = await strictAuth(res, body, { identity, action: PROJECT_IMPORT_ACTIONS.pumpChallengeStart });
      if (!auth) return;
      const resolved = await resolveForSigner(identity, auth.walletAddress);
      if (resolved?.authoritySource !== "pump_bonding_curve_creator" || !resolved?.currentAuthority) throw Object.assign(new Error("A signable Pump.fun creator wallet could not be established for this token."), { code: "PROJECT_IMPORT_PUMP_CHALLENGE_UNAVAILABLE" });
      if (resolved.signedWalletMatchesAuthority) throw Object.assign(new Error("This wallet already matches the Pump.fun creator wallet."), { code: "PROJECT_IMPORT_PUMP_CHALLENGE_NOT_NEEDED" });
      const challenge = await createPumpOwnershipChallenge(pool, { tokenAddress: identity.tokenAddress, creatorWallet: resolved.currentAuthority, claimantWallet: auth.walletAddress });
      return json(res, 201, { challenge: pumpChallengePublic(challenge) });
    }

    if (req.method === "POST" && path === "/pump-challenge/check") {
      const body = await readJson(req);
      const identity = normalizeProjectIdentity(body.chainId, body.tokenAddress);
      if (identity.chainId !== 101) throw Object.assign(new Error("Pump.fun wallet verification is only available on Solana."), { code: "INVALID_CHAIN" });
      const intentBody = { challengeId: String(body.challengeId || "") };
      const auth = await strictAuth(res, body, { identity, action: PROJECT_IMPORT_ACTIONS.pumpChallengeCheck, intentBody });
      if (!auth) return;
      const challenge = await latestPumpOwnershipChallenge(pool, { tokenAddress: identity.tokenAddress, claimantWallet: auth.walletAddress });
      if (!challenge || challenge.id !== intentBody.challengeId) throw Object.assign(new Error("Verification challenge not found. Start a new one."), { code: "PROJECT_IMPORT_PUMP_CHALLENGE_NOT_FOUND" });
      const current = await resolveForSigner(identity, auth.walletAddress);
      if (current?.authoritySource !== "pump_bonding_curve_creator" || current?.currentAuthority !== challenge.creator_wallet) throw Object.assign(new Error("The Pump.fun creator record changed. Start verification again."), { code: "PROJECT_IMPORT_PUMP_CREATOR_CHANGED" });
      const verified = await verifyPumpOwnershipChallenge(pool, challenge, pumpChallengeConnection());
      const { resolved, security, assessment } = await buildImportChecks(identity, auth.walletAddress, body.auth, true);
      const project = await enrichExistingProjectIdentity(identity, resolved) || await lookupProjectImport(pool, identity);
      return json(res, 200, { challenge: pumpChallengePublic(verified), resolved: { ...resolved, security, assessment, retainedPageOnly: isRetainedImportPage(project) }, project: publicProject(project) });
    }

    if (req.method === "POST" && path === "/resolve") {
      const body = await readJson(req);
      const identity = normalizeProjectIdentity(body.chainId, body.tokenAddress);
      const auth = await strictAuth(res, body, { identity, action: PROJECT_IMPORT_ACTIONS.resolve });
      if (!auth) return;
      const {resolved,security,assessment} = await buildImportChecks(identity,auth.walletAddress,body.auth,true);
      const project = await enrichExistingProjectIdentity(identity, resolved) || await lookupProjectImport(pool, identity);
      return json(res, 200, { resolved: { ...resolved, security, assessment, retainedPageOnly: isRetainedImportPage(project) }, project: publicProject(project) });
    }

    if (req.method === "POST" && path === "/") {
      const body = await readJson(req);
      const identity = normalizeProjectIdentity(body.chainId, body.tokenAddress);
      const intentBody = { operation: "create" };
      const auth = await strictAuth(res, body, { identity, action: PROJECT_IMPORT_ACTIONS.create, intentBody });
      if (!auth) return;
      const {resolved,security,assessment} = await buildImportChecks(identity,auth.walletAddress,body.auth,false,{registrationOnly:true});
      assertNewImportMarket(resolved);
      requireSecurityPass(security);
      const result = await withImportTransaction(pool,async client=>{
        const result=await createProjectImport(client,{resolverResult:{...resolved,signedWalletMatchesAuthority:false},signedWallet:auth.walletAddress});
        if(result.created) await appendImportEvidence(client,{project:result.project,assessment,source:"permissionless_import"});
        return result;
      });
      return json(res,result.created?201:200,{...result,project:publicProject(result.project),ownershipEvidence:{...resolved,security,assessment}});
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
      const {resolved,security,assessment} = await buildImportChecks(identity,auth.walletAddress,body.auth);
      assertNewImportMarket(resolved); requireResolvedOwner(resolved); requireSecurityPass(security); assertAutomaticImport(assessment);
      const project=await withImportTransaction(pool,async client=>{
        const claimed=await claimExistingProject(client,{resolverResult:resolved,signedWallet:auth.walletAddress});
        await appendImportEvidence(client,{project:claimed,assessment,source:"owner_claim"}); return claimed;
      });
      await enrichExistingProjectIdentity(identity,resolved);
      return json(res,200,{project:publicProject(project)});
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
      const {resolved,security,assessment} = await buildImportChecks(identity,auth.walletAddress,body.auth,true);
      assertNewImportMarket(resolved);
      const pumpCreatorMismatch = resolved.automaticOwnershipAvailable === true && !resolved.signedWalletMatchesAuthority && isPumpFunImportToken(resolved);
      if (resolved.automaticOwnershipAvailable && !resolved.signedWalletMatchesAuthority && !pumpCreatorMismatch) requireResolvedOwner(resolved);
      if (!assessment.manualRequestAllowed && !(existing?.ownership_status === "ownership_manual_review" && existing.manual_claim_wallet === auth.walletAddress)) throw Object.assign(new Error("Use the normal verified import flow"),{code:"MANUAL_CLAIM_NOT_ALLOWED"});
      const project=await withImportTransaction(pool,async client=>{
        const created=await createProjectImport(client,{resolverResult:{...resolved,signedWalletMatchesAuthority:false},signedWallet:auth.walletAddress});
        const locked=await client.query("SELECT * FROM public.arena_token_imports WHERE id=$1 FOR UPDATE",[created.project.id]);
        const current=locked.rows[0];
        if(current.ownership_status==='ownership_manual_review'&&current.manual_claim_wallet===auth.walletAddress){
          await appendImportEvidence(client,{project:current,assessment,source:"signed_recheck"});
          await client.query("UPDATE public.arena_token_imports SET updated_at=NOW() WHERE id=$1",[current.id]); return current;
        }
        const claimed=await requestManualProjectClaim(client,{...identity,signedWallet:auth.walletAddress,note:manualReviewNote({resolved,security,note})});
        await appendImportEvidence(client,{project:claimed,assessment,source:"manual_claim"}); return claimed;
      });
      await enrichExistingProjectIdentity(identity,resolved);
      return json(res,200,{project:publicProject(project),ownershipEvidence:{...resolved,security,assessment}});
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
