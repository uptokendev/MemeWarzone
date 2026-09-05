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

function normalizedCode(value) {
  return String(value || "").trim();
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

export function importAuditPresentation(status) {
  if (status === "passed") {
    return {
      title: "AUTOMATIC CHECK PASSED",
      description: "This token passed the automatic checks currently implemented by MemeWarzone. This is not a guarantee that the token is safe or risk-free.",
      tone: "passed",
    };
  }
  if (status === "needs_review") {
    return {
      title: "AUTOMATIC CHECK NEEDS REVIEW",
      description: "The automatic check found one or more items that need human investigation before this import can proceed under the existing backend rules.",
      tone: "review",
    };
  }
  if (status === "declined") {
    return {
      title: "AUTOMATIC CHECK FAILED",
      description: "The automatic check found one or more conditions that prevented this import from passing. Requesting a manual check does not approve the token.",
      tone: "failed",
    };
  }
  return {
    title: "AUTOMATIC CHECK STATUS",
    description: "The current import status is provided by the MemeWarzone backend.",
    tone: "neutral",
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
