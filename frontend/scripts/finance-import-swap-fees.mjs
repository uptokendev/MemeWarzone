/**
 * Import swap fee (0.5%) records: reads the fee transfers of imported-coin swaps from the chain and
 * stores them in public.finance_import_swap_fees (api/lib/financeImportSwapFees.js). The same scan
 * runs every 5 minutes inside cron:finance-snapshots; this script is for the one-off backfill and
 * for checking by hand.
 *
 *   node scripts/finance-import-swap-fees.mjs --dry-run              # all chains, read only
 *   node scripts/finance-import-swap-fees.mjs                        # all chains, store from the cursor
 *   node scripts/finance-import-swap-fees.mjs --chain 56 --from-scratch   # BNB from the launch block
 *   node scripts/finance-import-swap-fees.mjs --chain 4663 --from-block 77787156
 *
 * --dry-run reads the chain and the stored cursor and prints what it would store; it writes nothing.
 * --from-scratch ignores the stored cursor (rows already stored are skipped, never doubled).
 * RPC: Solana SOLANA_MAINNET_RPC_HTTP / SOLANA_RPC_URL; BNB and Robinhood the API's read RPCs
 * (BSC_RPC_HTTP_56 / ROBINHOOD_RPC_HTTP_4663; BNB needs one that serves eth_getLogs history).
 * Read-only towards the chain: nothing is signed or sent.
 */
import "../api/load-local-env.mjs";
import { ingestImportSwapFees } from "../api/lib/financeImportSwapFees.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : null;
};
const dryRun = flag("--dry-run");
const chainIds = value("--chain") ? [Number(value("--chain"))] : [101, 56, 4663];
const fromBlock = value("--from-block") ? Number(value("--from-block")) : null;

const { pool } = dryRun && !process.env.DATABASE_URL ? { pool: null } : await import("../server/db.js");

let failed = 0;
for (const chainId of chainIds) {
  try {
    // One run reads a bounded block range; repeat until the chain head (dry runs carry the position themselves).
    let next = fromBlock;
    let scratch = flag("--from-scratch");
    for (let round = 0; round < 50; round += 1) {
      const result = await ingestImportSwapFees({ db: pool, chainId, dryRun, fromScratch: scratch, fromBlock: next });
      const { rows, ...summary } = result;
      console.log("[finance-import-swap-fees]", JSON.stringify(summary));
      for (const r of rows) console.log("  ", r.occurredAt, r.txHash, r.side || "-", r.tokenAddress || "-", r.feeRaw, r.feeAsset, r.wallet, r.internalWallet ? "(internal)" : "");
      if (result.complete || chainId === 101) break;
      next = dryRun || scratch ? Number(result.cursorAfter) : null;
      scratch = false;
    }
  } catch (error) {
    failed += 1;
    console.error("[finance-import-swap-fees]", chainId, error?.message || error);
  }
}
if (failed) process.exitCode = 1;
await pool?.end?.().catch(() => undefined);
