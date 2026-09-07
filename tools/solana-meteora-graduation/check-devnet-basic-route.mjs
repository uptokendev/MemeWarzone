import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const ORIGINAL_HEAD = "1e7b45802a7e2e39e13e46321209d2eb6c87606f";
const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const ORCA = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const ORCA_CERT_POOL = "6XqJUqX4zUL7KEm9wGqTvJmE7DdC8e6MYeMBF9uYLckX";
const DEVNET_NATIVE_CONFIG = "a2100000-0000-4000-8000-000000000211";
const DEVNET_USDC_CONFIG = "a2100000-0000-4000-8000-000000000212";

function text(path) { return fs.readFileSync(path, "utf8"); }
function has(source, needle, label) { assert.ok(source.includes(needle), `${label}: missing ${needle}`); }

const mainnet = text("frontend/supabase/migrations/20260907001000_solana_basic_quote_catalog.sql");
has(mainnet, "a2100000-0000-4000-8000-000000000201", "mainnet native deployment");
has(mainnet, "a2100000-0000-4000-8000-000000000202", "mainnet stable deployment");
has(mainnet, "'101'", "mainnet chain id");
has(mainnet, MAINNET_USDC, "mainnet canonical USDC");
has(mainnet, JUPITER, "mainnet Jupiter program");
assert.ok(!mainnet.includes(DEVNET_USDC), "chain-101 migration must not contain Circle devnet USDC");
assert.ok(!mainnet.includes("ORCA_WHIRLPOOL_DEVNET"), "chain-101 migration must not select Orca devnet adapter");

const devnet = text("frontend/supabase/migrations/20260907163000_solana_devnet_basic_quote_certification.sql");
has(devnet, DEVNET_NATIVE_CONFIG, "devnet native deployment");
has(devnet, DEVNET_USDC_CONFIG, "devnet stable deployment");
has(devnet, "'102'", "devnet chain id");
has(devnet, "native:102", "devnet native identity");
has(devnet, DEVNET_USDC, "devnet canonical Circle USDC");
has(devnet, "ORCA_WHIRLPOOL_DEVNET", "devnet Orca adapter");
has(devnet, ORCA, "devnet Orca program");
has(devnet, ORCA_CERT_POOL, "devnet Orca certification pool");
has(devnet, "'orcaTickSpacing', 1", "devnet Orca certification tick spacing");
has(devnet, "'certificationSolUsdMicros', 145948162", "devnet certification reference");
has(devnet, "'review'", "unseeded devnet stable must fail closed");
assert.ok(!devnet.includes(MAINNET_USDC), "chain-102 migration must not contain mainnet USDC");

const mapper = text("frontend/api/lib/quoteAssetCatalog.js");
has(mapper, "pv.policy_config", "catalog query policy config");
has(mapper, "id: row.policy_version_id", "catalog policy version id");
has(mapper, "config: row.policy_config || {}", "catalog policy config mapping");

const auth = text("frontend/api/dev-fix/solana-graduation-authorization-v2.js");
has(auth, "if (String(item.chainId) !== String(chainId)", "exact chain binding");
has(auth, "if (body.quoteMint)", "arbitrary client quote mint rejection");
has(auth, '"ORCA_WHIRLPOOL_DEVNET"', "policy-selected Orca adapter");
has(auth, 'String(chainId) !== "102"', "Orca devnet isolation");
has(auth, 'config.acquisitionAdapter !== "JUPITER"', "Jupiter remains explicit production adapter");
has(auth, "quoteConfigHash", "quote config digest binding");
has(auth, "generationConfig: campaign.generationConfig", "generation digest binding");

const orcaQuote = text("frontend/api/lib/solanaOrcaGraduationQuote.js");
has(orcaQuote, ORCA, "Orca exact program binding");
has(orcaQuote, "fetchConcentratedLiquidityPool", "Orca concentrated pool resolver");
has(orcaQuote, "route.orcaTickSpacing", "Orca tick spacing authority");
has(orcaQuote, "pool.liquidity", "Orca liquidity health gate");
has(orcaQuote, "pool mint binding mismatch", "Orca pool mint binding");

const poolTool = text("tools/solana-meteora-graduation/orca-devnet-cert-pool.mjs");
has(poolTool, ORCA_CERT_POOL, "operator exact Orca pool");
has(poolTool, "CERT_TICK_SPACING = 1", "operator exact Orca fee tier");
has(poolTool, DEVNET_USDC, "operator exact Circle USDC");

const operator = text("tools/solana-meteora-graduation/graduate-basic-quote.mjs");
has(operator, "buildAcquisitionInstructions", "operator policy adapter dispatch");
has(operator, "ORCA_WHIRLPOOL_DEVNET", "operator Orca support");
has(operator, "buildJupiterInstructions", "operator Jupiter regression");
has(operator, "getLatestBlockhash", "latest blockhash regression");
has(operator, "lastValidBlockHeight", "last-valid-height regression");
has(operator, "buildLaunchpadV0Transaction", "V0 regression");
has(operator, "lookupTableAccounts", "ALT regression");
has(operator, "flushCampaignFees", "FeeEscrow ordering path");

const programDiff = execFileSync("git", ["diff", "--name-only", ORIGINAL_HEAD, "--", "programs/memewarzone_solana"], { encoding: "utf8" }).trim();
assert.equal(programDiff, "", `Orca certification rail must not change Solana program files; changed: ${programDiff}`);

const mainnetDiff = execFileSync("git", ["diff", "--name-only", ORIGINAL_HEAD, "--", "frontend/supabase/migrations/20260907001000_solana_basic_quote_catalog.sql"], { encoding: "utf8" }).trim();
assert.equal(mainnetDiff, "", `chain-101 Solana BASIC migration changed unexpectedly: ${mainnetDiff}`);

console.log(JSON.stringify({
  mainnetBasicUnchanged: true,
  chain102NativeQuoteConfigId: DEVNET_NATIVE_CONFIG,
  chain102UsdcQuoteConfigId: DEVNET_USDC_CONFIG,
  circleDevnetUsdc: DEVNET_USDC,
  productionJupiterProgram: JUPITER,
  devnetOrcaProgram: ORCA,
  devnetOrcaPool: ORCA_CERT_POOL,
  devnetOrcaTickSpacing: 1,
  solanaProgramSourceChanged: false,
  result: "PASS",
}, null, 2));
