import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// Founder, 2026-10-03: one signature per 30 days covers every social action.
test("the feed session lasts 30 days and survives closing the tab", () => {
  assert.match(read("api/lib/feedSessionAuth.js"), /SESSION_TTL_MS = 30 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(read("src/lib/feedSession.ts"), /localStorage\.setItem\(sessionKey/);
});

test("coin comments, War Room join, quick reports and creator updates accept the feed session", () => {
  for (const p of ["api/comments.js", "api/chat/join.js", "api/coinPage.js", "api/coinPageImage.js", "api/abuse/handlers.js"]) {
    assert.match(read(p), /createFeedSessionAuth\(\{ pool \}\)/, p);
  }
  assert.match(read("src/components/token/TokenComments.tsx"), /feedSession\.withSession/);
  assert.match(read("src/hooks/useWarRoom.ts"), /joinWarRoomWithFeedSession/);
  assert.match(read("src/components/moderation/ReportDialog.tsx"), /withSession\(\(token\) => createInAppAbuseReport/);
  assert.match(read("src/components/token/CoinPageSocial.tsx"), /createPost\(sign, \{[^}]+\}, ownerSession\)/);
});

test("coin page profile, story and banner images stay signed", () => {
  assert.match(read("api/coinPage.js"), /authorizeOwner\(res, body, "coin_page_profile_update"\);/);
  assert.match(read("api/coinPageImage.js"), /slot === "post" && \/\^Bearer/);
});
