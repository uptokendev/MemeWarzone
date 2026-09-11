import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  resolveCurrentSolanaAuthority,
  isCurrentSolanaProductionAuthority,
  isCurrentSolanaStagingAuthority,
} from "./solanaCurrentAuthority.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, "..");
const repoRoot = path.resolve(frontendRoot, "..");

async function source(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

test("101 + staging + devnet is canonical staging authority", () => {
  assert.deepEqual(
    resolveCurrentSolanaAuthority({ chainId: 101, environment: "staging", cluster: "devnet" }),
    { chainId: 101, environment: "staging", cluster: "devnet" },
  );
  assert.equal(isCurrentSolanaStagingAuthority({ chainId: 101, environment: "staging", cluster: "devnet" }), true);
});

test("101 + production + mainnet-beta is canonical production authority", () => {
  assert.deepEqual(
    resolveCurrentSolanaAuthority({ chainId: 101, environment: "production", cluster: "mainnet-beta" }),
    { chainId: 101, environment: "production", cluster: "mainnet-beta" },
  );
  assert.equal(isCurrentSolanaProductionAuthority({ chainId: 101, environment: "production", cluster: "mainnet-beta" }), true);
});

test("environment-sensitive Solana authority fails closed when identity is missing, invalid, or crossed", () => {
  const invalid = [
    { chainId: 101, cluster: "devnet" },
    { chainId: 101, environment: "staging" },
    { chainId: 101, environment: "staging", cluster: "mainnet-beta" },
    { chainId: 101, environment: "production", cluster: "devnet" },
    { chainId: 101, environment: "preview", cluster: "devnet" },
    { chainId: 101, environment: "staging", cluster: "testnet" },
    { chainId: 101, environment: "production", cluster: "localnet" },
  ];
  for (const identity of invalid) assert.equal(resolveCurrentSolanaAuthority(identity), null);
});

test("legacy chain 102 can never become current Solana authority", () => {
  for (const environment of ["staging", "production", "prod"]) {
    for (const cluster of ["devnet", "mainnet-beta", "solana-devnet", "solana-mainnet-beta"]) {
      assert.equal(resolveCurrentSolanaAuthority({ chainId: 102, environment, cluster }), null);
    }
  }
});

test("admin finance removes 102 authority and requires canonical Solana resolver", async () => {
  const text = await source("frontend/api/admin/finance.js");
  assert.match(text, /resolveCurrentSolanaAuthority/);
  assert.doesNotMatch(text, /\[102\s*,\s*\{\s*chain:\s*["']solana["']/);
  assert.doesNotMatch(text, /sol102-/);
  assert.match(text, /chainId\s*!==\s*101/);
  assert.match(text, /staging\/devnet or production\/mainnet-beta/);
  assert.match(text, /\[56,/);
  assert.match(text, /\[97,/);
});

test("analytics no longer models 102 as a current Solana product chain", async () => {
  const text = await source("frontend/api/analytics/launchpad.js");
  assert.doesNotMatch(text, /TESTNET_CHAIN_IDS\s*=\s*new Set\(\[97,\s*102\]\)/);
  assert.match(text, /CURRENTLY_EXCLUDED_CHAIN_IDS\s*=\s*new Set\(\[97,\s*102\]\)/);
  assert.match(text, /Historical 102 records/);
});

test("post-grad current route authority rejects 102 and resolves 101 by explicit identity", async () => {
  const text = await source("frontend/src/features/postgrad/identityRoutes.ts");
  assert.match(text, /if \(chainId === 102\) return null/);
  assert.match(text, /resolveCurrentSolanaAuthority/);
  assert.match(text, /VITE_RUNTIME_ENVIRONMENT/);
  assert.match(text, /VITE_SOLANA_CLUSTER/);
});

test("graduation test tier cannot be activated by legacy 102 or production mainnet", async () => {
  const text = await source("frontend/src/lib/graduationTiers.ts");
  assert.match(text, /if \(id === 97\) return true/);
  assert.match(text, /if \(id !== 101\) return false/);
  assert.doesNotMatch(text, /id === 102/);
  assert.match(text, /resolveCurrentSolanaAuthority/);
  assert.match(text, /\?\.environment === ["']staging["']/);
  assert.match(text, /Number\(chainId\) === 101 \|\| Number\(chainId\) === 97/);
});

test("draft deploy requires canonical 101 environment and cluster", async () => {
  const deploy = await source("frontend/api/dev-fix/draft-deploy.js");
  assert.match(deploy, /resolveCurrentSolanaAuthority/);
  assert.match(deploy, /chainId:\s*101/);
  assert.match(deploy, /SOLANA_CURRENT_AUTHORITY_INVALID/);
  assert.match(deploy, /staging\/devnet or production\/mainnet-beta/);
});

test("EVM route authorization cannot be selected by Solana 101 or legacy 102", async () => {
  const text = await source("frontend/api/dev-fix/routeAuthorizationSigner.js");
  assert.match(text, /normalizedChainId === 101n \|\| normalizedChainId === 102n/);
  assert.match(text, /Solana route authorization is not an EVM route-authority lane/);
  assert.match(text, /ROBINHOOD_TESTNET_CHAIN_ID = 46630n/);
  assert.match(text, /ROBINHOOD_MAINNET_CHAIN_ID = 4663n/);
  assert.match(text, /normalizedChainId === 97n/);
});

test("launchpad adapter rejects 102 while retaining canonical Solana and Robinhood routes", async () => {
  const text = await source("frontend/src/features/launchpad/useLaunchpadAdapter.ts");
  assert.match(text, /if \(chainId === 102\)/);
  assert.match(text, /cannot select a current launchpad adapter/);
  assert.match(text, /if \(chainId === 101\) return ["']solana["']/);
  assert.match(text, /chainId === 4663 \|\| chainId === 46630/);
});

test("paid UpVote blocks explicit legacy 102 before Solana payment", async () => {
  const text = await source("frontend/src/components/token/UpvoteDialog.tsx");
  assert.match(text, /legacySolanaChain = Number\(chainIdOverride\) === 102/);
  assert.match(text, /!legacySolanaChain/);
  assert.match(text, /Legacy Solana chain 102 cannot authorize a current paid UpVote/);
  assert.match(text, /SOLANA_CHAIN_ID/);
  assert.match(text, /ROBINHOOD_CHAIN_ID/);
  assert.match(text, /ROBINHOOD_TESTNET_CHAIN_ID/);
});

test("ticker reservation boundary rejects 102 without changing BNB or Robinhood identifiers", async () => {
  const text = await source("frontend/api/dev-fix/ticker-reservation-service.js");
  assert.match(text, /if \(numericChainId === 102\)/);
  assert.match(text, /LEGACY_SOLANA_CHAIN_NOT_AUTHORIZED/);
  assert.match(text, /numericChainId === 56/);
  assert.match(text, /numericChainId === 97/);
});

test("LP fee frontend, API and indexer routes reject legacy authority", async () => {
  const uiHarvest = await source("frontend/src/lib/lpFeeHarvest.ts");
  const apiFees = await source("frontend/api/dashboard/lp-fees.js");
  const indexerFees = await source("realtime-indexer/src/lpFeesRoutes.ts");
  for (const text of [uiHarvest, apiFees, indexerFees]) {
    assert.match(text, /102/);
    assert.match(text, /current LP fee authority|current.*authority/i);
  }
  assert.match(indexerFees, /chainId !== 101/);
  assert.match(indexerFees, /staging.*devnet|devnet.*staging/i);
  assert.match(indexerFees, /production.*mainnet-beta|mainnet-beta.*production/i);
});

test("current realtime market identity excludes legacy 102 and preserves BNB Robinhood and Solana 101", async () => {
  const text = await source("realtime-indexer/src/marketIdentity.ts");
  assert.match(text, /return chainId === 101/);
  assert.match(text, /chainId === 56 \|\| chainId === 97 \|\| chainId === 101 \|\| chainId === 4663 \|\| chainId === 46630/);
  assert.match(text, /chainId === 102/);
  assert.match(text, /Legacy Solana chain 102 is not a current market authority/);
  assert.doesNotMatch(text, /chainId === 101 \|\| chainId === 102/);
});
