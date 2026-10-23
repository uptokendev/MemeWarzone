import "./rpcUsagePreload.js";
import { indexerRoles } from "./evm/payoutWatchdogConfig.js";

/**
 * INDEXER_ROLE (payoutWatchdogConfig.ts indexerRoles):
 *   unset            the indexer (indexerMain.ts) and the payout watchdog, the watchdog only when no operator key
 *                    (EVM_GEN8_OPERATOR_KEY[_<id>], EVM_CREATOR_CHOICE_OPERATOR_PRIVATE_KEY[_<id>]) is in this env;
 *   payout-watchdog  only the payout watchdog (its own Coolify service, no operator key, no API);
 *   indexer          only the indexer.
 */
const roles = indexerRoles(process.env);
console.log("[main] roles", roles);
if (roles.watchdog) {
  const { startPayoutWatchdogWorker } = await import("./evm/payoutWatchdogWorker.js");
  void startPayoutWatchdogWorker().catch((error) => console.error("[payout-watchdog] start failed", error));
}
if (roles.indexer) {
  await import("./indexerMain.js");
} else if (roles.watchdog) {
  // A watchdog-only service: a minimal health endpoint on PORT (when set) for the container's health check.
  const port = Number(process.env.PORT || 0);
  if (port > 0) {
    const http = await import("node:http");
    http
      .createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, role: "payout-watchdog" }));
      })
      .listen(port);
  }
}
