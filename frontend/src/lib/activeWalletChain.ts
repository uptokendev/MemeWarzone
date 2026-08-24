export const FEED_CHAIN_KEY = "mwz:selected_feed_chain_id";
export const ACTIVE_WALLET_KIND_KEY = "mwz:active_wallet_kind";
export const FEED_CHAIN_EVENT = "memewarzone:feedChainChanged";
export const ACTIVE_WALLET_KIND_EVENT = "memewarzone:activeWalletKindChanged";

export type ActiveWalletKind = "solana" | "bnb";

export function getActiveWalletKind(): ActiveWalletKind | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = String(window.localStorage.getItem(ACTIVE_WALLET_KIND_KEY) || "").trim();
    if (raw === "solana" || raw === "bnb") return raw;
  } catch {
    // ignore
  }
  return null;
}

export function setActiveWalletKind(kind: ActiveWalletKind): ActiveWalletKind {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(ACTIVE_WALLET_KIND_KEY, kind);
      window.dispatchEvent(new CustomEvent(ACTIVE_WALLET_KIND_EVENT, { detail: { kind } }));
    } catch {
      // ignore
    }
  }
  return kind;
}

/** Last explicit connect wins. Unset storage falls back to the only connected wallet. */
export function resolveActiveWalletKind(params: {
  storedKind?: ActiveWalletKind | null;
  solanaConnected?: boolean;
  bnbConnected?: boolean;
}): ActiveWalletKind | null {
  if (params.storedKind === "solana" || params.storedKind === "bnb") return params.storedKind;
  if (params.solanaConnected && !params.bnbConnected) return "solana";
  if (params.bnbConnected && !params.solanaConnected) return "bnb";
  if (params.solanaConnected) return "solana";
  if (params.bnbConnected) return "bnb";
  return null;
}

export function campaignWalletMatches(params: {
  isSolanaCampaign: boolean;
  storedKind?: ActiveWalletKind | null;
  solanaConnected?: boolean;
  bnbConnected?: boolean;
}): boolean {
  const kind = resolveActiveWalletKind(params);
  if (params.isSolanaCampaign) return kind === "solana" && Boolean(params.solanaConnected);
  return kind === "bnb" && Boolean(params.bnbConnected);
}

export function readStoredFeedChainId(): 56 | 97 | 101 | null {
  if (typeof window === "undefined") return null;
  try {
    const feed = Number(window.localStorage.getItem(FEED_CHAIN_KEY) || "");
    if (feed === 56 || feed === 97 || feed === 101) return feed;
    const featured = Number(window.localStorage.getItem("mwz:last_featured_chain_id") || "");
    if (featured === 56 || featured === 97 || featured === 101) return featured;
  } catch {
    // ignore
  }
  return null;
}

export function chainIdForWalletKind(kind: ActiveWalletKind, evmChainId?: number | null): 56 | 97 | 101 {
  if (kind === "solana") return 101;
  if (evmChainId === 56 || evmChainId === 97) return evmChainId;
  const stored = readStoredFeedChainId();
  if (stored === 56 || stored === 97) return stored;
  return 56;
}
