import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { WALL_REALTIME_CAP } from "./battleWallRealtime.mjs";
import { presentBattleWallModule } from "./battleWallPresentation.mjs";
import {
  BATTLE_MORE_FUNDING_COPY,
  battleMorePanelId,
  battleMoreToggle,
  compactWalletLabel,
  formatBattleWallMatchQuality,
  presentBattleFundingStatus,
  presentBattleResult,
  presentBattleWallMore,
  shouldPresentScoreBreakdown,
  shouldPresentWarPoolEconomics,
} from "./battleWallMorePresentation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function readSrc(...parts) {
  return fs.readFileSync(path.join(here, ...parts), "utf8");
}

function battle(overrides = {}) {
  return {
    id: "wall-1",
    state: "live",
    source: "queue",
    chainId: 56,
    startedAt: "2026-09-03T10:00:00.000Z",
    endsAt: "2026-09-03T12:00:00.000Z",
    stakeNative: 2,
    durationHours: 24,
    nativeSymbol: "BNB",
    rankedMode: "competitive",
    matchClassification: "strong",
    participants: [
      {
        tokenId: "0xaaa",
        tokenAddress: "0xaaa",
        tokenName: "Alpha",
        symbol: "ALPHA",
        ownerWallet: "0x1234567890abcdef1234567890abcdef12345678",
        liquidityUsd: 42000,
        marketCapUsd: 842000,
        campaignAddress: "0xca",
        origin: "native",
      },
      {
        tokenId: "0xbbb",
        tokenAddress: "0xbbb",
        tokenName: "Bravo",
        symbol: "BRAVO",
        ownerWallet: "0xbbbowner",
        liquidityUsd: 18000,
        marketCapUsd: 790000,
        origin: "imported",
      },
    ],
    ...overrides,
  };
}

function metrics(overrides = {}) {
  return {
    scoringVersion: "battle_points_v2",
    settlementScoringVersion: "battle_points_v2",
    dataHealth: { healthy: true, status: "healthy", reasons: [] },
    sides: {
      left: { current: { marketCapUsd: 842000, liquidityUsd: 42000, holders: 2811, healthy: true } },
      right: { current: { marketCapUsd: 790000, liquidityUsd: 18000, holders: 2422, healthy: true } },
    },
    ...overrides,
  };
}

test("MORE is collapsed by default and LESS is the expanded label", () => {
  const collapsed = battleMoreToggle(false);
  const expanded = battleMoreToggle(true);
  assert.equal(collapsed.expanded, false);
  assert.equal(collapsed.label, "MORE ↓");
  assert.equal(expanded.expanded, true);
  assert.equal(expanded.label, "LESS ↑");
});

test("MORE panel ids and toggle state stay battle-id scoped", () => {
  assert.equal(battleMorePanelId("wall-a"), "battle-wall-a-more");
  assert.equal(battleMorePanelId("wall-b"), "battle-wall-b-more");
  assert.notEqual(battleMorePanelId("wall-a"), battleMorePanelId("wall-b"));
  const aOpen = battleMoreToggle(true);
  const bClosed = battleMoreToggle(false);
  assert.equal(aOpen.expanded, true);
  assert.equal(bClosed.expanded, false);
});

test("Battle Intel presents owner, liquidity, origin, and token identity from existing data", () => {
  const more = presentBattleWallMore(battle(), metrics(), { realtimeState: "connected", dataSource: "feed" });
  assert.equal(more.left.ticker, "$ALPHA");
  assert.equal(more.right.ticker, "$BRAVO");
  assert.equal(more.left.tokenId, "0xaaa");
  assert.equal(more.right.tokenId, "0xbbb");
  assert.equal(more.left.ownerWallet, "0x1234567890abcdef1234567890abcdef12345678");
  assert.equal(more.left.ownerLabel, compactWalletLabel(more.left.ownerWallet));
  assert.equal(more.left.liquidityLabel, "$42.0K");
  assert.equal(more.right.liquidityLabel, "$18.0K");
  assert.equal(more.left.originLabel, "MWZ Native");
  assert.equal(more.right.originLabel, "Imported");
  assert.equal(more.chainLabel, "BNB Chain");
  assert.equal(more.typeLabel, "AUTO DEPLOY / Queue");
  assert.equal(more.classification, "RANKED");
  assert.equal(more.combinedMcapLabel, "$1.63M");
  assert.equal(more.healthLabel, "Battle data healthy");
  assert.equal(more.realtimeLabel, "Realtime linked");
  assert.equal(more.dataSourceLabel, "REST snapshot");
});

