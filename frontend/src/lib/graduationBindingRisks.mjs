/**
 * What a creator is told before binding a launch to something other than SOL.
 *
 * Two sources, deliberately combined. The catalog returns `bindingRisks` read
 * from the mint itself -- a permanent delegate, a pausable authority, a transfer
 * hook -- and those are the specific powers this issuer actually holds. On top
 * of them sit consequences that are true of every non-native binding whether or
 * not a scan has run, because a creator choosing a quote for the first time
 * should not see an empty dialog just because the catalog has not been
 * rescanned.
 *
 * The program no longer refuses any of this: which asset a campaign graduates
 * against is the creator's decision. This is what makes that decision informed.
 */

/** Risks that hold for any non-SOL binding, independent of the token program. */
export const STRUCTURAL_BINDING_RISKS = Object.freeze([
  Object.freeze({
    code: "LIQUIDITY_LOCKED_FOREVER",
    severity: "high",
    title: "The liquidity is locked permanently",
    detail:
      "Graduation creates a pool and locks its liquidity for good. Whatever happens to this asset afterwards, the pool cannot be unwound or moved.",
  }),
  Object.freeze({
    code: "PRICE_FOLLOWS_QUOTE",
    severity: "medium",
    title: "Your token's price will follow this asset",
    detail:
      "Buyers trade your token against this asset, so its price and liquidity become part of yours. If it falls or thins out, your market does too.",
  }),
  Object.freeze({
    code: "CHECKED_ONCE",
    severity: "medium",
    title: "These checks happen once, at graduation",
    detail:
      "We verify this asset when your campaign graduates. Powers the issuer adds afterwards cannot be caught, and the pool stays locked either way.",
  }),
]);

const SEVERITY_ORDER = Object.freeze({ high: 0, medium: 1, info: 2 });

function normalizeRisk(risk) {
  if (!risk || typeof risk !== "object") return null;
  const code = String(risk.code || "").trim();
  const title = String(risk.title || "").trim();
  if (!code || !title) return null;
  return {
    code,
    title,
    detail: String(risk.detail || "").trim(),
    severity: SEVERITY_ORDER[risk.severity] === undefined ? "info" : risk.severity,
    armed: risk.armed === undefined ? null : Boolean(risk.armed),
  };
}

/**
 * The risks to show for a selected quote, most serious first.
 *
 * An issuer power that is present but not armed is reported as information
 * rather than a warning: a permanent delegate with no delegate set is not the
 * same thing as one that is set, and flattening the two would make every
 * Token-2022 asset look equally dangerous.
 */
export function bindingRisksForAsset(asset, { isNative = false } = {}) {
  if (isNative) return [];
  const fromCatalog = Array.isArray(asset?.bindingRisks) ? asset.bindingRisks : [];
  const issuerPowers = fromCatalog
    .map(normalizeRisk)
    .filter(Boolean)
    .map((risk) => (risk.armed === false ? { ...risk, severity: "info" } : risk));

  const seen = new Set(issuerPowers.map((risk) => risk.code));
  const structural = STRUCTURAL_BINDING_RISKS.filter((risk) => !seen.has(risk.code));

  return [...issuerPowers, ...structural].sort(
    (left, right) => (SEVERITY_ORDER[left.severity] ?? 2) - (SEVERITY_ORDER[right.severity] ?? 2),
  );
}

/** True when the creator must confirm before this quote can be used. */
export function bindingNeedsConfirmation(asset, { isNative = false } = {}) {
  return !isNative && Boolean(asset);
}

/** One line summarising why the dialog is being shown. */
export function bindingRiskHeadline(asset, risks) {
  const symbol = String(asset?.symbol || asset?.displayName || "this asset").trim();
  const armed = risks.filter((risk) => risk.armed === true).length;
  if (armed > 0) {
    return `${symbol} gives its issuer ${armed === 1 ? "a power" : `${armed} powers`} over your locked liquidity.`;
  }
  return `Your launch will be paired with ${symbol} instead of the chain's own coin.`;
}
