import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MISSING_BATTLE_CHAIN_ID,
  pairKey,
  pairScoringLockKey,
  requireBattleChainId,
} from "./arenaLeagueScoreMath.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.join(here, "..");
const srcRoot = path.join(here, "../../src");

function readApi(rel) {
  return fs.readFileSync(path.join(apiRoot, rel), "utf8");
}

function readSrc(rel) {
  return fs.readFileSync(path.join(srcRoot, rel), "utf8");
}

const EVM_A = `0x${"Aa".repeat(20)}`;
const EVM_B = `0x${"Bb".repeat(20)}`;
const SOL_A = "So11111111111111111111111111111111111111112";
const SOL_B = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

test("4d: EVM pair casing is ignored; Solana casing is identity; pairs are unordered", () => {
  assert.equal(pairKey(EVM_A, EVM_B), pairKey(EVM_A.toLowerCase(), `0x${EVM_B.slice(2).toUpperCase()}`));
  assert.notEqual(pairKey(SOL_A, SOL_B), pairKey(SOL_A.toLowerCase(), SOL_B));
  assert.equal(pairKey(SOL_A, SOL_B), pairKey(SOL_B, SOL_A));
  assert.equal(pairKey(EVM_A, EVM_B), pairKey(EVM_B, EVM_A));
});

