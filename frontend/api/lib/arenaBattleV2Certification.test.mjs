import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.join(here, "..");

function read(rel) {
  return fs.readFileSync(path.join(apiRoot, rel), "utf8");
}

test("DB-controlled live transition captures both baselines inside updateBattle transaction", () => {
  const battles = read("arenaBattles.js");
  const update = battles.split("async function updateBattle")[1]?.split("async function waitingCandidates")[0] || "";
  const begin = battles.split("async function beginFight")[1]?.split("async function goLiveFromMatched")[0] || "";
  const goLive = battles.split("async function goLiveFromMatched")[1]?.split("export async function promoteMatchedIfFunded")[0] || "";
  const transition = battles.split("async function handleTransition")[1]?.split("export default async function handler")[0] || "";

  assert.match(update, /patch\.state === ["']live["']/);
  assert.match(update, /pool\.connect\(\)/);
  assert.match(update, /for update/i);
  assert.match(update, /captureLiveBaselines\(updated, \{ query:/);
  assert.match(update, /await client\.query\(["']commit["']\)/);
  assert.match(update, /await client\.query\(["']rollback["']\)/);
  assert.doesNotMatch(begin, /captureLiveBaselines/);
  assert.doesNotMatch(goLive, /captureLiveBaselines/);
  assert.doesNotMatch(transition, /captureLiveBaselines/);
});

test("baseline helper uses battle started_at and writes both combatants in one INSERT", () => {
  const metrics = read("lib/arenaBattleMetrics.js");
  assert.match(metrics, /row\.started_at \|\| row\.startedAt/);
  assert.match(metrics, /prepared\.flatMap/);
  assert.match(metrics, /values \(\$\{first\}\),\(\$\{second\}\)/);
  assert.doesNotMatch(metrics, /baselineTimestamp = nowIso/);
});

test("Match Quality active routes hydrate through normalized market snapshot", () => {
  const battles = read("arenaBattles.js");
  const matches = battles.split("async function handleMatches")[1]?.split("async function handleOpen")[0] || "";
  const open = battles.split("async function handleOpen")[1]?.split("async function handleChallenge")[0] || "";
  const challenge = battles.split("async function handleChallenge")[1]?.split("function offerFromToken")[0] || "";
  const autoMatch = battles.split("async function tryAutoMatch")[1]?.split("async function currentMcap")[0] || "";

  assert.match(battles, /getArenaMarketSnapshot/);
  assert.match(matches, /hydrateMatchCoin/);
  assert.match(open, /hydrateMatchCoin/);
  assert.match(challenge, /hydrateMatchCoin/);
  assert.match(autoMatch, /hydrateMatchCoin/);
  assert.doesNotMatch(battles, /votes_24h/);
});

test("tournament seeding uses normalized snapshot and live insert shares a transaction with baselines", () => {
  const tournaments = read("arenaTournaments.js");
  const snapshot = tournaments.split("async function coinSnapshot")[1]?.split("async function handleList")[0] || "";
  const insert = tournaments.split("async function insertTournamentBattle")[1]?.split("async function handleAdminStart")[0] || "";

  assert.match(tournaments, /getArenaMarketSnapshot/);
  assert.doesNotMatch(tournaments, /votes_24h/);
  assert.doesNotMatch(snapshot, /market_cap_bnb/);
  assert.match(insert, /ownsTransaction/);
  assert.match(insert, /client\.query\(["']begin["']\)/);
  assert.match(insert, /startedAt/);
  assert.match(insert, /captureLiveBaselines/);
  assert.match(insert, /snapshots:\s*\{\s*left:\s*leftSnap,\s*right:\s*rightSnap\s*\}/);
  assert.match(insert, /client\.query\(["']commit["']\)/);
  assert.match(insert, /client\.query\(["']rollback["']\)/);
});

test("imported candidates do not fabricate zero native market metrics", () => {
  const battles = read("arenaBattles.js");
  assert.doesNotMatch(battles, /market_cap_bnb:\s*0/);
  assert.doesNotMatch(battles, /liquidity_bnb:\s*0/);
  assert.doesNotMatch(battles, /volume_24h_bnb:\s*0/);
  assert.match(battles, /marketDataHealthy:\s*false/);
});

test("settleLive still uses V1 settlement and does not import calculateBattlePoints", () => {
  const battles = read("arenaBattles.js");
  const settle = battles.split("async function settleLive")[1]?.split("async function expireChallenge")[0] || "";
  assert.match(settle, /decideBattleSettlement/);
  assert.match(settle, /canSettleBattle/);
  assert.match(settle, /recordFinishedBattle/);
  assert.doesNotMatch(settle, /calculateBattlePoints/);
  assert.doesNotMatch(battles, /from "\.\/lib\/arenaBattlePoints\.js"/);
});

test("canonical calculator source has no chain branches", () => {
  const source = read("lib/arenaBattlePoints.js");
  assert.doesNotMatch(source, /bnb/i);
  assert.doesNotMatch(source, /solana/i);
  assert.doesNotMatch(source, /robinhood/i);
  assert.match(source, /export function calculateBattlePoints/);
});

test("snapshot and match adapters never map votes_24h to holders", () => {
  const snapshot = read("lib/arenaMarketSnapshot.js");
  const match = read("lib/arenaMatchQuality.js");
  assert.doesNotMatch(snapshot, /votes_24h/);
  assert.doesNotMatch(match, /votes_24h/);
  assert.match(snapshot, /token_holder_balances/);
});
