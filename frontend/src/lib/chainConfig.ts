// src/lib/chainConfig.ts
// Centralized chain + env config for MemeBattles.
// Supports BNB Smart Chain plus Solana mainnet via supported Solana wallets.
//
// Design goal:
// - Reads follow explicit route/feed chain context first, then the wallet's connected chain,
//   otherwise fall back to default chain.
// - No redeploy needed to switch between BNB testnet/mainnet; only switch the wallet network.

import { getActiveWalletKind, readStoredFeedChainId } from "@/lib/activeWalletChain";

export type SupportedChainId = 56 | 97 | 101;

export const BNB_CHAIN_ID: SupportedChainId = 56;
export const BNB_TESTNET_CHAIN_ID: SupportedChainId = 97;
export const SOLANA_CHAIN_ID: SupportedChainId = 101;
export const SUPPORTED_CHAIN_IDS: SupportedChainId[] = [56, 97, 101];

const DEFAULT_ALLOWED: SupportedChainId[] = [56, 97, 101];
const DEFAULT_CHAIN: SupportedChainId = 56;
const LAST_FEATURED_CHAIN_KEY = "mwz:last_featured_chain_id";

const parseCsvNumbers = (raw?: string): number[] => {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
};

export function getAllowedChainIds(): SupportedChainId[] {
  const raw = import.meta.env.VITE_ALLOWED_CHAIN_IDS as string | undefined;
  const parsed = parseCsvNumbers(raw).filter((chainId) => isSupportedChainId(chainId)) as SupportedChainId[];
  return parsed.length ? parsed : DEFAULT_ALLOWED;
}

export function getSupportedChainIds(): SupportedChainId[] {
  return SUPPORTED_CHAIN_IDS;
}

export function getDefaultChainId(): SupportedChainId {
  const raw =
    (import.meta.env.VITE_DEFAULT_CHAIN_ID as string | undefined) ??
    (import.meta.env.VITE_TARGET_CHAIN_ID as string | undefined); // backward-compat
  const n = Number(raw);
  return Number.isFinite(n) && isSupportedChainId(n) ? (n as SupportedChainId) : DEFAULT_CHAIN;
}

export function isSupportedChainId(chainId?: number | null): boolean {
  return chainId === 56 || chainId === 97 || chainId === 101;
}

export function isAllowedChainId(chainId?: number | null): boolean {
  if (!chainId) return false;
  return getAllowedChainIds().includes(chainId as SupportedChainId);
}

export function isSolanaChainId(chainId?: number | null): boolean {
  return chainId === SOLANA_CHAIN_ID;
}

export function isEvmChainId(chainId?: number | null): boolean {
  return chainId === BNB_CHAIN_ID || chainId === BNB_TESTNET_CHAIN_ID;
}

function isEvmTokenPath(pathname: string): boolean {
  return /^\/token\/0x[a-fA-F0-9]{40}/i.test(pathname);
}

export function isEvmTokenRoutePath(pathname?: string | null): boolean {
  return isEvmTokenPath(String(pathname || ""));
}

function tokenPathId(pathname: string): string {
  try {
    const decoded = decodeURIComponent(String(pathname || "").split("?")[0] || "");
    const match = decoded.match(/^\/token\/([^/]+)\/?$/);
    return match?.[1] ? String(match[1]).trim() : "";
  } catch {
    return "";
  }
}

function isSolanaTokenPath(pathname: string): boolean {
  const id = tokenPathId(pathname);
  if (!id || id.startsWith("0x") || id.startsWith("0X")) return false;
  // Strict base58 *and* older lowercased/damaged grid URLs (0, O, I, l).
  return (
    (id.length >= 32 && id.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(id)) ||
    (id.length >= 32 && id.length <= 48 && /^[0-9A-Za-z]+$/.test(id))
  );
}

/** Trust an explicit 56/97/101 from a market page. Do not fall through to the wallet latch. */
export function coerceSupportedChainId(value: unknown): SupportedChainId | null {
  const n = Number(value);
  if (n === BNB_CHAIN_ID || n === BNB_TESTNET_CHAIN_ID || n === SOLANA_CHAIN_ID) return n;
  return null;
}

