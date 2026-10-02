/**
 * Images on feed posts (UI redesign phase 2). Stored under social-posts/<wallet>/<uuid>.<ext> by
 * POST /api/feed/image; a post may only reference an image in its own author's folder.
 */

/** Folder-safe wallet: Solana keeps base58 case, EVM is lowercased; anything else is stripped. */
export function feedImageWalletKey(wallet) {
  const raw = String(wallet || "").trim();
  const safe = /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : raw;
  return safe.replace(/[^A-Za-z0-9]/g, "");
}

export function feedImagePath({ wallet, uuid, ext }) {
  const key = feedImageWalletKey(wallet);
  const safeExt = String(ext || "").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
  return `social-posts/${key}/${String(uuid).replace(/[^A-Za-z0-9-]/g, "")}.${safeExt}`;
}

/** True only for a public URL of this project's storage inside the author's own social-posts folder. */
export function isOwnFeedImage(url, { storageBase, wallet }) {
  const base = String(storageBase || "").replace(/\/+$/, "");
  const key = feedImageWalletKey(wallet);
  if (!base || !url || !key) return false;
  const value = String(url);
  if (value.length > 512 || value.includes("..")) return false;
  const prefix = `${base}/storage/v1/object/public/`;
  if (!value.startsWith(prefix)) return false;
  const rest = value.slice(prefix.length);
  const slash = rest.indexOf("/");
  return slash > 0 && rest.slice(slash + 1).startsWith(`social-posts/${key}/`);
}

const EVM_ADDRESS = /\b0x[0-9a-fA-F]{40}\b/;
const SOLANA_ADDRESS = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;

/** First contract address written in a post body (EVM first, then Solana base58), or "". */
export function contractAddressInBody(body) {
  const text = String(body || "");
  const evm = text.match(EVM_ADDRESS);
  if (evm) return evm[0];
  const sol = text.match(SOLANA_ADDRESS);
  return sol ? sol[0] : "";
}
