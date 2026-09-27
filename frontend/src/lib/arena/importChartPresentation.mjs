export function importTradingBlocked(scan, security) {
  const hard = Array.isArray(scan?.hardFindings) ? scan.hardFindings : [];
  const codes = new Set(hard.map((item) => String(item?.code || item || "").toLowerCase()));
  if (codes.has("honeypot_sell_failed") || codes.has("non_transferable") || codes.has("paused")) return true;
  if (String(security?.status || "").toLowerCase() === "blocked") return true;
  const critical = Array.isArray(security?.criticalRisks) ? security.criticalRisks : [];
  return critical.some((risk) => {
    const code = String(risk?.code || "").toLowerCase();
    return code === "is_honeypot" || code === "cannot_sell_all" || code === "non_transferable";
  });
}

export function presentImportMarketState(profile, chainId, tokenAddress) {
  const cap = Number(profile?.marketCapUsd);
  const volume = Number(profile?.volume24hUsd);
  const liquidity = Number(profile?.liquidityUsd);
  const price = Number(profile?.priceUsd);
  return {
    chainId: Number(chainId),
    campaignAddress: String(profile?.campaignAddress || tokenAddress || ""),
    tokenAddress: String(profile?.tokenAddress || tokenAddress || ""),
    factoryAddress: null,
    campaignGeneration: null,
    marketStage: Number.isFinite(liquidity) && liquidity > 0 ? "DEX_ACTIVE" : "DEX_PENDING",
    graduation: null,
    pairAddress: null,
    routerAddress: null,
    dexFactoryAddress: null,
    wrappedNativeAddress: null,
    stable: null,
    feeBps: null,
    verified: true,
    tradingEnabled: true,
    verifiedAt: profile?.marketDataUpdatedAt || null,
    lastError: null,
    marketCapUsd: Number.isFinite(cap) ? cap : null,
    priceUsd: Number.isFinite(price) ? price : null,
    volume24hUsd: Number.isFinite(volume) ? volume : null,
    liquidityUsd: Number.isFinite(liquidity) ? liquidity : null,
  };
}

export function presentImportChart(profile, candles, chainId, tokenAddress, options = {}) {
  const items = Array.isArray(candles) ? candles : [];
  const emptyNote = items.length || options.loading
    ? null
    : options.reason === "NO_POOL"
      ? "No DEX pool found for this token yet"
      : "Chart appears once trades are indexed";
  return {
    candles: items,
    marketState: presentImportMarketState(profile, chainId, tokenAddress),
    emptyNote,
  };
}

/** Chart resolutions the import candle source serves; 1s/5s have no DEX-level source and fall to 1m. */
export const IMPORT_CHART_RESOLUTIONS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"];
export const IMPORT_CHART_DEFAULT_RESOLUTION = "1h";

export function clampImportResolution(resolution) {
  const value = String(resolution || "");
  if (IMPORT_CHART_RESOLUTIONS.includes(value)) return value;
  return value === "1s" || value === "5s" ? "1m" : IMPORT_CHART_DEFAULT_RESOLUTION;
}

function nativeString(usd, nativeUsd) {
  const value = Number(usd);
  return Number.isFinite(value) && value >= 0 ? String(value / nativeUsd) : null;
}

/**
 * /api/arena/imports/candles rows are USD. The chart takes native values and multiplies by the
 * nativeUsdPrice it is handed, so dividing by that same rate here makes the chart show the USD values
 * exactly. Without a rate there is nothing honest to draw: no rows.
 */
export function importUsdCandlesToChart(items, nativeUsd) {
  const rate = Number(nativeUsd);
  if (!Array.isArray(items) || !Number.isFinite(rate) || rate <= 0) return [];
  const out = [];
  for (const row of items) {
    const o = nativeString(row?.o, rate);
    const h = nativeString(row?.h, rate);
    const l = nativeString(row?.l, rate);
    const c = nativeString(row?.c, rate);
    if (![o, h, l, c].every((v) => v != null && Number(v) > 0) || !row?.bucket_start) continue;
    const hasMcap = [row.mcap_o, row.mcap_h, row.mcap_l, row.mcap_c].every((v) => v != null && Number(v) > 0);
    const volume = nativeString(row.volume_usd, rate) || "0";
    out.push({
      bucket_start: String(row.bucket_start),
      o, h, l, c,
      price_o: o, price_h: h, price_l: l, price_c: c,
      mcap_o: hasMcap ? nativeString(row.mcap_o, rate) : null,
      mcap_h: hasMcap ? nativeString(row.mcap_h, rate) : null,
      mcap_l: hasMcap ? nativeString(row.mcap_l, rate) : null,
      mcap_c: hasMcap ? nativeString(row.mcap_c, rate) : null,
      volume_bnb: volume,
      trades_count: 1,
      source_mask: 0,
      bonding_trade_count: 0,
      dex_trade_count: 1,
      bonding_volume_bnb: "0",
      dex_volume_bnb: volume,
      last_block_number: null,
      last_log_index: null,
    });
  }
  return out;
}

export function admissionPill(status) {
  const value = String(status || "scanning").toLowerCase();
  if (value === "passed") return { label: "Arena: eligible", tone: "success" };
  if (value === "needs_review") return { label: "Arena: needs review", tone: "default" };
  if (value === "declined") return { label: "Arena: declined", tone: "default" };
  return { label: "Arena: scanning", tone: "default" };
}
