import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DATA_DELAY_LABEL } from "./battleWallPresentation.mjs";
import {
  battleShareAbsoluteUrl,
  battleShareXIntentUrl,
  presentBattleShare,
} from "./battleSharePresentation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function readSrc(...parts) {
  return fs.readFileSync(path.join(here, ...parts), "utf8");
}

function battle(overrides = {}) {
  return {
    id: "wall-share-1",
    state: "live",
    source: "queue",
    chainId: 56,
    participants: [
      { tokenId: "0xaaa", tokenAddress: "0xaaa", tokenName: "Alpha", symbol: "ALPHA", campaignAddress: "0xca" },
      { tokenId: "0xbbb", tokenAddress: "0xbbb", tokenName: "Bravo", symbol: "BRAVO", origin: "imported" },
    ],
    ...overrides,
  };
}

function metrics(overrides = {}) {
  return {
    settlementMode: "battle_points_v2",
    scoringVersion: "battle_points_v2",
    leaderSide: "left",
    pointDifference: 7.2,
    dataHealth: { healthy: true, status: "healthy", reasons: [] },
    sides: {
      left: { pointsReady: true, points: { total: 58.4 } },
      right: { pointsReady: true, points: { total: 51.2 } },
    },
    ...overrides,
  };
}

test("Live battle produces canonical /warzone/battles/:id share path and X intent", () => {
  const share = presentBattleShare(battle(), metrics(), { requested: true, loaded: true, origin: "https://app.example.test" });
  assert.equal(share.canonicalPath, "/warzone/battles/wall-share-1");
  assert.equal(share.canonicalUrl, "https://app.example.test/warzone/battles/wall-share-1");
  assert.equal(share.state, "live");
  assert.match(share.shareText, /\$ALPHA vs \$BRAVO is live in MemeWarzone/);
  assert.match(share.shareText, /Battle Points/);
  assert.doesNotMatch(share.canonicalPath, /\/battle\//);
  assert.match(share.xIntentUrl, /twitter\.com\/intent\/tweet/);
  assert.match(decodeURIComponent(share.xIntentUrl), /\/warzone\/battles\/wall-share-1/);
});

test("Upcoming produces deployment-safe share copy", () => {
  const share = presentBattleShare(battle({ id: "up-1", state: "matched" }), null, { origin: "https://app.example.test" });
  assert.equal(share.state, "upcoming");
  assert.equal(share.canonicalPath, "/warzone/battles/up-1");
  assert.match(share.shareText, /is deploying in MemeWarzone/);
  assert.doesNotMatch(share.shareText, /Battle Points|leads|defeated/i);
});

test("Finished uses authoritative winner only", () => {
  const withWinner = presentBattleShare(
    battle({ id: "fin-1", state: "finished", winnerToken: "0xaaa" }),
    metrics({ finalBattlePoints: { left: 61, right: 44.5 } }),
    { requested: true, loaded: true },
  );
  assert.match(withWinner.shareText, /\$ALPHA defeated \$BRAVO/);
  const withoutWinner = presentBattleShare(battle({ id: "fin-2", state: "finished", leaderSide: "left" }), null);
  assert.match(withoutWinner.shareText, /\$ALPHA vs \$BRAVO is finished/);
  assert.doesNotMatch(withoutWinner.shareText, /defeated/);
  assert.equal(withoutWinner.winnerLabel, null);
});

test("Historical V1 does not say Battle Points", () => {
  const share = presentBattleShare(
    battle({ id: "fin-v1", state: "finished", settlementVersion: 1, scoreBasis: "mcap_pct_change", winnerToken: "0xaaa" }),
    null,
    { requested: false, loaded: true },
  );
  assert.equal(share.scoreKind, "legacy");
  assert.doesNotMatch(share.shareText, /Battle Points/);
  assert.doesNotMatch(share.shareTitle, /Battle Points/);
});

test("V2 Battle Points can be shared as generic Battle Points and V3 is not labeled V2", () => {
  const v2 = presentBattleShare(battle(), metrics(), { requested: true, loaded: true });
  assert.equal(v2.scoreKind, "battle_points");
  assert.match(v2.shareText, /Battle Points/);
  assert.doesNotMatch(v2.shareText, /V2|50\/30\/20|45\/27\/18/);
  const v3 = presentBattleShare(
    battle(),
    metrics({ scoringVersion: "battle_points_v3", settlementScoringVersion: "battle_points_v3" }),
    { requested: true, loaded: true },
  );
  assert.doesNotMatch(v3.shareText, /V2|Battle Points V3|50\/30\/20/);
});

test("DATA DELAY suppresses stale score claims", () => {
  const share = presentBattleShare(
    battle(),
    metrics({ dataHealth: { healthy: false, status: "data_delay", reasons: ["stale"] } }),
    { requested: true, loaded: true },
  );
  assert.equal(share.dataDelayed, true);
  assert.match(share.shareText, new RegExp(DATA_DELAY_LABEL));
  assert.equal(share.leftPointsLabel, null);
  assert.equal(share.rightPointsLabel, null);
  assert.doesNotMatch(share.shareText, /58\.4|51\.2/);
});

test("Imported/native and tournament fights use the same share system", () => {
  const imported = presentBattleShare(
    battle({
      participants: [
        { tokenId: "SoL111", tokenAddress: "SoL111", symbol: "IMP", tokenName: "Imported", origin: "imported" },
        { tokenId: "0xbbb", tokenAddress: "0xbbb", symbol: "BRAVO", tokenName: "Bravo", campaignAddress: "0xca" },
      ],
    }),
    metrics(),
    { requested: true, loaded: true },
  );
  const tournament = presentBattleShare(
    battle({ id: "tour-fight", source: "tournament", tournamentId: "tour-9" }),
    metrics(),
    { requested: true, loaded: true },
  );
  assert.equal(imported.canonicalPath.startsWith("/warzone/battles/"), true);
  assert.equal(tournament.canonicalPath, "/warzone/battles/tour-fight");
  assert.equal(tournament.tournament, true);
  assert.match(tournament.shareText, /tournament/);
  assert.equal(typeof imported.shareText, typeof tournament.shareText);
});

test("Share helpers stay generation-neutral and do not invent money or formulas", () => {
  const src = readSrc("./battleSharePresentation.mjs");
  const menu = readSrc("../../components/arena/BattleShareMenu.tsx");
  const moduleSrc = readSrc("../../components/arena/BattleWallModule.tsx");
  const moreSrc = readSrc("../../components/arena/BattleWallMore.tsx");
  const carousel = readSrc("../../components/arena/CreatorChallengeCarousel.tsx");
  const app = readSrc("../../App.tsx");

  assert.equal(battleShareAbsoluteUrl("/warzone/battles/abc", "https://app.example.test"), "https://app.example.test/warzone/battles/abc");
  assert.match(battleShareXIntentUrl("hello", "https://app.example.test/warzone/battles/abc"), /twitter\.com\/intent\/tweet/);
  assert.match(src, /presentBattleWallModule/);
  assert.doesNotMatch(src, /calculateBattlePoints|50\/30\/20|45\/27\/18|war_pool_v|85%|75%|0\.85|0\.75/);
  assert.doesNotMatch(menu, /WarPoolPanel|ArenaStakeButton|\/battle\//);
  assert.match(menu, /Copy battle link/);
  assert.match(menu, /Share on X/);
  assert.match(menu, /Download share image/);
  assert.match(menu, /\/api\/battle-share-card/);
  assert.match(moduleSrc, /BattleShareMenu/);
  assert.match(moduleSrc, /data-battle-wall-actions-reserved/);
  assert.match(moreSrc, /BattleFunding/);
  assert.match(carousel, /beginChallengePending/);
  assert.match(app, /path="\/battle\/:id"/);
});
