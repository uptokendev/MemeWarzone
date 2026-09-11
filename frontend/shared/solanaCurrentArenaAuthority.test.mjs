import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  connectionForArenaMoneyV2,
  probeArenaMoneyV2,
} from "../api/lib/solanaArenaMoneyV2Read.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

async function source(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

test("legacy 102 cannot open an Arena Money V2 RPC authority", async () => {
  assert.equal(connectionForArenaMoneyV2(102), null);
  assert.deepEqual(await probeArenaMoneyV2(102), {
    configured: false,
    live: false,
    reason: "legacy-solana-chain-not-authorized",
  });
});

test("Arena Money V2 current authority is canonical application chain 101", async () => {
  const text = await source("frontend/api/lib/solanaArenaMoneyV2Read.js");
  assert.match(text, /CURRENT_SOLANA_ARENA_CHAIN_ID = 101/);
  assert.match(text, /Number\(chainId\) !== CURRENT_SOLANA_ARENA_CHAIN_ID/);
  assert.match(text, /id === 102/);
  assert.match(text, /legacy-solana-chain-not-authorized/);
});

test("Solana Boost financial contexts are downstream of the canonical Arena Money read authority", async () => {
  const boosts = await source("frontend/api/arenaSolanaBoosts.js");
  assert.match(boosts, /readCompetitionPoolV2\(chainId, competitionId\)/);
  assert.match(boosts, /connectionForArenaMoneyV2/);
  assert.match(boosts, /verifySolanaBoostPayment/);
});

test("standalone Arena operator cannot resolve or claim a legacy 102 settlement", async () => {
  const worker = await source("scripts/solana/arena-operator-worker.mjs");
  assert.match(worker, /Number\(settlement\.chain_id\) !== 101/);
  assert.match(worker, /Number\(settlement\.chain_id\) === 102 \? "legacy-solana-chain-not-authorized"/);
  assert.doesNotMatch(worker, /Number\(settlement\.chain_id\) !== 101 && Number\(settlement\.chain_id\) !== 102/);
});

test("Arena scoring and economics constants are not changed by the authority closeout", async () => {
  const runtime = await source("frontend/api/lib/solanaArenaMoneyV2Runtime.mjs");
  const boosts = await source("frontend/api/arenaSolanaBoosts.js");
  assert.match(runtime, /const BPS = 10_000n/);
  assert.match(runtime, /const BOOST_PROTOCOL_BPS = 1_000n/);
  assert.match(runtime, /return \{ gross, prize: gross - protocol, protocol \}/);
  assert.match(runtime, /const SPONSORSHIP_MARKETING_BPS = 2_000n/);
  assert.match(runtime, /const SPONSORSHIP_PROTOCOL_BPS = 1_000n/);
  assert.match(boosts, /pointsPerBoost: 1/);
  assert.match(boosts, /pointsPerBoost: 2/);
});
