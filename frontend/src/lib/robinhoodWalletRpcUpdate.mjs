// Robinhood Chain is new, so most users added it to their wallet through this app
// (wallet_addEthereumChain with rpcUrls = VITE_PUBLIC_RPC_4663). Until 2026-10-13 that was our paid
// Chainstack URL; wallets keep the URL they were given and use it for balances, block polling and
// sending transactions, long after the app moved to the public Robinhood RPC. Calling
// wallet_addEthereumChain again for the same chain with the new URL lets the wallet replace it
// (MetaMask asks the user once). This module only decides and calls; the prompt is always started
// by the user's click (RobinhoodWalletRpcNotice), never inside a connect or trade flow.

const KEY_PREFIX = "mwz:rh_wallet_rpc_update:v1:";
export const DECLINED_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
export const UNSUPPORTED_RETRY_MS = 30 * 24 * 60 * 60 * 1000;

// Hosts whose URLs carry a paid key. A URL written into a user's wallet is public and permanent, so
// none of these (or any URL with a key query param) is ever offered.
const PAID_RPC_HOST =
  /(?:^|\.)(?:chainstack\.com|helius-rpc\.com|quiknode\.pro|alchemy\.com|infura\.io|blockpi\.network|drpc\.org|ankr\.com|getblock\.io|nodereal\.io)$/i;
const KEY_QUERY = /[?&](?:api[-_]?key|apikey|key|token)=/i;

/** An https URL on a host that carries no paid key and has no key query param. */
export function isPublicRpcUrl(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== "https:") return false;
    return !PAID_RPC_HOST.test(parsed.hostname) && !KEY_QUERY.test(String(url));
  } catch {
    return false;
  }
}

/** The add-chain params with only public RPC URLs, or null when none is left. */
export function publicChainParams(params) {
  const rpcUrls = (params?.rpcUrls || []).filter(isPublicRpcUrl);
  return rpcUrls.length ? { ...params, rpcUrls } : null;
}

function key(walletId) {
  return `${KEY_PREFIX}${walletId || "unknown"}`;
}

function safeStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readRpcUpdateState(walletId, storage = safeStorage()) {
  try {
    const raw = storage?.getItem(key(walletId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !["updated", "declined", "unsupported"].includes(parsed.status) || !Number.isFinite(parsed.at)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeRpcUpdateState(walletId, status, now = Date.now(), storage = safeStorage()) {
  try {
    storage?.setItem(key(walletId), JSON.stringify({ status, at: now }));
  } catch {
    // storage unavailable: the notice may show again next session, nothing else depends on it
  }
}

/** Whether to offer the update: never offered, or declined / not supported long enough ago. */
export function rpcUpdateDue(state, now = Date.now()) {
  if (!state) return true;
  if (state.status === "updated") return false;
  if (state.status === "declined") return now - state.at >= DECLINED_RETRY_MS;
  return now - state.at >= UNSUPPORTED_RETRY_MS;
}

function errorCode(error) {
  return Number(error?.code ?? error?.info?.error?.code ?? error?.error?.code ?? error?.data?.originalError?.code ?? 0);
}

/**
 * Asks the wallet (anything with send(method, params), e.g. an ethers BrowserProvider) to use the
 * public RPC. "updated" also covers a wallet that already had it (no prompt). A 4001 /
 * ACTION_REJECTED is "declined"; any other failure is "unsupported". Returns "skipped" without
 * calling the wallet when no public URL is configured.
 */
export async function requestRpcUpdate(wallet, walletId, { params, now = Date.now, storage = safeStorage() } = {}) {
  const publicParams = publicChainParams(params);
  if (!publicParams) return "skipped";
  try {
    await wallet.send("wallet_addEthereumChain", [publicParams]);
    writeRpcUpdateState(walletId, "updated", now(), storage);
    return "updated";
  } catch (error) {
    const rejected = errorCode(error) === 4001 || error?.code === "ACTION_REJECTED";
    const status = rejected ? "declined" : "unsupported";
    writeRpcUpdateState(walletId, status, now(), storage);
    return status;
  }
}
