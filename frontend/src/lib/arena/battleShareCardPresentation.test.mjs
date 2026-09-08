import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DATA_DELAY_LABEL } from "./battleWallPresentation.mjs";
import {
  BATTLE_SHARE_CARD_HEIGHT,
  BATTLE_SHARE_CARD_WIDTH,
  battleShareCardImagePath,
  battleShareCardSvg,
  presentBattleShareCard,
} from "./battleShareCardPresentation.mjs";

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

test("Battle share PNG presenter is 1200x630 with canonical focused Battle URL", () => {
  const card = presentBattleShareCard(battle(), metrics(), {
    requested: true,
    loaded: true,
    origin: "https://app.example.test",
  });
  assert.equal(card.width, 1200);
  assert.equal(card.height, 630);
  assert.equal(BATTLE_SHARE_CARD_WIDTH, 1200);
  assert.equal(BATTLE_SHARE_CARD_HEIGHT, 630);
  assert.equal(card.canonicalPath, "/warzone/battles/wall-share-1");
  assert.equal(card.canonicalUrl, "https://app.example.test/warzone/battles/wall-share-1");
  assert.match(String(card.scoreCaption || ""), /Battle points/i);
  assert.equal(card.leftPointsLabel, "58.4");
  assert.match(battleShareCardSvg(card), /width="1200"/);
  assert.match(battleShareCardSvg(card), /height="630"/);
  assert.match(battleShareCardSvg(card), />V</);
  assert.match(battleShareCardSvg(card), />S</);
  assert.equal(battleShareCardImagePath("wall-share-1"), "/api/battle-share-card?battleId=wall-share-1");
});

test("DATA DELAY share PNG suppresses stale scores and does not infer a winner", () => {
  const card = presentBattleShareCard(
    battle(),
    metrics({ dataHealth: { healthy: false, status: "data_delay", reasons: ["stale"] } }),
    { requested: true, loaded: true, origin: "https://app.example.test" },
  );
  assert.equal(card.dataDelayed, true);
  assert.equal(card.leftPointsLabel, null);
  assert.equal(card.rightPointsLabel, null);
  assert.equal(card.winnerLabel, null);
  assert.equal(card.stateLabel, DATA_DELAY_LABEL);
  const svg = battleShareCardSvg(card);
  assert.match(svg, new RegExp(DATA_DELAY_LABEL));
  assert.doesNotMatch(svg, /58\.4|51\.2/);
});

test("V1 share PNG labels SCORE instead of Battle Points", () => {
  const card = presentBattleShareCard(
    battle({ id: "fin-v1", state: "finished", settlementVersion: 1, scoreBasis: "mcap_pct_change", winnerToken: "0xaaa" }),
    null,
    { requested: false, loaded: true, origin: "https://app.example.test" },
  );
  assert.equal(card.scoreKind, "legacy");
  if (card.scoreCaption) assert.equal(card.scoreCaption, "Score");
  assert.doesNotMatch(card.shareText, /Battle Points/);
});

test("Battle OG reuses Prepare-mode crawler/human split on the canonical Battle route", () => {
  const og = readSrc("../../../api/battle-og.js");
  const png = readSrc("../../../api/battle-share-card.js");
  const edge = readSrc("../../../netlify/edge-functions/battle-og.ts");
  const server = readSrc("../../../api/server.mjs");
  const app = readSrc("../../App.tsx");
  const menu = readSrc("../../components/arena/BattleShareMenu.tsx");
  const payload = readSrc("../../../api/lib/publicBattleSharePayload.mjs");

  assert.match(server, /\/battle-og\/:battleId/);
  assert.match(server, /\/battle-share-card/);
  assert.match(og, /x-mwz-og", "battle"/);
  assert.match(og, /og:image:width" content="1200"/);
  assert.match(og, /og:image:height" content="630"/);
  assert.match(og, /\/warzone\/battles\/:battleId/);
  assert.match(png, /fitTo: \{ mode: "width", value: 1200 \}/);
  assert.match(edge, /BOT_RE/);
  assert.match(edge, /x-mwz-edge-og["']:\s*["']bot["']/);
  assert.match(edge, /x-mwz-edge-og", "inject"/);
  assert.match(edge, /parts\[0\] !== "warzone" \|\| parts\[1\] !== "battles"/);
  assert.match(edge, /config = \{ path: "\/warzone\/battles\/\*"/);
  assert.match(app, /path="\/warzone\/battles\/:battleId"/);
  assert.match(menu, /Download share image/);
  assert.doesNotMatch(payload, /creator_address|offered_stake|matchComponents/);
  assert.doesNotMatch(og, /\/warzone\/tournaments/);
  assert.doesNotMatch(png, /\/warzone\/tournaments/);
});
