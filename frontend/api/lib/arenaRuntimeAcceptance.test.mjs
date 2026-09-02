import assert from "node:assert/strict";
import test from "node:test";

import { solanaLiveTransition, solanaMatchedLifecyclePatch, solanaMayGoLive } from "./arenaBattleLive.js";
import {
  battleSettlementPatch,
  canSettleBattle,
  decideBattleSettlement,
  decorateSettledParticipants,
} from "./arenaBattleSettle.js";
import {
  DRAW_POINTS,
  LOSS_POINTS,
  MONEY_TIE_BREAK,
  MWL_RESULT,
  WIN_POINTS,
} from "./arenaLeagueScoreMath.js";
import { calculateMatchQuality, optimizeMatchPairings } from "./arenaMatchQuality.js";
import { planTournamentBracketReconcile, unorderedPairKey } from "./arenaTournamentBracketReconcile.js";
import { tournamentStartRoster } from "./arenaTournamentRoster.js";

const NOW_MS = Date.parse("2026-09-02T12:00:00.000Z");
const DEPOSIT_DEADLINE = "2026-09-03T12:00:00.000Z";
const LIVE_ENDS_AT = "2026-09-03T00:00:00.000Z";
const SETTLED_AT = "2026-09-04T12:00:00.000Z";
const SOLANA_CHAIN_ID = 101;

