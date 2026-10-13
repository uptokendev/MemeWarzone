// Imported first by run-arena-battle-realtime-worker.mjs, for the same reason as
// api/lib/rpcUsageInstall.js: imports run before the worker's body, and modules that capture fetch
// while being imported would otherwise send uncounted requests.
import { installRpcUsageCounters } from "../api/lib/rpcUsage.js";

installRpcUsageCounters({ label: "arena-worker-rpc" });
