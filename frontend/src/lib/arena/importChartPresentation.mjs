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

export function presentImportChart(profile, candles, chainId, tokenAddress) {
  const items = Array.isArray(candles) ? candles : [];
  return {
    candles: items,
    marketState: presentImportMarketState(profile, chainId, tokenAddress),
    emptyNote: items.length ? null : "Chart appears once trades are indexed",
  };
}

export function admissionPill(status) {
  const value = String(status || "scanning").toLowerCase();
  if (value === "passed") return { label: "Arena: eligible", tone: "success" };
  if (value === "needs_review") return { label: "Arena: needs review", tone: "default" };
  if (value === "declined") return { label: "Arena: declined", tone: "default" };
  return { label: "Arena: scanning", tone: "default" };
}
