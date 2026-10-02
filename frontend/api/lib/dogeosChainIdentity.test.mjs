import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ARENA_CHAIN_IDS, arenaEnvironmentIdentity } from "./arenaChainEnvironment.js";
import { MWL_SUPPORTED_CHAIN_IDS, mwlChainIdentity } from "./arenaMwlChainIdentity.mjs";
import { NATIVE_ASSET_BY_CHAIN } from "./arenaNativeUsdFeed.mjs";
import { isDogeosChainId, nativeSymbolFor } from "./chainNative.js";
import { nativeAssetForEventSponsorship } from "./eventSponsorshipAuthority.mjs";
import { normalizeChain } from "./notificationContract.js";
import { EVM_NATIVE_LAUNCH_CHAIN_IDS, nativeProviderKey, nativeSymbol } from "../../src/lib/graduationMarketPresentation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const chainConfig = fs.readFileSync(path.join(repoRoot, "frontend", "src", "lib", "chainConfig.ts"), "utf8");
const registry = fs.readFileSync(path.join(repoRoot, "frontend", "src", "lib", "chainRegistry.ts"), "utf8");
const migration = fs.readFileSync(path.join(repoRoot, "db", "migrations", "20260930_000001_dogeos_chain_identity.sql"), "utf8");

const DOGEOS = 6281971;

test("DogeOS Chikyū is a first-class EVM identity with native DOGE", () => {
  assert.equal(DOGEOS, 6281971);
  assert.equal(isDogeosChainId(DOGEOS), true);
  assert.equal(isDogeosChainId(56), false);
  assert.equal(nativeSymbolFor(DOGEOS), "DOGE");
  assert.equal(nativeSymbol(DOGEOS), "DOGE");
  assert.equal(nativeProviderKey(DOGEOS), "dogeos-basic");
  assert.equal(NATIVE_ASSET_BY_CHAIN[DOGEOS], "DOGE");
  assert.equal(normalizeChain(DOGEOS), "dogeos");
  assert.deepEqual(nativeAssetForEventSponsorship(DOGEOS), { symbol: "DOGE", decimals: 18, family: "evm" });
  assert.equal(EVM_NATIVE_LAUNCH_CHAIN_IDS.has(DOGEOS), true);
});

test("DogeOS is staging on arena and MWL lists and does not fall through to BNB", () => {
  assert.equal(ARENA_CHAIN_IDS.includes(DOGEOS), true);
  assert.equal(MWL_SUPPORTED_CHAIN_IDS.includes(DOGEOS), true);
  assert.deepEqual(arenaEnvironmentIdentity(DOGEOS), { chainId: DOGEOS, environment: "staging", solanaCluster: null });
  assert.deepEqual(mwlChainIdentity(DOGEOS), { chainId: DOGEOS, family: "dogeos", environment: "staging", nativeSymbol: "DOGE" });
  assert.throws(() => nativeSymbolFor(1), /Unsupported current application chain/);
});

test("registry, chainConfig and SQL name Chikyū 6281971 without a DEX or factory", () => {
  assert.match(registry, /"dogeos-testnet"/);
  assert.match(registry, /chainId: 6281971/);
  assert.match(registry, /nativeAsset: "DOGE"/);
  assert.match(registry, /graduationAdapter: "pending-dex"/);
  assert.match(registry, /supportsCreation: false/);
  assert.match(chainConfig, /DOGEOS_TESTNET_CHAIN_ID[^\n]*= 6281971/);
  assert.match(chainConfig, /dogeos-testnet\.l2scan\.co/);
  assert.match(chainConfig, /0x5fe533/);
  assert.match(migration, /chain in \('bnb','solana','robinhood','dogeos'\)/);
  assert.match(migration, /token in \('BNB','SOL','ETH','DOGE'\)/);
  assert.match(migration, /6281971/);
});
