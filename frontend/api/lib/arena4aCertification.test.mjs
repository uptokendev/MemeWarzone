import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DRAW_POINTS,
  INVALID_MARKET_CAP_SNAPSHOT,
  LOSS_POINTS,
  WIN_POINTS,
  mwlLedgerPlan,
  pairKey,
  settleBattleResult,
} from "./arenaLeagueScoreMath.js";
import { battleSettlementPatch, canSettleBattle } from "./arenaBattleSettle.js";
import { solanaLiveTransition, solanaMatchedLifecyclePatch, solanaMayGoLive } from "./arenaBattleLive.js";

const TOKEN_A = "0x1111111111111111111111111111111111111111";
const TOKEN_B = "0x2222222222222222222222222222222222222222";
const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.join(here, "..");
const repoRoot = path.join(here, "../../..");

function read(rel) {
  return fs.readFileSync(path.join(apiRoot, rel), "utf8");
}

test("4a.4: no Solana battle live-transition bypass outside the canonical gate", () => {
  const battles = read("arenaBattles.js");
  const warPools = read("arenaWarPools.js");
  const begin = battles.split("async function beginFight")[1]?.split("async function goLiveFromMatched")[0] || "";
  const goLive = battles.split("async function goLiveFromMatched")[1]?.split("export async function promoteMatchedIfFunded")[0] || "";
  const promote = battles.split("export async function promoteMatchedIfFunded")[1]?.split("async function tryAutoMatch")[0] || "";
  const admin = battles.split("async function handleTransition")[1]?.split("export default async function handler")[0] || "";

  assert.match(begin, /solanaLiveTransition/);
  assert.match(goLive, /solanaMayGoLive/);
  assert.match(promote, /solanaLiveTransition/);
  assert.match(promote, /solanaMatchedLifecyclePatch/);
  assert.match(admin, /SOLANA_BATTLE_NOT_FUNDED/);
  assert.match(admin, /solanaLiveTransition/);
  assert.match(warPools, /promoteMatchedIfFunded/);
  assert.doesNotMatch(begin, /arena_war_pool_deposits/);
  assert.doesNotMatch(goLive, /arena_war_pool_deposits/);
  assert.doesNotMatch(promote, /arena_war_pool_deposits/);

  const liveAssignments = [...battles.matchAll(/state:\s*["']live["']/g)];
  assert.equal(liveAssignments.length, 1, "arenaBattles should have a single state:'live' object write (goLiveFromMatched)");
  assert.match(goLive, /state: "live"/);

  const open = battles.split("async function handleOpen")[1]?.split("async function handleChallenge")[0] || "";
  const challenge = battles.split("async function handleChallenge")[1]?.split("async function handleAccept")[0] || "";
  assert.match(open, /state: "waiting"/);
  assert.match(challenge, /state: "challenged"/);
  assert.doesNotMatch(open, /state: "live"/);
  assert.doesNotMatch(challenge, /state: "live"/);
});

test("4a.4: tournament match rows still insert live — deferred to 4c, not a 4a battle bypass", () => {
  const tournaments = read("arenaTournaments.js");
  const insert = tournaments.split("async function insertTournamentBattle")[1]?.split("async function handleAdminStart")[0] || "";
  assert.match(insert, /'live'/);
  assert.match(insert, /'tournament'/);
  assert.doesNotMatch(insert, /solanaLiveTransition/);
});

test("4a.4: invalid market-cap data never scores or persists a payout winner", () => {
  const decision = settleBattleResult({
    leftToken: TOKEN_A,
    rightToken: TOKEN_B,
    leftStartMcap: 0,
    rightStartMcap: 10_000,
    leftEndMcap: 20_000,
    rightEndMcap: 15_000,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, INVALID_MARKET_CAP_SNAPSHOT);
  assert.equal(decision.mwlResult, null);
  assert.equal(decision.moneyWinnerToken, null);
  assert.equal(decision.ledger, null);
  const write = battleSettlementPatch(decision, { nowIso: "2026-08-31T12:00:00.000Z" });
  assert.equal(write.persist, false);
  assert.equal(write.patch, null);

  const settle = read("arenaBattles.js").split("async function settleLive")[1]?.split("async function expireChallenge")[0] || "";
  assert.match(settle, /if \(!preview\.ok\) return mapBattle\(row\)/);
  const previewReturnAt = settle.indexOf("if (!preview.ok)");
  const scoreAt = settle.indexOf("recordFinishedBattle");
  assert.ok(previewReturnAt >= 0 && scoreAt > previewReturnAt);
  assert.equal(canSettleBattle({ state: "live" }), false);
});

test("4a.4: duplicate settlement cannot double-write the same battle ledger row", () => {
  const sql = fs.readFileSync(
    path.join(repoRoot, "db/migrations/20260829_000001_arena_settle_idempotency.sql"),
    "utf8",
  );
  assert.match(sql, /arena_league_point_events_battle_token_kind_idx/);
  assert.match(sql, /duplicate battle MWL events require review/);
  const writer = read("lib/arenaLeagueScore.js");
  assert.match(writer, /on conflict \(season_id, battle_id, token_address, kind\)/);
  assert.match(writer, /already-scored/);
  const settle = read("arenaBattles.js").split("async function settleLive")[1]?.split("async function expireChallenge")[0] || "";
  assert.match(settle, /for update/);
  assert.match(settle, /state = 'live' and ends_at is not null and ends_at <= now\(\)/);

  const seen = new Set();
  function writeOnce(battleId, token, kind) {
    const key = `${battleId}:${token}:${kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }
  assert.equal(writeOnce("b1", TOKEN_A, "battle_win"), true);
  assert.equal(writeOnce("b1", TOKEN_A, "battle_win"), false);
  assert.equal(writeOnce("b1", TOKEN_B, "battle_loss"), true);
});

test("4a.4: concurrent rematches cannot double-score after pair serialization", () => {
  const writer = read("lib/arenaLeagueScore.js");
  const fn = writer.split("export async function recordFinishedBattle")[1]?.split("export async function creditCheckin")[0] || "";
  assert.ok(fn.indexOf("lockPairScoring") < fn.indexOf("pairScoredRecently"));
  assert.match(writer, /pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)/);

  const input = {
    leftToken: TOKEN_A,
    rightToken: TOKEN_B,
    leftStartMcap: 100,
    rightStartMcap: 100,
    leftEndMcap: 140,
    rightEndMcap: 90,
  };
  let pairScored = false;
  function serializedSettle() {
    const already = pairScored;
    const result = settleBattleResult({ ...input, pairAlreadyScored: already });
    if (!already) pairScored = true;
    return result;
  }
  const first = serializedSettle();
  const second = serializedSettle();
  assert.equal(first.ledger.left.points, WIN_POINTS);
  assert.equal(first.ledger.right.points, LOSS_POINTS);
  assert.equal(second.ledger.skipPoints, true);
  assert.equal(second.ledger.countFight, true);
  assert.equal(second.ledger.left.points, 0);
  assert.equal(pairKey(TOKEN_A, TOKEN_B), pairKey(TOKEN_B, TOKEN_A));
});

test("4a.4: Arena downtime never consumes the Solana deposit window", () => {
  const down = solanaMatchedLifecyclePatch(
    solanaLiveTransition({ arenaLive: false, bothPaid: false }),
    { state: "matched", started_at: null, ends_at: "2026-08-31T15:00:00.000Z" },
    { nowMs: Date.parse("2026-08-31T14:00:00.000Z") },
  );
  assert.equal(down.expire, false);
  assert.equal(down.patch.ends_at, null);
  assert.equal(down.patch.started_at, null);

  const recovered = solanaMatchedLifecyclePatch(
    solanaLiveTransition({ arenaLive: true, bothPaid: false }),
    { state: "matched", started_at: null, ends_at: "2026-08-31T15:00:00.000Z" },
    { nowMs: Date.parse("2026-08-31T17:00:00.000Z"), depositEndsAt: "2026-09-01T17:00:00.000Z" },
  );
  assert.equal(recovered.expire, false);
  assert.equal(recovered.patch.ends_at, "2026-09-01T17:00:00.000Z");
  assert.equal(solanaMayGoLive({ live: false, bothPaid: true }), false);
  assert.equal(solanaLiveTransition({ arenaLive: true, bothPaid: true }).state, "live");
});

test("4a.4: money winner never leaks into MWL points", () => {
  const decision = settleBattleResult({
    leftToken: TOKEN_A,
    rightToken: TOKEN_B,
    leftStartMcap: 100,
    rightStartMcap: 200,
    leftEndMcap: 110,
    rightEndMcap: 220,
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.mwlDraw, true);
  assert.equal(decision.mwlWinnerToken, null);
  assert.equal(decision.moneyWinnerToken, TOKEN_B);
  assert.equal(decision.ledger.left.points, DRAW_POINTS);
  assert.equal(decision.ledger.right.points, DRAW_POINTS);
  const leaked = mwlLedgerPlan({
    mwlDraw: true,
    mwlWinnerToken: decision.moneyWinnerToken,
    leftToken: TOKEN_A,
    rightToken: TOKEN_B,
  });
  assert.equal(leaked.left.points, DRAW_POINTS);
  assert.equal(leaked.right.kind, "battle_draw");

  const settle = read("arenaBattles.js").split("async function settleLive")[1]?.split("async function expireChallenge")[0] || "";
  assert.match(settle, /mwlWinnerToken: decision\.mwlWinnerToken/);
  assert.match(settle, /mwlDraw: decision\.mwlDraw/);
  assert.doesNotMatch(settle, /mwlWinnerToken: decision\.moneyWinnerToken/);
});

test("4a.4: UpVotes remain isolated from MWL scoring and the league table", () => {
  const math = read("lib/arenaLeagueScoreMath.js");
  const writer = read("lib/arenaLeagueScore.js");
  const votes = read("arenaVotes.js");
  const leagueUi = fs.readFileSync(path.join(apiRoot, "../src/pages/PostGradLeague.tsx"), "utf8");
  assert.doesNotMatch(math, /upvote/i);
  assert.doesNotMatch(writer, /upvote/i);
  assert.doesNotMatch(writer, /arena_votes/);
  assert.doesNotMatch(votes, /recordFinishedBattle/);
  assert.doesNotMatch(votes, /mwlLedgerPlan/);
  assert.doesNotMatch(votes, /settleBattleResult/);
  assert.doesNotMatch(leagueUi, /upvote/i);
  assert.doesNotMatch(leagueUi, /volume/i);
  assert.match(leagueUi, /Win 3 \/ loss 1 \/ draw 0/);
  assert.match(writer, /kind: "checkin"/);
  assert.match(writer, /kind: "dispatch"/);
});