const TOKEN_A = "So11111111111111111111111111111111111111112";
const TOKEN_B = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_C = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const TOKEN_D = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function profile(overrides = {}) {
  return {
    chainId: SOLANA_CHAIN_ID,
    tokenId: TOKEN_A,
    tokenAddress: TOKEN_A,
    ownerWallet: "owner-a",
    marketCapUsd: 12_000_000,
    holderCount: 800,
    liquidityUsd: 700_000,
    volumeUsd: 180_000,
    launchedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

const PROFILE_A = profile({
  tokenId: TOKEN_A,
  tokenAddress: TOKEN_A,
  ownerWallet: "owner-a",
  marketCapUsd: 12_000_000,
  holderCount: 820,
  liquidityUsd: 720_000,
  volumeUsd: 190_000,
  launchedAt: "2026-08-01T00:00:00.000Z",
});
const PROFILE_B = profile({
  tokenId: TOKEN_B,
  tokenAddress: TOKEN_B,
  ownerWallet: "owner-b",
  marketCapUsd: 12_600_000,
  holderCount: 850,
  liquidityUsd: 700_000,
  volumeUsd: 205_000,
  launchedAt: "2026-08-03T00:00:00.000Z",
});
const PROFILE_C = profile({
  tokenId: TOKEN_C,
  tokenAddress: TOKEN_C,
  ownerWallet: "owner-c",
  marketCapUsd: 62_000_000,
  holderCount: 5_400,
  liquidityUsd: 4_200_000,
  volumeUsd: 930_000,
  launchedAt: "2026-07-20T00:00:00.000Z",
});
const PROFILE_D = profile({
  tokenId: TOKEN_D,
  tokenAddress: TOKEN_D,
  ownerWallet: "owner-d",
  marketCapUsd: 60_000_000,
  holderCount: 5_200,
  liquidityUsd: 4_050_000,
  volumeUsd: 910_000,
  launchedAt: "2026-07-19T00:00:00.000Z",
});

const PROFILE_BY_TOKEN = new Map([
  [TOKEN_A, PROFILE_A],
  [TOKEN_B, PROFILE_B],
  [TOKEN_C, PROFILE_C],
  [TOKEN_D, PROFILE_D],
]);

function pairingsAsKeys(pairings) {
  return pairings
    .map((pair) => unorderedPairKey(pair.left.tokenAddress, pair.right.tokenAddress))
    .sort();
}

test("runtime acceptance: ranked Solana battles refresh the deposit window, go live, and settle canonically", () => {
  const match = calculateMatchQuality(PROFILE_A, PROFILE_B, { nowMs: NOW_MS });
  assert.equal(match.rankedEligible, true);
  assert.notEqual(match.classification, "open_war");
  assert.ok(match.matchScore >= 70);

  const waiting = solanaLiveTransition({ arenaLive: true, bothPaid: false });
  assert.equal(waiting.state, "matched");
  assert.equal(waiting.reason, "stakes-unpaid");
  assert.equal(waiting.startDepositWindow, true);

  const lifecycle = solanaMatchedLifecyclePatch(
    waiting,
    { state: "matched", started_at: null, ends_at: null },
    { nowMs: NOW_MS, depositEndsAt: DEPOSIT_DEADLINE },
  );
  assert.equal(lifecycle.action, "refresh-deposit");
  assert.deepEqual(lifecycle.patch, {
    state: "matched",
    started_at: null,
    ends_at: DEPOSIT_DEADLINE,
  });

  assert.equal(solanaMayGoLive({ live: true, bothPaid: true }), true);
  const live = solanaLiveTransition({ arenaLive: true, bothPaid: true });
  assert.equal(live.state, "live");
  assert.equal(live.startFightClock, true);

  const battle = {
    state: "live",
    ends_at: LIVE_ENDS_AT,
    participants: [
      { tokenId: TOKEN_A, tokenAddress: TOKEN_A },
      { tokenId: TOKEN_B, tokenAddress: TOKEN_B },
    ],
  };
  assert.equal(canSettleBattle(battle, Date.parse(SETTLED_AT)), true);

  const decision = decideBattleSettlement({
    leftToken: TOKEN_A,
    rightToken: TOKEN_B,
    leftStartMcap: PROFILE_A.marketCapUsd,
    rightStartMcap: PROFILE_B.marketCapUsd,
    leftEndMcap: 14_000_000,
    rightEndMcap: 13_000_000,
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.mwlResult, MWL_RESULT.LEFT_WIN);
  assert.equal(decision.moneyWinnerToken, TOKEN_A);
  assert.equal(decision.moneyTieBreak, MONEY_TIE_BREAK.PERFORMANCE);
  assert.equal(decision.ledger.left.points, WIN_POINTS);
  assert.equal(decision.ledger.right.points, LOSS_POINTS);

  const participants = decorateSettledParticipants(battle.participants, decision);
  assert.equal(participants[0].isLeading, true);
  assert.equal(participants[1].isLeading, false);
  assert.ok(participants[0].priceChangePct > 16);
  assert.ok(participants[1].priceChangePct > 3);

  const patch = battleSettlementPatch(decision, { nowIso: SETTLED_AT, participants });
  assert.equal(patch.persist, true);
  assert.equal(patch.patch.state, "finished");
  assert.equal(patch.patch.money_winner_token, TOKEN_A);
  assert.equal(patch.patch.mwl_winner_token, TOKEN_A);
  assert.equal(patch.patch.settlement_version, 1);
  assert.equal(patch.patch.participants[0].isLeading, true);
});

test("runtime acceptance: paid tournament rosters seed the closest markets together", () => {
  const blocked = tournamentStartRoster(
    [
      { tokenAddress: TOKEN_A, buyInIntent: true, buyInPaid: true },
      { tokenAddress: TOKEN_B, buyInIntent: true, buyInPaid: false },
    ],
    { buyInNative: 0.25 },
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "unpaid-roster");

  const paidRoster = tournamentStartRoster(
    [
      { tokenAddress: TOKEN_A, buyInIntent: true, buyInPaid: true },
      { tokenAddress: TOKEN_B, buyInIntent: true, buyInPaid: true },
      { tokenAddress: TOKEN_C, buyInIntent: true, buyInPaid: true },
      { tokenAddress: TOKEN_D, buyInIntent: true, buyInPaid: true },
    ],
    { buyInNative: 0.25 },
  );
  assert.equal(paidRoster.ok, true);
  assert.equal(paidRoster.reason, "paid");

  const seeded = optimizeMatchPairings(paidRoster.roster, {
    nowMs: NOW_MS,
    getProfile: (entry) => PROFILE_BY_TOKEN.get(entry.tokenAddress),
  });
  assert.equal(seeded.pairings.length, 2);
  assert.equal(seeded.bye, null);
  assert.deepEqual(
    pairingsAsKeys(seeded.pairings),
    [
      unorderedPairKey(TOKEN_A, TOKEN_B),
      unorderedPairKey(TOKEN_C, TOKEN_D),
    ].sort(),
  );
  assert.ok(seeded.totalMatchQuality > 140);
  for (const pairing of seeded.pairings) {
    assert.equal(pairing.ranked, true);
    assert.notEqual(pairing.classification, "open_war");
  }
});

test("runtime acceptance: tournament progression advances with the money winner even when MWL draws", () => {
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
  assert.equal(decision.mwlWinnerToken, null);
  assert.equal(decision.moneyWinnerToken, TOKEN_B);
  assert.equal(decision.moneyTieBreak, MONEY_TIE_BREAK.ENDING_MCAP);
  assert.equal(decision.ledger.left.points, DRAW_POINTS);
  assert.equal(decision.ledger.right.points, DRAW_POINTS);

  const settled = battleSettlementPatch(decision, {
    nowIso: SETTLED_AT,
    participants: [
      { tokenId: TOKEN_A, tokenAddress: TOKEN_A },
      { tokenId: TOKEN_B, tokenAddress: TOKEN_B },
    ],
  });

  const planned = planTournamentBracketReconcile({
    tournament: {
      id: "tourney-final",
      status: "live",
      chain_id: SOLANA_CHAIN_ID,
      winner_token: null,
      bracket: {
        rounds: [{ round: 1, matches: [{ id: "m1", tokenA: TOKEN_A, tokenB: TOKEN_B, battleId: "arena-final-1", winner: null, bye: false }] }],
      },
    },
    battle: {
      id: "arena-final-1",
      tournament_id: "tourney-final",
      source: "tournament",
      state: "finished",
      chain_id: SOLANA_CHAIN_ID,
      challenger_token: TOKEN_A,
      defender_token: TOKEN_B,
      winner_token: settled.patch.winner_token,
      money_winner_token: settled.patch.money_winner_token,
      mwl_winner_token: settled.patch.mwl_winner_token,
      mwl_draw: settled.patch.mwl_draw,
    },
  });

  assert.equal(planned.ok, true);
  assert.equal(planned.action, "apply");
  assert.equal(planned.finished, true);
  assert.equal(planned.matchWinner, TOKEN_B);
  assert.equal(planned.winner, TOKEN_B);
  assert.equal(planned.nextBracket.rounds[0].matches[0].winner, TOKEN_B);
  assert.equal(planned.battlesToInsert.length, 0);
});
