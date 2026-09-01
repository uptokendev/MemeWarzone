import dns from "node:dns";
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {}

import { publishRecruiterSettlementBatchesV2 } from "../rewards/publishRecruiterSettlementV2.js";

function isEmptySettlement(error: unknown): boolean {
  const message = String((error as any)?.message || error || "");
  return message.startsWith("No valid recruiter settlement recipients.");
}

async function main() {
  const sha = process.env.SOURCE_COMMIT || process.env.COOLIFY_GIT_COMMIT_SHA || process.env.GIT_SHA || "unset";
  console.log(`[exportRecruiterSettlementBatch] BUILD_SHA=${sha}`);
  try {
    const result = await publishRecruiterSettlementBatchesV2();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (!isEmptySettlement(error)) throw error;
    console.warn("[exportRecruiterSettlementBatch] no-op: no valid recruiter settlement recipients for this weekly epoch");
    console.log(JSON.stringify({
      ok: true,
      published: 0,
      prepared: 0,
      note: "No valid recruiter settlement recipients for this weekly epoch.",
    }, null, 2));
  }
}

main().catch((error) => {
  console.error("[exportRecruiterSettlementBatch] fatal", error);
  process.exit(1);
});
