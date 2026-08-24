/** Campaigns kept operational for internal claim/upgrade acceptance but hidden from all public feed merges. */
const PUBLIC_HIDDEN_CAMPAIGNS = new Map<number, Set<string>>([
  [
    101,
    new Set([
      "9t72mNAVpnJCn42Z2quJTqoS8wsBTGR9aG2CvbeumXEF",
      "Bv2EZEznfuHNHcoC5DXJJtJH8x7mAjCUagsPGeXK3Jms",
      "EFUF3bPBaN3MzSBpm4MfXMdbXDmesPWcKaoNsLzn45VH",
    ]),
  ],
]);

const PUBLIC_HIDDEN_SYMBOLS = new Map<number, Set<string>>([
  [56, new Set(["BWT"])],
]);

function isPublicHiddenCampaign(chainId: number, address: string): boolean {
  const cid = Number(chainId);
  const raw = String(address ?? "").trim();
  return Boolean(raw && PUBLIC_HIDDEN_CAMPAIGNS.get(cid)?.has(raw));
}

function isPublicHiddenSymbol(chainId: number, symbol: unknown): boolean {
  const cid = Number(chainId);
  const normalized = String(symbol ?? "").trim().toUpperCase();
  return Boolean(normalized && PUBLIC_HIDDEN_SYMBOLS.get(cid)?.has(normalized));
}

/** Canonical campaign key: EVM lowercase, Solana base58 preserved. */
export function liveCampaignKey(chainId: number, address: string): string {
  const raw = String(address ?? "").trim();
  if (!raw) return "";
  const cid = Number(chainId);
  if (isPublicHiddenCampaign(cid, raw)) return "";
  if (cid === 101 || cid === 102) return raw;
  if (!raw.startsWith("0x") && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) return raw;
  return raw.toLowerCase();
}

function asFiniteNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return NaN;
}

/** Prefer a finite live number (or numeric string); otherwise fallback. */
export function pickLiveNumeric(live: unknown, fallback: unknown): number {
  const liveNum = asFiniteNumber(live);
  if (Number.isFinite(liveNum)) return liveNum;
  const fb = asFiniteNumber(fallback);
  return Number.isFinite(fb) ? fb : NaN;
}

/**
 * REST page first (deduped by liveCampaignKey). Created rows missing from REST
 * are prepended so Ably stubs survive until the indexer catches up.
 */
export function mergeFeedWithCreated<
  T extends { campaignAddress?: string; chainId?: number; symbol?: unknown },
  C extends { campaignAddress: string; symbol?: unknown },
>(
  restItems: T[],
  created: C[],
  chainId: number,
  toItem: (created: C) => T,
): T[] {
  const seen = new Set<string>();
  const rest: T[] = [];
  for (const item of restItems) {
    const itemChainId = Number(item.chainId ?? chainId);
    if (isPublicHiddenSymbol(itemChainId, item.symbol)) continue;
    const key = liveCampaignKey(itemChainId, String(item.campaignAddress ?? ""));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rest.push(item);
  }

  const prepended: T[] = [];
  for (const row of created) {
    if (isPublicHiddenSymbol(chainId, row.symbol)) continue;
    const key = liveCampaignKey(chainId, String(row.campaignAddress ?? ""));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    prepended.push(toItem(row));
  }

  return [...prepended, ...rest];
}