test("Match Quality renders only when the backend supplied a value", () => {
  const withQuality = presentBattleWallMore(battle({ matchQuality: 84 }), metrics());
  assert.equal(withQuality.matchQualityLabel, "84%");
  assert.equal(withQuality.terms.matchQualityLabel, "84%");
  const missing = presentBattleWallMore(battle({ matchQuality: null }), metrics());
  assert.equal(missing.matchQualityLabel, null);
  assert.equal(formatBattleWallMatchQuality(null), null);
  assert.equal(formatBattleWallMatchQuality(undefined), null);
  assert.equal(formatBattleWallMatchQuality(""), null);
  assert.equal(formatBattleWallMatchQuality(76.4), "76.4%");
});

test("Match Quality is a server value formatter and does not compute a score", () => {
  const helper = readSrc("./battleWallMorePresentation.mjs");
  const intel = readSrc("../../components/arena/BattleIntel.tsx");
  assert.equal(formatBattleWallMatchQuality(84), "84%");
  assert.match(helper, /formatMatchQuality/);
  assert.doesNotMatch(helper, /matchComponents|matchReasons|cluster|matchScore\s*\*|calculateMatchQuality/);
  assert.doesNotMatch(intel, /matchComponents|matchReasons|calculateMatchQuality/);
});

test("Battle Terms expose stake, duration, start, and end without money-generation copy", () => {
  const more = presentBattleWallMore(battle(), metrics());
  assert.equal(more.terms.stakeLabel, "2.00 BNB");
  assert.equal(more.terms.durationLabel, "24 hours");
  assert.equal(more.terms.startedAt, "2026-09-03T10:00:00.000Z");
  assert.equal(more.terms.endsAt, "2026-09-03T12:00:00.000Z");
  assert.notEqual(more.terms.startedLabel, "Unscheduled");
  assert.notEqual(more.terms.endsLabel, "Unscheduled");
  assert.equal(more.terms.originLabel, "Queue");
  assert.equal(more.terms.fundingCopy, BATTLE_MORE_FUNDING_COPY);
  assert.match(more.terms.fundingCopy, /required funding is complete/);
  assert.doesNotMatch(more.terms.fundingCopy, /85%|75%|5%|10%|20%/);
});

test("VIEW TOURNAMENT appears only when an authoritative tournament id exists", () => {
  const normal = presentBattleWallMore(battle(), metrics());
  assert.equal(normal.terms.tournamentId, null);
  assert.equal(normal.terms.tournamentHref, null);
  const tournament = presentBattleWallMore(
    battle({ id: "tour-fight", source: "tournament", tournamentId: "tour-9" }),
    metrics(),
  );
  assert.equal(tournament.originKind, "tournament");
  assert.equal(tournament.terms.tournamentId, "tour-9");
  assert.equal(tournament.terms.tournamentHref, "/warzone/tournament/tour-9");
});

test("Scoring generation is omitted unless an explicit identifier is present", () => {
  const omitted = presentBattleWallMore(battle({ settlementVersion: 1 }), { settlementMode: "battle_points_v2" });
  assert.equal(omitted.scoringGeneration, null);
  const raw = presentBattleWallMore(battle(), { scoringVersion: "battle_points_v2" });
  assert.equal(raw.scoringGeneration, "battle_points_v2");
  const persisted = presentBattleWallMore(battle(), { settlementScoringVersion: "mcap_pct_change" });
  assert.equal(persisted.scoringGeneration, "mcap_pct_change");
});

test("Phase 4A intel/terms stay generation-neutral on the collapsed wall", () => {
  const files = [
    readSrc("../../components/arena/BattleIntel.tsx"),
    readSrc("../../components/arena/BattleTerms.tsx"),
    readSrc("../../components/arena/BattleWallModule.tsx"),
  ];
  for (const src of files) {
    assert.doesNotMatch(src, /85\s*%|75\s*%/);
    assert.doesNotMatch(src, /5%\s*protocol|10%\s*Major|75%\s*->|20%\s*->/);
    assert.doesNotMatch(src, /Battle Boost|Final Salvo|Vote Tournament|sponsorship/i);
    assert.doesNotMatch(src, /45\s*\/\s*27\s*\/\s*18/);
    assert.doesNotMatch(src, /WarPoolPanel|ArenaStakeButton|ArenaWarPoolClaimButton|ArenaSupportButton|BattleMetricBreakdown/);
  }
});

