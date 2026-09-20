import { tokenDetailsPath } from "@/lib/tokenDetailsPath";

/**
 * Mirrors SearchResultKind. Recent searches are replayed straight back into the
 * results list, so a kind that is searchable but not storable would be dropped
 * from history and silently lose its label.
 */
export type SearchHistoryKind = "token" | "wallet" | "draft";

export type SearchHistoryItem = {
  kind: SearchHistoryKind;
  name: string;
  symbol?: string;
  logoURI?: string;
  tokenAddress?: string;
  campaignAddress?: string;
  chainId: number;
  href: string;
  at: number;
};

const SEARCHED_KEY = "mwz:search-history:v1";
const VIEWED_KEY = "mwz:recently-viewed:v1";
const MAX_ITEMS = 12;

function readList(key: string): SearchHistoryItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => normalizeItem(row))
      .filter((row): row is SearchHistoryItem => Boolean(row))
      .slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

function writeList(key: string, items: SearchHistoryItem[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(items.slice(0, MAX_ITEMS)));
  } catch {
    // quota / private mode
  }
}

function itemKey(item: Pick<SearchHistoryItem, "kind" | "chainId" | "href" | "campaignAddress" | "tokenAddress">) {
  return `${item.kind}:${item.chainId}:${item.tokenAddress || item.campaignAddress || item.href}`;
}

function normalizeItem(raw: unknown): SearchHistoryItem | null {
  const row = raw as Partial<SearchHistoryItem> | null;
  if (!row || typeof row !== "object") return null;
  const href = String(row.href || "").trim();
  const chainId = Number(row.chainId || 0);
  if (!href || !Number.isFinite(chainId) || chainId <= 0) return null;
  return {
    kind: row.kind === "wallet" ? "wallet" : "token",
    name: String(row.name || row.symbol || "Unknown").trim() || "Unknown",
    symbol: row.symbol ? String(row.symbol) : undefined,
    logoURI: row.logoURI ? String(row.logoURI) : undefined,
    tokenAddress: row.tokenAddress ? String(row.tokenAddress) : undefined,
    campaignAddress: row.campaignAddress ? String(row.campaignAddress) : undefined,
    chainId,
    href,
    at: Number(row.at || Date.now()),
  };
}

function upsert(key: string, next: SearchHistoryItem) {
  const prev = readList(key).filter((item) => itemKey(item) !== itemKey(next));
  writeList(key, [{ ...next, at: Date.now() }, ...prev]);
}

export function loadRecentlySearched(): SearchHistoryItem[] {
  return readList(SEARCHED_KEY);
}

export function loadRecentlyViewed(): SearchHistoryItem[] {
  return readList(VIEWED_KEY);
}

export function recordRecentlySearched(item: SearchHistoryItem) {
  upsert(SEARCHED_KEY, item);
}

export function recordRecentlyViewed(item: Omit<SearchHistoryItem, "kind" | "href" | "at"> & { href?: string }) {
  const href =
    item.href ||
    tokenDetailsPath(
      {
        tokenAddress: item.tokenAddress,
        campaignAddress: item.campaignAddress,
        chainId: item.chainId,
      },
      { chainId: item.chainId },
    );
  if (!href) return;
  upsert(VIEWED_KEY, {
    kind: "token",
    name: item.name,
    symbol: item.symbol,
    logoURI: item.logoURI,
    tokenAddress: item.tokenAddress,
    campaignAddress: item.campaignAddress,
    chainId: item.chainId,
    href,
    at: Date.now(),
  });
}

export function clearRecentlySearched() {
  writeList(SEARCHED_KEY, []);
}
