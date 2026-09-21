#!/usr/bin/env node
/**
 * Seed the Quote Asset Catalog with test-network binding assets so the test
 * stack has something to graduate against, and approve the ones whose
 * identity and route are already proven in this repo:
 *
 *   Solana devnet  SOL (native)           approved
 *   Solana devnet  USDC 4zMMC9…DncDU     approved with the Orca devnet route the
 *                                        2026-09-07 certification used
 *   BNB testnet 97       BNB (native)     approved
 *   Robinhood testnet    ETH (native)     approved
 *
 * Wrapped/stable tokens on 97 and 46630 are not seeded: their addresses are
 * not recorded in this repo. Add them from the Command Center.
 *
 *   node scripts/seed-quote-catalog-testnet-candidates.mjs --db staging [--apply]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const dbArg = process.argv[process.argv.indexOf("--db") + 1] || "staging";
if (dbArg !== "staging") { console.error("only --db staging is supported"); process.exit(2); }

const envLocal = fs.readFileSync(path.resolve(here, "../.env.local"), "utf8");
const url = (envLocal.match(/^STAGING_DATABASE_URL=(.+)$/m) || [])[1]?.trim();
if (!url || !url.includes("vrnsbguutnwgtekcexls")) { console.error("STAGING_DATABASE_URL (vrnsbguutnwgtekcexls) is required in frontend/.env.local"); process.exit(2); }
process.env.DATABASE_URL = url;
process.env.PG_SSL_ALLOW_SELF_SIGNED = process.env.PG_SSL_ALLOW_SELF_SIGNED || "1";

const { pool } = await import("../server/db.js");
const { createQuoteCatalogCandidate, decideQuoteCatalogDeployment, listQuoteCatalogAdmin } = await import("../api/lib/quoteAssetCatalogAdmin.js");

const ACTOR = "script:seed-quote-catalog-testnet-candidates";
const DEVNET_USDC_ORCA = {
  acquisitionAdapter: "ORCA_WHIRLPOOL_DEVNET",
  acquisitionProgram: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  orcaPool: "6XqJUqX4zUL7KEm9wGqTvJmE7DdC8e6MYeMBF9uYLckX",
  referenceUsdMicros: 1_000_000,
  maxSlippageBps: 100,
  maxImpactBps: 100,
  maxDeviationBps: 100,
  adapterConfig: {
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    orcaTickSpacing: 1,
    orcaWhirlpoolsConfig: "FcrweFY1G9HJAHG5inkGB6pKg1HZ6x9UC2WioAfWrGkR",
    certificationOnly: true,
  },
};

const SEEDS = [
  { chain: "101:devnet", providerKey: "solana-basic", symbol: "SOL", displayName: "Solana Devnet SOL", assetClass: "NATIVE", category: "CORE", contractAddressOrMint: "", decimals: 9, providerAssetId: "sol-native-devnet", evidence: ["repo:frontend/supabase/migrations/20260907163000_solana_devnet_basic_quote_certification.sql"], approve: {} },
  { chain: "101:devnet", providerKey: "solana-basic", symbol: "USDC", displayName: "Circle USDC (Solana Devnet)", assetClass: "STABLECOIN", category: "STABLES_CURRENCIES", contractAddressOrMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6, providerAssetId: "usdc-circle-devnet", evidence: ["repo:frontend/supabase/migrations/20260907163000_solana_devnet_basic_quote_certification.sql", "https://faucet.circle.com"], approve: DEVNET_USDC_ORCA },
  { chain: "97", providerKey: "bnb-native", symbol: "BNB", displayName: "BNB (testnet)", assetClass: "NATIVE", category: "CORE", contractAddressOrMint: "", decimals: 18, providerAssetId: "bnb-native-97", evidence: ["repo:frontend/.env VITE_FACTORY_ADDRESS_97"], approve: {} },
  { chain: "46630", providerKey: "robinhood-basic", symbol: "ETH", displayName: "ETH (Robinhood testnet)", assetClass: "NATIVE", category: "CORE", contractAddressOrMint: "", decimals: 18, providerAssetId: "eth-native-46630", evidence: ["repo:frontend/src/lib/chainConfig.ts ROBINHOOD_TESTNET_CHAIN_ID"], approve: {} },
];

let created = 0;
let approved = 0;
for (const seed of SEEDS) {
  const listed = await listQuoteCatalogAdmin({ chain: seed.chain });
  const wantedKey = seed.contractAddressOrMint || `native:${listed.chain.chainId}`;
  let item = listed.items.find((entry) => entry.symbol === seed.symbol && (entry.identityKind === "NATIVE" ? !seed.contractAddressOrMint : entry.contractAddressOrMint === seed.contractAddressOrMint));
  console.log(`${seed.chain} ${seed.symbol} (${wantedKey}): ${item ? `exists ${item.catalogState} v${item.stateVersion}` : "missing"}`);
  if (!item) {
    if (!apply) { console.log("  would create candidate"); }
    else {
      const detail = await createQuoteCatalogCandidate({ ...seed, reason: "Test-network binding asset seeded from the repo's certification records." }, { actorIdentity: ACTOR });
      item = detail.item; created += 1; console.log(`  created ${item.id}`);
    }
  }
  if (item && item.actionPolicy.canApprove) {
    if (!apply) { console.log("  would approve"); continue; }
    const { adapterConfig, ...policyOverrides } = seed.approve;
    const detail = await decideQuoteCatalogDeployment({ id: item.id, action: "approve", expectedVersion: item.stateVersion, reason: "Identity and route proven by the repo's certification records; approved for test-network graduation.", policyOverrides: { ...policyOverrides, adapterConfig }, evidence: seed.evidence, actorIdentity: ACTOR });
    approved += 1; console.log(`  approved -> ${detail.item.catalogState} eligible=${detail.item.newGraduationEligible} policy=${detail.item.policy?.policyKey}`);
  }
}
console.log(JSON.stringify({ apply, created, approved }));
await pool.end().catch(() => undefined);
