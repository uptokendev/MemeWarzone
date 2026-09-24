import { isSolanaChain } from "../../server/http.js";
import { ARENA_IMPORT_SCAN_VERSION, scanEvm, scanSolana } from "./arenaImportScan.js";

export async function scanImportedToken(chainId, token) {
  return isSolanaChain(chainId) ? scanSolana(chainId, token) : scanEvm(chainId, token);
}

export function failedAdmissionScan(error) {
  const scannedAt = new Date().toISOString();
  const message = String(error?.message || error || "scan_failed");
  return {
    status: "needs_review",
    name: null,
    symbol: null,
    scanVersion: ARENA_IMPORT_SCAN_VERSION,
    scannedAt,
    scan: {
      ok: false,
      reasons: ["scan_failed"],
      warnings: [],
      findings: [{ code: "scan_failed", message }],
      hardFindings: [],
      reviewableFindings: [{ code: "scan_failed", message }],
      scanVersion: ARENA_IMPORT_SCAN_VERSION,
      scannedAt,
      error: message,
    },
  };
}

export async function loadTrustedImportProfile(query, chainId, token) {
  try {
    const tokenPredicate = isSolanaChain(chainId) ? `token_address = $2` : `lower(token_address) = lower($2)`;
    const result = await query(
      `select logo_uri, description, website, external_url, x_account, telegram, updated_at
         from public.token_metadata_registry
        where chain_id = $1
          and token_address is not null
          and ${tokenPredicate}
        order by updated_at desc
        limit 1`,
      [chainId, token],
    );
    const row = result.rows[0];
    if (!row) return null;
    const imageUrl = String(row.logo_uri || "").trim();
    return {
      imageUrl: imageUrl && !/^data:/i.test(imageUrl) ? imageUrl : null,
      description: String(row.description || "").trim() || null,
      website: String(row.website || row.external_url || "").trim() || null,
      xUrl: String(row.x_account || "").trim() || null,
      telegramUrl: String(row.telegram || "").trim() || null,
      metadataUpdatedAt: row.updated_at || null,
    };
  } catch (error) {
    console.warn("[arenaImportAdmission] trusted metadata unavailable", error?.message || error);
    return null;
  }
}

export async function applyAdmissionScan(query, project, scan, trusted = null) {
  if (!project?.id) return project;
  const status = ["passed", "needs_review", "declined"].includes(String(scan?.status || ""))
    ? String(scan.status)
    : "needs_review";
  const result = await query(
    `update public.arena_token_imports
        set status = $2,
            scan_json = $3::jsonb,
            scan_version = $4,
            scanned_at = $5::timestamptz,
            name = coalesce(nullif(btrim(coalesce(name, '')), ''), $6),
            symbol = coalesce(nullif(btrim(coalesce(symbol, '')), ''), $7),
            image_url = coalesce(nullif(btrim(coalesce(image_url, '')), ''), $8),
            description = coalesce(nullif(btrim(coalesce(description, '')), ''), $9),
            website = coalesce(nullif(btrim(coalesce(website, '')), ''), $10),
            x_url = coalesce(nullif(btrim(coalesce(x_url, '')), ''), $11),
            telegram_url = coalesce(nullif(btrim(coalesce(telegram_url, '')), ''), $12),
            metadata_updated_at = coalesce(metadata_updated_at, $13::timestamptz, now()),
            updated_at = now()
      where id = $1::uuid
      returning *`,
    [
      project.id,
      status,
      JSON.stringify(scan?.scan || {}),
      scan?.scanVersion || ARENA_IMPORT_SCAN_VERSION,
      scan?.scannedAt || new Date().toISOString(),
      scan?.name || null,
      scan?.symbol || null,
      trusted?.imageUrl || null,
      trusted?.description || null,
      trusted?.website || null,
      trusted?.xUrl || null,
      trusted?.telegramUrl || null,
      trusted?.metadataUpdatedAt || null,
    ],
  );
  return result.rows[0] || project;
}

export async function runAdmissionScanForProject(query, project) {
  const chainId = Number(project?.chain_id || project?.chainId);
  const token = String(project?.token_address || project?.tokenAddress || "").trim();
  let scan;
  try {
    scan = await scanImportedToken(chainId, token);
  } catch (error) {
    scan = failedAdmissionScan(error);
  }
  const trusted = await loadTrustedImportProfile(query, chainId, token);
  return applyAdmissionScan(query, project, scan, trusted);
}
