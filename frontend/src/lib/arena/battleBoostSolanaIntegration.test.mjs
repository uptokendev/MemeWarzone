import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const client = await readFile(new URL("./battleBoostClient.ts", import.meta.url), "utf8");
const panel = await readFile(new URL("../../components/arena/BattleBoostPanel.tsx", import.meta.url), "utf8");
const transport = await readFile(new URL("./solanaArenaBrowserTransaction.ts", import.meta.url), "utf8");

test("Normal Battle SOL Boost uses frozen server lifecycle endpoints", () => {
  for (const route of ["solana-state", "solana-quote", "solana-submission", "solana-payment", "solana-expire"]) {
    assert.match(client, new RegExp(route));
  }
  assert.match(client, /arena_battle_boost_quote/);
  // Two wallet prompts only (quote + transaction): the submission carries the signed transaction as
  // proof and the payment is proven on chain (api/lib/solanaSignedArenaSubmission.mjs).
  assert.match(client, /signedTransaction: pending\.signedTransaction/);
  assert.doesNotMatch(client, /arena_battle_boost_submission|arena_battle_boost_payment/);
});

test("SOL quote is fail-closed on founder economics and V3 lock", () => {
  // Metrics battles: 1 pt, V3 curve. Vote Battles: 2 pts (Free Vote 1, Boost 2), V3 off -- only when
  // the API marks the quote voteBattle (arenaSolanaBoosts.js, VOTE_BATTLE_BOOST_POINTS_PER_UNIT).
  assert.match(client, /const expectedPoints = voteBattle \? 2 : 1;/);
  assert.match(client, /pointsPerBoost\) !== expectedPoints/);
  assert.match(client, /usdPerBoostMicros\) !== "1000000"/);
  assert.match(client, /prizeBps\) !== 9000/);
  assert.match(client, /protocolBps\) !== 1000/);
  assert.match(client, /leagueBps\) !== 0/);
  assert.match(client, /boost_hyperbolic_100_v1/);
  assert.doesNotMatch(client, /10\s*\*\s*U\s*\//);
});

test("browser recovery preserves exact signature and block-height lifecycle", () => {
  assert.match(transport, /recoverSolanaArenaPayment/);
  // Phantom adds ComputeBudget + Lighthouse instructions when signing; the post-sign check must
  // allow them (our instruction unchanged) or every signed arena payment is refused.
  assert.match(transport, /assertSolanaUserV0Intent\(web3, signed, \{ payer: connected, instructions: \[instruction\], allowAdditionalInstructions: true \}\)/);
  assert.doesNotMatch(transport, /assertSolanaUserV0Intent\(web3, signed, intent\)/);
  assert.match(transport, /lastValidBlockHeight/);
  assert.match(transport, /confirmLaunchpadSignature/);
  assert.match(transport, /registerArenaPaymentBeforeBroadcast/);
  assert.match(transport, /encodeBase58\(signatureBytes\)/);
  assert.match(client, /receipt signature does not match the preserved payment/);
});

test("Battle UI recovers before replacement quote and exposes lifecycle states", () => {
  assert.match(panel, /if \(state\.unresolved\)/);
  assert.match(panel, /recoverSolanaBattleBoost/);
  assert.match(panel, /state\.newPaymentAllowed !== true/);
  assert.match(panel, /No replacement payment will be signed/);
  for (const label of ["Confirmed", "Expired — retry allowed", "Failed", "Recovering payment", "Payment pending"]) {
    assert.ok(panel.includes(label));
  }
});
