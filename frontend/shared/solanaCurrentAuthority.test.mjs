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

test("environment-sensitive Solana authority fails closed when identity is missing or crossed", () => {
  assert.equal(resolveCurrentSolanaAuthority({ chainId: 101, cluster: "devnet" }), null);
  assert.equal(resolveCurrentSolanaAuthority({ chainId: 101, environment: "staging" }), null);
  assert.equal(resolveCurrentSolanaAuthority({ chainId: 101, environment: "staging", cluster: "mainnet-beta" }), null);
  assert.equal(resolveCurrentSolanaAuthority({ chainId: 101, environment: "production", cluster: "devnet" }), null);
});

test("legacy chain 102 can never become current Solana authority", () => {
  for (const environment of ["staging", "production"]) {
    for (const cluster of ["devnet", "mainnet-beta"]) {
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

test("analytics no longer models 102 as the staging Solana product chain", async () => {
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
  assert.match(text, /if \(id !== 101\) return false/);
  assert.doesNotMatch(text, /id === 102/);
  assert.match(text, /resolveCurrentSolanaAuthority/);
  assert.match(text, /\?\.environment === ["']staging["']/);
});

test("Solana deploy authorization and LP fee financial routes reject legacy authority", async () => {
  const deploy = await source("frontend/api/dev-fix/draft-deploy.js");
  const uiHarvest = await source("frontend/src/lib/lpFeeHarvest.ts");
  const apiFees = await source("frontend/api/dashboard/lp-fees.js");
  assert.match(deploy, /resolveCurrentSolanaAuthority/);
  assert.match(deploy, /chainId:\s*101/);
  assert.match(uiHarvest, /chainId === 102/);
  assert.match(uiHarvest, /not a current LP fee authority/);
  assert.match(apiFees, /chainId === 102/);
  assert.match(apiFees, /not a current LP fee authority/);
});
