#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";

const EXPECTED_CHAIN_ID = "101";
const EXPECTED_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const EXPECTED_PROGRAM_ID = "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt";
const EXPECTED_SBF_SHA256 = "27ad65b560dba8a33330bd95f08ae7ca6945f71ebf667a5a3756ae0cb9f7f080";
const EXPECTED_SBF_BYTES = 1165328;

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`[solana:network-canary] ${name} is required`);
  return value;
}

const chainId = required("SOLANA_APPLICATION_CHAIN_ID");
if (chainId !== EXPECTED_CHAIN_ID) {
  throw new Error(`[solana:network-canary] active certification is chain ${EXPECTED_CHAIN_ID} only; received ${chainId}`);
}
for (const legacyName of ["SOLANA_SQUAD_CHAIN_ID", "SQUAD_SOLANA_CHAIN_ID", "AIRDROP_CHAIN_ID", "RECRUITER_SOLANA_CHAIN_ID", "LEAGUE_SOLANA_CHAIN_ID"]) {
  if (String(process.env[legacyName] || "").trim() === "102") {
    throw new Error(`[solana:network-canary] legacy chain 102 variable ${legacyName} is forbidden in active financial certification`);
  }
}
if (required("SOLANA_LAUNCHPAD_PROGRAM_ID") !== EXPECTED_PROGRAM_ID) {
  throw new Error("[solana:network-canary] launchpad program identity mismatch");
}
if (required("SOLANA_EXPECTED_DEVNET_GENESIS") !== EXPECTED_GENESIS) {
  throw new Error("[solana:network-canary] expected devnet genesis mismatch");
}
if (required("SOLANA_LAUNCHPAD_PROGRAM_SHA256").toLowerCase() !== EXPECTED_SBF_SHA256) {
  throw new Error("[solana:network-canary] configured live SBF SHA-256 mismatch");
}
if (Number(required("SOLANA_LAUNCHPAD_PROGRAM_BYTES")) !== EXPECTED_SBF_BYTES) {
  throw new Error("[solana:network-canary] configured live SBF byte size mismatch");
}
required("SOLANA_RPC_URL");
required("SOLANA_DEVNET_PAYER");
required("SOLANA_DEVNET_ROUTE_SIGNER_SECRET_KEY");
required("SOLANA_UPGRADE_AUTHORITY_PUBLIC_KEY");

const packageJson = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
if (packageJson.scripts?.["solana:network-canary"] !== "bash scripts/solana/network-canary.sh") {
  throw new Error("[solana:network-canary] package runner is not pinned to scripts/solana/network-canary.sh");
}
const legacyMigration = fs.readFileSync(new URL("../../frontend/supabase/migrations/20260907163000_solana_devnet_basic_quote_certification.sql", import.meta.url), "utf8");
if (!legacyMigration.includes("native:102")) {
  throw new Error("[solana:network-canary] legacy 102 migration history changed unexpectedly; do not reinterpret it as 101");
}
const canonicalCatalog = fs.readFileSync(new URL("../../frontend/supabase/migrations/20260907001000_solana_basic_quote_catalog.sql", import.meta.url), "utf8");
if (!canonicalCatalog.includes("native:101") || !canonicalCatalog.includes("'101', 'NATIVE'")) {
  throw new Error("[solana:network-canary] canonical native:101 graduation catalog row is missing");
}
const selfSha = crypto.createHash("sha256").update(fs.readFileSync(new URL(import.meta.url))).digest("hex");
console.log(JSON.stringify({
  status: "PASS",
  mode: "solana-devnet",
  applicationChainId: EXPECTED_CHAIN_ID,
  historicalChain102: "preserved-history-only",
  programId: EXPECTED_PROGRAM_ID,
  expectedGenesis: EXPECTED_GENESIS,
  expectedSbfSha256: EXPECTED_SBF_SHA256,
  expectedSbfBytes: EXPECTED_SBF_BYTES,
  runnerSha256: selfSha,
}, null, 2));