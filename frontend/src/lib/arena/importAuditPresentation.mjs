const KNOWN_SCAN_REASONS = Object.freeze({
  not_a_contract: "No token contract was found at this address.",
  not_a_mint: "No valid Solana token mint was found at this address.",
  honeypot_sell_failed: "The automatic Topaz check could quote a buy but could not quote a sell.",
  non_transferable: "The token reports transfer restrictions that prevent normal transfers.",
  paused: "The token contract reports that transfers are paused.",
  owner_present: "The token contract still reports an owner address.",
  mint_authority_present: "The Solana mint still has a mint authority.",
  freeze_authority_present: "The Solana mint still has a freeze authority.",
  transfer_fee: "The token uses a transfer-fee mechanism.",
  transfer_tax_too_high: "The detected transfer fee is above the current automatic-check threshold.",
  permanent_delegate: "The Solana token reports a permanent delegate.",
  no_topaz_pool: "No supported Topaz pool was found by the automatic check.",
  no_meteora_pool: "A supported Meteora pool was not verified by the current automatic check.",
  topaz_env_missing: "The automatic Topaz quote check is not available in the current environment.",
  topaz_buy_quote_failed: "The automatic Topaz buy quote could not be completed.",
  rpc_failed: "The EVM network check could not be completed.",
  solana_rpc_failed: "The Solana network check could not be completed.",
  erc20_metadata_unreadable: "Required ERC-20 metadata could not be read.",
  decimals_unreadable: "Token decimals could not be read.",
  mint_decimals_unreadable: "Solana mint decimals could not be read.",
  name_unreadable: "The token name could not be read.",
  symbol_unreadable: "The token symbol could not be read.",
  supply_unreadable: "The token supply could not be read.",
  zero_supply: "The token currently reports a zero total supply.",
  getPool_failed: "The automatic Topaz pool lookup could not be completed.",
});

const AUTHORITY_OUTCOMES = new Set([
  "passed",
  "needs_review",
  "hard_failure",
  "stale",
  "rejected",
  "not_approved",
]);

function normalizedCode(value) {
  return String(value || "").trim();
}

function authorityOutcome(item) {
  const value = normalizedCode(item?.eligibility?.authorityOutcome);
  return AUTHORITY_OUTCOMES.has(value) ? value : "not_approved";
}

export function presentImportScanCode(value) {
  const code = normalizedCode(value);
  if (!code) return null;
  return {
    code,
    message: KNOWN_SCAN_REASONS[code] || `Automatic check reported: ${code.replaceAll("_", " ")}.`,
    known: Boolean(KNOWN_SCAN_REASONS[code]),
  };
}

export function presentImportScanFindings(scan) {
  const source = scan && typeof scan === "object" ? scan : {};
  const codes = [];
  for (const key of ["reasons", "warnings"]) {
    const values = Array.isArray(source[key]) ? source[key] : [];
    for (const value of values) {
      const code = normalizedCode(value);
      if (code && !codes.includes(code)) codes.push(code);
    }
  }
  return codes.map(presentImportScanCode).filter(Boolean);
}

export function importAuditPresentation(item) {
  const outcome = authorityOutcome(item);
  if (outcome === "passed") {
    return {
      title: "AUTOMATIC CHECK PASSED",
      description: "The backend reports a current approved automatic-check authority for this import. This is not a guarantee that the token is safe or risk-free.",
      tone: "passed",
    };
  }
  if (outcome === "needs_review") {
    return {
      title: "AUTOMATIC CHECK NEEDS REVIEW",
      description: "The backend reports reviewable uncertainty. A manual review request does not approve this token or make it competitively eligible.",
      tone: "review",
    };
  }
  if (outcome === "hard_failure") {
    return {
      title: "AUTOMATIC CHECK HARD FAILURE",
      description: "The backend reports a non-approved hard-failure authority. Public review requests cannot override this competition authority.",
      tone: "failed",
    };
  }
  if (outcome === "stale") {
    return {
      title: "AUTOMATIC CHECK STALE",
      description: "The backend reports that the previous scan authority is no longer current. This import is not currently eligible for new Arena competition admission.",
      tone: "review",
    };
  }
  if (outcome === "rejected") {
    return {
      title: "IMPORT NOT APPROVED",
      description: "The backend reports that this import was rejected. A public review request does not approve it.",
      tone: "failed",
    };
  }
  return {
    title: "IMPORT NOT APPROVED",
    description: "The backend does not currently report approved competition authority for this import.",
    tone: "neutral",
  };
}

export function presentImportCompetitionEligibility(item) {
  const outcome = authorityOutcome(item);
  const eligible = item?.eligibility?.eligible === true && outcome === "passed";
  const labels = {
    passed: "CURRENTLY ELIGIBLE",
    needs_review: "REVIEW REQUIRED",
    hard_failure: "HARD FAILURE",
    stale: "STALE AUTHORITY",
    rejected: "REJECTED",
    not_approved: "NOT APPROVED",
  };
  return {
    eligible,
    authorityOutcome: outcome,
    label: labels[outcome],
    code: normalizedCode(item?.eligibility?.code) || null,
    freshness: item?.eligibility?.freshness || null,
  };
}

export function sameImportOwner(connectedWallet, ownerWallet, solana = false) {
  const connected = String(connectedWallet || "").trim();
  const owner = String(ownerWallet || "").trim();
  if (!connected || !owner) return false;
  return solana ? connected === owner : connected.toLowerCase() === owner.toLowerCase();
}

export function canRequestImportManualReview(item, connectedWallet, solana = false) {
  if (!item || (item.status !== "needs_review" && item.status !== "declined")) return false;
  if (item.reviewRequestedAt) return false;
  return sameImportOwner(connectedWallet, item.ownerWallet, solana);
}
