// Major War League payout periods and their EVM vaults: one TreasuryVaultV2 per period per chain,
// separate from every pre-grad league vault (founder decision 2026-10-02). The MWL money reaches them
// from PostGradLeagueTreasuryV2.claimMonthly / claimQuarterly (receivers set by the Safe).
// Solana pays both periods from mwl_vault (no address needed here).

export const MWL_PAYOUT_PERIODS = Object.freeze(["mwl_monthly", "quarterly"]);
export const MWL_PAYOUT_CATEGORIES = Object.freeze({ mwl_monthly: "mwl", quarterly: "championship" });

// EVM epoch id = keccak(abi.encode(uint32 chain, uint8 code, uint64 epochStart)), as the pre-grad
// weekly vault; codes 3 and 4 never collide with pre-grad weekly (1) / monthly (2).
export const MWL_EVM_PERIOD_CODES = Object.freeze({ mwl_monthly: 3, quarterly: 4 });

// Filled in once the vaults are deployed (scripts/deploy-mwl-payout-vaults.ts); env always wins.
export const MWL_VAULT_MAINNET_DEFAULTS = Object.freeze({
  mwl_monthly: Object.freeze({}),
  quarterly: Object.freeze({}),
});

export function isMwlPayoutPeriod(period) {
  return MWL_PAYOUT_PERIODS.includes(String(period || ""));
}

export function mwlVaultEnvName(period, chainId) {
  return `${period === "quarterly" ? "MWL_QUARTERLY_VAULT_ADDRESS" : "MWL_MONTHLY_VAULT_ADDRESS"}_${Number(chainId)}`;
}

/** The EVM vault paying this MWL period on this chain, or "" when none is configured. */
export function mwlVaultAddress(period, chainId, env = process.env) {
  if (!isMwlPayoutPeriod(period)) return "";
  const explicit = String(env[mwlVaultEnvName(period, chainId)] || "").trim();
  if (explicit) return explicit;
  return String(MWL_VAULT_MAINNET_DEFAULTS[period]?.[Number(chainId)] || "");
}
