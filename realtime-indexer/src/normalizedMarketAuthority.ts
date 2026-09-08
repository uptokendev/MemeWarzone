/**
 * Additive normalized market authority for post-graduation markets created by
 * new campaign/market generations.
 *
 * Legacy Topaz/Meteora/Robinhood rows are never reinterpreted here. Quote
 * eligibility is owned by Agent 1's Quote Asset Catalog; Agent 4 consumes the
 * catalog decision/result and does not recalculate its policy or health gates.
 */

export type DecimalString = string;
export type RawAmountString = string;
export type QuoteAssetClass = "NATIVE" | "STABLECOIN" | "PROVIDER_RWA" | "MWZ_NATIVE" | "COMMUNITY" | string;
export type ReferenceState = "available" | "missing" | "stale";

/** Exact public item shape consumed from frontend/api/lib/quoteAssetCatalog.js. */
export interface QuoteCatalogResult {
  id: string;
  assetId: string | null;
  provider: {
    id?: string | null;
    key: string;
    displayName?: string;
    authorityMode?: string;
    providerClass?: string;
  };
  chainId: string;
  identityKind: string;
  contractAddressOrMint: string;
  assetClass: QuoteAssetClass;
  symbol?: string | null;
  stateVersion: number;
  newGraduationEligible: boolean;
  existingMarketSupport: boolean;
  policy: {
    authority: string;
    policyKey: string | null;
    version: number | null;
  };
}

/** Exact Agent 3 BNB catalog commitment fields consumed after graduation. */
export interface BnbGraduatedQuoteBinding {
  deploymentId: string;
  quoteToken: string;
  providerKey: string;
  policyKey: string;
  policyVersion: bigint | number | string;
}

export interface AssetRef {
  asset: string;
  address: string;
  symbol?: string;
}

export interface NormalizedMarketIdentity {
  baseAsset: string;
  baseAddress: string;
  quoteAsset: string;
  quoteAddress: string;
  quoteAssetClass: QuoteAssetClass;
  provider: string;
  poolAddress: string;
  venue: string;
  chainId: string;
  campaignGeneration: string;
  marketGeneration: string;
  quoteAssetId: string | null;
  quoteDeploymentId: string;
  quotePolicyKey: string;
  quotePolicyVersion: number;
  quotePolicyAuthority: string;
}

export interface NormalizedTradeRecord {
  market: NormalizedMarketIdentity;
  side: "BUY" | "SELL";
  baseAmountRaw: RawAmountString;
  quoteAmountRaw: RawAmountString;
  txHash: string;
  blockTime: string;
}

interface ReferenceBinding {
  quoteAddress: string;
  quotePolicyKey: string;
  quotePolicyVersion: number;
}

export interface AvailableQuoteUsdReference extends ReferenceBinding {
  status: "available";
  provider: string;
  priceUsd: DecimalString;
  observedAt: string;
  validUntil: string;
}
export interface MissingQuoteUsdReference extends ReferenceBinding {
  status: "missing";
  reason: string;
}
export interface StaleQuoteUsdReference extends ReferenceBinding {
  status: "stale";
  provider: string;
  priceUsd: DecimalString;
  observedAt: string;
  validUntil: string;
  reason: string;
}
export type QuoteUsdReference = AvailableQuoteUsdReference | MissingQuoteUsdReference | StaleQuoteUsdReference;

export interface QuoteDenominatedMarketMetrics {
  priceQuote: DecimalString;
  marketCapQuote: DecimalString;
  liquidityQuote: DecimalString;
  volumeQuote: DecimalString;
}

export interface NormalizedUsdMarketSnapshot extends QuoteDenominatedMarketMetrics {
  market: NormalizedMarketIdentity;
  referenceStatus: ReferenceState;
  quoteUsdReference: DecimalString | null;
  referenceProvider: string | null;
  referenceObservedAt: string | null;
  referenceValidUntil: string | null;
  priceUsd: DecimalString | null;
  marketCapUsd: DecimalString | null;
  liquidityUsd: DecimalString | null;
  volumeUsd: DecimalString | null;
  degradedReason: string | null;
}

