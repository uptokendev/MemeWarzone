import { apiFetch } from "@/lib/apiBase";
import { getBnbCampaignFeedChainIds } from "@/lib/feedChainConfig";
import {
  BNB_CHAIN_ID,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
  SOLANA_CHAIN_ID,
  isAllowedChainId,
  isSolanaChainId,
} from "@/lib/chainConfig";
import {
  isSolanaBase58Address,
  normalizeEvmAddress,
  normalizeTokenRouteAddress,
  tokenDetailsPath,
} from "@/lib/tokenDetailsPath";
import type { TokenSearchResult } from "@/types/search";
import { fetchArenaImportMarket, type ArenaImportMarketRow } from "@/lib/arenaImports";

function scoreRow(query: string, row: TokenSearchResult): number {
  const q = query.toLowerCase().trim();
  const sym = row.symbol.toLowerCase();
  const name = row.name.toLowerCase();
  const campaign = row.campaignAddress.toLowerCase();
  const token = String(row.tokenAddress || "").toLowerCase();
  if (!q) return 0;
  if (sym === q || `$${sym}` === q) return 1000;
  if (name === q) return 900;
  if (sym.startsWith(q) || `$${sym}`.startsWith(q)) return 800;
  if (name.startsWith(q)) return 700;
  if (sym.includes(q) || name.includes(q)) return 500;
  if (campaign.includes(q) || token.includes(q)) return 400;
  return 100;
}

function mapCampaignRow(raw: Record<string, unknown>, fallbackChainId: number): TokenSearchResult | null {
  const chainId = Number(raw.chainId ?? raw.chain_id ?? fallbackChainId) || fallbackChainId;
  const campaignAddress = normalizeTokenRouteAddress(
    raw.campaignAddress ?? raw.campaign_address ?? raw.campaign,
    chainId,
  );
  const tokenAddress = normalizeTokenRouteAddress(raw.tokenAddress ?? raw.token_address ?? raw.token, chainId);
  if (!campaignAddress && !tokenAddress) return null;
  const href = tokenDetailsPath(
    { tokenAddress, campaignAddress, chainId },
    { chainId },
  );
  if (!href) return null;
  const graduated = Boolean(
    raw.isDexTrading ??
      raw.is_dex_trading ??
      (raw.status === "graduated" || Boolean(raw.graduatedAtChain)),
  );
  return {
    kind: "token",
    campaignAddress: campaignAddress || tokenAddress,
    tokenAddress: tokenAddress || undefined,
    name: String(raw.name || raw.symbol || "Unknown"),
    symbol: String(raw.symbol || raw.ticker || ""),
    status: graduated ? "graduated" : "bonding",
    logoURI: raw.logoURI || raw.logoUri || raw.logo_uri ? String(raw.logoURI || raw.logoUri || raw.logo_uri) : undefined,
    chainId,
    marketcapBnb: raw.marketcapBnb != null || raw.marketcap_bnb != null ? String(raw.marketcapBnb ?? raw.marketcap_bnb) : null,
    href,
  };
}

async function searchChain(chainId: number, q: string, limit: number, signal?: AbortSignal): Promise<TokenSearchResult[]> {
  const params = new URLSearchParams({
    chainId: String(chainId),
    search: q,
    tab: "trending",
    status: "all",
    limit: String(limit),
  });
  const res = await apiFetch(`/api/campaigns?${params.toString()}`, {
    method: "GET",
    cache: "no-store" as RequestCache,
    signal,
  });
  if (!res.ok) return [];
  const body = await res.json().catch(() => null);
  const rows = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : [];
  return rows
    .map((row: Record<string, unknown>) => mapCampaignRow(row, chainId))
    .filter((row): row is TokenSearchResult => Boolean(row));
}

async function searchProfiles(
  chainId: number,
  q: string,
  limit: number,
  signal?: AbortSignal,
): Promise<TokenSearchResult[]> {
  const params = new URLSearchParams({
    chainId: String(chainId),
    search: q,
    limit: String(limit),
  });
  const res = await apiFetch(`/api/profile?${params.toString()}`, {
    method: "GET",
    cache: "no-store" as RequestCache,
    signal,
  });
  if (!res.ok) return [];
  const body = await res.json().catch(() => null);
  const rows = Array.isArray(body?.items) ? body.items : [];
  return rows
    .map((row: Record<string, unknown>) => {
      const address = String(row.address || "").trim();
      if (!address) return null;
      const displayName = String(row.displayName || "").trim();
      const handle = String(row.handle || "").trim();
      const short = `${address.slice(0, 4)}…${address.slice(-4)}`;
      return {
        kind: "wallet" as const,
        campaignAddress: address,
        name: displayName || (handle ? `@${handle}` : "Wallet"),
        symbol: short,
        subtitle: handle ? `@${handle} · ${short}` : short,
        status: "unknown" as const,
        logoURI: row.avatarUrl ? String(row.avatarUrl) : undefined,
        chainId: Number(row.chainId || chainId) || chainId,
        href: `/profile/${encodeURIComponent(address)}`,
      };
    })
    .filter((row): row is TokenSearchResult => Boolean(row));
}

