import {
  PROJECT_IMPORT_OWNERSHIP,
  canonicalProjectImportIdentity,
  ownershipClaimDecision,
} from "./projectImportSecurity.js";

function requireStore(store) {
  const required = ["withIdentityLock", "findByIdentity", "insertCanonical", "persistVerifiedOwner"];
  for (const method of required) {
    if (!store || typeof store[method] !== "function") {
      throw Object.assign(new Error(`Project import store is missing ${method}`), { code: "IMPORT_STORE_INVALID" });
    }
  }
}

/**
 * Creates at most one canonical project row for chain + token/mint.
 * The importer is audit attribution only. It is deliberately NOT edit authority.
 * The storage adapter must serialize identity.key and retain Agent 1's unique
 * (chain_id, token_address) index as the final duplicate backstop.
 */
export async function createCanonicalProjectImport({ store, chainId, token, importerWallet, seed = {} }) {
  requireStore(store);
  const identity = canonicalProjectImportIdentity(chainId, token);
  return store.withIdentityLock(identity.key, async () => {
    const existing = await store.findByIdentity(identity);
    if (existing) return { project: existing, existing: true, identity };
    const project = await store.insertCanonical({
      ...seed,
      chain_id: identity.chainId,
      token_address: identity.token,
      imported_by_wallet: String(importerWallet || "").trim() || null,
      project_owner_wallet: null,
      ownership_status: PROJECT_IMPORT_OWNERSHIP.pending,
    });
    return { project, existing: false, identity };
  });
}

/**
 * Claims edit authority only after a chain resolver has independently proven currentOwnerProof.
 * Competing claims serialize on canonical identity. The adapter receives the current owner/status
 * as compare-and-set inputs so suspension or a concurrent owner transition cannot be overwritten.
 */
export async function claimCanonicalProjectOwnership({ store, chainId, token, claimantWallet, currentOwnerProof }) {
  requireStore(store);
  const identity = canonicalProjectImportIdentity(chainId, token);
  return store.withIdentityLock(identity.key, async () => {
    const project = await store.findByIdentity(identity);
    const decision = ownershipClaimDecision(project, {
      claimantWallet,
      currentOwnerProof,
      chainId: identity.chainId,
      token: identity.token,
    });
    if (decision.outcome === "already_verified") {
      return { project, claimed: false, replay: true, identity };
    }
    const updated = await store.persistVerifiedOwner({
      project,
      identity,
      ownerWallet: decision.ownerWallet,
      expectedOwnershipStatus: project.ownership_status ?? project.ownershipStatus,
      expectedOwnerWallet: project.project_owner_wallet ?? project.projectOwnerWallet ?? null,
    });
    if (!updated) {
      throw Object.assign(new Error("Project ownership changed during claim"), { code: "IMPORT_OWNER_CAS_CONFLICT" });
    }
    return { project: updated, claimed: true, replay: false, identity };
  });
}
