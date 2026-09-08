#!/usr/bin/env node
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
export const BNB_MAINNET_CHAIN_ID = 56;

export function proveRobinhoodIndexerContinuity({ rows, campaignAddress, expectedChainId = ROBINHOOD_TESTNET_CHAIN_ID }) {
  if (!campaignAddress) throw new Error("campaign address is required for continuity proof");
  const normalized = String(campaignAddress).toLowerCase();
  const list = Array.isArray(rows) ? rows : [];
  const aliased = list.filter((row) => Number(row.chain_id) === BNB_MAINNET_CHAIN_ID);
  if (aliased.length) {
    throw new Error(`campaign ${normalized} is recorded on chain 56; Robinhood must never alias to BNB`);
  }
  const matched = list.filter((row) => Number(row.chain_id) === expectedChainId);
  if (!matched.length) {
    throw new Error(`campaign ${normalized} is not recorded as chain ${expectedChainId}`);
  }
  return true;
}

function loadPg() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const require = createRequire(path.join(here, "..", "frontend", "package.json"));
  return require("pg");
}

async function loadRows(databaseUrl, campaignAddress) {
  const pg = loadPg();
  const client = new pg.Client({ connectionString: databaseUrl, ssl: false });
  await client.connect();
  try {
    const exists = await client.query("select to_regclass('public.campaigns') as relation");
    if (!exists.rows[0]?.relation) {
      throw new Error("public.campaigns is missing; Robinhood continuity cannot be proven");
    }
    const result = await client.query(
      `select chain_id, campaign_address
       from public.campaigns
       where lower(campaign_address) = lower($1)`,
      [campaignAddress],
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

function runningAsCli() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (runningAsCli()) {
  const campaignAddress = process.argv[2] || process.env.ROBINHOOD_CONTINUITY_CAMPAIGN;
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!campaignAddress) {
    console.error("usage: DATABASE_URL=... node scripts/prove-robinhood-testnet-indexer-continuity.mjs <campaign>");
    process.exit(2);
  }
  if (!databaseUrl) {
    console.error("DATABASE_URL is required to prove Robinhood indexer continuity");
    process.exit(2);
  }
  loadRows(databaseUrl, campaignAddress)
    .then((rows) => {
      proveRobinhoodIndexerContinuity({ rows, campaignAddress });
      console.log("Robinhood indexer continuity passed: chain_id=46630 with no 56 alias");
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