test("Phase 4B MORE reuses existing score, WarPool, funding, claim, and result surfaces", () => {
  const moreSrc = readSrc("../../components/arena/BattleWallMore.tsx");
  const moduleSrc = readSrc("../../components/arena/BattleWallModule.tsx");
  const fundingSrc = readSrc("../../components/arena/BattleFunding.tsx");
  const resultSrc = readSrc("../../components/arena/BattleResultLog.tsx");
  const breakdownSrc = readSrc("../../components/arena/BattleScoreBreakdown.tsx");
  const v2 = presentBattleWallMore(battle({ state: "live" }), metrics({ settlementMode: "battle_points_v2", scoringVersion: "battle_points_v2" }));
  const upcoming = presentBattleWallMore(battle({ state: "matched" }), metrics({ settlementMode: "battle_points_v2" }));
  const historical = presentBattleWallMore(
    battle({ id: "fin-v1", state: "finished", settlementVersion: 1, winnerToken: "0xaaa" }),
    { settlementScoringVersion: "mcap_pct_change" },
  );
  const v3 = shouldPresentScoreBreakdown({ scoringVersion: "battle_points_v3" }, battle({ state: "live" }));

  assert.equal(v2.showScoreBreakdown, true);
  assert.equal(upcoming.showScoreBreakdown, false);
  assert.equal(historical.showScoreBreakdown, false);
  assert.equal(v3, false);
  assert.equal(historical.showClaim, true);
  assert.equal(upcoming.showFunding, true);
  assert.equal(upcoming.showClaim, false);
  assert.equal(presentBattleFundingStatus({ paidA: true, paidB: false }).label, "AWAITING FUNDING 1 / 2 DEPLOYED");
  assert.equal(presentBattleFundingStatus({ bothPaid: true, paidA: true, paidB: true }).label, "FUNDED");
  assert.equal(presentBattleResult(battle({ state: "finished", winnerToken: "0xaaa" }), { finalBattlePoints: { left: 61, right: 44.5 } }).finalPointsLabel, "61.0 — 44.5");
  assert.equal(presentBattleResult(battle({ state: "live" }), {}).finalPointsLabel, null);

  assert.match(moreSrc, /BattleScoreBreakdown/);
  assert.match(moreSrc, /BattleFunding/);
  assert.match(moreSrc, /BattleResultLog/);
  assert.match(fundingSrc, /ArenaStakeButton/);
  assert.match(fundingSrc, /ArenaWarPoolClaimButton/);
  assert.match(fundingSrc, /fetchArenaStakeStatus/);
  assert.match(breakdownSrc, /BattleMetricBreakdown/);
  assert.doesNotMatch(resultSrc, /Live telemetry V2/);
  assert.doesNotMatch(moreSrc, /Battle Boost|Final Salvo|Live telemetry V2/);
  assert.doesNotMatch(moduleSrc, /WarPoolPanel|ArenaStakeButton|ArenaWarPoolClaimButton|BattleMetricBreakdown/);
  assert.doesNotMatch(moreSrc, /useBattleWallRealtime|useArenaBattleRealtimeDetails/);
});

test("Unknown WarPool generation does not expose historical 85/5/10 economics on the Wall", () => {
  const moreSrc = readSrc("../../components/arena/BattleWallMore.tsx");
  const helper = readSrc("./battleWallMorePresentation.mjs");
  const moduleSrc = readSrc("../../components/arena/BattleWallModule.tsx");
  const unknown = presentBattleWallMore(battle({ state: "live" }), metrics({ settlementMode: "battle_points_v2", scoringVersion: "battle_points_v2" }));
  const fromPoints = shouldPresentWarPoolEconomics({ scoringVersion: "battle_points_v2", settlementMode: "battle_points_v2" });
  const fromSettlement = shouldPresentWarPoolEconomics({ settlementVersion: 2, battleState: "finished" });
  const fromRouting = shouldPresentWarPoolEconomics({ routingBreakdown: { winnersUsd: 85, protocolUsd: 5, featuredUsd: 10 } });
  const knownV1 = shouldPresentWarPoolEconomics({ poolGeneration: "war_pool_v1" });
  const knownV2 = shouldPresentWarPoolEconomics({ poolGeneration: "war_pool_v2" });
  const tournament = presentBattleWallMore(battle({ id: "tour-fight", source: "tournament", tournamentId: "tour-9" }), metrics());

  assert.equal(unknown.warPool.showEconomics, false);
  assert.equal(fromPoints, false);
  assert.equal(fromSettlement, false);
  assert.equal(fromRouting, false);
  assert.equal(knownV1, false);
  assert.equal(knownV2, false);
  assert.equal(tournament.warPool.redirectTo.href, "/warzone/tournament/tour-9");
  assert.match(moreSrc, /data-battle-war-pool="tournament-redirect"/);
  assert.doesNotMatch(moreSrc, /WarPoolPanel|useArenaWarPool|85%|75%|0\.85|0\.75/);
  assert.doesNotMatch(helper, /winnersUsd:\s*Math\.round|totalPotUsd \* 0\.|75\s*\/\s*20\s*\/\s*5/);
  assert.doesNotMatch(moduleSrc, /WarPoolPanel|85%|75%/);
  assert.match(readSrc("../../App.tsx"), /path="\/battle\/:id"/);
});

