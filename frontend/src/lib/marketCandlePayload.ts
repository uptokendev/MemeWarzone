export function parseMarketCandlePayload(body: unknown): {
  items: any[];
  graduationMarker: any | null;
  marketStage: string;
  serverTime: string | null;
  canonicalVersion: number | null;
} {
  const empty = {
    items: [] as any[],
    graduationMarker: null,
    marketStage: "BONDING",
    serverTime: null as string | null,
    canonicalVersion: null as number | null,
  };
  if (Array.isArray(body)) {
    return { ...empty, items: body };
  }
  if (!body || typeof body !== "object") return empty;
  const row = body as Record<string, unknown>;
  const items = Array.isArray(row.items)
    ? row.items
    : Array.isArray(row.candles)
      ? row.candles
      : [];
  return {
    items,
    graduationMarker: row.graduationMarker ?? null,
    marketStage: String(row.marketStage || row.market_stage || "BONDING"),
    serverTime: row.serverTime != null ? String(row.serverTime) : row.server_time != null ? String(row.server_time) : null,
    canonicalVersion: row.canonicalVersion != null || row.canonical_version != null
      ? Number(row.canonicalVersion ?? row.canonical_version)
      : null,
  };
}
