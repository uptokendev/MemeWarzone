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

test("live baseline capture is hooked on actual live transitions only", () => {
  const battles = read("arenaBattles.js");
  const tournaments = read("arenaTournaments.js");
  const begin = battles.split("async function beginFight")[1]?.split("async function goLiveFromMatched")[0] || "";
  const goLive = battles.split("async function goLiveFromMatched")[1]?.split("export async function promoteMatchedIfFunded")[0] || "";
  const promote = battles.split("export async function promoteMatchedIfFunded")[1]?.split("async function tryAutoMatch")[0] || "";
  const open = battles.split("async function handleOpen")[1]?.split("async function handleChallenge")[0] || "";
  const challenge = battles.split("async function handleChallenge")[1]?.split("function offerFromToken")[0] || "";
  const transition = battles.split("async function handleTransition")[1]?.split("export default async function handler")[0] || "";
  const insert = tournaments.split("async function insertTournamentBattle")[1]?.split("async function handleAdminStart")[0] || "";

  assert.match(begin, /captureLiveBaselines/);
  assert.match(goLive, /captureLiveBaselines/);
  assert.match(transition, /captureLiveBaselines/);
  assert.match(insert, /captureLiveBaselines/);
  assert.doesNotMatch(promote, /captureLiveBaselines/);
  assert.doesNotMatch(open, /captureLiveBaselines/);
  assert.doesNotMatch(challenge, /captureLiveBaselines/);
});

test("arenaBattles still has a single state:\"live\" object write and frozen function order", () => {
  const battles = read("arenaBattles.js");
  const liveAssignments = [...battles.matchAll(/state:\s*["']live["']/g)];
  assert.equal(liveAssignments.length, 1, "arenaBattles should have a single state:'live' object write (goLiveFromMatched)");

  const beginAt = battles.indexOf("async function beginFight");
  const goLiveAt = battles.indexOf("async function goLiveFromMatched");
  const promoteAt = battles.indexOf("export async function promoteMatchedIfFunded");
  const matchAt = battles.indexOf("async function tryAutoMatch");
  const settleAt = battles.indexOf("async function settleLive");
  const expireAt = battles.indexOf("async function expireChallenge");
  assert.ok(beginAt >= 0 && goLiveAt > beginAt);
  assert.ok(promoteAt > goLiveAt);
  assert.ok(matchAt > promoteAt);
  assert.ok(settleAt > matchAt);
  assert.ok(expireAt > settleAt);
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

test("snapshot adapter never maps votes_24h to holders", () => {
  const source = read("lib/arenaMarketSnapshot.js");
  assert.doesNotMatch(source, /votes_24h/);
  assert.match(source, /token_holder_balances/);
});
