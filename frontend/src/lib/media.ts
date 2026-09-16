// Normalize token/campaign image URIs so they render correctly in browsers.
// Supports ipfs:// and ar:// in addition to http(s):// and relative paths.
//
// Uses multiple public gateways with fallbacks because some gateways
// (especially cloudflare-ipfs) are unreliable or blocked on certain local networks / ISPs.
// This explains why images load in production but show placeholders locally.

const LEGACY_UNREACHABLE_IMAGE_HOSTS = new Set([
  "jlbdueorprgnfkcpnkfq.supabase.co",
]);

function isLegacyUnreachableImageUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return LEGACY_UNREACHABLE_IMAGE_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function resolveImageUri(uri?: string | null): string | undefined {
  const raw = String(uri ?? "").trim();
  if (!raw) return undefined;
  if (isLegacyUnreachableImageUrl(raw)) return undefined;

  const isLikelyCid = (s: string) =>
    /^Qm[1-9A-HJ-NP-Za-km-z]{44,}$/.test(s) ||
    /^b[a-z2-7]{20,}$/i.test(s);

  // Normalize to an array of possible gateway URLs (tried in order)
  const candidates: string[] = [];

  const addIpfs = (path: string) => {
    const p = path.replace(/^ipfs\//, '');
    candidates.push(`https://ipfs.io/ipfs/${p}`);
    candidates.push(`https://cloudflare-ipfs.com/ipfs/${p}`);
    candidates.push(`https://gateway.pinata.cloud/ipfs/${p}`);
  };

  if (raw.startsWith("ipfs/")) {
    addIpfs(raw.slice("ipfs/".length));
  } else if (isLikelyCid(raw)) {
    addIpfs(raw);
  } else if (raw.startsWith("ipfs://")) {
    let p = raw.slice("ipfs://".length);
    if (p.startsWith("ipfs/")) p = p.slice("ipfs/".length);
    if (!isLikelyCid(p.split("/")[0] || "")) return undefined;
    addIpfs(p);
  } else if (raw.startsWith("ar://")) {
    const tx = raw.slice("ar://".length);
    candidates.push(`https://arweave.net/${tx}`);
  } else if (raw.startsWith("data:")) {
    return raw;
  } else if (raw.startsWith("https://") || raw.startsWith("http://")) {
    return raw;
  } else if (raw.startsWith("/")) {
    return raw;
  } else {
    return raw;
  }

  // Return the first (most reliable primary) gateway.
  // The <img onError> in components can try the next one if we wanted advanced fallback,
  // but for now returning a good primary + having multiple in the list helps debugging.
  return candidates[0];
}
