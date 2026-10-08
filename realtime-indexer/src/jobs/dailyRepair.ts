import { runRepairOnce } from "../indexer.js";
import { logRpcUsageOnExit } from "../rpcUsage.js";

// One [rpc-usage] line at exit: what this run sent per chain and method.
logRpcUsageOnExit();

// Designed to be run as a one-off process (e.g., Railway cron service).
// It rewinds recent cursor state and replays a bounded lookback window.

async function main() {
  await runRepairOnce();
}

main()
  .then(() => {
    // Ensure clean process exit for cron-style runs
    process.exit(0);
  })
  .catch((e) => {
    console.error("dailyRepair failed", e);
    process.exit(1);
  });