/**
 * Every chain the app serves, so search does not depend on the chain the visitor has selected (founder,
 * 2026-10-09: a Robinhood coin could not be found from the BNB feed). Same per-chain lists as the feeds.
 */
export function searchChainIds(): number[] {
  const chains = [SOLANA_CHAIN_ID, BNB_CHAIN_ID, ROBINHOOD_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID].flatMap((id) => getBnbCampaignFeedChainIds(id));
  return [...new Set(chains.map(Number))];
}

/** A pasted contract address, looked up on every chain at once (api/searchAddress.js). */
async function searchAddress(query: string, signal?: AbortSignal): Promise<TokenSearchResult[]> {
  const raw = query.trim();
  if (!normalizeEvmAddress(raw) && !isSolanaBase58Address(raw)) return [];
  const res = await apiFetch(`/api/search/address?address=${encodeURIComponent(raw)}`, { method: "GET", signal });
  if (!res.ok) return [];
  const body = await res.json().catch(() => null);
  const rows: Array<Record<string, unknown>> = Array.isArray(body?.items) ? body.items : [];
  return rows
    .filter((row) => isAllowedChainId(Number(row.chainId)))
    .map((row): TokenSearchResult | null => {
      const chainId = Number(row.chainId);
      if (row.kind === "import") {
        const token = String(row.tokenAddress || "");
        return {
          kind: "token",
          campaignAddress: token,
          tokenAddress: token,
          name: String(row.name || row.symbol || "Imported coin"),
          symbol: String(row.symbol || ""),
          status: "graduated",
          logoURI: row.logoURI ? String(row.logoURI) : undefined,
          chainId,
          marketcapBnb: null,
          href: `/token/${encodeURIComponent(token)}?chainId=${chainId}`,
        };
      }
      return mapCampaignRow({ ...row, isDexTrading: row.graduated }, chainId);
    })
    .filter((row): row is TokenSearchResult => Boolean(row));
}

function walletResult(query: string, chainId: number): TokenSearchResult | null {
  const raw = query.trim();
  const evm = normalizeEvmAddress(raw);
  const solana = isSolanaBase58Address(raw);
  if (!evm && !solana) return null;
  const address = evm || raw;
  const walletChain = evm ? (isSolanaChainId(chainId) ? BNB_CHAIN_ID : chainId) : 101;
  return {
    kind: "wallet",
    campaignAddress: address,
    name: "Wallet",
    symbol: `${address.slice(0, 4)}…${address.slice(-4)}`,
    status: "unknown",
    chainId: walletChain,
    href: `/profile/${encodeURIComponent(address)}`,
  };
}

/**
 * A published draft is a promotion page, not a tradeable campaign, so it has no
 * campaign or token address and its route is the slug. Everything the API
 * returns here has already passed the visibility and status filters, so a
 * private or unlisted draft cannot reach this point.
 */
function mapDraftRow(raw: Record<string, unknown>, fallbackChainId: number): TokenSearchResult | null {
  const slug = String(raw.slug || "").trim();
  if (!slug) return null;
  const chainId = Number(raw.chainId ?? raw.chain_id ?? fallbackChainId) || fallbackChainId;
  const name = String(raw.name || raw.ticker || "").trim();
  if (!name) return null;
  return {
    kind: "draft",
    campaignAddress: slug,
    draftSlug: slug,
    name,
    symbol: String(raw.ticker || raw.symbol || "").trim(),
    status: "unknown",
    logoURI: String(raw.logoUrl || raw.logo_url || raw.imageUrl || "") || undefined,
    chainId,
    marketcapBnb: null,
    href: `/prepare/${encodeURIComponent(slug)}`,
  };
}

async function searchDrafts(
  chainId: number,
  q: string,
  limit: number,
  signal?: AbortSignal,
): Promise<TokenSearchResult[]> {
  const params = new URLSearchParams({ chainId: String(chainId), search: q, limit: String(limit) });
  const res = await apiFetch(`/api/drafts?${params.toString()}`, {
    method: "GET",
    cache: "no-store" as RequestCache,
    signal,
  });
  if (!res.ok) return [];
  const body = await res.json().catch(() => null);
  const rows = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : [];
  return rows
    .map((row: Record<string, unknown>) => mapDraftRow(row, chainId))
    .filter((row): row is TokenSearchResult => Boolean(row));
}

