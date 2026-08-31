import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  INVALID_MARKET_CAP_SNAPSHOT,
  MONEY_TIE_BREAK,
  MWL_RESULT,
} from "./arenaLeagueScoreMath.js";
import {
  battleSettlementPatch,
  canSettleBattle,
  decideBattleSettlement,
  decorateSettledParticipants,
} from "./arenaBattleSettle.js";

const TOKEN_A = "0x1111111111111111111111111111111111111111";
const TOKEN_B = "0x2222222222222222222222222222222222222222";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../../..");

test("canSettleBattle requires live and ends_at in the past", () => {
  const now = Date.parse("2026-08-29T12:00:00.000Z");
  assert.equal(canSettleBattle({ state: "live", ends_at: "2026-08-29T11:00:00.000Z" }, now), true);
  assert.equal(canSettleBattle({ state: "live", ends_at: "2026-08-29T13:00:00.000Z" }, now), false);
  assert.equal(canSettleBattle({ state: "live" }, now), false);
  assert.equal(canSettleBattle({ state: "matched", ends_at: "2026-08-29T11:00:00.000Z" }, now), false);
  assert.equal(canSettleBattle({ state: "finished", ends_at: "2026-08-29T11:00:00.000Z" }, now), false);
});

test("invalid snapshot does not persist MWL points or a payout winner", () => {
  const decision = decideBattleSettlement({
    leftToken: TOKEN_A,
    rightToken: TOKEN_B,
    leftStartMcap: 0,
    rightStartMcap: 10000,
    leftEndMcap: 20000,
    rightEndMcap: 15000,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, INVALID_MARKET_CAP_SNAPSHOT);
  const write = battleSettlementPatch(decision, { nowIso: "2026-08-29T12:00:00.000Z" });
  assert.equal(write.persist, false);
  assert.equal(write.patch, null);
});

test("durable patch keeps MWL result separate from money winner", () => {
  const decision = decideBattleSettlement({
    leftToken: TOKEN_A,
    rightToken: TOKEN_B,
    leftStartMcap: 100,
    rightStartMcap: 200,
    leftEndMcap: 110,
    rightEndMcap: 220,
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.mwlResult, MWL_RESULT.DRAW);
  assert.equal(decision.moneyWinnerToken, TOKEN_B);
  assert.equal(decision.moneyTieBreak, MONEY_TIE_BREAK.ENDING_MCAP);
  const write = battleSettlementPatch(decision, { nowIso: "2026-08-29T12:00:00.000Z", participants: [] });
  assert.equal(write.persist, true);
  assert.equal(write.patch.state, "finished");
  assert.equal(write.patch.mwl_draw, true);
  assert.equal(write.patch.mwl_winner_token, null);
  assert.equal(write.patch.money_winner_token, TOKEN_B);
  assert.equal(write.patch.winner_token, TOKEN_B);
  assert.notEqual(write.patch.mwl_result, write.patch.money_winner_token);
});

test("isLeading follows MWL winner, not the money winner, on a draw", () => {
  const decision = decideBattleSettlement({
    leftToken: TOKEN_A,
    rightToken: TOKEN_B,
    leftStartMcap: 100,
    rightStartMcap: 200,
    leftEndMcap: 110,
    rightEndMcap: 220,
  });
  const parts = decorateSettledParticipants(
    [{ tokenAddress: TOKEN_A }, { tokenAddress: TOKEN_B }],
    decision,
  );
  assert.equal(parts[0].isLeading, false);
  assert.equal(parts[1].isLeading, false);
});

test("rerunning the same snapshot produces the same persist patch", () => {
  const input = {
    leftToken: TOKEN_A,
    rightToken: TOKEN_B,
    leftStartMcap: 80,
    rightStartMcap: 80,
    leftEndMcap: 80,
    rightEndMcap: 96,
  };
  const first = battleSettlementPatch(decideBattleSettlement(input), { nowIso: "t1" });
  const second = battleSettlementPatch(decideBattleSettlement(input), { nowIso: "t1" });
  assert.deepEqual(first, second);
});

test("settleLive consumes settleBattleResult and fail-closes invalid snapshots", () => {
  const battles = fs.readFileSync(path.join(here, "../arenaBattles.js"), "utf8");
  const handler = battles.split("async function settleLive")[1]?.split("async function expireChallenge")[0] || "";
  assert.match(handler, /decideBattleSettlement/);
  assert.match(handler, /canSettleBattle/);
  assert.match(handler, /battleSettlementPatch/);
  assert.match(handler, /recordFinishedBattle/);
  assert.match(handler, /mwlWinnerToken: decision\.mwlWinnerToken/);
  assert.match(handler, /if \(!preview\.ok\) return mapBattle\(row\)/);
  assert.match(handler, /if \(!decision\.ok\)/);
  assert.match(handler, /for update/);
  assert.match(handler, /state = 'live' and ends_at is not null and ends_at <= now\(\)/);
  assert.doesNotMatch(handler, /leftPct > rightPct/);
  assert.doesNotMatch(handler, /winner_token: winner/);
  assert.doesNotMatch(handler, /state: "live"/);
  assert.doesNotMatch(handler, /pctChange\(/);
});

test("league writer scores MWL outcome and treats ledger conflicts as already scored", () => {
  const writer = fs.readFileSync(path.join(here, "arenaLeagueScore.js"), "utf8");
  const fn = writer.split("export async function recordFinishedBattle")[1]?.split("export async function creditCheckin")[0] || "";
  assert.match(fn, /mwlLedgerPlan/);
  assert.match(fn, /mwlDraw/);
  assert.match(fn, /already-scored/);
  assert.match(fn, /mwlWinnerToken/);
  assert.doesNotMatch(fn, /row\.winner_token/);
  assert.match(writer, /on conflict \(season_id, battle_id, token_address, kind\)/);
});

test("pair scoring lock is taken before the 7-day pair-window read", () => {
  const writer = fs.readFileSync(path.join(here, "arenaLeagueScore.js"), "utf8");
  assert.match(writer, /pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)/);
  const fn = writer.split("export async function recordFinishedBattle")[1]?.split("export async function creditCheckin")[0] || "";
  const lockAt = fn.indexOf("lockPairScoring");
  const readAt = fn.indexOf("pairScoredRecently");
  assert.ok(lockAt >= 0 && readAt > lockAt, "pair lock must precede pairScoredRecently");
});

test("migration persists snapshot columns and unique battle ledger rows", () => {
  const sql = fs.readFileSync(
    path.join(root, "db/migrations/20260829_000001_arena_settle_idempotency.sql"),
    "utf8",
  );
  assert.match(sql, /money_winner_token/);
  assert.match(sql, /mwl_draw/);
  assert.match(sql, /mwl_result/);
  assert.match(sql, /money_tie_break/);
  assert.match(sql, /challenger_end_mcap_usd/);
  assert.match(sql, /settlement_version/);
  assert.match(sql, /settled_at/);
  assert.match(sql, /arena_league_point_events_battle_token_kind_idx/);
  assert.match(sql, /UNIQUE INDEX/);
  assert.match(sql, /duplicate battle MWL events require review/);
  const preflightAt = sql.indexOf("RAISE EXCEPTION");
  const indexAt = sql.indexOf("CREATE UNIQUE INDEX");
  assert.ok(preflightAt >= 0 && indexAt > preflightAt, "duplicate preflight must precede unique index");
});
