import { normalizeAddress } from "../../server/http.js";

export function normalizeProjectIdentity(chainId, tokenAddress) {
  const id = Number(chainId);
  if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error("Invalid chain id"), { code: "INVALID_CHAIN" });
  const token = normalizeAddress(tokenAddress, id);
  if (!token) throw Object.assign(new Error("Invalid token address or mint"), { code: "INVALID_TOKEN" });
  return { chainId: id, tokenAddress: token };
}

function normalizeWallet(walletAddress, chainId) {
  const wallet = normalizeAddress(walletAddress, chainId);
  if (!wallet) throw Object.assign(new Error("Invalid wallet"), { code: "INVALID_WALLET" });
  return wallet;
}

export function assertResolverIdentity(requested, resolved) {
  const canonical = normalizeProjectIdentity(resolved?.chainId, resolved?.tokenAddress);
  if (canonical.chainId !== requested.chainId || canonical.tokenAddress !== requested.tokenAddress) {
    throw Object.assign(new Error("Resolver returned a different project identity"), { code: "RESOLVER_IDENTITY_MISMATCH" });
  }
  return canonical;
}

export function ownershipFromResolver(result, signedWallet) {
  if (result?.signedWalletMatchesAuthority) {
    return { ownershipStatus: "ownership_verified", projectOwnerWallet: signedWallet };
  }
  if (result?.automaticOwnershipAvailable === false || !result?.currentAuthority) {
    return { ownershipStatus: "ownership_manual_review", projectOwnerWallet: null };
  }
  return { ownershipStatus: "ownership_pending", projectOwnerWallet: null };
}

export async function createProjectImport(pool, { resolverResult, signedWallet }) {
  const identity = normalizeProjectIdentity(resolverResult?.chainId, resolverResult?.tokenAddress);
  const signer = normalizeWallet(signedWallet, identity.chainId);
  const ownership = ownershipFromResolver(resolverResult, signer);
  const result = await pool.query(
    `INSERT INTO public.arena_token_imports (
       chain_id, token_address, owner_wallet, imported_by_wallet, project_owner_wallet,
       name, symbol, decimals, ownership_status, verified_at, metadata_updated_at
     ) VALUES ($1,$2,'',$3,$4,$5,$6,$7,$8,
       CASE WHEN $8 = 'ownership_verified' THEN NOW() ELSE NULL END, NOW())
     ON CONFLICT (chain_id, token_address) DO NOTHING
     RETURNING *`,
    [
      identity.chainId,
      identity.tokenAddress,
      signer,
      ownership.projectOwnerWallet,
      resolverResult?.name ?? null,
      resolverResult?.symbol ?? null,
      Number.isFinite(Number(resolverResult?.decimals)) ? Number(resolverResult.decimals) : null,
      ownership.ownershipStatus,
    ],
  );
  if (result.rows?.[0]) return { created: true, project: result.rows[0] };
  const existing = await lookupProjectImport(pool, identity);
  return { created: false, project: existing };
}

export async function lookupProjectImport(pool, { chainId, tokenAddress }) {
  const identity = normalizeProjectIdentity(chainId, tokenAddress);
  const result = await pool.query(
    `SELECT * FROM public.arena_token_imports WHERE chain_id=$1 AND token_address=$2 LIMIT 1`,
    [identity.chainId, identity.tokenAddress],
  );
  return result.rows?.[0] || null;
}

export async function listUserProjectImports(pool, { chainId, walletAddress }) {
  const id = Number(chainId);
  const wallet = normalizeWallet(walletAddress, id);
  const result = await pool.query(
    `SELECT * FROM public.arena_token_imports
      WHERE chain_id=$1
        AND (imported_by_wallet=$2 OR project_owner_wallet=$2 OR manual_claim_wallet=$2)
      ORDER BY metadata_updated_at DESC, created_at DESC`,
    [id, wallet],
  );
  return result.rows || [];
}

