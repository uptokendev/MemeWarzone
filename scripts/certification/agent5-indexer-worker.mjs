#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const dist = (name) => pathToFileURL(path.join(root, "realtime-indexer/dist", name)).href;
const mode = String(process.env.CERT_INDEXER_MODE || "").trim();
const campaign = String(process.env.CERT_CAMPAIGN || "").trim();
const from = Number(process.env.CERT_FROM || 0);
const to = Number(process.env.CERT_TO || 0);
const signature = String(process.env.CERT_SIGNATURE || "").trim();

if (mode === "bnb-bonding") {
  if (!campaign || !from || !to) throw new Error("bnb-bonding requires CERT_CAMPAIGN/CERT_FROM/CERT_TO");
  const mod = await import(dist("indexer.js"));
  await mod.runTradeRepairOnce(campaign, { fromBlock: from, toBlock: to });
} else if (mode === "bnb-postgrad") {
  const mod = await import(dist("topazPoolIndexer.js"));
  await mod.runTopazPoolIndexerOnce();
} else if (mode === "solana-bonding") {
  if (!campaign || !signature) throw new Error("solana-bonding requires CERT_CAMPAIGN/CERT_SIGNATURE");
  const mod = await import(dist("solanaIndexer.js"));
  const result = await mod.ingestSolanaSignatures(campaign, [signature]);
  if (!result?.ok || result.scanned !== 1) throw new Error(`unexpected Solana ingest result ${JSON.stringify(result)}`);
} else if (mode === "solana-postgrad") {
  const mod = await import(dist("meteoraSwapIndexer.js"));
  await mod.runMeteoraSwapIndexerOnce();
} else {
  throw new Error(`unsupported CERT_INDEXER_MODE ${mode}`);
}

console.log(JSON.stringify({ result: "PASS", mode, processRestartBoundary: true }));
process.exit(0);
