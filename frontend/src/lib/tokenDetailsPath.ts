/**
 * Canonical public Token Details route uses token mint/address when known.
 * Bonding / market APIs still key by campaign internally — resolve first.
 *
 * CRITICAL: Solana base58 is case-sensitive. Never .toLowerCase() Solana ids.
 * Lowercasing turns allowed base58 `L` into forbidden `l` and breaks TokenDetails.
 */

export function normalizeEvmAddress(value: unknown): string {
  const raw = String(value ?? "").trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(raw) ? raw : "";
}

export function isSolanaBase58Address(value: unknown): boolean {
  const raw = String(value ?? "").trim();
  return raw.length >= 32 && raw.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(raw) && !raw.startsWith("0x");
}

/**
 * Detect addresses that look Solana-length but are invalid base58 —
 * typically after a mistaken .toLowerCase() (L→l, O→o, I→i, 0).
 */
export function isMaybeDamagedSolanaAddress(value: unknown): boolean {
  const raw = String(value ?? "").trim();
  if (!raw || raw.startsWith("0x")) return false;
  if (raw.length < 32 || raw.length > 48) return false;
  if (isSolanaBase58Address(raw)) return false;
  return /^[0-9A-Za-z]+$/.test(raw);
}

/** True if this should use the Solana TokenDetails path (valid or damaged base58). */
export function isSolanaTokenRouteId(value: unknown): boolean {
  return isSolanaBase58Address(value) || isMaybeDamagedSolanaAddress(value);
}

/**
 * Normalize for route storage / display:
 * - Solana: preserve exact case (even if damaged — recovery happens on TokenDetails)
 * - EVM: lowercase
 */
export function normalizeTokenRouteAddress(value: unknown, chainId?: number | null): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (Number(chainId) === 101 || Number(chainId) === 102 || isSolanaTokenRouteId(raw)) {
    if (isSolanaBase58Address(raw) || isMaybeDamagedSolanaAddress(raw)) return raw;
    return "";
  }
  return normalizeEvmAddress(raw);
}

/**
 * Build `/token/:tokenAddress` for navigation.
 * Prefer tokenAddress; fall back to campaign only when token is unknown.
 * Always attach chainId for Solana (101) so TokenDetails does not default to EVM.
 *
 * ALWAYS use this instead of `/token/${addr.toLowerCase()}`.
 */
export function tokenDetailsPath(
  tokenOrCampaign: {
    tokenAddress?: string | null;
    token?: string | null;
    campaignAddress?: string | null;
    campaign?: string | null;
    chainId?: number | null;
  },
  options?: { chainId?: number; search?: string },
): string {
  const chainId = Number(options?.chainId ?? tokenOrCampaign.chainId ?? 0);
  const isSolana = chainId === 101 || chainId === 102;

  const pick = (a: unknown, b: unknown) => {
    const primary = String(a ?? "").trim();
    const secondary = String(b ?? "").trim();
    if (isSolana || isSolanaTokenRouteId(primary) || isSolanaTokenRouteId(secondary)) {
      return (
        normalizeTokenRouteAddress(primary || secondary, 101) ||
        (isSolanaTokenRouteId(primary) ? primary : "") ||
        (isSolanaTokenRouteId(secondary) ? secondary : "")
      );
    }
    return normalizeEvmAddress(primary) || normalizeEvmAddress(secondary);
  };

  const token = pick(tokenOrCampaign.tokenAddress, tokenOrCampaign.token);
  const campaign = pick(tokenOrCampaign.campaignAddress, tokenOrCampaign.campaign);
  // Public TokenDetails URLs are token/mint canonical. The bonding campaign/PDA stays
  // an internal execution identity and is resolved from the registry on page load.
  const id = token || campaign;
  if (!id) return "/";

  const params = new URLSearchParams();
  const resolvedChain =
    isSolana || isSolanaTokenRouteId(id)
      ? chainId === 102
        ? 102
        : 101
      : Number.isFinite(chainId) && chainId > 0
        ? chainId
        : 0;

  // Shareable TokenDetails URLs stay clean when the address already implies the chain:
  //   /token/0x…     → BNB mainnet (56)
  //   /token/<mint>  → Solana (101)
  // Keep an explicit pin only when it is not the default for that address shape.
  if (resolvedChain === 97 || resolvedChain === 102) {
    params.set("chainId", String(resolvedChain));
  }

  const extra = String(options?.search || "").replace(/^\?/, "");
  if (extra) {
    const extraParams = new URLSearchParams(extra);
    extraParams.forEach((value, key) => {
      if (!params.has(key)) params.set(key, value);
    });
  }

  const qs = params.toString();
  return qs ? `/token/${encodeURIComponent(id)}?${qs}` : `/token/${encodeURIComponent(id)}`;
}
