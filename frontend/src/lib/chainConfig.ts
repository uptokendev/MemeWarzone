// src/lib/chainConfig.ts
// Centralized chain + env config for MemeWarzone.
// Supports BNB Smart Chain, Solana mainnet, and opt-in Robinhood Chain EVM networks.
//
// Design goal:
// - Reads follow explicit route/feed chain context first, then the wallet's connected chain,
//   otherwise fall back to default chain.
// - Known chains are not automatically public/allowed. VITE_ALLOWED_CHAIN_IDS controls activation.

import { getActiveWalletKind, readStoredFeedChainId } from "@/lib/activeWalletChain";

export type SupportedChainId = 56 | 97 | 101 | 4663 | 46630;

export const BNB_CHAIN_ID: SupportedChainId = 56;
export const BNB_TESTNET_CHAIN_ID: SupportedChainId = 97;
export const SOLANA_CHAIN_ID: SupportedChainId = 101;
export const ROBINHOOD_CHAIN_ID: SupportedChainId = 4663;
export const ROBINHOOD_TESTNET_CHAIN_ID: SupportedChainId = 46630;
export const SUPPORTED_CHAIN_IDS: SupportedChainId[] = [56, 97, 101, 4663, 46630];

// Preserve the public product surface unless a runtime explicitly opts Robinhood in.
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
  return chainId === 56 || chainId === 97 || chainId === 101 || chainId === 4663 || chainId === 46630;
}

export function isAllowedChainId(chainId?: number | null): boolean {
  if (!chainId) return false;
  return getAllowedChainIds().includes(chainId as SupportedChainId);
}

export function isSolanaChainId(chainId?: number | null): boolean {
  return chainId === SOLANA_CHAIN_ID;
}