function readBrowserChainContext(): SupportedChainId | null {
  if (typeof window === "undefined") return null;

  try {
    const url = new URL(window.location.href);
    const queryChainId = Number(url.searchParams.get("chainId") || "");

    // EVM token pages must never inherit Solana (101) from ?chainId= or last feed switch.
    // That routes metrics/trades through the Solana launchpad adapter and blanks the UI.
    if (isEvmTokenPath(url.pathname)) {
      if (isEvmChainId(queryChainId)) return queryChainId as SupportedChainId;
      const stored = Number(window.localStorage.getItem(LAST_FEATURED_CHAIN_KEY) || "");
      if (isEvmChainId(stored)) return stored as SupportedChainId;
      return null; // fall through to wallet / default EVM
    }

    if (isSolanaTokenPath(url.pathname)) {
      if (queryChainId === SOLANA_CHAIN_ID) return SOLANA_CHAIN_ID;
      return SOLANA_CHAIN_ID;
    }

    if (isAllowedChainId(queryChainId)) return queryChainId as SupportedChainId;

    if (/^\/token\//.test(url.pathname)) {
      const stored = Number(window.localStorage.getItem(LAST_FEATURED_CHAIN_KEY) || "");
      if (isAllowedChainId(stored)) return stored as SupportedChainId;
    }

    const kind = getActiveWalletKind();
    if (kind === "solana") return SOLANA_CHAIN_ID;
    const storedFeed = readStoredFeedChainId();
    if (storedFeed && isAllowedChainId(storedFeed)) return storedFeed;
  } catch {
    // ignore route-context failures
  }

  return null;
}

export function getActiveChainId(walletChainId?: number | null): SupportedChainId {
  const routeChainId = readBrowserChainContext();
  if (routeChainId) return routeChainId;
  const kind = getActiveWalletKind();
  if (kind === "solana") return SOLANA_CHAIN_ID;
  const storedFeed = readStoredFeedChainId();
  if (storedFeed && isAllowedChainId(storedFeed)) return storedFeed;
  if (walletChainId && isAllowedChainId(walletChainId)) return walletChainId as SupportedChainId;
  return getDefaultChainId();
}

/**
 * Chain used for *reading* Token Details / metrics on 0x pages.
 *
 * IMPORTANT: Do NOT follow the wallet network here. Users often leave MetaMask on
 * mainnet (56) while browsing testnet (97) tokens — that produced totally wrong
 * price/mcap/liquidity (reading the wrong chain's contracts).
 *
 * Order: pinned token-page chain → last featured EVM feed → default EVM (56).
 */
export const TOKEN_DETAILS_CHAIN_KEY = "mwz:token_details_chain_id";
export const LAST_EVM_CHAIN_KEY = "mwz:last_evm_chain_id";

export function pinTokenDetailsChainId(chainId: number): void {
  if (!isEvmChainId(chainId)) return;
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(TOKEN_DETAILS_CHAIN_KEY, String(chainId));
    window.localStorage.setItem(LAST_EVM_CHAIN_KEY, String(chainId));
    window.localStorage.setItem(LAST_FEATURED_CHAIN_KEY, String(chainId));
  } catch {
    // ignore
  }
}

function readLastEvmChainId(): SupportedChainId | null {
  try {
    if (typeof window === "undefined") return null;
    for (const key of [TOKEN_DETAILS_CHAIN_KEY, LAST_EVM_CHAIN_KEY, LAST_FEATURED_CHAIN_KEY]) {
      const value = Number(window.localStorage.getItem(key) || "");
      if (isEvmChainId(value) && isAllowedChainId(value)) return value as SupportedChainId;
    }
  } catch {
    // ignore
  }
  return null;
}

export function getEvmReadChainIdForTokenPage(): SupportedChainId {
  try {
    if (typeof window !== "undefined") {
      const queryChainId = Number(new URLSearchParams(window.location.search).get("chainId") || "");
      if (isEvmChainId(queryChainId) && isAllowedChainId(queryChainId)) return queryChainId as SupportedChainId;
    }
  } catch {
    // ignore
  }
  const lastEvm = readLastEvmChainId();
  if (lastEvm && isAllowedChainId(lastEvm)) return lastEvm;
  
  const def = getDefaultChainId();
  return isEvmChainId(def) ? def : BNB_CHAIN_ID;
}

/**
 * Chain for the open Token Details page.
 * The address in the URL wins. A connected Solana wallet must never remount a
 * 0x campaign as chain 101 (that drops BNB trades/holders to a stub).
 */
