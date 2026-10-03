// Major War League payout periods and their EVM vaults: one TreasuryVaultV2 per period per chain,
// separate from every pre-grad league vault (founder decision 2026-10-02). The MWL money reaches them
// from PostGradLeagueTreasuryV2.claimMonthly / claimQuarterly (receivers set by the Safe).
// Solana pays both periods from mwl_vault (no address needed here).

export const MWL_PAYOUT_PERIODS = Object.freeze(["mwl_monthly", "quarterly"]);
export const MWL_PAYOUT_CATEGORIES = Object.freeze({ mwl_monthly: "mwl", quarterly: "championship" });

// EVM epoch id = keccak(abi.encode(uint32 chain, uint8 code, uint64 epochStart)), as the pre-grad
// weekly vault; codes 3 and 4 never collide with pre-grad weekly (1) / monthly (2).
export const MWL_EVM_PERIOD_CODES = Object.freeze({ mwl_monthly: 3, quarterly: 4 });

// Deployed 2026-10-02 by scripts/deploy-mwl-payout-vaults.ts, read back from chain (code == artifact
// with the immutable multisig = Safe; operator 0; rootPoster = payout operator). Env always wins.
// Note: 0xC46D33FC... on BNB is NOT the Robinhood stock campaign implementation at the same address
// (same deployer nonce on another chain): always pair an address with its chain.
export const MWL_VAULT_MAINNET_DEFAULTS = Object.freeze({
  mwl_monthly: Object.freeze({ 56: "0xC46D33FCce7030627254278716d4AEb536Cf46FF", 4663: "0xa20388579323e22076b07e89Ac916aE6Ff91A0E0" }),
  quarterly: Object.freeze({ 56: "0xa83d8194C367f2d3eA7B3963f50d579efD8a2218", 4663: "0xA2f8e9C7aaeeECaa78D070FEe64CB54427d5291e" }),
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