export function isEvmChainId(chainId?: number | null): boolean {
  return (
    chainId === BNB_CHAIN_ID ||
    chainId === BNB_TESTNET_CHAIN_ID ||
    chainId === ROBINHOOD_CHAIN_ID ||
    chainId === ROBINHOOD_TESTNET_CHAIN_ID
  );
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

/** Trust an explicit known MemeWarzone chain from a market page. */
export function coerceSupportedChainId(value: unknown): SupportedChainId | null {
  const n = Number(value);
  if (isSupportedChainId(n)) return n as SupportedChainId;
  return null;
}

function readBrowserChainContext(): SupportedChainId | null {
  if (typeof window === "undefined") return null;

  try {
    const url = new URL(window.location.href);
    const queryChainId = Number(url.searchParams.get("chainId") || "");

    // EVM token pages must never inherit Solana (101) from ?chainId= or last feed switch.
    if (isEvmTokenPath(url.pathname)) {
      if (isEvmChainId(queryChainId) && isAllowedChainId(queryChainId)) return queryChainId as SupportedChainId;
      const stored = Number(window.localStorage.getItem(LAST_FEATURED_CHAIN_KEY) || "");
      if (isEvmChainId(stored) && isAllowedChainId(stored)) return stored as SupportedChainId;
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
    if (storedFeed && isAllowedChainId(storedFeed)) return storedFeed as SupportedChainId;
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
  if (storedFeed && isAllowedChainId(storedFeed)) return storedFeed as SupportedChainId;
  if (walletChainId && isAllowedChainId(walletChainId)) return walletChainId as SupportedChainId;
  return getDefaultChainId();
}

/**
 * Chain used for *reading* Token Details / metrics on 0x pages.
 *
 * IMPORTANT: Do NOT follow the wallet network here. Users often leave MetaMask on
 * a different EVM chain while browsing a token. Route/feed context must win.
 */
export const TOKEN_DETAILS_CHAIN_KEY = "mwz:token_details_chain_id";
export const LAST_EVM_CHAIN_KEY = "mwz:last_evm_chain_id";

export function pinTokenDetailsChainId(chainId: number): void {
  if (!isEvmChainId(chainId) || !isAllowedChainId(chainId)) return;
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
  return isEvmChainId(def) && isAllowedChainId(def) ? def : BNB_CHAIN_ID;
}

/**
 * Chain for the open Token Details page.
 * The address in the URL wins. A connected Solana wallet must never remount an
 * EVM campaign as chain 101.
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
    if (isEvmChainId(queryChainId) && isAllowedChainId(queryChainId)) return queryChainId as SupportedChainId;

    // Keep public query-less 0x links backward-compatible with BNB mainnet.
    // The isolated Robinhood local profile is the only environment allowed to
    // use its explicitly selected default EVM chain without a query parameter.
    const runtime = String(import.meta.env.VITE_RUNTIME_ENVIRONMENT || "").trim().toLowerCase();
    const def = getDefaultChainId();
    if (runtime === "local" && isEvmChainId(def) && isAllowedChainId(def)) return def;
    return BNB_CHAIN_ID;
  }

  if (isSolanaTokenPath(pathname) || (!routeId.startsWith("0x") && routeId.length >= 32)) {
    return SOLANA_CHAIN_ID;
  }

  if (isEvmChainId(queryChainId) && isAllowedChainId(queryChainId)) return queryChainId as SupportedChainId;
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
    return getEvmReadChainIdForTokenPage();
  }
  return getActiveChainId(_walletChainId);
}

function normalizeRpcUrl(u: string) {
  const s = u.trim();
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

function robinhoodDefaultRpc(chainId: SupportedChainId): string {
  if (chainId === ROBINHOOD_TESTNET_CHAIN_ID) return "https://rpc.testnet.chain.robinhood.com";
  if (chainId === ROBINHOOD_CHAIN_ID) return "https://rpc.mainnet.chain.robinhood.com";
  return "";
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

  if (chainId === ROBINHOOD_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID) {
    return robinhoodDefaultRpc(chainId);
  }

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

  if (chainId === ROBINHOOD_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID) {
    return [robinhoodDefaultRpc(chainId)];
  }

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

  const perChain = (import.meta.env[`VITE_FACTORY_ADDRESS_${chainId}`] as string | undefined) ?? "";
  if (perChain.trim()) return perChain.trim();

  // Backward-compat single var is BNB-only; never let it leak into Robinhood.
  if (chainId === BNB_CHAIN_ID || chainId === BNB_TESTNET_CHAIN_ID) {
    const fallback = (import.meta.env.VITE_FACTORY_ADDRESS as string | undefined) ?? "";
    return fallback.trim();
  }
  return "";
}

function isEvmAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

/** Active creation factory + supported inventory for read/index discovery. */
export function getSupportedFactoryAddresses(chainId: SupportedChainId): string[] {
  if (isSolanaChainId(chainId)) return [];

  const active = getFactoryAddress(chainId);
  const supportedRaw =
    (import.meta.env[`VITE_SUPPORTED_FACTORY_ADDRESSES_${chainId}`] as string | undefined) ??
    ((chainId === BNB_CHAIN_ID || chainId === BNB_TESTNET_CHAIN_ID)
      ? (import.meta.env.VITE_SUPPORTED_FACTORY_ADDRESSES as string | undefined)
      : undefined) ??
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
  if (isSolanaChainId(chainId) || Number(chainId) === 102) {
    const solana =
      (import.meta.env.VITE_SOLANA_VOTE_TREASURY_ADDRESS as string | undefined) ||
      (import.meta.env.VITE_VOTE_TREASURY_ADDRESS_101 as string | undefined) ||
      "";
    return String(solana || "").trim();
  }

  const perChain = (import.meta.env[`VITE_VOTE_TREASURY_ADDRESS_${chainId}`] as string | undefined) ?? "";
  if (perChain.trim()) return perChain.trim();

  if (chainId === BNB_CHAIN_ID || chainId === BNB_TESTNET_CHAIN_ID) {
    const fallback = (import.meta.env.VITE_VOTE_TREASURY_ADDRESS as string | undefined) ?? "";
    return fallback.trim();
  }
  return "";
}

/**
 * Arena UpVote destination.
 * Solana can explicitly override this, but otherwise falls back to the standard
 * vote treasury so Arena keeps the same V0 payment rail and only changes memo domain.
 */
export function getArenaVoteTreasuryAddress(chainId: SupportedChainId): string {
  if (isSolanaChainId(chainId) || Number(chainId) === 102) {
    const solana =
      (import.meta.env.VITE_SOLANA_ARENA_VOTE_TREASURY_ADDRESS as string | undefined) ||
      (import.meta.env.VITE_ARENA_VOTE_TREASURY_ADDRESS_101 as string | undefined) ||
      (import.meta.env.VITE_SOLANA_PROTOCOL_TREASURY_ADDRESS as string | undefined) ||
      getVoteTreasuryAddress(SOLANA_CHAIN_ID);
    return String(solana || "").trim();
  }

  const perChain = (import.meta.env[`VITE_ARENA_VOTE_TREASURY_ADDRESS_${chainId}`] as string | undefined) ?? "";
  if (perChain.trim()) return perChain.trim();

  if (chainId === BNB_CHAIN_ID || chainId === BNB_TESTNET_CHAIN_ID) {
    const fallback = (import.meta.env.VITE_ARENA_VOTE_TREASURY_ADDRESS as string | undefined) ?? "";
    return fallback.trim();
  }
  return "";
}

export function getArenaWarPoolTreasuryAddress(chainId: SupportedChainId): string {
  if (isSolanaChainId(chainId)) return "";

  const perChain = (import.meta.env[`VITE_ARENA_WAR_POOL_TREASURY_ADDRESS_${chainId}`] as string | undefined) ?? "";
  if (perChain.trim()) return perChain.trim();

  if (chainId === BNB_CHAIN_ID || chainId === BNB_TESTNET_CHAIN_ID) {
    const fallback = (import.meta.env.VITE_ARENA_WAR_POOL_TREASURY_ADDRESS as string | undefined) ?? "";
    return fallback.trim();
  }
  return "";
}

/** TreasuryVault holds accumulated League Treasury fees in the chain's native asset. */
export function getTreasuryVaultAddress(chainId: SupportedChainId): string {
  if (isSolanaChainId(chainId)) return "";

  const perChain = (import.meta.env[`VITE_TREASURY_VAULT_ADDRESS_${chainId}`] as string | undefined) ?? "";
  if (perChain.trim()) return perChain.trim();

  if (chainId === BNB_CHAIN_ID || chainId === BNB_TESTNET_CHAIN_ID) {
    const fallback = (import.meta.env.VITE_TREASURY_VAULT_ADDRESS as string | undefined) ?? "";
    return fallback.trim();
  }
  return "";
}

export function getExplorerTxBase(chainId: SupportedChainId): string {
  if (chainId === SOLANA_CHAIN_ID) return "https://solscan.io/tx/";
  if (chainId === ROBINHOOD_TESTNET_CHAIN_ID) return "https://explorer.testnet.chain.robinhood.com/tx/";
  if (chainId === ROBINHOOD_CHAIN_ID) return "https://robinhoodchain.blockscout.com/tx/";
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

  if (chainId === ROBINHOOD_CHAIN_ID) {
    return {
      chainId: "0x1237",
      chainName: "Robinhood Chain",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: getPublicRpcUrls(ROBINHOOD_CHAIN_ID),
      blockExplorerUrls: ["https://robinhoodchain.blockscout.com/"],
    };
  }

  if (chainId === ROBINHOOD_TESTNET_CHAIN_ID) {
    return {
      chainId: "0xb626",
      chainName: "Robinhood Chain Testnet",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: getPublicRpcUrls(ROBINHOOD_TESTNET_CHAIN_ID),
      blockExplorerUrls: ["https://explorer.testnet.chain.robinhood.com/"],
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
  4663: "Robinhood Chain",
  46630: "Robinhood Chain Testnet",
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
  if (chainId === 4663) return "Robinhood";
  if (chainId === 46630) return "Robinhood Testnet";
  return CHAIN_LABELS[chainId] ?? `Chain ${chainId}`;
}
