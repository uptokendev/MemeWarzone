/**
 * Solana route profile of a wallet, for the graduation fee.
 *
 * The launchpad program pays fee slices by profile id (programs/memewarzone_solana/src/lib.rs):
 *   0 = LINKED, 1 = UNLINKED, 2 = OG.
 * Graduation uses the creator's link: linked/OG -> recruiter + squad slices, unlinked -> airdrop.
 *
 * Same query as trade signing (`resolveRouteProfile` in dev-fix/solana-trade-authorization-v1.js),
 * with one difference on purpose: a database error THROWS here instead of falling back to
 * unlinked. A graduation happens once; a silent fallback would route a recruiter's share to the
 * airdrop for good. The keeper retries a failed pass.
 */
export const SOLANA_ROUTE_PROFILE = Object.freeze({ LINKED: 0, UNLINKED: 1, OG: 2 });

export function isSolanaRouteProfile(value) {
  return value === SOLANA_ROUTE_PROFILE.LINKED
    || value === SOLANA_ROUTE_PROFILE.UNLINKED
    || value === SOLANA_ROUTE_PROFILE.OG;
}

export async function resolveSolanaRouteProfileStrict(db, walletAddress) {
  const wallet = String(walletAddress || "").trim();
  if (!db || typeof db.query !== "function") throw new Error("route profile: no database");
  if (!wallet) throw new Error("route profile: no wallet");
  const { rows } = await db.query(
    `select r.is_og
       from public.wallet_recruiter_links l
       join public.recruiters r
         on r.id = l.recruiter_id
      where l.wallet_address = $1
      limit 1`,
    [wallet],
  );
  if (!rows[0]) return SOLANA_ROUTE_PROFILE.UNLINKED;
  return rows[0].is_og ? SOLANA_ROUTE_PROFILE.OG : SOLANA_ROUTE_PROFILE.LINKED;
}
