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
  assert.match(client, /arena_battle_boost_submission/);
  assert.match(client, /arena_battle_boost_payment/);
});

test("SOL quote is fail-closed on founder economics and V3 lock", () => {
  assert.match(client, /pointsPerBoost\) !== 1/);
  assert.match(client, /usdPerBoostMicros\) !== "1000000"/);
  assert.match(client, /prizeBps\) !== 9000/);
  assert.match(client, /protocolBps\) !== 1000/);
  assert.match(client, /leagueBps\) !== 0/);
  assert.match(client, /boost_hyperbolic_100_v1/);
  assert.doesNotMatch(client, /10\s*\*\s*U\s*\//);
  assert.doesNotMatch(client, /pointsPerBoost\) !== 2/);
});

test("browser recovery preserves exact signature and block-height lifecycle", () => {
  assert.match(transport, /recoverSolanaArenaPayment/);
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