test("4d: missing chain_id is MISSING_BATTLE_CHAIN_ID before lock, rematch lookup, or ledger writes", () => {
  assert.equal(requireBattleChainId({ challenger_token: EVM_A, defender_token: EVM_B }).reason, MISSING_BATTLE_CHAIN_ID);
  assert.equal(requireBattleChainId({ chain_id: 101 }).ok, true);

  const writer = readApi("lib/arenaLeagueScore.js");
  const fn = writer.split("export async function recordFinishedBattle")[1]?.split("export async function creditCheckin")[0] || "";
  assert.match(fn, /requireBattleChainId/);
  assert.match(fn, /MISSING_BATTLE_CHAIN_ID|chain\.reason/);
  const chainGuard = fn.indexOf("requireBattleChainId");
  assert.ok(chainGuard >= 0);
  assert.ok(chainGuard < fn.indexOf("ensureActiveSeason"));
  assert.ok(chainGuard < fn.indexOf("lockPairScoring"));
  assert.ok(chainGuard < fn.indexOf("pairScoredRecently"));
  assert.ok(chainGuard < fn.indexOf("mwlLedgerPlan"));
  assert.ok(chainGuard < fn.indexOf("writeEvent"));
  assert.ok(chainGuard < fn.indexOf("bumpEntry"));
  assert.doesNotMatch(fn, /Number\(chainId\) \|\| 56/);
  assert.doesNotMatch(fn, /ensureActiveSeason\(row\.chain_id/);
});

test("4d: advisory lock is season plus canonical pair; season id remains chain-specific", () => {
  const key = pairKey(SOL_A, SOL_B);
  assert.equal(pairScoringLockKey("mwl-2026-q3-c101", key), `mwl-2026-q3-c101:${key}`);
  assert.match(key, /:/);
  assert.doesNotMatch(key, /\|/);

  const writer = readApi("lib/arenaLeagueScore.js");
  assert.match(writer, /mwl-\$\{year\}-q\$\{quarter\}-c\$\{idNum\}/);
  const record = writer.split("export async function recordFinishedBattle")[1]?.split("export async function creditCheckin")[0] || "";
  assert.match(record, /ensureActiveSeason\(chain\.chainId/);
  assert.match(record, /lockPairScoring\(season\.id, key/);
  const lockFn = writer.split("async function lockPairScoring")[1]?.split("async function pairScoredRecently")[0] || "";
  assert.match(lockFn, /pairScoringLockKey\(seasonId, key\)/);
});

test("4d: UpVotes and Command Center display never write MWL battle scoring", () => {
  const math = readApi("lib/arenaLeagueScoreMath.js");
  const writer = readApi("lib/arenaLeagueScore.js");
  const votes = readApi("arenaVotes.js");
  const league = readApi("arenaLeague.js");
  const briefing = readSrc("components/command-center/ArenaDailyBriefing.tsx");
  const battlesUi = readSrc("pages/command-center/CommandCenterBattles.tsx");

  assert.doesNotMatch(math, /upvote/i);
  assert.doesNotMatch(writer, /upvote/i);
  assert.doesNotMatch(writer, /arena_votes/);
  assert.doesNotMatch(votes, /recordFinishedBattle/);
  assert.doesNotMatch(votes, /mwlLedgerPlan/);
  assert.doesNotMatch(votes, /settleBattleResult/);
  assert.doesNotMatch(league, /upvote/i);
  assert.doesNotMatch(briefing, /upvote/i);
  assert.doesNotMatch(briefing, /recordFinishedBattle/);
  assert.doesNotMatch(briefing, /settleLive/);
  assert.doesNotMatch(briefing, /battle_win|battle_loss|battle_draw/);
  assert.doesNotMatch(battlesUi, /recordFinishedBattle/);
  assert.doesNotMatch(battlesUi, /mwlLedgerPlan/);
  assert.doesNotMatch(battlesUi, /writeEvent/);
});

test("4d: briefing check-in/streak/dispatch stay activity events; GET does not settle", () => {
  const writer = readApi("lib/arenaLeagueScore.js");
  const league = readApi("arenaLeague.js");
  assert.match(writer, /kind: "checkin"/);
  assert.match(writer, /kind: "dispatch"/);
  assert.match(writer, /kind: "streak_bonus"/);
  const checkin = writer.split("export async function creditCheckin")[1]?.split("export async function creditDispatch")[0] || writer.split("export async function creditCheckin")[1] || "";
  assert.doesNotMatch(checkin, /battle_win/);
  assert.doesNotMatch(checkin, /recordFinishedBattle/);

  const statusHandler = league.split("checkin-status")[0] + league.split("checkinStatus")[1]?.slice(0, 800) || league;
  assert.doesNotMatch(league.split("async function handleCheckinStatus")[1]?.split("async function ")[0] || statusHandler, /settleLive/);
  assert.doesNotMatch(league, /settleLive/);
  assert.doesNotMatch(league, /recordFinishedBattle/);
});

test("4d: settleLive still scores MWL from mwlWinnerToken and payouts from money_winner_token", () => {
  const settle = readApi("arenaBattles.js").split("async function settleLive")[1]?.split("async function expireChallenge")[0] || "";
  assert.match(settle, /mwlWinnerToken: decision\.mwlWinnerToken/);
  assert.doesNotMatch(settle, /mwlWinnerToken: decision\.moneyWinnerToken/);
  assert.match(settle, /money_winner_token = \$3/);
  assert.match(settle, /decision\.moneyWinnerToken/);
});

test("4d: pairKey uses canonicalTokenKey; 4c and Create/BUY/SELL stay out of this cut", () => {
  const math = readApi("lib/arenaLeagueScoreMath.js");
  const pairFn = math.split("export function pairKey")[1]?.split("export function requireBattleChainId")[0] || "";
  assert.match(pairFn, /canonicalTokenKey/);
  assert.doesNotMatch(pairFn, /\.toLowerCase\(\)/);

  const writer = readApi("lib/arenaLeagueScore.js");
  assert.doesNotMatch(math, /planTournamentResolve/);
  assert.doesNotMatch(math, /planTournamentBracketReconcile/);
  assert.doesNotMatch(writer, /planTournamentResolve/);
  assert.doesNotMatch(writer, /window\.phantom/i);
  assert.doesNotMatch(writer, /solanaUserV0Transaction/);
  assert.doesNotMatch(math, /compileSolanaUserV0WithLatestBlockhash/);
});
