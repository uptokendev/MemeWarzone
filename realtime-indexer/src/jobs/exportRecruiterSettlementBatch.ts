import dns from "node:dns";
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {}

import { publishRecruiterSettlementBatches } from "../rewards/publishRecruiterSettlement.js";

async function main() {
  const sha = process.env.SOURCE_COMMIT || process.env.COOLIFY_GIT_COMMIT_SHA || process.env.GIT_SHA || "unset";
  console.log(`[exportRecruiterSettlementBatch] BUILD_SHA=${sha}`);
  const result = await publishRecruiterSettlementBatches();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("[exportRecruiterSettlementBatch] fatal", error);
  process.exit(1);
});
