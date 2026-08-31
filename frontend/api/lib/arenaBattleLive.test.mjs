import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { solanaLiveTransition, solanaMayGoLive } from "./arenaBattleLive.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("Solana not-live never starts a fight clock, even if bothPaid is claimed", () => {
  const result = solanaLiveTransition({ arenaLive: false, bothPaid: true });
  assert.equal(result.state, "matched");
  assert.equal(result.reason, "arena-not-live");
  assert.equal(result.startFightClock, false);
  assert.equal(result.startDepositWindow, false);
  assert.equal(solanaMayGoLive({ live: false, bothPaid: true }), false);
  assert.equal(solanaLiveTransition({ arenaLive: undefined, bothPaid: true }).state, "matched");
});

test("Solana one-paid battle remains matched with a deposit window", () => {
  const result = solanaLiveTransition({ arenaLive: true, bothPaid: false });
  assert.equal(result.state, "matched");
  assert.equal(result.reason, "stakes-unpaid");
  assert.equal(result.startFightClock, false);
  assert.equal(result.startDepositWindow, true);
  assert.equal(solanaMayGoLive({ live: true, bothPaid: false, paidA: true, paidB: false }), false);
});

test("Solana both-paid and Arena live may become live", () => {
  const result = solanaLiveTransition({ arenaLive: true, bothPaid: true });
  assert.equal(result.state, "live");
  assert.equal(result.startFightClock, true);
  assert.equal(result.startDepositWindow, false);
  assert.equal(solanaMayGoLive({ live: true, bothPaid: true }), true);
});

test("beginFight and matched promotion use on-chain bothPaid, not off-chain receipts", () => {
  const battles = fs.readFileSync(path.join(here, "../arenaBattles.js"), "utf8");
  const begin = battles.split("async function beginFight")[1]?.split("async function goLiveFromMatched")[0] || "";
  const promote = battles.split("export async function promoteMatchedIfFunded")[1]?.split("async function tryAutoMatch")[0] || "";
  const transition = battles.split("async function handleTransition")[1]?.split("export default async function handler")[0] || "";
  const solanaBegin = begin.split("if (isSolanaWarzoneChainId(chainId))")[1]?.split("const requireEscrow")[0] || "";
  assert.match(begin, /solanaLiveTransition/);
  assert.match(begin, /readOnchainPool/);
  assert.match(solanaBegin, /onchain\.bothPaid === true/);
  assert.match(solanaBegin, /onchain\.live === true/);
  assert.doesNotMatch(solanaBegin, /escrowRequired/);
  assert.doesNotMatch(begin, /arena_war_pool_deposits/);
  assert.match(begin, /escrowRequired\(chainId\)/);
  assert.match(promote, /solanaLiveTransition/);
  assert.match(promote, /startDepositWindow/);
  assert.match(promote, /onchain\.live === true/);
  assert.doesNotMatch(promote, /arena_war_pool_deposits/);
  assert.match(transition, /SOLANA_BATTLE_NOT_FUNDED/);
  assert.match(transition, /solanaLiveTransition/);
});