export function resolveTokenPageChainId(input?: {
  pathname?: string | null;
  search?: string | null;
  routeId?: string | null;
}): SupportedChainId {
  const pathname =
    input?.pathname ?? (typeof window !== "undefined" ? window.location.pathname : "");
  const search =
    input?.search ?? (typeof window !== "undefined" ? window.location.search : "");
  const routeId = String(input?.routeId || tokenPathId(pathname) || "").trim();
  const queryChainId = Number(new URLSearchParams(String(search || "").replace(/^\?/, "")).get("chainId") || "");

  if (/^0x[a-fA-F0-9]{40}$/i.test(routeId) || isEvmTokenPath(pathname)) {
    if (isEvmChainId(queryChainId)) return queryChainId as SupportedChainId;
    // Query-less 0x URLs are BNB mainnet. Do not inherit last testnet (97) from feed storage,
    // or a shared /token/0x… link would open the wrong chain.
    return BNB_CHAIN_ID;
  }

  if (isSolanaTokenPath(pathname) || (!routeId.startsWith("0x") && routeId.length >= 32)) {
    return SOLANA_CHAIN_ID;
  }

  if (isEvmChainId(queryChainId)) return queryChainId as SupportedChainId;
  if (queryChainId === SOLANA_CHAIN_ID) return SOLANA_CHAIN_ID;
  return getEvmReadChainIdForTokenPage();
}

/** Force EVM chain for 0x campaign/token ids (Token Details / War Room). */
export function getEvmChainIdForAddress(
  address: string | null | undefined,
  _walletChainId?: number | null,
): SupportedChainId {
  const raw = String(address || "").trim();
  if (/^0x[a-fA-F0-9]{40}$/i.test(raw)) {
    // Wallet chain deliberately ignored for 0x market pages (see getEvmReadChainIdForTokenPage).
    return getEvmReadChainIdForTokenPage();
  }
  return getActiveChainId(_walletChainId);
}

function normalizeRpcUrl(u: string) {
  const s = u.trim();
  // common typo: "https//" (missing colon)
  if (s.startsWith("https//")) return "https:" + s.slice("https".length);
  if (s.startsWith("http//")) return "http:" + s.slice("http".length);
  return s;
}

