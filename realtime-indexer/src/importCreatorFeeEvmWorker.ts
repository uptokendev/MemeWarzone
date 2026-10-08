/**
 * Import swap fee worker (EVM: BNB 56 / 97, Robinhood 4663 / 46630): pays the coin creator's half of
 * the 1% import fee out of the chain's ImportFeeVault, expires what nobody claimed within 90 days and
 * sweeps our half to the ProtocolRevenueVault. Logic and safety rules: importCreatorFeesEvm.ts. The
 * Solana side is importCreatorFeeWorker.ts.
 *
 *   IMPORT_FEE_EVM_WORKER_ENABLED=true          off otherwise
 *   IMPORT_FEE_PAYOUT_SEND=true                 sends (shared with the Solana worker); a dry run otherwise
 *   IMPORT_FEE_VAULT_<chainId>                  the ImportFeeVault; a chain without it is skipped
 *   IMPORT_FEE_PAYOUT_OPERATOR_PK_<chainId>     the vault's operator key (send mode only; must equal vault.operator())
 *   PROTOCOL_REVENUE_VAULT_ADDRESS_<chainId>    sweep target (mainnet defaults built in; testnets need it)
 *   IMPORT_FEE_EVM_CHAINS                       optional subset, e.g. "97,46630"
 * RPC: BSC_RPC_HTTP_56 / BSC_RPC_HTTP_97 / ROBINHOOD_RPC_HTTP_4663 / ROBINHOOD_RPC_HTTP_46630 (first URL).
 */
import { pool } from "./db.js";
import { ENV } from "./env.js";
import { createStaticJsonRpcProvider, parseRpcList } from "./rpcProvider.js";
import {
  IMPORT_FEE_EVM_CHAINS,
  createEthersImportFeeChain,
  importFeeEvmSettings,
  importFeePayoutWallet,
  runImportCreatorFeeEvmPass,
  type ImportFeeChain,
  type ImportFeeEvmSettings,
} from "./importCreatorFeesEvm.js";

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

export function importFeeEvmRpcUrl(chainId: number): string {
  const list = chainId === 56 ? ENV.BSC_RPC_HTTP_56 : chainId === 97 ? ENV.BSC_RPC_HTTP_97 : chainId === 4663 ? ENV.ROBINHOOD_RPC_HTTP_4663 : chainId === 46630 ? ENV.ROBINHOOD_RPC_HTTP_46630 : "";
  return parseRpcList(list)[0] || "";
}

let started = false;

type ChainWorker = { settings: ImportFeeEvmSettings; chain: ImportFeeChain; operator: string; send: boolean; running: boolean };

export async function startImportCreatorFeeEvmWorker() {
  if (started) return;
  started = true;
  if (!truthy(process.env.IMPORT_FEE_EVM_WORKER_ENABLED)) {
    console.log("[import-fees-evm] disabled (set IMPORT_FEE_EVM_WORKER_ENABLED=true)");
    return;
  }
  const send = truthy(process.env.IMPORT_FEE_PAYOUT_SEND);
  const only = String(process.env.IMPORT_FEE_EVM_CHAINS || "").split(",").map((v) => Number(v.trim())).filter(Boolean);
  const workers: ChainWorker[] = [];
  for (const chainId of IMPORT_FEE_EVM_CHAINS) {
    if (only.length && !only.includes(chainId)) continue;
    const settings = importFeeEvmSettings(chainId);
    if (!settings) continue;
    const url = importFeeEvmRpcUrl(chainId);
    if (!url) {
      console.warn(`[import-fees-evm] chain ${chainId}: no RPC configured; skipped`);
      continue;
    }
    try {
      const wallet = importFeePayoutWallet(chainId);
      if (send && !wallet) {
        console.warn(`[import-fees-evm] chain ${chainId}: IMPORT_FEE_PAYOUT_SEND needs IMPORT_FEE_PAYOUT_OPERATOR_PK_${chainId}; skipped`);
        continue;
      }
      const provider = createStaticJsonRpcProvider(url, chainId, { timeoutMs: 20_000 });
      const chain = createEthersImportFeeChain(provider, settings.vault, send ? wallet : null, { maxLogRange: chainId === 56 || chainId === 97 ? 5000 : 100_000 });
      const vaultOperator = (await chain.readVault()).operator;
      const operator = wallet ? wallet.address : vaultOperator;
      if (operator.toLowerCase() !== vaultOperator.toLowerCase()) {
        console.error(`[import-fees-evm] chain ${chainId}: key ${operator} is not the vault's operator ${vaultOperator}; skipped`);
        continue;
      }
      workers.push({ settings, chain, operator, send, running: false });
      console.log("[import-fees-evm] enabled", {
        chainId,
        send,
        vault: settings.vault,
        operator,
        protocolVault: settings.protocolVault,
        minPayoutWei: settings.minPayoutWei.toString(),
        minSweepWei: settings.minSweepWei.toString(),
      });
    } catch (error) {
      console.error(`[import-fees-evm] chain ${chainId}: not started`, error instanceof Error ? error.message : String(error));
    }
  }
  if (!workers.length) {
    console.log("[import-fees-evm] no chain configured (IMPORT_FEE_VAULT_<chainId>)");
    return;
  }
  const intervalMs = Math.max(30_000, Number(process.env.IMPORT_FEE_WORKER_INTERVAL_MS || 60_000));
  const tick = async (w: ChainWorker) => {
    if (w.running) return;
    w.running = true;
    try {
      const result = await runImportCreatorFeeEvmPass({ db: pool, chain: w.chain, operator: w.operator, send: w.send, settings: w.settings });
      if (result.payouts.length || result.sweep || result.expired || result.skipped.length || result.resolved?.landed || result.resolved?.reset || result.resolved?.resent) {
        console.log("[import-fees-evm] pass", JSON.stringify(result));
      }
    } catch (error) {
      console.error(`[import-fees-evm] chain ${w.settings.chainId}: pass failed`, error instanceof Error ? error.message : String(error));
    } finally {
      w.running = false;
    }
  };
  for (const w of workers) {
    const initial = setTimeout(() => void tick(w), 25_000);
    initial.unref?.();
    const timer = setInterval(() => void tick(w), intervalMs);
    timer.unref?.();
  }
}