export async function claimExistingProject(pool, { resolverResult, signedWallet }) {
  const identity = normalizeProjectIdentity(resolverResult?.chainId, resolverResult?.tokenAddress);
  const signer = normalizeWallet(signedWallet, identity.chainId);
  if (!resolverResult?.signedWalletMatchesAuthority) {
    throw Object.assign(new Error("Current authority proof does not match signed wallet"), { code: "OWNERSHIP_PROOF_REQUIRED" });
  }
  const result = await pool.query(
    `UPDATE public.arena_token_imports
        SET project_owner_wallet=$3,
            ownership_status='ownership_verified',
            verified_at=NOW(),
            metadata_updated_at=NOW(),
            updated_at=NOW()
      WHERE chain_id=$1
        AND token_address=$2
        AND ownership_status <> 'ownership_suspended'
      RETURNING *`,
    [identity.chainId, identity.tokenAddress, signer],
  );
  if (!result.rows?.[0]) {
    const existing = await lookupProjectImport(pool, identity);
    if (!existing) throw Object.assign(new Error("Imported project not found"), { code: "PROJECT_NOT_FOUND" });
    throw Object.assign(new Error("Project ownership is suspended"), { code: "OWNERSHIP_SUSPENDED" });
  }
  return result.rows[0];
}

export async function requestManualProjectClaim(pool, { chainId, tokenAddress, signedWallet, note = null }) {
  const identity = normalizeProjectIdentity(chainId, tokenAddress);
  const signer = normalizeWallet(signedWallet, identity.chainId);
  const result = await pool.query(
    `UPDATE public.arena_token_imports
        SET manual_claim_wallet=$3,
            manual_claim_requested_at=NOW(),
            manual_claim_note=$4,
            ownership_status='ownership_manual_review',
            metadata_updated_at=NOW(),
            updated_at=NOW()
      WHERE chain_id=$1
        AND token_address=$2
        AND ownership_status NOT IN ('ownership_verified','ownership_suspended')
      RETURNING *`,
    [identity.chainId, identity.tokenAddress, signer, note == null ? null : String(note).slice(0, 1000)],
  );
  if (result.rows?.[0]) return result.rows[0];
  const existing = await lookupProjectImport(pool, identity);
  if (!existing) throw Object.assign(new Error("Imported project not found"), { code: "PROJECT_NOT_FOUND" });
  throw Object.assign(new Error("Manual ownership review is not available for this project state"), { code: "MANUAL_CLAIM_NOT_ALLOWED" });
}

const METADATA_FIELDS = ["description", "website", "x_url", "telegram_url"];

export async function patchProjectMetadata(pool, { chainId, tokenAddress, signedWallet, patch }) {
  const identity = normalizeProjectIdentity(chainId, tokenAddress);
  const signer = normalizeWallet(signedWallet, identity.chainId);
  const values = {};
  for (const field of METADATA_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch || {}, field)) {
      const raw = patch[field];
      values[field] = raw == null || String(raw).trim() === "" ? null : String(raw).trim().slice(0, 2048);
    }
  }
  if (Object.keys(values).length === 0) {
    throw Object.assign(new Error("No mutable metadata fields supplied"), { code: "NO_METADATA_FIELDS" });
  }
  const result = await pool.query(
    `UPDATE public.arena_token_imports
        SET description = CASE WHEN $4::boolean THEN $5 ELSE description END,
            website = CASE WHEN $6::boolean THEN $7 ELSE website END,
            x_url = CASE WHEN $8::boolean THEN $9 ELSE x_url END,
            telegram_url = CASE WHEN $10::boolean THEN $11 ELSE telegram_url END,
            metadata_updated_at=NOW(),
            updated_at=NOW()
      WHERE chain_id=$1
        AND token_address=$2
        AND project_owner_wallet=$3
        AND ownership_status='ownership_verified'
      RETURNING *`,
    [
      identity.chainId,
      identity.tokenAddress,
      signer,
      Object.hasOwn(values, "description"), values.description ?? null,
      Object.hasOwn(values, "website"), values.website ?? null,
      Object.hasOwn(values, "x_url"), values.x_url ?? null,
      Object.hasOwn(values, "telegram_url"), values.telegram_url ?? null,
    ],
  );
  if (result.rows?.[0]) return result.rows[0];
  const existing = await lookupProjectImport(pool, identity);
  if (!existing) throw Object.assign(new Error("Imported project not found"), { code: "PROJECT_NOT_FOUND" });
  throw Object.assign(new Error("Verified project owner required"), { code: "PROJECT_OWNER_REQUIRED" });
}
