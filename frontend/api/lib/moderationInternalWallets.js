// Internal wallets for the moderation view: the one owner/internal list in
// shared/ownerWallets.mjs (also used to leave these wallets out of league
// winners, airdrops and recruiter credit). Kept as its own module so the
// moderation code and its tests keep their imports.
//
// Extra wallets without a deploy: OWNER_WALLETS or MODERATION_INTERNAL_WALLETS
// (comma separated, optional "address:label").

import { OWNER_WALLETS, ownerWalletIndex } from "../../shared/ownerWallets.mjs";

export const INTERNAL_WALLETS = OWNER_WALLETS;

/**
 * Map of lower-cased address -> { address, chain, label }. Lower-cased on
 * purpose: recruiters.wallet_address stores Solana keys lower-cased, so a
 * case-sensitive compare would miss them.
 */
export function internalWalletIndex(env = process.env) {
  return ownerWalletIndex(env);
}
