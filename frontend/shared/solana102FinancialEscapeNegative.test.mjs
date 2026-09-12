import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { nativeSymbolFor } from "../api/lib/chainNative.js";
import {
  SOLANA_GENESIS,
  expectedGenesisHash,
  isSolanaWarzoneChainId,
  validateCanonicalArenaConfig,
} from "../src/lib/solanaArenaLayout.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

async function source(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

test("native financial symbols fail closed and never classify 102 as BNB", () => {
  assert.equal(nativeSymbolFor(56), "BNB");
  assert.equal(nativeSymbolFor(97), "BNB");
  assert.equal(nativeSymbolFor(101), "SOL");
  assert.equal(nativeSymbolFor(4663), "ETH");
  assert.equal(nativeSymbolFor(46630), "ETH");
  assert.throws(() => nativeSymbolFor(102), /not current financial authority/i);
  assert.throws(() => nativeSymbolFor(999999), /unsupported current application chain/i);
});

test("trade authorization accepts only current Solana application chain 101", async () => {
  const text = await source("frontend/api/dev-fix/solana-trade-authorization-v1.js");
  assert.match(text, /const chainId = Number\(body\.chainId \|\| 101\);/);
  assert.match(text, /if \(chainId !== 101\)/);
  assert.match(text, /chainId must be current Solana chain 101/);
  assert.doesNotMatch(text, /isSolanaChain\s*\(/);
  assert.doesNotMatch(text, /\[101,\s*102\]/);
});

test("paid Solana UpVote ingest accepts only current Solana application chain 101", async () => {
  const text = await source("frontend/api/dev-fix/solana-vote-ingest.js");
  assert.match(text, /const chainId = Number\(body\.chainId \|\| 101\);/);
  assert.match(text, /if \(chainId !== 101\)/);
  assert.match(text, /chainId must be current Solana chain 101/);
  assert.doesNotMatch(text, /isSolanaChain\s*\(/);
  assert.doesNotMatch(text, /\[101,\s*102\]/);
});

test("Arena paid Solana vote ingest accepts only current Solana application chain 101", async () => {
  const text = await source("frontend/api/arenaVotes.js");
  assert.match(text, /const chainId = Number\(body\.chainId \|\| 101\);/);
  assert.match(text, /if \(chainId !== 101\)/);
  assert.match(text, /chainId must be current Solana chain 101/);
  assert.doesNotMatch(text, /isSolanaChain\s*\(/);
  assert.doesNotMatch(text, /\[101,\s*102\]/);
});

test("Arena identity is 101+staging+devnet or 101+production+mainnet-beta only", () => {
  assert.equal(isSolanaWarzoneChainId(101), true);
  assert.equal(isSolanaWarzoneChainId(102), false);

  assert.equal(
    expectedGenesisHash({ chainId: 101, environment: "staging", cluster: "devnet" }),
    SOLANA_GENESIS.devnet,
  );
  assert.equal(
    expectedGenesisHash({ chainId: 101, environment: "production", cluster: "mainnet-beta" }),
    SOLANA_GENESIS["mainnet-beta"],
  );

  assert.equal(expectedGenesisHash({ chainId: 102, environment: "staging", cluster: "devnet" }), "");
  assert.equal(expectedGenesisHash({ chainId: 102, environment: "production", cluster: "mainnet-beta" }), "");
  assert.equal(expectedGenesisHash({ chainId: 101, environment: "staging", cluster: "mainnet-beta" }), "");
  assert.equal(expectedGenesisHash({ chainId: 101, environment: "production", cluster: "devnet" }), "");
  assert.equal(expectedGenesisHash({ chainId: 101, environment: "", cluster: "devnet" }), "");
});

test("Arena config validator rejects 102 and mismatched current environments before account trust", () => {
  assert.deepEqual(
    validateCanonicalArenaConfig({
      chainId: 102,
      environment: "staging",
      cluster: "devnet",
      genesisHash: SOLANA_GENESIS.devnet,
      account: null,
    }),
    { live: false, reason: "authority-mismatch" },
  );

  assert.deepEqual(
    validateCanonicalArenaConfig({
      chainId: 101,
      environment: "production",
      cluster: "devnet",
      genesisHash: SOLANA_GENESIS.devnet,
      account: null,
    }),
    { live: false, reason: "authority-mismatch" },
  );
});

test("BASIC quote catalog current authority cannot route legacy application chain 102", async () => {
  const baseCatalog = await source("frontend/supabase/migrations/20260907001000_solana_basic_quote_catalog.sql");
  const historicalDevnet = await source("frontend/supabase/migrations/20260907163000_solana_devnet_basic_quote_certification.sql");
  const closeout = await source("frontend/supabase/migrations/20260911210000_disable_legacy_solana_102_basic_quotes.sql");

  assert.match(baseCatalog, /'101', 'NATIVE', 'native:101', 'native:101'/);
  assert.match(baseCatalog, /'101', 'SOLANA_MINT'/);

  // Historical certification is deliberately retained as evidence rather than rewritten.
  assert.match(historicalDevnet, /'102', 'NATIVE', 'native:102', 'native:102'/);
  assert.match(historicalDevnet, /'102', 'SOLANA_MINT'/);

  // Forward migration makes those historical rows non-routable and enforces the invariant.
  assert.match(closeout, /provider\.provider_key = 'solana-basic'/);
  assert.match(closeout, /d\.chain_id = '102'/);
  assert.match(closeout, /policy_status = 'retired'/);
  assert.match(closeout, /basic_approved = false/);
  assert.match(closeout, /new_graduation_enabled = false/);
  assert.match(closeout, /admin_state = 'disabled'/);
  assert.match(closeout, /existing_market_support = false/);
  assert.match(closeout, /check \(chain_id <> '102' or admin_state = 'disabled'\)/);
  assert.match(closeout, /raise exception 'legacy Solana chain 102 remains routable in BASIC quote catalog'/);
});