export interface MarketTradeIntent {
  side: "BUY" | "SELL";
  userInputAsset: AssetRef;
  userOutputAsset: AssetRef;
  routingPath: AssetRef[];
  market: NormalizedMarketIdentity;
}

export interface NormalizedLpFeeInput {
  market: NormalizedMarketIdentity;
  baseFeeAmountRaw: RawAmountString;
  quoteFeeAmountRaw: RawAmountString;
  quoteDecimals: number;
  quoteSymbol: string;
  quoteReference: QuoteUsdReference;
}
export interface NormalizedLpFeeReport {
  baseFeeAmountRaw: RawAmountString;
  quoteFeeAmountRaw: RawAmountString;
  quoteSymbol: string;
  quoteAddress: string;
  quoteReferenceStatus: ReferenceState;
  quoteUsdReference: DecimalString | null;
  quoteUsdEstimate: DecimalString | null;
  degradedReason: string | null;
}
export interface ArenaMarketSnapshot {
  marketId: string;
  priceUsd: DecimalString;
  marketCapUsd: DecimalString;
  liquidityUsd: DecimalString;
  volumeUsd: DecimalString;
}

interface ParsedDecimal { coefficient: bigint; scale: number; }
const DECIMAL_RE = /^([+-]?)(\d+)(?:\.(\d+))?$/;
const RAW_RE = /^\d+$/;

