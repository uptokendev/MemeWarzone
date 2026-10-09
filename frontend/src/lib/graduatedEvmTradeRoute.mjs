/**
 * Graduated MemeWarzone coins on BNB and Robinhood trade through the import route (founder, 2026-10-09: "I just want
 * the same for the graduates as for the imports"): the same quote / build / fee / route checks and the same panel as
 * an imported coin (ImportedTradePanel), so every in-app buy and sell of a graduated coin pays the 1% import fee to the
 * chain's ImportFeeVault, half of it the coin's creator's. LP fees of the coin's pool are separate and unchanged.
 *
 * Bonding-curve trades are not routed here: a coin that has not graduated keeps its curve path exactly as before.
 *
 * Per chain, the import route is used only while that chain's import fee route to the ImportFeeVault is switched on;
 * otherwise a graduated coin keeps today's direct pool trade (so live keeps its behaviour until the vault exists):
 *   56     VITE_IMPORT_FEE_VAULT_56 is set (the API's Kyber switch is IMPORT_FEE_VAULT_56 = IMPORT_SWAP_FEE_RECEIVER_56;
 *          set the API pair first, then this one). The panel also refuses a quote that does not carry the creator
 *          split, so a graduated coin never pays the old 0.5% protocol-only fee. No Kyber route: the Topaz pool
 *          through ImportSwapFeeRouter (VITE_IMPORT_SWAP_FEE_ROUTER_56), else no trade, exactly as an import.
 *   97     VITE_IMPORT_SWAP_FEE_ROUTER_97 is set (testnet: Topaz through the fee router, which pays the vault).
 *   4663   the Universal Router terms are split (VITE_IMPORT_FEE_VAULT_4663 = VITE_IMPORT_SWAP_FEE_RECEIVER_4663).
 *   46630  never: the testnet has no fee-taking route (imports there use the fee-less adapter), so graduated coins
 *          keep their direct pool trade.
 * Plain ESM so node tests and the fork proofs run the same decision as the app.
 */
import { importSwapFeeRouterAddress } from "./importSwapFeeRouter.mjs";
import { importSwapFeeTerms4663 } from "./robinhoodImportSwap.mjs";

export const GRADUATED_IMPORT_ROUTE_CHAINS = Object.freeze([56, 97, 4663]);

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

const isVault = (value) => {
  const raw = String(value ?? "").trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(raw) && !/^0x0{40}$/.test(raw);
};

/** True while `chainId` takes the import fee to its ImportFeeVault in the app (see the table above). */
export function graduatedImportRouteEnabled(chainId, env = moduleEnv()) {
  const id = Number(chainId);
  if (id === 56) return isVault(env?.VITE_IMPORT_FEE_VAULT_56);
  if (id === 97) return Boolean(importSwapFeeRouterAddress(97, env));
  if (id === 4663) return importSwapFeeTerms4663(env).split === true;
  return false;
}

/**
 * Which path an in-app trade of a MemeWarzone EVM coin takes:
 *   "bonding"      not graduated: the coin's own bonding-curve path, unchanged
 *   "import"       graduated, import fee route on for the chain: ImportedTradePanel (Kyber / fee router / Universal Router)
 *   "direct-pool"  graduated, switch off (or a chain without a fee route): today's direct pool trade
 */
export function graduatedEvmTradeRoute({ chainId, graduated }, env = moduleEnv()) {
  if (!graduated) return "bonding";
  return graduatedImportRouteEnabled(chainId, env) ? "import" : "direct-pool";
}

/**
 * A graduated coin only trades on a quote that carries the creator's half of the fee. Imports accept the old
 * protocol-only terms while a chain has not switched; a graduated coin never does.
 */
export function assertGraduatedImportQuote(quote) {
  const fee = Number(quote?.feeBps || 0);
  const creator = Number(quote?.creatorShareBps || 0);
  if (!(fee > 0) || !(creator > 0) || creator > fee) {
    throw Object.assign(new Error("Swaps for this coin are paused while the fee route is updated. Try again later."), { code: "GRADUATED_IMPORT_FEE_OFF" });
  }
  return quote;
}

/** The ArenaImportItem shape ImportedTradePanel takes, for a graduated MemeWarzone campaign. */
export function graduatedCampaignTradeItem(campaign, chainId) {
  return {
    id: `campaign:${Number(chainId)}:${String(campaign?.campaign || "").toLowerCase()}`,
    chainId: Number(chainId),
    tokenAddress: String(campaign?.token || ""),
    ownerWallet: String(campaign?.creator || ""),
    name: campaign?.name ?? null,
    symbol: campaign?.symbol ?? null,
    imageUrl: campaign?.logoURI ?? null,
    status: "passed",
  };
}
