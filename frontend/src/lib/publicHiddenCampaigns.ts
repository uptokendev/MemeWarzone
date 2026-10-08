/**
 * Test coins kept out of every public list. The API feed leaves out campaigns flagged
 * meta.publicHidden; the on-chain fallbacks (Explore, Featured, Graduated, the ticker) read factories
 * directly, so they check this list: the built-in entries below plus GET /api/campaigns/hidden.
 * 2026-10-08: the BNB and Robinhood MWZDONOTBUY test coins showed on Explore and filled the ticker.
 */
const BUILT_IN: Record<number, string[]> = {
  56: [
    "0x49ac80f9ccb0b4b88c2d98671a04cb146c0c6eb3", // MWZBNB test coin
    "0xa2bab12270d724ce70d5462024fe0d067b8b94e5", // BTW
    "0x36b2e5b717c47c181f06e3a53e9744b8b9c23de7", // SBF
  ],
  4663: ["0x404d723dabab33f0303d9fd26fa36936a87627f8"], // MWZRH test coin
  46630: ["0xb69e19c4387905170aa17e986aaa3b805dafe440"],
  97: [
    "0xecd05ac87007d5ae7a13407b59db32b8030eab3c",
    "0x127629b181023b503e91dca1e33c6f94664257b4",
    "0x7ba2daa9962c60ac9a14ceee31673710d7b234c8",
    "0x2af7776e520107152b0bba1a27fadcc21fa1baaf",
  ],
  101: [
    "9t72mNAVpnJCn42Z2quJTqoS8wsBTGR9aG2CvbeumXEF",
    "Bv2EZEznfuHNHcoC5DXJJtJH8x7mAjCUagsPGeXK3Jms",
    "EFUF3bPBaN3MzSBpm4MfXMdbXDmesPWcKaoNsLzn45VH",
  ],
};

/** Symbols hidden on a chain, for factory rows that carry no indexed campaign yet. */
const HIDDEN_SYMBOLS: Record<number, string[]> = { 56: ["BWT"] };

const CACHE_MS = 5 * 60_000;
const loaded = new Map<number, { at: number; keys: Set<string> }>();
const inFlight = new Map<number, Promise<Set<string>>>();

function key(chainId: number, address: unknown) {
  const raw = String(address ?? "").trim();
  if (!raw) return "";
  return Number(chainId) === 101 || Number(chainId) === 102 ? raw : raw.toLowerCase();
}

function builtIn(chainId: number) {
  return new Set((BUILT_IN[Number(chainId)] || []).map((a) => key(chainId, a)));
}

/** Sync check: built-in entries plus whatever the API list returned last. */
export function isPublicHiddenCampaign(chainId: number, address: unknown): boolean {
  const k = key(chainId, address);
  if (!k) return false;
  if (builtIn(chainId).has(k)) return true;
  return Boolean(loaded.get(Number(chainId))?.keys.has(k));
}

export function isPublicHiddenSymbol(chainId: number, symbol: unknown): boolean {
  const normalized = String(symbol ?? "").trim().toUpperCase();
  return Boolean(normalized && (HIDDEN_SYMBOLS[Number(chainId)] || []).includes(normalized));
}

/** Loads the API list for a chain (cached 5 minutes). Never throws; an API without the route keeps the built-in list. */
export async function loadPublicHiddenCampaigns(chainId: number): Promise<Set<string>> {
  const cid = Number(chainId);
  const cached = loaded.get(cid);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.keys;
  const pending = inFlight.get(cid);
  if (pending) return pending;
  const run = (async () => {
    try {
      // Loaded here, not at the top: liveMarketMerge imports this file and must stay free of the API base.
      const { apiFetch } = await import("@/lib/apiBase");
      const res = await apiFetch(`/api/campaigns/hidden?chainId=${cid}`, { cache: "no-store" as RequestCache });
      const body = await res.json().catch(() => null);
      const keys = new Set<string>(
        res.ok && Array.isArray(body?.campaigns) ? body.campaigns.map((a: unknown) => key(cid, a)).filter(Boolean) : [],
      );
      loaded.set(cid, { at: Date.now(), keys });
      return keys;
    } catch {
      const keys = cached?.keys || new Set<string>();
      loaded.set(cid, { at: Date.now(), keys });
      return keys;
    } finally {
      inFlight.delete(cid);
    }
  })();
  inFlight.set(cid, run);
  return run;
}
