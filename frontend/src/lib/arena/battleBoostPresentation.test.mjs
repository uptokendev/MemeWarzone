import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { battleBoostAvailability } from "./battleBoostPresentation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function battle(overrides = {}) {
  return {
    id: "boost-battle",
    state: "live",
    source: "queue",
    battleMode: "normal",
    chainId: 56,
    competitionGeneration: "arena_competition_v2",
    participants: [
      { tokenId: "0x1000000000000000000000000000000000000001" },
      { tokenId: "0x2000000000000000000000000000000000000002" },
    ],
    ...overrides,
  };
}

const solanaBattle = () => battle({
  chainId: 101,
  participants: [
    { tokenId: "So11111111111111111111111111111111111111112" },
    { tokenId: "Vote111111111111111111111111111111111111111" },
  ],
});

test("Battle Boost opens only for live normal competition V2 battles on supported EVM or Solana identities", () => {
  assert.equal(battleBoostAvailability(battle()).available, true);
  assert.equal(battleBoostAvailability(solanaBattle()).available, true);
  assert.equal(battleBoostAvailability(battle({ state: "finished" })).reason, "not_live");
  assert.equal(battleBoostAvailability(battle({ source: "tournament" })).reason, "not_normal_battle");
  assert.equal(battleBoostAvailability(battle({ battleMode: "tournament" })).reason, "not_normal_battle");
  assert.equal(battleBoostAvailability(battle({ competitionGeneration: "war_pool_v1" })).reason, "wrong_generation");
});

test("Battle Boost never guesses missing combatant identity for either chain family", () => {
  const unavailableEvm = battleBoostAvailability(
    battle({ participants: [{ tokenId: "0x1000000000000000000000000000000000000001" }, { tokenId: "pending-right" }] }),
  );
  assert.equal(unavailableEvm.available, false);
  assert.equal(unavailableEvm.reason, "missing_combatants");

  const unavailableSolana = battleBoostAvailability({
    ...solanaBattle(),
    participants: [{ tokenId: "So11111111111111111111111111111111111111112" }, { tokenId: "pending-right" }],
  });
  assert.equal(unavailableSolana.available, false);
  assert.equal(unavailableSolana.reason, "missing_combatants");
});

test("Battle Wall Boost uses signed quote paths without client-side receipt authority", () => {
  const client = fs.readFileSync(path.join(here, "./battleBoostClient.ts"), "utf8");
  const panel = fs.readFileSync(path.join(here, "../../components/arena/BattleBoostPanel.tsx"), "utf8");
  // Vote/Boost moved from the MORE panel onto the battle card (founder, 2026-09-25).
  const wall = fs.readFileSync(path.join(here, "../../components/arena/BattleWallCombatControls.tsx"), "utf8");

  assert.match(client, /arena_battle_boost_quote/);
  assert.match(client, /\/api\/arena\/boosts\/quote/);
  assert.match(client, /solana-quote/);
  assert.match(client, /boostBattle/);
  assert.doesNotMatch(client, /\/api\/arena\/boosts\/confirm/);
  assert.doesNotMatch(panel, /\/api\/arena\/boosts\/confirm/);
  assert.match(panel, /90% goes to the prize pool and 10% to protocol/);
  assert.match(panel, /backend-authoritative/);
  assert.match(wall, /battleBoostAvailability/);
  assert.match(wall, /useBattleBoost/);
  // Vote Battle boosts are quoted at 1 pt with V3 scoring off (arenaSolanaBoosts.js, since
  // 2026-10-15; was 2); the client must accept that shape or every Vote Battle boost is refused.
  assert.match(client, /const expectedPoints = 1;/);
  assert.match(client, /scoringVersion \|\| ""\) !== "vote_tournament_v1"/);
});

test("Battle Boost fails closed when aggregate runtime is unavailable and polls authoritative totals after payment", () => {
  const panel = fs.readFileSync(path.join(here, "../../components/arena/BattleBoostPanel.tsx"), "utf8");

  assert.match(panel, /runtimeReady !== true/);
  assert.match(panel, /data-battle-boost-runtime="unavailable"/);
  assert.match(panel, /Battle Boost unavailable/);
  assert.match(panel, /for \(let attempt = 0; attempt < 4; attempt \+= 1\)/);
  assert.match(panel, /unitsFor\(fresh\?\.summary \|\| null, side\) > previousUnits/);
});

test("boost allowance: 2 per wallet, closed in the last 20%", async () => {
  const { boostAllowance, boostQuantityOptions } = await import("./battleBoostPresentation.mjs");
  const closesAt = "2026-10-15T12:00:00.000Z";
  const before = Date.parse(closesAt) - 60_000;
  const fresh = boostAllowance({ boostRules: { maxUnitsPerWallet: 2, closesAt }, walletBoostUnits: "0", nowMs: before });
  assert.equal(fresh.open, true);
  assert.equal(fresh.remaining, 2);
  assert.match(fresh.label, /^2 of 2 Boosts left for your wallet\. Boosts close at \d\d:\d\d\.$/);
  assert.deepEqual(boostQuantityOptions(fresh).map((o) => [o.value, o.disabled]), [[1, false], [2, false]]);

  const one = boostAllowance({ boostRules: { maxUnitsPerWallet: 2, closesAt }, walletBoostUnits: "1", nowMs: before });
  assert.deepEqual(boostQuantityOptions(one).map((o) => o.disabled), [false, true]);

  const used = boostAllowance({ boostRules: { maxUnitsPerWallet: 2, closesAt }, walletBoostUnits: "2", nowMs: before });
  assert.equal(used.remaining, 0);
  assert.equal(used.label, "You used your 2 Boosts in this battle.");

  const closed = boostAllowance({ boostRules: { maxUnitsPerWallet: 2, closesAt }, walletBoostUnits: "0", nowMs: Date.parse(closesAt) });
  assert.equal(closed.open, false);
  assert.equal(closed.label, "Boosts are closed for the last 20% of the battle.");
  assert.deepEqual(boostQuantityOptions(closed).map((o) => o.disabled), [true, true]);

  const anonymous = boostAllowance({ boostRules: { maxUnitsPerWallet: 2, closesAt }, walletBoostUnits: null, nowMs: before });
  assert.equal(anonymous.remaining, null);
  assert.match(anonymous.label, /^Max 2 Boosts per wallet\./);
});