// Imported coins (founder, 2026-10-05: searching "ASK" found nothing). The listed imports per chain are
// a short list, read once a minute and matched here on ticker, name or address.
const importListCache = new Map<number, { at: number; rows: Promise<ArenaImportMarketRow[]> }>();
function importList(chainId: number) {
  const hit = importListCache.get(chainId);
  if (hit && Date.now() - hit.at < 60_000) return hit.rows;
  // No abort signal: the list is shared between keystrokes, a cancelled search must not empty it.
  const rows = fetchArenaImportMarket(chainId).catch(() => {
    importListCache.delete(chainId);
    return [] as ArenaImportMarketRow[];
  });
  importListCache.set(chainId, { at: Date.now(), rows });
  return rows;
}

async function searchImports(chainId: number, q: string, limit: number, signal?: AbortSignal): Promise<TokenSearchResult[]> {
  const needle = q.toLowerCase().replace(/^\$/, "").trim();
  if (!needle) return [];
  if (signal?.aborted) return [];
  const rows = await importList(chainId);
  return rows
    .filter((row) => {
      const sym = String(row.symbol || "").toLowerCase().replace(/^\$/, "");
      const name = String(row.name || "").toLowerCase();
      const addr = String(row.tokenAddress || "").toLowerCase();
      return sym.includes(needle) || name.includes(needle) || (needle.length >= 6 && addr.startsWith(needle));
    })
    .slice(0, limit)
    .map((row) => {
      const chain = Number(row.chainId || chainId) || chainId;
      return {
        kind: "token" as const,
        campaignAddress: row.tokenAddress,
        tokenAddress: row.tokenAddress,
        name: String(row.name || row.symbol || "Imported coin"),
        symbol: String(row.symbol || "").replace(/^\$/, ""),
        status: "graduated" as const,
        logoURI: row.imageUrl || undefined,
        chainId: chain,
        marketcapBnb: null,
        marketCapUsd: row.marketCapUsd ?? null,
        href: `/token/${encodeURIComponent(row.tokenAddress)}?chainId=${chain}`,
      };
    });
}

export async function searchTokensRemote(
  q: string,
  opts?: { limit?: number; signal?: AbortSignal; chainId?: number; chainOnly?: boolean },
): Promise<TokenSearchResult[]> {
  const query = String(q || "").trim();
  if (query.length < 2) return [];
  const limit = opts?.limit ?? 12;
  // Every chain, unless the caller picks a coin for one chain (the battle coin picker).
  const chainIds = opts?.chainOnly ? getBnbCampaignFeedChainIds(opts?.chainId) : searchChainIds();
  const profileChain = Number(opts?.chainId || chainIds[0] || BNB_CHAIN_ID);
  const [tokenPages, profiles, draftPages, importPages, addressMatches] = await Promise.all([
    Promise.all(chainIds.map((id) => searchChain(id, query, limit, opts?.signal).catch(() => []))),
    // Profiles are the same on every chain: one lookup.
    opts?.chainOnly ? Promise.resolve([] as TokenSearchResult[]) : searchProfiles(profileChain, query, 8, opts?.signal).catch(() => []),
    // Drafts were never queried here, so a published promotion could not be
    // found by name or ticker even though its page was public.
    Promise.all(chainIds.map((id) => searchDrafts(id, query, 8, opts?.signal).catch(() => []))),
    Promise.all(chainIds.map((id) => searchImports(id, query, 8, opts?.signal).catch(() => []))),
    searchAddress(query, opts?.signal)
      .then((rows) => (opts?.chainOnly ? rows.filter((row) => chainIds.includes(row.chainId)) : rows))
      .catch(() => [] as TokenSearchResult[]),
  ]);
  const merged = new Map<string, TokenSearchResult>();
  const key = (row: TokenSearchResult) =>
    row.kind === "wallet"
      ? `wallet:${row.campaignAddress.toLowerCase()}`
      : `${row.kind}:${row.chainId}:${isSolanaChainId(row.chainId) ? row.tokenAddress || row.campaignAddress : String(row.tokenAddress || row.campaignAddress).toLowerCase()}`;
  // An exact address match first, then the rest; one result per person (profiles are the same on every chain).
  for (const row of [...addressMatches, ...tokenPages.flat(), ...importPages.flat(), ...profiles, ...draftPages.flat()]) {
    if (!merged.has(key(row))) merged.set(key(row), row);
  }
  const exact = new Set(addressMatches.map(key));
  const ranked = [...merged.values()]
    .map((row) => ({ row, score: exact.has(key(row)) ? 2000 : scoreRow(query, row) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.row);

  // A pasted address that is a coin opens the coin, not a wallet profile.
  const wallet = addressMatches.length ? null : walletResult(query, profileChain);
  if (wallet && !ranked.some((row) => row.kind === "wallet" && row.href === wallet.href)) {
    ranked.push(wallet);
  }
  return ranked;
}
