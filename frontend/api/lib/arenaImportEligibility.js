import { ARENA_IMPORT_SCAN_VERSION, FINDING_AUTHORITY, classifyFinding } from "./arenaImportScan.js";

const DEFAULT_MAX_SCAN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function maxScanAgeMs() {
  const configuredHours = Number(process.env.ARENA_IMPORT_SCAN_MAX_AGE_HOURS || 168);
  if (!Number.isFinite(configuredHours) || configuredHours <= 0) return DEFAULT_MAX_SCAN_AGE_MS;
  return configuredHours * 60 * 60 * 1000;
}

function scanObject(row) {
  return row?.scan_json && typeof row.scan_json === "object" ? row.scan_json : {};
}

export function hasNonOverridableFinding(row) {
  const scan = scanObject(row);
  const findings = Array.isArray(scan.findings) ? [...scan.findings] : [];
  // Pre-v2 evidence stored only reason codes. Re-classify that immutable evidence so
  // an old hard failure cannot be manually upgraded merely because it predates v2.
  if (Array.isArray(scan.reasons)) {
    for (const reason of scan.reasons) findings.push(classifyFinding(reason));
  }
  return findings.some((finding) => finding?.authority === FINDING_AUTHORITY.NON_OVERRIDABLE);
}

export function importScanFreshness(row, now = new Date()) {
  const scan = scanObject(row);
  const scanVersion = String(row?.scan_version || scan.scanVersion || "");
  const scannedAtRaw = row?.scanned_at || scan.scannedAt || null;
  const scannedAt = scannedAtRaw ? new Date(scannedAtRaw) : null;
  const validTimestamp = scannedAt && Number.isFinite(scannedAt.getTime());
  const ageMs = validTimestamp ? Math.max(0, now.getTime() - scannedAt.getTime()) : Number.POSITIVE_INFINITY;
  const currentVersion = scanVersion === ARENA_IMPORT_SCAN_VERSION;
  const fresh = currentVersion && validTimestamp && ageMs <= maxScanAgeMs();
  return {
    fresh,
    stale: !fresh,
    scanVersion: scanVersion || null,
    expectedScanVersion: ARENA_IMPORT_SCAN_VERSION,
    scannedAt: validTimestamp ? scannedAt.toISOString() : null,
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
    maxAgeMs: maxScanAgeMs(),
  };
}

export function evaluateImportedCompetitionEligibility(row, now = new Date()) {
  if (!row) {
    return { eligible: false, code: "IMPORT_NOT_FOUND", status: null, freshness: null, stateVersion: null };
  }
  const status = String(row.status || "");
  const freshness = importScanFreshness(row, now);
  if (hasNonOverridableFinding(row)) {
    return { eligible: false, code: "IMPORT_NON_OVERRIDABLE_FINDING", status, freshness, stateVersion: Number(row.state_version || 0) };
  }
  if (status === "declined") {
    return { eligible: false, code: "IMPORT_REJECTED", status, freshness, stateVersion: Number(row.state_version || 0) };
  }
  if (status !== "passed") {
    return { eligible: false, code: status === "needs_review" ? "IMPORT_REVIEW_REQUIRED" : "IMPORT_NOT_APPROVED", status, freshness, stateVersion: Number(row.state_version || 0) };
  }
  if (!freshness.fresh) {
    return { eligible: false, code: "IMPORT_SCAN_STALE", status: "stale", freshness, stateVersion: Number(row.state_version || 0) };
  }
  return { eligible: true, code: "IMPORT_ELIGIBLE", status, freshness, stateVersion: Number(row.state_version || 0) };
}

export async function loadImportedCompetitionEligibility(pool, chainId, tokenAddress, { now = new Date(), exactAddress = false } = {}) {
  const tokenPredicate = exactAddress ? "token_address = $2" : "lower(token_address) = lower($2)";
  const result = await pool.query(
    `select * from public.arena_token_imports
      where chain_id = $1 and ${tokenPredicate}
      order by updated_at desc
      limit 1`,
    [Number(chainId), String(tokenAddress || "")],
  );
  const row = result.rows[0] || null;
  return { row, eligibility: evaluateImportedCompetitionEligibility(row, now) };
}

export function importedCreatorEconomicsAllowed() {
  return false;
}
