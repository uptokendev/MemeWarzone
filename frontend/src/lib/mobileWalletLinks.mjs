/**
 * "Open in wallet" links for phone browsers that have no wallet in the page.
 *
 * A phone browser (Safari, Chrome) cannot see which wallet apps are
 * installed, so the connect modal offers a fixed list. Each link reopens the
 * current page inside that wallet's own browser, where the wallet injects its
 * provider and the normal detected-wallet path takes over. Nothing here
 * connects or signs; it only navigates.
 *
 * Formats, from each wallet's docs (checked 2026-10-06):
 * - Phantom:  https://phantom.com/ul/browse/<url>?ref=<ref>        (both URL-encoded)
 * - Solflare: https://solflare.com/ul/v1/browse/<url>?ref=<ref>    (both URL-encoded)
 * - MetaMask: https://link.metamask.io/dapp/<url without scheme>
 * - Trust:    https://link.trustwallet.com/open_url?coin_id=60&url=<url>
 * - OKX:      okx://wallet/dapp/url?dappUrl=<url>                  (URL-encoded; custom scheme,
 *             so it does nothing when the app is missing)
 *
 * Binance Wallet is left out: Binance publishes no link that opens a page in
 * its browser. Binance users connect through WalletConnect instead.
 *
 * Only wallets our app can actually use from their browser are listed per
 * chain: Solana signing reads injected Phantom/Solflare/Backpack/Glow
 * (detectSolanaWallets), EVM reads any injected EIP-1193 provider.
 */

export const LAST_OPEN_IN_WALLET_STORAGE_KEY = "mwz:last_open_in_wallet";

/** @typedef {{ id: string, name: string, chains: "solana" | "evm", description: string, href: string }} OpenInWalletLink */

const WALLETS = [
  {
    id: "phantom",
    name: "Phantom",
    chains: "solana",
    description: "Solana",
    build: (url, ref) => `https://phantom.com/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(ref)}`,
  },
  {
    id: "solflare",
    name: "Solflare",
    chains: "solana",
    description: "Solana",
    build: (url, ref) => `https://solflare.com/ul/v1/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(ref)}`,
  },
  {
    id: "metamask",
    name: "MetaMask",
    chains: "evm",
    description: "BNB Chain and Robinhood Chain",
    build: (url) => `https://link.metamask.io/dapp/${url.replace(/^https?:\/\//i, "")}`,
  },
  {
    id: "trust",
    name: "Trust Wallet",
    chains: "evm",
    description: "BNB Chain and Robinhood Chain",
    build: (url) => `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(url)}`,
  },
  {
    id: "okx",
    name: "OKX Wallet",
    chains: "evm",
    description: "BNB Chain and Robinhood Chain",
    build: (url) => `okx://wallet/dapp/url?dappUrl=${encodeURIComponent(url)}`,
  },
];

/**
 * True for phones and tablets. iPadOS reports a Mac user agent, so a Mac with
 * a touch screen counts as an iPad.
 *
 * @param {{ userAgent?: string, maxTouchPoints?: number }} nav
 */
export function isMobileBrowser(nav) {
  const ua = String(nav?.userAgent || "");
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return true;
  return /Macintosh/i.test(ua) && Number(nav?.maxTouchPoints || 0) > 1;
}

/**
 * @param {{ currentUrl: string, filter?: "evm" | "solana" | null, lastUsedId?: string | null }} input
 * @returns {OpenInWalletLink[]}
 */
export function buildOpenInWalletLinks({ currentUrl, filter = null, lastUsedId = null }) {
  let parsed;
  try {
    parsed = new URL(String(currentUrl || ""));
  } catch {
    return [];
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return [];

  const url = parsed.href;
  const ref = parsed.origin;
  const links = WALLETS
    .filter((wallet) => !filter || wallet.chains === filter)
    .map((wallet) => ({
      id: wallet.id,
      name: wallet.name,
      chains: wallet.chains,
      description: wallet.description,
      href: wallet.build(url, ref),
    }));

  const lastIndex = lastUsedId ? links.findIndex((link) => link.id === lastUsedId) : -1;
  if (lastIndex > 0) links.unshift(...links.splice(lastIndex, 1));
  return links;
}
