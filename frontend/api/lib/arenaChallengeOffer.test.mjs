import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  arenaCreatorChannelName,
  creatorChallengePayload,
  isStrictlyHigherStake,
  normalizeCreatorWallet,
  sanitizeDeclineMessage,
} from "./arenaChallengeOffer.js";

test("decline message is trimmed, stripped of control chars, and capped at 280", () => {
  assert.equal(sanitizeDeclineMessage("  later  "), "later");
  assert.equal(sanitizeDeclineMessage("no\u0000pe"), "nope");
  assert.equal(sanitizeDeclineMessage("   "), null);
  assert.equal(sanitizeDeclineMessage(null), null);
  const long = "x".repeat(400);
  assert.equal(sanitizeDeclineMessage(long).length, 280);
});

test("counter stake must be strictly higher than the live offer", () => {
  assert.equal(isStrictlyHigherStake(2, 1), true);
  assert.equal(isStrictlyHigherStake(1.01, 1), true);
  assert.equal(isStrictlyHigherStake(1, 1), false);
  assert.equal(isStrictlyHigherStake(0.9, 1), false);
  assert.equal(isStrictlyHigherStake("2", "1"), true);
  assert.equal(isStrictlyHigherStake("abc", 1), false);
});

test("creator channel is exact chain+wallet and never a wildcard", () => {
  assert.equal(
    arenaCreatorChannelName(56, "0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd"),
    "arena:creator:56:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  );
  assert.equal(arenaCreatorChannelName(101, "9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H"), "arena:creator:101:9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H");
  assert.equal(arenaCreatorChannelName(56, ""), "");
  assert.equal(arenaCreatorChannelName("nope", "0xabc"), "");
  assert.equal(normalizeCreatorWallet("0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd"), "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
  assert.doesNotMatch(arenaCreatorChannelName(56, "0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd"), /\*/);
});

test("battle handlers pin decline message, higher-stake counters, and creator Ably events", () => {
  const src = fs.readFileSync(new URL("../arenaBattles.js", import.meta.url), "utf8");
  assert.match(src, /sanitizeDeclineMessage/);
  assert.match(src, /isStrictlyHigherStake/);
  assert.match(src, /challenge_received/);
  assert.match(src, /counter_received/);
  assert.match(src, /challenge_accepted/);
  assert.match(src, /challenge_declined/);
  assert.match(src, /notifyDeclined/);
  assert.match(src, /decline_message/);
});

test("creator payload copies the hydrated battle offer fields", () => {
  const payload = creatorChallengePayload(
    { id: "b1", offeredStakeNative: 1.5, offeredDurationHours: 72, nativeSymbol: "ETH", stakeNative: 1 },
    { message: "  no thanks  ", escrowRequired: true },
  );
  assert.equal(payload.offeredStakeNative, 1.5);
  assert.equal(payload.offeredDurationHours, 72);
  assert.equal(payload.nativeSymbol, "ETH");
  assert.equal(payload.message, "no thanks");
  assert.equal(payload.escrowRequired, true);
  assert.equal(payload.battle.id, "b1");
});

test("the decline message reaches only the challenger: never part of the public battle shape", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../arenaBattles.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /declineMessage: row\.decline_message/, "mapBattle must not expose decline_message on public list/detail payloads");
  assert.match(source, /creatorChallengePayload\(expired, \{ message \}\)/, "the creator channel event carries it");
  assert.match(source, /notifyDeclined\(\{[\s\S]*?message,/, "the email carries it");
});

test("the server refuses a metrics Battle when either coin has no live market data (before signing), and lists every opponent per battle type", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../arenaBattles.js", import.meta.url), "utf8");
  assert.match(source, /code: "METRICS_MARKET_DATA_UNAVAILABLE"/);
  assert.ok(source.indexOf('code: "METRICS_MARKET_DATA_UNAVAILABLE"') < source.indexOf('action: "arena_challenge_battle"'), "checked before the wallet signature is verified");
  assert.match(source, /battleMode !== BATTLE_MODE_VOTE && \(hydratedChallenger\?\.marketDataHealthy !== true \|\| hydratedDefender\?\.marketDataHealthy !== true\)/);
  assert.match(source, /path === "\/arena\/battles\/opponents"\) return handleOpponents\(req, res\)/);
});

