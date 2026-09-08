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
 * The storage adapter must make withIdentityLock mutually exclusive for identity.key
 * (DB transaction/advisory lock or equivalent) and keep a unique constraint on chain + token.
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
      owner_wallet: null,
      ownership_status: PROJECT_IMPORT_OWNERSHIP.unverified,
    });
    return { project, existing: false, identity };
  });
}

/**
 * Claims edit authority only after a chain resolver has independently proven currentOwnerProof.
 * All competing claims serialize on canonical identity; persistence is expected to use a
 * state/version CAS so a stale decision cannot overwrite a newer suspension/verification.
 */
export async function claimCanonicalProjectOwnership({
  store,
  chainId,
  token,
  claimantWallet,
  currentOwnerProof,
}) {
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
      expectedStateVersion: Number(project.state_version ?? project.stateVersion ?? 0),
    });
    if (!updated) {
      throw Object.assign(new Error("Project ownership changed during claim"), { code: "IMPORT_OWNER_CAS_CONFLICT" });
    }
    return { project: updated, claimed: true, replay: false, identity };
  });
}