function usableHttpUrl(value: string) {
  const raw = String(value || "").trim();
  if (!raw || /\{\{/.test(raw) || /%7B%7B/i.test(raw)) return "";
  return /^https?:\/\//i.test(raw) ? raw : "";
}

function firstFromCsv(raw?: string) {
  if (!raw) return "";
  const parts = String(raw)
    .split(",")
    .map((p) => usableHttpUrl(normalizeRpcUrl(p)))
    .filter(Boolean);
  return parts[0] ?? "";
}

function fromCsv(raw?: string) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((p) => usableHttpUrl(normalizeRpcUrl(p)))
    .filter((p) => Boolean(p));
}

export function getPublicRpcUrl(chainId: SupportedChainId): string {
  // NOTE: In Vite, only VITE_* env vars are exposed to the frontend bundle.
  // We support comma-separated lists for redundancy.

  if (chainId === SOLANA_CHAIN_ID) {
    const solana =
      (import.meta.env.VITE_SOLANA_MAINNET_RPC as string | undefined) ??
      (import.meta.env.VITE_SOLANA_RPC as string | undefined) ??
      (import.meta.env.VITE_PUBLIC_RPC_SOLANA as string | undefined) ??
      (import.meta.env.VITE_PUBLIC_RPC_101 as string | undefined);
    const solanaFirst = firstFromCsv(solana);
    return solanaFirst || "https://api.mainnet-beta.solana.com";
  }

  const explicit =
    (import.meta.env[`VITE_PUBLIC_RPC_${chainId}`] as string | undefined) ??
    (import.meta.env[`VITE_BSC_RPC_${chainId}`] as string | undefined);

  const explicitFirst = firstFromCsv(explicit);
  if (explicitFirst) return explicitFirst;

  if (chainId === 56) {
    const v =
      (import.meta.env.VITE_BSC_MAINNET_RPC as string | undefined) ??
      (import.meta.env.VITE_PUBLIC_RPC_MAINNET as string | undefined);
    const vFirst = firstFromCsv(v);
    if (vFirst) return vFirst;
    return "https://bsc-dataseed.binance.org/";
  }

  const v =
    (import.meta.env.VITE_BSC_TESTNET_RPC as string | undefined) ??
    (import.meta.env.VITE_PUBLIC_RPC_TESTNET as string | undefined);
  const vFirst = firstFromCsv(v);
  if (vFirst) return vFirst;
  return "https://data-seed-prebsc-1-s1.binance.org:8545/";
}

// For redundancy: get *all* configured public RPC URLs for a chain.
export function getPublicRpcUrls(chainId: SupportedChainId): string[] {
  if (chainId === SOLANA_CHAIN_ID) {
    const solana =
      (import.meta.env.VITE_SOLANA_MAINNET_RPC as string | undefined) ??
      (import.meta.env.VITE_SOLANA_RPC as string | undefined) ??
      (import.meta.env.VITE_PUBLIC_RPC_SOLANA as string | undefined) ??
      (import.meta.env.VITE_PUBLIC_RPC_101 as string | undefined);
    const list = fromCsv(solana);
    return list.length ? list : ["https://api.mainnet-beta.solana.com"];
  }

  const explicit =
    (import.meta.env[`VITE_PUBLIC_RPC_${chainId}`] as string | undefined) ??
    (import.meta.env[`VITE_BSC_RPC_${chainId}`] as string | undefined);

  const explicitList = fromCsv(explicit);
  if (explicitList.length) return explicitList;

  if (chainId === 56) {
    const v =
      (import.meta.env.VITE_BSC_MAINNET_RPC as string | undefined) ??
      (import.meta.env.VITE_PUBLIC_RPC_MAINNET as string | undefined);
    const list = fromCsv(v);
    return list.length ? list : ["https://bsc-dataseed.binance.org/"];
  }

  const v =
    (import.meta.env.VITE_BSC_TESTNET_RPC as string | undefined) ??
    (import.meta.env.VITE_PUBLIC_RPC_TESTNET as string | undefined);
  const list = fromCsv(v);
  // Browser-only fallbacks when VITE_BSC_TESTNET_RPC / VITE_PUBLIC_RPC_97 are unset.
  // The Railway indexer does NOT use these — it uses BSC_RPC_HTTP_97 (e.g. BlockPI).
  // Prefer publicnode over Binance seeds for eth_getLogs (seeds often rate-limit).
  const defaults = [
    "https://bsc-testnet.publicnode.com",
    "https://data-seed-prebsc-1-s1.binance.org:8545/",
    "https://data-seed-prebsc-2-s1.binance.org:8545/",
  ];
  if (!list.length) return defaults;
  const seen = new Set(list.map((u) => u.toLowerCase()));
  for (const url of defaults) {
    if (!seen.has(url.toLowerCase())) list.push(url);
  }
  return list;
}

export function getFactoryAddress(chainId: SupportedChainId): string {
  if (isSolanaChainId(chainId)) return "";

  // Preferred per-chain vars
  const perChain = (import.meta.env[`VITE_FACTORY_ADDRESS_${chainId}`] as string | undefined) ?? "";
  if (perChain.trim()) return perChain.trim();

  // Backward-compat single var
  const fallback = (import.meta.env.VITE_FACTORY_ADDRESS as string | undefined) ?? "";
  return fallback.trim();
}

function isEvmAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

/**
 * Active creation factory + supported inventory for read/index discovery.
 * No hardcoded testnet factory — 97 only appears if env still lists it.
 */
export function getSupportedFactoryAddresses(chainId: SupportedChainId): string[] {
  if (isSolanaChainId(chainId)) return [];

  const active = getFactoryAddress(chainId);
  const supportedRaw =
    (import.meta.env[`VITE_SUPPORTED_FACTORY_ADDRESSES_${chainId}`] as string | undefined) ??
    (import.meta.env.VITE_SUPPORTED_FACTORY_ADDRESSES as string | undefined) ??
    "";
  const fromEnv = String(supportedRaw)
    .split(",")
    .map((value) => value.trim())
    .filter((value) => isEvmAddress(value));

  const ordered = [active, ...fromEnv]
    .map((value) => String(value || "").trim())
    .filter((value) => isEvmAddress(value));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const address of ordered) {
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function getVoteTreasuryAddress(chainId: SupportedChainId): string {
  // Solana UP Vote treasury is a system-owned fee wallet (native SOL transfers).
  // Same product as BNB UPVoteTreasury — different rail.
  if (isSolanaChainId(chainId) || Number(chainId) === 102) {
    const solana =
      (import.meta.env.VITE_SOLANA_VOTE_TREASURY_ADDRESS as string | undefined) ||
      (import.meta.env.VITE_VOTE_TREASURY_ADDRESS_101 as string | undefined) ||
      "";
    return String(solana || "").trim();
  }

  // Preferred per-chain vars (EVM)
  const perChain = (import.meta.env[`VITE_VOTE_TREASURY_ADDRESS_${chainId}`] as string | undefined) ?? "";
  if (perChain.trim()) return perChain.trim();

  // Backward-compat single var
  const fallback = (import.meta.env.VITE_VOTE_TREASURY_ADDRESS as string | undefined) ?? "";
  return fallback.trim();
}

/** Arena UpVote sink. Never aliases the launchpad UPVoteTreasury keys. */
export function getArenaVoteTreasuryAddress(chainId: SupportedChainId): string {
  if (isSolanaChainId(chainId) || Number(chainId) === 102) {
    const solana =
      (import.meta.env.VITE_SOLANA_ARENA_VOTE_TREASURY_ADDRESS as string | undefined) ||
      (import.meta.env.VITE_ARENA_VOTE_TREASURY_ADDRESS_101 as string | undefined) ||
      "";
    return String(solana || "").trim();
  }
  const perChain = (import.meta.env[`VITE_ARENA_VOTE_TREASURY_ADDRESS_${chainId}`] as string | undefined) ?? "";
  if (perChain.trim()) return perChain.trim();
  const fallback = (import.meta.env.VITE_ARENA_VOTE_TREASURY_ADDRESS as string | undefined) ?? "";
  return fallback.trim();
}

/**
 * TreasuryVault holds the accumulated League Treasury fees (native BNB).
 * This address is chain-specific.
 */
export function getTreasuryVaultAddress(chainId: SupportedChainId): string {
  if (isSolanaChainId(chainId)) return "";

  // Preferred per-chain vars
  const perChain = (import.meta.env[`VITE_TREASURY_VAULT_ADDRESS_${chainId}`] as string | undefined) ?? "";
  if (perChain.trim()) return perChain.trim();

  // Backward-compat single var
  const fallback = (import.meta.env.VITE_TREASURY_VAULT_ADDRESS as string | undefined) ?? "";
  return fallback.trim();
}

export function getExplorerTxBase(chainId: SupportedChainId): string {
  if (chainId === SOLANA_CHAIN_ID) return "https://solscan.io/tx/";
  return chainId === 97 ? "https://testnet.bscscan.com/tx/" : "https://bscscan.com/tx/";
}

export function getChainParams(chainId: SupportedChainId) {
  if (chainId === BNB_CHAIN_ID) {
    return {
      chainId: "0x38",
      chainName: "BNB Smart Chain",
      nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
      rpcUrls: getPublicRpcUrls(BNB_CHAIN_ID),
      blockExplorerUrls: ["https://bscscan.com/"],
    };
  }

  if (chainId === BNB_TESTNET_CHAIN_ID) {
    return {
      chainId: "0x61",
      chainName: "BNB Smart Chain Testnet",
      nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
      rpcUrls: getPublicRpcUrls(BNB_TESTNET_CHAIN_ID),
      blockExplorerUrls: ["https://testnet.bscscan.com/"],
    };
  }

  return {
    chainId: "0x65",
    chainName: "Solana mainnet",
    nativeCurrency: { name: "SOL", symbol: "SOL", decimals: 9 },
    rpcUrls: getPublicRpcUrls(SOLANA_CHAIN_ID),
    blockExplorerUrls: ["https://solscan.io/"],
  };
}

// Common chains the wallet may be connected to but the app doesn't support.
// Used purely for human-readable labels on settings/diagnostic screens.
const CHAIN_LABELS: Record<number, string> = {
  1: "Ethereum",
  56: "BNB Smart Chain",
  97: "BNB Smart Chain Testnet",
  101: "Solana mainnet",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum One",
  10: "Optimism",
  43114: "Avalanche C-Chain",
};

export function getChainLabel(chainId?: number | null): string {
  if (!chainId) return "Unknown";
  if (chainId === 56) return "BNB";
  if (chainId === 97) return "BNB Testnet";
  if (chainId === 101) return "Solana";
  return CHAIN_LABELS[chainId] ?? `Chain ${chainId}`;
}