function parseDecimal(value: DecimalString): ParsedDecimal {
  const match = DECIMAL_RE.exec(value);
  if (!match) throw new Error(`invalid decimal string: ${value}`);
  const fraction = match[3] ?? "";
  return { coefficient: (match[1] === "-" ? -1n : 1n) * BigInt(`${match[2]}${fraction}`), scale: fraction.length };
}
function formatDecimal(value: ParsedDecimal): DecimalString {
  const negative = value.coefficient < 0n;
  let digits = (negative ? -value.coefficient : value.coefficient).toString();
  if (value.scale > 0) {
    digits = digits.padStart(value.scale + 1, "0");
    const split = digits.length - value.scale;
    digits = `${digits.slice(0, split)}.${digits.slice(split)}`.replace(/\.?0+$/, "");
  }
  if (!digits || digits === "-0") digits = "0";
  return `${negative && digits !== "0" ? "-" : ""}${digits}`;
}
export function multiplyDecimalStrings(a: DecimalString, b: DecimalString): DecimalString {
  const left = parseDecimal(a); const right = parseDecimal(b);
  return formatDecimal({ coefficient: left.coefficient * right.coefficient, scale: left.scale + right.scale });
}
export function rawAmountToDecimal(raw: RawAmountString, decimals: number): DecimalString {
  if (!RAW_RE.test(raw)) throw new Error(`invalid raw amount: ${raw}`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error(`invalid decimals: ${decimals}`);
  return formatDecimal({ coefficient: BigInt(raw), scale: decimals });
}
function assertAddressMatch(actual: string, expected: string, label: string): void {
  if (actual === expected) return;
  if (actual.startsWith("0x") && expected.startsWith("0x") && actual.toLowerCase() === expected.toLowerCase()) return;
  throw new Error(`${label} address mismatch`);
}

/**
 * Bind an actual Agent 1 catalog result to a NEW market. The only eligibility
 * decision consumed here is Agent 1's newGraduationEligible boolean. Agent 4
 * deliberately does not inspect/rederive identity/security/market/policy gates.
 */
export function bindMarketToCatalogResult(
  market: Omit<NormalizedMarketIdentity,
    "quoteAssetClass" | "provider" | "quoteAssetId" | "quoteDeploymentId" |
    "quotePolicyKey" | "quotePolicyVersion" | "quotePolicyAuthority">,
  catalog: QuoteCatalogResult,
): NormalizedMarketIdentity {
  if (catalog.newGraduationEligible !== true) throw new Error("Agent 1 quote catalog did not approve new graduation");
  if (market.chainId !== String(catalog.chainId)) throw new Error("quote catalog chain mismatch");
  assertAddressMatch(market.quoteAddress, catalog.contractAddressOrMint, "quote catalog");
  if (!catalog.id) throw new Error("quote catalog deployment id missing");
  if (!catalog.provider?.key) throw new Error("quote catalog provider key missing");
  if (!catalog.policy?.policyKey || !Number.isInteger(catalog.policy.version)) throw new Error("quote catalog policy key/version missing");
  return {
    ...market,
    quoteAsset: catalog.symbol || market.quoteAsset,
    quoteAssetClass: catalog.assetClass,
    provider: catalog.provider.key,
    quoteAssetId: catalog.assetId,
    quoteDeploymentId: catalog.id,
    quotePolicyKey: catalog.policy.policyKey,
    quotePolicyVersion: catalog.policy.version as number,
    quotePolicyAuthority: catalog.policy.authority,
  };
}

/**
 * Consume Agent 3's immutable BNB quote commitment plus the same Agent 1 catalog
 * result and bind the actual graduated MEME/QUOTE pool into Agent 4. This only
 * checks identity continuity; it never recomputes quote eligibility.
 */
export function bindBnbGraduatedMarketToCatalogResult(
  market: Omit<NormalizedMarketIdentity,
    "quoteAssetClass" | "provider" | "quoteAssetId" | "quoteDeploymentId" |
    "quotePolicyKey" | "quotePolicyVersion" | "quotePolicyAuthority">,
  bnbBinding: BnbGraduatedQuoteBinding,
  catalog: QuoteCatalogResult,
): NormalizedMarketIdentity {
  if (bnbBinding.deploymentId !== catalog.id) throw new Error("Agent 3 BNB quote deployment mismatch");
  assertAddressMatch(bnbBinding.quoteToken, catalog.contractAddressOrMint, "Agent 3 BNB quote");
  if (bnbBinding.providerKey !== catalog.provider?.key) throw new Error("Agent 3 BNB quote provider mismatch");
  if (bnbBinding.policyKey !== catalog.policy?.policyKey) throw new Error("Agent 3 BNB quote policy key mismatch");
  if (String(bnbBinding.policyVersion) !== String(catalog.policy?.version)) throw new Error("Agent 3 BNB quote policy version mismatch");
  assertAddressMatch(market.quoteAddress, bnbBinding.quoteToken, "graduated BNB market quote");
  return bindMarketToCatalogResult(market, catalog);
}

export function classifyQuoteReference(market: NormalizedMarketIdentity, reference: QuoteUsdReference, now = new Date()): QuoteUsdReference {
  assertAddressMatch(reference.quoteAddress, market.quoteAddress, "quote reference");
  if (reference.quotePolicyKey !== market.quotePolicyKey || reference.quotePolicyVersion !== market.quotePolicyVersion) {
    throw new Error("quote reference policy mismatch");
  }
  if (reference.status !== "available") return reference;
  const validUntilMs = Date.parse(reference.validUntil);
  if (!Number.isFinite(validUntilMs)) throw new Error("invalid quote reference validUntil");
  if (now.getTime() > validUntilMs) return { ...reference, status: "stale", reason: "authoritative quote/USD reference expired" };
  return reference;
}

export function normalizeMarketUsd(market: NormalizedMarketIdentity, metrics: QuoteDenominatedMarketMetrics, reference: QuoteUsdReference, now = new Date()): NormalizedUsdMarketSnapshot {
  const effective = classifyQuoteReference(market, reference, now);
  if (effective.status !== "available") return {
    market, ...metrics, referenceStatus: effective.status,
    quoteUsdReference: effective.status === "stale" ? effective.priceUsd : null,
    referenceProvider: effective.status === "stale" ? effective.provider : null,
    referenceObservedAt: effective.status === "stale" ? effective.observedAt : null,
    referenceValidUntil: effective.status === "stale" ? effective.validUntil : null,
    priceUsd: null, marketCapUsd: null, liquidityUsd: null, volumeUsd: null, degradedReason: effective.reason,
  };
  return {
    market, ...metrics, referenceStatus: "available", quoteUsdReference: effective.priceUsd,
    referenceProvider: effective.provider, referenceObservedAt: effective.observedAt, referenceValidUntil: effective.validUntil,
    priceUsd: multiplyDecimalStrings(metrics.priceQuote, effective.priceUsd),
    marketCapUsd: multiplyDecimalStrings(metrics.marketCapQuote, effective.priceUsd),
    liquidityUsd: multiplyDecimalStrings(metrics.liquidityQuote, effective.priceUsd),
    volumeUsd: multiplyDecimalStrings(metrics.volumeQuote, effective.priceUsd), degradedReason: null,
  };
}

export function normalizeChartValueUsd(market: NormalizedMarketIdentity, valueQuote: DecimalString, reference: QuoteUsdReference, now = new Date()): { status: ReferenceState; valueUsd: DecimalString | null; reason: string | null } {
  const effective = classifyQuoteReference(market, reference, now);
  if (effective.status !== "available") return { status: effective.status, valueUsd: null, reason: effective.reason };
  return { status: "available", valueUsd: multiplyDecimalStrings(valueQuote, effective.priceUsd), reason: null };
}
function sameAsset(a: AssetRef, b: AssetRef): boolean {
  if (a.address === b.address) return true;
  return a.address.startsWith("0x") && b.address.startsWith("0x") && a.address.toLowerCase() === b.address.toLowerCase();
}
export function validateTradeIntent(intent: MarketTradeIntent): void {
  if (intent.routingPath.length < 2) throw new Error("routing path is too short");
  if (!sameAsset(intent.routingPath[0], intent.userInputAsset)) throw new Error("route does not start with user input asset");
  if (!sameAsset(intent.routingPath[intent.routingPath.length - 1], intent.userOutputAsset)) throw new Error("route does not end with user output asset");
  const base: AssetRef = { asset: intent.market.baseAsset, address: intent.market.baseAddress };
  const quote: AssetRef = { asset: intent.market.quoteAsset, address: intent.market.quoteAddress };
  let hasMarketEdge = false;
  for (let i = 0; i < intent.routingPath.length - 1; i += 1) {
    const a = intent.routingPath[i]; const b = intent.routingPath[i + 1];
    if ((sameAsset(a, quote) && sameAsset(b, base)) || (sameAsset(a, base) && sameAsset(b, quote))) { hasMarketEdge = true; break; }
  }
  if (!hasMarketEdge) throw new Error("route does not cross actual MEME/QUOTE market edge");
  if (intent.side === "BUY" && !sameAsset(intent.userOutputAsset, base)) throw new Error("BUY must output market base asset");
  if (intent.side === "SELL" && !sameAsset(intent.userInputAsset, base)) throw new Error("SELL must input market base asset");
}
export function normalizeLpFeeReport(input: NormalizedLpFeeInput, now = new Date()): NormalizedLpFeeReport {
  const effective = classifyQuoteReference(input.market, input.quoteReference, now);
  if (effective.status !== "available") return {
    baseFeeAmountRaw: input.baseFeeAmountRaw, quoteFeeAmountRaw: input.quoteFeeAmountRaw,
    quoteSymbol: input.quoteSymbol, quoteAddress: input.market.quoteAddress,
    quoteReferenceStatus: effective.status, quoteUsdReference: effective.status === "stale" ? effective.priceUsd : null,
    quoteUsdEstimate: null, degradedReason: effective.reason,
  };
  const quoteAmount = rawAmountToDecimal(input.quoteFeeAmountRaw, input.quoteDecimals);
  return {
    baseFeeAmountRaw: input.baseFeeAmountRaw, quoteFeeAmountRaw: input.quoteFeeAmountRaw,
    quoteSymbol: input.quoteSymbol, quoteAddress: input.market.quoteAddress, quoteReferenceStatus: "available",
    quoteUsdReference: effective.priceUsd, quoteUsdEstimate: multiplyDecimalStrings(quoteAmount, effective.priceUsd), degradedReason: null,
  };
}
export function toArenaMarketSnapshot(marketId: string, snapshot: NormalizedUsdMarketSnapshot): ArenaMarketSnapshot | null {
  if (snapshot.referenceStatus !== "available" || snapshot.priceUsd === null || snapshot.marketCapUsd === null || snapshot.liquidityUsd === null || snapshot.volumeUsd === null) return null;
  return { marketId, priceUsd: snapshot.priceUsd, marketCapUsd: snapshot.marketCapUsd, liquidityUsd: snapshot.liquidityUsd, volumeUsd: snapshot.volumeUsd };
}
