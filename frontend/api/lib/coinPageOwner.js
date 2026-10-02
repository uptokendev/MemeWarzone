/**
 * Who may edit a coin page: the verified owner of an imported coin, else the creator of a launched
 * coin. Same rule as storyOwner in api/story.js (copied here so story.js stays untouched).
 */
export const isSolanaChain = (chainId) => Number(chainId) === 101;

/** Canonical token identity: Solana base58 as given, EVM lowercased; "" when malformed. */
export function coinIdent(chainId, token) {
  const t = String(token || "").trim();
  if (isSolanaChain(chainId)) return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t) ? t : "";
  return /^0x[a-fA-F0-9]{40}$/.test(t) ? t.toLowerCase() : "";
}

/** @returns {Promise<{ wallet: string, token: string, origin: "launched" | "imported" } | null>} */
export async function coinPageOwner(pool, chainId, token) {
  const match = isSolanaChain(chainId) ? "token_address = $2" : "lower(token_address) = lower($2)";
  const imp = (await pool.query(
    `select token_address, project_owner_wallet, ownership_status from public.arena_token_imports where chain_id = $1 and ${match} limit 1`,
    [chainId, token],
  )).rows[0];
  if (imp) {
    return imp.ownership_status === "ownership_verified" && imp.project_owner_wallet
      ? { wallet: String(imp.project_owner_wallet), token: String(imp.token_address), origin: "imported" }
      : null;
  }
  const camp = (await pool.query(
    `select token_address, campaign_address, creator_address from public.campaigns where chain_id = $1 and (${
      isSolanaChain(chainId)
        ? "token_address = $2 or campaign_address = $2"
        : "lower(token_address) = lower($2) or lower(campaign_address) = lower($2)"
    }) limit 1`,
    [chainId, token],
  )).rows[0];
  return camp?.creator_address
    ? { wallet: String(camp.creator_address), token: String(camp.token_address || camp.campaign_address), origin: "launched" }
    : null;
}
