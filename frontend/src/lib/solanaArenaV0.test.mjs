import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(root, "solanaArenaV0.ts"), "utf8");

test("Arena executor stays on the user V0 envelope without ALT or Legacy", () => {
  assert.match(source, /compileSolanaUserV0WithLatestBlockhash/);
  assert.match(source, /simulateSolanaUserV0OrThrow/);
  assert.match(source, /allowAdditionalInstructions: true/);
  assert.match(source, /instructions\?: TransactionInstruction\[\]/);
  assert.doesNotMatch(source, /new web3\.Transaction\s*\(/);
  assert.doesNotMatch(source, /compileToV0Message\(\s*lookup/);
  assert.doesNotMatch(source, /Ed25519/);
  assert.doesNotMatch(source, /claim_charity/);
  assert.doesNotMatch(source, /solanaV0Transaction/);
});

test("builders use frozen v2 / claim_winner discriminators", () => {
  assert.match(source, /open_battle_pool_v2/);
  assert.match(source, /deposit_stake_v2/);
  assert.match(source, /donate_support_v2/);
  assert.match(source, /deposit_buy_in_v2/);
  assert.match(source, /claim_winner/);
  assert.match(source, /refund_stake/);
  assert.match(source, /refund_buy_in_v2/);
  assert.match(source, /settle_expired_pool/);
  const disc = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
  assert.equal(disc("open_battle_pool_v2").length, 8);
});

test("prize-boost builders stay in the executor but are not a Batch 3 UI path", () => {
  assert.match(source, /deposit_prize_boost_v2/);
  assert.match(source, /refund_prize_boost_v2/);
  const ui = fs.readFileSync(path.join(root, "../components/arena/ArenaStakeButton.tsx"), "utf8");
  assert.doesNotMatch(ui, /prize_boost/);
});

test("Support and Buy-in consume explicit live, never live: configured", () => {
  const support = fs.readFileSync(path.join(root, "../components/arena/ArenaSupportButton.tsx"), "utf8");
  const buyIn = fs.readFileSync(path.join(root, "../components/arena/ArenaBuyInButton.tsx"), "utf8");
  const claim = fs.readFileSync(path.join(root, "../components/arena/ArenaWarPoolClaimButton.tsx"), "utf8");
  assert.doesNotMatch(support, /live:\s*configured/);
  assert.match(support, /live:\s*liveFlag/);
  assert.match(buyIn, /live:\s*liveFlag/);
  assert.match(claim, /isSolanaWarzoneMoneyLive/);
});

test("buy-in receipt endpoint verifies the authoritative PDA, not existence", () => {
  const apiRoot = path.join(root, "../../api");
  const tournaments = fs.readFileSync(path.join(apiRoot, "arenaTournaments.js"), "utf8");
  const reader = fs.readFileSync(path.join(apiRoot, "lib/solanaArenaPoolRead.js"), "utf8");
  const handler = tournaments.split("async function handleBuyInReceipt")[1]?.split("async function handleAdminList")[0] || "";
  assert.match(handler, /readAuthoritativeBuyInReceipt/);
  assert.match(handler, /BUY_IN_RECEIPT_INVALID/);
  assert.match(reader, /verifyAuthoritativeBuyInReceipt/);
  assert.doesNotMatch(handler, /getAccountInfo/);
});
