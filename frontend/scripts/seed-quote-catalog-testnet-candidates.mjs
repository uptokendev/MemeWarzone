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
 * Test-network ERC-20 quotes are seeded as CANDIDATES only (not approved):
 * every address below was verified on-chain on 2026-09-21 (symbol, decimals,
 * bytecode), but none has a graduation route yet (no Topaz WBNB/stable pool
 * on 97, no DEX pool on 46630). Approve them from the Command Center once
 * the route exists.
 *
 *   BNB testnet 97      WBNB (the Topaz testnet wrapped native our stack indexes),
 *                       USDT, USDC, BUSD, DAI (Binance testnet faucet tokens, 18 dec)
 *   Robinhood testnet   WETH (the wrapped native our stack indexes), USDC (18 dec),
 *                       USDG (6 dec), and five community mock stock tokens
 *                       (AMZN, TSLA, AMD, PLTR, NFLX) that Robinhood's asset API
 *                       does not list, labelled as mocks.
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

// Same env loader the API server uses: aliases (VITE_* names), .env files when
// present, and the Postgres TLS setting for the Supabase pooler. Without it
// a container run rejects the pooler certificate.
await import("../api/load-local-env.mjs");
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

const CANDIDATES = [
  { chain: "97", providerKey: "bnb-native", symbol: "WBNB", displayName: "Wrapped BNB (Topaz testnet)", assetClass: "NATIVE", category: "CORE", contractAddressOrMint: "0x4E7aF54D355684EF206DAb0b5Dca8695D1e75dA2", decimals: 18, providerAssetId: "wbnb-topaz-97", evidence: ["onchain:97 symbol WBNB decimals 18", "repo:dex_pools.wrapped_native_address chain 97"] },
  { chain: "97", providerKey: "bnb-testnet-faucet", providerDisplayName: "BNB Testnet Faucet Tokens", providerClass: "STABLECOIN", symbol: "USDT", displayName: "USDT Token (BSC testnet)", assetClass: "STABLECOIN", category: "STABLES_CURRENCIES", contractAddressOrMint: "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd", decimals: 18, providerAssetId: "usdt-bsc-testnet", evidence: ["onchain:97 symbol USDT decimals 18", "https://testnet.bnbchain.org/faucet-smart"] },
  { chain: "97", providerKey: "bnb-testnet-faucet", providerDisplayName: "BNB Testnet Faucet Tokens", providerClass: "STABLECOIN", symbol: "USDC", displayName: "USDC Token (BSC testnet)", assetClass: "STABLECOIN", category: "STABLES_CURRENCIES", contractAddressOrMint: "0x64544969ed7EBf5f083679233325356EbE738930", decimals: 18, providerAssetId: "usdc-bsc-testnet", evidence: ["onchain:97 symbol USDC decimals 18", "https://testnet.bnbchain.org/faucet-smart"] },
  { chain: "97", providerKey: "bnb-testnet-faucet", providerDisplayName: "BNB Testnet Faucet Tokens", providerClass: "STABLECOIN", symbol: "BUSD", displayName: "Binance USD (BSC testnet)", assetClass: "STABLECOIN", category: "STABLES_CURRENCIES", contractAddressOrMint: "0xeD24FC36d5Ee211Ea25A80239Fb8C4Cfd80f12Ee", decimals: 18, providerAssetId: "busd-bsc-testnet", evidence: ["onchain:97 symbol BUSD decimals 18", "https://testnet.bnbchain.org/faucet-smart"] },
  { chain: "97", providerKey: "bnb-testnet-faucet", providerDisplayName: "BNB Testnet Faucet Tokens", providerClass: "STABLECOIN", symbol: "DAI", displayName: "DAI Token (BSC testnet)", assetClass: "STABLECOIN", category: "STABLES_CURRENCIES", contractAddressOrMint: "0xEC5dCb5Dbf4B114C9d0F65BcCAb49EC54F6A0867", decimals: 18, providerAssetId: "dai-bsc-testnet", evidence: ["onchain:97 symbol DAI decimals 18", "https://testnet.bnbchain.org/faucet-smart"] },
  // Two wrapped ETHs exist on the Robinhood testnet stack: the one the retired testnet DEX
  // pools index (0x52a47a33…) and the "Mock Wrapped Ether" the staged generation-4 launchpad
  // factory (0xF170a2C9…) routes through via router 0xe69a6a41… . Both are candidates; the
  // one to approve is decided when the testnet launchpad is wired (step 2).
  { chain: "46630", providerKey: "robinhood-basic", symbol: "WETH", displayName: "Wrapped ETH (Robinhood testnet, legacy DEX pools)", assetClass: "NATIVE", category: "CORE", contractAddressOrMint: "0x52a47a33930b8a90a2000b1ba3cb96e879569670", decimals: 18, providerAssetId: "weth-46630", evidence: ["onchain:46630 symbol WETH decimals 18", "repo:dex_pools.wrapped_native_address chain 46630"] },
  { chain: "46630", providerKey: "robinhood-basic", symbol: "mWETH", displayName: "Mock Wrapped Ether (generation-4 factory router WETH)", assetClass: "NATIVE", category: "CORE", contractAddressOrMint: "0x632061cA786f7B585Bbd46A792FDA92B02f70671", decimals: 18, providerAssetId: "mweth-46630", evidence: ["onchain:46630 symbol mWETH name Mock Wrapped Ether decimals 18", "onchain:46630 factory 0xF170a2C97953754c2C1105E2AcC522Bc8e764D75 router 0xe69a6a41363a48179beaB9b1E6122885bbFe8C65 WETH()"] },
  { chain: "46630", providerKey: "robinhood-testnet-tokens", providerDisplayName: "Robinhood Testnet Tokens (unofficial)", providerClass: "STABLECOIN", symbol: "USDC", displayName: "USDC (Robinhood testnet, 18 decimals)", assetClass: "STABLECOIN", category: "STABLES_CURRENCIES", contractAddressOrMint: "0xbf4479C07Dc6fdc6dAa764A0ccA06969e894275F", decimals: 18, providerAssetId: "usdc-46630", evidence: ["onchain:46630 symbol USDC decimals 18", "https://explorer.testnet.chain.robinhood.com/token/0xbf4479C07Dc6fdc6dAa764A0ccA06969e894275F"] },
  { chain: "46630", providerKey: "robinhood-testnet-tokens", providerDisplayName: "Robinhood Testnet Tokens (unofficial)", providerClass: "STABLECOIN", symbol: "USDG", displayName: "USDG (Robinhood testnet)", assetClass: "STABLECOIN", category: "STABLES_CURRENCIES", contractAddressOrMint: "0x915Ef7c9F9f80a69e3BE47A38EE0Bb47607103ec", decimals: 6, providerAssetId: "usdg-46630", evidence: ["onchain:46630 symbol USDG decimals 6", "https://explorer.testnet.chain.robinhood.com/token/0x915Ef7c9F9f80a69e3BE47A38EE0Bb47607103ec"] },
  ...[["AMZN", "Amazon", "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02"], ["TSLA", "Tesla", "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E"], ["AMD", "AMD", "0x71178BAc73cBeb415514eB542a8995b82669778d"], ["PLTR", "Palantir Technologies", "0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0"], ["NFLX", "Netflix", "0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93"]].map(([symbol, name, address]) => ({
    chain: "46630", providerKey: "robinhood-testnet-mock-stocks", providerDisplayName: "Robinhood Testnet Mock Stocks (community, not Robinhood-issued)", providerClass: "COMMUNITY", symbol, displayName: `${name} (testnet mock)`, assetClass: "OTHER", category: "STOCKS", contractAddressOrMint: address, decimals: 18, providerAssetId: `${symbol.toLowerCase()}-mock-46630`, evidence: [`onchain:46630 symbol ${symbol} decimals 18 (EIP-1167 clone, supply 6181175)`, "https://api.robinhood.com/rhj/assets lists chain 4663 only"],
  })),
];

let created = 0;
let approved = 0;
for (const seed of CANDIDATES) {
  const listed = await listQuoteCatalogAdmin({ chain: seed.chain });
  const item = listed.items.find((entry) => entry.contractAddressOrMint.toLowerCase() === seed.contractAddressOrMint.toLowerCase());
  console.log(`${seed.chain} ${seed.symbol} (${seed.contractAddressOrMint}): ${item ? `exists ${item.catalogState} v${item.stateVersion}` : "missing"}`);
  if (item) continue;
  if (!apply) { console.log("  would create candidate (not approved)"); continue; }
  const detail = await createQuoteCatalogCandidate({ ...seed, reason: "Test-network quote token verified on-chain 2026-09-21; candidate until a graduation route exists." }, { actorIdentity: ACTOR });
  created += 1; console.log(`  created ${detail.item.id} (${detail.item.catalogState})`);
}
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
