/**
 * Second widget file (mwz-swap-bonding.js): the app's launchpad and DBC trade code, loaded by mwz-swap.js
 * only for a bonding coin, so import-only sites do not download Meteora's toolkit.
 */
import { quoteBonding, tradeBonding } from "./bonding";
import { setWidgetApiBase } from "./shims/apiBase";
import { setWidgetSolanaProvider } from "./shims/solanaWallet";

(globalThis as any).__MemeWarzoneSwapBonding = { quoteBonding, tradeBonding, setWidgetApiBase, setWidgetSolanaProvider };
