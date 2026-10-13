// Imported first by api/server.mjs. ES module imports all run before the importing module's body,
// and several modules create their RPC clients while being imported (createSolanaImportTrades
// captures fetch at import), so the counters must be installed by an import, not by a call in
// server.mjs's body: otherwise those requests are never counted.
import { installRpcUsageCounters } from "./rpcUsage.js";

installRpcUsageCounters();
