import "dotenv/config";
import { pool } from "../db.js";
import { backfillSolanaCampaign } from "../solanaIndexer.js";

const arg = String(process.argv[2] || "").trim();

async function campaignsToBackfill(): Promise<string[]> {
  if (!arg) {
    throw new Error("usage: backfillSolanaCampaign <campaignPda>|--all");
  }
  if (arg === "--all") {
    const rows = await pool.query(
      `select campaign_address
         from public.campaigns
        where chain_id=101
        order by created_block asc nulls last, campaign_address asc`,
    );
    return rows.rows.map((row) => String(row.campaign_address || "").trim()).filter(Boolean);
  }
  return [arg];
}

try {
  const campaigns = await campaignsToBackfill();
  if (!campaigns.length) {
    console.log("[solana-campaign-backfill] no Solana campaigns");
  }
  for (const campaign of campaigns) {
    const result = await backfillSolanaCampaign(campaign);
    console.log("[solana-campaign-backfill] complete", result);
    if (result.failed > 0) process.exitCode = 1;
  }
} catch (error) {
  console.error(
    "[solana-campaign-backfill] fatal",
    error instanceof Error ? error.stack || error.message : String(error),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
