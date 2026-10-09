/**
 * Graduated MemeWarzone coins on Solana trade through the import route (founder, 2026-10-09: "the same for the
 * graduates as for the imports"): Jupiter with the 1% import fee, the same quote / build / panel as an imported coin
 * (ImportedTradePanel). The creator's half goes to the coin's creator (campaigns.creator_address) with no claim, hold
 * or expiry (financeImportSwapFees.js accrues it as campaign_creator; realtime-indexer importCreatorFees.ts pays it).
 * BNB and Robinhood: graduatedEvmTradeRoute.mjs (gen-7).
 *
 * Bonding coins keep their curve path untouched; the CREATE / BUY / SELL transactions do not change.
 * A graduated launchpad coin (curve graduated on chain) or a migrated DBC coin uses the import route only while
 * VITE_SOLANA_GRADUATED_IMPORT_ROUTE is on; off, today's direct Meteora pool trade. Turn it on only after the API
 * runs the split (SOLANA_IMPORT_FEE_COLLECTOR set): the panel also refuses a quote without the creator's half.
 * Plain ESM so node tests run the same decision as the app.
 */

function moduleEnv() {
  let vite = {};
  try {
    vite = import.meta.env || {};
  } catch {
    vite = {};
  }
  const node = typeof process !== "undefined" && process?.env ? process.env : {};
  return { ...node, ...vite };
}

const PAUSED = "Swaps for this coin are paused while the fee route is updated. Try again later.";

export function solanaGraduatedImportRouteEnabled(env = moduleEnv()) {
  return ["1", "true", "yes", "on"].includes(String(env?.VITE_SOLANA_GRADUATED_IMPORT_ROUTE ?? "").trim().toLowerCase());
}

/** A launchpad coin whose curve graduated on chain, or a DBC coin whose pool migrated. Never a coin still on its curve. */
export function solanaCoinGraduated({ isDbc, dbcMigrated, curveGraduated }) {
  return isDbc ? Boolean(dbcMigrated) : Boolean(curveGraduated);
}

/** "bonding" (curve path), "import" (ImportedTradePanel, Jupiter, 1%) or "direct-pool" (today's Meteora trade). */
export function graduatedSolanaTradeRoute(coin, env = moduleEnv()) {
  if (!solanaCoinGraduated(coin)) return "bonding";
  return solanaGraduatedImportRouteEnabled(env) ? "import" : "direct-pool";
}

/** A graduated coin trades only on a quote that carries the creator's half of the fee (split mode on the API). */
export function assertGraduatedSolanaQuote(quote) {
  const fee = Number(quote?.feeBps || 0);
  const creator = Number(quote?.creatorShareBps || 0);
  if (!(fee > 0) || !(creator > 0) || creator > fee) throw Object.assign(new Error(PAUSED), { code: "GRADUATED_IMPORT_FEE_OFF" });
  return quote;
}

export function graduatedSolanaPausedError() {
  return Object.assign(new Error(PAUSED), { code: "GRADUATED_IMPORT_FEE_OFF" });
}

/** The ArenaImportItem shape ImportedTradePanel takes, for a graduated Solana campaign (mint: the coin's mint). */
export function graduatedSolanaTradeItem(campaign, mint) {
  return {
    id: `campaign:101:${String(campaign?.campaign || "")}`,
    chainId: 101,
    tokenAddress: String(mint || campaign?.token || ""),
    ownerWallet: String(campaign?.creator || ""),
    name: campaign?.name ?? null,
    symbol: campaign?.symbol ?? null,
    imageUrl: campaign?.logoURI ?? null,
    status: "passed",
  };
}