test("MORE wiring is inline, accessible, and does not add a realtime or profile fetch", () => {
  const moduleSrc = readSrc("../../components/arena/BattleWallModule.tsx");
  const moreSrc = readSrc("../../components/arena/BattleWallMore.tsx");
  const intelSrc = readSrc("../../components/arena/BattleIntel.tsx");
  const page = readSrc("../../pages/ArenaBattles.tsx");
  const realtime = readSrc("./battleWallRealtime.mjs");

  assert.match(moduleSrc, /aria-expanded=\{moreToggle\.expanded\}/);
  assert.match(moduleSrc, /aria-controls=\{morePanelId\}/);
  assert.match(moduleSrc, /battleMorePanelId\(battle\.id\)/);
  assert.match(moduleSrc, /useState\(false\)/);
  assert.match(moduleSrc, /setMoreOpen\(false\)/);
  assert.match(moduleSrc, /\[battle\.id\]/);
  assert.match(moduleSrc, /moreToggle\.label/);
  assert.match(readSrc("./battleWallMorePresentation.mjs"), /MORE ↓/);
  assert.match(readSrc("./battleWallMorePresentation.mjs"), /LESS ↑/);
  assert.match(moduleSrc, /hidden=\{!moreToggle\.expanded\}/);
  assert.match(moduleSrc, /useBattleWallRealtime\(battle\.id, realtimeActive && live\)/);
  assert.equal(moduleSrc.split("useBattleWallRealtime(").length - 1, 1);
  assert.match(moduleSrc, /BattleWallMore/);
  assert.match(moduleSrc, /to=\{presented\.href\}/);
  assert.match(moreSrc, /BattleIntel/);
  assert.match(moreSrc, /BattleTerms/);
  assert.doesNotMatch(moreSrc, /useBattleWallRealtime|useArenaBattleRealtimeDetails|useArenaTokenProfile|useArenaWarPool/);
  assert.doesNotMatch(intelSrc, /useArenaTokenProfile|useArenaBattleRealtimeDetails/);
  assert.match(intelSrc, /getArenaTokenRoute/);
  assert.match(intelSrc, /Token intel/);
  assert.match(readSrc("../../components/arena/BattleTerms.tsx"), /VIEW TOURNAMENT/);
  assert.doesNotMatch(page, /BattleWallMore|moreOpen|MORE ↓/);
  assert.match(page, /key=\{battle\.id\}/);
  assert.equal(WALL_REALTIME_CAP, 2);
  assert.match(realtime, /export const WALL_REALTIME_CAP = 2/);
});

test("Historical V1 and V2 wall presentation stay unchanged beside MORE", () => {
  const historical = presentBattleWallModule(
    battle({ id: "fin-v1", state: "finished", settlementVersion: 1, scoreBasis: "mcap_pct_change" }),
    null,
    { requested: false, loaded: true },
  );
  assert.equal(historical.scoreKind, "legacy");
  assert.equal(historical.scoreCaption, "Score");
  const liveV2 = presentBattleWallModule(
    battle(),
    {
      settlementMode: "battle_points_v2",
      leaderSide: "left",
      pointDifference: 7.2,
      dataHealth: { healthy: true, status: "healthy", reasons: [] },
      sides: {
        left: { pointsReady: true, points: { total: 58.4 } },
        right: { pointsReady: true, points: { total: 51.2 } },
      },
    },
    { requested: true, loaded: true },
  );
  assert.equal(liveV2.scoreKind, "battle_points");
  assert.equal(liveV2.leftPointsLabel, "58.4");
});
